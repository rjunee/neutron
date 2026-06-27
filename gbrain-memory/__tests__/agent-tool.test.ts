/**
 * P0-2 — `gbrain_search` agent recall tool.
 *
 * Proves the READ path the audit said was missing: a tool, backed by the SAME
 * `GBrainMemoryStore` the scribe WRITE path uses, that the live agent can call
 * natively to recall entity pages + extracted facts. Backed here by a real
 * `GBrainMemoryStore` over an in-process fake `McpClient` returning GBrain-shaped
 * rows, so the search → normalise → tool_result path is exercised end-to-end.
 */

import { describe, test, expect } from 'bun:test'

import { ToolRegistry, type ToolCallContext } from '../../tools/registry.ts'
import { GBrainMemoryStore } from '../gbrain-memory-store.ts'
import {
  GBrainUnavailableError,
  type McpClient,
  type MemoryStore,
} from '../memory-store.ts'
import { GBRAIN_SEARCH_TOOL, registerGBrainSearchToolSurface } from '../agent-tool.ts'

const ctx: ToolCallContext = {
  project_slug: 'p',
  topic_id: null,
  call_id: 'c1',
  speaker_user_id: null,
}

/** GBrain-shaped fake: `search` returns chunk rows, `list_pages` recency rows. */
function fakeGbrainClient(
  rows: Array<{ slug: string; chunk_text: string; score: number; entity_kind?: string }>,
): McpClient {
  return {
    call: async (name, args) => {
      if (name === 'search') {
        const q = String((args as Record<string, unknown>)['query'] ?? '').toLowerCase()
        return {
          results: rows
            .filter((r) => r.chunk_text.toLowerCase().includes(q) || r.slug.includes(q))
            .map((r) => ({
              slug: r.slug,
              chunk_text: r.chunk_text,
              score: r.score,
              ...(r.entity_kind !== undefined ? { entity_kind: r.entity_kind } : {}),
            })),
        }
      }
      if (name === 'list_pages') {
        return { pages: rows.map((r) => ({ slug: r.slug, title: r.slug })) }
      }
      throw new Error(`unexpected gbrain call: ${name}`)
    },
  }
}

function storeOver(client: McpClient): MemoryStore {
  return new GBrainMemoryStore(client)
}

describe('registerGBrainSearchToolSurface', () => {
  test('registers gbrain_search gated on read:memory, auto-approval', () => {
    const reg = new ToolRegistry()
    const names = registerGBrainSearchToolSurface(reg, storeOver(fakeGbrainClient([])))
    expect(names).toEqual([GBRAIN_SEARCH_TOOL])
    const t = reg.get(GBRAIN_SEARCH_TOOL)!
    expect(t.capability_required).toBe('read:memory')
    expect(t.approval_policy).toBe('auto')
    // Visible to the agent manifest (NOT agent_hidden) — the whole point of P0-2.
    expect(t.agent_hidden).not.toBe(true)
    expect((t.input_schema as { required?: string[] }).required).toEqual(['query'])
  })

  test('recalls a scribe-written fact: query → ranked excerpt + entity kind', async () => {
    const reg = new ToolRegistry()
    registerGBrainSearchToolSurface(
      reg,
      storeOver(
        fakeGbrainClient([
          {
            slug: 'acme-corp',
            chunk_text: 'Acme Corp is the customer piloting the dashboard; CEO is Dana.',
            score: 0.91,
            entity_kind: 'company',
          },
          { slug: 'unrelated', chunk_text: 'nothing to see', score: 0.1 },
        ]),
      ),
    )
    const handler = reg.get(GBRAIN_SEARCH_TOOL)!.handler
    const out = (await handler({ query: 'Acme' }, ctx)) as {
      results: Array<{ id: string; content: string; score: number; kind?: string }>
    }
    expect(out.results.length).toBe(1)
    expect(out.results[0]!.id).toBe('acme-corp')
    expect(out.results[0]!.content).toContain('Acme Corp is the customer')
    expect(out.results[0]!.score).toBeCloseTo(0.91, 4)
    expect(out.results[0]!.kind).toBe('company')
  })

  test('empty query lists recent memory pages (list_pages path)', async () => {
    const reg = new ToolRegistry()
    registerGBrainSearchToolSurface(
      reg,
      storeOver(
        fakeGbrainClient([
          { slug: 'jane-doe', chunk_text: '', score: 0 },
          { slug: 'project-x', chunk_text: '', score: 0 },
        ]),
      ),
    )
    const handler = reg.get(GBRAIN_SEARCH_TOOL)!.handler
    const out = (await handler({ query: '' }, ctx)) as { results: Array<{ id: string }> }
    expect(out.results.map((r) => r.id).sort()).toEqual(['jane-doe', 'project-x'])
  })

  test('clamps an oversized limit and tolerates a non-numeric one', async () => {
    let seenLimit: number | undefined
    const client: McpClient = {
      call: async (name, args) => {
        if (name === 'search') {
          seenLimit = (args as Record<string, unknown>)['limit'] as number | undefined
          return { results: [] }
        }
        return { pages: [] }
      },
    }
    const reg = new ToolRegistry()
    registerGBrainSearchToolSurface(reg, storeOver(client))
    const handler = reg.get(GBRAIN_SEARCH_TOOL)!.handler
    await handler({ query: 'x', limit: 9999 }, ctx)
    expect(seenLimit).toBe(50)
    await handler({ query: 'x', limit: 'lots' }, ctx)
    expect(seenLimit).toBe(10) // default
  })

  test('truncates an over-long excerpt with an ellipsis', async () => {
    const long = 'A'.repeat(2000)
    const reg = new ToolRegistry()
    registerGBrainSearchToolSurface(
      reg,
      storeOver(fakeGbrainClient([{ slug: 'big', chunk_text: long, score: 0.5 }])),
    )
    const handler = reg.get(GBRAIN_SEARCH_TOOL)!.handler
    const out = (await handler({ query: 'A' }, ctx)) as { results: Array<{ content: string }> }
    expect(out.results[0]!.content.length).toBeLessThan(long.length)
    expect(out.results[0]!.content.endsWith('…')).toBe(true)
  })

  test('degrades to empty results when the gbrain binary is missing', async () => {
    const client: McpClient = {
      call: async () => {
        throw new GBrainUnavailableError('Executable not found in $PATH: gbrain')
      },
    }
    const reg = new ToolRegistry()
    registerGBrainSearchToolSurface(reg, storeOver(client))
    const handler = reg.get(GBRAIN_SEARCH_TOOL)!.handler
    const out = (await handler({ query: 'anything' }, ctx)) as { results: unknown[] }
    expect(out.results).toEqual([])
  })
})
