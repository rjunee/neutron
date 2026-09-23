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
Dependency preparation, explicit review-thread queueing, review readiness,
review/synthesis, publication proof and cleanup retain interval
events. These intervals can overlap and are never added into a wall-clock total.
The dispatch interval includes any transport queueing the adapter cannot separate;
it is not claimed to be precise provider execution time.

All outcome variants retain observed provider measurements. Missing counters
remain unknown and zero stays zero. A host abort records interruption before a
transport has finished draining, while a later observation can still persist its
partial spend. Duplicate completion and host reconstruction reuse absolute
receipts under the original step identity. A partial recovery cannot erase known
fields. Two monotonic cumulative updates in the same millisecond are accepted
without fabricating later timestamps; an identical duplicate is inert and a
regression is refused. Accounting does not authorize result reuse: the substrate's existing
reservation and validation protocol remains responsible for that decision.
Invalid telemetry records an accounting refusal without changing the result.
An unavailable diagnostic sink emits a warning and cannot veto work or cleanup.

Original requests are journaled outside worker writable roots before dispatch.
Host reconstruction reads already observed provider metadata through the
observation-only adapter hook before the pending-step state machine runs. It
never dispatches or converts pending work into approval. Native Claude observers
retain the original exact request and session transcript binding; loss of the
currently adopted session does not redirect accounting to a different session.
Mismatched request journals and symlinks are refused with valid nonzero controls.

Verification:

- `open/__tests__/project-build-e2e.test.ts`: the first full integration suite
  passed 130 cases; seven focused accounting cases cover the final native hook.
  New cases exercise a
  complete unknown-metadata run, actual Codex transport measurements with valid
  and mismatched result identities, explicit zero versus partial failed work,
  and reconstructed host recovery with one child dispatch and unchanged totals.
  The actual gateway pending-recovery case ingests native transcript spend after
  the live session is removed, refuses altered/symlinked bindings, and keeps the
  pending result unknown with no new dispatch. Native successful work yields
  nonzero usage for all five role/seat calls through the actual Open binding.
- `trident/attempt-accounting.test.ts`: 14 passed against migrated SQLite,
  including all outcome kinds, missing/zero/nonzero controls, ownership mismatch,
  duplicate/restart recovery, telemetry refusal and abort with late measurements.
  The existing `trident/phase-usage.test.ts` and `trident/attempt-ledger.test.ts`
  projection/storage tests also pass.
- Driver, generic/project host, project review source, accounting and phase
  storage: 355 passed.
  Worker adapters and wiring checks passed; the localhost REPL reuse test needed
  execution outside the socket-restricted sandbox and then passed.
- Both `tsc -p tsconfig.json --noEmit` and
  `tsc -p trident/tsconfig.json --noEmit` passed.
- Semantic mutations in `attempt-accounting.ts` each went red: discard failure
  observations; turn measured zero into null; add a replayed receipt to prior
  spend; omit the resolved-model identity guard; veto missing telemetry; let a
  diagnostic sink veto work; omit reconciliation ownership; omit the native
  request binding check; discard increasing same-millisecond observations. Restored
  tests pass, including the valid ownership and absent-metadata controls.

Leak verification of the accounting tree and its exact dependency base found
the same 455 inherited findings with matching normalized finding sets. Both
changed-file exports contain the same three inherited source findings; the
known license was included as a positive file control. Commit/PR text scans
were silent. This is not reported as a globally silent tree. No denylist or
scanning rule was relaxed.

This change wires observations that the adapters provide; it does not invent
missing metadata or historical spend. Live deployment measurement
and the remaining efficiency criteria are still required before closing #1196.
