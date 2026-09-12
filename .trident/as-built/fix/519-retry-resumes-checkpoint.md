## 2026-09-12 — a retry resumes the dead run's ralph round, not just its commit, and every refusal to resume says so

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

**The carry is gated on the seed's existing proof, plus the two facts a COUNTER needs.**
The caller has already shown that the card names this run (`linked_run_id`, fail-closed on
absent/whitespace), that the run's task text is byte-identical (the 35-character slug is not
an identity), that the run is `built-never-reviewed` and not `stopped`, that it recorded a
40-hex head and a 40-hex `base_sha`, and that the LIVE branch tip — read through the same
ref the launch will consult — is exactly that head. `carriedRalphRound`
(`trident/run-disposition.ts`) adds: BOTH runs must be governed (`opts.ralph` is the mode
the new row is born in, `run.ralph` the mode the count was produced in — a Ralph iteration
count means nothing on a row that will not run a Ralph loop), and the round must LEAVE A
RE-FIRE inside the cap the new row will get. A round at or past that cap would create a row
`refireNextRalphTask` refuses on its first handoff: dead on arrival, which is strictly worse
than a fresh budget. Everything it cannot read — a non-integer, a negative, `undefined`, a
value past 2^53, an unreadable cap — answers 0, which is the pre-existing fresh-row value,
so no shape it declines behaves differently from before.

**One predicate, three places, and a new leaf to hold it.** `ralphRoundIsSpendable` +
`DEFAULT_MAX_RALPH_ROUNDS` live in `trident/ralph-budget.ts`, which imports nothing. They
could not live in `store.ts`: `store.ts` already imports `reviewCapableCheckpoint` from
`run-disposition.ts`, so a constant there read by `run-disposition.ts` would close a runtime
import cycle the G4 layering gate rejects. The producer (`builtButNeverReviewedSeed`) offers
only a spendable round; `create` REFUSES one that is not (`TridentUnusableRalphRoundError`)
and refuses any non-zero round on a row that seeds no checkpoint
(`TridentUnseededPinError`), because a fresh build has spent no iterations. Two copies of
`20` would have let the producer offer exactly the value the write site throws on, turning a
salvageable dispatch into a `backend_error`.

**`local` merge-mode is covered, and that is the point of not using the PR probe.** The
spec item's third criterion is about `detectExistingPr`: a resume that depends on asking
GitHub for the branch's open PRs silently degrades to nothing where there is no origin and
no `gh`, and a test written only in `pr` mode passes with the defect present. This resume
depends on the durable row plus `defaultReadBranchTip`, which reads `ls-remote` in `pr` mode
and `rev-parse --verify` on the local ref in `local` mode — the same proof, both modes, with
both pinned as tests.

**Silence is the defect the spec item named, so silence is gone.** Every arm that declines
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
report. The BOARD is not written to: the chokepoint's binder surface is
`get`/`attachRun`/reconcile with no free-text channel, so the card's honest record is its
linked run row plus that line.

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

**Mutation-checked.** Thirteen mutations, each reverting one guard, each proven RED and
restored: dropping the carry at the dispatch site; restoring `ralph_round: 0` in `create`;
making the evidence gate always resume; treating an unreadable tip as a match; dropping the
leaves-a-re-fire arm; dropping each of the two governed-mode arms; allowing an unseeded row
to carry a round; clamping instead of refusing an unspendable one; removing the
`dispatch_resume_seed` line; letting a card that names a different run seed anyway; coercing
a garbled round instead of reading it as 0; and letting `beginCrashRecovery` reset the Ralph
budget (which reds the pre-existing crash-recovery test as well as the new pin).
