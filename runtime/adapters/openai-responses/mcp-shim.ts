/**
 * @neutronai/runtime — MCP shim for the GPT-5.5 Responses API adapter.
 *
 * Load-bearing MCP shim for the GPT-5.5 Responses API adapter.
 *
 * The Responses API exposes function calling as an EXTERNAL protocol — the
 * model emits a `tool_call` event and the caller is expected to post the
 * result back via a `function_call_output` item in the next API turn. That
 * shape diverges from the locked CC adapter pattern (`tool_resolution:
 * 'internal'`) and would force every Core to ship two code paths.
 *
 * The shim closes that gap. When the upstream stream emits a `tool_call`,
 * the shim:
 *
 *   1. Resolves the tool by calling the supplied per-instance MCP server
 *      (Neutron's MCP-per-instance pattern, P1 S4) — same surface the CC
 *      adapter uses internally.
 *   2. Buffers the result.
 *   3. Re-streams a fresh Responses API turn whose `input` carries a
 *      `function_call_output` item keyed by the original `call_id`.
 *   4. Surfaces the original `tool_call` to the caller as informational
 *      (matching the internal-mode contract: model emits, but caller does
 *      NOT respondToTool).
 *   5. Continues yielding events from the new turn until that turn's
 *      `completion` (or recurses if it emits another tool_call).
 *
 * Result: callers see `tool_resolution: 'internal'` with `tool_call` events
 * surfaced for observability but no obligation to respond. Cores stay on the
 * locked CC pattern.
 */

import type { Event } from '../../events.ts'
// L2 (2026-07) — `McpToolResolver` moved to `../../../contracts/mcp-tool-resolver.ts`
// (a node-free leaf so `mcp/server.ts` can depend on the shape without
// importing `runtime` — critic-layering.md §2.1 edge #11: `mcp → runtime`).
import type { McpToolResolver } from '@neutronai/contracts/mcp-tool-resolver.ts'
export type { McpToolResolver }

export interface McpShimOptions {
  /** Resolver — see McpToolResolver. */
  resolver: McpToolResolver
  /**
   * Continuation: kick off a fresh upstream stream whose `input` carries the
   * `function_call_output` items. The shim hands off control to this when a
   * tool call is resolved. Implemented by the adapter index so the shim is
   * decoupled from the actual transport.
   */
  continueStream: (continuation: ContinuationInput) => AsyncGenerator<Event, void, void>
  /** Maximum number of tool-call rounds before we abort to prevent loops. Default 10. */
  max_rounds?: number
}

export interface ContinuationInput {
  /** previous_response_id to chain. */
  previous_response_id: string
  /** function_call_output items to ship in the next turn's input. */
  outputs: Array<{ call_id: string; output: string }>
}

/**
 * Wrap an upstream Responses-API event stream so callers see internal-mode
 * semantics. Transparently resolves any `tool_call` events by calling the
 * supplied resolver and continuing the conversation under the hood.
 */
export async function* shimToInternal(
  upstream: AsyncGenerator<Event, void, void>,
  opts: McpShimOptions,
): AsyncGenerator<Event, void, void> {
  const max_rounds = opts.max_rounds ?? 10
  let round = 0
  let current = upstream
  while (true) {
    const pendingCalls: Array<{ call_id: string; tool_name: string; args: unknown }> = []
    let lastSessionId: string | undefined
    let completionEmitted = false

    for await (const ev of current) {
      if (ev.kind === 'tool_call') {
        // Surface to the caller as informational. NEVER prompt them to
        // respond — internal-mode contract.
        pendingCalls.push({ call_id: ev.call_id, tool_name: ev.tool_name, args: ev.args })
        yield ev
      } else if (ev.kind === 'completion') {
        if (ev.session?.id) lastSessionId = ev.session.id
        if (pendingCalls.length === 0) {
          // Clean completion — caller-facing terminal event.
          completionEmitted = true
          yield ev
          return
        }
        // Tool calls were emitted this round — do NOT yield the upstream
        // completion (it's a synthetic mid-conversation event). Resolve calls,
        // then continue.
        completionEmitted = true
        break
      } else {
        yield ev
      }
    }

    if (!completionEmitted || pendingCalls.length === 0) {
      // Stream ended without an upstream completion that requires resolution.
      return
    }

    // Resolve all pending calls in parallel — the MCP server is responsible
    // for any ordering it cares about. Failures surface as error events.
    const outputs: Array<{ call_id: string; output: string }> = []
    for (const call of pendingCalls) {
      try {
        const result = await opts.resolver(call)
        outputs.push({ call_id: call.call_id, output: JSON.stringify(result) })
      } catch (err) {
        const message = `mcp_shim_tool_resolution_failed: ${call.tool_name}: ${(err as Error).message}`
        yield { kind: 'error', message, retryable: false }
        return
      }
    }

    if (!lastSessionId) {
      yield {
        kind: 'error',
        message: 'mcp_shim: upstream completion lacked response.id; cannot continue',
        retryable: false,
      }
      return
    }

    round++
    if (round > max_rounds) {
      yield {
        kind: 'error',
        message: `mcp_shim: tool-call loop exceeded max_rounds=${max_rounds}`,
        retryable: false,
      }
      return
    }

    current = opts.continueStream({ previous_response_id: lastSessionId, outputs })
  }
}
