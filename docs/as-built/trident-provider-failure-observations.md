## 2026-09-23 — Retain provider observations independently of worker success

This implements the provider-collection slice of #1196, governed by
`docs/spec-items/trident-build-efficiency.md:100-115`. It does not complete the
attempt ledger, continuity, concurrent review, or deployed efficiency criteria.

`BoundedWorkOutcome` accepts optional provider observations on every outcome.
The observation records host times, transport provenance, reported model and
thread when available, and nullable disjoint token/cache/cost measurements.
Existing completed-outcome fields remain compatible. Codex total input includes
cache reads, so normalized uncached input subtracts that subset. Claude's native
categories are already disjoint. Missing counters remain unknown, explicit zero
remains zero, and no price is inferred.

Claude headless and Codex review now preserve stdout observations after nonzero
exit, timeout, blocked results, and invalid result trailers. A separate
host-owned observation receipt lets restart recover measurements without
promoting a failed dispatch to a completed result or replaying it. Malformed
observation receipts are ignored as unknown telemetry. Worker-authored result
fields cannot supply usage. Missing provider usage no longer vetoes an otherwise
valid Codex review. Result identity, permissions, model checks and durable
completion receipts retain their existing authority.

Verification includes process fixtures for successful and failed nonzero spend,
explicit zero, missing usage, timeout after observed usage, corrupt trailers,
duplicate completion, worker-authored usage rejection, and restart without
another process. Both TypeScript projects passed. The consuming
`open/__tests__/project-build-e2e.test.ts` passed all 125 tests with local test
sockets permitted; the sandboxed attempt failed nine socket-listening fixtures.

Four semantic mutations were detected: counting cached input twice, rejecting
explicit zero, dropping telemetry on nonzero exit, and treating missing usage
as a result veto. Each failed its behavioral assertion; restored code passed.
An initial malformed mutation trial was excluded from this evidence.

The full-tree local leak scan is baseline-red with the configured denylist;
publication requires comparison with the same base export and a clean changed
surface/message scan. This record claims no live token saving or cutover proof.
