## Issue 517 — heartbeat-gated card pulse

### What changed

The run store now selects only the two shipped wrapper heartbeat stages for a run (`trident/store.ts:1080-1092`). Run-progress derivation carries the observed timestamp and computes its expiry from the shared heartbeat cadence (`trident/run-progress.ts:76-79`, `trident/run-progress.ts:232-235`). The HTTP board surface supplies that lookup while enriching board rows (`gateway/http/work-board-surface.ts:243-255`), and the websocket snapshot supplies the same lookup to the shared derivation (`open/composer.ts:4230-4242`).

Web activity, web board rows, and native board rows now require a fresh expiry and a non-terminal phase (`landing/chat-react/work-activity.tsx:37-46`, `landing/chat-react/WorkBoardTab.tsx:111-124`, `app/lib/work-board-helpers.ts:347-362`). Missing progress, a bare binding, malformed time, and expired evidence all fail closed. Bound rows continue to schedule quiet polling so heartbeat arrival and expiry can reach the display without treating the binding as life (`landing/chat-react/WorkBoardTab.tsx:562-573`, `app/app/projects/[id]/workboard.tsx:257-268`).

### Decisions

The pulse consumes the wrapper heartbeat as ALIVE evidence only. It does not classify transcript writes, launcher state, or a non-terminal phase as healthy or progressing. This preserves the existing outcome vocabulary: terminal phase labels remain the terminal classification, while heartbeat freshness decides only whether a non-terminal row is presently running (`landing/chat-react/work-activity.tsx:43-46`). The default for missing or malformed heartbeat data is non-running, which exposes the existing retry path.

No feature flag or compatibility liveness branch was added. The new wire fields are optional only at client decode boundaries so a rolling deployment fails closed; omission never restores the old proxy (`landing/chat-react/work-board-client.ts:152-154`, `app/lib/work-board-client.ts:122-124`). The continuously maintained invariant is the expiry derived from the shipped cadence, refreshed by quiet board reads; it does not depend on a killed writer producing a terminal transition.

### Tests and mutation evidence

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Freshness comparison in `itemRunning` | Changed `nowMs <= freshUntil` to `nowMs > freshUntil` at `landing/chat-react/work-activity.tsx:46` | `itemRunning > fails closed when the heartbeat is missing or stale` failed because stale evidence returned true | Same focused test passed after restoring `<=` |

The store test proves ordinary stages and another run cannot supply this run's heartbeat (`trident/store.test.ts:34-47`). The progress test pins the five-minute server-clock expiry (`trident/run-progress.test.ts:161-173`). The client test directly covers missing and stale evidence (`landing/chat-react/__tests__/work-activity.test.tsx:88-101`).

Validation: `bunx tsc --noEmit` passed. `EXPO_NO_TELEMETRY=1 bun run lint` in `app/` passed. Each touched test file passed in its own process; the integration surface and both wire-decoder files also passed. A combined multi-file Bun invocation exposed existing shared browser-state pollution in the web add-item test, while that file passed alone. The app-local typecheck could not start because its configured implicit type library is unavailable in this checkout; the root typecheck, which includes the changed TypeScript, passed.

### Deliberately not changed

The wrapper heartbeat producer and hang watchdog were not redesigned: the producer already stamps the two heartbeat stages and the watchdog already reads stage-event time. No convergence claim was inferred from transcript activity. The spec's existing ALIVE-versus-PROGRESSING distinction remains intact: animation is bounded ALIVE evidence, not a health verdict.
