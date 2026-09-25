## 2026-09-25 — Stabilize the phone model refocus test

The phone model test deferred GET number two to check that a successful POST
snapshot is cleared on refocus and replaced only after the new GET completes.
An unrelated background GET could consume that ordinal first. The device lane
then reported a missing completion callback even though the refocus request ran.

The mock now defers the refocus GET by its new bearer identity. The test includes
an intervening old-session GET, confirms that the new-session GET was made, and
retains both state assertions: unknown while that GET is pending, then the new
model after its response completes. No app behavior changed.

The original test failed at its completion-callback assertion when the extra GET
was inserted. With the change, the focused test and all 18 tests in the file
passed. The server and app TypeScript checks and the isolated device lane were
also run for this change.
