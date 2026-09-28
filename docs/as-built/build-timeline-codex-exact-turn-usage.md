## 2026-09-28 — Native Codex per-turn token receipts in the build timeline

The Codex rollout importer previously emitted an attested completed turn with
unknown usage even when its native rollout contained `turn_token_usage`. It now
accepts that receipt only when native session and turn identities match an
explicit phase/PR binding and a completed task envelope. Conflicting or malformed
matching receipts leave usage unknown; foreign and unbound receipts never charge
a phase. Nested command spans still have unknown tokens.

Native input includes cached input. The importer subtracts cache reads from the
input field and reports cache reads separately, preserving the dashboard's
disjoint-token sum. Cache creation and cost remain unknown, so coverage is
partial even with all three native counters. A bounded tail can miss a receipt;
full scans are needed to recover historical token coverage before immutable
observations are recorded.

Verification: `bun test scripts/build-timeline-codex-import.test.ts` exercises
positive, zero, missing, foreign, malformed, conflicting, duplicate, unbound and
missing-completion controls. Root and Trident TypeScript checks pass. The local
full-tree leak gate reports 451 existing denylist matches on both this branch and
the unchanged base revision; this change adds no gate findings.
