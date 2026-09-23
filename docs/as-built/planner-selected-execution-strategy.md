## 2026-09-23 — Planner-selected execution strategy

Issue #1216; acceptance remains in
[`planner-selected-execution-strategy`](../spec-items/planner-selected-execution-strategy.md).
This records the repository implementation and its local verification. It does
not establish deployment or live acceptance. The final complete partitioned
suite on the exact candidate head was still running when this record was written;
its outcome is not claimed here.

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

Verification of the committed implementation:

- Root and Trident TypeScript checks and whole-tree lint passed.
- The complete production-consuming E2E file passed 236/236 in one invocation.
  Focused verification passed 890 tests; migration and board verification passed
  304 tests.
- Twenty driver semantic mutations covered both directions of selection
  evidence, launch hints, resume authority, reclassification, closed plans,
  whole-plan remainder, persistence refusal, ledger agreement, continuation,
  and suite scope. Each produced a failing guard with a passing legitimate
  sibling. Six UI/client mutation classes were also caught. Ten additional
  bidirectional budget mutations exercised exhausted and remaining allowance
  cases, including card-owned spend across retry and strategy translation.
- Independent review found and verified fixes for null-selection checkpoint
  authority, migrated-wave recovery, missing historical rebuild columns, and
  a partial missing-counter budget refund. The last budget correction is in
  commit `72e8a68f8`; card spend remains durable when a retry lacks its prior
  run link. The bounded re-review approved those fixes.

The earlier partitioned run saw obsolete fixture and citation failures while
the source was changing. Those results describe an intermediate revision, not
the candidate head. The final exact-head full suite is still running, so no
complete-suite pass is asserted. Issue #1219 tracks a separate inherited
condition and is not acceptance evidence for this change.

The exported candidate and exact base each reported 455 inherited leak
findings with identical rule totals; neither whole tree is silent. Publication
remains subject to the exact-head full-suite result and repository guards.
No push, PR, merge, deployment, or live acceptance is claimed.

The full-planner refresh now preserves the host-owned ordered pending task
sequence (`trident/build-run.ts`). A planner cannot tick, drop, reorder, or
declare unfinished accepted tasks terminal to reach review early. Execution
details remain revisable. Only a matching-head `task-built` checkpoint with
the accepted remainder advances one task; checking the remainder also prevents
advancing twice after selection persistence and before reservation cleanup.
Cheap continuation still uses its measured ledger. Previously accepted terminal
tasks without checkbox syntax retain their task identity.

Additional refresh verification:

- The complete Open project-build E2E file passed 250/250 with 2,860 assertions.
  Its new production-host cases refuse tick/drop/reorder proposals before
  persistence or building and accept an execution-detail revision that advances
  only the checkpointed task. An earlier sandbox run failed nine local-socket
  cases; the complete socket-capable rerun above passed all of them.
- The driver passed 356/356. The broad Trident run recorded 6,276 passed,
  five skipped, and one failed across 197 files: an old fixture seeded
  `first/second` but refreshed it as `first/next`. The fixture now preserves
  its accepted task names; its complete production-host file then passed
  110/110. The broad suite was not rerun after that fixture-only correction.
- Both TypeScript checks, changed-file ESLint, and the diff whitespace check
  passed. Candidate and exact preceding base leak scans both reported 455
  findings, with identical rule totals; no whole-tree silence is claimed.
- Paired final-code mutations were caught in an isolated copy. Bypassing the
  guard produced five failing driver cases with eleven passing siblings and
  three failing production-consuming cases with the valid detail sibling
  passing. Refusing every guarded refresh produced six failing driver cases
  with ten passing siblings and failed the valid production-consuming detail
  case while all three attack refusals passed. Restoring the implementation
  passed all sixteen focused driver cases and all four consuming cases.
