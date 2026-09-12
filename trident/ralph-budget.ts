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
 * The re-fire counter a resumed row may carry, or 0 when there is nothing to carry.
 *
 * THE CAP IS DELIBERATELY NOT CONSULTED, and an earlier revision of this file got
 * that exactly backwards (cross-model review, BLOCKER 1). It required
 * `round < max` — "the round must leave a re-fire" — on the theory that a row born
 * at its cap is dead on arrival. Trace the fallback: refusing the carry does not
 * refuse the dispatch, it produces a FRESH row at `ralph_round: 0`, and
 * `refireNextRalphTask` (orchestrator.ts) then asks `0 + 1 > max_ralph_rounds`,
 * which is false — so re-dispatching a card AT its cap restored the WHOLE budget
 * and the nineteen iterations after it. The conjunct meant to bound the loop was
 * the one thing unbounding it.
 *
 * SO EXHAUSTED STAYS EXHAUSTED. A round at or past the cap is carried verbatim and
 * the cap bites on the row that inherits it: `computeTransition` (state-machine.ts,
 * the single site the counter advances) and `refireNextRalphTask` both refuse at
 * `ralph_round + 1 > max_ralph_rounds`, loudly, naming `max_ralph_rounds` in the
 * failure reason. Nothing is bricked by that: a salvage-seeded row resumes to a
 * REVIEW (`fix-round-N`, `outer-published:*`), and `refireNextRalphTask` is reached
 * only from `applyResult`'s `publish_requested && run.ralph && remaining_tasks > 0`
 * arm — so the resumed run can still review, fix and merge the commit it adopted.
 * What it may not do is open a NEW planning iteration on a budget that is spent,
 * which is the whole point of having a budget.
 *
 * FAIL-CLOSED ON EVERY SHAPE IT CANNOT READ. `undefined`, `null`, a string, a
 * float, a negative, `NaN`, `Infinity` and anything past 2^53 answer 0 rather than
 * being coerced — the counter reaches this function from a stored INTEGER column
 * and from caller-supplied options, and `Number.isSafeInteger` is the only test
 * that rejects all of them. `round < 1` answers 0 too: zero is "nothing to carry",
 * which is the fresh-row value, and a negative is a garbled row. 0 always means
 * "take the fresh budget", never "fail the dispatch" — a build must not be lost to
 * an unreadable counter.
 */
export function carryableRalphRound(round: unknown): number {
  return Number.isSafeInteger(round) && (round as number) >= 1 ? (round as number) : 0
}

/**
 * Is `v` a value this repo can use as a Ralph re-fire cap?
 *
 * A SAFE INTEGER ≥ 0, AND THE ZERO IS THE POINT (cross-model review, final round).
 * An earlier revision of this file required `>= 1`, treated everything else as
 * "absent", and substituted {@link DEFAULT_MAX_RALPH_ROUNDS} — so
 * `carriedRalphCap(30, 0)` answered **20**, and a dispatch that asked for ZERO
 * iterations authorised fifteen more on a run already at round 5. That is not a
 * fail-closed default, it is the most permissive value available, chosen because an
 * edge value was mistaken for an unset one. Nothing in this repo establishes a
 * positive-only contract for the field, so "non-positive means absent" was an
 * assumption rather than a fact.
 *
 * ZERO IS A COHERENT REQUEST — a card capped at zero gets no Ralph iterations, and
 * `refireNextRalphTask` / `computeTransition` refuse the first one loudly, naming
 * `max_ralph_rounds`. So zero is VALID and preserved. Only `undefined`/`null` mean
 * absent, and only they get a default.
 *
 * Everything else — negative, fractional, `NaN`, `±Infinity`, past 2^53, a string —
 * is INVALID rather than absent, and this predicate answers false for it so the
 * caller can refuse instead of substituting. `Number.isSafeInteger` is the only test
 * that rejects all of them at once.
 */
export function isRalphCap(v: unknown): boolean {
  return Number.isSafeInteger(v) && (v as number) >= 0
}

/**
 * The re-fire cap the row that RESUMES a prior run must be born with: the TIGHTER of
 * the cap that run actually had and the cap this dispatch asked for.
 *
 * WHY A CAP HAS TO TRAVEL AT ALL (cross-model review round 2, BLOCKER). Carrying the
 * round alone does not make a bound, because the bound is a PAIR. A prior run at
 * `ralph_round: 5, max_ralph_rounds: 5` re-dispatched with no explicit cap produced a
 * row at `5 / 20` — the round travelled, the cap did not, and `5 + 1 > 20` is false,
 * so a card someone deliberately capped at 5 got 20.
 *
 * THE RULE IS ONE-DIRECTIONAL: a re-dispatch may TIGHTEN the budget, never loosen
 * it. `Math.min` is the whole implementation and each direction is deliberate.
 *
 *   - A cap LOWER on the prior row survives the re-dispatch: a deliberate 5 is the
 *     card's own bound and a dispatch carrying the ambient default must not raise it.
 *   - A cap lowered in CONFIGURATION since the prior run applies immediately.
 *     Tightening is always safe.
 *   - A cap RAISED in configuration does NOT reach a resumed card. This is the
 *     load-bearing half: otherwise an exhausted card could be resurrected by editing
 *     config and pressing ▶ — the unbounded-retry defect re-entering through the cap
 *     instead of the counter. The escape hatch is deliberate and explicit rather than
 *     ambient: the carry only happens when the card NAMES the prior run, so re-cutting
 *     the card takes the fresh dispatch with its fresh budget, on purpose.
 *
 * ABSENT AND INVALID ARE DIFFERENT ANSWERS, and conflating them is what the final
 * blocker was.
 *
 *   - `dispatch_cap` ABSENT (`undefined`/`null`) is the only case that gets
 *     {@link DEFAULT_MAX_RALPH_ROUNDS} — and that is right, because it is exactly what
 *     `TridentRunStore.create` writes for a row whose creator named no cap. Nothing is
 *     being substituted for a value someone supplied.
 *   - `dispatch_cap` PRESENT is honoured as given, ZERO INCLUDED. It is never widened.
 *   - `dispatch_cap` present but INVALID ({@link isRalphCap} false) carries NOTHING.
 *     The invalid value then reaches `create`, which REFUSES it by name — loud, and at
 *     the write site, rather than quietly becoming the most permissive number in the
 *     file. Returning `null` here is what keeps this function from having to throw.
 *   - `prior_cap` unreadable carries NOTHING either, for the reason the pair rule
 *     exists: a round without the bound it was spent against is the `5 / 20` shape.
 *     There is no prior bound to preserve, so the dispatch's own cap applies — which
 *     is the pre-existing behaviour for a legacy or garbled row, not a loosening.
 */
export function carriedRalphCap(prior_cap: unknown, dispatch_cap: unknown): number | null {
  if (!isRalphCap(prior_cap)) return null
  // ABSENT MEANS ABSENT — and nothing else does.
  if (dispatch_cap === undefined || dispatch_cap === null) {
    return Math.min(prior_cap as number, DEFAULT_MAX_RALPH_ROUNDS)
  }
  // PRESENT BUT UNREADABLE: carry nothing and let the write site refuse the raw value
  // by name. Substituting a default here is precisely the failure this rules out.
  if (!isRalphCap(dispatch_cap)) return null
  return Math.min(prior_cap as number, dispatch_cap as number)
}
