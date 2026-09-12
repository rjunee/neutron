## 2026-09-12 — A terminal cause on every terminal path, and two readers that report it

`trident/inner-workflow.mjs` has twelve terminal exits. Four of them said why they
ended. The other eight said nothing at all, so everything downstream had to deduce a
cause — and deduction is how `orchestrator.ts` came to tell four different failures the
same sentence on one night in August (`03242fe5`, `000cedc8`, `1daded20`, `36b95167`:
three stopped at round 1 with `checkpoint: 'inner-error'` and all four reported
"exhausted 10 round(s)"). This closes #520 by giving every one of the twelve an explicit,
typed cause, and by making the orchestrator and the delivery read it instead of guessing.

### The signal that was missing, and why the obvious one was not it

`checkpoint` records the PHASE the run reached, not why the loop stopped.
`argus-request-changes` is written for genuine budget exhaustion, for a fix round whose
work never landed, for a fix round that left no diff, AND for an `infra-only` synthesis
stop. Two Codex review rounds on PR #240 killed two attempts to deduce a cause from
`(round, checkpoint)` for exactly that reason, and the second is the instructive one: it
added "…and the checkpoint is not `inner-error`" and was still wrong, because the four
exits above are indistinguishable at that pair.

So the fix is not a cleverer deduction. It is a second field.

`terminalCauseKind` is a CLOSED vocabulary of fifteen members owned by
`trident/terminal-cause.ts`. It answers "which of the known exits was this". The existing
`terminalCause` — the probe's, lane's or thrown error's own words, redacted and capped —
stays exactly as it was and answers "what did the thing that stopped us actually say".
They are not two spellings of one fact: one is routable and says nothing the vocabulary
does not already define; the other is quotable and must never be routed on. A kind with
no prose is still an answer, and prose with no kind is still worth quoting.

### The review loop's kind is MEASURED, and here is what makes that word honest

`reviewLoopTerminalCause` (inner-workflow.mjs) is called at the exit and reads the guard
variables the loop exited on — `finalVerdict`, `round >= maxRounds`,
`synthesis.blockKind`, `roundLostItsWork`, `roundLostItsDiff`. Those are not a
reconstruction of the exit; they ARE the `while (...)` condition at the top of the fix
loop and the two `break`s inside it, read at the moment it stopped. The arms are ordered
to mirror the terminal result's own `blockKind` expression, so a lost round outranks the
budget — at the ceiling as well as below it, which is where the two can be confused.

`'round-budget-exhausted'` is the only member licensed to say the rounds ran out, and it
is emitted only where `round >= maxRounds` actually held.

### `'unknown'` is a member, and `null` is not the same thing

A vocabulary that cannot say "I could not establish which of these it was" forces a
determinate answer, and then "nothing happened" and "I could not find out" arrive at the
reader as one value. So `'unknown'` is a member; `reviewLoopTerminalCause`'s last arm
returns it rather than the nearest plausible member; and every composer downstream answers
it by saying LESS, never more.

`null` is a different fact and decodes separately. It means the field did not arrive — a
legacy row, a truncated result, a value from a future writer — and every reader answers it
by keeping the behaviour it had before this change, byte for byte. `parseTerminalCause`
therefore refuses to map garbage to `'unknown'`: that would manufacture an assertion
nobody made, and a reader could then no longer tell a run that answered from a run that
was never asked.

### The twelve paths, enumerated rather than sampled

"Every terminal path emits a cause" is an absence claim about the paths that do not, and
the honest way to make one is to enumerate. `inner-workflow.mjs` is a detached script with
a top-level `return` and no exports, so its exits cannot be reached one at a time from a
test process. What CAN be enumerated is every `writeTerminalResult(...)` call site, which
is the definition of a terminal path in that file.

