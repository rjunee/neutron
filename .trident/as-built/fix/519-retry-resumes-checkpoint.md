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

**AN EDGE VALUE IS NOT AN UNSET VALUE — the third defect of that shape in this lane.**
`carriedRalphCap` required a cap `>= 1`, treated everything else as absent, and
substituted `DEFAULT_MAX_RALPH_ROUNDS`. Measured: `carriedRalphCap(30, 0)` answered
**20**, so a dispatch asking for ZERO iterations wrote a resumed run at `5 / 20` and
authorised fifteen more. The helper's own docblock claimed it was "fail-closed on either
value being unreadable" while substituting the most permissive number in the file, which
is the definition of failing open. Nothing in this repo establishes a positive-only
contract for the field, so "non-positive means absent" was an assumption.

The rule now: **only `undefined`/`null` are ABSENT**, and only they get a default —
which is right, because that is exactly what `create` writes for a row whose creator
named no cap. A PRESENT value is honoured as given, zero included: a card capped at zero
gets no Ralph iterations, which is a coherent request that `computeTransition` /
`refireNextRalphTask` refuse loudly on their own terms. A PRESENT-but-unreadable value
(negative, fractional, `NaN`, `±Infinity`, past 2^53, a non-number) carries NOTHING, and
the raw value then reaches `create`, which REFUSES it by name
(`TridentInvalidRalphCapError`) rather than choosing a number on the caller's behalf.
`NaN` is the one that mattered most: `ralph_round + 1 > NaN` is false forever, so a
config typo produced an UNBOUNDED Ralph loop — the exact opposite of a cap.

All three defects in this lane were the same mistake: the at-cap reset, the
cap-not-carried, and zero-becomes-default each treated an edge value as "unset" and
reached for the permissive default. So every numeric fallback in the files this lane
touches was audited rather than just this one:

| site | verdict |
|---|---|
| `store.ts` `input.max_ralph_rounds ?? DEFAULT_MAX_RALPH_ROUNDS` | FIXED — validated above |
| `store.ts` `input.max_rounds ?? 10` | Same SHAPE, opposite failure DIRECTION, left alone. An unchecked `max_rounds` is compared as `round < maxRounds`, so `NaN` makes it FALSE and the fix loop ends early — it under-authorises. The ralph comparison is `+1 > cap`, where `NaN` false means unbounded. Worth its own change, not this one; noted here so the asymmetry is on the record rather than rediscovered. |
| `store.ts` `checkpointRound(...) ?? 0`, `crash_recoveries ?? 0`, `infra_retries ?? 0` | Not this class. Nullish-only coalescing on genuinely nullable columns, where `0` IS the correct absent value and no permissive default is involved. |

**WHAT IS STILL NOT TRUE, and `#629` holds it.** `max_ralph_rounds` is not a bound on
the CARD, and the escape is far cheaper than two drafts of this record claimed. Both
described it as needing the SLUG lost — "no card at all"
(`onboarding/overnight/register.ts`) or "a re-cut card (new title, new slug)". The real
one is ONE CLICK: `work-board/store.ts` NULLs `linked_run_id` when a card leaves the
`failed` lane (`nextStatus('failed')` to `'upcoming'`, the ordinary status-dot advance)
and again on `done` to `upcoming`. Measured: link cleared, `card_names_no_run`, a full
fresh budget — same card, same slug, same title, same branch, nothing re-cut. A limit
described as requiring a rename when it actually requires a click is the kind of wrong
that gets the guard removed later as redundant, which is why the correction is recorded
rather than quietly applied.

A fourth door, and it is not the "gap in the chain" `#629` already names: AN INTERVENING
NON-GOVERNED RUN LAUNDERS THE WHOLE SPEND. Measured: a card at 20/20, one dispatch with
ralph off (row born at 0, non-governed), that row dies, `latestTerminalBySlug` returns
IT, and the next governed dispatch is 0/20. That row is present, terminal and perfectly
readable — it is simply not governed, so `carriedRalphBudget` answers null on
`run.ralph !== true`. A present row is not a gap. The spend is also read from ONE prior
row rather than accumulated, so a real gap loses everything before it. The row is recreated by every dispatch, so a per-row counter is one reset away
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

