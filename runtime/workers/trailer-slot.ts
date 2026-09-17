import { readFile, unlink, writeFile } from 'node:fs/promises'

/** Clear the result slot a step is about to dispatch against.
 *
 * The trailer path is keyed by ROLE, not by step: `open/wiring/project-build.ts:366`
 * composes `<state>/<role>.result` once at prepare time, before any round exists, while
 * `trident/build-run.ts:319` gives every round of that role its own `step_id`. A second
 * round therefore dispatches against a path that STILL HOLDS the previous round's
 * trailer, and both readers take it for this round's answer:
 * `decodeProjectTrailer` (`runtime/workers/project-runners.ts:50`) rejects the stale ids
 * as `Trailer step_id missing or mismatched`, and `claude-acting-turn.ts:200` reads the
 * file's mere existence as the dispatch having already ended — before any worker ran.
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
 * So the clear is made part of taking ownership. A reservation is ARMED only after the
 * slot has been cleared and immediately before the work is submitted. An unarmed
 * reservation therefore proves no dispatch was ever submitted for this step, which makes
 * both clearing the slot and submitting the work safe; that is not an uncertain dispatch
 * being replayed, it is one that provably never happened. An armed reservation means the
 * slot was already cleared for this step, so anything in it now belongs to this step. */
export async function reserveTrailerSlot(
  reservation: string,
  identity: string,
  resultPath: string,
): Promise<SlotReservation> {
  let held: string
  try {
    await writeFile(reservation, identity, { flag: 'wx', mode: 0o600 })
    held = identity
  } catch {
    let existing: string
    try {
      existing = await readFile(reservation, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return { kind: 'unknown', detail: `Step reservation ${reservation} could not be created or read (${code ?? String(error)}); whether this step was already dispatched is unknown.` }
    }
    if (existing !== identity && existing !== identity + ARMED) {
      return { kind: 'unknown', detail: 'Step is reserved for a different request.' }
    }
    held = existing
  }
  if (held === identity + ARMED) return { kind: 'resume' }
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
