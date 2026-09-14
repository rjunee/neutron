## Issue 595 verification: reconnect already adopts terminal turn state

### Outcome

No runtime change was made. The filed issue describes behavior already repaired on the current base. A newly opened socket receives an explicit turn-state snapshot from `open/wiring/app-ws.ts:1172`; the snapshot reads the shared live-turn set at `open/wiring/app-ws.ts:1181` and sends either `start` or `end` at `open/wiring/typing-catchup.ts:16`-`open/wiring/typing-catchup.ts:24`.

A client reconnecting five minutes after the turn and process died sees `agent_typing` with `state: end`. The native reducer clears its stale typing state at `app/lib/chat-core/chat-render-model.ts:151`, and the web controller clears its stale running state at `landing/chat-react/controller.ts:1287`. The web regression then sends immediately at `landing/chat-react/__tests__/controller.test.ts:969`.

### Decisions

The existing `agent_typing` outcome vocabulary was retained: `start` means running and `end` means idle at `open/wiring/typing-catchup.ts:20`. An unrecognized client-side value is ignored at `app/lib/chat-core/chat-render-model.ts:158`; it is not collapsed into idle. No new outcome, invariant, feature switch, or parallel protocol path was introduced.

The brief's `session_ready` citation has moved: that envelope is now constructed at `gateway/http/app-ws-surface.ts:740`-`gateway/http/app-ws-surface.ts:747`. Its claim that no snapshot exists is stale; `open/wiring/typing-catchup.ts:8` names the snapshot helper, and `open/wiring/app-ws.ts:1181` invokes it during session open.

### Tests and mutation

| Guard | Mutation | Red | Restored |
|---|---|---|---|
| Idle snapshot emits `end` at `open/wiring/typing-catchup.ts:20` | Changed the idle branch to `start`; printed the changed line and diff before running | `open/__tests__/typing-refcount.test.ts:85` failed at its exact envelope assertion on line 88 | The same focused test passed after restoration |

`bun test open/__tests__/typing-refcount.test.ts app/__tests__/chat-core-render-model.test.ts landing/chat-react/__tests__/controller.test.ts` passed 111 tests. The real-socket test could not start its `Bun.serve({ port: 0 })` fixture at `open/__tests__/open-app-ws-durable-chatlog.test.ts:143`; the runner returned `EADDRINUSE` before behavior was exercised. The root has no `typecheck` script; the app typecheck reached TypeScript but stopped because the installed dependency tree lacks the implicit `@types` definition. `EXPO_NO_TELEMETRY=1 bun run --cwd app lint` completed with zero errors and 21 pre-existing warnings.

### Deliberately not done

I did not add a field to `session_ready` or retain two snapshot mechanisms. The existing targeted `agent_typing` snapshot already reaches both clients and is covered in both directions at `open/__tests__/typing-refcount.test.ts:85` and `open/__tests__/typing-refcount.test.ts:91`. I did not alter tests or runtime code merely to create a diff for an already-fixed issue.
