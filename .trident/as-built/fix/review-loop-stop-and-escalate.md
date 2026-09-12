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
green. Normalisation drops case, whitespace, a leading `./` and LINE NUMBERS (a fix round
moves lines without fixing the defect), and requires three surviving segments so a bare
title cannot masquerade as a key. A finding with no usable key is `''` — UNDECIDABLE, and
never a fresh identity.

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
`block_kind`). Three surfaces read the distinction through it and none re-implements it:
the chat line (`🛑 … build BLOCKED, not failed`, under its own glyph — every other class
keeps its ❌ byte-identical), the stored `failure_reason` (`escalationStopSentence`,
replacing the generic "…without Argus APPROVE" catch-all), and the card's lane.

Migration `0140` adds a sixth `work_board_items.status`: `blocked`. It is RUN-DRIVEN and
NOT client-writable (the agent tool and the HTTP surface keep their four values) and it is
ACTIVE — the card keeps its `sort_order`, stays in `listActive`, and never stamps
`completed_at`. A `missing-dependency` escalation lands there rather than in `failed`
(wrong word) or `upcoming` (looks startable, and the next dispatch would re-learn the same
block). An escalation is also recorded as a REQUEST_CHANGES rather than REVIEW_NOT_RUN: a
run only reaches one from a round a full panel judged.

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
- **The ledger records only rounds whose `blockKind` is `'code'`.** An infra-only or
  advisory-only round exits under its own kind and says nothing about the plan; folding one
  in would report a lane outage under a kind that asserts a design defect.
