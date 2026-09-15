import { TERMINAL_CAUSE_MAX, unknownCause as refusalDetail } from '@neutronai/runtime/refusal-cause.ts'

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
 * THE CAP APPLIES TO THE WHOLE DETAIL, exactly as #1009 had it. I briefly "improved"
 * this to cap only the cause so a long exception could not truncate the gate's own
 * sentence — and two tests caught it. They are right: `TERMINAL_CAUSE_MAX` bounds WHAT
 * IS PERSISTED, so capping only the cause lets `message + cause` exceed the bound the
 * column relies on. A merge resolution is the worst possible place to change behaviour,
 * because it makes a regression indistinguishable from an improvement.
 */
export function unknownCause(message: string, error: unknown, runId: string): { kind: 'unknown'; detail: string } {
  return { kind: 'unknown', detail: refusalDetail(message, error, runId).slice(0, TERMINAL_CAUSE_MAX) }
}
