## 2026-09-26 — Exercise Codex credential recovery at graph readiness

The production boot-wiring fixture constructed the Open composition and expected
Codex owner credential resolution immediately. Startup recovery now deliberately
runs in the returned `on_graph_ready` hook, after graph tools are bound. The
fixture never invoked that hook, so all three credential-ordering cases observed
no project credential resolution. This was stale lifecycle coverage, not a
production credential-ordering defect.

The fixture now verifies materialization during composition and zero early
credential resolution or attachment. It invokes the returned readiness hook
once, then requires graph readiness before project credential resolution and
credential resolution before any surviving-owner attachment. It drains startup
recovery through the shutdown-start hook before restoring mocks. The existing
missing-journal and non-private-home refusals remain; a revoked-project-credential
case additionally requires zero attachment. Production sources are unchanged.

This follows the exact-credential and graph-readiness requirements in
[`a-gateway-restart-keeps-the-project-repls`](../spec-items/a-gateway-restart-keeps-the-project-repls.md).
The consumer under test is `open/composer.ts`'s materialization and readiness
hooks, using synthetic credentials and a mocked durable attachment boundary.
It does not prove physical restart or live provider recovery.

Validation reproduced the original three failures before editing. The corrected
named cases pass four tests with 32 assertions. Omitting readiness makes all four
ordering controls fail; allowing the revoked fixture credential through makes
the negative attachment-count assertion fail. Both mutations were restored and
the four cases passed again. Root and Trident TypeScript checks passed. No full
suite, provider turn or live owner operation was run for this change.
