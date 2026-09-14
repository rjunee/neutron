---
title: The project REPL owns the build loop
group: trident
status: open
priority: P0
cutover: true
legacy_ref: "#545 — pivot step 3; docs/plans/harness-orchestrator-pivot-2026-09-11.md §3"
---

#545 is the umbrella for pivot step 3 and has carried **no acceptance criteria** since it
was migrated from the Work Board. Its body says so itself — criteria belong in a spec item
"if and when this one's 'done' needs to be enforceable". It is the last open item of
milestone 2, so that time is now: without this file the milestone closes on opinion.

**What it is NOT.** Three slices have merged and none of them is this item: escalation
routing into sequencing decisions (#697), the orchestrator's board reorder and its report
(#707, which closed #536), and terminal build decisions moving onto the project
conversation (#716). Each is real and each is a step; none replaces the loop.

**The measurement that shows why.** `trident/inner-workflow.mjs` is 9,315 lines,
`trident/orchestrator.ts` 6,316, `trident/inner-loop.ts` 1,167 — **16,798 lines**, intact.
The umbrella's own words are that this loop is "replaced". Reporting milestone 2 as
"6 of 7" is true by issue count and misleading by effort, and this file exists so that
cannot happen again.

## What done means

Derived from the locked design, `docs/plans/harness-orchestrator-pivot-2026-09-11.md` §3.1,
§3.2 and §3.4. Each criterion names the property, not the mechanism, because the mechanism
is the thing being rebuilt.

## Acceptance

- [ ] **The project REPL runs the build.** A build for a project executes in that project's
      long-lived REPL rather than in a separately-composed loop. Asserted by a test that
      fails if the build runs anywhere else — not by the absence of the old path.

- [ ] **Bounded work splits on MODEL, not on kind.** Same-model work dispatches as a
      subagent inside the REPL; different-model work runs as a headless worker of the other
      harness. Both directions asserted: a same-model task that spawns a headless process
      fails, and a cross-model task that tries to run in-REPL fails.

- [ ] **A headless worker never talks to the owner.** It returns "blocked on X" to the
      orchestrator, which decides whether that reaches him. Asserted by a test in which a
      worker attempts to ask and the attempt is refused or routed — and its complement, that
      the orchestrator CAN ask, so the guard is not simply muting everything.

- [ ] **Exactly one place asks the owner a question**, in the chat he is already in. An
      enumeration with a positive control, not a claim: the grep that finds the sanctioned
      path must also be the grep that would find a second one.

- [ ] **The old loop is DELETED, not flagged off.** No dual code path — the repository
      forbids it. Establish by grep with a positive control that nothing still routes
      through the replaced loop, and say what was deleted rather than what was added.

- [ ] **The gates are kept.** Every gate the current loop enforces is enforced by the new
      one. Enumerate them first — a list derived by grep, with a positive control, not by
      reading the old file top to bottom — and pin each. A gate silently lost in a rewrite
      is the most likely real defect in this whole item.

- [ ] **The run still cannot mutate the Work Board.** `trident/escalation-block.test.ts`
      holds this line today ("the run cannot REORDER the board"; "the reconcile is handed
      ONE board verb"). It must still pass, unmodified, against the rebuilt loop.

- [ ] **A card is dispatched and reaches MERGED with no human touching it.** The owner's own
      definition of "trident works", and the only criterion here that is about the product
      rather than the code. That number has been 0 of 291.

## Notes on scope

This is deliberately large, and splitting it is expected. A slice may tick individual boxes
provided it leaves no half-migrated state — one orchestrator live at a time — and says in its
record which boxes it did NOT tick. What is not acceptable is closing #545 with boxes
unticked, which is what the absence of this file has been permitting.
