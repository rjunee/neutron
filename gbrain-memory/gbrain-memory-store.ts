/**
 * @neutronai/gbrain-memory — `MemoryStore` over a GBrain `McpClient`.
 *
 * Maps the substrate-neutral `MemoryStore` surface onto GBrain MCP tools:
 *   - `add`    → `put_page`     (slug from `metadata.slug`/`metadata.entity_slug`)
 *   - `query`  → `search`       (ranked chunks; normalised to {id,content,…})
 *             → `list_pages`    when the query is empty/blank — GBrain `search`
 *               requires a non-empty query and returns nothing for `''`, so the
 *               admin "Memory" tab's empty/recent listing (`query({query:''})`)
 *               must fall through to the recency-sorted page enumeration.
 *   - `delete` → `delete_page`
 *   - `stats`  → `get_stats`
 *
 * Works over ANY `McpClient`, so production wires it onto `GBrainStdioMcpClient`
 * and tests wire it onto an in-process client backed by a real PGLite brain.
 * Read paths are defensive about GBrain response shapes — the admin browse is
 * best-effort and must never throw the whole route.
 */

import type { McpClient, MemoryStore } from './memory-store.ts'

export class GBrainMemoryStore implements MemoryStore {
  private readonly mcp: McpClient

  constructor(mcp: McpClient) {
    this.mcp = mcp
  }

  async add(input: {
    content: string
    metadata?: Record<string, unknown>
  }): Promise<{ id: string }> {
    const slug = resolveSlug(input.metadata)
    await this.mcp.call('put_page', { slug, content: input.content })
    return { id: slug }
  }

  async query(input: {
    query: string
    limit?: number
    filter?: Record<string, unknown>
  }): Promise<
    Array<{ id: string; content: string; metadata: Record<string, unknown>; score: number }>
  > {
    // Empty/blank query → the admin "Memory" tab's recent listing. GBrain
    // `search` requires a non-empty query (it returns nothing for ''), so route
    // the empty path to `list_pages` (recency-sorted) instead.
    if (input.query.trim().length === 0) {
      const listRes = await this.mcp.call('list_pages', {
        sort: 'updated_desc',
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      })
      return extractRows(listRes).map((row) => {
        const o = (row ?? {}) as Record<string, unknown>
        const id = String(o['slug'] ?? o['id'] ?? o['page_id'] ?? '')
        // list_pages carries no body — surface the title (falling back to the
        // slug) as the preview. score is 0: recency ordering, not relevance.
        const content = String(o['title'] ?? o['content'] ?? id)
        return { id, content, metadata: o, score: 0 }
      })
    }
    const res = await this.mcp.call('search', {
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    })
    const rows = extractRows(res)
    return rows.map((row) => {
      const o = (row ?? {}) as Record<string, unknown>
      const id = String(o['slug'] ?? o['id'] ?? o['page_id'] ?? '')
      // GBrain `SearchResult.chunk_text` (gbrain types.ts) is the matched chunk
      // body — that's the field to surface as the preview. The other names are
      // defensive fallbacks for non-search shapes; `chunk_text` MUST be first or
      // every search preview renders blank (Argus r2 IMPORTANT).
      const content = String(
        o['chunk_text'] ?? o['content'] ?? o['compiled_truth'] ?? o['text'] ?? o['snippet'] ?? '',
      )
      const score = typeof o['score'] === 'number' ? (o['score'] as number) : 0
      return { id, content, metadata: o, score }
    })
  }

  async delete(input: { id: string }): Promise<void> {
    await this.mcp.call('delete_page', { slug: input.id })
  }

  async stats(): Promise<{ count: number; size_bytes: number }> {
    const res = (await this.mcp.call('get_stats', {})) as Record<string, unknown> | null
    const o = res ?? {}
    // GBrain `get_stats` returns `BrainStats` whose page tally is `page_count`
    // (gbrain types.ts / pglite-engine.ts getStats) — NOT `pages`/`count`. Read
    // `page_count` first or the admin Memory tab shows 0 pages forever (Argus r2
    // IMPORTANT). Fall back to `chunk_count` only when there are no pages but the
    // brain has loose chunks, then to the legacy names for non-gbrain shapes.
    const count = typeof o['page_count'] === 'number'
      ? (o['page_count'] as number)
      : typeof o['pages'] === 'number'
        ? (o['pages'] as number)
        : typeof o['count'] === 'number'
          ? (o['count'] as number)
          : 0
    // `BrainStats` carries no byte total (only page/chunk tallies), so size_bytes
    // stays a best-effort read for any future engine that reports it, else 0.
    const size_bytes = typeof o['size_bytes'] === 'number' ? (o['size_bytes'] as number) : 0
    return { count, size_bytes }
  }
}

function resolveSlug(metadata: Record<string, unknown> | undefined): string {
  const m = metadata ?? {}
  const slug = m['slug'] ?? m['entity_slug']
  if (typeof slug === 'string' && slug.length > 0) return slug
  throw new Error('GBrainMemoryStore.add requires metadata.slug (or metadata.entity_slug)')
}

function extractRows(res: unknown): unknown[] {
  if (Array.isArray(res)) return res
  if (res === null || res === undefined || typeof res !== 'object') return []
  const obj = res as Record<string, unknown>
  for (const key of ['results', 'rows', 'result', 'data', 'pages', 'hits']) {
    const v = obj[key]
    if (Array.isArray(v)) return v
  }
  return []
}