| # | Exit | Kind | Emitted before? |
|---|---|---|---|
| 1 | resume: head of the recorded branch unreadable | `resume-head-unreadable` | yes (prose only) |
| 2 | resume: prior run recorded `pr-merged` | `pr-already-merged` | no |
| 3 | resume: prior `argus-approved`, head unmoved | `resume-approved-unchanged` | no |
| 4 | build completion: head unreadable or disputed | `built-head-unverified` | yes (prose only) |
| 5 | wave member finished its pinned build | `wave-member-built` | no |
| 6 | round-1 publish handoff (`forge-done`) | `handoff-publish` | no |
| 7 | PR already merged when the build returned | `pr-already-merged` | no |
| 8 | Ralph re-fire after one task | `ralph-task-built` | no |
| 9 | fix-round publish handoff | `handoff-publish` | no |
| 10 | PR merged during a fix round | `pr-already-merged` | no |
| 11 | the review loop's own exit | measured (six members) | only `infra-only` |
| 12 | the workflow threw | `workflow-threw` | yes (prose only) |

Exits 2, 7 and 10 share one composer (`mergedTerminalResult`), and share one kind because
they are one event: which of the three noticed the merge is a fact about this process's
timing, not about why the run stopped.

The narrowing note on the spec item undercounted this. It named the three review-verdict
block kinds; the real gap was eight paths, not three.

### Two mechanisms so a thirteenth cannot be added silently

The spec item's own HOW IT GOT THIS WAY paragraph is the reason a prose rule would not
do: the catch-all sentence was TRUE when it was written, and every early exit added since
landed in it without anyone adding a terminal branch — one plausible commit at a time.

1. **A source-level refusal.** `inner-workflow-terminal-cause.test.ts` scans the shipped
   `.mjs` for every `await writeTerminalResult(<ident>)`, resolves the identifier to its
   object literal (following the one composer indirection), and fails naming any site that
   hands over a result with no `terminalCauseKind`.
2. **A runtime answer.** `stampTerminalCause` stamps `'unknown'` on a bare result and
   writes the gap to the run log. It does NOT throw: throwing would trade a missing
   sentence for a lost terminal write, and the run would then sit `running` until the
   stall guard — strictly worse than an honest non-answer. Recording the gap out loud
   rather than papering over it is the convention `gateway-shutdown-kill.ts:774` set on
   #642 and this follows it rather than reinventing one.

Every scan in that file carries a POSITIVE CONTROL: the identical scan is re-run over a
doctored copy of the same source with the defect reintroduced, and must find it. A
scanner that silently stopped matching would otherwise read as a clean bill of health,
which is how eight paths went years without a cause.

### What the orchestrator does with it

`innerTerminalFailureReason` gained ONE branch, placed BELOW every existing branch and
above only the generic catch-all. That placement is the whole design: every sentence main
already composes is untouched and still wins, because each of those branches is already
holding a measured prose cause and a second owner for one fact is how reasons drift. What
reaches the new branch is precisely what the R1/R2 notes describe — the exits that emitted
nothing, which the catch-all spoke for all at once.

`terminalCauseReason` is total over the vocabulary and returns `null` for eleven of the
fifteen members. Four now speak:

| Kind | Reason |
|---|---|
| `round-budget-exhausted` | the fix loop used its whole round budget at round N of M and never reached an approved review |
| `review-advisory-only` | the review panel ran at round N of M and raised nothing actionable, so the loop stopped with no approval to land |
| `round-lost-work` | a fix round's work never reached the branch at round N of M, so the code was not re-judged |
| `round-lost-no-diff` | a fix round left the reviewed code unchanged at round N of M, so there was nothing new to re-judge |

The other eleven say nothing on purpose. The infra-only, resume-stop, built-head and
thrown exits already have a specific sentence UPSTREAM, composed from the prose they
carry. The six success and handoff exits are not failures: a FAILED row carrying one of
them failed downstream of that exit, at the merge or the publish, of something this
function did not measure — and naming the exit as the failure would be the inference the
module exists to refuse. `'unknown'` buys silence by definition.

