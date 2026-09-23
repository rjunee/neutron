## 2026-09-23 — Durable attempt accounting storage

This is the storage slice of #1196 and
`docs/spec-items/trident-build-efficiency.md`, not completion of the efficiency
item. Existing phase snapshots could not attribute a repeated call or preserve
its identity across host reconstruction. Migration 0156 adds host-owned attempt
identities, lifecycle observations, and cumulative provider receipts. It leaves
historical phase measurements unchanged and invents no historical attempts.

`TridentAttemptLedger` records the run, task, step, attempt, revision, role or
review seat, provider, requested/resolved models, placement and host timestamps.
Provider receipts separately retain reported model, source and observation time.
Replaying an identical identity is inert; changing its ownership is refused.
Later lifecycle evidence can fill a missing timestamp but cannot rewrite an
observed event or terminal outcome. Accounting evidence never authorizes result
reuse.

Receipts are absolute totals for one call. Duplicate/older observations cannot
add spend; distinct failed calls remain separate. A newer observation cannot
erase an earlier measured counter or change its provider receipt identity.
SQLite prevents attributing the same provider receipt to two attempts in a run.
The phase projection is recomputed in the same transaction. A missing operand
keeps that aggregate metric unknown; measured subtotals remain available in the
attempt receipts. Explicit zero remains zero. Historical phase reports without
attempt attribution cannot be silently replaced, and legacy writers cannot
overwrite a phase owned by the ledger.

Verification covers migration preservation, reconstruction, reverse observation
order, distinct failed calls, streaming usage followed by failure, missing versus
zero, identity conflicts, timestamp ordering, provenance and direct SQL invalid
values. Semantic mutation checks removed or over-applied identity and receipt
guards, fabricated zero for unknown metrics, suppressed real zero, and allowed
cumulative regression; each produced a failing assertion, then passed after
restoration. Both TypeScript configurations and the migration/schema ownership
checks are required for this slice.

Production collection, scheduling, host wiring and consuming
`open/__tests__/project-build-e2e.test.ts` coverage remain integration work under
#1196. This storage change alone supplies neither live usage nor an efficiency
improvement claim.
