/**
 * @neutronai/research-core — ResearchClaimStore unit tests.
 *
 * Per docs/plans/research-core-tier1-brief.md § 2.3.
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'

import { ResearchClaimStore } from '../src/claim-store.ts'
import {
  applyProjectScopedMigrations,
} from '@neutronai/migrations/runner.ts'
import { DEFAULT_MIGRATIONS_DIR } from '../src/store-resolver.ts'

function freshDb(): Database {
  const db = new Database(':memory:', { create: true })
  db.exec('PRAGMA foreign_keys = ON')
  applyProjectScopedMigrations(db, DEFAULT_MIGRATIONS_DIR)
  // Seed a parent task row so research_claims FK passes.
  db.run(
    `INSERT INTO research_tasks
       (id, project_slug, project_id, query, depth, sources_json, status,
        attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', 1, ?, ?)`,
    ['t-1', 'project-a', 'proj-1', 'q', 'standard', '[]', 1, 1],
  )
  db.run(
    `INSERT INTO research_tasks
       (id, project_slug, project_id, query, depth, sources_json, status,
        attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', 1, ?, ?)`,
    ['t-2', 'project-b', 'proj-2', 'q', 'standard', '[]', 1, 1],
  )
  return db
}

describe('ResearchClaimStore — CRUD', () => {
  test('insertClaim + listForTask + getClaim round-trip', () => {
    const db = freshDb()
    const store = new ResearchClaimStore({ db, project_slug: 'project-a' })
    const c = store.insertClaim({
      task_id: 't-1',
      claim: 'water is wet',
      citation: 'https://en.wikipedia.org/wiki/Water',
      confidence: 'high',
    })
    expect(c.id.length).toBeGreaterThan(0)
    const all = store.listForTask('t-1')
    expect(all).toHaveLength(1)
    expect(all[0]?.claim).toBe('water is wet')
    const got = store.getClaim(c.id)
    expect(got?.confidence).toBe('high')
    expect(got?.citation).toBe('https://en.wikipedia.org/wiki/Water')
  })

  test('cite() updates the citation field', () => {
    const db = freshDb()
    const store = new ResearchClaimStore({ db, project_slug: 'project-a' })
    const c = store.insertClaim({
      task_id: 't-1',
      claim: 'unverified for now',
      confidence: 'unverified',
    })
    expect(c.citation).toBeNull()
    const updated = store.cite(c.id, 'https://nytimes.com/x')
    expect(updated?.citation).toBe('https://nytimes.com/x')
  })

  test('cite() rejects empty citation', () => {
    const db = freshDb()
    const store = new ResearchClaimStore({ db, project_slug: 'project-a' })
    const c = store.insertClaim({
      task_id: 't-1',
      claim: 'x',
      confidence: 'unverified',
    })
    expect(() => store.cite(c.id, '   ')).toThrow(/non-empty/)
  })

  test('markUnverified() flips the confidence', () => {
    const db = freshDb()
    const store = new ResearchClaimStore({ db, project_slug: 'project-a' })
    const c = store.insertClaim({
      task_id: 't-1',
      claim: 'x',
      citation: 'https://x',
      confidence: 'high',
    })
    const updated = store.markUnverified(c.id)
    expect(updated?.confidence).toBe('unverified')
  })

  test('countForTask returns 0 for tasks with no claims', () => {
    const db = freshDb()
    const store = new ResearchClaimStore({ db, project_slug: 'project-a' })
    expect(store.countForTask('t-1')).toBe(0)
    store.insertClaim({
      task_id: 't-1',
      claim: 'a',
      citation: 'https://x',
      confidence: 'high',
    })
    expect(store.countForTask('t-1')).toBe(1)
  })

  test('cascade — deleting parent task drops its claims (FK ON DELETE CASCADE)', () => {
    const db = freshDb()
    const store = new ResearchClaimStore({ db, project_slug: 'project-a' })
    store.insertClaim({
      task_id: 't-1',
      claim: 'a',
      citation: 'https://x',
      confidence: 'high',
    })
    db.run(`DELETE FROM research_tasks WHERE id = ?`, ['t-1'])
    expect(store.listForTask('t-1')).toHaveLength(0)
  })
})

describe('ResearchClaimStore — project isolation', () => {
  test('cross-project lookup surfaces as not-found (info-hiding)', () => {
    const db = freshDb()
    const storeA = new ResearchClaimStore({ db, project_slug: 'project-a' })
    const c = storeA.insertClaim({
      task_id: 't-1',
      claim: 'secret claim',
      citation: 'https://x',
      confidence: 'high',
    })
    // Second store points at the same DB but a different owner — must
    // NOT see the row.
    const storeB = new ResearchClaimStore({ db, project_slug: 'project-b' })
    expect(storeB.getClaim(c.id)).toBeNull()
    expect(storeB.listForTask('t-1')).toHaveLength(0)
  })
})
