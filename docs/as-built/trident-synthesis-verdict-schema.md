## 2026-09-19 — Give review workers the enforced verdict schema

A live Work Board dispatch built and published a green PR, then stopped at review synthesis. The synthesis worker wrote a completed `APPROVE` result with an extra `synthesis` string; the host's closed verdict schema rejected `$.synthesis`, so the run correctly failed rather than treating that result as approval. This was a brief/contract mismatch, not a reason to weaken the review gate.

The review source now supplies the same authoritative verdict schema used by the host validator to every review and synthesis seat, and instructs workers to keep the result and nested objects inside it. The validator, malformed-result refusal, and G060 infrastructure block remain unchanged.

Focused source tests verify the schema in every seat brief, the exact extra-field rejection, the valid-result complement, and the G060 checkpoint. The consuming project-build end-to-end test verifies that a schema-guided synthesis can take a PR to `MERGED` unattended, while an extra-field synthesis still blocks and leaves the PR open. These tests establish local behavior; a fresh dispatch through the deployed service is still required to verify the live unattended merge.
