## 2026-09-24 — Isolate the Open rail unread fixture from ambient Claude auth

The project rail WebSocket fixture removed explicit Claude keys but still inherited the runner's ambient Claude login. Open's credential resolver accepts that login, so socket setup could run a real provider turn despite the fixture's LLM-less claim. A host full-suite run timed out the per-connection unread case after 30 seconds; a focused rerun passed, which made the failure intermittent rather than a rail behavior regression.

The fixture now sets the existing ambient-auth opt-out and restores its prior value after each test. A guard checks both directions with a simulated available ambient credential: the fixture refuses it, while the production probe accepts it when the opt-out is absent. This preserves the rail requirement in `SPEC.md:425-434` and the production auth behavior.

The affected Open WebSocket file and ambient-auth unit file passed together: 14 tests, zero failures. The per-connection unread case took 197 ms in that focused run. Removing the fixture opt-out made its guard fail (expected false, received true); applying the opt-out to the simulated production probe made the inverse guard fail (expected true, received false). Both `tsc -p tsconfig.json --noEmit` and `tsc -p trident/tsconfig.json --noEmit` passed.

The full host suite ran once on code commit `9385bf45fcb7b7bf9ee200cedacc19f8350ef2fe` with one runner job and exited 0. Its coverage audit found 1,666 files, assigned and executed all 1,666, and reported zero failed lanes across 15 general chunks, one PGLite lane, one device lane, and one serial HTTP lane (1,437 + 22 + 43 + 164 files). The previously timed-out unread test passed in the full HTTP lane in 187 ms. The complete local receipt is `/tmp/open-unread-full-suite-9385.log`; that temporary host path is not a portable CI artifact. This successful run verifies this revision under the measured host conditions, but one prior timeout alone cannot establish that ambient auth was its only possible cause.

Tracks #1267.
