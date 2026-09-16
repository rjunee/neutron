## 2026-09-16 — the MCP stdio registration is observed, in both bridges

Issue rjunee/neutron#1094, split out of #1080's round-3 review.

`createToolCallHandler` in `tools-bridge-handler.ts` is the exact handler the stdio
bridge registers, and it was well tested — `__tests__/tools-bridge-response.test.ts`
drives it from `CallToolRequest` to `CallToolResult` through the real POST code. What
no test drove was the line that hands it to the running server,
`tools-bridge-impl.ts:111`. The dev-channel's reply/typing switch had the same
unobserved seam at `dev-channel-impl.ts:152`.

The premise was verified before building on it: replacing the tools-bridge
registration with `async () => ({ content: [{ type: 'text', text: 'null' }] })` and
running `tools-bridge-response.test.ts` + `tool-bridge.test.ts` gave **37 pass / 0
fail** — the same as unmutated. The tested handler and the running bridge were joined
by a line nothing looked at.

### What was added

`runtime/adapters/claude-code/persistent/__tests__/mcp-stdio-registration.test.ts`,
two cases, each spawning the REAL entry point as a subprocess through the SDK's own
`Client` + `StdioClientTransport` (the dependency `gbrain-stdio-client.ts` already
uses). `client.connect()` resolves only after the server answered `initialize`, which
the bridge can do only once `mcp.connect(transport)` ran — after every
`setRequestHandler` above it — so the handshake is the readiness signal; the
`MCP connected` stderr marker is asserted too, proving it is the real bridge.

- **tools-bridge** — `Bun.serve` fake sink on an ephemeral port answering
  `401 {"status":"unauthorized"}`, `TOOLS_MANIFEST_PATH=''`, one `tools/call`. Asserts
  the sink saw exactly `['/tool-call']` (only the registered handler POSTs; the
  mutant never does), `isError === true`, text `!== 'null'` and containing
  `tool dispatch refused (HTTP 401)`.
- **dev-channel** — unreachable sink as in `dev-channel-exit-on-close.test.ts`, one
  `reply` call with no body. Asserts `isError === true`, text `!== 'null'` and
  containing `reply requires a non-empty \`text\``. That refusal is decided before any
  sink traffic, so the case needs no fake server.

### Mutation table

Every run: `bun test runtime/adapters/claude-code/persistent/__tests__/mcp-stdio-registration.test.ts`

| mutation | changed line | observed |
|---|---|---|
| none | — | 2 pass / 0 fail |
| tools-bridge registration replaced | `tools-bridge-impl.ts:111` → `mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'null' }] }))` | 1 pass / 1 fail — the tools-bridge case, `expect(posts).toEqual(['/tool-call'])` received `[]` |
| dev-channel registration replaced | a second `mcp.setRequestHandler(CallToolRequestSchema, async () => ({ …'null' }))` inserted at `dev-channel-impl.ts:225`, after the real one (the SDK keeps the last registration per method) | 1 pass / 1 fail — the dev-channel case, `expect(result.isError).toBe(true)` received `undefined` |
| restored | — | 2 pass / 0 fail |

One wrong mutation is recorded because it is the trap: a first attempt at the
dev-channel mutant renamed the original handler in place and broke the module, so the
subprocess died at startup and the test failed with `MCP error -32000: Connection
closed`. Red, but proving nothing about the registration. The re-register-after form
compiles, runs, and fails on the assertion.

### Also measured

- The four neighbouring suites (`tools-bridge-response`, `tool-bridge`,
  `dev-channel-exit-on-close`, and the new file): 40 pass / 0 fail.
- `bash scripts/ci/lint.sh`: every gate ✅, exit 0 (run with a `bunx` shim, which this
  box lacks; the script calls `bunx eslint`).
- `tsc --noEmit -p runtime/tsconfig.json`: 7 errors with the file and 7 without, all
  pre-existing in `cores/sdk/manifest.ts` and `runtime/__tests__/doc-links-parity.test.ts`.