**AN EDGE VALUE IS NOT AN UNSET VALUE — the FOURTH defect of that shape, in the field
beside the third.** The cap got a three-way classification; the COUNTER next to it still
normalised anything it did not understand to `0`, which is the most permissive answer
available, because a row at `{ 0, 20 }` is authorised for the whole budget. Measured: a
governed prior at `{ ralph_round: NaN, max_ralph_rounds: 20 }` produced `{ 0, 20 }` — the
budget reset, restored for malformed persisted data, through a different door, and
contradicting the helper's own stated FAIL-CLOSED contract.

The counter now takes the same split, with one asymmetry that matters: for a CAP,
"carry nothing" leaves the dispatch's own cap in place and costs nothing; for a COUNTER
there is no such fallback, because carrying nothing IS the reset. So an unreadable
counter — or an unreadable prior cap, since the pair is indivisible — REFUSES the
dispatch, with a `dispatch_budget_unreadable` warning and a message naming the run and
the column so the repair is a one-line UPDATE. `unknown` authorises nothing.

Measured rather than assumed: `code_trident_runs` is STRICT with both columns
`INTEGER NOT NULL`, so sqlite itself rejects `NaN` (binds as NULL, hits NOT NULL), the
infinities and fractionals ("cannot store REAL value in INTEGER"). The PERSISTED surface
is therefore negatives and unsafe magnitudes; those are covered through the real
database, and the three sqlite cannot store are covered through the real dispatch
chokepoint with the row supplied by an overridden `latestTerminalBySlug`. Layered, not
duplicated, and not pretending the schema is weaker than it is.

**FOUR ROUNDS ON ONE SENTENCE, AND THE LAST PROXY WAS IN THE ARM THAT WAS NEVER IN
DISPUTE.** Arm collapse, cap-versus-counter, the inheritance claim — and then arm 1,
which nobody had argued about, turned out to rest on the same kind of proxy as the claim
that started the argument. `ralphCapFailureReason` read a non-null `inner_checkpoint` as
proof THIS run built something, while the dispatch chokepoint COPIES the prior run's
checkpoint onto the new row: a re-dispatch of a linked prior at its cap arrives carrying
`fix-round-3` having run no Ralph iteration at all, and was told it failed to converge.
The attention goes where the argument is; the defect waits where it isn't.

The earlier analysis in this very record had already reached the answer for a different
arm — real provenance needs a column, and until it exists the reason must not assert
per-run authorship — and then let arm 1 assert exactly that. So arm 1 now says what is
knowable (the budget is exhausted, and a resumable build IS on this row) and claims
nothing about who produced it. Whether that distinction is worth having is a real
question — "this run burned 20 rounds" and "this run inherited a spent budget and a
checkpoint" are different operator situations — but answering it needs a provenance
column, which is a schema change and belongs with `#629`, not here.

AND THE TESTS SHARED THE DISCRIMINATOR'S BLIND SPOT, which is why three rounds of
narrowing never reached it: the inherited-spend case WITHHELD the checkpoint and the
built-something control INJECTED one, so neither could tell an inherited checkpoint from
an authored one. A fixture that constructs the state cannot see a defect in how the state
is PRODUCED — the same lesson as the E1 survivor one round earlier. The replacement runs
the real chokepoint: dispatch a linked prior at cap, let review return remaining work, and
read the reason the orchestrator's own cap path emits.

