// persistent-repl-substrate.ts → repl-sink.ts
// Late-bound tool-bridge accessors + the reply-sink coordinates accessor
// (D2 split). The ReplToolBridge/sink singletons live in pool-state.ts (D1).

import { type ReplToolBridge, replToolBridgeRef, sink } from './pool-state.ts'

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

