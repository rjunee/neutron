## 2026-09-28 — Native Codex per-turn token receipts in the build timeline

The Codex rollout importer previously emitted an attested completed turn with
unknown usage even when its native rollout contained `turn_token_usage`. It now
accepts that receipt only when native session and turn identities match an
explicit phase/PR binding and a completed task envelope. Real native rollouts
carry cumulative snapshots during a turn, so the importer uses the last
monotonic snapshot for that exact turn. Malformed or regressing matching receipts
leave usage unknown; foreign and unbound receipts never charge a phase. Nested
command spans still have unknown tokens.

Native input includes cached input. The importer subtracts cache reads from the
input field and reports cache reads separately, preserving the dashboard's
disjoint-token sum. Cache creation and cost remain unknown, so coverage is
partial even with all three native counters. A bounded tail can miss a receipt;
the importer defers its turn observation when the partial window has no usage,
so an append-only journal does not freeze unknown tokens before a later or full
scan can recover them.

A read-only structural probe of native rollouts confirmed the exact
`token_usage_record.turn_token_usage` shape with matching session and turn IDs,
and a completed real turn produced non-null token fields through the importer.
The older `event_msg` / `token_count` form was present as a separate control and
is not used for this attribution.

Verification: `bun test scripts/build-timeline-codex-import.test.ts` exercises
positive, zero, missing, foreign, malformed, regressing, progressive, duplicate,
unbound, missing-completion and bounded-tail race controls. Root and Trident
TypeScript checks pass. The local
full-tree leak gate reports 451 existing denylist matches on both this branch and
the unchanged base revision; this change adds no gate findings.
