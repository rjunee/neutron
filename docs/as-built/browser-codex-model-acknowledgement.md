## 2026-09-25 — Browser model switches accept the native conditional token

The served browser compared the model switch acknowledgement's `sessionId`
with its pre-switch token. Codex advances that token's epoch after a successful
settings update, so a successful switch displayed a session-change error.
`landing/chat-react/ReplModelControl.tsx:70` now compares harness and stable
conversation identity, retaining the session-token fallback used by Claude.
The accepted response supplies the token for the next switch. The browser
client declares and validates the optional nonempty `conversationId` at
`landing/chat-react/repl-model-client.ts:5` and `:27`.

This implements the in-place web model control required by SPEC.md's
2026-09-11 harness-orchestrator decision and the project controls in
`docs/spec-items/instance-project-provider-resolution.md:32`. It does not
transfer native context or change owner admission.

Rendered browser regressions cover two successive Codex switches with advancing
tokens, foreign harness and conversation acknowledgements, missing and malformed
conversation identity, and authentication refusal. Existing Claude success and
session-replacement refusal remain positive and negative controls.

The consuming Open regression in
`open/__tests__/open-app-ws-durable-chatlog.test.ts:191` starts the real graph,
admits a web WebSocket chat turn, then uses the browser model client through the
authenticated HTTP route. Actual owner bindings, model controls, helper transport
and native control broker execute; subscription lookup and process launch use
the existing simulated native-owner fixture. It proves two successive model
updates on one conversation, stale-token/authentication/foreign-project refusal
without a native settings write, and one owner attachment. It does not invoke
a real provider or establish deployed acceptance.

Verification: the three focused browser files passed 46 tests / 257 assertions;
the full focused Open chat-log file passed 10 tests / 68 assertions. TypeScript
checks for `landing/chat-react`, `landing`, and `open` passed. Restoring the old
token-equality comparison made the same-conversation test fail; removing the
identity guard made both foreign-conversation and foreign-harness cases fail.
Both mutations were restored before the passing focused runs. The canonical
full suite, CI and deployment were deliberately left to integration ownership.

### Fresh-main integration

The functional delta from `c2d04648a41ddc3e7aff53792561332676a3caec` was
integrated onto public main `b046589034de0569208da4c6b9a69e571fbdedaf`
alongside browser native controls and the single General phone-scope delta.
The four-file browser run including the create-project consuming fixture
passed 66 tests / 423 assertions. The real Open chat-log file passed 10 tests /
68 assertions with loopback sockets enabled; the initial sandboxed run could
not open its listeners and is not treated as product-failure evidence.

Restoring pre-switch token equality killed the same-conversation case (17 pass /
1 fail). Removing the identity guard killed foreign conversation, foreign harness,
missing conversation and Claude session-replacement cases (14 pass / 4 fail).
Both mutations were restored before the passing browser rerun. Root, Trident,
app, landing chat, landing and Open TypeScript checks exited zero.

This consuming test still simulates provider credentials and process launch as
described above; it does not satisfy the live Codex build required by
`docs/spec-items/instance-project-provider-resolution.md:82-84`. Final
workspace-lifecycle composition, independent review, the full shared-host suite,
exact-head CI and live cutover acceptance remain outstanding. Nothing was
pushed, merged or deployed.
