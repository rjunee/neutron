## 2026-09-19 — Observe the first real Codex turn before its rollout materializes

The observer previously opened the rollout before submitting owner input, so a
native thread whose exact rollout path existed only in its binding could not
receive its first turn. The locked project conversation contract remains
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:87`.

`runtime/adapters/codex-cli/persistent/rollout-observer.ts:64` now preserves an
absent exact path until native delivery is acknowledged. Deferred observation
requires the host's binding revision and exact native session metadata, then
checks a receipt containing the same thread, path, revision and native turn.
Only missing files defer; metadata mismatches, replaced files, unrelated turns
and unknown lifecycle events still refuse. Existing materialized TUI attachment
retains its baseline validation. The host owns native identity attestation;
this reader does not discover a path from cwd or recency.

`runtime/adapters/codex-cli/persistent/conversational-substrate.ts:71` accepts
multiline chat and compares the exact prompt against the native user-message
record. Receipt binding happens at line 102 before observation. Missing receipt
on deferred delivery reports unknown delivery and releases the lease refused;
the existing deadline bounds materialization and completion waits.

Verification: the first multiline turn regression failed before the fix and
the dedicated rollout suite passes 44 tests. Removing expected-turn comparison
made the wrong-receipt-turn test fail; rejecting all deferred opens made the
first-turn success test fail. Both mutations were reverted. Root and Trident
TypeScript checks pass after a frozen dependency install in the isolated
worktree. The whole-tree leak scan reports existing baseline/denylist findings
and the worktree gitdir pointer, so it is not a clean publication result.
This seam does not
claim production host attestation, bootstrap composition, publication admission
or a completed build; those boundaries are outside this change.
