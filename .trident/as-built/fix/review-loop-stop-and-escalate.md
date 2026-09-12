## 2026-09-12 — the review loop STOPS and escalates instead of iterating on a bad plan

Spec item: `docs/spec-items/the-review-loop-must-stop-and-re-plan.md` (P0, cutover).
Closes the trap that cost run `36b95167` ten rounds and ~2.5 h to reach a verdict that
was knowable at round 2.

### What was actually there, measured before anything was written

The fix loop is `trident/inner-workflow.mjs` (the `while` at what is now ~8062). It
iterated while `finalVerdict === 'REQUEST_CHANGES' && round < maxRounds` and the block
kind was neither `'infra-only'` nor `'advisory-only'`. So `round < maxRounds` was the
PRIMARY exit for a run that could not converge — a cap used as a policy. What the loop
could observe about WHY a round failed was `synthesis.findings`, free-text
`{severity, title, evidence}` objects (the old `VERDICT_SCHEMA`), and nothing else: no
identity, no per-round history, no comparison between rounds. And there was nowhere to
escalate TO — `blockKind` had five members, all of them about the panel or the branch,
none about the plan. The planner runs once, outside the loop, gated on
`ralph === true || memberMode`; a plain run has no planner at all.

### The shape of the fix

Three triggers, and the ordering between "self-declared" and "arithmetic" is the
load-bearing part.

**Stable identity first, because the rest is built on it.** `VERDICT_SCHEMA` findings now
REQUIRE a `key` — `file:symbol:rule`, machine-read. `findingIdentity` reads that field
and nothing else; a title-derived fingerprint is exactly what the item rules out, since a
model that rewords its own sentence between rounds defeats it while the gate reports
green. Normalisation drops case, whitespace and a leading `./` — SPELLING ONLY, never content —
and requires three segments so a bare title cannot masquerade as a key. A finding with no
usable key is `''` — UNDECIDABLE, and never a fresh identity.

NOTHING IS SUBTRACTED FROM THE KEY, and that is a correction to an earlier cut of this
branch. Identity used to drop every purely-numeric segment anywhere in the key, reasoning
that a numeric segment is a line number a fix round would move. A numeric segment is not a
line number — it is whatever the reviewer put there. `api.ts:handler:401:missing-auth` and
`api.ts:handler:403:missing-auth` are two DIFFERENT defects that both normalised to
`api.ts:handler:missing-auth`, so the gate read them as one finding surviving a fix round
and escalated a run that was CONVERGING. Status codes, error numbers, CWE ids, ports and
version segments were all taken the same way.

AND THE SAME MISTAKE WAS IN ANOTHER DIMENSION: the key was LOWER-CASED. On a
case-sensitive filesystem `src/Foo.ts:Handler:missing-auth` and
`src/foo.ts:handler:missing-auth` can name genuinely different files and genuinely
different symbols, and collapsing them produced the same false repeat on a converging run.
Collapsing internal whitespace runs went with it — a filename may legitimately contain two
consecutive spaces. Case is now content, so the schema says the key is compared exactly
INCLUDING case and must stay byte-identical between rounds: the grammar move again, making
the stable thing explicit rather than subtracting the volatile thing afterwards.

THE GENERAL RULE, since this file got it wrong twice in the same function: EVERY
NORMALISATION IS A CLAIM THAT THE DISCARDED DIFFERENCE COULD NOT HAVE BEEN MEANINGFUL, and
for an identity derived from free text that claim is almost never safe. What survives is
only what is a fact about the NOTATION rather than about the content it denotes — a leading
`./` (the same file by definition) and whitespace around a token (transport noise). An
outer `.trim()` beside the per-segment one was removed as dead work when mutation showed it
changed nothing, which is the same standard applied to the guard rather than to the bug.

THE ASYMMETRY IS WHY THIS ONE MATTERED MORE THAN ITS SIZE. Over-firing stops a run that
was converging and reports `not-converging` about it — the one way this gate can be WORSE
than the round cap it replaced, since the cap only ever stopped a run that could not
converge, and the two are indistinguishable to an operator reading the escalation.
Under-firing merely fails to prove a repeat: the run continues, the no-progress arithmetic
still watches it, and the cap is still behind that. So the line number is excluded by the
GRAMMAR rather than by subtraction — `VERDICT_SCHEMA` and all three prompts specify
`file:symbol:rule` and say the line belongs in `evidence` — and a key that carries one
anyway simply fails to match next round, which is the safe half. That moved the rule from
"I removed the parts I think are volatile" to "I used the parts that are stable": a
subtraction can collide, a construction cannot.

