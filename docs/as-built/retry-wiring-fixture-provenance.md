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

The added consumer control in `open/__tests__/project-build-wiring.test.ts:159`
refuses missing host completion, wrong run, wrong step, wrong head and missing
envelope identity through all three readers. Invalid provenance invokes no suite
process. Restoring the original completed-worker shape makes publication,
mutation selection and suite execution succeed, providing positive controls
against an unwired or always-refusing fixture.

Verification runs both complete `open/__tests__/project-build-wiring.test.ts`
and `open/__tests__/project-build-e2e.test.ts`, both TypeScript project checks,
and changed-file lint. No production guard, acceptance requirement, deployed
state or saved live artifact changed.
