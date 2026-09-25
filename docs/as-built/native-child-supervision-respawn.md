## 2026-09-25 — Supervision preserves unresolved native children

Watchdog and forced admin respawns reached `executeRespawn` without consulting
durable native-child ownership. A valid registry and an available respawn gate
could therefore authorize killing and evicting the parent while its child lease
remained unresolved. Registry identity established ownership, not child idleness.

`respawnReplSession` now reads the existing native-child authority under the
registry lock, after durable scope validation but before any in-flight stamp or
cap write, and again immediately before consuming the respawn plan. Unknown
liveness refuses both watchdog and forced admin requests. The latter retains its
documented cooldown/cap override but does not override child safety. A refusal at
the second check clears the in-flight claim and leaves the child and pool intact.

The dedicated consuming tests use a migrated ProjectAdmission database, real
registry/plan/respawn execution, and a mocked final provider spawn. Both force
modes retain parent, pool and lease while unresolved; a database read failure is
also refused. Exact completion permits a real acknowledged kill and reaches the
mocked resume boundary. Another project's unresolved child does not block it.
The tests also cover child ownership discovered after the registry claim.

The initial supervision slice passed 69 focused tests, and five consuming Open build
E2Es pass. Root and Trident typechecks pass. Removing both child checks produces
six failing tests; refusing all respawns also produces six failures, including
the legitimate completion and unrelated-project controls. That slice did not run
the full canonical suite, a live provider restart proof, or deployed validation.
The integrated host suite subsequently passed before the scope-order correction
below; the fresh full run on the corrected head is recorded below.

The integrated CI shard exposed an ordering defect: the initial child check ran
before durable scope validation, so an installed census could mask a scope
refusal. Open composition registers the process-wide owner census
(`open/composer.ts:1214`); a composition fixture closes that database
(`open/__tests__/usage-dashboard-base-url-wiring.test.ts:141`). A later ambiguous
scope or failed database read is conservatively unresolved
(`runtime/adapters/claude-code/persistent/native-child-liveness.ts:22`). The
earlier green host result did not establish coverage with an installed census;
different process groupings can avoid exposing this shared-state dependency.

The corrected ordering keeps both scope and child refusal on `skipSave: true`
before registry mutations (`supervision.ts:271`, `:277`). The child census is a
synchronous SQLite read with no registry lock re-entry
(`gateway/project-admission-store.ts:180`); its duration scales with durable lease
rows. The consuming recheck remains in place (`supervision.ts:354`). The scope
fixture owns and removes its census registration, explicitly tests absent, idle,
busy and unreadable authorities, and requires zero census reads on invalid scope
while preserving an existing cap even under force (`supervision-scope.test.ts:74`).

The ordering regression fails 12 cases against the previous implementation.
Removing both child checks fails six of eight consuming child tests; refusing
every child check fails six, including completed-child and unrelated-project
controls. Restoring the implementation passes all 44 scope/child/claim tests.
With local listener access, the combined suite including REPL supervision passes
81 tests. Seven real Open native-child/project-admission E2Es pass, and root and
Trident typechecks pass. The CI predecessor composition fixture followed by the
scope suite passes 32 tests in one process. Sandboxed listener tests failed due
to unavailable local sockets; the full consuming file was stopped after that
failure and only the seven relevant cases were retried. The corrected code head
`d7e06df58a904ddac9cd53fca2230db262c4dcca` then passed
`bash scripts/check-shared-host.sh` with local listener access: 51 TypeScript
projects, all 1,685 declared/discovered/assigned/executed files across 18 lanes,
zero failed lanes. The same command in a listener-denied sandbox was stopped
after unrelated socket tests failed; it is not counted as a code failure or
successful gate. Fresh final-head CI remains required before merge.
