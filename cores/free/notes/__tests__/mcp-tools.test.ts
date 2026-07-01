/**
 * @neutronai/notes — S1 MCP tools + `buildExtraTools` wiring tests.
 *
 * Regression cover for ISSUE #330: the four S1 tools
 * (notes_create_drawer / notes_drawer_list / notes_search /
 * notes_traverse) are fully implemented in `buildNotesMcpTools` against
 * a real per-project NotesStore, but were never wired at install time
 * because the barrel did not export `buildExtraTools`. These tests
 * assert the barrel export exists, returns all four handlers, and each
 * dispatches correctly against the resolver-backed store.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { SecretAuditLog } from '@neutronai/cores-runtime'

import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'

import {
  buildExtraTools,
  loadManifest,
  NotesStoreResolver,
} from '../index.ts'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog
let resolver: NotesStoreResolver
const OWNER = 't1'
const PROJECT = 'p-s1'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'notes-mcp-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
  resolver = new NotesStoreResolver({ owner_home: tmp })
})

afterEach(() => {
  resolver.closeAll()
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

function buildExtraForTest() {
  return buildExtraTools({
    manifest: loadManifest(),
    project_slug: OWNER,
    audit,
    resolver,
  })
}

describe('buildExtraTools — S1 tool wiring (ISSUE #330)', () => {
  test('returns all four S1 handlers', () => {
    const tools = buildExtraForTest()
    expect(typeof tools.notes_create_drawer).toBe('function')
    expect(typeof tools.notes_drawer_list).toBe('function')
    expect(typeof tools.notes_search).toBe('function')
    expect(typeof tools.notes_traverse).toBe('function')
  })

  test('every declared S1 tool name has a handler (no manifest_tool_unimplemented gap)', () => {
    const tools = buildExtraForTest()
    const s1Names = [
      'notes_create_drawer',
      'notes_drawer_list',
      'notes_search',
      'notes_traverse',
    ] as const
    for (const name of s1Names) {
      expect(tools[name]).toBeDefined()
    }
  })

  test('notes_create_drawer → notes_drawer_list round-trip', async () => {
    const tools = buildExtraForTest()
    const created = await tools.notes_create_drawer({
      project_id: PROJECT,
      name: 'Research',
    })
    expect(typeof created.id).toBe('string')
    expect(created.id.length).toBeGreaterThan(0)

    const listed = await tools.notes_drawer_list({ project_id: PROJECT })
    expect(listed.drawers.some((d) => d.id === created.id && d.name === 'Research')).toBe(
      true,
    )
  })

  test('notes_search surfaces a written note via FTS', async () => {
    const tools = buildExtraForTest()
    const store = await resolver.resolve(PROJECT)
    store.write({ content: 'shopify daily roll-up dashboard plan' })

    const hits = await tools.notes_search({
      project_id: PROJECT,
      query: 'shopify',
    })
    expect(hits.results.length).toBeGreaterThanOrEqual(1)
    expect(hits.results[0]?.snippet).toContain('shopify')
  })

  test('notes_traverse resolves a user tunnel between two notes', async () => {
    const tools = buildExtraForTest()
    const store = await resolver.resolve(PROJECT)
    const a = store.write({ content: 'note alpha' })
    const b = store.write({ content: 'note beta' })
    store.tunnel(a.id, b.id)

    const result = await tools.notes_traverse({ project_id: PROJECT, from: a.id, depth: 1 })
    expect(result.nodes.length).toBeGreaterThanOrEqual(1)
    expect(result.edges.some((e) => e.kind === 'user_tunnel')).toBe(true)
  })

  test('S1 tools resolve project scope explicitly — separate projects are isolated', async () => {
    const tools = buildExtraForTest()
    await tools.notes_create_drawer({ project_id: 'proj-a', name: 'A-only' })

    const listB = await tools.notes_drawer_list({ project_id: 'proj-b' })
    expect(listB.drawers.some((d) => d.name === 'A-only')).toBe(false)
  })
})
