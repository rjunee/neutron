## 2026-09-23 — Refuse an exhausted clean continuation before planning

Issues #1216 and #1219; the normative budget and recovery contracts remain in
`docs/spec-items/planner-selected-execution-strategy.md` and
`docs/spec-items/same-run-task-sequence-crash-handoff.md`.

A clean `task-built` continuation checked its durable allowance only after the
next planner finished. The consuming production-host regression reproduced a
planner dispatch at spend one, cap one, even though plan persistence subsequently
refused the exhausted budget. Its cap-two sibling completed the second task and
merged. The fixture first interrupted a real ledger commit and reconstructed the
host to settle it, so this also exercises the boundary between permitted recovery
and new worker dispatch.

The existing preflight now checks the accepted task-sequence plan's durable
budget before every new planning continuation, including clean handoffs. It
retains the accepted strategy and plan, and uses the existing store transaction
to reconcile run and linked-card spend. A completed intermediate checkpoint can
still settle its ledger at the cap; reconciling an existing worker reservation
and resuming terminal review also retain their existing paths. Repeating the
exhausted clean resume dispatches no worker. The outer orchestrator's refire
accounting is unchanged.

Verification: the cap-one consuming regression failed on the pre-fix driver
because it observed a real planner dispatch; the cap-two control passed. Both
pass with the fix. The focused driver, production effects and mutation suites
passed 492 tests. Three semantic mutations remove the preflight, apply it to
worker-free settlement, and refuse all continuations; each fails its named
behavioral regression, while the unmodified controls pass.
The complete consuming `open/__tests__/project-build-e2e.test.ts` suite passed
262 tests with 3,047 assertions. Both root and Trident TypeScript checks,
touched-file lint, and diff whitespace checks passed.

These are local regression results; they do not establish deployment or live
unattended merge acceptance.
