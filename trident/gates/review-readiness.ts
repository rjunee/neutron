import type { BuildSnapshot, GateResult } from '../build-run.ts'

/** Host reads, pinned to the requested revision. These are never worker trailers. */
export type ReviewReadinessObservation =
  | { kind: 'unknown'; detail: string }
  | {
    kind: 'known'
    head: string
    configuration: { kind: 'unknown'; detail: string } | { kind: 'resolved'; required: readonly string[] }
    mergeability: 'mergeable' | 'conflicting' | 'pending'
    /** Missing evidence is incomplete, including older injected sources. */
    checksComplete?: boolean
    checks: readonly { name: string; state: 'passed' | 'failed' | 'skipped' | 'running' }[]
  }

export type ReviewReadiness =
  | { kind: 'passed'; failed: readonly string[] }
  | { kind: 'failed'; failed: readonly string[] }
  | { kind: 'pending'; detail: string }
  | Exclude<GateResult, { kind: 'allow' }>

export interface ReviewReadinessSource {
  /** Acquire configuration and revision; unreadable check lists carry incomplete evidence and wait. */
  observe(snapshot: BuildSnapshot, signal: AbortSignal): Promise<ReviewReadinessObservation>
}

export const REVIEW_READINESS_BUDGET_MS = 900000
export const REVIEW_READINESS_RETRY_MS = 30000

/** G044/G047/G049/G052: classify facts before deciding whether to spend review. */
export function classifyReviewReadiness(snapshot: BuildSnapshot, observation: ReviewReadinessObservation): ReviewReadiness {
  const unknown = (detail: string): ReviewReadiness => ({ kind: 'unknown', detail })
  if (observation.kind === 'unknown') return observation
  if (observation.kind !== 'known' || observation.head !== snapshot.head) return unknown('Review readiness revision does not match the measured head')
  if (observation.configuration.kind === 'unknown') return unknown(`Required check configuration: ${observation.configuration.detail}`)
  if (observation.mergeability === 'conflicting') return { kind: 'blocked', on: 'Review PR conflicts with base' }
  if (observation.mergeability !== 'mergeable') return { kind: 'pending', detail: 'Review PR mergeability is not established' }
  if (observation.configuration.kind !== 'resolved') return unknown('Required check configuration is not resolved')
  const { required } = observation.configuration
  const rows = observation.checks
  // Missing or malformed observations must not become a resolved empty configuration.
  if (!Array.isArray(required) || required.some(name => typeof name !== 'string' || !name.trim()) ||
    !Array.isArray(rows) || rows.some(row => !row || typeof row.name !== 'string' || !row.name.trim() || !['passed', 'failed', 'skipped', 'running'].includes(row.state))) {
    return unknown('Review check configuration or rows are malformed')
  }
  if (observation.checksComplete !== true) return { kind: 'pending', detail: 'Review check lists are unreadable or incomplete' }
  const ran = rows.filter(row => row.state !== 'skipped')
  for (const name of required) {
    const matching = ran.filter(row => row.name === name)
    if (matching.length === 0 || matching.some(row => row.state === 'running')) return { kind: 'pending', detail: `Required check ${name} has not run and settled` }
  }
  if (required.length === 0 && (ran.length === 0 || ran.some(row => row.state === 'running'))) return { kind: 'pending', detail: 'At least one check must run and all participating checks must settle' }
  const participating = required.length ? ran.filter(row => required.includes(row.name)) : ran
  const failed = [...new Set(participating.filter(row => row.state === 'failed').map(row => row.name))]
  return { kind: failed.length ? 'failed' : 'passed', failed }
}

export interface ReadinessClock {
  now(): number
  wait(ms: number, signal: AbortSignal): Promise<void>
}
const clock: ReadinessClock = {
  now: () => performance.now(),
  wait: (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('Review readiness cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  }),
}

/** G053/G054: host-owned elapsed budget; a hung observer cannot hold the host forever. */
export async function awaitReviewReadiness(source: ReviewReadinessSource | undefined, snapshot: BuildSnapshot, signal: AbortSignal, time: ReadinessClock = clock): Promise<GateResult> {
  if (!source) return { kind: 'unknown', detail: 'Review readiness observation source is missing' }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal.addEventListener('abort', cancel, { once: true })
  const deadline = time.now() + REVIEW_READINESS_BUDGET_MS
  // Wall-clock watchdog also bounds an observer or injected wait that never settles.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<GateResult>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve({ kind: 'unknown', detail: 'Review readiness budget exhausted' }) }, REVIEW_READINESS_BUDGET_MS)
  })
  const cancelled = new Promise<GateResult>(resolve => {
    controller.signal.addEventListener('abort', () => resolve({ kind: 'unknown', detail: 'Review readiness cancelled or budget exhausted' }), { once: true })
  })
  try {
    if (signal.aborted) controller.abort()
    return await Promise.race([timeout, cancelled, (async (): Promise<GateResult> => {
      let detail = 'Review checks have not settled'
      while (!controller.signal.aborted && time.now() < deadline) {
        const readiness = classifyReviewReadiness(snapshot, await source.observe(snapshot, controller.signal))
        if (time.now() >= deadline) break
        if (readiness.kind === 'passed' || readiness.kind === 'failed') return { kind: 'allow' }
        if (readiness.kind === 'unknown' || readiness.kind === 'blocked') return readiness
        detail = readiness.detail
        await time.wait(Math.min(REVIEW_READINESS_RETRY_MS, deadline - time.now()), controller.signal)
      }
      return { kind: 'unknown', detail: `Review readiness deferred: ${detail}; budget exhausted or cancelled` }
    })()])
  } catch (error) {
    return { kind: 'unknown', detail: `Review readiness observation failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
    controller.abort()
    signal.removeEventListener('abort', cancel)
  }
}
