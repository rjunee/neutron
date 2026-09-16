## 2026-09-16 — Tool-call HTTP outcomes preserve execution certainty

### Change and rationale

The executable handler factory from the previous round remains wired through
`runtime/adapters/claude-code/persistent/tools-bridge-handler.ts:53` and registered
by `runtime/adapters/claude-code/persistent/tools-bridge-impl.ts:111`.

The response mapper now consults HTTP status before parsing at
`runtime/adapters/claude-code/persistent/tools-bridge-response.ts:93-100`.
Known denials (400, 401, and 403) join the existing `BridgeToolResult` error
vocabulary as `tool dispatch refused`; other non-2xx statuses use the distinct
`tool dispatch outcome indeterminate` error because the tool may have run. Both
default to `isError: true` through the existing `fail` constructor at lines
63-65. The raw body is bounded by the existing truncation helper at lines 58-61.

Only 2xx responses proceed to JSON parsing at lines 101-110. The existing
error-string and missing-success outcomes remain at lines 112-120, while a bare
`null` remains reachable only from 2xx plus `ok:true` at lines 122-129.

Targeted cases at
`runtime/adapters/claude-code/persistent/__tests__/tools-bridge-response.test.ts:68-126`
cover parseable and malformed 500 responses, malformed 401, malformed 2xx,
`ok:false` with and without an error string, and the distinct messages. The
handler fixture at lines 142-187 proves the indeterminate 500 flows through the
executable bridge connection.

### Decisions

HTTP 400/401/403 are the known-denial set specified by the issue. All other
non-2xx statuses are conservatively indeterminate; this avoids telling callers
that a retry is safe when a server failed during or after dispatch. Raw response
bodies are not parsed on failure status because status is authoritative and a
malformed body must not erase it.

No feature flag or parallel path was added. No product or SPEC decision changed.

### Mutation evidence

Every mutation below was printed at the cited line before the same targeted test
command ran. Bun compiled and executed each mutation; the first two also passed
`bunx tsc --noEmit --pretty false` before reddening.

| Guard | Compiling mutation | Observed red | Restored green |
| --- | --- | --- | --- |
| Known denial, response:96 | Replace 401 with 402 | 22 pass / 1 fail: malformed 401 was indeterminate | 23 pass / 0 fail |
| Indeterminate outcome, response:99 | Label other non-2xx as refused | 20 pass / 3 fail: both 500 mapper cases and handler case | 23 pass / 0 fail |
| Status before parsing, response:94 | Invert `!httpOk` to `httpOk` | 9 pass / 14 fail, including malformed 401/500 and malformed 2xx | 23 pass / 0 fail |
| Error-string arm, response:113 | Return success with `ok(error)` | 22 pass / 1 fail: handler error lost `isError` | 23 pass / 0 fail |
| Positive-success arm, response:114 | Change `ok !== true` to `ok !== false` | 16 pass / 7 fail, including isolated `ok:false` case | 23 pass / 0 fail |

Command for each red and green result:
`bun test runtime/adapters/claude-code/persistent/__tests__/tools-bridge-response.test.ts`.

### Validation and limits

The final targeted test, typecheck, lint, diff check, and heading-count results
are recorded in the lane progress file. The complete affected behavior list was
enumerated from the mapper's ordered returns at
`runtime/adapters/claude-code/persistent/tools-bridge-response.ts:92-129` and the
test file's `it` cases. No full suite, network action, push, PR, or merge was
performed.

The filed brief's implementation citation remained correct. Its malformed-body
test citation moved from the stated lines 103-108 into the cases at lines 82-126
after the new cases were inserted.