**THE QUESTION AFTER ANY CORRECTION IS NOT "IS THIS SITE RIGHT NOW" BUT "WHO ELSE SAYS
THIS".** Five times on this change a rule was applied to the site in front of the author
and not to its siblings: the cap got a careful three-way classification while the counter
beside it silently normalised; `!= null` was fixed at the `isRalphCap` validation while
the pair guard one layer down still read `=== undefined`; `ralph-budget.ts`'s header went
on asserting the card-level bound this very record had disproved; a comment credited
`delivery.ts` with a dependency it does not have; and the three-arm reason landed in
`enterRalphPlan` while `refireNextRalphTask` — the OTHER production enforcement path, and
the one a resumed run reaches — kept emitting "without converging" unconditionally.

Every one was found by someone else, and each is cheap to find first: after changing a
rule, grep for every other producer of it WITH A POSITIVE CONTROL, so the count means
something. Here that grep returned exactly two producers of the cap sentence, and the
control was that both known sites appeared in the output — a grep that finds one of two
looks identical to a grep that finds one of one. The sentence is now written once, by
`ralphCapFailureReason` in `ralph-budget.ts`, and fixing the string twice was refused for
the reason that module's own header gives for existing: two copies of a rule drift, and
the drift is invisible because both compile.

THE EXTRACTION'S OWN FAILURE MODE WAS ALSO CAUGHT BY A MUTATION, not by reading. The
first orchestrator test asserted whichever arm the row happened to take, so pointing that
call site back at the old hard-coded string left the suite green — the helper existed and
one call site did not use it, which is what every extraction risks. Measured while fixing
it: a run only reaches `refireNextRalphTask` after the workflow wrote a terminal result,
and the workflow writes a checkpoint first, so in the ORDINARY flow that row has a
checkpoint and arm 1 is genuinely accurate there. The discriminating case is real but
narrower — `checkpoint.sh` is an out-of-process writer, so a terminal result can land with
no checkpoint behind it — and the test now drives both arms at that call site.

**THE PATTERN, AND THE LINE THAT MATTERS MOST IN THIS RECORD.** Four boundary defects
landed in this lane and all four were one mistake: the at-cap round reset to a fresh row,
the cap not carried at all, an explicit `0` cap read as `20`, and an unreadable counter
normalised to `0`. Every one treated an EDGE value as an UNSET value and reached for the
permissive default. The audit that caught the third was aimed only at the cap, which is
why the fourth — one field over — survived it.

And the most expensive defect is not in that list. THE PROPERTY THIS CHANGE ADVERTISES AS
ITS CENTRAL FIX WAS ASSERTED IN PROSE, PINNED BY POSITION, AND LEFT UNPINNED IN
SUBSTANCE. The claim was "the line now states what was WRITTEN, not what was intended"; a
mutation proving the line's POSITION was red, while mutations changing the SOURCE of its
values survived the entire suite. No amount of reading found that — a mutation did. A
test that reacts to its subject while the claim is about something else reads as coverage
and is worth less than no test.

The same holds for the five tests in this session that documented a defect AS CORRECT
BEHAVIOUR — including one asserting that a malformed counter becomes zero, which is
precisely the budget reset this change exists to close. A test pinning wrong behaviour is
strictly more expensive than no test: it converts the next correct fix into an apparent
regression, and whoever hits it will most likely change the fix rather than the test. The
disposition here was to INVERT each one, with a docblock recording what it used to assert
and why that was wrong, rather than delete it quietly.

**AND THE FIX FOR THE LYING REASON WAS ITSELF A LIE, keyed on a PROXY — the dominant
defect of this build phase, appearing in a message string instead of a test.** The
replacement wording discriminated on `inner_checkpoint === null`, which is exactly right
for "this run has no build of its own", and then used it to assert something else
entirely: that the budget had been INHERITED from an earlier run. Measured by the final
gate: a brand-new Ralph run created with `max_ralph_rounds: 0` and transitioned from
`forge-init` has a null checkpoint and round 0, and was reported as having inherited a
spent budget from a predecessor THAT DOES NOT EXIST. The proxy correlated with the claim
in the cases in mind and diverged in the one that was not. And a terminal reason is what
the owner reads when a card dies, so naming a cause that did not occur is worse than
vagueness: it sends the reader hunting a run that never existed.

