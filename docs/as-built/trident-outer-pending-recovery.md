## 2026-09-23 — Recover the outer driver's original pending worker

The efficiency specification requires a lost acknowledgement to reconcile its
original pending identity before buying more work
(`docs/spec-items/trident-build-efficiency.md:154`). The outer driver previously
returned unknown for every pending checkpoint, including a completed worker with
an intact result and reservation.

The driver now saves the exact request and continuation context before invoking
the worker (`trident/build-run.ts:509`). Resume validates that request, execution
inputs, round and snapshot (`trident/build-run.ts:350`), then requires the runner's
explicit recovery-only capability (`trident/build-run.ts:496`). It neither
prepares a replacement context nor falls back to ordinary dispatch. Legacy
checkpoints without this evidence remain unknown. Fresh-admission PR ownership
may appear after publication; the measured PR identity still binds recovery.

Review recovery resolves the original standalone worker before consulting the
panel (`trident/build-run.ts:517`). Publication nomination repair cannot discard
an unresolved pending identity (`trident/build-run.ts:717`). Writable planner,
builder and fix completions retain the existing host measurement, trailer and
lineage checks; read-only work cannot inherit a moved revision. Ralph recovery
retains the validated plan remainder and suite scope.

Prior review progress is paired with explicit `reviewBaseline` provenance in both
completion and pending checkpoints (`trident/build-run.ts:97`). `none` requires
null progress; `required` requires a valid progress object. Blocking review and
nomination establish the baseline; approval does not invent one. Missing markers,
invalid pairs and disagreement between checkpoint copies remain unknown. Fixes,
spent re-plans and fixed/rejected stages independently require a baseline. The
writer checks the same provenance before preparing work. Round numbers are not
history: a real pre-review built checkpoint at round one with a moved head can
legitimately plan again with no baseline, including recovery of that planner's
lost acknowledgement (`trident/build-run.test.ts:1206`). Conversely an absent-head
round-zero rebuild can retain prior history. JSON-roundtrip controls cover pending
re-plans, post-fix/post-re-plan reviews, completion checkpoints and moved heads.

Verification: `bun test trident/build-run.test.ts` passes 298 tests, including
actual Codex adapter recovery across all four phases with retained, missing,
unarmed and foreign reservations (`trident/build-run.test.ts:951`). The negative
cases retain the pending checkpoint and leave reservation/result bytes unchanged
without another provider or panel turn. Both root and Trident TypeScript checks
pass. Semantic mutations replacing recovery with ordinary dispatch fail all four
missing-reservation controls; refusing valid recovery fails all four completion
controls. Removing input freshness or the nomination pending guard also fails
its regression. Allowing missing/null fix progress reproduces the unintended
merge. Weakening the explicit baseline validator fails seven missing-history or
missing-provenance controls, including unintended merges. Restoring round-based
inference fails both generated pre-review moved-head positive controls. Refusing
known-absent progress also kills valid initial plan/build/review recovery.
Restoring the implementation restores all 298 passing tests.

This record covers the outer driver and its focused tests. Consuming project-host
integration, complete Open E2E verification, deployment and live acceptance belong
to the integration change; they are not claimed by this slice.
