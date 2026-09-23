## 2026-09-23 — Planner-selected execution strategy implementation checkpoint

Issue #1216; acceptance remains in
[`planner-selected-execution-strategy`](../spec-items/planner-selected-execution-strategy.md).
This is a WIP implementation checkpoint, not release or deployment acceptance.
The partitioned suite is red and its remaining isolation lanes were interrupted
at the requested restart boundary. Do not close the issue from this record.

The existing planner now returns a closed strategy/rationale/plan contract.
Fresh implementation runs start with no selection; the host validates, persists,
and reads back the decision before dispatching a builder. `single` executes the
whole accepted plan; `task_sequence` executes the host-selected ledger task.
Neither `SPEC.md` presence nor arbitrary checklist length selects a strategy.
Wave and bound-review remain host modes. Model, effort, and substrate routing
are unchanged. Recovery, retries, and bounded replanning cannot reclassify work.

The forward migration replaces current run/card vocabulary and preserves the
historical migration ledger, dependent accounting rows, and stored checkpoint
events. Legacy boolean selections map deterministically to the two strategies.
Card spend is monotone and its allowance can only tighten. Missing historical
counter evidence disables allowance rather than buying new work. The obsolete
overnight-queue selector is retained only as historical storage provenance;
new overnight runs also await the planner. Current API and UI show planning
pending, a single review round, or task progress plus review round.

Original legacy worker reservations retain their exact requests and artifacts.
Versioned new briefs and plan schema avoid overwriting those artifacts. The
compatibility check requires legacy provenance, the complete original worker
identity, unchanged authority/routing/budgets, and verified original brief bytes.
It cannot authorize a new-format malformed proposal. Historical SQL, immutable
SPEC decisions, frozen records, and gate IDs/history were not rewritten.

Measured before the restart boundary:

- Root and Trident TypeScript checks and whole-tree lint passed.
- Driver: 333 tests passed; legacy normalization: 41 passed; host/contract
  suites: 222 passed; persistence/retry: 523 passed; migrations: 225 passed.
- A complete production-consuming E2E run passed 227 tests. The final legacy
  subset passed 16, including nine subsequently added coherent worker-identity
  forgeries. The resulting 236-case file was covered across those runs, not
  claimed as one complete 236-case invocation.
- API/client/progress tests passed; consuming web UI passed 46 and app/helper
  tests passed 71. Isolated mutation restoration passed 171 core/client tests
  and 46 web tests.
- Twenty driver semantic mutations covered both directions of selection
  evidence, launch hints, resume authority, reclassification, closed plans,
  whole-plan remainder, persistence refusal, ledger agreement, continuation,
  and suite scope. Each produced a failing guard with a passing legitimate
  sibling. Six UI/client mutation classes were also caught. The restored
  driver passed all 333 tests. The broader every-touched-guard audit, including
  final persistence and compatibility mutations, is still required.
- Independent review found and verified fixes for null-selection checkpoint
  authority, migrated-wave recovery, missing historical rebuild columns, and
  a partial missing-counter budget refund. The bounded re-review approved
  those fixes; this is not a substitute for final frozen-commit review.

All 24 general partitions ran. Outstanding failures are in
`open/__tests__/open-skill-forge-wiring.test.ts`,
`open/__tests__/open-trident-prod-boot-wiring.test.ts`,
`open/__tests__/project-build-wiring.test.ts`, the legacy
`trident/__tests__/{dead-core-seat,dying-reviewer,escalation}-e2e.test.ts`
harnesses, and `trident/{codex-build-arrival,gates-inventory-citations,
slug-retry-after-terminal,tick}.test.ts`. They include old mode/plan-envelope
fixtures and historical citation resolution after test-file renames. The run
also observed an earlier migration draft while that file was changing; the
final migration separately passed all 225 migration tests. The full run is not
evidence for one frozen source revision. Local log: `/tmp/strategy-full-suite.log`.

The exported candidate and exact base each reported 455 inherited leak
findings with identical rule totals; neither whole tree is silent. Exact
changed-file/message leak checks with positive controls remain required.
Finish the fixture repairs, every-touched-guard mutation audit, complete frozen
full suite, as-built guard, and frozen-commit review before publication.
No push, PR, merge, deployment, or live acceptance is claimed.
