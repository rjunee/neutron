## 2026-09-25 — Supervision preserves unresolved native children

Watchdog and forced admin respawns reached `executeRespawn` without consulting
durable native-child ownership. A valid registry and an available respawn gate
could therefore authorize killing and evicting the parent while its child lease
remained unresolved. Registry identity established ownership, not child idleness.

`respawnReplSession` now reads the existing native-child authority before claiming
the registry and again immediately before consuming the respawn plan. Unknown
liveness refuses both watchdog and forced admin requests. The latter retains its
documented cooldown/cap override but does not override child safety. A refusal at
the second check clears the in-flight claim and leaves the child and pool intact.

The dedicated consuming tests use a migrated ProjectAdmission database, real
registry/plan/respawn execution, and a mocked final provider spawn. Both force
modes retain parent, pool and lease while unresolved; a database read failure is
also refused. Exact completion permits a real acknowledged kill and reaches the
mocked resume boundary. Another project's unresolved child does not block it.
The tests also cover child ownership discovered after the registry claim.

The focused supervision suite passes 69 tests, and five consuming Open build
E2Es pass. Root and Trident typechecks pass. Removing both child checks produces
six failing tests; refusing all respawns also produces six failures, including
the legitimate completion and unrelated-project controls. No full canonical
suite, live provider restart proof, or deployed validation is claimed.
