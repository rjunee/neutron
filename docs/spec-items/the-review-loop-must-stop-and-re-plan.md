---
title: Stop and escalate a review loop instead of iterating on a bad plan
group: trident
status: open
priority: P0
cutover: true
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**The review loop must be able to STOP and re-plan — a fix round cannot repair a defect in the plan**
(owner-directed 2026-08-13, from run `36b95167`, which burned ten rounds and ~2.5h to reach a verdict
knowable at round 2). Three constraints compose into a trap, and no one of them is wrong alone:
(i) the verdict enum is effectively binary — `APPROVE` / `REQUEST_CHANGES` / `COMMENT` with `COMMENT`
normalised into `REQUEST_CHANGES` (`inner-workflow.mjs` `normalizeVerdict`), so a reviewer who
diagnoses a DESIGN gap has one channel and that channel means "go fix the code";
(ii) Forge is contractually a PURE EXECUTOR — "do NOT re-plan or redesign" — so the only agent that
receives the findings is the one forbidden to act on what they mean;
(iii) `plan:fable` is invoked ONCE, OUTSIDE the fix loop (`inner-workflow.mjs` ~2073 vs the `while` at
~2175), so the only agent permitted to re-plan never hears a single reviewer finding.
The escape hatch already exists in two flavours — the loop runs only while
`synthesis.blockKind` is neither `'infra-only'` (no seat judged the code) nor `'advisory-only'` (a healthy
panel judged it and said only things this file has already declared non-blocking) — proving the category
is understood; it simply has no siblings that say the PLAN is wrong.
EVIDENCE (all nine review results of `36b95167`): three findings — the tautological "row/rail lockstep"
test, the out-of-spec `inline_active` proxy, and the untouched research/dispatch path — recur in ALL
NINE rounds, and the finding totals never converge (9, 8, 13, 9, 8, 12, 9, 10, 11). Note the planner
AUTHORED the tautological test in its execution spec, so no number of fix rounds could ever remove it.
TRIGGERS (a run must escalate when ANY fires):
(a) REVIEWER-DECLARED — extend `blockKind` with `design-gap` (the plan is wrong) and
    `missing-dependency` (needs work outside this card), each REQUIRING a `whatIsMissing` field so it
    cannot be a bare complaint. Fast (can fire at round 1) but self-declared, so it must never be the
    only trigger — a self-declared exit is an escape hatch an agent can learn to pull.
(b) REPEAT-FINDING — a finding that survives a fix round means fixing is not working. This is the HARD
    gate: it is arithmetic and requires no agent to be honest. Would have fired at ROUND 2 here, saving
    seven rounds. PREREQUISITE: findings need STABLE IDENTITY constructed from required named
    `file`, `symbol`, and `rule` fields. `line` and free-text prose are excluded by structure, so line
    movement and rewording cannot change identity. That prerequisite is part of this item, not an
    assumption of it.
(c) NO-PROGRESS — blocker+major count not strictly decreasing across two rounds (real data: 4, 2, 6, 4,
    2, 4, 4, 4, 5 → fires round 3). Needs no finding identity, which is its only virtue; noisy, because
    a round can legitimately fix three findings and surface two.
ROUTING — escalation goes to the ORCHESTRATOR (the project chat), never to a dead end:
• `design-gap` → ONE bounded re-plan per run, with the findings attached so the planner is no longer
  deaf. Unbounded re-planning reproduces this same waste one level up as a plan↔fix oscillation.
• `missing-dependency` → the ORCHESTRATOR, which owns SEQUENCING: it reports in the project chat and
  REORDERS the Work Board so the dependency precedes the blocked card. This is the case `36b95167` was
  actually in, and it composes with the dependency-aware dispatch item — a card escalated this way must
  move to a visibly BLOCKED state, not sit in `upcoming` looking startable.
• a repeat finding AFTER the bounded re-plan → the orchestrator. The re-plan gets exactly one chance to
  prove it changed something.
GUARDRAIL: the RUN reports; the ORCHESTRATOR decides. A build must never mutate the board itself, or an
autonomous run could reorder the owner's priorities with no judgement in between. Creating a card for a
dependency that does not yet exist still follows the standing intake rule — spec first, then card;
reordering cards that ALREADY exist is the sequencing call the orchestrator may make and must report.
Escalating is cheap to make safe: branch and PR already survive a terminal failure, so stopping early
loses nothing. Round 10 bought nothing over round 2 except cost.
Acceptance: a run whose reviewers repeat a finding stops and escalates instead of iterating; the round
cap becomes the backstop it was meant to be rather than the primary exit; and the owner can see, on the
card, that a build stopped because it was blocked rather than because it failed.

## Acceptance

### Typed host terminal transport (2026-09-25)

