## 2026-09-24 — Repair a malformed in-REPL review seat once

A live rubric reviewer atomically published a completed REQUEST_CHANGES envelope
but omitted a required finding `rule`. The host rejected `$.findings[2].rule` as
`missing-field`; the review source hid that distinction behind its generic
dispatch/observation exception. A completed envelope was not a usable verdict.
The counterexample now lives in synthetic fixtures, without private run data.

`runtime/workers/project-runners.ts:78` retains host-tagged invalid payload
evidence only after run, step, schema and completed-envelope checks.
`trident/project-review-source.ts:319` revalidates that evidence for fresh review
seats and settles it as deferred. The existing single deferred retry carries the
original invalid result and exact host validation path to the same configured
seat. The worker must substantiate the missing field or report blocked; the host
does not fabricate values or relax the schema. A repaired major finding still
enters the fix loop. A second invalid payload becomes an infrastructure block.

Attempt-zero directory identity and request bytes stay unchanged. The retry's
immutable request hash binds its augmented brief; reconstruction derives the
same feedback from the original settled receipt and verifies its rejection
again (`trident/project-review-source.ts:127`). Unknown pending work still uses
evidence-only recovery. No new attempt is purchased for an unobserved worker,
late file, rate limit, or already usable verdict. Existing malformed pending
receipts are not migrated into deferred results by recovery. Synthesis and the
separate headless decoders retain their previous refusal behavior. This slice
addresses the in-REPL decoder path that produced the incident.

G057 and G060 continue to block unusable seats/synthesis. G059 retains one retry,
and only for deferred work. G063 suite receipts are unaffected.

Verification: the decoder/review-source suites and semantic mutation suite pass;
mutants disabling repair, treating invalid payloads as completed, repairing an
uncertain pending result, and removing repair feedback are each killed by named
behavioral tests. Durable tests cover one repair, exhaustion across restart,
exact pending-retry recovery without a third purchase, and corrupted feedback
refusal. The consuming `open/__tests__/project-build-e2e.test.ts` repairs a missing
`rule`, enters the fix loop, and merges its local fake PR; its exhausted control
leaves that PR open with no synthesis or fix. Existing synthesis-malformed,
unavailable-seat and provider-rate-limit controls pass. Root, runtime, trident
and open TypeScript checks pass. The repository-wide suite was not run in this
worktree while another change owned that check.