**Word choice is load-bearing, and it is tested as a property.** A row can carry one of
these sentences and still be unreadable structurally (unharvested, force-terminated,
result did not parse). Such a row reaches `interpretFailure`'s keyword branches with the
sentence and nothing else, and those branches are bare `includes()` over tokens like
`exhausted`, `stalled`, `git ` and `conflict`. So the test asserts that every sentence,
with no structured cause available, degrades to the honest verbatim fallback — in each of
the three dispositions where the prose is what decides, `not-terminal` included, because
that is the shape a crashed build leaves behind and the one where the `exhausted` token is
live. A single terminal-row fixture missed that: mutation M14 (the budget sentence gaining
the word "exhausted") survived until the test was widened. The fallback also enforces a
200-character clamp, so one assertion covers length and vocabulary at once. This is the
same rule `deploy-kill-reason.ts` states for its own markers.

### What the delivery does with it

`trident/delivery.ts` had ZERO reads of the terminal cause — the spec item names the
search that proves it. So one sentence, "The build ended without an approved review, so I
did not merge it.", served a fix round whose work vanished, a fix round that changed
nothing, a panel that raised only advisory findings, and a genuine exhaustion. Four
different next actions behind one line of copy: the orchestrator's defect, one layer out.

The cause is read STRUCTURALLY, through a new `deriveTerminalCause` in `infra-block.ts`
that shares `deriveInfraBlock`'s three-condition gate via an extracted
`harvestedTerminalResult`. Two copies of a staleness gate are two chances to widen one of
them, and the hazard is real: a force-terminated row keeps a parseable `inner_result` from
an earlier iteration, and `harvested_at` is the only proof the outer loop decided on THIS
one.

The branch sits below the infra-block, launch-guard, undetermined-launcher-death and
deploy-restart branches and above every string branch. Below, because each of those
describes something that happened OUTSIDE the inner workflow, which the workflow's own
cause cannot know about and must not overrule — a build whose launcher a deploy killed
mid-flight never wrote a terminal result for that ending at all. Above the string
branches, because a measured kind beats a keyword match over prose.

One new `FailureClass`, `'round-lost'`. It sits exactly between the two classes it would
otherwise be forced into and is neither: nothing about the machine broke (`infra`), and no
reviewer rejected anything (`review-unresolved`) — the round simply produced nothing to
review. The two members keep distinct ADVICE, because the recoveries differ: one needs the
round rebuilt, the other needs a diff regenerated against work already safely on the
branch.

**Two arms turn on `disposition`, and they turn opposite ways.** The rule is that a
measured cause outranks prose when it CONTRADICTS it, and stands aside when it does not:

- `'review-advisory-only'` contradicts. `recordedTerminalVerdict` records an advisory-only
  exit as a real `REQUEST_CHANGES` (a panel ran and spoke), so the row reaches the review
  branch and is told the reviewer "still had blocking findings" — the one thing an
  advisory-only exit establishes did NOT happen. The cause wins. The test asserts the row
  really does take the review branch without the cause, so this is a contradiction and not
  a preference.
- `'round-budget-exhausted'` does not contradict. The budget running out and the reviewer
  holding blocking findings are both true of a genuine ten-round exhaustion, and the review
  branch tells the richer story. The cause stands aside — the same deferral the two
  existing `disposition !== 'reviewed-rejected'` branches already make.

A cause branch that won unconditionally would have deleted the second story; mutation M5
is that branch, and it goes red.

**The two halves move together, asserted as equalities rather than maintained in
parallel.** The structured budget route must return what the `reached max_rounds` string
route returns — the whole object, advice included, because a summary that matches beside
advice that does not is still two stories and the advice is the half the owner acts on.
The infra-death copy was extracted to one composer, `infraDeathInterpretation()`, so the
two routes cannot be reworded apart. It is a FUNCTION rather than a shared constant:
`interpretFailure` returns by reference and every other arm hands back a fresh literal, so
a module-level object returned from two arms would be one field assignment away from
rewriting the copy every future call receives.

### Why this is a new field and not a widened `blockKind`

`blockKind` is already a closed set on the same result, and the answer is that it answers
a narrower question and only sometimes. Seven of the twelve paths are not review verdicts
and emit no `blockKind` at all. More importantly it is load-bearing exactly where it is
narrow: `'infra-only'` is the ONLY value licensed to say no seat judged the code, and both
`recordedTerminalVerdict` and `isInfraDeath` key on it. A second meaning in that field is
how a value that licenses a claim starts licensing it for rows that never earned it.

