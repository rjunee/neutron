/**
 * P0-2 — `memory_search` write→native-recall loop against a REAL GBrain brain.
 *
 * This is the acceptance proof in committed form (mirrors the #87 real-turn
 * regression shape): it stands up an actual in-process PGLite GBrain brain
 * (same harness as `memory-store.test.ts`) and drives the full loop the spawned
 * agent rides —
 *
 *   1. WRITE (turn 1's effect): `GBrainMemoryStore.add` → real gbrain `put_page`
 *      — exactly what the scribe does every turn.
 *   2. DISCOVERY: `McpServer.listToolSchemas()` advertises `memory_search` (what
 *      the per-session manifest hands the spawned `claude`).
 *   3. NATIVE RECALL (a later turn): `McpServer.dispatch({ tool_name:
 *      'memory_search' })` — the bridge's invocation half (POST /tool-call →
 *      replToolBridge.dispatch) — recalls the written fact from the real brain.
 *
 * No fakes in the read path: a real brain, real `search`, real row shapes. This
 * is also where the `kind`/`title` contract is pinned to reality — GBrain
 * returns the page `type` (not `entity_kind`), so the tool sources `kind` from
 * `type`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'

import type { McpClient } from '../mcp-client.ts'
import { GBrainMemoryStore } from '../gbrain-memory-store.ts'
import { bootPgliteBrain } from './boot-pglite-brain.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { McpServer } from '@neutronai/mcp/server.ts'
import { withTopicContext } from '@neutronai/mcp/topic-context.ts'
import { MEMORY_SEARCH_TOOL, registerMemorySearchToolSurface } from '../agent-tool.ts'

describe('memory_search — real GBrain write→native-recall loop', () => {
  let engine: { disconnect(): Promise<void> }
  let client: McpClient

  beforeAll(async () => {
    const { engine: eng, operations } = await bootPgliteBrain()
    // No embedder under `bun test` → force keyword-only search so a non-empty
    // query is deterministic against a real brain without network (mirrors
    // memory-store.test.ts).
    await eng.setConfig('search.mcp_keyword_only', 'true')
    engine = eng
    const ctx = {
      engine: eng,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    }
    client = {
      async call(name: string, args: Record<string, unknown>): Promise<unknown> {
        const op = operations.find((o) => o.name === name)
        if (op === undefined) throw new Error(`no gbrain op: ${name}`)
        return op.handler(ctx, args)
      },
    }
  }, 60_000)

  afterAll(async () => {
    if (engine !== undefined) await engine.disconnect()
  }, 30_000)

  test('a fact written by the scribe is recalled by a native memory_search call', async () => {
    const store = new GBrainMemoryStore(client)

    // 1) WRITE — the scribe's effect after turn 1 stated the fact.
    await store.add({
      content:
        '---\nkind: person\n---\n\nDana Okonkwo is the CEO of Acme Corp. We met at the 2026 ' +
        'company offsite in Lisbon and agreed to pilot the dashboard in Q3.\n',
      metadata: { slug: 'dana-okonkwo', entity_kind: 'person' },
    })

    // 2) Register exactly as build-core-modules does; wrap in the McpServer the
    //    tools-bridge dispatches against.
    const registry = new ToolRegistry()
    registerMemorySearchToolSurface(registry, store)
    const server = new McpServer({ project_slug: 'default', registry })

    // DISCOVERY half — the manifest the spawned claude is handed.
    expect(server.listToolSchemas().map((s) => s.name)).toContain(MEMORY_SEARCH_TOOL)

    // 3) NATIVE RECALL — a later turn: mcp__neutron__memory_search.
    const result = (await withTopicContext(
      { topic_id: 'app:owner', project_id: 'default', speaker_user_id: 'owner', call_id: 'recall-1' },
      async () =>
        server.dispatch({
          tool_name: MEMORY_SEARCH_TOOL,
          args: { query: 'Acme Corp CEO' },
          call_id: 'recall-1',
        }),
    )) as { results: Array<{ id: string; title?: string; content: string; score: number; kind?: string }> }

    const hit = result.results.find((r) => r.id === 'dana-okonkwo')
    expect(hit).toBeDefined()
    // The recalled fact surfaces in the excerpt — the write→read loop is closed.
    expect(hit!.content.toLowerCase()).toContain('acme corp')
    expect(hit!.score).toBeGreaterThan(0)
    // GBrain returns a real `type` on the row → the tool surfaces `kind`.
    expect(typeof hit!.kind === 'string' && hit!.kind.length > 0).toBe(true)
    // And a human-readable title for the matched page.
    expect(hit!.title).toBe('Dana Okonkwo')
  })

  test('empty query lists the recent memory pages from the real brain', async () => {
    const store = new GBrainMemoryStore(client)
    await store.add({
      content: '---\nkind: company\n---\n\nAcme Corp is piloting the dashboard.\n',
      metadata: { slug: 'acme-corp', entity_kind: 'company' },
    })
    const registry = new ToolRegistry()
    registerMemorySearchToolSurface(registry, store)
    const server = new McpServer({ project_slug: 'default', registry })

    const result = (await server.dispatch({
      tool_name: MEMORY_SEARCH_TOOL,
      args: { query: '' },
      call_id: 'recent-1',
    })) as { results: Array<{ id: string }> }

    expect(result.results.map((r) => r.id)).toContain('acme-corp')
  })
})