The instruction became load-bearing in the process, because nothing in the code removes a
line number any more, so it is pinned in all four places it is said (the schema and the
three prompts) — the legitimate kind of source assertion, since a schema is data handed to
the model and has no behaviour to execute.

THE STRONGER VERSION WAS CONSIDERED AND DEFERRED, deliberately rather than silently:
building identity from NAMED fields (`file`, `symbol`, `rule`, with `line` in its own slot)
would make it structurally impossible for a line number to reach identity, instead of
instructing against it. It is filed as #657 with the reasoning. It was not done here
because it changes the model-facing schema, all three prompts, the decoder and every
fixture across ~six suites, and what it buys is converting a failure that is ALREADY the
safe direction into no failure at all. It also does not fix the remaining over-fire case —
a model that gives two different defects the same key still collides, and no schema shape
prevents that; the `undecidable` third answer and the no-progress backstop are what cover
it. The one thing #657 must not do is "named fields when present, else parse the key":
that is two rules that must agree, which is the shape that produced this defect. Six mutations, each applied individually, all
RED: restoring the strip, a narrower positional strip, an identity that never matches, one
that stops normalising case, one that makes a moved line escalate, and one that drops the
instruction.

**A DECLARATION IS NOT LEDGER ARITHMETIC, and gating it on `blockKind` was a category
error.** A reviewer's `escalate` is a claim about the WORK'S VIABILITY — the plan is
wrong, or the dependency is not there yet. `blockKind` and severity are claims about the
CODE'S QUALITY. Routing the first through a gate built for the second made this loop
DEAFEST exactly when the reviewer was CLEAREST.

The canonical case it silently dropped is not exotic: "the code is fine, the dependency
isn't there yet" — one `minor` finding plus `escalate: {kind: 'missing-dependency'}`.
`enforceSeverityGate` turns an all-non-blocking `REQUEST_CHANGES` into `APPROVE` and
`classifyBlock` calls that list `advisory-only`, so the declaration never reached
`decideEscalation` and the run proceeded AS APPROVED — merging work a reviewer had just
said could not be built yet. The spec item is explicit that a run escalates when ANY
trigger fires, and the declaration is the FAST one: the only trigger that can fire at
round 1, before any arithmetic has two rounds to compare. Both declared kinds are now
covered paired with minor/nit-only findings.

A RUN THAT STOPPED DID NOT APPROVE, and that had to be said in code. The terminal result
reads `finalVerdict === 'APPROVE'` BEFORE it reads the escalation, so an
approved-and-escalated run reported `blockKind: 'none'` — the escalation would have
vanished AND the outer loop would have MERGED the branch, which is the worst available
outcome. The verdict is now forced to `REQUEST_CHANGES` when an escalation fired; for
every pre-existing path it is a no-op (they can only fire inside the fix loop, which runs
only while the verdict is `REQUEST_CHANGES`), so it closes the new door without touching
the old ones.

**THE SAME CATEGORY ERROR, ONE STEP LATER — and the enumeration that should have found
it.** Hearing the declaration was only half. With the claim reaching `decideEscalation`, a
`design-gap` beside minor/nit findings was AUTHORISED for a re-plan that could not run: the
severity gate had already turned the verdict into `APPROVE` and `classifyBlock` had called
the list `advisory-only`, so every clause of the fix loop's `while` was false. The run then
reported `re-plan-unreachable` WITH FIVE ROUNDS STILL IN THE BUDGET — a false diagnosis,
and the kind that sends the next reader after the cap instead of after the gate. The spec
item's criterion "a design-gap buys exactly ONE bounded re-plan" was ticked over a path
that could not execute for this case.

A pending re-plan is now its OWN reason to enter the loop. The blockKind clauses exist to
stop the loop re-Forging against findings already declared non-blocking; that reasoning
does not apply, because a re-plan round does not re-Forge against the findings at all — it
rebuilds against a REVISED PLAN.

THE ENUMERATION, since this was the second instance: every site where `finalVerdict` gates
something, classified as code-quality or work-viability. Seven gates. Six are correctly
about code quality (the two early-APPROVE paths, the round-lost forcings, `isInfraOnlyStop`,
the reported `checkpoint`, the terminal findings list) and one — the `blockKind` ternary
reading `APPROVE ? 'none'` before the escalation — is made correct by forcing the verdict
when a run stops. The fix loop's `while` was the only remaining miscategorised one, and it
is the one review found. A third would be found the same way, which is the argument for
doing the enumeration rather than waiting for the next report.

