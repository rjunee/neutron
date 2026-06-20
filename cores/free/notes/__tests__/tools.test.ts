/**
 * @neutronai/notes — tools.ts capability-gated dispatch tests.
 *
 * v0.2.0 rewrite (Notes Core S1): the four legacy tools (notes_write /
 * notes_recall / notes_list / notes_link) now route through
 * `buildNotesStoreBackend(resolver, default_project_id)` against a
 * per-project NotesStore over real SQLite. The v0.1.0 `MemoryStore`
 * fake is gone with the dependency.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import {
  CapabilityDeniedError,
  CapabilityGuard,
  SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'

import {
  buildNotesStoreBackend,
  buildTools,
  loadManifest,
  NotesStoreResolver,
} from '../index.ts'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog
let resolver: NotesStoreResolver
const OWNER = 't1'
const PROJECT = 'p-default'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'notes-tools-'))
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

function buildToolsForTest(opts?: { manifest?: NeutronManifest }) {
  const manifest = opts?.manifest ?? loadManifest()
  const backend = buildNotesStoreBackend({
    resolver,
    default_project_id: PROJECT,
  })
  return buildTools({
    manifest,
    project_slug: OWNER,
    audit,
    backend,
  })
}

describe('buildTools — capability-gated dispatch', () => {
  test('notes_write → notes_recall round-trip through the NotesStore backend', async () => {
    const tools = buildToolsForTest()

    const w1 = await tools.notes_write({
      content: 'first idea: AI agents that fix bugs autonomously',
    })
    expect(typeof w1.id).toBe('string')
    expect(w1.id.length).toBeGreaterThan(0)

    const w2 = await tools.notes_write({
      content: 'shopify CM dashboard plan — daily roll-up',
      tags: ['cores', 'analytics'],
    })

    // Recall by substring lex query (FTS5 BM25).
    const r = await tools.notes_recall({ query: 'shopify' })
    expect(r.results.length).toBeGreaterThanOrEqual(1)
    expect(r.results.some((row) => row.id === w2.id)).toBe(true)
    const shopify = r.results.find((row) => row.id === w2.id)
    expect(shopify?.content).toContain('shopify')
    expect(shopify?.metadata['tags']).toEqual(['cores', 'analytics'])
    expect(shopify?.metadata['kind']).toBe('notes.note')

    // Audit log captured at least three success rows (two writes + recall).
    const auditRows = await audit.list({ project_slug: OWNER, core_slug: 'notes' })
    const successRows = auditRows.filter((row) => row.outcome === 'ok')
    expect(successRows.length).toBeGreaterThanOrEqual(3)
    const toolNames = new Set(successRows.map((row) => row.label))
    expect(toolNames.has('notes_write')).toBe(true)
    expect(toolNames.has('notes_recall')).toBe(true)
    void w1
  })

  test('notes_list returns recent entries newest-first; limit cap honored', async () => {
    const tools = buildToolsForTest()
    const a = await tools.notes_write({ content: 'note a' })
    const b = await tools.notes_write({ content: 'note b' })
    const c = await tools.notes_write({ content: 'note c' })

    const all = await tools.notes_list({})
    const ids = all.results.map((r) => r.id)
    expect(ids).toEqual([c.id, b.id, a.id])

    const capped = await tools.notes_list({ limit: 2 })
    expect(capped.results.map((r) => r.id)).toEqual([c.id, b.id])
  })

  test('notes_link persists a KG edge; recall / list still surface authored notes only', async () => {
    const tools = buildToolsForTest()
    const a = await tools.notes_write({ content: 'first note' })
    const b = await tools.notes_write({ content: 'second note' })
    const link = await tools.notes_link({ source_id: a.id, target_id: b.id })
    expect(link.ok).toBe(true)
    expect(typeof link.link_id).toBe('string')

    // The edge id is NOT a note id; recall / list must continue to
    // return only the two authored notes.
    const recalled = await tools.notes_recall({ query: 'note' })
    const recalledIds = new Set(recalled.results.map((r) => r.id))
    expect(recalledIds.has(a.id)).toBe(true)
    expect(recalledIds.has(b.id)).toBe(true)
    expect(recalledIds.has(link.link_id)).toBe(false)

    const listed = await tools.notes_list({})
    expect(listed.results.map((r) => r.id)).toEqual([b.id, a.id])
  })

  test('capability gate: missing write capability denies notes_write / notes_link', async () => {
    const m0 = loadManifest()
    const downgraded: NeutronManifest = {
      ...m0,
      capabilities: m0.capabilities.filter((c) => c !== 'write:notes.db'),
    }
    const tools = buildToolsForTest({ manifest: downgraded })

    await expect(tools.notes_write({ content: 'x' })).rejects.toThrow(
      CapabilityDeniedError,
    )
    await expect(
      tools.notes_link({ source_id: 'a', target_id: 'b' }),
    ).rejects.toThrow(CapabilityDeniedError)

    // `notes_recall` still resolves — read gate is intact.
    const recall = await tools.notes_recall({ query: 'x' })
    expect(recall.results).toEqual([])

    const denied = await audit.listDenied({
      project_slug: OWNER,
      core_slug: 'notes',
    })
    const labels = new Set(denied.map((r) => r.label))
    expect(labels.has('notes_write')).toBe(true)
    expect(labels.has('notes_link')).toBe(true)
    expect(labels.has('notes_recall')).toBe(false)
  })

  test('capability gate: undeclared tool name is rejected by `tool_not_declared`', async () => {
    const m = loadManifest()
    const guard = new CapabilityGuard({
      manifest: m,
      core_slug: 'notes',
      project_slug: OWNER,
      audit,
    })
    const result = guard.check({
      tool_name: 'notes_unknown_tool',
      capability_required: 'write:notes.db',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('tool_not_declared')
    }
  })
})
