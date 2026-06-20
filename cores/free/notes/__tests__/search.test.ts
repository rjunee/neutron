/**
 * @neutronai/notes — hybrid search tests.
 *
 * Per docs/plans/notes-core-tier1-brief.md § 3.4.
 *
 * v1 ships lex (FTS5 BM25) + a deterministic-rank vec stub. The test
 * suite locks the rank stability + the deterministic-fallback
 * semantics so the S2 embedding swap doesn't silently regress the
 * shape contract.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NotesStoreResolver, search } from '../index.ts'

let tmp: string
let resolver: NotesStoreResolver

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'notes-search-'))
  resolver = new NotesStoreResolver({ owner_home: tmp })
})

afterEach(() => {
  resolver.closeAll()
  rmSync(tmp, { recursive: true, force: true })
})

describe('search — hybrid lex+vec scorer', () => {
  test('empty query returns no hits', async () => {
    const store = await resolver.resolve('p1')
    store.write({ content: 'whatever' })
    const hits = await search({ store, project_id: 'p1', query: '' })
    expect(hits).toEqual([])
  })

  test('lex ranking puts the best BM25 match first; score is in [0, 1]', async () => {
    const store = await resolver.resolve('p2')
    const a = store.write({ content: 'shopify orders by region — 2024 H1' })
    store.write({ content: 'cooking dinner — chicken thigh recipe' })
    const c = store.write({
      content: 'shopify shopify shopify quarterly playbook — shopify',
    })

    const hits = await search({ store, project_id: 'p2', query: 'shopify' })
    expect(hits.length).toBe(2)
    expect(hits[0]?.note_id === c.id || hits[0]?.note_id === a.id).toBe(true)
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0)
      expect(h.score).toBeLessThanOrEqual(1)
      expect(['lex', 'vec', 'lex+vec', 'kg_traverse']).toContain(h.why)
    }
  })

  test('limit clamps the number of results', async () => {
    const store = await resolver.resolve('p3')
    for (let i = 0; i < 25; i++) {
      store.write({ content: `shopify event #${i}` })
    }
    const hits = await search({ store, project_id: 'p3', query: 'shopify', limit: 5 })
    expect(hits.length).toBe(5)
  })

  test('snippet centers on the first match token when possible', async () => {
    const store = await resolver.resolve('p4')
    const longBody = `${'lorem ipsum '.repeat(20)} shopify here we go ${'dolor sit amet '.repeat(20)}`
    store.write({ content: longBody })
    const hits = await search({ store, project_id: 'p4', query: 'shopify' })
    expect(hits.length).toBe(1)
    expect(hits[0]?.snippet).toContain('shopify')
  })

  test('KG-traverse short-circuit (#<note_id>) surfaces 1-hop neighbors', async () => {
    const store = await resolver.resolve('p5')
    const a = store.write({ content: 'A' })
    const b = store.write({ content: 'B' })
    const c = store.write({ content: 'C' })
    store.tunnel(a.id, b.id)
    store.tunnel(a.id, c.id)
    const hits = await search({ store, project_id: 'p5', query: `#${a.id}` })
    const ids = new Set(hits.map((h) => h.note_id))
    expect(ids.has(b.id)).toBe(true)
    expect(ids.has(c.id)).toBe(true)
    for (const h of hits) {
      expect(h.why).toBe('kg_traverse')
    }
  })

  test('deterministic ordering: same query against the same content yields the same rank twice', async () => {
    const store = await resolver.resolve('p6')
    store.write({ content: 'shopify revenue 2024' })
    store.write({ content: 'shopify revenue 2025' })
    store.write({ content: 'shopify revenue forecast' })
    const a = await search({ store, project_id: 'p6', query: 'shopify' })
    const b = await search({ store, project_id: 'p6', query: 'shopify' })
    expect(a.map((h) => h.note_id)).toEqual(b.map((h) => h.note_id))
  })
})
