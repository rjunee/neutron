## 2026-09-19 — Observe a Claude child's provider rate limit without waiting for a verdict file

A live synthesis child stopped with Claude's structured API-error record and no
result file. The acting turn observed its metadata but waited for the entire
worker budget. Separately, the review source discarded unavailable synthesis
reasons, leaving the panel to report a provenance mismatch.

The host now reads bounded first/last windows of the single matching child
transcript (`runtime/workers/claude-child-rate-limit.ts:9`). Both envelopes must
name the bound session and child; the initial user record must contain the exact
full request. The last complete record must carry the provider's synthetic
assistant marker, API-error flag, rate-limit error, HTTP 429, rejected quota and
request ID. Assistant prose does not classify a quota failure. Missing,
ambiguous, partial, oversized or unrecognized evidence remains uncertain.

The acting turn returns a block on this observation
(`runtime/workers/claude-acting-turn.ts:229`), and the project runner preserves it
without releasing the durable step reservation
(`runtime/workers/project-runners.ts:157`). Success still requires the validated
result file. A replacement runner does not replay the child. A review block is
unavailable, so G059 does not immediately retry it. Synthesis unavailability now
retains its reason (`trident/project-review-source.ts:220`); the panel checks
run, revision and round before reporting that reason as an infrastructure block
(`trident/gates/review-panel.ts:102`). G057–G060 remain fail-closed.

This implements the locked pivot's §3.2 return-to-orchestrator boundary and the
existing review gates, without changing worker placement or accepting a
transcript as a verdict. It recognizes the measured Claude quota envelope;
other error shapes and recovery after host replacement remain unknown.

Verification: 159 focused tests pass across the child classifier, acting turn,
project runners, review source and panel; all 104 consuming Open end-to-end tests
pass with local Unix socket listeners available. The new consuming case
observes the provider envelope through production wiring and requires a named
synthesis block, one dispatch, no result file, no fix and an unmerged PR. Both
root and Trident TypeScript projects pass. Bidirectional mutations fail by
assertion: suppressing quota detection loses the positive observation; accepting
arbitrary error envelopes fails the negative controls; removing full request
equality fails all six mismatched-request controls; dropping the synthesis
reason recreates the misleading provenance answer. All mutations were restored.
