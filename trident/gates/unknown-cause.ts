import { unknownCause as refusalDetail } from '@neutronai/runtime/refusal-cause.ts'

/**
 * Preserve the full host exception in the journal while bounding its relayed refusal.
 *
 * MERGE RESOLUTION (#1009 × #1011). #1009 landed this helper here with the
 * implementation inline, importing `TERMINAL_CAUSE_MAX` from `trident/inner-loop.ts`.
 * #1011 moved the implementation to `@neutronai/runtime/refusal-cause.ts` so
 * `runtime/workers/*` could use it WITHOUT importing the execution layer that step 2
 * deletes — and left a bare re-export here.
 *
 * Neither side survives alone: the re-export returns a `string`, while every gate call
 * site merged in #1009 expects a `GateResult`-shaped `{kind:'unknown', detail}`. So the
 * gate-facing wrapper stays (that is the contract its callers were written against) and
 * is implemented over the runtime helper (that is the home that outlives `inner-loop.ts`).
 *
 * One deliberate behaviour change from #1009's version: the cap now applies to the
 * CAUSE rather than to `message + cause`, so a long exception can no longer truncate
 * the gate's own sentence — which is the half an operator needs to know which gate spoke.
 */
export function unknownCause(message: string, error: unknown, runId: string): { kind: 'unknown'; detail: string } {
  return { kind: 'unknown', detail: refusalDetail(message, error, runId) }
}
