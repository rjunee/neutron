import { readFile, unlink, writeFile } from 'node:fs/promises'

/** Clear the result slot a step is about to dispatch against.
 *
 * The trailer path is keyed by ROLE, not by step: `open/wiring/project-build.ts:366`
 * composes `<state>/<role>.result` once at prepare time, before any round exists, while
 * `trident/build-run.ts:319` gives every round of that role its own `step_id`. A second
 * round therefore dispatches against a path that STILL HOLDS the previous round's
 * trailer. That USED to be taken for this round's answer by both readers, and was the
 * defect this clear was written for.
 *
 * Both readers are now step-aware as well (#1123): `decodeProjectTrailer` returns
 * `not-current-step` for a well-formed identity belonging to another request rather than
 * a terminal `unknown`, and the acting turns continue past a trailer that is not theirs
 * instead of reporting the dispatch ended. The two guards are deliberately independent —
 * the reader means a missed clear cannot produce a WRONG ANSWER, only a wait; this clear
 * means the wait is not spent on a slot that will never be overwritten. Neither replaces
 * the other, and removing either re-opens a real failure.
 *
 * Absence is the ordinary first-round case and is success. Any other failure leaves a
 * foreign trailer in place, which the caller would otherwise read as its own result, so
 * it is reported rather than swallowed — "there was nothing to clear" and "the earlier
 * trailer is still there" must not share a signal. */
export async function clearTrailerSlot(path: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await unlink(path)
    return { ok: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true }
    return { ok: false, detail: `Result slot ${path} may still hold an earlier round's trailer and could not be cleared (${code ?? String(error)}); this step's outcome is unknown.` }
  }
}

/** A step either dispatches, resumes, or cannot establish which. */
export type SlotReservation =
  | { kind: 'dispatch' }
  | { kind: 'resume' }
  | { kind: 'unknown'; detail: string }

/** Marks a reservation whose slot has been cleared AND whose work was about to be
 * submitted. It is written as a suffix so the identity comparison below still
 * recognises the request, and so the armed and unarmed states are distinguishable
 * from the file alone after any restart. */
const ARMED = '\n#dispatch-armed\n'

/** Take ownership of a step, clearing its result slot exactly once.
 *
 * Neither ordering of "reserve" and "clear" is correct on its own, and both were tried:
 *
 * - Reserve, then clear: a replacement arriving in that window finds the reservation,
 *   calls it a resume, skips the clear and reads the PREVIOUS round's trailer. This is
 *   the original defect, reached through a narrower door.
 * - Clear, then reserve: a genuine resume — the worker wrote its trailer and the gateway
 *   was then replaced — has its own completed receipt destroyed, and the step is replayed
 *   with its outcome already lost.
 *
 * So the clear is made part of taking ownership. The exclusive `wx` create is the only
 * thing that confers it: exactly one caller can create the reservation, and only that
 * caller clears the slot, arms the reservation and dispatches. Arming happens after the
 * clear and immediately before the work is submitted, so an ARMED reservation proves the
 * slot was already cleared for this step and anything in it now belongs to this step.
 *
 * A reservation that exists but is UNARMED is NOT taken over. A second caller cannot tell
 * "the owner died between creating and arming" from "the owner is a few milliseconds from
 * arming", and taking over on that guess dispatches the bounded task twice against one
 * shared trailer. It is reported as unknown instead, which is what it is, and matches the
 * standing contract that an uncertain dispatch is never replayed — the host reconciles the
 * original step. Crucially the stale slot is still never read as this step's answer. */
export async function reserveTrailerSlot(
  reservation: string,
  identity: string,
  resultPath: string,
): Promise<SlotReservation> {
  try {
    await writeFile(reservation, identity, { flag: 'wx', mode: 0o600 })
  } catch {
    let existing: string
    try {
      existing = await readFile(reservation, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return { kind: 'unknown', detail: `Step reservation ${reservation} could not be created or read (${code ?? String(error)}); whether this step was already dispatched is unknown.` }
    }
    if (existing === identity + ARMED) return { kind: 'resume' }
    if (existing === identity) {
      return { kind: 'unknown', detail: `Step ${reservation} is held by another instance that has not yet dispatched it; its dispatch state is unknown and it is not replayed here.` }
    }
    return { kind: 'unknown', detail: 'Step is reserved for a different request.' }
  }
  const cleared = await clearTrailerSlot(resultPath)
  if (!cleared.ok) return { kind: 'unknown', detail: cleared.detail }
  try {
    await writeFile(reservation, identity + ARMED, { mode: 0o600 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // The slot is clear but the arming is not durable. Dispatching now would let a
    // replacement clear the slot a second time, under a worker already writing to it.
    return { kind: 'unknown', detail: `Step reservation ${reservation} could not be armed (${code ?? String(error)}); this step was not dispatched.` }
  }
  return { kind: 'dispatch' }
}