PROVENANCE WAS THE BETTER OPTION AND WAS REJECTED FOR A MEASURED REASON, recorded because
the reasoning is the reusable part. Every signal available at that point is another proxy.
`ralph_round > 0` looks decisive — `create` writes 0 for every row that inherits nothing —
but `enterRalphPlan` ADVANCES the counter without writing a checkpoint, so a run that
legitimately spent its rounds through the phase graph arrives at the cap with
`ralph_round > 0` and a null checkpoint and would be mislabelled identically. Real
provenance therefore means a new column and a migration, and it buys a better SENTENCE
rather than a better DECISION. So the claim was narrowed instead: the reason now states
only what the row shows, NAMES the two possibilities (an earlier run used the budget up,
or the cap was set that low at dispatch) and says the row cannot tell them apart. Strictly
more useful than vague, strictly more honest than picking one.

The test that had pinned the lying wording is corrected too, and it is the sixth of its
kind in this lane: it required the phrase "inherited a spent budget", which made a false
message look verified. A test asserting a claim is only ever as good as the claim.

**AND THE FIX FOR THE FIX OVER-GENERALISED — the mirror of the same error.** Having
correctly removed a claim that was NOT determinable (inheritance), the replacement
retreated to the most general wording available and thereby asserted something FALSE
about the cases that were never ambiguous: a brand-new run configured
`max_ralph_rounds: 0` was told "the budget was spent before this run began" when nothing
had ever been allocated, let alone spent. And the test that replaced the first lying
message excluded only the WORD "inherited", so it blessed the new contradiction — the
seventh test in this lane to document a defect as correct behaviour.

Keying on a PROXY asserts more than the row establishes. Retreating to the MOST GENERAL
wording asserts something false about the unambiguous cases. They are the same error
approached from opposite sides: the message not matching what the row can support. The
reason now has three arms, and which three was DERIVED rather than guessed. The refusal
fires iff `ralph_round >= max_ralph_rounds`; `max_ralph_rounds` is written only by
`create` (it is absent from `TridentRunUpdate`) and `create` refuses any cap that is not
a non-negative safe integer — so `ralph_round === 0` at that point IMPLIES `cap === 0`,
and the fourth combination one might expect, round 0 under a positive cap, cannot reach
the branch at all. That unreachability is itself pinned, so widening the refusal
condition or letting a negative cap be written reds rather than silently making a fourth
arm live.

  1. a checkpoint exists — this run built and then ran out: "without converging", the
     original wording, accurate for it and unchanged;
  2. no checkpoint and `ralph_round === 0` — therefore cap 0: nothing was ever
     allocated, so nothing was spent by anyone, stated plainly;
  3. no checkpoint and `ralph_round > 0` — the budget IS consumed, certainly, whoever
     consumed it; only WHO is left open, because this row may have advanced the counter
     itself through the phase graph or carried the count in.

THE DISCRIMINATOR FOR ARM 2 IS THE COUNTER, NOT THE CAP, and a mutation is what
established the difference. Keying it on `max_ralph_rounds === 0` reads identically on
every row except one that is reachable — a prior at 5/30 re-dispatched with an explicit
cap of 0 produces 5/0, where the cap-keyed version says "nothing has been spent" to a row
whose counter says five. That mutation survived the suite until the case was written.