The host's arithmetic G070/G071 STOP carries structured trigger, previous/current
finding identities, blocker/major counts and round through the launcher into the
canonical escalation result. The terminal harvest, Work Board reconciliation,
delivery and project-chat wake consume that result through the existing escalation
decoder. A host STOP must not be reduced to a generic `inner-error` without its
escalation evidence. The stored full host result retains the identities; bounded
owner-facing evidence begins with the counts so truncation cannot hide them.
The verified-panel consumer attaches the reviewed head and panel decision before
suite, CI and arithmetic overrides. For those stops the launcher records the host's
`REQUEST_CHANGES` while preserving the actual panel's `argus-approved` or
`argus-request-changes` checkpoint, exact head and round. Nexus attributes the
actual panel decision to Argus and the host terminal result to the handoff. Host-only
nomination repair also uses arithmetic but cannot attach a reviewed head, and
must remain `REVIEW_NOT_RUN` with no reviewer decision event.

- [x] A nondecreasing second review stops before a second fix, persists a rejected
      checkpoint, and yields a BLOCKED card with the specific cause and project-chat
      escalation evidence. Its published PR stays open and its base remains unmoved.
      The composed terminal observer persists a `REQUEST_CHANGES` host handoff and
      the actual Argus decision in Nexus, never a misleading `REVIEW_NOT_RUN` handoff.
      A panel approval followed by G070 remains a host veto, not an invented Argus
      rejection. Every arithmetic STOP persists the rejected typed checkpoint even
      when the underlying panel decision is approve, re-plan, or a verified block.
      A simultaneous nomination round ceiling or exhausted re-plan cannot erase
      the arithmetic evidence. Immediate delivery and checkpoint recovery retain
      the same BLOCKED classification and reviewed provenance. An exhausted
      re-plan with distinct decreasing findings retains its ordinary refusal;
      it does not acquire an arithmetic veto.
      verify: `bun test open/__tests__/project-build-e2e.test.ts -t 'review arithmetic STOP'`
- [x] The rejected checkpoint and its arithmetic veto are one durable write. A
      crash after that write but before returning STOP cannot authorize another
      fix or rebuild: same-run recovery validates and rechecks the saved arithmetic,
      then re-delivers BLOCKED with the same round, head and actual panel decision
      without dispatching work or resetting spend. A distinct decreasing-count
      rejection still resumes its permitted fix. Malformed veto evidence refuses
      continuation; legacy rows are not backfilled with invented STOP evidence.
      verify: `bun test open/__tests__/project-build-e2e.test.ts -t 'review arithmetic STOP.*checkpoint interruption'`
      verify: `bun test trident/build-run.test.ts -t 'checkpointed arithmetic STOP'`
- [x] Repeated identities yield the same BLOCKED transport even when counts fall;
      distinct decreasing counts still continue. An ordinary host failure, a blocked
      outcome without arithmetic evidence, and an unharvested result are not relabeled
      as escalation. A reason string resembling the STOP cannot manufacture evidence.
      Host-only arithmetic with zero reviewers may report BLOCKED but cannot
      manufacture reviewed provenance or an Argus decision.
      verify: `bun test trident/gates/review-progress.test.ts trident/project-launcher.test.ts`

### Follow-up proposal: orchestrator-authorized re-plan from a rejected head

This is a separate recovery change, not permission to widen ordinary retry's
checkpoint whitelist. `build-mode-state.ts` refuses a `rejected` terminal source.
Same-run recovery re-delivers a checkpointed arithmetic veto; other rejected
checkpoints can still resume their permitted fix. Neither path authorizes a new
orchestrator re-plan, and historical rows without the durable veto are not upgraded
by widening the terminal-source whitelist.

The proposed recovery action belongs to the authenticated project-chat
orchestrator. It records a durable, one-use decision bound to project, card, prior
run, exact latest checkpoint event, base OID, published PR number and head OID,
and a nonempty reason/revised planning direction. Neither model output nor an
ordinary retry boolean is authority. The action must atomically claim its source;
parallel requests and replay after consumption cannot launch another recovery.

Before admitting work, resolve the open PR in the expected repository and prove
its head equals the rejected checkpoint and the remote branch tip. A deleted local
branch/worktree may be reconstructed from that verified published head; missing,
moved, closed, merged, unowned or unreadable evidence refuses without fresh-build
fallback. Launch rechecks the same evidence after any dispatch/launch race.

Import the checkpoint and findings under a distinct recovery-source type, retaining
task spend/cap, review round/cap, accepted strategy, base and previous review
baseline. Consume the single bounded re-plan allowance across the lineage before
the planner runs. Pass the prior findings and the orchestrator's direction to a
full re-plan, then build and independently review. G070/G071 compare the resulting
review against the retained baseline; neither an unchanged/worse result nor a
second re-plan is authorized. If a review round or task budget is exhausted, refuse
without resetting it. Approval and provider receipts are never inherited.

Every refusal stays visible on the card and preserves its source binding and
BLOCKED lane. Delivering that refusal surface requires the dispatch API, durable
board reason storage and both card renderers, beyond the terminal transport fix.

Real-Git test plan for that follow-up:

- Recover a published rejected head after removing its local branch and worktree;
  assert exact parent/base ancestry, imported findings/counters, one planner/build,
  subsequent fresh review and no merge before approval.
- Repeat with moved remote head, wrong PR/repository/card/source event, unreadable
  ref, active worktree holder, exhausted task/review/re-plan budget and ordinary
  redispatch: no worker, no fresh row that refunds spend, visible refusal.
