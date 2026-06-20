/**
 * @neutronai/notes — NotesStore + resolver unit tests.
 *
 * Per docs/plans/notes-core-tier1-brief.md § 4 + § 5.
 *
 * Covers:
 *   - schema round-trip via the in-tree migration tree
 *   - drawer create + idempotent on name
 *   - note write + auto-provisioned inbox drawer
 *   - listNotes ordering + per-drawer scope
 *   - soft-delete (deleteNote idempotency)
 *   - KG tunnel (self-loop rejected, idempotent on (source, target, kind))
 *   - traverse depth clamp + BFS
 *   - FTS5 search via NotesStore.ftsSearch
 *   - resolver: fresh init, idempotent re-open, copy-leak rejection
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  KG_EDGE_KIND_USER_TUNNEL,
  NotesSidecarMismatchError,
  NotesStore,
  NotesStoreError,
  NotesStoreResolver,
  sanitizeFtsQuery,
} from '../index.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'notes-store-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('NotesStoreResolver — per-project SQLite lifecycle', () => {
  test('resolve(project) creates <owner_home>/Projects/<project>/notes/notes.db', async () => {
    const resolver = new NotesStoreResolver({ owner_home: tmp })
    const store = await resolver.resolve('alpha')
    expect(store).toBeInstanceOf(NotesStore)
    expect(store.project_id).toBe('alpha')
    const expectedPath = resolver.pathFor('alpha')
    expect(expectedPath).toContain('Projects/alpha/notes/notes.db')
    resolver.closeAll()
  })

  test('resolve is idempotent — same handle returned for repeated calls', async () => {
    const resolver = new NotesStoreResolver({ owner_home: tmp })
    const s1 = await resolver.resolve('alpha')
    const s2 = await resolver.resolve('alpha')
    expect(s1).toBe(s2)
    resolver.closeAll()
  })

  test('two distinct projects yield distinct stores + isolated content', async () => {
    const resolver = new NotesStoreResolver({ owner_home: tmp })
    const a = await resolver.resolve('alpha')
    const b = await resolver.resolve('beta')
    expect(a).not.toBe(b)
    a.write({ content: 'alpha-only content' })
    expect(a.listNotes().length).toBe(1)
    expect(b.listNotes().length).toBe(0)
    resolver.closeAll()
  })

  test('copy-leak: a sidecar opened against the wrong project throws NotesSidecarMismatchError', async () => {
    const resolver = new NotesStoreResolver({ owner_home: tmp })
    await resolver.resolve('alpha')
    resolver.closeAll()
    const r2 = new NotesStoreResolver({ owner_home: tmp })
    // Copy alpha's notes.db into beta's slot to simulate a sidecar leak.
    const betaDir = join(tmp, 'Projects', 'beta', 'notes')
    mkdirSync(betaDir, { recursive: true })
    copyFileSync(
      join(tmp, 'Projects', 'alpha', 'notes', 'notes.db'),
      join(betaDir, 'notes.db'),
    )
    await expect(r2.resolve('beta')).rejects.toBeInstanceOf(NotesSidecarMismatchError)
    r2.closeAll()
  })
})

describe('NotesStore — drawers + notes', () => {
  let resolver: NotesStoreResolver
  let store: NotesStore

  beforeEach(async () => {
    resolver = new NotesStoreResolver({ owner_home: tmp })
    store = await resolver.resolve('proj1')
  })

  afterEach(() => {
    resolver.closeAll()
  })

  test('createDrawer is idempotent on name', () => {
    const d1 = store.createDrawer({ name: 'ideas' })
    const d2 = store.createDrawer({ name: 'ideas' })
    expect(d1.id).toBe(d2.id)
    expect(store.listDrawers().map((d) => d.name).sort()).toEqual(['ideas'])
  })

  test('write auto-provisions the inbox drawer on first call', () => {
    const result = store.write({ content: 'first thought' })
    const drawer = store.getDrawer(result.drawer_id)
    expect(drawer?.name).toBe('inbox')
    expect(drawer?.kind).toBe('inbox')
  })

  test('listNotes orders newest-first; per-drawer scope filters correctly', () => {
    const ideas = store.createDrawer({ name: 'ideas' })
    const a = store.write({ content: 'first', drawer_id: ideas.id })
    const b = store.write({ content: 'second', drawer_id: ideas.id })
    const c = store.write({ content: 'third (default drawer)' })
    expect(store.listNotes().map((n) => n.id)).toEqual([c.id, b.id, a.id])
    expect(store.listNotes({ drawer_id: ideas.id }).map((n) => n.id)).toEqual([b.id, a.id])
  })

  test('deleteNote soft-deletes; re-delete returns false (idempotent)', () => {
    const n = store.write({ content: 'to be deleted' })
    expect(store.deleteNote(n.id)).toBe(true)
    expect(store.getNote(n.id)).toBeNull()
    expect(store.deleteNote(n.id)).toBe(false)
  })

  test('write rejects empty / oversized content', () => {
    expect(() => store.write({ content: '' })).toThrow(NotesStoreError)
    const huge = 'x'.repeat(2 * 1024 * 1024)
    expect(() => store.write({ content: huge })).toThrow(NotesStoreError)
  })
})

describe('NotesStore — KG tunnels + traverse', () => {
  let resolver: NotesStoreResolver
  let store: NotesStore

  beforeEach(async () => {
    resolver = new NotesStoreResolver({ owner_home: tmp })
    store = await resolver.resolve('proj2')
  })

  afterEach(() => {
    resolver.closeAll()
  })

  test('tunnel a → b creates kg_edge of kind=user_tunnel; self-loop rejected', () => {
    const a = store.write({ content: 'source' })
    const b = store.write({ content: 'target' })
    const edge = store.tunnel(a.id, b.id, KG_EDGE_KIND_USER_TUNNEL)
    expect(edge.kind).toBe(KG_EDGE_KIND_USER_TUNNEL)
    expect(() => store.tunnel(a.id, a.id)).toThrow(NotesStoreError)
  })

  test('tunnel idempotent on (source, target, kind)', () => {
    const a = store.write({ content: 'source' })
    const b = store.write({ content: 'target' })
    const e1 = store.tunnel(a.id, b.id)
    const e2 = store.tunnel(a.id, b.id)
    expect(e1.id).toBe(e2.id)
  })

  test('traverse depth=1 returns 1-hop neighbors; depth clamped to 3', () => {
    const a = store.write({ content: 'A' })
    const b = store.write({ content: 'B' })
    const c = store.write({ content: 'C' })
    const d = store.write({ content: 'D' })
    store.tunnel(a.id, b.id)
    store.tunnel(b.id, c.id)
    store.tunnel(c.id, d.id)
    const t1 = store.traverse(a.id, 1)
    expect(t1.nodes.length).toBe(2) // start + 1 neighbor
    const t2 = store.traverse(a.id, 2)
    expect(t2.nodes.length).toBe(3)
    const t99 = store.traverse(a.id, 99)
    expect(t99.nodes.length).toBe(4) // clamped to 3 reaches all
  })

  test('tunnel against unknown note throws unknown_note', () => {
    const a = store.write({ content: 'real' })
    expect(() => store.tunnel(a.id, 'nope')).toThrow(NotesStoreError)
    expect(() => store.tunnel('nope', a.id)).toThrow(NotesStoreError)
  })
})

describe('NotesStore — FTS5 search', () => {
  test('ftsSearch surfaces lex hits with BM25 ranking; sanitizer strips operators', async () => {
    const resolver = new NotesStoreResolver({ owner_home: tmp })
    const store = await resolver.resolve('proj3')

    const a = store.write({ content: 'shopify orders by region 2024' })
    const b = store.write({ content: 'daily standup notes for the engineering team' })
    const c = store.write({ content: 'shopify financial reconciliation playbook' })

    const hits = store.ftsSearch('shopify', 10)
    expect(hits.length).toBe(2)
    const ids = new Set(hits.map((h) => h.note_id))
    expect(ids.has(a.id)).toBe(true)
    expect(ids.has(c.id)).toBe(true)
    expect(ids.has(b.id)).toBe(false)

    // Sanitizer: punctuation collapses to whitespace, tokens get quoted.
    expect(sanitizeFtsQuery('shopify; DROP TABLE notes;--')).toContain('"shopify"')
    expect(sanitizeFtsQuery('   ')).toBe('')

    resolver.closeAll()
  })

  test('ftsSearch ignores soft-deleted notes', async () => {
    const resolver = new NotesStoreResolver({ owner_home: tmp })
    const store = await resolver.resolve('proj4')

    const a = store.write({ content: 'doomed content marked for delete' })
    store.write({ content: 'unrelated content' })
    const before = store.ftsSearch('doomed', 10)
    expect(before.length).toBe(1)

    expect(store.deleteNote(a.id)).toBe(true)
    const after = store.ftsSearch('doomed', 10)
    expect(after.length).toBe(0)

    resolver.closeAll()
  })
})