**AND TWO SPELLINGS OF ABSENT DISAGREED ONE LAYER LOWER.** `create` resolves the cap with
`??` (null and undefined alike) while the carried-round pair guard checked only
`=== undefined`, so `{ ralph_round: 5, max_ralph_rounds: null }` passed the guard AND
defaulted to 20 — the unbounded half-pair `TridentUnboundedCarriedRoundError` exists to
refuse. The same asymmetry fixed a round earlier at the `isRalphCap` validation, in the
one remaining place where a `??` normalisation was paired with an `=== undefined`
validation instead of a comparison on the normalised value. Audited: every other `??` in
`create` compares the RESULT, so none of them can disagree about null. The coverage gap
was the shape of the tests, not their absence — null-cap-defaults and omitted-cap-rejects
were both covered, SEPARATELY, and the combination fell between them.

**A BULK EDIT THAT PARTIALLY APPLIES AND EXITS QUIETLY IS INDISTINGUISHABLE FROM ONE THAT
WORKED, and that produced a FALSE REPORT in this very record.** Three multi-edit scripts
used to write these paragraphs each asserted their anchors, hit one stale anchor partway
down, raised, and — because the write happened after the last edit — wrote NOTHING. The
report said the escape description had been corrected while this file still described it
as requiring a re-cut card. Nothing about the outcome looked wrong: the prose that WAS
here read exactly as intended, so no reviewer reading it would have caught the omission,
and the only signal was a traceback in a tool transcript nobody re-reads. That is a tool
producing a false claim, not an author being careless, which makes it the more dangerous
shape of the two.

The rule that follows, and the one the next lane should start with rather than arrive at
on the fourth attempt: EVERY EDIT VERIFIES ITSELF. One anchor per script, or a write after
each replacement, and a `grep -c` afterwards that FAILS LOUDLY when the count is wrong —
never a batch whose success is inferred from the absence of an error message. The same
discipline the tests in this lane are held to: silence is not success, and a claim about
state has to be read back from the state.

**MUTATION-CHECKED — thirty-seven mutations across the lane, every one red and restored,**
and deliberately in BOTH directions: failing-open (carry the permissive value) and
failing-closed (refuse a legitimate one), because a suite that only ever mutates toward
permissiveness passes when the code becomes too strict — and a suite that only covers
positive values cannot tell round-vs-cap from round-vs-default, which is how the second
and third defects hid. Two of the reviewer's log-line mutations are provably INERT rather
than uncaught: the row is written from the same objects the line would otherwise read, so
`budget?.ralph_round ?? 0` and the row's value cannot differ and no test can separate
them. That is reported as an inert mutation rather than papered over with a pin, the same
disposition taken for two inert mutations of my own earlier in the lane.

**A LOAD-BEARING COMMENT ASSERTED THE OPPOSITE OF WHAT THIS CHANGE ESTABLISHED.**
`ralph-budget.ts`'s header said the Ralph bound "is a property of the CARD rather than of
whichever attempt happens to be running" and that `max_ralph_rounds` is "unenforceable by
anyone willing to press ▶ again" without the carry. Both halves are false in the ways this
very record spent two rounds documenting — one status-dot click clears `linked_run_id`,
and an intervening non-governed run launders the spend — and it sat in the FILE THAT
IMPLEMENTS THE RULE, which is where a future reader is most likely to trust it. It was
written before the escapes were understood, and nothing re-reads a comment you did not
touch. It now states only what the code delivers: when a governed re-dispatch NAMES the
governed prior run it is resuming, the spend and the cap travel together and the cap can
only tighten. Both escapes are named there, with `#629` as the fix.

**THE SWEEP THAT FOUND IT ALSO FOUND AN ASSERTED CONSUMER THAT DOES NOT EXIST.** Reading
every claim in `ralph-budget.ts`, `state-machine.ts` and the spec item and naming the code
behind each one turned up a comment crediting `delivery.ts` with keying on the
`max_ralph_rounds` token; `delivery.ts` does not mention it anywhere. The real dependants
are three test files, and no production reader parses the string at all — `phase:
'failed'` is what production routes on, identically on all three arms. Words that assert
completeness or provenance — "is a property of", "cannot", "always", "spent", "inherited"
— each need a line behind them or they get narrowed, and two of them here did not.
