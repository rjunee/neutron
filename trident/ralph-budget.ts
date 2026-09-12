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
 * WHY THEY MUST AGREE (#519). A re-dispatch of a card THAT NAMES ITS PRIOR RUN
 * carries that run's `ralph_round` and cap onto the new row, so for that path the
 * Ralph bound follows the card rather than the attempt. `carriedRalphBudget`
 * (run-disposition.ts) decides whether the pair may be carried;
 * `TridentRunStore.create` (store.ts) refuses a pair it should not have been
 * offered. Two copies of the rule would let the producer offer exactly the value
 * the write site throws on, which turns a salvageable dispatch into a
 * `backend_error` — the failure mode this file exists to make impossible.
 *
 * AND THAT IS THE WHOLE OF THE CLAIM. An earlier version of this paragraph said the
 * bound "is a property of the CARD" and that `max_ralph_rounds` is not resettable by
 * pressing ▶ again — which is exactly what this change spent two review rounds
 * establishing to be FALSE, in the file that implements the rule, where a future
 * reader is most likely to trust it. It was written before the escapes were
 * understood and nothing re-reads a comment you did not touch. The escapes, both
 * measured and both pinned as tests in `retry-resumes-checkpoint.test.ts`:
 *
 *   - ONE CLICK CLEARS THE LINK. `work-board/store.ts` NULLs `linked_run_id` when a
 *     card leaves the `failed` lane (`nextStatus('failed')` to `'upcoming'`, the
 *     ordinary status-dot advance) and again on `done` to `upcoming`. The carry is
 *     gated on that link, so the next dispatch inherits nothing: same card, same
 *     slug, same branch, full fresh budget.
 *   - AN INTERVENING NON-GOVERNED RUN LAUNDERS THE SPEND. `carriedRalphBudget`
 *     answers null when either run is not governed, and `latestTerminalBySlug`
 *     returns only the LATEST terminal row — so one ralph-off dispatch between two
 *     governed ones drops the count entirely. That row is present and readable; it
 *     is simply not governed, which is why it is not a "gap in the chain".
 *
 * Making the bound genuinely card-level is `#629`, not this file. What this file
 * guarantees is narrower and worth stating exactly: WHEN a governed re-dispatch
 * names the governed prior run it is resuming, the spend and the cap travel
 * together, and the cap can only tighten.
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
 * Is `v` a value this repo can use as a Ralph re-fire COUNTER?
 *
 * THE SAME DOMAIN AS {@link isRalphCap}, AND THE SYMMETRY IS THE POINT (cross-model
 * review, final round — the FOURTH defect of one shape in this lane). The cap got a
 * careful three-way classification while the counter quietly normalised every value it
 * did not understand to `0`. So a governed prior at `{ ralph_round: NaN,
 * max_ralph_rounds: 20 }` produced `{ 0, 20 }`, and `computeTransition` then authorised
 * the next transition because `0 + 1 > 20` is false: the budget reset, restored for
 * malformed persisted data, in the field next to the one that had just been fixed.
 *
 * A safe integer >= 0. Zero is VALID and means "nothing spent" — the fresh-row value.
 * Negative, fractional, `NaN`, `±Infinity`, past 2^53 and non-numbers are INVALID
 * rather than "unset", and callers must refuse them instead of substituting, because
 * every substitution available is more permissive than the truth.
 */
export function isRalphRound(v: unknown): boolean {
  return Number.isSafeInteger(v) && (v as number) >= 0
}

/**
 * The re-fire counter a caller's INPUT may be normalised to — `0` when genuinely
 * absent, the value when readable, and `null` when present but unreadable.
 *
 * THREE ANSWERS, NOT TWO, for the reason {@link carriedRalphCap} has three: absent and
 * invalid are different facts and collapsing them is what produced defect four. Absent
 * (`undefined`/`null`) is a caller that named no counter, and `0` is the right answer
 * for it — it is what `create` has always written for a fresh row. A PRESENT value that
 * is not a counter is refused by returning `null`, so the write site can name it rather
 * than quietly charge the card nothing.
 *
 * NOTE THAT `null` HERE IS THE STRICT ANSWER, not the permissive one — the opposite of
 * `carriedRalphCap`'s `null`. For a CAP, carrying nothing leaves the dispatch's own cap
 * in place, so `null` costs nothing. For a COUNTER there is no such fallback: carrying
 * nothing IS the reset. That asymmetry is why callers must treat a `null` round as a
 * REFUSAL and never as "carry zero".
 */
export function carryableRalphRound(round: unknown): number | null {
  if (round === undefined || round === null) return 0
  return isRalphRound(round) ? (round as number) : null
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
