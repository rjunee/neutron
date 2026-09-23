import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type {
  BoundedWorkOutcome,
  BoundedWorkRequest,
  ProviderObservation,
  Effort,
  Placement,
  RefusalReason,
  Unsupported,
  WorkerHandle,
  WorkerRole,
  WorkerRunner,
} from '../bounded-work.ts'
import { unknownCause } from '../refusal-cause.ts'
import { reserveTrailerSlot } from './trailer-slot.ts'
import { codexBuildObservation, isCodexBuildObservation, type CodexBuildObservation } from './codex-build-observation.ts'
import { codexWorkerEnv, createCodexReviewTransport, type CodexReviewContract } from './codex-review.ts'
import { createObservationPublisher, recoverProviderObservation } from './provider-observation-recovery.ts'
import { codexObservation, readProviderObservation } from './provider-observation.ts'

type Probe = { ok: true } | { ok: false; reason: RefusalReason; detail: string }

export interface CodexHeadlessRunnerOptions {
  readonly buildScript?: string
  readonly env?: NodeJS.ProcessEnv
  readonly probe?: Probe
  readonly reviewContracts?: ReadonlyMap<string, CodexReviewContract>
  readonly reviewBriefIntegrity?: (text: string) => string
}

// Keep the selected contract value intact when passing it to the exec wrapper.
const CLI_EFFORTS: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }

const SUPPORTED_ROLES = new Set<WorkerRole>(['build', 'fix', 'review', 'synthesis'])

function startupProbe(env: NodeJS.ProcessEnv): Probe {
  const childEnv = codexWorkerEnv(env)
  const found = spawnSync('codex', ['--version'], { env: childEnv, stdio: 'ignore' })
  if (found.error || found.status !== 0) {
    return { ok: false, reason: 'provider-not-connected', detail: 'Codex CLI is unavailable' }
  }
  const login = spawnSync('codex', ['login', 'status'], { env: childEnv, stdio: 'ignore' })
  return login.status === 0
    ? { ok: true }
    : { ok: false, reason: 'provider-not-connected', detail: 'Codex login is unavailable' }
}

type TrailerClaim = { head: string; diff: string; pr: null }
type TrailerMapping = { kind: 'mapped'; result: TrailerClaim } | Extract<BoundedWorkOutcome, { kind: 'unknown' }>

// The wrapper names a diff artifact, not inline diff text. Both remain claims;
// only the driver can corroborate them with its independent measurement.
async function mapTrailer(text: string, cwd: string, runId: string): Promise<TrailerMapping> {
  const fields = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const separator = line.indexOf('=')
    if (separator <= 0) return { kind: 'unknown', detail: 'Codex wrapper wrote a malformed trailer' }
    const key = line.slice(0, separator)
    if (fields.has(key)) return { kind: 'unknown', detail: `Codex trailer repeats ${key}` }
    fields.set(key, line.slice(separator + 1))
  }
  for (const field of ['HEAD', 'DIFF', 'PR']) {
    if (!fields.has(`NEUTRON_CODEX_BUILD_${field}`)) {
      return { kind: 'unknown', detail: `Codex trailer is missing NEUTRON_CODEX_BUILD_${field}` }
    }
  }
  const head = fields.get('NEUTRON_CODEX_BUILD_HEAD')!
  const diffPath = fields.get('NEUTRON_CODEX_BUILD_DIFF')!
  const pr = fields.get('NEUTRON_CODEX_BUILD_PR')!
  if (head === '') return { kind: 'unknown', detail: 'Codex trailer has empty NEUTRON_CODEX_BUILD_HEAD' }
  if (diffPath === '') return { kind: 'unknown', detail: 'Codex trailer has empty NEUTRON_CODEX_BUILD_DIFF' }
  // The current wrapper asserts no PR with an explicit empty value. A number
  // alone cannot supply the PR head and state required by the driver.
  if (pr !== '') return { kind: 'unknown', detail: 'Codex trailer is missing pr.head and pr.state for NEUTRON_CODEX_BUILD_PR' }
  try {
    const diff = await readFile(resolve(cwd, diffPath), 'utf8')
    return { kind: 'mapped', result: { head, diff, pr: null } }
  } catch (error) {
    return { kind: 'unknown', detail: unknownCause('Codex trailer NEUTRON_CODEX_BUILD_DIFF artifact is unreadable', error, runId) }
  }
}

