## 2026-09-23 — Attribute bounded work through the production attempt ledger

Implements the production consumer of the attempt ledger for
`docs/spec-items/trident-build-efficiency.md:100-115` (issue #1196).
The former build-loop accumulator wrote only completed turns and omitted panel
seats and synthesis. Project composition now admits every prepared plan, build,
fix, standalone review, panel seat and synthesis through one required ledger.
The old cumulative writer and its in-memory restart baseline are removed.

Each record binds the host run, task or Ralph iteration, bounded step, role or
seat, measured revision, provider, selected tier, resolved model and placement.
Preparation, dispatch, terminal outcome and provider observation have separate
host timestamps. A provider's separately reported model stays in its receipt.
Review readiness, review/synthesis, publication proof and cleanup retain interval
events. These intervals can overlap and are never added into a wall-clock total.
The dispatch interval includes any transport queueing the adapter cannot separate;
it is not claimed to be precise provider execution time.

All outcome variants retain observed provider measurements. Missing counters
remain unknown and zero stays zero. A host abort records interruption before a
transport has finished draining, while a later observation can still persist its
partial spend. Duplicate completion and host reconstruction reuse absolute
receipts under the original step identity. A partial recovery cannot erase known
fields. Accounting does not authorize result reuse: the substrate's existing
reservation and validation protocol remains responsible for that decision.
Invalid telemetry records an accounting refusal without changing the result.

Verification:

- `open/__tests__/project-build-e2e.test.ts`: 130 passed. New cases exercise a
  complete unknown-metadata run, actual Codex transport measurements with valid
  and mismatched result identities, explicit zero versus partial failed work,
  and reconstructed host recovery with one child dispatch and unchanged totals.
- `trident/attempt-accounting.test.ts`: 11 passed against migrated SQLite,
  including all outcome kinds, missing/zero/nonzero controls, ownership mismatch,
  duplicate/restart recovery, telemetry refusal and abort with late measurements.
  The existing `trident/phase-usage.test.ts` and `trident/attempt-ledger.test.ts`
  projection/storage tests also pass.
- Driver, generic/project host and project review-source tests: 316 passed.
  Worker adapters and wiring checks passed; the localhost REPL reuse test needed
  execution outside the socket-restricted sandbox and then passed.
- Both `tsc -p tsconfig.json --noEmit` and
  `tsc -p trident/tsconfig.json --noEmit` passed.
- Semantic mutations in `attempt-accounting.ts` each went red: discard failure
  observations; turn measured zero into null; add a replayed receipt to prior
  spend; omit the resolved-model identity guard; veto missing telemetry. Restored
  tests pass, including the valid ownership and absent-metadata controls.

This change wires observations that the adapters provide; it does not invent
missing native-child metadata or historical spend. Live deployment measurement
and the remaining efficiency criteria are still required before closing #1196.
