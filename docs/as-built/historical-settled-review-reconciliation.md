## 2026-09-28 — Reconcile historical settled review reservations on retry

Related: #1358; normative criteria:
[`a-retry-must-resume-from-the-checkpoint`](../spec-items/a-retry-must-resume-from-the-checkpoint.md).

The producer-side settled-rate-limit repair did not change terminal checkpoints
written before that repair. Those checkpoints retained a pending review even
when the original standalone review and every admitted panel seat had already
settled. Cross-run retry consequently discarded a completed build.

`trident/settled-review-recovery.ts` now proves this narrow historical state at
the existing retry-source boundary. It binds the original standalone request,
armed reservation, brief, context and completed result to the checkpoint. The
durable attempt ledger independently enumerates admitted review work, so deleting
a seat directory cannot turn an incomplete panel into complete evidence. Every
current-round seat must have a matching immutable request, journal and settled
receipt; at least one must be rate-limited. Foreign scope, missing evidence,
unsettled work, deferred repair and invalid verdicts retain the refusal.

The proof uses bounded regular-file reads without following result symlinks and
checks the evidence inventory and ledger for concurrent changes. It removes
pending only from the parsed import view; the terminal source event and files
remain untouched. Launch-time source reads repeat the proof. Only completed
built/fixed state and existing bounded budgets transfer: the new run must buy its
own review panel, and required-seat vetoes and publication gates still apply.
Historical settings are not guessed from current configuration; this proves all
admitted work settled, not that old approvals satisfy the new run's panel.

Measured against the actual consumer in `open/__tests__/project-build-e2e.test.ts`:
four final cases passed (75 assertions), covering current producer settlement,
historical built and post-fix checkpoints, and malformed/incomplete/foreign
evidence. The historical paths reuse the published head with no new plan/build/
fix dispatch, preserve budgets, and obtain fresh review before merging the test
PR. Corruption after dispatch is refused by launch-time revalidation. Removing
the receipt-head binding kills the negative test; reversing settlement admission
kills the valid historical retry test. Both semantic mutants were restored and
the four-case consumer run passed again. The earlier broader retry/checkpoint
selection passed 104 tests. Root and Trident TypeScript checks both passed on the
restored implementation.

A read-only probe against the original failed run admitted its exact published
head while confirming the source event still retained pending review byte for
byte. This is source-admission evidence, not a live retry or deployment claim.
No live records, credentials or pull requests were changed. Full shared-host and
CI results belong to the frozen commit's external check receipts. Unsupported
standalone placements and current-round repair attempts remain fail-closed.
