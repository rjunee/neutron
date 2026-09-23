## 2026-09-23 — Recover the outer driver's original pending worker

The efficiency specification requires a lost acknowledgement to reconcile its
original pending identity before buying more work
(`docs/spec-items/trident-build-efficiency.md:154`). The outer driver previously
returned unknown for every pending checkpoint, including a completed worker with
an intact result and reservation.

The driver now saves the exact request and continuation context before invoking
the worker (`trident/build-run.ts:499`). Resume validates that request, execution
inputs, round and snapshot (`trident/build-run.ts:345`), then requires the runner's
explicit recovery-only capability (`trident/build-run.ts:486`). It neither
prepares a replacement context nor falls back to ordinary dispatch. Legacy
checkpoints without this evidence remain unknown. Fresh-admission PR ownership
may appear after publication; the measured PR identity still binds recovery.

Review recovery resolves the original standalone worker before consulting the
panel (`trident/build-run.ts:507`). Publication nomination repair cannot discard
an unresolved pending identity (`trident/build-run.ts:706`). Writable planner,
builder and fix completions retain the existing host measurement, trailer and
lineage checks; read-only work cannot inherit a moved revision. Ralph recovery
retains the validated plan remainder and suite scope.

Prior review progress is an explicit object or null in every recovery checkpoint;
missing evidence is refused. A non-null valid object is required for every fix,
plan/build rounds above zero, and review rounds above one. The same condition is
enforced before preparing new work. Completed and rejected checkpoints retain the
baseline across interruptions between phases, including publication nomination
repair. Legacy later-round state cannot manufacture an empty baseline. Initial
rounds can legitimately carry prior history when an absent head causes a rebuild,
so a non-null object there is not refused. JSON-roundtrip controls cover pending
re-plans, post-fix/post-re-plan reviews, completion checkpoints and moved heads.

Verification: `bun test trident/build-run.test.ts` passes 274 tests, including
actual Codex adapter recovery across all four phases with retained, missing,
unarmed and foreign reservations (`trident/build-run.test.ts:951`). The negative
cases retain the pending checkpoint and leave reservation/result bytes unchanged
without another provider or panel turn. Both root and Trident TypeScript checks
pass. Semantic mutations replacing recovery with ordinary dispatch fail all four
missing-reservation controls; refusing valid recovery fails all four completion
controls. Removing input freshness or the nomination pending guard also fails
its regression. Allowing missing/null fix progress reproduces the unintended
merge; limiting the rule to fixes misses four later-phase controls. Removing the
writer refusal fails six completion/moved-head controls. Refusing known-absent
progress also kills valid initial plan/build/review recovery. Restoring the
implementation restores all 274 passing tests.

This record covers the outer driver and its focused tests. Consuming project-host
integration, complete Open E2E verification, deployment and live acceptance belong
to the integration change; they are not claimed by this slice.
