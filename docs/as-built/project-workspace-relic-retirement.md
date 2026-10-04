## 2026-10-04 — Preserve and safely retire dead Chat workspace remnants

Refs #1432, #1342. Dead native-owner relinquishment retained only pane/tab
handles, and relic-only scopes appeared absent to lifecycle cleanup. Chat
creation now preserves the server-returned terminal/runtime birth receipt; the
journal carries it through relinquishment and exposes a distinct relic state.

The manager durably reserves a correlated input hold, checks the original birth,
placement and workspace marker, and uses only held owned-pane retirement. A
strict held kernel census checks shell start/boot/UID/session/terminal identity,
enumerates the observer as a positive control and refuses background children,
session/terminal members, unreadable data or changed evidence. The consuming
lifecycle also supplies a synchronous admission recheck at retirement. Lost
replies retain exact retry authority; foreign splits prevent atomic empty
workspace retirement and survive. Missing legacy receipts are never inferred
from current live state; their obligation remains visible without blocking wake.
Independent review identified two pre-retirement recovery gaps: late admission
now releases the exact hold before restoring readiness; uncertain releases carry
durable intent and re-hold only the original target/token before re-proving idle
at the newly acknowledged epoch. Already-issued uncertain retirement cannot
take that release path. Focused restart/lost-release and actual next-wake
controls cover these repairs.
The final kernel census uses the same unissued-release path when background work
arrives after the first census. Its regression verifies the exact release and
successful next wake; the former missing-release mutant fails that assertion
while the idle sibling passes. Uncertain input epochs and already-issued
retirement keep their holds and reservations.

The normative item records a separate protected current-shell operator authority
for legacy cleanup. This public change does not implement that privileged
actuator or claim deployment cleanup. There are no raw-close fallbacks, lease
deletions, registry repairs or transcript writes.

Measured locally: 89 focused manager/empty-workspace/lifecycle tests passed;
the subsequently extended new relic/census/lifecycle group passed all 31 tests.
The three consuming `open/__tests__/project-build-e2e.test.ts` project/General
placement fixtures passed (55 assertions; remaining cases filtered). Root and
Trident type checks and changed-file lint passed. A restrictive mutant restoring
the old absent classification failed the consuming idle cleanup assertion; a
permissive mutant removing background-member refusal failed child/session/TTY
controls while the legitimate idle sibling passed. Both mutations were restored
and the new test group passed again. These are isolated fixtures, not live Herdr
or provider evidence. Full-host gating and deployed cleanup remain pending.
