## 2026-09-28 — Bound the native owner replacement assertion

The helper review test deliberately invalidates a native owner binding before
dispatch. On CI, the helper refused the stale binding but the response body was
lost, so the frontend reported an unknown request outcome and fenced itself.
The old assertion accepted only the delivered refusal text, making a safe
transport failure red under load.

The test now accepts either refusal outcome while requiring the frontend to be
closed, no native `turn/start` to have been sent, and the retained native review
lease to refuse a direct turn. A temporary mutation that kept the old binding
valid made the test fail because review dispatch succeeded. The focused helper
suite passed all 23 tests; root and Open typechecks passed.
