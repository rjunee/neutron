---
title: Let the initial planner select a persisted execution strategy
group: trident
status: open
priority: P0
cutover: true
---

# Planner-selected execution strategy

Work state: GitHub issue #1216. The owner approved this change on 2026-09-23.
The governing decision is the dated entry in `SPEC.md`. This item owns the
acceptance criteria; the issue owns priority and progress.

The initial planner already produces an executable plan. It must also propose
`single` or `task_sequence`, with a nonempty rationale, for every fresh
implementation build. `single` asks one builder invocation to complete the
whole accepted plan; `task_sequence` asks each invocation to complete exactly
the host-selected task. The planner weighs the work, dependencies, and useful
execution boundaries. A count of arbitrary Markdown checklist bullets is not
an execution strategy. A repository's `SPEC.md` and governance remain
authoritative context, but their presence or absence cannot select the strategy.

## Persisted contract

Fresh implementation runs begin with `execution_strategy = NULL` (planning
pending). Selected strategies are exactly `single` and `task_sequence`.
The host validates the closed planner result and persists the strategy,
rationale, and accepted plan before dispatching a builder. Invalid or unavailable
selection is a named blocked or unknown outcome, never a default to `single`.
Wave members and bound reviews remain explicit host modes.

Selection is immutable across continuation, restart, infrastructure retry,
cross-run retry, and bounded replanning. Replanning may revise the accepted
execution details within the selected strategy; it cannot reclassify the run.
The host continues to own task identity, test scope, review, mutation proof,
publication, merge, and all budgets. Card-owned iteration spend and its cap
survive every strategy translation and retry, including when a prior-run link
is cleared. A retry cannot buy a fresh budget by changing strategy.
For an intermediate task, its validated completed-build checkpoint charges the
iteration before the host writes the Git ledger. Settling or rejecting a pending
ledger handoff cannot refund that spend or charge it twice. Ledger recovery uses
the original task identity even though the persisted spent count is one ahead.

Legacy stored `ralph = 1` maps to `task_sequence`; `ralph = 0` maps to `single`.
Migration translates durable counters and phases/checkpoints without changing
their meaning or spending. Legacy active runs keep that selection without a
filesystem probe. Historical SQL migrations, immutable Decisions Log entries,
and frozen as-built records retain their original names. An explicit terminology
map preserves their provenance and the gate inventory's historical anchors.
Current code, schema, API, prompts, and living documentation use the new terms.

## Acceptance

- [ ] The existing initial planner selects either strategy for a repository
  with `SPEC.md` and for one without it; all four combinations reach the
  corresponding builder scope. There is no additional classification call.
  Verify through `open/__tests__/project-build-e2e.test.ts` and the build driver.
- [ ] Missing, malformed, unknown, contradictory, or incomplete strategy results
  prevent builder dispatch. Valid results for both strategies remain executable.
  The result schema is closed, and the builder observes the persisted decision.
- [ ] `single` completes the whole accepted plan and uses terminal full-suite
  scope. `task_sequence` builds only the host-selected task, validates its
  ledger, defers review/publication while tasks remain, and reviews only the
  terminal cumulative result. Preserve G025–G029, G037, and G063.
- [ ] Restart, same-run recovery, cross-run retry, changed branch heads, and
  cleared card links preserve selection and spend. Missing or corrupt evidence
  cannot reclassify a selected run. Exhausted cards cannot dispatch more work;
  a legitimate remaining-budget sibling still can. Preserve G070–G082.
- [ ] A forward migration preserves existing run/card counters, caps, totals,
  checkpoints, retry links, and mode-state events. Test a historical database,
  a fresh database, a reopened migrated database, and the migration ledger.
  Legacy active single and task-sequence runs continue safely with unchanged
  publication and review authority.
- [ ] The Work Board displays `Planning pending` before selection, `Round R`
  for `single`, and `Task N/M · Round R` for `task_sequence` (`?` for an unknown
  total). Terminal rows hide progress. Both clients validate current frames
  and handle older frames without inventing a strategy.
- [ ] Wave and bound-review behavior, model/effort/substrate routing, pinned
  merge, review independence, and every other affected inventory gate remain
  enforced. Existing gate IDs/history are preserved with a terminology map.
- [ ] Every touched guard has paired semantic mutations in both directions,
  each with a legitimate sibling control. Run the consuming E2E suite, migration,
  live-ledger/schema, UI/client, retry/recovery and budget suites; both root and
  Trident TypeScript checks; then the complete partitioned suite, lint, leak,
  as-built and diff checks. Record exact outcomes and limits in one new as-built
  shard. This item does not claim live deployment or close the broader pivot.