function waitFor(child: ChildProcess, signal: AbortSignal, wallMs: number): Promise<{ code: number | null; killed: boolean; timedOut: boolean }> {
  return new Promise((resolveResult) => {
    let aborted = false
    let timedOut = false
    let finished = false
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = Date.now() + wallMs
    const killGroup = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal) } catch { /* Already exited or failed to spawn. */ }
    }
    const finish = (code: number | null) => {
      if (finished) return
      finished = true
      clearTimeout(wallTimer); clearTimeout(drainTimer); clearTimeout(killTimer)
      signal.removeEventListener('abort', abort)
      // Descendants can inherit stdout after the wrapper exits. Neither their
      // pipe lifetime nor telemetry drainage owns the bounded call's lifetime.
      killGroup('SIGKILL')
      child.stdout?.destroy()
      resolveResult({ code, killed: aborted, timedOut })
    }
    const stop = () => {
      killGroup('SIGTERM')
      killTimer ??= setTimeout(() => finish(null), 250)
    }
    const abort = () => { aborted = true; stop() }
    const wallTimer = setTimeout(() => { timedOut = true; stop() }, Math.max(1, wallMs))
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', () => finish(null))
    child.once('exit', code => {
      clearTimeout(wallTimer)
      if (timedOut || aborted || !child.stdout || child.stdout.readableEnded) return finish(code)
      child.stdout.once('end', () => finish(code))
      drainTimer = setTimeout(() => finish(code), Math.max(0, Math.min(250, deadline - Date.now())))
    })
    if (signal.aborted) abort()
  })
}

