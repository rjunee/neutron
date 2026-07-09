/**
 * P0-2 — `gbrain_search` over the native-MCP tools-bridge boundary.
 *
 * Mirrors the #87 tool-bridge shape (`runtime/.../__tests__/tool-bridge.test.ts`)
 * at the `McpServer` seam — the two halves the spawned `claude` reaches as
 * `mcp__neutron__gbrain_search`:
 *
 *   - `listToolSchemas()` — the DISCOVERY half. The persistent REPL substrate
 *     writes exactly these into the per-session tools manifest the bridge
 *     advertises. The agent only sees a tool if it's here (and not agent_hidden).
 *   - `dispatch()` — the INVOCATION half. The bridge POSTs `/tool-call` →
 *     `replToolBridge.dispatch()` → this. Proves a native tool_use routes into
 *     the owner's MemoryStore and returns a structured tool_result.
 *
 * Together these prove the agent can DISCOVER + CALL gbrain_search natively —
 * the read path the lift audit said did not exist.
 */

import { describe, expect, test } from 'bun:test'

import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { registerGBrainSearchToolSurface } from '@neutronai/gbrain-memory/agent-tool.ts'
import type { MemoryStore } from '@neutronai/gbrain-memory/memory-store.ts'
import { registerNeutronToolsSurface } from './surfaces/neutron-tools.ts'
import { McpServer } from './server.ts'

/** A MemoryStore that records the recall query and returns one entity hit. */
function recordingStore(seen: string[]): MemoryStore {
  return {
    add: async () => ({ id: 'x' }),
    query: async (input) => {
      seen.push(input.query)
      // Mirrors a real GBrain `search` row: page type lands on `type`.
      return [
        {
          id: 'dana-okonkwo',
          content: 'Dana Okonkwo — CEO of Acme Corp, met at the 2026 offsite.',
          metadata: { type: 'person', title: 'Dana Okonkwo' },
          score: 0.88,
        },
      ]
    },
    delete: async () => undefined,
    stats: async () => ({ count: 1, size_bytes: 0 }),
  }
}

describe('gbrain_search over the tools-bridge', () => {
  test('is advertised in the agent manifest alongside the Hermes stubs being hidden', () => {
    const reg = new ToolRegistry()
    registerNeutronToolsSurface(reg) // the agent_hidden P3 stubs
    registerGBrainSearchToolSurface(reg, recordingStore([]))
    const server = new McpServer({ project_slug: 'acme', registry: reg })

    const names = server.listToolSchemas().map((s) => s.name)
    // The recall tool IS offered to the spawned agent...
    expect(names).toContain('gbrain_search')
    // ...and the not-implemented-yet Hermes stubs are NOT (agent_hidden).
    expect(names).not.toContain('messages_send')
    // The advertised schema carries the input contract the model validates against.
    const schema = server.listToolSchemas().find((s) => s.name === 'gbrain_search')!
    expect((schema.input_schema as { required?: string[] }).required).toEqual(['query'])
  })

  test('dispatch routes a native call into the MemoryStore and returns the recall', async () => {
    const seen: string[] = []
    const reg = new ToolRegistry()
    registerGBrainSearchToolSurface(reg, recordingStore(seen))
    const server = new McpServer({ project_slug: 'acme', registry: reg })

    const result = (await server.dispatch({
      tool_name: 'gbrain_search',
      args: { query: 'who is Dana' },
      call_id: 'call-1',
    })) as { results: Array<{ id: string; content: string; kind?: string }> }

    expect(seen).toEqual(['who is Dana'])
    expect(result.results[0]!.id).toBe('dana-okonkwo')
    expect(result.results[0]!.content).toContain('CEO of Acme Corp')
    expect(result.results[0]!.kind).toBe('person')
  })
})
