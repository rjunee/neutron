## 2026-09-12 — a retry resumes the dead run's ralph round, not just its commit, and an exhausted card stays exhausted

`#519`, spec item `docs/spec-items/a-retry-must-resume-from-the-checkpoint.md`.

**What was already true and what was not.** The `inner_checkpoint` half of continuity
landed with the salvage-resume seed: `dispatchBoardBoundBuild` reads the card's latest
TERMINAL run, `builtButNeverReviewedSeed` decides whether its commit may be adopted, and
the new row is created carrying `inner_checkpoint`, `inner_checkpoint_head`,
`inner_checkpoint_findings` and `base_sha` — so `launch()` takes its resume path and the
commit goes to REVIEW. `round` travelled too, derived from the checkpoint name by
`checkpointRound`. `ralph_round` did not: `TridentRunStore.create` wrote `ralph_round: 0`
onto every row it made, unconditionally.

**Why that column is not decoration.** Two readers in this tree, both measurable:
`refireNextRalphTask` (`trident/orchestrator.ts`) bounds the WHOLE Ralph loop on
`nextRalphRound > run.max_ralph_rounds`, and `buildWorkflowArgs` (`trident/inner-loop.ts`)
threads the counter to the inner workflow as `ralphRound`, where the planner-cadence gate
reads `Number.isSafeInteger(ralphRoundNum) && ralphRoundNum >= 1 && ralphRoundNum %
PLAN_REFRESH_EVERY !== 0` to choose between the cheap continuation planner and the full
survey (`trident/inner-workflow.mjs`). So a reset counter cost two things. The bound stopped
applying to the CARD — press ▶ again and a non-converging planner got another full twenty
iterations, indefinitely, each attempt believing it had spent nothing — and the
plan-refresh cadence restarted, so the periodic full re-plan landed on the wrong iteration
and the governed plan was regenerated off-schedule. The durable row already held the answer;
nothing had to be measured again, only carried.

**The carry is gated on the seed's existing proof, plus the one fact a COUNTER needs.**
The caller has already shown that the card names this run (`linked_run_id`, fail-closed on
absent/whitespace), that the run's task text is byte-identical (the 35-character slug is not
an identity), that the run is `built-never-reviewed` and not `stopped`, that it recorded a
40-hex head and a 40-hex `base_sha`, and that the LIVE branch tip — read through the same
ref the launch will consult — is exactly that head. `carriedRalphRound`
(`trident/run-disposition.ts`) adds one thing: BOTH runs must be governed (`opts.ralph` is
the mode the new row is born in, `run.ralph` the mode the count was produced in — a Ralph
iteration count means nothing on a row that will not run a Ralph loop). Everything it cannot
read — a non-integer, a negative, `undefined`, a value past 2^53 — answers 0, which is the
pre-existing fresh-row value, so no shape it declines behaves differently from before.

**AND THE CAP IS NOT PART OF THAT GATE. Getting this wrong inverted the whole change.**
The first revision of this fix added a second conjunct — the round must leave a re-fire
inside the cap the new row will get — on the theory that a row born at its cap is dead on
arrival. The cross-model review's BLOCKER 1 traced the fallback and it is the opposite of
prudent: refusing the carry does not refuse the DISPATCH, it produces a FRESH row at
`ralph_round: 0`, and `refireNextRalphTask` then asks `0 + 1 > max_ralph_rounds`, which is
false. **Re-dispatching a card AT its cap therefore restored all twenty iterations** — the
exact unbounded-retry defect this change exists to close, reintroduced by the guard meant to
prevent it. Worse, one of this branch's own tests asserted that reset as correct, which is
how a wrong answer survives review.

So the round travels VERBATIM, cap included, and `max_ralph_rounds` bites on the row that
inherits it: `computeTransition` (state-machine.ts, the single site the counter advances) and
`refireNextRalphTask` both refuse at `ralph_round + 1 > max_ralph_rounds`, loudly, naming the
cap in the failure reason. **Exhausted stays exhausted.** Nothing useful is lost by that, and
the reason is structural rather than hopeful: a salvage-seeded row resumes to a REVIEW
(`fix-round-N`, `outer-published:*`), and `refireNextRalphTask` is reachable only from
`applyResult`'s `publish_requested && run.ralph && remaining_tasks > 0` arm — so the resumed
run still reviews, fixes and merges the commit it adopted. What it may not do is open a NEW
planning iteration on a budget that is spent. The write site follows the same rule for a
second reason: throwing there would convert an exhausted card's dispatch into a
`backend_error` (HTTP 500, nothing queued), and clamping would manufacture budget out of a
number nobody asked for.

It refuses on `branch_tip_moved`, `branch_tip_unreadable_or_absent`,
`prior_run_has_no_resumable_build`, `card_names_a_different_run`, `card_names_no_run` and
`prior_run_is_a_different_card` — every one of them a fall-back to the byte-identical fresh
dispatch.