- Change the remote between dispatch and launch; race/replay the same authorization;
  crash before/after its consumption. Each source grants at most one re-plan and
  every restart retains the imported budget and baseline.
- After the authorized build, repeat a finding or keep/increase the count: STOP
  again. The positive sibling uses distinct decreasing findings and completes the
  normal governed review loop. Root and Trident TypeScript checks plus the Open
  consuming harness are required; mocks of source selection alone are insufficient.

### Original workflow acceptance

Built on branch `fix/review-loop-stop-and-escalate`; record at
`.trident/as-built/fix/review-loop-stop-and-escalate.md`.

- [x] A run whose reviewers repeat a finding STOPS and escalates instead of iterating. On
      the recorded data of run `36b95167` this fires at ROUND 2, not round 10.
      NOTE ON "the recorded data": that run's reviewers emitted no `key` field (it did not
      exist), so the test drives the gate with the three recorded findings carried under
      the identities this item introduces. The counterfactual is the only satisfiable
      reading — criterion 2 says as much when it calls identity a prerequisite of the item
      rather than an assumption of it.
- [x] Findings have STABLE IDENTITY constructed from required named `file`, `symbol`, and
      `rule` fields. This is a prerequisite of the item, not an assumption of it: with
      free-text titles "same finding" is not machine-decidable, so a repeat-finding gate
      built on titles does not satisfy this. `line` is a separate evidence field and does
      not enter identity. There is no legacy-key or title-derived fallback: a finding
      missing any identity field is UNDECIDABLE, never a fresh one.
- [x] The REPEAT-FINDING gate is arithmetic and requires no agent to be honest. A
      self-declared `design-gap` / `missing-dependency` exit exists too, but is never the
      ONLY trigger — assert the arithmetic gate fires with the self-declaration suppressed.
- [x] `design-gap` and `missing-dependency` each REQUIRE a `whatIsMissing` field, so
      neither can be a bare complaint. Assert an escalation without it is refused.
      Refused in TWO places, because either alone is reversible by the other: the
      workflow's `validateEscalationClaim`, and `parseInnerEscalation` on the way back out
      of the database.
- [x] A `design-gap` buys exactly ONE bounded re-plan per run, with the findings attached.
      Assert a second re-plan is refused — unbounded re-planning reproduces the same waste
      as a plan↔fix oscillation.
      INCLUDING when the code itself is fine. A design gap declared alongside only
      minor/nit findings was authorised and then discarded: the severity gate had turned
      that round's verdict into APPROVE and the fix loop was gated on it, so the re-plan
      could not run and the stop reported `re-plan-unreachable` with rounds still in the
      budget. A pending re-plan is now its own reason to enter the loop, because it is a
      claim about the WORK'S VIABILITY and every other clause of that loop is a claim about
      the CODE'S QUALITY. Asserted at exactly one planner call, in both directions.
- [x] **The RUN reports; the ORCHESTRATOR decides.** A build must never mutate the Work
      Board itself. Assert a run cannot reorder cards — a test where the run writes to the
      board must go red.
      The inner workflow has no board access at all (absence established by grep with two
      positive controls — see the as-built record). The only board writer a build can reach
      is the terminal reconcile, whose interface is `detachRun` and nothing else; a hostile
      escalation payload naming a card and a position is asserted inert, and a reconcile
      that obeys it turns two tests red.
- [x] A card escalated as `missing-dependency` moves to a visibly BLOCKED state, not
      `upcoming` looking startable, and BLOCKED means something at the dispatch boundary:
      the chokepoint refuses it (`card_blocked`, not queued — nothing can re-test a
      decision) and neither UI offers a play or retry control for it. Without that half
      the lane is decoration: the next dispatch picks the card up and relearns the same
      block, which is the loop this item closes inside the run, reopened one level out.
      `work_board_items.status = 'blocked'` (migration 0140) — run-driven, not
      client-writable, and ACTIVE rather than terminal: the card keeps its `sort_order` and
      never stamps `completed_at`, because it is unfinished work that is waiting.
- [x] The round cap becomes the backstop rather than the primary exit, and the owner can
      see on the card that a build stopped because it was BLOCKED rather than because it
      FAILED — two different words, not one.
- [x] `missing-dependency` → the ORCHESTRATOR reports in the project chat AND REORDERS
      the Work Board so the dependency precedes the blocked card (ROUTING, above).
      The existing terminal-wake orchestrator independently reads the board and linked
      specs, then calls `work_board_reorder` with `precedes`. The store atomically
      moves an existing active dependency before the blocked card, or reports that it
      already precedes it without rewriting the order. The tool posts the sequencing
      result in project chat; the blocked lane remains enforced at dispatch.
      verify: `bun test work-board/dependency-sequencing.test.ts
      trident/escalation-block.test.ts trident/board-dispatch.test.ts`
      Terminal decision turns now use the project conversation's substrate and chat
      queue. Launch, workflow control and checkpoint transport remain broader #545 work.
      verify: `bun test gateway/wiring/__tests__/build-live-agent-turn-overlap.test.ts
      open/__tests__/open-terminal-build-wake-wiring.test.ts`