### Mutation table

Every guard was reverted and the specific test proven red. `T` = both new test files
(`trident/terminal-cause.test.ts`, `trident/inner-workflow-terminal-cause.test.ts`).

| # | Mutation | Result |
|---|---|---|
| M1 | `parseTerminalCause` maps garbage to `'unknown'` instead of `null` | 3 fail |
| M2 | `deriveTerminalCause` drops the `harvested_at` staleness gate | 2 fail |
| M3 | `innerTerminalFailureReason`'s measured-kind branch deleted | 5 fail |
| M4 | `interpretFailure`'s cause branch deleted | 6 fail |
| M5 | cause branch wins unconditionally (budget stops deferring) | 1 fail |
| M6 | advisory-only defers instead of contradicting | 1 fail |
| M7 | `round-lost-no-diff` reuses `round-lost-work`'s delivery copy | 2 fail |
| M8 | `reviewLoopTerminalCause` falls through to a determinate member, not `'unknown'` | 3 fail |
| M9 | `terminalCauseKind` dropped from the main terminal result | 3 fail |
| M10 | the round-lost arms moved BELOW the budget arm | 1 fail |
| M11 | `stampTerminalCause` stops stamping | 2 fail |
| M12 | `stampTerminalCause` stamps silently (no report) | 1 fail |
| M13 | `round-lost-no-diff`'s reason duplicates `round-lost-work`'s | 4 fail |
| M14 | the budget sentence gains the word "exhausted" | 1 fail |
| M15 | the round-lost sentence gains a bare `git ` | 2 fail |
| M16 | `parseInnerResult` decodes the kind raw, with no fail-closed parse | 1 fail |
| M17 | the delivery cause branch moved ABOVE the launcher-death markers | 2 fail |

Every row above was re-run against the FINAL source rather than trusted from the revision
it was first written against, and that re-run is what found the third of the three defects
this table caught — none of which reading the diff had.

**M11 survived.** The runtime backstop was inlined in `writeTerminalResult`, which cannot
be lifted out of the `.mjs` and run, so nothing could exercise it. Extracted to
`stampTerminalCause` so it could be.

**M14 survived.** The routing-token property was tested only on a terminal row, where the
`exhausted` branch is gated off by disposition — so the classifier was never going to look
at the sentence and the test could not have failed whatever the wording was. It now covers
every disposition in which the prose is what decides.

**M2 could not be applied at all**, and that was the finding. `deriveInfraBlock` had kept
its own copy of the `harvested_at` check beside its call to the newly extracted
`harvestedTerminalResult`, so the module carried exactly the two staleness gates its new
docblock claimed it did not have. Widening one would have left the other as the only thing
between a stale `inner_result` and a confident sentence about an ending that is not this
run's. The duplicate is gone; M2 now applies in one place and goes red.

The general lesson is the reason the table is re-run rather than transcribed: a mutation
that fails to APPLY is not a passing row, it is a report that the code no longer looks the
way the mutation assumed — and that is worth reading every time.

### Verified by running, not by reading

- `bun test trident/` — 4178 pass, 0 fail, 119 files (4122 before this change).
- `scripts/ci/typecheck-all.sh` — 51 tsconfigs, ALL PASS, with `node_modules` installed in
  the worktree.
- `scripts/ci/lint.sh` — every gate 0 found.
- `node --check trident/inner-workflow.mjs` — parses to the expected illegal-top-level-return,
  which is the file's documented shape and not a regression.
- The seventeen mutations above, each applied to the shipped source and reverted.

### What was checked against `main` and found to have moved

The spec item's `file:line` evidence was written earlier. Verified at `3633ff62`: the two
shipped emit sites are at `inner-workflow.mjs:7851` and `:7905`, not `:7470` and `:7524`.
The substance held — both still emit, both still gate as described — and the spec item now
records the drift rather than leaving the next reader to find it.