**AND THAT FORCING SURFACED A LATENT BUG RATHER THAN CAUSING ONE — worth recording because
of how it was found.** A cross-model test went red, and the honest first question was
whether the change had broken it. It had not: the ledger was also recording the round that
APPROVED. A round 1 that rejects with no blocker/major findings records a count of 0, the
approving round 2 recorded another 0, and `[0,0]` read as "the count stopped falling" —
the fix rounds reported as NOT CONVERGING on the very round they converged. It had been
invisible for exactly one reason: the terminal result discarded the escalation under the
`APPROVE` branch. Forcing the verdict made a silently-discarded decision readable, and the
bogus stop fell out immediately. The ledger measures whether REJECTIONS are getting
smaller; an approval is the successful terminus and has no place in that series. A
decision that is computed and then thrown away is worth removing even while it is
harmless, because it is one edit away from being read.

**The hard gate is arithmetic.** `repeatVerdict` is a set intersection over two rounds'
identities and needs no agent to be honest. It is three-valued and that is deliberate:
`'none'` requires both lists readable AND every finding keyed; anything less is
`'undecidable'`, which never shares a branch with a definite answer. `blockingFindingCount`
returns `null` (not `0`) for an unreadable list, and `progressVerdict` — the identity-free
backstop, fires when the blocker+major count stops strictly decreasing — reads that `null`
as undecidable rather than as the best possible count.

**The self-declaration can never be the only trigger.** The schema gains an optional
`escalate: {kind, whatIsMissing}` with `kind ∈ {design-gap, missing-dependency}`;
`whatIsMissing` is REQUIRED and an escalation without it is REFUSED (the refusal is logged
and never quotes the model's own text back). The claim is read off `synthesisRaw` — the
seat's own reply, before this file merges its CI advisories, suite blockers and lane
findings in — because a declaration that the plan is wrong is a reviewer's judgement or it
is nothing. The arithmetic runs whether or not a claim is present, and `triggers` lists
EVERY gate that fired, so a stop is never recorded as having happened only because an
agent said so.

**Routing.** A valid `design-gap` buys ONE bounded re-plan per run — a `plan:fable` seat
invoked INSIDE the loop with the findings attached, which is the whole correction to
constraint (iii). It is counted when AUTHORISED, not when performed, so a second
`design-gap` cannot be granted one while the first is pending; once spent, every trigger
routes to a stop. A re-plan that returned null, or a plan with no execution spec, is NOT a
successful re-plan: it escalates, because carrying on would send Forge in with the
original plan while the run's one re-plan is recorded as spent. Everything else stops and
reports to the orchestrator.

The `while` gains one clause, `escalation === null`, which is what turns `round < maxRounds`
back into a backstop.

### BLOCKED is not FAILED

`blockKind` gains `design-gap`, `missing-dependency` and `not-converging`. The third is
what the ARITHMETIC reports and it deliberately names no cause — the numbers show that
fixing is not working and say nothing about why, so they may not borrow a name that
asserts one. `parseInnerResult` decodes all three fail-closed and decodes the escalation
payload ALL-OR-NOTHING (a blank `whatIsMissing` decodes to `null`, so the decoder cannot
restore downstream the bare complaint the gate removed upstream).

`trident/escalation-block.ts` is the ONE deriver, built as the sibling of `infra-block.ts`
and with the same three-condition gate (`phase === 'failed'`, `harvested_at !== null` for
the stale-result hazard, and a decoded escalation whose kind MATCHES the decoded
`block_kind`). TWO READERS go through it and neither re-implements it: the chat line
(`🛑 … build BLOCKED, not failed`, under its own glyph — every other class keeps its ❌
byte-identical) and the card's lane.

THE THIRD SURFACE — the stored `failure_reason` — SHARES ONE CONDITION AND NOT THE OTHER
TWO, and the distinction is a boundary rather than a gap. `orchestrator.ts` composes that
sentence while BUILDING the terminal row, upstream of both `phase === 'failed'` and
`harvested_at`, which it is itself about to make true; calling the full deriver there would
return `null` on every real escalation and the sentence would never fire. What it genuinely
shares is condition 3, now exported as `escalationKindAgrees` and called by both, so the
kind/payload rule has exactly ONE spelling rather than two that must be remembered
together. A test pins that a half-written escalation is refused identically on both sides,
with a control proving both still accept a whole one; mutating either caller off the shared
function turns it red.

An earlier draft of this record claimed three surfaces read the deriver and named
`run-progress.ts` as one of them. It does not, and it SHOULD NOT: it reports what the RUN
did, and the run genuinely ended in the `failed` phase, while blockedness is a fact about
the CARD. Teaching the run payload to also say "blocked" would put a second source of truth
for one distinction on one surface — the drift this module exists to prevent — so every
board renderer asks the LANE first and lets the run refine it instead.

Migration `0140` adds a sixth `work_board_items.status`: `blocked`. It is RUN-DRIVEN and
NOT client-writable (the agent tool and the HTTP surface keep their four values) and it is
ACTIVE — the card keeps its `sort_order`, stays in `listActive`, and never stamps
`completed_at`. A `missing-dependency` escalation lands there rather than in `failed`
(wrong word) or `upcoming` (looks startable, and the next dispatch would re-learn the same
block). An escalation is also recorded as a REQUEST_CHANGES rather than REVIEW_NOT_RUN: a
run only reaches one from a round a full panel judged.

### BLOCKED means something at the dispatch boundary

A lane that changes nothing where builds are started is decoration: the escalation would
stop the fix loop inside the run and the next dispatch would pick the same card up and
relearn the same block — the loop closed inside the run, reopened one level out. So the
chokepoint (`trident/board-dispatch.ts`) REFUSES a blocked card with its own code,
`card_blocked`, checked immediately after the item is found and before every other gate
(the answer does not depend on the task text, a bound PR, or executor health). It is NOT
queued, unlike `held`: a hold parks a dispatch whose blocker a sweep can re-test, and
nothing can re-test a decision — a sweep that re-fired it would relearn the block on the
orchestrator's behalf. Both UIs drop the ▶/↻ control for a blocked card (`canPlay` gains
it as a fourth suppressor, and `isRetry` returns false for it even though the card keeps
its `linked_run_id` so the reported reason stays reachable): a control that can only
produce a refusal, labelled "retry", is worse than no control.