export function createCodexHeadlessRunner(options: CodexHeadlessRunnerOptions = {}): WorkerRunner {
  const baseEnv = options.env ?? process.env
  const buildScript = options.buildScript ?? resolve(import.meta.dir, '../../trident/codex-build.sh')
  const live = new Map<string, { readonly exitCode: number | null }>()
  const review = createCodexReviewTransport({ env: baseEnv, contracts: options.reviewContracts ?? new Map(),
    briefIntegrity: options.reviewBriefIntegrity, live })
  // A production runner with review contracts must reject metered/malformed
  // account files before even --version or login-status launches Codex.
  const probe: Probe = options.probe ?? (options.reviewContracts?.size && !review.connected
    ? { ok: false, reason: 'provider-not-connected', detail: 'Codex review subscription credentials are unavailable' }
    : startupProbe(baseEnv))

  const unsupported = (role: WorkerRole, placement: Placement): Unsupported | null => {
    if (placement !== 'headless') {
      return { ok: false, reason: 'placement-unavailable', detail: 'Codex runner only hosts cross-provider headless work' }
    }
    if (!SUPPORTED_ROLES.has(role)) {
      return { ok: false, reason: 'capability-unsupported', detail: `Codex runner does not support role ${role}` }
    }
    if (role === 'review' || role === 'synthesis') {
      if (!options.reviewContracts?.size || !options.reviewBriefIntegrity) return { ok: false, reason: 'capability-unsupported', detail: 'Codex review requires host result and brief validators' }
      if (!review.connected) return { ok: false, reason: 'provider-not-connected', detail: 'Codex review requires subscription credentials in its selected account home' }
      if (!review.ready) return { ok: false, reason: 'cli-contract', detail: 'Codex review CLI contract is unavailable' }
    }
    return probe.ok ? null : probe
  }

  const buildIdentity = (req: BoundedWorkRequest) => JSON.stringify({
    run: req.run_id, step: req.step_id, role: req.role, provider: 'openai-codex',
    model: req.model_id, effort: req.effort, thread: req.thread?.id ?? null,
    credentialHome: baseEnv.CODEX_HOME ?? null, cwd: resolve(req.cwd),
    briefIntegrity: req.brief.integrity, schema: req.result.schema,
    writable: req.writable, network: req.network, tools: req.tools,
    needsApproval: req.needs_approval_decision,
  })
  return {
    provider: 'openai-codex',
    supports(role, placement) {
      return unsupported(role, placement) ?? { ok: true }
    },
    async observe(req) {
      if (req.role === 'review' || req.role === 'synthesis') return review.observe(req)
      if (req.role !== 'build' && req.role !== 'fix') return undefined
      const started = Date.now()
      const key = createHash('sha256').update(JSON.stringify([req.run_id, req.step_id])).digest('hex')
      const reservation = join(dirname(req.result.path), `codex-headless-step-${key}.json`)
      const identity = buildIdentity(req)
      const current = await recoverProviderObservation(reservation, identity, `${reservation}.observation`, 'codex-cli-jsonl', undefined, bytes => {
        const receipt = JSON.parse(bytes)
        return receipt.identity === identity ? readProviderObservation(JSON.stringify(receipt.observation), 'codex-cli-jsonl') : undefined
      })
      if (current) return current
      return recoverProviderObservation(reservation, identity, `${reservation}.receipt`, 'codex-cli-jsonl', undefined, bytes => {
        const receipt = JSON.parse(bytes)
        if (receipt.identity !== identity || !isCodexBuildObservation(receipt.observation)
          || (req.thread && receipt.observation.thread_id !== req.thread.id)) return undefined
        const usage = receipt.observation.usage
        const observation = codexObservation(usage === null ? undefined : {
          input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
          cached_input_tokens: usage.cache_read_input_tokens,
        }, receipt.observation.thread_id, started, Date.now())
        return { ...observation, model_reported: receipt.observation.model_reported }
      })
    },
    async run(req, placement, signal): Promise<BoundedWorkOutcome> {
      let measured: ProviderObservation | undefined
      const execute = async (): Promise<BoundedWorkOutcome> => {
      const refusal = unsupported(req.role, placement)
      if (refusal) return { kind: 'refused', reason: refusal.reason }
      if (req.role === 'review' || req.role === 'synthesis') return review(req, signal)
      if (req.thread && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(req.thread.id)) return { kind: 'refused', reason: 'cli-contract' }
      if (signal.aborted) return { kind: 'failed', class: 'killed', detail: 'Codex worker was cancelled before dispatch' }

      // Same atomic reservation the in-repl runners use. It is what separates a
      // FIRST dispatch of this step from a RESUME after a gateway replacement, and
      // the slot may only be cleared on the first: on a resume the trailer sitting
      // there is this step's own receipt, and the child that wrote it is long gone,
      // so destroying it would replay work whose outcome was already known.
      const key = createHash('sha256').update(JSON.stringify([req.run_id, req.step_id])).digest('hex')
      const reservation = join(dirname(req.result.path), `codex-headless-step-${key}.json`)
      // The reservation directory is the durable run state. A replacement host
      // may choose new brief/result filenames or a different remaining wait
      // budget there; those are transport coordinates, not a new paid attempt.
      // Retain the brief's bytes receipt and execution policy: changed work must
      // never inherit the previous completion merely because run/step match.
      const identity = buildIdentity(req)
      const receiptPath = `${reservation}.receipt`
      const held = await reserveTrailerSlot(reservation, identity, req.result.path)
      if (held.kind === 'unknown') return { kind: 'unknown', detail: held.detail }
      let observation: CodexBuildObservation
      let trailerText: string
      if (held.kind === 'dispatch') {
        const effort = req.effort === null ? '' : CLI_EFFORTS[req.effort]
        const env = codexWorkerEnv({
          ...baseEnv,
          CODEX_BUILD_MODEL: req.model_id,
          CODEX_BUILD_EFFORT: effort,
          CODEX_REVIEW_MODEL: req.model_id,
          NEUTRON_CODEX_BUILD_BRIEF_FILE: req.brief.path,
          NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY: req.brief.integrity,
          NEUTRON_CODEX_BUILD_TRAILER_FILE: req.result.path,
          NEUTRON_CODEX_THREAD_ID: req.thread?.id ?? '',
        })
        const events = codexBuildObservation(req.thread?.id ?? null)
        const started = Date.now()
        const publisher = createObservationPublisher(`${reservation}.observation`, identity)
        const child = spawn('/bin/bash', [buildScript], { cwd: req.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
        child.stdout!.setEncoding('utf8')
        child.stdout!.on('data', (chunk: string) => { events.push(chunk); publisher.publish(events.snapshot(started, Date.now())) })
        live.set(req.step_id, child)
        const settled = await waitFor(child, signal, req.budget.wall_ms)
        live.delete(req.step_id)
        // Retry the latest absolute snapshot even if an earlier identical write
        // failed. Never replace newer observed spend with an older disk receipt.
        measured = await publisher.settle(events.snapshot(started, Date.now()))
        if (settled.killed || signal.aborted) return { kind: 'failed', class: 'killed', detail: 'Codex worker was cancelled' }
        if (settled.timedOut) return { kind: 'failed', class: 'timeout', detail: 'Codex worker exceeded its wall-clock budget' }
        if (settled.code !== 0) {
          if (settled.code === 10 || settled.code === 11) return { kind: 'refused', reason: 'provider-not-connected' }
          if (settled.code === 3) return { kind: 'refused', reason: 'cli-contract' }
          return { kind: 'failed', class: 'infra', detail: `Codex wrapper exited ${settled.code ?? 'without status'}` }
        }
        try {
          trailerText = await readFile(req.result.path, 'utf8')
        } catch (error) {
          return { kind: 'unknown', detail: unknownCause('Codex wrapper exited successfully without a readable trailer', error, req.run_id) }
        }
        const observed = events.finish()
        if (!observed) return { kind: 'unknown', detail: 'Codex build lacks a valid completed turn and matching thread observation' }
        observation = observed
        try {
          await writeFile(`${receiptPath}.tmp`, JSON.stringify({ identity, trailerText, observation }), { flag: 'wx', mode: 0o600 })
          await rename(`${receiptPath}.tmp`, receiptPath)
        } catch { return { kind: 'unknown', detail: 'Codex build observation could not be committed' } }
      } else {
        measured = await this.observe?.(req)
        // Recovery consumes the original receipt, never the role's mutable slot or
        // a newly requested ID. An uncertain dispatch must not buy another turn.
        try {
          const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
          if (receipt.identity !== identity || typeof receipt.trailerText !== 'string'
            || !isCodexBuildObservation(receipt.observation)
            || (req.thread && receipt.observation.thread_id !== req.thread.id)) {
            return { kind: 'unknown', detail: 'Codex build receipt identity mismatched' }
          }
          trailerText = receipt.trailerText
          observation = receipt.observation
        } catch { return { kind: 'unknown', detail: 'Codex build has no committed receipt; dispatch will not be replayed' } }
      }
      const mapped = await mapTrailer(trailerText, req.cwd, req.run_id)
      if (mapped.kind === 'unknown') return mapped
      return {
        kind: 'completed',
        result: mapped.result,
        usage: observation.usage,
        model_reported: observation.model_reported,
        thread_id: observation.thread_id,
      }
      }
      const outcome = await execute()
      return measured ? { ...outcome, observation: measured } : outcome
    },
    async liveness(handle: WorkerHandle) {
      const child = live.get(handle.step_id)
      return child && child.exitCode === null ? 'activity' : 'nothing'
    },
  }
}
