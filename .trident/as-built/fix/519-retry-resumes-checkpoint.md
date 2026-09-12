## 2026-09-12 — a re-dispatch inherits the card's Ralph spend, gated on the board link rather than on the commit

`#519`, spec item `docs/spec-items/a-retry-must-resume-from-the-checkpoint.md`. The
follow-on structural item is `#629`.

**WHAT WAS ALREADY TRUE.** `builtButNeverReviewedSeed` → `dispatchBoardBoundBuild` →
`TridentRunStore.create` already carried a built-but-never-reviewed prior run's
`inner_checkpoint`, its recorded head, its findings, its `base_sha` and the review
`round` (from `checkpointRound`) onto the row that retries a card. `ralph_round` did
not travel: `create` wrote 0 onto every row it made.

**WHY THAT COLUMN IS NOT DECORATION.** `refireNextRalphTask` (`trident/orchestrator.ts`)
bounds a run's remaining Ralph loop on `nextRalphRound > run.max_ralph_rounds`, and
`buildWorkflowArgs` (`trident/inner-loop.ts`) threads the counter to the inner workflow
as `ralphRound`, where the plan-refresh cadence reads `ralphRound % PLAN_REFRESH_EVERY`.
A re-dispatch that writes 0 hands a mid-budget run a fresh count and lands its periodic
full re-plan on the wrong iteration of the same piece of work.

**THE SHIPPED SCOPE IS THE MID-BUDGET CASE, and getting to that sentence took three
review rounds, each of which caught this branch claiming more than it did.** The
history is recorded because the wrong versions are the useful part.

*Round 1 — the guard that inverted the change.* The carry required `round < max`
("the round must leave a re-fire"), on the theory that a row born at its cap is dead on
arrival. But that refusal is not a refusal: it falls back to a FRESH row at
`ralph_round: 0`, on which the only check is `0 + 1 > max_ralph_rounds` — false. So
re-dispatching a card AT its cap restored the whole budget, and one of this branch's own
tests asserted that reset as correct. A refusal to carry has to be a refusal, not a
reset. Nothing useful is lost by carrying an at-cap round, for a structural reason: a
seeded row resumes to a REVIEW, and `refireNextRalphTask` is reachable only from
`applyResult`'s `publish_requested && run.ralph && remaining_tasks > 0` arm, so such a
run still reviews, fixes and merges the commit it adopted — only a NEW planning
iteration is refused.

*Round 2 — half a bound is not a bound.* The round travelled; the cap did not. A prior
at `ralph_round: 5, max_ralph_rounds: 5`, re-dispatched with no explicit cap, produced a
row at `5 / 20`, because `create` supplies `DEFAULT_MAX_RALPH_ROUNDS` when the caller
names none — so `5 + 1 > 20` authorised fifteen more iterations and a card deliberately
capped at 5 got twenty. The branch's own boundary tests could not see it because they
used the default cap on both sides, which makes round-vs-cap and round-vs-default
indistinguishable. The cap now travels with the round as `min(prior, dispatch)`: a
re-dispatch may TIGHTEN the budget and never loosen it. A config cut reaches a resumed
card; a config RAISE does not, because if it did, an exhausted card could be resurrected
by editing config and pressing ▶ — the same defect re-entering through the cap instead
of the counter. `create` refuses a round whose cap was not named
(`TridentUnboundedCarriedRoundError`) so no future caller can write the half-pair.

*Round 3 — the headline claim was still false, and measured so.* "Press ▶ again and a
non-converging planner gets another full twenty" was still true, because
`refireNextRalphTask`'s exhaustion branch builds its terminal row through `failedRun`,
which does not touch `inner_checkpoint`: an exhausted run dies carrying
`ralph-task-built`, that name is not review-capable, so the row classifies
`died-before-build`, the seed declines it, and the next dispatch was a fresh build. The
reset cost one exhaustion cycle per press instead of none.

**THE FIX FOR THAT WAS NOT MORE MACHINERY — IT WAS SPLITTING THE TWO CARRIES APART, and
the same split fixes a second measured defect.** The ▶ task text is the card's
design-doc BODY (`work-board-surface.ts`) and `slugifyTask` truncates at 35 characters,
so an owner clarifying that doc between two presses keeps the same slug, the same branch
and the same card while the full text differs. Measured: a prior at `ralph_round 12` on
`fix-round-3`, tip unmoved, `linked_run_id` naming it, came back
`prior_run_is_a_different_card` with a fresh budget — same lane, same card, and a
diagnosis that was simply false. Clarifying a spec doc between two presses is the most
likely thing an owner does.

