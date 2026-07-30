// persistent-repl-substrate.ts → repl-sink.ts
// Late-bound tool-bridge accessors + the reply-sink coordinates accessor
// (D2 split). The ReplToolBridge/sink singletons live in pool-state.ts (D1).

import {
  activityTapRef,
  type ReplToolBridge,
  replToolBridgeRef,
  sink,
  todoSyncRef,
} from './pool-state.ts'

// ---------------------------------------------------------------------------
// P0-1 native-MCP tool bridge — late-bound dispatcher.
//
// The `ReplToolBridge` contract + the mutable `replToolBridgeRef` singleton it
// wires live in `pool-state.ts` (D1) alongside the rest of the per-process pool
// state; the interface is re-exported here so the public surface is unchanged.
// ---------------------------------------------------------------------------


/**
 * Wire (or clear) the in-process tool dispatcher the spawned agent reaches over
 * the native-MCP stdio bridge. Called once by `composeProductionGraph` with the
 * graph's `McpServer`; called with `undefined` on graph shutdown so a torn-down
 * instance can't serve tool calls against a dead registry.
 */
export function setReplToolBridge(bridge: ReplToolBridge | undefined): void {
  replToolBridgeRef.current = bridge
}

/**
 * Identity-guarded clear: drop the singleton ONLY if it still points at
 * `bridge`. A graph's shutdown calls this with its own `McpServer` so that, in
 * a process that composed a SECOND graph (the test suite), an older graph's
 * teardown can't null out the live graph's bridge (mirrors
 * `ReplSink.unregisterIf`). Production has one graph per process, so the guard
 * is inert there.
 */
export function clearReplToolBridgeIf(bridge: ReplToolBridge): void {
  if (replToolBridgeRef.current === bridge) replToolBridgeRef.current = undefined
}

// ---------------------------------------------------------------------------
// TodoWrite → Work Board sync — late-bound reconciler (WAVE 3.5 task B).
//
// Mirror of the tool-bridge accessors above. `composeProductionGraph` wires a
// closure that resolves the session's active project scope + reconciles the
// forwarded TodoWrite list into the shared `WorkBoardStore`; the sink's
// `/todo-sync` route reads it. Kept untyped-through (the raw `todos` array) so
// this runtime module never imports work-board.
// ---------------------------------------------------------------------------

export type ReplTodoSync = (input: {
  project_id: string | null
  todos: unknown
}) => Promise<void>

/** Wire (or clear, with `undefined`) the in-process TodoWrite→board reconciler
 *  the `/todo-sync` sink route dispatches to. Called once by the graph compose,
 *  and with `undefined` on graph shutdown. */
export function setReplTodoSync(fn: ReplTodoSync | undefined): void {
  todoSyncRef.current = fn
}

/** Identity-guarded clear: drop the singleton ONLY if it still points at `fn`
 *  (mirrors `clearReplToolBridgeIf`, so a second graph's teardown in the same
 *  process can't null the live graph's reconciler). */
export function clearReplTodoSyncIf(fn: ReplTodoSync): void {
  if (todoSyncRef.current === fn) todoSyncRef.current = undefined
}

// ---------------------------------------------------------------------------
// Activity Inspector tool tap — late-bound recorder.
//
// Third instance of the same accessor pattern as the tool bridge + todo sync
// above. `composeProductionGraph` wires a closure that records the tool row into
// the in-memory inspector buffer and fans an app-ws frame; the sink's `/activity`
// route (POSTed by the Pre/PostToolUse `activity-tap.ts` hook) reads it. Kept as
// a plain synchronous `void` so the hook POST cannot become tool-call latency.
// ---------------------------------------------------------------------------

export type ReplActivityTap = (input: {
  project_id: string | null
  phase: 'pre' | 'post'
  tool_name: string
  detail: string
}) => void

/** Wire (or clear, with `undefined`) the in-process Activity Inspector recorder
 *  the `/activity` sink route dispatches to. Called once by the graph compose,
 *  and with `undefined` on graph shutdown. */
export function setReplActivityTap(fn: ReplActivityTap | undefined): void {
  activityTapRef.current = fn
}

/** Identity-guarded clear (mirrors `clearReplTodoSyncIf`) so a second graph's
 *  teardown in the same process can't null the live graph's recorder. */
export function clearReplActivityTapIf(fn: ReplActivityTap): void {
  if (activityTapRef.current === fn) activityTapRef.current = undefined
}

// ---------------------------------------------------------------------------
// Reply sink — one loopback HTTP server the dev-channels POST back to.
// Module singleton so it is shared across every per-turn substrate instance.
// The `ReplSink` class + the `sink` singleton live in `pool-state.ts` (D1),
// imported above with the rest of the per-process pool state.
// ---------------------------------------------------------------------------

/** Exposed for tests acting as the dev-channel: the live sink coordinates. */
export function getReplSinkInfo(): { port: number; token: string } {
  sink.ensureStarted()
  return { port: sink.port, token: sink.token }
}

