## 2026-09-29 — Prepare bounded continuation of the original Claude child

This is a **NO-SHIP prototype pending a real native-tool capability witness**.
The normative item is `docs/spec-items/claude-same-agent-continuation.md`; #1416
remains open. The existing adapter has no production native catalog probe, so
actual sessions report UNKNOWN. An isolated fake catalog proves the consuming
code path, not served capability or account consumption.

`runtime/workers/claude-native-continuation.ts` validates the original armed
request and signed child receipt against host admission, harvests the original
result first, and binds a typed quota event to a one-use continuation claim.
Migration 0166 stores that claim through `gateway/project-admission-store.ts`
before parent input. The claim survives restart and has no refund. Reconciliation
recognizes only the exact post-boundary native tool invocation; it never sends a
second continuation. `open/wiring/project-build.ts` wires hot observation and
recovery through this path without re-entering initial `Agent` dispatch.

The future canonical project tool profile grants `SendMessage`. Eligibility also
requires a measured current native catalog; an argv grant alone cannot permit
continuation, and a catalog cannot override a launch lacking that grant. The
session queue allows only the original admitted child's continuation past its
own unresolved slot. Its original busy ownership remains until the normal result
validator releases it. No credential files, live leases or live parent input were
changed during development.

The consuming fixture reaches merge after one same-ID continuation. Paired
unavailable/foreign catalog and lost-acknowledgement cases preserve child ownership
and refuse merge. Runtime/admission controls cover durable cross-connection claims,
exact invocation reconciliation, completed/invalid result precedence, deadlines,
ordinary errors and request identity. Existing Claude dispatch and tool-profile
regressions passed (196 tests); focused quota/workspace/admission/migration/index
checks passed (105 tests at their recorded development revision).

The development full consuming run passed 519 tests. Subsequent hardening of the
new continuation path requires final committed-source verification; that earlier
run is not an exact-head receipt for the final candidate. Semantic mutations of
the catalog guard both failed the consuming checks as required: allow-all merged
the unavailable-tool fixture, while deny-all blocked the successful continuation.
The guard was restored afterward. Both root and Trident typechecks passed during
development. Final committed-source receipts accompany the candidate handoff.
The served catalog/fixed-profile witness and real quota-account continuation
controls remain unperformed. A file swap, 401 recovery, selector receipt or
synthetic provider response is not proof of 429 account consumption.

This candidate stacks on the handler-drain change that adds migration 0165.

Independent review found two queue deadlocks and a reconciliation gap. Recovery
now compares measured workspace authority rather than proof-object allocation.
The parent queue retains normal FIFO but lets an eligible continuation pass a
head waiting for background completion, without overlapping active parent input.
The consuming fixture exercises ordinary input queued before the quota child
binds and yields. Same-attempt conflicting recipient input refuses reconciliation;
a SHA-256 prefix boundary detects changed same-inode transcript history.
Runtime positive/negative controls cover restored parent generations, reconstructed
proofs, unrelated child waits, exact-only invocation and truncate/regrow history.
Allow/deny queue and invocation mutants, plus the prefix-check bypass mutant, fail
their respective behavioral assertions; all mutations were restored.
