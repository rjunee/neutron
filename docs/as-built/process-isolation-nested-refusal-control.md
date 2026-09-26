## 2026-09-26 — Isolation refusal controls with an already-contained parent

The canonical suite exposed a test-parent assumption: the isolation refusal
control expected its synthetic child to launch a new namespace even when the
whole Bun invocation already occupied a verified boundary. The preload correctly
reuses that boundary (`tests/support/process-test-isolation-preload.ts:14`), so
the harmless child passed without calling the test's unavailable launcher.
The original full-suite failure remains a failed receipt, not evidence of a
production isolation escape.

The negative control now supplies a fixture-local Python shim that refuses only
the exact helper `--check` invocation, recording that observation. All other
arguments execute the real Python interpreter and unchanged launcher; the fake
bubblewrap still refuses before synthetic module loading. The assertions retain
the refusal status, diagnostic, missing module marker and exact replayed Bun
arguments (`trident/process-test-isolation.test.ts:59`). A converse runs the
harmless synthetic suite in an honestly verified boundary, proves one selected
test passes while another is filtered out, and proves the unavailable launcher
was not invoked (`trident/process-test-isolation.test.ts:96`). Neither control
loads an ownership fixture. No production flag, verifier, preload, or launcher
behavior changed.

Both `bun test trident/process-test-isolation.test.ts` and `python3 -B
trident/process-test-isolation.py -- bun test trident/process-test-isolation.test.ts`
completed with exit zero: five tests and 31 assertions each. The second command
reproduces the already-contained parent context. The existing thirteen mock-only
Python boundary controls also run within each invocation. Root and Trident
TypeScript checks both completed with exit zero.
The reviewed Python launcher, its Python controls, the TypeScript verifier and
the first preload retain their original digests.

This repairs the test instrument, not the cancellation ownership contract:
`docs/spec-items/cancel-stops-host-review-suite.md:46` still requires exact claims
and pidfds. The canonical suite and fresh integrated CI remain mandatory under
that spec's lines 78–80; these focused receipts do not replace them.
