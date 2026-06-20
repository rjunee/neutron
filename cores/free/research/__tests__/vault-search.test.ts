/**
 * @neutronai/research-core — vault search (FTS5 + vec stub) tests.
 *
 * Per docs/plans/research-core-tier1-brief.md § 2.3.
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'

import { applyProjectScopedMigrations } from '../../../../migrations/runner.ts'
import { ResearchProjectStore } from '../src/research-store.ts'
import { DEFAULT_MIGRATIONS_DIR } from '../src/store-resolver.ts'
import { sanitizeFtsQuery, searchPriorBriefs } from '../src/vault-search.ts'

function buildHarness(): { db: Database; store: ResearchProjectStore } {
  const db = new Database(':memory:', { create: true })
  db.exec('PRAGMA foreign_keys = ON')
  applyProjectScopedMigrations(db, DEFAULT_MIGRATIONS_DIR)
  const store = new ResearchProjectStore({
    db,
    project_slug: 'project-a',
    project_id: 'proj-1',
  })
  return { db, store }
}

function seedBrief(
  store: ResearchProjectStore,
  topic: string,
  findings: string[],
): string {
  const row = store.insertPending({ query: topic, depth: 'standard', sources: [] })
  store.setCompleted(
    row.id,
    {
      topic,
      key_findings: findings,
      sources: [],
      confidence_level: 'medium',
      recommendations: [],
      claims: findings.map((f, i) => ({
        claim: f,
        citation: `https://wikipedia.org/wiki/x-${i}`,
        confidence: 'medium' as const,
      })),
    },
    findings.length,
  )
  return row.id
}

describe('sanitizeFtsQuery', () => {
  test('plain alnum passes through', () => {
    expect(sanitizeFtsQuery('water cycle')).toBe('water cycle')
  })
  test('special chars get quoted', () => {
    // "water" stays as-is (alnum); "(cycle)" gets quoted because parens
    // aren't allowed bare. Test the quoted-side outcome.
    expect(sanitizeFtsQuery('water (cycle)')).toContain('"(cycle)"')
  })
  test('empty / whitespace returns ""', () => {
    expect(sanitizeFtsQuery('  ')).toBe('')
  })
})

describe('searchPriorBriefs', () => {
  test('matches a topic via FTS5', () => {
    const { store } = buildHarness()
    seedBrief(store, 'water cycle in tropical climates', ['rainfall', 'evaporation'])
    seedBrief(store, 'rocket propulsion engineering', ['ion drives', 'plasma'])
    const hits = searchPriorBriefs({ query: 'water' }, { store })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.topic).toContain('water')
  })

  test('matches a key_finding via FTS5', () => {
    const { store } = buildHarness()
    seedBrief(store, 'topic A', ['evaporation is fast'])
    seedBrief(store, 'topic B', ['plasma physics is hard'])
    const hits = searchPriorBriefs({ query: 'evaporation' }, { store })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.matched_in === 'finding' || hits[0]?.matched_in === 'topic').toBe(true)
  })

  test('no match returns empty', () => {
    const { store } = buildHarness()
    seedBrief(store, 'topic A', ['evaporation'])
    expect(searchPriorBriefs({ query: 'photosynthesis' }, { store })).toHaveLength(0)
  })

  test('limit caps the result count', () => {
    const { store } = buildHarness()
    for (let i = 0; i < 5; i++) {
      seedBrief(store, `entropy and order ${i}`, ['heat flows downhill'])
    }
    const hits = searchPriorBriefs({ query: 'entropy', limit: 2 }, { store })
    expect(hits.length).toBeLessThanOrEqual(2)
  })

  test('cross-project isolation — search in project A invisible to project B', () => {
    const dbA = new Database(':memory:', { create: true })
    dbA.exec('PRAGMA foreign_keys = ON')
    applyProjectScopedMigrations(dbA, DEFAULT_MIGRATIONS_DIR)
    const storeA = new ResearchProjectStore({
      db: dbA,
      project_slug: 'project-a',
      project_id: 'proj-A',
    })
    seedBrief(storeA, 'isolated topic', ['private finding'])

    const dbB = new Database(':memory:', { create: true })
    dbB.exec('PRAGMA foreign_keys = ON')
    applyProjectScopedMigrations(dbB, DEFAULT_MIGRATIONS_DIR)
    const storeB = new ResearchProjectStore({
      db: dbB,
      project_slug: 'project-a',
      project_id: 'proj-B',
    })
    expect(searchPriorBriefs({ query: 'isolated' }, { store: storeB })).toHaveLength(0)
    expect(searchPriorBriefs({ query: 'isolated' }, { store: storeA }).length).toBeGreaterThan(0)
  })

  test('hybrid score is stable + deterministic for identical inputs', () => {
    const { store } = buildHarness()
    seedBrief(store, 'topic A about water', ['rainfall'])
    seedBrief(store, 'topic B about water', ['rivers'])
    const first = searchPriorBriefs({ query: 'water' }, { store })
    const second = searchPriorBriefs({ query: 'water' }, { store })
    expect(first.map((h) => h.task_id)).toEqual(second.map((h) => h.task_id))
    expect(first.map((h) => h.score)).toEqual(second.map((h) => h.score))
  })
})
