## 2026-09-19 — Observe consumed Claude dispatches through compaction

Issue #1180 corrects a launch-observation failure within the existing project
REPL design (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:97`). A nested
review request reached its parent conversation, but automatic compaction delayed
the Agent call beyond the launch probe. The host ended observation while the
parent still owned the queued request; the child started after the run failed.

The acting-turn adapter now recognizes the exact terminal paste envelope in
addition to the raw submitted text. Both envelope ids and the entire payload
must match; embedded quotations, changed payloads and mismatched ids are not
consumption evidence (`runtime/workers/claude-acting-turn.ts:78`). The existing
post-submission transcript boundary still excludes historical, replaced and
truncated transcripts (`runtime/workers/claude-acting-turn.ts:87`).

Consumption extends observation to the request's original wall deadline, while
retaining the turn lock and original trailer identity. It does not resubmit the
request, claim worker creation, restart the budget or manufacture completion
(`runtime/workers/claude-acting-turn.ts:223`). Unconsumed or unreadable dispatches
retain the launch-probe UNKNOWN outcome. Cancellation and wall expiry still
return UNKNOWN; only the existing result decoder can accept a completed result.

The regression drives the real project runner, acting turn and result decoder.
Its valid raw and pasted submissions complete after a simulated two-minute
compaction delay. Its opposite controls reject changed envelopes and payloads,
cancel the wait, exhaust its wall budget, or supply a different step's trailer
(`runtime/workers/claude-acting-turn.test.ts:517`). Existing transcript-boundary
and stalled-I/O tests remain in the same suite.

Validation: the five runtime/runner/review suites passed 169 tests, and the
explicit consuming `open/__tests__/project-build-e2e.test.ts` passed 103 tests.
The latter needed local Unix socket access; its first sandboxed execution failed
nine cases at socket creation. Root and Trident `tsc --noEmit` both exited zero.
Semantic mutations were reverted after measurement: accepting a substring in
place of the exact paste envelope failed three controls; rejecting every paste
envelope failed five cases; reinstating the launch cutoff for consumed requests
failed six cases. Each mutation ran all nine new consuming scenarios, including
the complementary cases that remained green.

This change does not recover a terminal run or deploy a new service. A fresh
live acceptance result remains separate evidence from the local regression.