### THIS DID NOT CLOSE THE ITEM — the marker moves, not the item

The PR shipped the stop, the escalation and the BLOCKED card. It did not ship the
orchestrator's reorder, and the item's ROUTING requires it. So the acceptance box stays
UNCHECKED with a pointer to #545, the issue stays open, and the PR carries no `Closes`.

Worth recording as a PATTERN rather than as a fact about this branch: a PR that does most
of an item FEELS like the item, and the tracker is the only place that difference
survives. #536 exists because a system kept reporting progress it had not made — closing
it on a partial delivery would be the same error one layer up, in the issue tracker
instead of the review loop. And the next build reads this spec item to learn what it owes,
so an honestly-unmet box is part of the deliverable. Three PRs reached this question on
2026-09-12 (#642 for #518, this one, and #547) and the answer was the same each time.

### The reorder is reported, not automated — and the criterion says so

The item's ROUTING requires the orchestrator to report in the project chat and REORDER
the board. What ships is the REPORT and the lane. The reorder stays the orchestrator's own
`work_board_reorder`, made when it reads the message, and the criterion is left UNCHECKED
rather than ticked over an unbuilt path. An earlier cut of this branch edited the
REQUIREMENT until the implementation satisfied it and then ticked the box, which is the
same error again; `:41` and `:50` of the spec item are byte-identical to the base. The
reason the automation stops where it does: automating it would
require the RUN to identify which card is the dependency, and the only thing the run can
honestly produce is `whatIsMissing` — a sentence. Deriving a card id from model prose and
acting on it is exactly the board mutation the guardrail forbids. The delivery sentence
therefore names the sequencing call and what it takes (reorder the card if it exists; spec
it first if it does not; move this card back to `upcoming`, which is the decision), so
nothing is left to be discovered.

### The run reports; the orchestrator decides

The inner workflow has no board access at all — `grep -cE "work_board|WorkBoardStore|sort_order|reorder\(" trident/inner-workflow.mjs`
is 0, where the same grep shape over the same file for `checkpoint\(|forgeAgent\(|runReviewRound\(`
is 28 and the same vocabulary hits `work-board/store.ts` and `trident/board-dispatch.ts`.
The only board writer any build can reach is the terminal reconcile, and its
`TridentBoardReconciler` interface is `detachRun` and NOTHING ELSE — `reorder`, `update`,
`create` and `delete` are not on the object, so they are unreachable however the escalation
payload is written. Both decoders on the path are allowlists that rebuild their output
field by field, so extra keys in the payload (a card id, a position) never reach a caller.
That is asserted with a hostile payload that names another card and a position, and
mutation-checked: a reconcile that reads the raw JSON and obeys it turns both tests red.

### A STATUS IS NOT A VALUE — it is the set of paths that must agree about it

FIVE separate findings across four review rounds had one shape: a new state added to the
vocabulary and not to a path that reads it. Round 1 the decoder DROPPED the card; round 2
the row rendered it **Failed**; round 3 the summary COUNTED it failed and an agent could
mark it inline-active. Each fix reached the artefact the finding named and stopped there,
which is the failure this note exists to end.

WHAT THE ONE-AT-A-TIME ROUNDS HAD IN COMMON, and it is worth stating because it predicts
the next one: the reconcile deliberately KEEPS the terminal run link on a blocked card so
the reported reason stays reachable, and that run's `step_label` is `failed`. So EVERY
derivation that asked the RUN before the LANE inherited the same lie — the tag, the dot,
the notice, the summary, `isLinkedRunning`. The rule that fixes all of them at once: on a
card whose lane is durable and terminal-ish, **the lane is the fact and the run refines
it**, never the other way round.

THE SWEEP, done mechanically rather than by memory: every site in a Work-Board-consuming
file that compares a board status against a literal or enumerates the set — **95 sites
across 14 files**, every one examined. **13 non-test files were changed** (52 added
`blocked`-bearing lines); the rest were checked and correctly need no change, and the ones
where "no change" is a judgement rather than an obvious no-op are listed below with the
reason. By the coordinator's list:

- **decode** — the SQL CHECK, the store type, the wire envelope, and BOTH client
  `parseWorkBoardItems` allowlists (see below).
- **render** — `statusLabel` and `nextStatus` in both clients; `stepTag`, `dotState` and
  `runNotice`, where the card's own lane now wins over the bound run's step (below);
  `formatWorkBoardFragment`, which is the ORCHESTRATOR'S OWN VIEW and was calling a
  blocked card `·building`.
- **advance** — `store.update` now clears the stale terminal binding when a card leaves
  `blocked`, as it already did for `failed`.
- **dispatch** — the chokepoint refuses (`card_blocked`), the HTTP surface's code union
  carries it, and neither UI offers a control for it.
- **escalate** — the reconcile routes it; `detachRun` writes the lane and stamps nothing.

`agent-tool.ts` and the HTTP surface already REFUSED `blocked` (it is absent from both
client-writable allowlists), but only by omission — neither comment explaining why `failed`
is absent mentioned it, and the tool's status description said nothing, so an agent whose
build was refused with `card_blocked` had no way to learn what to do from the tool it was
holding. For `blocked` the omission IS the guardrail; the schema now says so, and says that
moving a card OUT of it is an ordinary `status:'upcoming'` update and that move is the
decision.

- **summary / roll-up** — `summarize` counted a blocked card as FAILED (the kept terminal
  run matched its `step_label` branch), so the pane's chip said "1 failed" beside a row
  labelled "Blocked". It now has its own count, checked BEFORE the failed branch; the
  pane stays open for it (a block demands attention more squarely than a failure, which
  can at least be retried) but does not COUNT as work kicking off, because announcing the
  absence of work is not what an auto-open is for.
- **live-run derivation** — `isLinkedRunning` read "no `run_progress` reported" as "still
  running", which is right for a live run that has not reported and wrong for one that
  ENDED. `failed` had said so since #340; `blocked` needs it more, because the kept link
  plus an aged-out run row is the shape that actually occurs. Without it a blocked card
  pulsed, counted as `running`, and had its ▶ suppressed for the wrong reason.
- **inline-activity** — the serious one, because it is WRITABLE BY AN AGENT: a blocked
  card exists to stop work, and `work_board_update` accepted `inline_active` independently
  of status. Refused at the STORE (both `update` and `setInlineActive`), not at the tool,
  because the flag has three independent writers and an invariant that holds only in the
  caller that remembered it is not an invariant. Moving INTO the lane clears the flag, the
  CLAIM is refused while in it, the CLEAR is always allowed (refusing it would strand a
  stale flag with no writer able to stop it), and the DERIVATION refuses to read one — so
  a flag stored before the block cannot outlive it.

Checked and deliberately UNCHANGED, with the reason: `project-rail.ts` (a blocked card
with a bound terminal run raises rail ATTENTION, which is correct — it needs the owner;
the internal variable is named for failure but the signal is "needs you"); `listActive`
and the client lane splits (`blocked` is ACTIVE — unfinished work that is waiting, so it
belongs in the active lane and keeps its `sort_order`); `dispatch-holds` (a `card_blocked`
refusal lands in the sweep's permanent arm and drops the hold, which is right: nothing can
re-test a decision); `work-wakeup-selection` (wakes `in_progress` only, so a blocked card
is never re-woken to re-read the same block); `board-dispatch`'s blocker-card scan (a
blocker that is itself blocked still holds its dependent).

