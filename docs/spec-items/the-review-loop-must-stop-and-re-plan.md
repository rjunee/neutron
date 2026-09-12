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
    seven rounds. PREREQUISITE: findings need STABLE IDENTITY (a reviewer-emitted key such as
    `file:symbol:rule`, or a normalised fingerprint) — today they are free-text titles and "same
    finding" is not machine-decidable. That prerequisite is part of this item, not an assumption of it.
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

Built on branch `fix/review-loop-stop-and-escalate`; record at
`.trident/as-built/fix/review-loop-stop-and-escalate.md`.

- [x] A run whose reviewers repeat a finding STOPS and escalates instead of iterating. On
      the recorded data of run `36b95167` this fires at ROUND 2, not round 10.
      NOTE ON "the recorded data": that run's reviewers emitted no `key` field (it did not
      exist), so the test drives the gate with the three recorded findings carried under
      the identities this item introduces. The counterfactual is the only satisfiable
      reading — criterion 2 says as much when it calls identity a prerequisite of the item
      rather than an assumption of it.
- [x] Findings have STABLE IDENTITY (a reviewer-emitted key such as `file:symbol:rule`, or
      a normalised fingerprint). This is a prerequisite of the item, not an assumption of
      it: with free-text titles "same finding" is not machine-decidable, so a
      repeat-finding gate built on titles does not satisfy this.
      Built as the reviewer-emitted key ONLY, with no title-derived fallback: a fallback
      would make the gate look like it worked on unkeyed findings while a reword defeated
      it. An unkeyed finding is UNDECIDABLE, never a fresh one.
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
- [ ] `missing-dependency` → the ORCHESTRATOR reports in the project chat AND REORDERS
      the Work Board so the dependency precedes the blocked card (ROUTING, above).
      UNMET: the reporting half ships here — the chat message names the sequencing call,
      the card lands in `blocked`, and nothing re-dispatches it until it is moved out —
      but the orchestrator that makes and reports the reorder does not exist yet; it
      lands with #545.