So the LINK decides identity and the TEXT decides only whether the COMMIT may be
adopted. `carriedRalphBudget` (`trident/run-disposition.ts`) is gated on
`item.linked_run_id === prior.id` plus both runs being governed, and nothing below can
veto it. The asymmetry is the hazard model rather than a compromise: adopting the wrong
card's unreviewed commit sends code to review under another card's title, while the
budget carry is MONOTONE — `min` can only tighten a bound, never authorise work. A wrong
budget carry under-authorises; a wrong commit carry authorises. The consequence is that
the spend now survives a moved tip, an unreadable ref, an unresumable prior (including
the `ralph-task-built` row exhaustion parks on) and a spec-doc edit — which closes round
3's measured table for a card that names its prior run. `create`'s old
"unseeded rows may not carry a round" rule was removed for exactly this: the row produced
when a commit is refused has no checkpoint, and the CARD has still spent those
iterations.

**WHAT IS STILL NOT TRUE, and `#629` holds it.** `max_ralph_rounds` is not a bound on
the CARD. The spend rides `linked_run_id`, so any dispatch without one starts at zero:
`onboarding/overnight/register.ts` creates governed runs with no card, and an owner who
re-cuts a card gets a new slug and no prior. The spend is also read from ONE prior row
(`latestTerminalBySlug`) rather than accumulated, so a gap in the chain loses everything
before it. The row is recreated by every dispatch, so a per-row counter is one reset away
by construction; holding the spend on the card is the durable fix. `#629` carries the
measurement. All three of the spec item's acceptance boxes are UNTICKED and the item
stays `open` — every one of them was ticked at some point in this PR and every tick was
wrong.

**THE TWO OTHER UNMET CRITERIA, named rather than quietly dropped.** The refusal is not
stated *on the card*: `work_board_items` has no free-text column (its text is `title`,
sanitised, and `design_doc_ref`) and `TridentBoardBinder` is `get`/`attachRun`/reconcile,
so a server log is all that exists and a server log is not card text. And planning tokens
ARE still re-spent: `cleanContinuation` (`trident/inner-workflow.mjs`) needs
`resumeCheckpoint === 'ralph-task-built'`, which this change never resumes, so the full
`plan:fable` survey runs for every shape it does resume. The test that pins the carried
round through `buildWorkflowArgs` now says in its own docblock that it is a WIRING
assertion and not that criterion.

**THE DIAGNOSTIC, and where it is emitted.** One `dispatch_resume_seed` line per dispatch
that had a prior terminal run AND created a row, reporting the commit reason
(`resumed`, `branch_tip_moved`, `branch_tip_unreadable_or_absent`,
`prior_run_has_no_resumable_build`, `prior_run_task_text_differs`, `card_names_no_run`,
`card_names_a_different_run`, `prior_run_is_a_different_card`) and the budget
(`ralph_round`, `max_ralph_rounds`, `budget_carried`) as separate fields, because one
word cannot honestly cover two gates. It moved: it used to be emitted before the plan-doc
await and before three refusal returns, so a dispatch that created NO row still logged
`reason=resumed` — the one line an operator would grep to find out what a retry
inherited, reporting a retry that never happened. It now reads its values off the ROW, so
it states what was WRITTEN rather than what was intended.

**ONE PREDICATE, AND A NEW LEAF TO HOLD IT.** `carryableRalphRound`, `carriedRalphCap`
and `DEFAULT_MAX_RALPH_ROUNDS` live in `trident/ralph-budget.ts`, which imports nothing.
They could not live in `store.ts`: it already imports `reviewCapableCheckpoint` from
`run-disposition.ts`, so a constant there read back would close a runtime import cycle
the G4 layering gate rejects — the cross-model reviewer reproduced that cycle by moving
the constant, which is why the leaf exists rather than a re-export. `create` re-applies
governed (`TridentUngovernedRalphRoundError`) and paired
(`TridentUnboundedCarriedRoundError`) at the write site.

**THE LAUNCHER-CRASH RELAUNCH IS A DIFFERENT PATH AND IS UNTOUCHED.** It recovers as a
continuation on the SAME row — `beginCrashRecovery` leaves `round` and `ralph_round`
alone — so it never calls `create`. Pinned by a test that counts `store.create` calls
through a real tick (must be zero) as well as asserting both counters; the reviewer
confirmed that pin would catch a regression.

**COVERAGE THE REVIEW FOUND MISSING, now present.** No test anywhere set
`deps.max_ralph_rounds` — the mutant replacing the dispatch ceiling with the prior row's
cap survived the entire suite — while `code-command.ts` threads it in production, so a
cap lowered between attempts was a live path with zero coverage. There are now four tests
where the prior cap differs from BOTH the default and the dispatch value. And the
`local`-mode proof was an injected stub that only showed `'local'` reaching a fake: two
tests now dispatch with NO injection against a git repo built on disk with no origin and
a recording `gh` shim, for a present ref and an absent one, so "works without gh or a
remote" is measured.