### The renderers were deriving from the run, and the run says "failed"

`detachRun` KEEPS the run link on a blocked card so the reported reason stays reachable —
and that run's `step_label` is `failed`. Both clients derive the dot and the phase tag
from `run_progress` BEFORE consulting the card's status, so a blocked card was painted red
and tagged "Failed": last round the card vanished, this round it lied, both times because
a status was added to the type and not to the path that renders it. The card's own lane
now wins over the run step for `blocked` and only for `blocked` — every other state is
legitimately refined by a live run, and the lane is written by the terminal reconcile from
the run's own escalation, so it is neither a guess nor older than the step. A `blocked`
phase colour (orange, not red) was added to both palettes so the styling cannot say
"failed" while the word says "Blocked".

### A design gap declared with no round left to re-plan in

`decideEscalation` can authorise the bounded re-plan at the end of ANY round, including
the last one the cap allows — but the planner runs at the TOP of the next fix round, and
`round < maxRounds` means there is no next fix round (with `maxRounds: 1`, never one at
all). The pending flag was simply dropped and the run fell through as an ordinary
`blockKind: 'code'` rejection: a reviewer said the PLAN is wrong, proved it, and the run
reported a code rejection. That is the silent drop this card exists to remove, reproduced
by the card's own remedy. It now escalates rather than stretching the cap — the findings
say the plan is wrong and there is no budget left to act on it, which is exactly what the
orchestrator needs told.

