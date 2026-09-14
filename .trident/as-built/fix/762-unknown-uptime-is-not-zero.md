## 2026-09-14 — Unknown socket uptime is not reported as zero

### What changed

The app WebSocket close diagnostic now asserts that its open timestamp exists before it emits `session_close`, then computes `uptime_ms` only from that timestamp (`gateway/http/app-ws-surface.ts:1306-1322`). A close callback that violates the lifecycle invariant rejects without writing a misleading close diagnostic (`gateway/__tests__/app-ws-close-attribution.test.ts:73-80`).

### Reachability and decision

The missing-timestamp branch is not a legitimate production path. Upgrade data receives the `app_ws` discriminator before `server.upgrade` (`gateway/http/app-ws-surface.ts:675-686`). The WebSocket multiplexer uses that same discriminator for both lifecycle callbacks (`gateway/http/compose.ts:330-351`). The app handler writes `opened_at_ms` synchronously at the start of `open`, before any later work can suspend (`gateway/http/app-ws-surface.ts:704-708`). Thus every production app close that reaches the diagnostic follows timestamp capture.

The defensive zero was removed rather than replaced with another sentinel. The impossible state joins ordinary JavaScript invariant exceptions: the async close handler rejects at the assertion, and by default no `session_close` vocabulary entry is emitted (`gateway/http/app-ws-surface.ts:1292-1309`). The invariant is continuously maintained by the lifecycle dispatcher and the first synchronous write in `open`; detecting a violation does not depend on a client continuing to work.

The consumer search was enumerated with `rg -n "session_close|app_socket_closed" . --glob '!docs/AS_BUILT.md' --glob '!.git/**'`. It found the producer at `gateway/http/app-ws-surface.ts:1309` and the documented log format at `docs/SYSTEM-OVERVIEW.md:8042-8063`; there is no in-tree arithmetic consumer to update. As a positive-controlled absence check, `rg -n "opened_at_ms === undefined \\? 0|uptime_ms: Math\\.max" gateway/http/app-ws-surface.ts gateway/__tests__` found the replacement at `gateway/http/app-ws-surface.ts:1322` and no old zero fallback.

### Verification

| Guard | Mutation | Mutated result | Restored result |
|---|---|---|---|
| Missing `opened_at_ms` throws before logging (`gateway/http/app-ws-surface.ts:1306-1308`) | Removed those three printed lines | `bun test gateway/__tests__/app-ws-close-attribution.test.ts`: RED, 3 pass / 1 fail; rejection expectation received a resolved promise | GREEN, 4 pass / 0 fail |

Additional checks:

- `bash scripts/ci/typecheck-all.sh`: all 51 TypeScript configurations passed.
- `bash scripts/ci/lint.sh`: all repository lint gates passed.
- `git diff --check`: passed with the complete change.

### Deliberately not changed

No sentinel value was introduced, and the existing `initiated_by` and `close_kind` classifications remain unchanged (`gateway/http/app-ws-surface.ts:1316-1322`). No spec decision changed. Scope remains the close handler and its focused test, apart from this required record.
