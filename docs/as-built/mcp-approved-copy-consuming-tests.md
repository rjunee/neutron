## 2026-09-19 — Align phone and web MCP approval assertions

The phone and web clients already describe approval as availability in supported
conversations (`app/lib/mcp-servers-client.ts:275` and
`landing/chat-react/mcp-servers-client.ts:265`). Their consuming component tests
still expected the superseded next-session wording and carried Claude-only
comments. Both assertions now require the exact current label, while retaining
the separate prohibition on claiming a running process
(`app/__tests__/mcp-servers-reachable.test.tsx:290` and
`landing/chat-react/__tests__/settings-tab-mcp-servers.test.tsx:290`).

The scoped search finds the current label in both clients and both tests, and no
remaining next-session MCP expectation. Other matches describe unrelated chat
session readiness. No lifecycle or production code changed.

Verification: phone component 16/16, web component 17/17, and MCP client parity
47/47 pass, each exact test file in its own process. Combining both UI files in one process encounters their
duplicate global Happy DOM registration; isolated executions pass. Root and
Trident TypeScript checks, touched-file lint and diff checks pass. This is test
alignment, not new runtime or deployment acceptance.