### A REJECTED planner is the same outcome as a null one, and now says so

`agent()` REJECTS on a transport error, a schema refusal or an exhausted retry. The
bounded re-plan awaited it with no `try`, so an uncaught rejection left the fix loop
entirely, landed in the workflow's outer catch, and was persisted as
`checkpoint: 'inner-error'` with NO escalation on it: a reviewer would have PROVED the
plan was wrong and the run would have reported an infrastructure death. That is this
file's own subject — a terminal state that says the wrong thing about why.

`threw`, `returned null` and `returned a plan with no execution spec` are one outcome —
"the planner did not produce a plan" — and the collapse is now DELIBERATE rather than
accidental. It is written as ONE expression that both decides and names (`rePlanFailure`),
because a condition and a description computed apart can disagree; every arm is
load-bearing and mutating any one of them changes what the run reports. The E2E suite's
`test.each` carries all three rows, which is what its own commentary had been claiming
while the table covered two.

### The migration REBUILDS a table that holds the owner's real board

0140 widens a CHECK on a STRICT table, which SQLite cannot ALTER — so it does what
0053/0097/0130 did: CREATE, `INSERT … SELECT`, `DROP TABLE`, rename. That `DROP` is the
risk: the transfer is an explicit column list, and a column omitted from it is not a lint
error, it is DELETED DATA — unrecoverable, invisible until the owner notices a card is
wrong, and it runs once against live data. Writing this migration already dropped 0139's
`blockers` once; only the committed schema snapshot caught it, and a snapshot sees the
COLUMN SET, never the CONTENTS.

Nothing else could see it either: the runner tests assert ordinal 140 RAN, the fresh
snapshot asserts the resulting shape, and every store test runs where 0140 has already
applied — none of them ever holds a populated 0139-shaped row, so none of them can lose
one. `migrations/__tests__/0140-work-board-blocked-preserves-every-column.test.ts` seeds
one with NON-DEFAULT values in every column (a column left at its default looks correct
against a rebuild that dropped it and let the default refill it), applies 0140, and
compares the row as a WHOLE OBJECT — so a column added later and forgotten in a future
rebuild's SELECT fails there rather than shipping. It also pins both indexes by name, the
`foreign_keys` restoration, and that the widened CHECK still refuses a lane nobody
declared. Seven mutations, including three different dropped columns and a misordering:
all red.

