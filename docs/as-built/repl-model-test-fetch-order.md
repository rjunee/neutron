## 2026-09-28 — Isolate the device model switch request assertion

The REPL model test replaces the process-wide `fetch` and records every request
except native owner control reads. In one full device-lane run, its second
recorded call was a General model GET with a different base URL and token. The
source of that request was not established. The test asserted that the second
recorded request was the switch POST, so this extra GET made the assertion fail
even though the model switch control had been pressed.

The test now selects the Willow model endpoint by exact URL and method and
asserts exactly one switch POST with the requested model, session, and token.
It also inserts and positively identifies an unrelated GET in the recorded-call
array. With that injected call, the former positional assertion fails; the
scoped assertion passes.

The isolated test and the 43-file device lane passed after the change. Root and
app TypeScript checks passed.
