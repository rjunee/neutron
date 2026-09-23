## 2026-09-23 — Recover the outer driver's original pending worker

The efficiency specification requires a lost acknowledgement to reconcile its
original pending identity before buying more work
(`docs/spec-items/trident-build-efficiency.md:154`). The outer driver previously
returned unknown for every pending checkpoint, including a completed worker with
an intact result and reservation.

The driver now saves the exact request and continuation context before invoking
the worker (`trident/build-run.ts:482`). Resume validates that request, execution
inputs, round and snapshot (`trident/build-run.ts:333`), then requires the runner's
explicit recovery-only capability (`trident/build-run.ts:469`). It neither
prepares a replacement context nor falls back to ordinary dispatch. Legacy
checkpoints without this evidence remain unknown. Fresh-admission PR ownership
may appear after publication; the measured PR identity still binds recovery.

Review recovery resolves the original standalone worker before consulting the
panel (`trident/build-run.ts:490`). Publication nomination repair cannot discard
an unresolved pending identity (`trident/build-run.ts:690`). Writable planner,
builder and fix completions retain the existing host measurement, trailer and
lineage checks; read-only work cannot inherit a moved revision. Ralph recovery
retains the validated plan remainder and suite scope.

Prior review progress is an explicit object or null in every recovery checkpoint;
missing evidence is refused. A pending fix requires a non-null valid object
because it follows a review. Losing this field previously erased the repeated
finding baseline and allowed another fix and merge. JSON-roundtrip controls now
refuse missing, null and malformed fix progress before recovery, while intact
progress still stops the repeated finding (`trident/build-run.test.ts:1053`).

Verification: `bun test trident/build-run.test.ts` passes 251 tests, including
actual Codex adapter recovery across all four phases with retained, missing,
unarmed and foreign reservations (`trident/build-run.test.ts:950`). The negative
cases retain the pending checkpoint and leave reservation/result bytes unchanged
without another provider or panel turn. Both root and Trident TypeScript checks
pass. Semantic mutations replacing recovery with ordinary dispatch fail all four
missing-reservation controls; refusing valid recovery fails all four completion
controls. Removing input freshness or the nomination pending guard also fails
its regression. Allowing missing/null fix progress reproduces the unintended
merge; refusing known-absent progress also kills valid plan/build/review recovery.
Restoring the implementation restores all 251 passing tests.

This record covers the outer driver and its focused tests. Consuming project-host
integration, complete Open E2E verification, deployment and live acceptance belong
to the integration change; they are not claimed by this slice.