**One predicate, two places, and a new leaf to hold it.** `carryableRalphRound` +
`DEFAULT_MAX_RALPH_ROUNDS` live in `trident/ralph-budget.ts`, which imports nothing. They
could not live in `store.ts`: it already imports `reviewCapableCheckpoint` from
`run-disposition.ts`, so a constant there read back would close a runtime import cycle the G4
layering gate rejects. The producer (`builtButNeverReviewedSeed`) and the write site
(`create`) normalise through the same function, so "is this a readable round" cannot drift
between them; `create` additionally refuses any non-zero round on a row that seeds no
checkpoint (`TridentUnseededPinError`), because a fresh build has spent no iterations.

**`local` merge-mode is covered, and that is the point of not using the PR probe.** The
spec item's third criterion is about `detectExistingPr`: a resume that depends on asking
GitHub for the branch's open PRs silently degrades to nothing where there is no origin and
no `gh`, and a test written only in `pr` mode passes with the defect present. This resume
depends on the durable row plus `defaultReadBranchTip`, which reads `ls-remote` in `pr` mode
and `rev-parse --verify` on the local ref in `local` mode — the same proof, both modes, with
both pinned as tests.

**THE CARD-TEXT HALF OF CRITERION 1 IS NOT DELIVERED, and the box stays unticked.** The
criterion is an OR — carry, *or* state plainly on the card that you will not — and the
carrying branch is what shipped. The refusal branch did not. The first revision of this
branch ticked that box and set the item `status: done` on the strength of a `log.info` line,
which the cross-model review's BLOCKER 2 correctly called out: **a server log is not card
text**, and a ticked box the code does not satisfy is worse than an unticked one because it
removes the thing that would otherwise make someone look. It cannot be met without a new
surface: `work_board_items` has no free-text column — its text is `title` (sanitised;
rewriting it would destroy the card's own name) and `design_doc_ref` — and
`TridentBoardBinder`, the structural surface this chokepoint may touch, is
`get`/`attachRun`/reconcile. Delivering it means a column plus a migration, a render in the
card UI, and wiring at three composition roots, in packages this lane does not own. The spec
item now says so under "Not met" and remains `open` for it.

**What DID replace the silence, honestly labelled.** Every arm that declines
to resume falls back to a byte-identical FRESH dispatch, and a fresh dispatch looks exactly
like a first attempt — a null checkpoint and a zero counter. So a card that silently rebuilt
finished work was indistinguishable from a card that had never been built. Every dispatch
with a prior TERMINAL run to ask about now emits one `dispatch_resume_seed` line:
`reason=resumed` with the checkpoint and round carried, or the proof that failed —
`branch_tip_moved` (a real 40-hex that is not the recorded one: the branch moved under this
lane), `branch_tip_unreadable_or_absent` (`unknown` authorises nothing, and the sentence
tells an operator to look at the credential rather than the branch),
`prior_run_has_no_resumable_build`, `card_names_a_different_run`, `card_names_no_run`,
`prior_run_is_a_different_card`. A card with no prior stays silent — there is nothing to
report. That is strictly more than the nothing there was before, and strictly less than the
criterion asks for.

**THE LAUNCHER-CRASH RELAUNCH IS A DIFFERENT PATH AND IS UNTOUCHED.** A crashed launcher is
recovered as a continuation on the SAME row — `beginCrashRecovery` leaves `round` and
`ralph_round` alone and `launch()` re-fires with the recorded checkpoint, branch and PR — so
it never calls `create` and nothing here can reach it. That is now pinned by a test that
counts `store.create` calls through a real tick (it must be zero) as well as asserting the
counters, so this change cannot silently alter the path it was modelled on.

**Still not resumed, deliberately.** A run that died at the `ralph-task-built` handoff.
`terminalRunDisposition` classifies it `died-before-build` because
`resumeOnUnchangedHead` rebuilds it by design, and it is the one shape that could reach the
cheap `plan:next` continuation planner. Carrying it needs the disposition taxonomy widened
and `reviewCapableCheckpoint` relaxed at the store's write site, which is a different
argument from this one and a separate item — not a silent extension of it.

**Mutation-checked — seventeen mutations, each reverting one guard, each proven RED and
restored.** Eleven on the carry and its evidence gate: dropping the carry at the dispatch
site; restoring `ralph_round: 0` in `create`; making the evidence gate always resume;
treating an unreadable tip as a match; dropping each of the two governed-mode arms; allowing
an unseeded row to carry a round; removing the `dispatch_resume_seed` line; letting a card
that names a different run seed anyway; coercing a garbled round instead of reading it as 0;
and letting `beginCrashRecovery` reset the Ralph budget (which reds the pre-existing
crash-recovery test as well as the new pin).

Six more on the cap behaviour specifically, because that is where this branch was wrong
once already — and the first of them is the BLOCKER-1 regression itself, caught now by both
a unit test and an end-to-end one: reinstating the cap gate in the producer (at the cap →
reset to 0); reinstating a cap refusal at the write site; clamping the carried round to the
cap; carrying `round + 1` (exhausts a round early); carrying `round - 1` (buys a free round
back); and dropping the carry entirely. The cap is asserted on BOTH sides of the bound — at
it and one below it — on rows produced by the real dispatch, so no mutation can pass by
refusing every iteration.
