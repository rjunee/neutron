import { writeFile, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BUILTIN_MODEL_TIERS, configuredModels } from '@neutronai/runtime/configured-models.ts'
import { placementFor, type BoundedWorkOutcome, type BoundedWorkRequest, type Provider, type WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import { modelTier, type ModelTierDescriptor } from './model-tiers.ts'
import { phaseByKey, type PhaseModelConfig } from './phase-models.ts'
import type { BuildSnapshot } from './build-run.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { validateTrailer, VERDICT_SCHEMA } from './gates/result-contract.ts'
import type { ReviewSeat, ReviewSource, SeatObservation } from './gates/review-panel.ts'
import type { AttemptAccounting } from './attempt-accounting.ts'
import { bindReviewRequest, claimReviewReceipt, invalidateReviewReceipt, readReviewJson, readReviewReceipt, settleReviewReceipt } from './project-review-receipt.ts'

const activeReviewAttempts = new Set<string>()

export interface ProjectReviewSourceOptions {
  runId: string
  projectSlug: string
  cwd: string
  /** Host-owned directory, outside worker writable roots; retained for audit. */
  evidenceRoot: string
  env: Readonly<Record<string, string | undefined>>
  phaseModels: PhaseModelConfig
  replProvider: Provider
  /** Composition binds the selected transport and owner credential for this descriptor. */
  runnerFor(model: ModelTierDescriptor, seat: ReviewSeat): WorkerRunner | undefined
  wallMs: number
  signal: AbortSignal
  accounting: AttemptAccounting
  taskId(): string
  /** Current canonical task bytes. Missing identity permits only source-local reuse. */
  taskInput?(): string
  /** Selected credential digest, including same-path account rotation. */
  credentialIdentity?(provider: Provider): Promise<string | null>
}

/** One source per admitted build. Host-owned receipts retain completed observations
 * and consumed attempts across source replacement; pending work remains uncertain. */
export function createProjectReviewSource(input: ProjectReviewSourceOptions): ReviewSource {
  const options = { ...input }
  if (!options.runId || !options.projectSlug || !Number.isSafeInteger(options.wallMs) || options.wallMs <= 0) throw Error('Review source requires host identity and a positive wall budget')
  const configured = configuredModels(options.env)
  const resolve = (id: string, role: ReviewSeat['role']) => {
    const phase = phaseByKey(id)!
    const override = options.phaseModels[id]
    const tier = override?.model ?? phase.default.tier
    const custom = configured.find(row => row.tier === tier)
    const builtin = (BUILTIN_MODEL_TIERS as readonly string[]).includes(tier) ? modelTier(tier) : null
    if (!custom && !builtin) throw Error(`Review seat ${id}: unknown configured model ${tier}`)
    const group = custom ? 'api' : builtin!.group
    if (!phase.dispatchGroups.includes(group)) throw Error(`Review seat ${id}: unsupported configured model ${tier}`)
    const provider: Provider = group === 'claude' ? 'anthropic' : group === 'codex' ? 'openai-codex' : 'pi'
    const effort = override?.effort ?? phase.default.effort
    const model: ModelTierDescriptor = custom ? { tier, provider: custom.provider, model_id: custom.model,
      endpoint: custom.endpoint, credential: custom.credential, group: 'api', transport: 'cli',
      wrapper: 'trident/api-review-cli.ts', env_var: null, requires: custom.credential } : builtin!
    return { model: Object.freeze(model), seat: Object.freeze({ id, provider, modelId: custom?.model ?? builtin!.model_id,
      family: custom?.provider ?? builtin!.provider, role, enabled: tier !== 'none' }), effort }
  }
  const routes = [resolve('review_rubric', 'core'), resolve('review_adversarial', 'core'),
    resolve('review_codex', 'peer'), resolve('review_kimi', 'peer')]
  const synthesisRoute = resolve('synthesis', 'core')
  // Preflight the capabilities of connected, provider-matched transports before
  // spending a build turn. Missing transports retain their dispatch-time
  // unavailable observation; discovery alone must not veto host construction.
  for (const route of [...routes, synthesisRoute].filter(route => route.seat.enabled)) {
    const runner = options.runnerFor(route.model, route.seat)
    if (!runner || runner.provider !== route.seat.provider) continue
    const support = runner.supports(route === synthesisRoute ? 'synthesis' : 'review', placementFor(route.seat.provider, options.replProvider))
    if (!support.ok) throw Error(`Review seat ${route.seat.id}: ${support.reason}: ${support.detail}`)
  }
  const seats = Object.freeze(routes.map(route => route.seat))
  const records = new Map<string, Promise<SeatObservation>>()
  const retried = new Set<string>()
  const syntheses = new Map<string, Promise<Awaited<ReturnType<ReviewSource['readSynthesis']>>>>()
  const threadQueues = new Map<string, Promise<void>>()
  const localIdentity = randomUUID()
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const environment = digest(Object.entries(options.env).sort(([a], [b]) => a.localeCompare(b)))
  const operationFor = async (route: typeof synthesisRoute) => ({
    taskId: options.taskId(), task: options.taskInput?.() ?? null,
    credential: await options.credentialIdentity?.(route.seat.provider) ?? null,
    runner: options.runnerFor(route.model, route.seat), provider: route.seat.provider,
  })
  type Operation = Awaited<ReturnType<typeof operationFor>>
  const assertScope = async (operation: Operation) => {
    if (operation.taskId !== options.taskId() || operation.task !== (options.taskInput?.() ?? null)
      || operation.credential !== (await options.credentialIdentity?.(operation.provider) ?? null)) {
      throw Error('Review task or credential scope changed during observation')
    }
  }
  const keyFor = (snapshot: BuildSnapshot, round: number, operation: Operation) => {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(snapshot.head) || !snapshot.diff.trim() || !Number.isSafeInteger(round) || round < 1) throw Error('Review source requires a measured revision, diff and host round')
    return JSON.stringify([operation.taskId, operation.task?.trim() ? operation.task : localIdentity, snapshot.head, snapshot.diff, snapshot.pr, round])
  }
  const routeFor = (seat: ReviewSeat) => {
    const route = routes.find(row => row.seat === seat && seat.enabled)
    if (!route) throw Error(`Review seat ${seat.id}: configuration does not belong to this source`)
    return route
  }
  const reviewBrief = (route: typeof synthesisRoute, snapshot: BuildSnapshot, round: number, panel?: SeatObservation[]) => JSON.stringify({
    project: options.projectSlug, seat: route.seat.id, snapshot, round, panel, verdictSchema: VERDICT_SCHEMA,
    instruction: 'Review the measured diff. The result must conform exactly to verdictSchema, including findings and file/line evidence. Do not add fields to result or its nested objects beyond those declared in verdictSchema. Synthesis must account for every supplied seat within this same schema.',
    resultFile: 'Write your result file as a JSON object with EXACTLY these five fields: "schema", "run_id" and "step_id", each copied verbatim from this dispatch\'s request (`request.result.schema`, `request.run_id`, `request.step_id`) — do not invent or reformat them; "kind", which is "completed" when you produced a verdict or "blocked" when you could not; and "result", the verdict payload itself, omitted when blocked. When blocked, add "on": a non-empty sentence saying what stopped you. Report blocked rather than inventing a verdict.',
  })
  const receiptFor = (route: typeof synthesisRoute, snapshot: BuildSnapshot, round: number, attempt: number, operation: Operation, panel?: SeatObservation[]) => {
    const identity = digest(['review-receipt-v1', options.runId, options.projectSlug, options.cwd,
      keyFor(snapshot, round, operation), route, options.replProvider, environment, operation.credential?.trim() ? operation.credential : localIdentity,
      options.wallMs, reviewBrief(route, snapshot, round, panel), attempt])
    return { identity, directory: join(options.evidenceRoot, `review-${identity}`) }
  }
  const threadBinding = (route: typeof synthesisRoute, operation: Operation) => {
    if (!['openai-codex', 'anthropic'].includes(route.seat.provider) || route.seat.provider === options.replProvider) return null
    const credential = route.seat.provider === 'anthropic'
      ? digest(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'HOME'].map(key => options.env[key] ?? null))
      : options.env.CODEX_HOME ?? null
    const owner = JSON.stringify([options.runId, options.projectSlug, options.cwd, route.seat.id, route.seat.modelId,
      operation.credential?.trim() ? operation.credential : credential])
    return { owner, path: join(options.evidenceRoot, `review-thread-${createHash('sha256').update(owner).digest('hex')}.json`) }
  }
  async function dispatch(route: typeof synthesisRoute, snapshot: BuildSnapshot, round: number, attempt: number, operation: Operation, panel?: SeatObservation[]): Promise<SeatObservation> {
    const { identity, directory } = receiptFor(route, snapshot, round, attempt, operation, panel)
    await assertScope(operation)
    const stored = await readReviewReceipt(directory, identity)
    if (stored?.invalidated) throw Error(`Review seat ${route.seat.id}: original pending attempt had changed inputs`)
    if (stored?.state === 'settled') {
      const observed = stored.observation!
      if (observed.runId !== options.runId || observed.head !== snapshot.head || observed.round !== round
        || observed.provider !== route.seat.provider || observed.modelId !== route.seat.modelId
        || (observed.family !== undefined && observed.family !== null && observed.family !== route.seat.family)) {
        throw Error(`Review seat ${route.seat.id}: receipt provenance mismatch`)
      }
      await assertScope(operation)
      return structuredClone(observed)
    }
    const priorAttempt = options.accounting.ledger.get({ run_id: options.runId,
      step_id: `${directory.split('/').at(-1)}:${round}:${attempt}`, attempt_id: 'dispatch' })
    // The durable ledger is only a veto against replay after lost file evidence.
    // Its outcome/usage cannot restore a verdict or authorize a fresh attempt.
    if (!stored && priorAttempt) throw Error(`Review seat ${route.seat.id}: prior attempt lost its receipt directory`)
    // No connected transport means no attempt was purchased. A later connection
    // may still run this seat, unlike a worker refusal or an uncertain dispatch.
    const runner = operation.runner
    const role = panel === undefined ? 'review' : 'synthesis'
    if (!runner || runner.provider !== route.seat.provider || !runner.supports(role, placementFor(route.seat.provider, options.replProvider)).ok) {
      return { runId: options.runId, head: snapshot.head, round, provider: route.seat.provider,
        modelId: route.seat.modelId, status: 'unavailable', payload: { reason: `Review seat ${route.seat.id}: configured runner is missing or unsupported` } }
    }
    if (activeReviewAttempts.has(directory)) throw Error(`Review seat ${route.seat.id}: original attempt remains pending in this host`)
    activeReviewAttempts.add(directory)
    try {
      let observed: SeatObservation
      if (stored) {
        if (!stored.requestHash || !priorAttempt || priorAttempt.started_at === null) throw Error('Pending review lacks its original dispatched request')
        const original = await readReviewJson(join(directory, 'request.json')) as BoundedWorkRequest
        if (!original || digest(original) !== stored.requestHash) throw Error('Pending review request identity is invalid')
        const expected = makeRequest(route, snapshot, round, attempt, directory, panel, original.thread)
        if (JSON.stringify(original) !== JSON.stringify(expected)
          || (original.thread !== null && (typeof original.thread !== 'object' || typeof original.thread.id !== 'string' || !original.thread.id))) {
          throw Error('Pending review request does not match its original scope')
        }
        const binding = threadBinding(route, operation)
        observed = await runRequest(route, snapshot, round, original, operation, binding ? async id => {
          if (!id || (original.thread && original.thread.id !== id)) throw Error('Recovered review did not preserve its original thread')
          try {
            const current = await readReviewJson(binding.path) as { owner: string; id: string }
            if (current.owner !== binding.owner || current.id !== id) throw Error('Recovered review thread ownership changed')
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          await writeFile(`${binding.path}.tmp`, JSON.stringify({ owner: binding.owner, id }), { mode: 0o600 })
          await rename(`${binding.path}.tmp`, binding.path)
          // Release only the abandoned source lease for this exact attempt.
          if (await readReviewJson(`${binding.path}.lock`).then(value => JSON.stringify(value)).catch(() => '') === JSON.stringify([binding.owner, directory])) {
            await unlink(`${binding.path}.lock`)
          }
        } : undefined, true)
      } else {
        await claimReviewReceipt(directory, identity)
        observed = await dispatchFresh(route, snapshot, round, attempt, directory, operation, panel)
      }
      await assertScope(operation)
      await settleReviewReceipt(directory, identity, observed)
      return observed
    } catch (error) {
      try { await assertScope(operation) }
      catch {
        await invalidateReviewReceipt(directory, identity)
        throw Error('Review task or credential scope changed; original pending attempt invalidated')
      }
      throw error
    } finally { activeReviewAttempts.delete(directory) }
  }
  async function dispatchFresh(route: typeof synthesisRoute, snapshot: BuildSnapshot, round: number, attempt: number, directory: string, operation: Operation, panel?: SeatObservation[]): Promise<SeatObservation> {
    // §3.3: one stored thread per recurring cross-provider seat, never a shared
    // newest-thread heuristic. An abandoned lock is uncertainty, not permission
    // to start another writer after a host replacement.
    const binding = threadBinding(route, operation)
    if (!binding) return dispatchTurn(route, snapshot, round, attempt, directory, operation, panel)
    const { owner, path } = binding
    const lease = JSON.stringify([owner, directory])
    const prior = threadQueues.get(owner) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>(resolve => { release = resolve })
    const queued = prior.then(() => turn)
    threadQueues.set(owner, queued)
    let waitTimer: ReturnType<typeof setTimeout> | undefined
    let locked = false
    let settled = false
    try {
      await options.accounting.interval('review-thread-queue', { run_id: options.runId, review_seat: route.seat.id,
        head_sha: snapshot.head, round, attempt }, () => Promise.race([prior, new Promise<never>((_, reject) => {
        waitTimer = setTimeout(() => reject(Error(`Review seat ${route.seat.id}: thread queue budget expired`)), options.wallMs)
      })]))
      clearTimeout(waitTimer)
      if (options.signal.aborted) throw Error('Review thread wait cancelled')
      try { await writeFile(`${path}.lock`, lease, { flag: 'wx', mode: 0o600 }); locked = true }
      catch { throw Error(`Review seat ${route.seat.id}: thread ownership conflict`) }
      let thread: { id: string } | null = null
      try {
        const stored = await readReviewJson(path) as { owner: string; id: string }
        if (stored.owner !== owner || typeof stored.id !== 'string' || !stored.id) throw Error('Invalid stored review thread')
        thread = { id: stored.id }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const observed = await dispatchTurn(route, snapshot, round, attempt, directory, operation, panel, thread, async id => {
        if (!id || (thread && thread.id !== id)) throw Error('Headless review did not preserve its observed thread')
        await writeFile(`${path}.tmp`, JSON.stringify({ owner, id }), { mode: 0o600 })
        await rename(`${path}.tmp`, path)
      })
      settled = true
      return observed
    } finally {
      clearTimeout(waitTimer)
      // A timed-out dispatch may still own the CLI writer until cancellation
      // completes. Keep its lock rather than turning uncertainty into a replay.
      if (locked && settled && await readReviewJson(`${path}.lock`).then(value => JSON.stringify(value)).catch(() => '') === lease) await unlink(`${path}.lock`)
      release()
      if (threadQueues.get(owner) === queued) threadQueues.delete(owner)
    }
  }
  const makeRequest = (route: typeof synthesisRoute, snapshot: BuildSnapshot, round: number, attempt: number, directory: string, panel: SeatObservation[] | undefined,
    thread: { id: string } | null): BoundedWorkRequest => ({ run_id: options.runId, step_id: `${directory.split('/').at(-1)}:${round}:${attempt}`,
    role: panel === undefined ? 'review' : 'synthesis', model_id: route.seat.modelId, effort: route.effort, cwd: options.cwd, writable: false,
    network: true, tools: 'read-only', brief: { path: join(directory, 'brief.json'), integrity: briefIntegrity(reviewBrief(route, snapshot, round, panel)) },
    result: { schema: 'verdict', path: join(directory, 'result.json') }, thread,
    budget: { wall_ms: options.wallMs }, needs_approval_decision: false })
  async function dispatchTurn(route: typeof synthesisRoute, snapshot: BuildSnapshot, round: number, attempt: number, directory: string, operation: Operation, panel?: SeatObservation[],
    thread: { id: string } | null = null, rememberThread?: (id: string | null) => Promise<void>): Promise<SeatObservation> {
    const { seat } = route
    const placement = placementFor(seat.provider, options.replProvider)
    // THE PANEL BRIEF MUST STATE THE ENVELOPE TOO. `decodeProjectTrailer`
    // (`runtime/workers/project-runners.ts:44-58`) reads
    // `{ schema, run_id, step_id, kind, result }` off EVERY project result file,
    // a panel seat's included, and refuses unless `run_id`, `step_id` and
    // `schema` each match the request exactly.
    //
    // This brief used to describe only the verdict payload, so a seat that
    // obeyed it wrote the bare `{verdict, findings}` object and the decode
    // returned "Trailer run_id missing or mismatched." — the SAME stop that
    // ended the third acceptance dispatch at the plan worker, which #1033 fixed
    // for the four role briefs and not for this one. Found by the offline
    // end-to-end harness (`open/__tests__/project-build-e2e.test.ts`) rather
    // than by a fourth dispatch.
    //
    // The host derives step_id from the retained input identity, round and attempt.
    const text = reviewBrief(route, snapshot, round, panel)
    const briefPath = join(directory, 'brief.json')
    const request = makeRequest(route, snapshot, round, attempt, directory, panel, thread)
    // Retain the exact original request, including its initial thread binding.
    // Pending receipts never synthesize a new request from a later thread state.
    await writeFile(join(directory, 'request.json'), JSON.stringify(request), { mode: 0o600, flag: 'wx' })
    await bindReviewRequest(directory, receiptFor(route, snapshot, round, attempt, operation, panel).identity, digest(request))
    await options.accounting.prepare(request, seat.provider, placement, {
      phase: seat.id, task_id: operation.taskId, head_sha: snapshot.head,
      review_seat: seat.id, requested_model: route.model.tier,
    }, () => writeFile(briefPath, text, { mode: 0o600, flag: 'wx' }))
    return runRequest(route, snapshot, round, request, operation, rememberThread)
  }
  async function runRequest(route: typeof synthesisRoute, snapshot: BuildSnapshot, round: number, request: BoundedWorkRequest, operation: Operation,
    rememberThread?: (id: string | null) => Promise<void>, recovering = false): Promise<SeatObservation> {
    const { seat } = route
    const identity = { runId: options.runId, head: snapshot.head, round, provider: seat.provider, modelId: seat.modelId }
    const unavailable = (reason: string): SeatObservation => ({ ...identity, status: 'unavailable', payload: { reason: `Review seat ${seat.id}: ${reason}` } })
    const runner = operation.runner!
    const placement = placementFor(seat.provider, options.replProvider)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: () => void = () => {}
    const stopped = new Promise<BoundedWorkOutcome>(resolve => {
      abort = () => { controller.abort(); resolve({ kind: 'failed', class: 'killed', detail: 'host cancelled review' }) }
      options.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { controller.abort(); resolve({ kind: 'failed', class: 'timeout', detail: 'review wall budget expired' }) }, options.wallMs)
    })
    try {
      if (options.signal.aborted) { abort(); return unavailable('host cancelled review') }
      await assertScope(operation)
      const outcome = await Promise.race([recovering
        ? options.accounting.recover(runner, request, placement, controller.signal)
        : options.accounting.run(runner, request, placement, controller.signal), stopped])
      await assertScope(operation)
      // Recovery may inspect existing evidence only. Unsupported, missing,
      // damaged or unresolved provider evidence retains the original pending
      // claim so restoring that evidence can recover it without a new attempt.
      if (recovering && outcome.kind !== 'completed') throw Error('Original review outcome remains pending')
      if (outcome.kind === 'completed') {
        if (recovering && !validateTrailer('verdict', outcome.result).ok) throw Error('Recovered review verdict is invalid')
        await rememberThread?.(outcome.thread_id)
        return { ...identity, status: 'completed', family: outcome.model_reported === null ? null : seat.family, payload: structuredClone(outcome.result) }
      }
      if (outcome.kind === 'refused') return unavailable(outcome.reason)
      // A worker block has no retryability evidence (it may be a rate limit).
      if (outcome.kind === 'blocked') return unavailable(outcome.on)
      if (outcome.kind === 'failed' && outcome.class === 'infra') return { ...identity, status: 'deferred', payload: { reason: 'host runner infrastructure failure' } }
      throw Error(`Review seat ${seat.id}: ${outcome.kind} observation`)
    } catch { throw Error(`Review seat ${seat.id}: host dispatch or observation failed`) }
    finally { clearTimeout(timer); options.signal.removeEventListener('abort', abort) }
  }
  return {
    seats,
    async readSeat(seat, snapshot, round) {
      const route = routeFor(seat)
      const operation = await operationFor(route)
      const key = receiptFor(route, snapshot, round, 0, operation).identity
      if (!records.has(key)) records.set(key, (async () => {
        const retry = receiptFor(route, snapshot, round, 1, operation)
        const stored = await readReviewReceipt(retry.directory, retry.identity)
        if (stored) {
          const initial = receiptFor(route, snapshot, round, 0, operation)
          const prior = await readReviewReceipt(initial.directory, initial.identity)
          if (prior?.state !== 'settled' || prior.observation?.status !== 'deferred') {
            throw Error(`Review seat ${seat.id}: retry lacks its original deferred observation`)
          }
          retried.add(key)
          return dispatch(route, structuredClone(snapshot), round, 1, operation)
        }
        return dispatch(route, structuredClone(snapshot), round, 0, operation)
      })())
      const observed = await records.get(key)!
      await assertScope(operation)
      return structuredClone(observed)
    },
    async retrySeat(seat, snapshot, round) {
      const route = routeFor(seat)
      const operation = await operationFor(route)
      const key = receiptFor(route, snapshot, round, 0, operation).identity
      const prior = await (records.get(key) ?? this.readSeat(seat, snapshot, round))
      if (retried.has(key)) throw Error(`Review seat ${seat.id}: retry already consumed`)
      if (prior && prior.status !== 'deferred') throw Error(`Review seat ${seat.id}: retry unavailable for ${prior.status}`)
      retried.add(key)
      records.set(key, dispatch(route, structuredClone(snapshot), round, 1, operation))
      await records.get(key)
    },
    async readSynthesis(snapshot, round) {
      snapshot = structuredClone(snapshot)
      const panel: SeatObservation[] = []
      for (const seat of seats.filter(row => row.enabled)) {
        const route = routeFor(seat)
        const seatKey = receiptFor(route, snapshot, round, 0, await operationFor(route)).identity
        const observed = await records.get(seatKey)
        if (!observed || observed.status !== 'completed') return null
        panel.push(observed)
      }
      const operation = await operationFor(synthesisRoute)
      const key = receiptFor(synthesisRoute, snapshot, round, 0, operation, panel).identity
      if (!syntheses.has(key)) syntheses.set(key, (async () => {
        const observed = await dispatch(synthesisRoute, structuredClone(snapshot), round, 0, operation, panel)
        if (observed.status !== 'completed') return { runId: options.runId, head: snapshot.head, round,
          unavailable: typeof observed.payload === 'object' && observed.payload !== null && 'reason' in observed.payload
            && typeof observed.payload.reason === 'string' ? observed.payload.reason : 'Review synthesis is unavailable' }
        const checked = validateTrailer('verdict', observed.payload)
        return { runId: options.runId, head: snapshot.head, round,
          checkpoint: checked.ok && checked.value.verdict === 'APPROVE' ? 'argus-approved' : 'review-recorded', payload: observed.payload }
      })())
      const observed = await syntheses.get(key)!
      await assertScope(operation)
      return structuredClone(observed)
    },
  }
}
