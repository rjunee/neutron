/**
 * @neutronai/runtime — SessionHandle interface for substrate adapters.
 *
 * VERBATIM per `docs/engineering-plan.md` § B.P1 lines 399-405. The handle is
 * what `Substrate.start(spec)` returns; it carries:
 *
 * - `events: AsyncIterable<Event>` — the locked tagged-event stream. Iterating
 *   to completion (the `completion` event) closes the session normally; calling
 *   `iterator.return()` propagates cancellation to the adapter.
 * - `respondToTool(call_id, result)` — external-mode only. Adapters with
 *   `tool_resolution: 'internal'` MUST throw if this is ever called (it is a
 *   caller bug).
 * - `cancel()` — idempotent shutdown of the underlying substrate (abort fetch,
 *   SIGTERM child, cancel websocket, etc.). Adapters MUST also cancel from
 *   inside the events iterator's `finally` so `iterator.return()` is enough.
 * - `tool_resolution: readonly 'internal' | 'external'` — locked literal union.
 *   Callers branch on this to decide whether to wire a tool runner.
 *
 * `result: unknown` deliberately matches the locked spec's `result: any` slot
 * (substrate-specific shape; gpt-5-5-api's mcp-shim and CC's internal MCP both
 * pass JSON-shaped values that the substrate parses on its own terms). Strict
 * mode in this codebase forbids `any`, so the spec's `any` is encoded as the
 * widest safe TypeScript type, `unknown`. Behaviorally identical for callers.
 */

import type { Event } from './events.ts'

export interface SessionHandle {
  events: AsyncIterable<Event>
  respondToTool(call_id: string, result: unknown): Promise<void>
  cancel(): Promise<void>
  readonly tool_resolution: 'internal' | 'external'
  /**
   * OPTIONAL child-process liveness probe (a SUPERSET of the locked contract).
   *
   * The persistent-REPL CC adapter's concrete handle additionally exposes this
   * (`runtime/adapters/claude-code/persistent/pool.ts`) so a heartbeat drain can
   * distinguish "silently reading but ALIVE" from a genuine hang: on an idle-
   * window expiry, `onboarding/synthesis`'s `drainWithHeartbeat` consults it and
   * treats a still-running child as liveness, not a wedge (the 2026-06-18 false-
   * wedge fix). It is declared here so that structural probe (`typeof
   * handle.isAlive === 'function'`) has a typed member to read instead of an
   * `as`-cast; substrates that don't implement it leave it `undefined` and every
   * consumer that doesn't know about it is unaffected.
   */
  isAlive?(): boolean
}
