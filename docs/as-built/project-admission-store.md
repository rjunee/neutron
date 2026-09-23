## 2026-09-23 — Durable project admission storage

Issue #1237 identified that adopting an old parent profile does not safely activate
bounded native workers. This slice supplies durable admission mechanics only.
It does not connect production producers, retire panes, replace parents, or
authorize deployment or activation of #1233. Project sleep and the rollout issue
remain incomplete until all producers and authoritative native-child census and
quiescence participate.

`gateway/project-admission-store.ts` stores explicit owner/project scopes,
generation-bound activity leases, and maintenance ownership. General uses a null
project identity distinct from any named project. Admission and fence acquisition
obtain SQLite's writer lock before checking eligibility. Existing admissions must
release their exact tokens before maintenance stages can advance. Generation,
token, and expected-phase comparisons refuse stale transitions. Registration is
idempotent and cannot clear an existing fence. Restart does not expire activity
or reopen admission. The stage names record caller assertions: zero participating
leases is not an authoritative native-child idle proof, and callers must verify
actual replacement identity and profile before reopening.

Migration 0158 adds the fence and lease tables; the schema snapshot and writer
ownership map include both. Tests use two connections to one on-disk database,
including an overlapping writer transaction, and reopen connections at every
maintenance stage. They cover unknown scopes, foreign and stale tokens, retained
leases, successful drain/reopen, and General/owner isolation.

Validation: 32 tests and 164 assertions across the store, migration snapshot,
and writer-conformance suites passed. Root and Trident TypeScript checks passed.
A mutation accepting stale generation/token comparisons failed one test; a
mutation refusing every valid reopen failed two. Restored store tests passed
(7 tests, 44 assertions).

Integration obligations established during investigation: chat admission must
precede the queue in `gateway/wiring/build-live-agent-turn.ts`; Work Board must
retain fenced holds instead of deleting them as permanent refusals in
`trident/dispatch-holds.ts`; wakeups and final substrate dispatch must share the
same scope. Direct parent input and autonomous native-child creation require an
acknowledged quiescence boundary beyond this database. The runtime's ordinary
parent specification and durable conversation identity must survive migration.
