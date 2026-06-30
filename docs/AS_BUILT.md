# AS_BUILT

Running log of what shipped, newest first. One entry per merged change.

## 2026-06-29 — M1: stale-client-store auto-reset on server reinstall

**Problem.** A fresh Neutron Open server reinstall showed a STALE chat: the web
client's offline local store (`@neutron/chat-core` OPFS snapshot, origin-scoped
`neutron-chat-core.json`) — and the mobile op-sqlite store (`neutron-chat.db`) —
survive a server uninstall+reinstall behind the same origin/device. The server's
per-topic `seq` counter restarts at 1 on a fresh install, but the client resumed
forward from its OLD high local cursor (`resume after_seq=<high>`), so the
server's `replayAfter` returned nothing and the dead server's transcript
rendered forever. `session_ready.last_seen_seq` already carried the server's
high-water seq but NO client code read it.

**Fix (seq-regression reset detection, no flags).**
- `chat-core/types.ts` — new `parseSessionReadyMaxSeq(frame)`: extracts
  `last_seen_seq` from a `session_ready` frame, `null` when absent/malformed.
- `chat-core/sync-engine.ts` — new `SyncEngine.reconcileServerReset(topic, serverMaxSeq)`:
  when the server's reported seq is a known number **strictly lower** than a
  **non-zero** local cursor, the server regressed (was wiped/reinstalled) →
  `store.clear(topic)` so the following `resume` re-syncs from `after_seq=0`.
  Conservative: no-op when seq is absent (`null`), when server seq ≥ local
  cursor (normal reconnect/cold-open/first-connect), or when the local cursor
  is 0 (nothing cached).
- `chat-core/web-session.ts` + `app/lib/chat-core/mobile-session.ts` — both
  `session_ready` handlers call `reconcileServerReset(frame)` BEFORE
  `resumeAndFlush()`, and emit a UI change on a real reset so the stale messages
  drop immediately (before the replay lands). The detection lives in the SHARED
  `SyncEngine`, so web (OPFS) and mobile (op-sqlite) both benefit.
- `app/lib/ws-envelope.ts` — added `last_seen_seq?` to `AppWsOutboundSessionReady`
  for type parity with the server envelope (`channels/adapters/app-ws/envelope.ts`).

**Not changed.** No server changes — `gateway/http/app-ws-surface.ts` already
stamps `session_ready.last_seen_seq = adapter.currentMaxSeq(topic)` (>0), and
`open/composer.ts` wires the durable `AppChatStore` chat_log, so the signal is
already present. No new local-store namespace keyed on a server instance id (the
frame exposes no per-install id today; the seq-regression heuristic is the
pragmatic detector per the bug note).

**Tests.** `chat-core/__tests__/session-ready.test.ts` (parser edge cases),
`chat-core/__tests__/sync-engine.test.ts` (reconcile: clears on regression;
no-op on ≥, null, cursor-0, un-sequenced optimistic sends),
`chat-core/__tests__/web-session.test.ts` + `app/__tests__/chat-core-mobile-session.test.ts`
(end-to-end: stale transcript cleared + `resume after_seq=0` + fresh replay
renders clean; normal reconnect preserves; absent `last_seen_seq` never wipes).