WHETHER THE REBUILD IS NEEDED AT ALL — asked, and the answer is yes. SQLite has no
`ALTER TABLE … DROP CONSTRAINT`; the only rebuild-free route is `PRAGMA
writable_schema=ON` surgery on `sqlite_master`, which SQLite's own documentation calls
dangerous and which corrupts the database outright if the rewritten text is wrong. The
12-step rebuild is the documented safe procedure and is what this table's three previous
migrations already use; a fourth spelling of "change a CHECK" would be one more thing to
get right. Prevention was not available, so verification is what makes it safe.

### A latent CI landmine this branch stepped on, and the lane that closes it

Adding test files moved a chunk boundary and six `landing/__tests__/server.test.ts` tests
went red on CI — `/chat-react.js` 404ing. The measured cause is not this branch:
`createLandingServer` lazily `Bun.build`s a ~0.9 MB browser bundle in-process, and that
build throws `AggregateError: Bundle failed` whose messages are `EBADF reading file:
…/react/index.js` — a BAD FILE DESCRIPTOR, closed by some earlier file in the chunk and
reused under the bundler's reads. Reproduced on an UNMODIFIED main with the same file
list, so any PR that adds a test file can step on it. The fd owner is worth finding and is
not this card — FILED AS ISSUE #656 with the reproduction (`NEUTRON_TEST_NO_BUNDLE_LANE=1`)
and a suggested next step, so it is not rediscovered from scratch: bisect WITHIN a failing
chunk against one appended landing-server file, rather than reasoning about which file looks
like it leaks descriptors, which has not worked. Until then those files run in their own
process, as a third lane beside the PGLite and device lanes the runner already has for
exactly this class of problem.
Membership is content-derived from `createLandingServer`, so a new landing-server test
joins without anyone remembering to.

### The client decoders were the other half of "visibly blocked"

Widening a TypeScript union is a compile-time claim; a parser's allowlist is the runtime
one. Both client decoders (`parseWorkBoardItems`, web and app) still gated on
`upcoming | in_progress | done | failed`, so a `blocked` card would not have rendered as
blocked — it would have been DROPPED, which is strictly worse than the behaviour before
the lane existed. The same drift had already eaten `archived` (0130). Both files now
derive the type FROM a single `WORK_BOARD_STATUSES` array and read that array through one
type guard, so widening the set is one edit that necessarily moves both, and
`tests/integration/work-board-status-mirrors.test.ts` compares the two runtime lists
against the CHECK constraint in the committed schema snapshot — the one statement of the
set a database will actually enforce.

### A SOURCE-TEXT ASSERTION BREAKS WHEN THE BEHAVIOUR IS CORRECTLY IMPROVED

(Instances two, three and four arrived while finishing this branch, and one of them had
PREDICTED ITSELF. `inner-workflow.test.ts` pinned `while (\s*finalVerdict` — under a
comment explaining that its previous version had been broken by a legitimately-added
clause and had therefore been rewritten to assert "the two PROPERTIES rather than the
literal condition text". It still encoded an opinion about the condition's SHAPE, so
adding the re-plan disjunct broke it for the second time. Two more in
`review-round-cap.test.ts` and `synthesis-unavailable.test.ts` sliced the loop by its
opening text for the same reason. All three now anchor on `round++` — the loop's first
statement, which is what they actually mean — and assert their clauses INSIDE the matched
condition with no claim about order or neighbours. They were repaired rather than deleted
because each guards something the executed suites do not: a local helper's fidelity to the
loop, and the `round++` step itself.)

This one arrived on its own and is worth more than the code it cost. A wiring test
required the literal `if (!rePlan || typeof rePlan.executionSpec !== 'string' …)`.
Production then replaced that string comparison with a computed failure classification —
an unambiguous improvement, made to close a real gap — and the ONLY thing that noticed was
the test asserting the old string. CI went red on a correct change.

So the argument against source-text assertions is stronger than "they do not prove
behaviour": they actively BREAK when behaviour improves, and the version of that defect
which does NOT cost a round is the one where the string happens to survive a change that
broke the behaviour. Both directions are wrong; only one of them is loud.

