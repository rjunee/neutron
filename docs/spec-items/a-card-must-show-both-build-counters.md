---
title: Show task progress and review round explicitly on the card
group: work-board
status: done
priority: P2
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

The owner’s 2026-09-23 decision replaces the decimal task/review counter with
`Task N/M · Round R`. A display such as `10.1` conceals both what is advancing
and how much work remains. This supersedes the 2026-08-13 decimal presentation;
the two counters still describe separate things.

For Ralph, `N` is the one-based task iteration (`ralph_round + 1`) and `R` is
the review/fix round. `M` is the latest plan estimate: at an intermediate task
harvest, the completed task number plus the validated remaining-task count.
The total is persisted in the same write that advances the task and consumes
its result. It can grow or shrink when a later result revises the plan. It is
never `max_ralph_rounds`, which limits spending and says nothing about plan size.
This is current iteration progress, not an immutable count of original task IDs.

A fresh first task or historical run has no recorded total and reads
`Task N/? · Round R`. Same-run retries and redispatch from an existing run or
card seed preserve a known total. A non-Ralph run reads only `Round R`;
terminal rows hide the counter. Mobile and web use the same server-derived
task number and total. Older gateway frames without task identity show only
the known review round instead of guessing a build mode.

This changes progress presentation and persistence, not escalation thresholds
or the heartbeat signal. See the Decisions Log entry dated 2026-09-23.

## Acceptance

- [x] A Ralph task with iteration 9, total 15 and review round 1 renders
      `Task 10/15 · Round 1` on phone and web; missing total renders `?`.
      verify: mobile row/helper and web Work Board render tests.
- [x] Non-Ralph runs show `Round R`; terminal rows show no counter. Malformed
      totals never become a numeric denominator.
      verify: both client parser suites and render tests.
- [x] An intermediate harvest advances the task, records its plan total, clears
      the consumed result and releases the worker in one persisted update.
      Reopening the database reads the same task/total; replacement plans can
      decrease or increase the estimate.
      verify: `trident/orchestrator.test.ts`, task-total re-fire test.
- [x] Infrastructure retry, prior-run redispatch, and card-only redispatch keep
      the known total. Terminal reconciliation preserves it when the run link
      is subsequently cleared.
      verify: orchestrator, retry-resumes-checkpoint, board-dispatch and
      board-reconcile tests.
- [x] Card progress, `codegen_status` and the run row agree on task number,
      total and review round; changing the iteration cap cannot change the total.
      verify: shared run-progress, status-route and board HTTP tests.
- [x] Substituting the iteration cap for the denominator and restoring decimal
      formatting each make the corresponding semantic tests fail.
