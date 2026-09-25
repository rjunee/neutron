## 2026-09-25 — Isolate boot-adoption fixture child authorities

The boot-adoption file's composed graph tests registered an owner liveness query,
then closed its database. A later standalone wrapper test inherited that query.
The production fail-closed reader correctly treated the closed-database exception
as unresolved ownership and refused the turn. The standalone test passed alone
but failed after the composed tests in the host suite.

The fixture now removes its exact owner's query at setup and teardown, before
closing the database. The existing first-turn adoption test also runs with a real
durable child lease: the ordinary turn must refuse, retain the lease, and succeed
on the same adopted pane after exact completion releases the child. Production
liveness and refusal behavior are unchanged.

Verification: all 11 boot-adoption tests passed, including the preceding composed
tests. The focused preceding-composition and wrapper sequence passed all three
cases. Omitting both cleanup calls failed both wrapper cases while the preceding
composition passed. Clearing the newly installed current authority instead failed
the unresolved-child refusal while the idle control passed. Open TypeScript passed.
Root TypeScript was attempted in the isolated checkout but its shared dependency
links caused duplicate nominal types for unrelated gateway stores; the integrated
root check remains required. This is fixture repair, not deployed acceptance.