The wiring suite was therefore DELETED rather than repaired — eight source-text and
call-count assertions across six tests, every one of them standing in for something the
executed suite now asserts directly (the gate consulted after each re-review, the findings
reaching the planner, exactly one re-plan per run, a planner that produced nothing
escalating, the terminal result carrying the escalation, the executor tag never lowered).
Keeping both would leave the weaker one to fail again the next time the stronger one is
satisfied by better code.

TWO SURVIVE, and the rule for what may: an assertion about SOURCE is legitimate only where
there is no behaviour to execute. The review SCHEMA is data handed to the model and is
never validated in-process, so its literal IS the deliverable. And the claim being read
off `synthesisRaw` rather than `gated` is not reachable by execution — `gated` SPREADS the
seat's reply, so both readings behave identically on every input a test can build without
also driving the CI seam — while remaining the guard that stops this file's own advisories
being laundered into a reviewer's judgement.

THE AUDIT, COUNTED. Across the seven suites this PR touches there are 324 source-text or
call-count assertions; this branch ADDED or CHANGED five of them, and five is the number
that was reviewable. Three are gone (the two in `review-round-cap` that duplicated what
the executed suite now shows, and the re-plan literal that started this); two remain and
are named above. The other 319 are pre-existing and belong to the cards that wrote them —
notably `inner-workflow.test.ts`'s reflection-placement checks, which that file itself
calls "belt-and-suspenders" beside a behavioural harness, on a trust-boundary property
where redundancy is a deliberate choice rather than an oversight. Changing them is not
this card's call; the one this card touched was kept true and no wider.

TWO WERE CONVERTED rather than deleted, and converting them found things. "The re-plan
may raise the executor tag but never lower it" is now asserted on the MODEL the fix round
was actually routed to — and writing it showed there is no useful control for the
`reasoning` case at all, because `modelForTag` maps both `null` and `'reasoning'` to the
same model, so adopting it has no observable consequence; the suite says that instead of
shipping a control that looks like one. "The ledger records only rounds that judged the
code" needed a SEQUENCE to be observable — a code round followed by a dead seat — and with
the guard removed that run reports `not-converging`, a kind asserting a DESIGN DEFECT,
about a review that never happened.

### The wiring is executed, not grepped

`trident/__tests__/escalation-e2e.test.ts` runs the shipped `inner-workflow.mjs` body
through the same AsyncFunction harness `inner-workflow-assembly.test.ts` uses, with
scripted review seats, and asserts what the run DID rather than what its source says: the
round-2 stop with only one fix round ever dispatched and two panels paid for; EXACTLY ONE
`plan:fable` seat across a run that declares a design gap three times; the re-planned
execution spec arriving in the NEXT fix round's prompt (a marker the planner produces at
run time, so it cannot be satisfied by a string that merely exists in the file); no fix
round at all when the re-plan returns nothing; and a converging control run that is left
alone and reaches its cap. A source-text assertion proves a string exists; it cannot prove
a call happened with the right argument, which is the entire content of "wired".

### Decisions worth recording

- **Identity is the reviewer's key, with no fingerprint fallback.** A title-normalising
  fallback would have made the gate look like it worked on legacy findings while being
  defeated by a reword. Findings this FILE authors (lane, suite, CI) carry no key and are
  therefore undecidable — which is honest, because none of them is a reviewer's judgement
  about the plan.
- **The repeat gate reads `isCodeWorkFinding`, the shared predicate, not a second copy.**
  A finding the loop would not have spent a round on cannot be evidence that the round was
  wasted. A recurring SUITE blocker IS kept: a required suite still red after a fix round is
  precisely "fixing is not working".
- **A `design-gap` re-plan outranks the arithmetic on the round it is declared**, because
  it is the specific bounded remedy for exactly the condition the numbers detect and costs
  one planner seat rather than the round budget. It cannot be used to dodge the gate: it is
  available at most once, and a repeat finding after it goes to the orchestrator.
- **A re-plan may RAISE the executor model but never lower it.** `modelForTag` routes
  `'mechanical'` to Sonnet/medium and everything else to Opus/high, so adopting the
  re-plan's tag wholesale let a re-plan DOWNGRADE the model on a run that had just proved
  hard enough to need re-planning — silently, on the rounds whose APPROVE ships the
  change. The asymmetry decides it: a wrong `'reasoning'` costs money, a wrong
  `'mechanical'` ships worse code.
- **The ledger records only rounds whose `blockKind` is `'code'`.** An infra-only or
  advisory-only round exits under its own kind and says nothing about the plan; folding one
  in would report a lane outage under a kind that asserts a design defect.
