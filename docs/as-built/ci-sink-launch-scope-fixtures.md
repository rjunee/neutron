## 2026-09-30 — Bind sink and native launch fixtures to their own scope authority

PR #1423 CI run 36763272570 exposed two fixture defects. The sink credential
fixtures assigned only the legacy pool label, while the handler requires the
canonical scope (`runtime/adapters/claude-code/persistent/pool-state.ts:623`).
Its HTTP 200 error response let status-only replacement controls pass without
dispatching. The fixtures now bind canonical scope, assert successful results
and actual handler calls, and check the dispatched project
(`runtime/adapters/claude-code/persistent/__tests__/sink-restart-survival.test.ts:1338`).
A legacy label remains refused; explicit General and projects literally named
`general` and `default` succeed with their distinct scopes (same file:1502).

The native launch fixture reused the composition fixtures' owner identity.
Composition registers a census over its database (`open/composer.ts:1265`);
after that database closes, the census correctly refuses unknown child ownership.
Running the actual-composition cases in `claude-native-dispatch-boot.test.ts`
before the original launch fixture reproduced its CI error: eight passes and
one failure. The launch fixture now owns a separate empty census and verifies
the exact project/General scopes queried, retaining its original executable,
argv, session, generation and tool-grant evidence assertions
(`runtime/adapters/claude-code/persistent/__tests__/native-parent-launch-evidence.test.ts:90`).

Validation: the complete sink, native launch and native-dispatch boot files pass
together (140 tests), and the tool bridge and tool restriction files pass
together (22 tests). An allow-all mutation of the sink scope guard fails the
legacy refusal; a deny-all mutation fails the legitimate child's result check.
Both mutations were restored. Production guards and startup behavior are unchanged.
Root and Trident TypeScript checks and ESLint for both edited tests also pass.
