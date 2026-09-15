import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILTIN_MODEL_TIERS, configuredModels } from '@neutronai/runtime/configured-models.ts'
import { placementFor, type BoundedWorkOutcome, type BoundedWorkRequest, type Provider, type WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import { modelTier, type ModelTierDescriptor } from './model-tiers.ts'
import { phaseByKey, type PhaseModelConfig } from './phase-models.ts'
import type { BuildSnapshot } from './build-run.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { validateTrailer } from './gates/result-contract.ts'
import type { ReviewSeat, ReviewSource, SeatObservation } from './gates/review-panel.ts'

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
}

/** One source per admitted build. Records are private host memory; rebuilding the
 * source cannot recover an approval. The caller owns evidence directory retention.
 */
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
    // The bounded-work vocabulary currently cannot represent xhigh or max.
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') throw Error(`Review seat ${id}: unsupported effort ${effort}`)
    const model: ModelTierDescriptor = custom ? { tier, provider: custom.provider, model_id: custom.model,
      endpoint: custom.endpoint, credential: custom.credential, group: 'api', transport: 'cli',
      wrapper: 'trident/api-review-cli.ts', env_var: null, requires: custom.credential } : builtin!
    return { model: Object.freeze(model), seat: Object.freeze({ id, provider, modelId: custom?.model ?? builtin!.model_id,
      family: custom?.provider ?? builtin!.provider, role, enabled: tier !== 'none' }), effort }
  }
  const routes = [resolve('review_rubric', 'core'), resolve('review_adversarial', 'core'),
    resolve('review_codex', 'peer'), resolve('review_kimi', 'peer')]
  const synthesisRoute = resolve('synthesis', 'core')
  const seats = Object.freeze(routes.map(route => route.seat))
  const records = new Map<string, Promise<SeatObservation>>()
  const retried = new Set<string>()
  const syntheses = new Map<string, Promise<Awaited<ReturnType<ReviewSource['readSynthesis']>>>>()
  const keyFor = (snapshot: BuildSnapshot, round: number) => {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(snapshot.head) || !snapshot.diff.trim() || !Number.isSafeInteger(round) || round < 1) throw Error('Review source requires a measured revision, diff and host round')
    return JSON.stringify([snapshot.head, snapshot.diff, snapshot.pr, round])
  }
  const routeFor = (seat: ReviewSeat) => {
    const route = routes.find(row => row.seat === seat && seat.enabled)
    if (!route) throw Error(`Review seat ${seat.id}: configuration does not belong to this source`)
    return route
  }
  async function dispatch(route: typeof synthesisRoute, snapshot: BuildSnapshot, round: number, attempt: number, panel?: SeatObservation[]): Promise<SeatObservation> {
    const { seat } = route
    const identity = { runId: options.runId, head: snapshot.head, round, provider: seat.provider, modelId: seat.modelId }
    const unavailable = (reason: string): SeatObservation => ({ ...identity, status: 'unavailable', payload: { reason: `Review seat ${seat.id}: ${reason}` } })
    const runner = options.runnerFor(route.model, seat)
    if (!runner || runner.provider !== seat.provider) return unavailable('configured runner is missing')
    const placement = placementFor(seat.provider, options.replProvider)
    const role = panel === undefined ? 'review' : 'synthesis'
    const supported = runner.supports(role, placement)
    if (!supported.ok) return unavailable(supported.reason)
    const directory = await mkdtemp(join(options.evidenceRoot, 'review-'))
    const text = JSON.stringify({ project: options.projectSlug, seat: seat.id, snapshot, round, panel,
      instruction: 'Review the measured diff. Return the verdict schema with findings and file/line evidence. Synthesis must account for every supplied seat.' })
    const briefPath = join(directory, 'brief.json')
    await writeFile(briefPath, text, { mode: 0o600, flag: 'wx' })
    const request: BoundedWorkRequest = { run_id: options.runId, step_id: `${directory.split('/').at(-1)}:${round}:${attempt}`,
      role, model_id: seat.modelId, effort: route.effort, cwd: options.cwd, writable: false,
      network: true, tools: 'read-only', brief: { path: briefPath, integrity: briefIntegrity(text) },
      result: { schema: 'verdict', path: join(directory, 'result.json') }, thread: null,
      budget: { wall_ms: options.wallMs }, needs_approval_decision: false }
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
      const outcome = await Promise.race([runner.run(request, placement, controller.signal), stopped])
      if (outcome.kind === 'completed') return { ...identity, status: 'completed', payload: structuredClone(outcome.result) }
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
      const key = `${keyFor(snapshot, round)}:${seat.id}`
      if (!records.has(key)) records.set(key, dispatch(route, structuredClone(snapshot), round, 0))
      return structuredClone(await records.get(key)!)
    },
    async retrySeat(seat, snapshot, round) {
      const route = routeFor(seat)
      const key = `${keyFor(snapshot, round)}:${seat.id}`
      if (retried.has(key)) throw Error(`Review seat ${seat.id}: retry already consumed`)
      retried.add(key)
      const prior = await records.get(key)
      if (prior && prior.status !== 'deferred') throw Error(`Review seat ${seat.id}: retry unavailable for ${prior.status}`)
      records.set(key, dispatch(route, structuredClone(snapshot), round, 1))
      await records.get(key)
    },
    async readSynthesis(snapshot, round) {
      snapshot = structuredClone(snapshot)
      const key = keyFor(snapshot, round)
      if (!syntheses.has(key)) syntheses.set(key, (async () => {
        const panel: SeatObservation[] = []
        for (const seat of seats.filter(row => row.enabled)) {
          const observed = await records.get(`${key}:${seat.id}`)
          if (!observed || observed.status !== 'completed') return null
          panel.push(observed)
        }
        const observed = await dispatch(synthesisRoute, structuredClone(snapshot), round, 0, panel)
        if (observed.status !== 'completed') return null
        const checked = validateTrailer('verdict', observed.payload)
        return { runId: options.runId, head: snapshot.head, round,
          checkpoint: checked.ok && checked.value.verdict === 'APPROVE' ? 'argus-approved' : 'review-recorded', payload: observed.payload }
      })())
      return structuredClone(await syntheses.get(key)!)
    },
  }
}
