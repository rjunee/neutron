import { unlink } from 'node:fs/promises'

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
 * Clearing the slot at first dispatch makes both read an absent file and wait for THIS
 * round's worker. A resumed step (an existing reservation) must not clear it: the trailer
 * sitting there may already be its own validated answer.
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
