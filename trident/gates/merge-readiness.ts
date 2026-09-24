import type { GateResult } from '../build-run.ts'
import { REVIEW_READINESS_BUDGET_MS, REVIEW_READINESS_RETRY_MS, type ReadinessClock } from './review-readiness.ts'

export type MergeReadiness = GateResult | { kind: 'pending'; detail: string }

const clock: ReadinessClock = {
  now: () => performance.now(),
  wait: (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('Merge readiness cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  }),
}

/** G049/G053: refreshed checks wait inside the approved run, without buying a round. */
export async function awaitMergeReadiness(
  observe: (signal: AbortSignal) => Promise<MergeReadiness>, signal: AbortSignal,
  time: ReadinessClock = clock,
): Promise<GateResult> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal.addEventListener('abort', cancel, { once: true })
  const deadline = time.now() + REVIEW_READINESS_BUDGET_MS
  let lastPending = 'CI has not settled'
  const deferred = (reason: string): GateResult => ({ kind: 'unknown', detail: `Merge readiness deferred: ${lastPending}; ${reason}` })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<GateResult>(resolve => {
    timer = setTimeout(() => { resolve(deferred('budget exhausted')); controller.abort() }, REVIEW_READINESS_BUDGET_MS)
  })
  const cancelled = new Promise<GateResult>(resolve => {
    controller.signal.addEventListener('abort', () => resolve(deferred('cancelled')), { once: true })
  })
  try {
    if (signal.aborted) controller.abort()
    return await Promise.race([timeout, cancelled, (async (): Promise<GateResult> => {
      while (!controller.signal.aborted && time.now() < deadline) {
        const readiness = await observe(controller.signal)
        if (readiness.kind === 'pending') lastPending = readiness.detail
        // An observation acquired after cancellation or the deadline cannot authorize merge.
        if (controller.signal.aborted || time.now() >= deadline) break
        if (readiness.kind !== 'pending') return readiness
        await time.wait(Math.min(REVIEW_READINESS_RETRY_MS, deadline - time.now()), controller.signal)
      }
      return deferred(controller.signal.aborted ? 'cancelled' : 'budget exhausted')
    })()])
  } catch (error) {
    return deferred(`observation failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
    controller.abort()
    signal.removeEventListener('abort', cancel)
  }
}
