## 2026-09-23 — Concurrent bound Claude child observation

Implements the native Claude consumer slice of issue #1196, governed by
`docs/spec-items/trident-build-efficiency.md:117-138` and the native placement
rule in `docs/plans/harness-orchestrator-pivot-2026-09-11.md:94-111`.

The consumer previously retained the parent session's exclusive turn slot until
the background child wrote its result. Concurrent review dispatch requests
therefore still executed serially. `ReplSession.acquireTurn` now offers a
dispatch-slot yield while retaining the existing busy lease until final release.
Ordinary turns still release the queue and busy lease together. Model control
and revocation continue to see accepted, observed background work as busy.

`runtime/workers/claude-acting-turn.ts` yields only after finding one metadata
candidate whose child transcript binds the provider session, child identity and
complete request. Description-only metadata and parent consumption do not meet
that boundary. Writable requests and edit-capable tool grants retain exclusive
observation. Child results retain their existing run/step/schema validation;
provider quota blocks and uncertain dispatches retain their existing outcomes
and durable no-replay reservations.

Verification: 163 focused worker tests, 125 tests in
`open/__tests__/project-build-e2e.test.ts`, 37 session revocation/model-control
tests, and both `tsc --noEmit -p tsconfig.json` and
`tsc --noEmit -p trident/tsconfig.json` passed. The new barrier uses the real
session mutex, keeps two read-only children live before producing either result,
asserts at most one parent submission, and retains both busy leases. Paired
controls cover wrong identities, missing/partial evidence, ambiguous children,
write grants, cancellation, quota rejection and lost acknowledgement.

Five semantic mutations were run and restored: accepting metadata without child
binding failed eight negative controls; dropping the writable guard failed its
negative control; suppressing queue yield failed the legitimate-child control;
removing the queue await admitted two simultaneous submissions and failed the
barrier; dropping the busy count at yield failed the lifetime test. These fail
on observed behavior rather than parse errors.

This slice does not claim end-to-end concurrent panel scheduling, measured token
savings, deployment, or cutover acceptance. Those remain tracked by #1196.
