---
title: Show both build counters on the card as <ralph_round>.<round>
group: work-board
status: open
priority: P2
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**A build's progress is TWO counters, so the card must show both — `<ralph_round>.<round>`**
(owner request, 2026-08-13). A trident run nests two loops and the board renders one of them, so a run
can grind through twenty task iterations while the owner watches a number that never moves.
`ralph_round` is the OUTER loop — which task of the governed plan is being built, each in a fresh
context, bounded by `max_ralph_rounds` (`trident/orchestrator.ts` `refireNextRalphTask`).
`round` is the INNER loop — the Argus review round for the task in hand, bumped on REQUEST_CHANGES →
forge-fix and bounded by `max_rounds` (`trident/state-machine.ts`). Task 2 under its first review is
therefore **2.1**, and it is the LEFT digit that tells the owner the build is advancing.
Acceptance: a run that re-fires to its next task visibly changes the number on the card without the
owner asking; and the three surfaces that answer "where is this run" — the card, `codegen_status`, and
the run row — do not disagree. (The `phase` a ralph re-fire deliberately leaves untouched, so
`codegen_status` can report `forge-init` half an hour into a healthy run, is part of the same defect:
correct mechanically, false as a status.) Related, and deliberately NOT the same item: the
`Work Board row state` card fixes the same class one layer up — a row must not claim a run it does not
have — and the pulse half of it is the entry above, blocked on the heartbeat. THIS entry is a DISPLAY
defect over a counter we already record honestly; that one is a MISSING SIGNAL. Collapsing them would
only make a run that reports nothing report nothing more precisely.

## Acceptance

- [ ] A run that re-fires to its next task visibly changes the number on the card **without
      the owner asking**. Task 2 under its first review reads `2.1`.
- [ ] The three surfaces that answer "where is this run" — the card, `codegen_status`, and
      the run row — do not disagree. Assert all three against one re-fired run; checking a
      single surface passes with the defect present.
- [ ] `codegen_status` no longer reports `forge-init` half an hour into a healthy run.
- [ ] This does not absorb the pulse item. This is a DISPLAY defect over a counter already
      recorded honestly; the heartbeat item is a MISSING SIGNAL. A change that collapses
      them makes a run that reports nothing report nothing more precisely.
