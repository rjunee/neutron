## 2026-09-18 — Give focused build wiring fixtures completed-worker provenance

The broader suite exposed nine focused wiring failures after the retry artifact
reader gained original-worker and host-completion checks. Positive fixtures
wrote only `{result:{head,payload}}`, so they no longer reached the publication,
mutation, or suite behavior they intended to exercise. The production reader
was correctly refusing those files (`open/wiring/project-build.ts:409`).

This change edits tests only. `open/__tests__/project-build-wiring.test.ts:39`
now records reservation/completion through the real production mode writer and
writes the complete worker envelope. Existing wrong-head, invalid payload,
commit mismatch, suite timeout, transcript and credential-boundary assertions
remain. The fix-result fixture also advances its head instead of presenting a
same-head fix as a completed driver transition.

The added consumer control in `open/__tests__/project-build-wiring.test.ts:172`
refuses eleven independently falsified provenance conditions through all three
readers: missing host completion; wrong run, step, or artifact head; missing
envelope identity; wrong envelope kind or schema; a wrong reservation phase;
and completion states that retain a pending worker, name the wrong role-specific
stage, or record the wrong head. Invalid provenance invokes no suite process.
Restoring the exact valid completed-worker envelope and reservation/completion
transition after every negative makes publication, mutation selection and suite
execution succeed, providing positive controls against an unwired or
always-refusing fixture. The fix-specific control at
`open/__tests__/project-build-wiring.test.ts:221` independently proves that a
fix artifact requires `fixed`, refuses `built` without running the suite, and is
accepted by all three consumers after the valid transition is restored.

Verification passed all 32 tests (270 assertions) in
`open/__tests__/project-build-wiring.test.ts` and all 61 tests (620 assertions)
in `open/__tests__/project-build-e2e.test.ts`. Root and Trident TypeScript
project checks and changed-file ESLint also passed. No full suite was rerun for
this test-only follow-up; no production guard, acceptance requirement, deployed
state or saved live artifact changed.

The preceding integrated retry batch passed `bash scripts/run-tests.sh`:
all 1,595 discovered files executed across 17 bounded-memory lanes, with
23,434 passing tests, 23 skips, zero failures and 99,378 assertions. The skipped
checks are not counted as live-provider or served-instance verification.
