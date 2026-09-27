## 2026-09-27 — Native Claude dispatch evidence boundary

The actual Claude acting-turn consumer exposes a synchronous evidence callback
for a composition-owned durable writer bound to the original request, session,
and child generation. Immediately before invoking `submitLine`, it crosses a
monotonic submission boundary and emits `submission-started`. A writer failure
refuses transport but remains conservatively uncertain. A lost acknowledgement
or partial submission cannot emit `not-submitted`.

Pre-dispatch refusal emits `not-submitted` only after the deadline controller is
aborted, preventing a late turn acquisition from submitting afterward. A unique
native child transcript matching the complete request and parent session emits
its actual agent ID as `child-bound`. That event establishes creation identity,
not completion, termination authority, or an idle census. Existing asynchronous
worker-result and lease semantics are unchanged. Signed receipt storage and its
recovery consumer are separate composition responsibilities; this change adds
no sleep ledger, hook, or provider dependency.

Validation: the acting-turn suites passed 104 tests and 431 assertions, including
the partial-transport boundary test. Focused tests reject both an
unconditional `not-submitted` mutant and a mutant suppressing valid child
binding; both mutations were restored. Root and Open TypeScript checks passed.
No provider process or live terminal was
started by this change's verification.
