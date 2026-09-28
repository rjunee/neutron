## 2026-09-28 — Reconcile validated late native results after observation ends

A submitted native task can finish after its workflow's observation deadline.
The live runner released child ownership only when its own run or recovery call
returned a validated result. The autonomous reconciler accepted signed
pre-submission refusals, leaving a terminal workflow's later result unconsumed.

The existing startup and periodic reconciler now also authenticates a submitted
request against its original lease and canonical attempt, checks its exact armed
reservation and canonical role result path, and uses the same trailer decoder as
live project-build execution. Only completed or blocked validated results release
the exact stored token and generation. A matching pooled workspace authority is
then completed. The workflow remains failed and its unknown attempt remains
unknown; no native actor is constructed or redispatched. This follows the existing
validated-result completion contract; it does not require the persistent parent
REPL to exit.

The focused receipt and Open-composition suites passed 41 tests. They cover late
results present at startup and arriving on a later autonomous tick, completed and
blocked results, idempotence, sibling scope/token retention, generation mismatch,
forged receipts, missing/unarmed reservations, foreign step/schema, invalid
payload, malformed JSON, symlink and FIFO results. Bypassing result validation
made three negative cases fail; refusing every late result made four positive
cases fail, including actual Open startup and periodic recovery. Both mutations
were restored. The consuming project-build E2E suite was also started; its final
result is recorded separately in the PR validation evidence.
