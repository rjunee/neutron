## Issue 613 — attribute app socket closes

### What changed

The app WebSocket lifecycle now retains each live socket and its open timestamp, marks locally initiated shutdown before sending a `1012 service_restart` close, and emits `initiated_by=client|server|unknown`, `close_code`, `close_reason`, `close_kind`, and `uptime_ms` on the existing `session_close` event (`gateway/http/app-ws-surface.ts:579-588`, `gateway/http/app-ws-surface.ts:704-708`, `gateway/http/app-ws-surface.ts:1292-1321`). Open registers the deliberate socket close in its existing teardown list (`open/wiring/app-ws.ts:1475-1476`).

The shared chat client now supplies protocol reasons for explicit teardown, socket replacement, inactive late-open cleanup, and missed-heartbeat cleanup (`chat-core/ws-client.ts:244-252`, `chat-core/ws-client.ts:273-277`, `chat-core/ws-client.ts:302-305`, `chat-core/ws-client.ts:409-415`). This does not change its retry decisions: unexpected `onclose` still schedules reconnect at `chat-core/ws-client.ts:339-352`, and heartbeat cleanup still reaches the existing scheduler at `chat-core/ws-client.ts:420-427`.

### Decisions

`initiated_by` is a three-state vocabulary. A locally marked close is `server`, a received close frame is `client`, and protocol code `1006` means no close frame was available and therefore remains `unknown`; no unavailable fact is guessed into either side (`gateway/http/app-ws-surface.ts:1313-1318`). `close_kind` is separate from initiator so normal client teardown and a server restart are deliberate, while abnormal and heartbeat failures remain unexpected (`gateway/http/app-ws-surface.ts:1316-1320`, `chat-core/ws-client.ts:415`).

These fields join the existing `[app-ws] event=… k=v` lifecycle vocabulary. Existing consumers that select older fields ignore the additive fields by default; the vocabulary and that default are documented at `docs/SYSTEM-OVERVIEW.md:8040-8071`.

### Tests and mutation evidence

The listener-free surface test directly drives the real handler and logger sink in both directions, plus the unavailable-information state (`gateway/__tests__/app-ws-close-attribution.test.ts:72-112`). Client tests pin the explicit teardown and heartbeat reasons (`chat-core/__tests__/ws-client.test.ts:247-256`, `chat-core/__tests__/resilience.test.ts:150-164`).

| Guard | Mutation | Red | Restored |
|---|---|---|---|
| initiator discriminator (`gateway/http/app-ws-surface.ts:1313-1314`) | inverted the server marker comparison; printed the mutated line | 3 failed / 0 passed | 3 passed / 0 failed |
| explicit client teardown reason (`chat-core/ws-client.ts:252`) | replaced the coded close with `close()`; printed the mutated line | 1 failed / 14 passed | 15 passed / 0 failed |
| heartbeat failure reason (`chat-core/ws-client.ts:415`) | replaced the coded close with `close()`; printed the mutated line | 1 failed / 11 passed | 12 passed / 0 failed |

Final local checks: `bun test gateway/__tests__/app-ws-close-attribution.test.ts chat-core/__tests__/ws-client.test.ts chat-core/__tests__/resilience.test.ts` passed 30 tests; `bunx tsc -p gateway --noEmit`, `bunx tsc -p chat-core --noEmit`, and `bunx tsc -p open --noEmit` passed; focused eslint and `git diff --check` passed.

### Deliberately not changed

No activity history or replay was added, no wire contract was changed, and no reconnect, message delivery, or churn-cause fix was attempted. The current-state reconnect snapshot remains the contract at `open/wiring/app-ws.ts:1172-1187` and `open/wiring/typing-catchup.ts:9-24`. No product decision in `SPEC.md` changed.

The pre-existing live-listener observability suite was not modified. A local attempt could not bind any `Bun.serve({port: 0})` listener in this build lane, including a standalone positive control, so the new bidirectional coverage is deterministic and listener-free (`gateway/__tests__/app-ws-close-attribution.test.ts:21-60`).
