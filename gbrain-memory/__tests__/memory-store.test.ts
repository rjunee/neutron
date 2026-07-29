/**
 * GBrainMemoryStore tests — the admin "Memory" tab's read/write surface.
 *
 * Two layers (mirrors sync-hook.test.ts):
 *   1. **Real PGLite round-trip** — stands up an actual in-memory GBrain brain
 *      and proves the empty/recent query path (`query({query:''})`) surfaces
 *      pages via GBrain `list_pages` — NOT via `search`, which returns nothing
 *      for an empty query (Argus r1 IMPORTANT: admin browse always empty).
 *   2. **Routing** — fast unit tests against a capturing fake `McpClient`
 *      asserting the empty query routes to `list_pages` and a non-empty query
 *      routes to `search`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { McpClient } from '../mcp-client.ts'
import { GBrainMemoryStore } from '../gbrain-memory-store.ts'
import { bootPgliteBrain } from './boot-pglite-brain.ts'

// ─── Layer 1: real GBrain PGLite round-trip ──────────────────────────────

describe('GBrainMemoryStore — real GBrain PGLite round-trip', () => {
  let engine: { disconnect(): Promise<void> }
  let client: McpClient

  beforeAll(async () => {
    // Serialised + retry-hardened real-PGLite boot (see boot-pglite-brain.ts).
    const { engine: eng, operations } = await bootPgliteBrain()
    // No embedding provider is configured under `bun test` (no API key), so the
    // default cheap-hybrid `search` would have no vectors to rank. Force the
    // keyword-only (BM25/ILIKE over `chunk_text`) path so the non-empty search
    // round-trip below is deterministic against a real brain without network.
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

  test('empty query surfaces recent pages via list_pages (not empty)', async () => {
    const store = new GBrainMemoryStore(client)
    await store.add({ content: '---\nkind: person\n---\n\nAda builds.\n', metadata: { slug: 'ada-lovelace' } })
    await store.add({ content: '---\nkind: company\n---\n\nAnalytical Engine.\n', metadata: { slug: 'analytical-engine' } })

    // The exact admin-browse call: empty query, recent listing.
    const rows = await store.query({ query: '', limit: 50 })
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('ada-lovelace')
    expect(ids).toContain('analytical-engine')
    // Every row carries a usable id + a non-empty preview (title/slug).
    for (const r of rows) {
      expect(r.id.length).toBeGreaterThan(0)
      expect(r.content.length).toBeGreaterThan(0)
    }
  })

  test('non-empty query surfaces a real chunk_text preview via search', async () => {
    // Exercises the SEARCH path (not list_pages) end-to-end against a real
    // brain. Before the Argus r2 fix the mapper read `content`/`text`/`snippet`
    // — none of which gbrain's `SearchResult` exposes — so every preview came
    // back ''. This asserts the matched-chunk body actually surfaces.
    const store = new GBrainMemoryStore(client)
    await store.add({
      content: '---\nkind: person\n---\n\nGrace Hopper invented the compiler.\n',
      metadata: { slug: 'grace-hopper' },
    })

    const hits = await store.query({ query: 'compiler', limit: 10 })
    expect(hits.length).toBeGreaterThan(0)
    const hit = hits.find((h) => h.id === 'grace-hopper')
    expect(hit).toBeDefined()
    // The preview is the real `chunk_text`, non-blank and carrying the match.
    expect(hit!.content.length).toBeGreaterThan(0)
    expect(hit!.content.toLowerCase()).toContain('compiler')
  })

  test('stats reports a non-zero page_count from get_stats', async () => {
    // Exercises the STATS path. Before the fix the mapper read `pages`/`count`
    // (neither exists on gbrain `BrainStats`) so the admin tab showed 0 pages
    // forever. Self-contained (adds its own page) so it doesn't depend on the
    // other tests' writes or on execution order.
    const store = new GBrainMemoryStore(client)
    await store.add({
      content: '---\nkind: person\n---\n\nKatherine Johnson computed trajectories.\n',
      metadata: { slug: 'katherine-johnson' },
    })
    const s = await store.stats()
    expect(s.count).toBeGreaterThan(0)
  })
})

// ─── Layer 2: routing (capturing fake, no brain) ─────────────────────────

function fakeMcp(behavior: (name: string, args: Record<string, unknown>) => unknown): {
  client: McpClient
  calls: Array<{ name: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  return {
    calls,
    client: {
      async call(name: string, args: Record<string, unknown>): Promise<unknown> {
        calls.push({ name, args })
        return behavior(name, args)
      },
    },
  }
}

describe('GBrainMemoryStore.query — routing', () => {
  test('empty query routes to list_pages, never search', async () => {
    const mcp = fakeMcp((name) =>
      name === 'list_pages'
        ? [{ slug: 'a', title: 'A', updated_at: '2026-06-06' }]
        : (() => { throw new Error('search must not be called for empty query') })(),
    )
    const store = new GBrainMemoryStore(mcp.client)
    const rows = await store.query({ query: '', limit: 10 })
    expect(mcp.calls.map((c) => c.name)).toEqual(['list_pages'])
    expect(rows[0]!.id).toBe('a')
    expect(rows[0]!.content).toBe('A')
  })

  test('whitespace-only query also routes to list_pages', async () => {
    const mcp = fakeMcp(() => [])
    const store = new GBrainMemoryStore(mcp.client)
    await store.query({ query: '   ' })
    expect(mcp.calls.map((c) => c.name)).toEqual(['list_pages'])
  })

  test('non-empty query routes to search and maps the REAL SearchResult shape', async () => {
    // Feed the ACTUAL gbrain `SearchResult` field names (`slug` / `chunk_text` /
    // `score` — gbrain types.ts), NOT a fabricated `{content}` shape. If the
    // mapper reads the wrong field for the preview, `content` comes back '' and
    // this assertion FAILS — which is the whole point (Argus r2: a fabricated
    // stub kept the routing test green while prod previews rendered blank).
    const mcp = fakeMcp((name) =>
      name === 'search'
        ? [{ slug: 'b', page_id: 7, chunk_text: 'body', score: 0.9 }]
        : (() => { throw new Error('list_pages must not be called for non-empty query') })(),
    )
    const store = new GBrainMemoryStore(mcp.client)
    const rows = await store.query({ query: 'ada', limit: 5 })
    expect(mcp.calls.map((c) => c.name)).toEqual(['search'])
    expect(rows[0]!.id).toBe('b')
    expect(rows[0]!.content).toBe('body') // chunk_text → preview, not blank
    expect(rows[0]!.score).toBe(0.9)
  })
})
