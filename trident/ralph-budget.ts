/**
 * @neutronai/trident — the Ralph re-fire BUDGET, and the one predicate that says
 * whether a given re-fire counter can still be spent under it.
 *
 * A LEAF ON PURPOSE. It imports nothing at all, because the two modules that must
 * agree about this number sit on opposite sides of an existing edge: `store.ts`
 * imports `reviewCapableCheckpoint` from `run-disposition.ts`, so a constant
 * living in `store.ts` and read by `run-disposition.ts` would close a runtime
 * import cycle the G4 gate rejects. The same shape `ascii-trim.ts` and
 * `checkpoint-round.ts` already take: one concept, no dependencies, shared by
 * every site that has to give the same answer.
 *
 * WHY THEY MUST AGREE (#519). A re-dispatch of a card whose previous run died
 * carries that run's `ralph_round` onto the new row, so the Ralph loop's bound is
 * a property of the CARD rather than of whichever attempt happens to be running —
 * without it, `max_ralph_rounds` is unenforceable by anyone willing to press ▶
 * again. `builtButNeverReviewedSeed` (run-disposition.ts) decides whether a round
 * may be carried; `TridentRunStore.create` (store.ts) refuses one it should not
 * have been offered. Two copies of the rule would let the producer offer exactly
 * the value the write site throws on, which turns a salvageable dispatch into a
 * `backend_error` — the failure mode this file exists to make impossible.
 */

/**
 * The re-fire cap a run gets when its creator names none — the value
 * `TridentRunStore.create` has always written for `max_ralph_rounds`.
 *
 * The `DEFAULT 20` on the column is not the authority here: `create` always
 * supplies the field, so this constant is what every row born through it carries,
 * and it is what a caller deciding whether a carried round is spendable must
 * resolve the cap to when the dispatch names no explicit cap of its own.
 */
export const DEFAULT_MAX_RALPH_ROUNDS = 20 as const

/**
 * Can a row capped at `max` actually SPEND a re-fire counter of `round`?
 *
 * `refireNextRalphTask` (orchestrator.ts) refuses at
 * `ralph_round + 1 > max_ralph_rounds`, so a row born at or past its own cap
 * cannot continue the Ralph loop at all — carrying a round like that onto a
 * resumed row produces a run that is dead on arrival, which is strictly worse
 * than starting over with a fresh budget. `round < max` is exactly the condition
 * that leaves one re-fire available.
 *
 * FAIL-CLOSED ON EVERY SHAPE IT CANNOT READ. `undefined`, `null`, a string, a
 * float, a negative, `NaN`, `Infinity` and anything past 2^53 all answer false
 * rather than being coerced — the counter reaches this function from a stored
 * INTEGER column and from caller-supplied options, and `Number.isSafeInteger` is
 * the only test that rejects all of them. `round < 1` answers false too: zero is
 * "nothing to carry", which is the fresh-row value, and a negative is a garbled
 * row. False always means "take the fresh budget", never "fail the dispatch".
 */
export function ralphRoundIsSpendable(round: unknown, max: unknown): boolean {
  return (
    Number.isSafeInteger(round) &&
    (round as number) >= 1 &&
    Number.isSafeInteger(max) &&
    (round as number) < (max as number)
  )
}
