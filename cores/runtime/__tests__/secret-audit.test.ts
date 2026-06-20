import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import type { PlatformSecretsStore } from '@neutronai/cores-sdk'

import { SecretAuditLog, buildAuditedSecretsStore } from '../secret-audit.ts'

let tmp: string
let dbPath: string
let projectDb: ProjectDb
let audit: SecretAuditLog
let now = 2_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cores-runtime-audit-'))
  dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  now = 2_000_000
  audit = new SecretAuditLog({ db: projectDb, now: () => now })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('record + list round-trip', async () => {
  await audit.record({
    project_slug: 't1', core_slug: 'tasks', op: 'get',
    kind: 'oauth_token', label: 'google', outcome: 'ok',
  })
  now = 2_000_100
  await audit.record({
    project_slug: 't1', core_slug: 'tasks', op: 'put',
    kind: 'byo_api_key', label: 'shopify', outcome: 'capability_denied',
    error: 'core did not declare secret',
  })
  const rows = await audit.list({ project_slug: 't1', core_slug: 'tasks' })
  expect(rows.length).toBe(2)
  expect(rows[0]?.ts).toBe(2_000_100)
  expect(rows[0]?.outcome).toBe('capability_denied')
  expect(rows[0]?.error).toBe('core did not declare secret')
  expect(rows[1]?.outcome).toBe('ok')
})

test('listDenied filters non-ok rows', async () => {
  await audit.record({ project_slug: 't1', core_slug: 'a', op: 'get',
    kind: 'oauth_token', label: 'google', outcome: 'ok' })
  await audit.record({ project_slug: 't1', core_slug: 'a', op: 'get',
    kind: 'byo_api_key', label: 'stripe', outcome: 'capability_denied' })
  await audit.record({ project_slug: 't1', core_slug: 'a', op: 'get',
    kind: 'byo_api_key', label: 'shopify', outcome: 'not_found' })

  const denied = await audit.listDenied({ project_slug: 't1' })
  expect(denied).toHaveLength(1)
  expect(denied[0]?.label).toBe('stripe')
})

test('recordToolCall writes op=tool_call kind=tool', async () => {
  await audit.recordToolCall({
    project_slug: 't1', core_slug: 'tasks', tool_name: 'list_tasks',
    outcome: 'capability_denied', error: 'no manifest entry',
  })
  const rows = await audit.list({ project_slug: 't1' })
  expect(rows[0]?.op).toBe('tool_call')
  expect(rows[0]?.kind).toBe('tool')
  expect(rows[0]?.label).toBe('list_tasks')
  expect(rows[0]?.outcome).toBe('capability_denied')
})

test('list filters by project when no core_slug supplied', async () => {
  await audit.record({ project_slug: 't1', core_slug: 'a', op: 'get',
    kind: 'oauth_token', label: 'google', outcome: 'ok' })
  await audit.record({ project_slug: 't2', core_slug: 'a', op: 'get',
    kind: 'oauth_token', label: 'google', outcome: 'ok' })
  const rows = await audit.list({ project_slug: 't1' })
  expect(rows).toHaveLength(1)
})

class FakePlatformStore implements PlatformSecretsStore {
  rows = new Map<string, { id: string; plaintext: string; expires_at?: number }>()
  nextId = 1
  failNext = false
  async get(input: { internal_handle: string; kind: string; label: string }): Promise<string | null> {
    if (this.failNext) { this.failNext = false; throw new Error('boom') }
    const r = this.rows.get(`${input.internal_handle}:${input.kind}:${input.label}`)
    return r?.plaintext ?? null
  }
  async put(input: { internal_handle: string; kind: string; label: string; plaintext: string; expires_at?: number }): Promise<{ id: string }> {
    const k = `${input.internal_handle}:${input.kind}:${input.label}`
    if (this.rows.has(k)) throw new Error('duplicate_label')
    const id = `id-${this.nextId++}`
    const row: { id: string; plaintext: string; expires_at?: number } = { id, plaintext: input.plaintext }
    if (input.expires_at !== undefined) row.expires_at = input.expires_at
    this.rows.set(k, row)
    return { id }
  }
  async list(input: { internal_handle: string; kind?: string }): Promise<Array<{ id: string; kind: string; label: string }>> {
    const out: Array<{ id: string; kind: string; label: string }> = []
    for (const [k, v] of this.rows) {
      const [t, kind, label] = k.split(':') as [string, string, string]
      if (t !== input.internal_handle) continue
      if (input.kind !== undefined && kind !== input.kind) continue
      out.push({ id: v.id, kind, label })
    }
    return out
  }
  async rotate(id: string, new_plaintext: string, options?: { expires_at?: number }): Promise<void> {
    for (const [k, v] of this.rows) {
      if (v.id === id) {
        const next: { id: string; plaintext: string; expires_at?: number } = { id, plaintext: new_plaintext }
        if (options?.expires_at !== undefined) next.expires_at = options.expires_at
        this.rows.set(k, next)
        return
      }
    }
    throw new Error('not_found')
  }
}

test('buildAuditedSecretsStore writes ok-row on get', async () => {
  const store = new FakePlatformStore()
  await store.put({ internal_handle: 't1', kind: 'oauth_token', label: 'google', plaintext: 'tok' })
  const wrapped = buildAuditedSecretsStore(store, { audit, project_slug: 't1', core_slug: 'tasks' })
  const got = await wrapped.get({ internal_handle: 't1', kind: 'oauth_token', label: 'google' })
  expect(got).toBe('tok')
  const rows = await audit.list({ project_slug: 't1', core_slug: 'tasks' })
  // 1 row from the put (which wasn't audited — direct call) + 1 row from get
  // Actually: only the wrapped get is audited.
  expect(rows.some((r) => r.op === 'get' && r.outcome === 'ok' && r.label === 'google')).toBe(true)
})

test('buildAuditedSecretsStore writes not_found on missing', async () => {
  const store = new FakePlatformStore()
  const wrapped = buildAuditedSecretsStore(store, { audit, project_slug: 't1', core_slug: 'tasks' })
  expect(await wrapped.get({ internal_handle: 't1', kind: 'oauth_token', label: 'google' })).toBeNull()
  const rows = await audit.list({ project_slug: 't1', core_slug: 'tasks' })
  expect(rows[0]?.op).toBe('get')
  expect(rows[0]?.outcome).toBe('not_found')
})

test('buildAuditedSecretsStore writes error row + rethrows', async () => {
  const store = new FakePlatformStore()
  store.failNext = true
  const wrapped = buildAuditedSecretsStore(store, { audit, project_slug: 't1', core_slug: 'tasks' })
  await expect(wrapped.get({ internal_handle: 't1', kind: 'oauth_token', label: 'google' })).rejects.toThrow('boom')
  const rows = await audit.list({ project_slug: 't1', core_slug: 'tasks' })
  expect(rows[0]?.outcome).toBe('error')
  expect(rows[0]?.error).toBe('boom')
})

test('buildAuditedSecretsStore audits put + rotate', async () => {
  const store = new FakePlatformStore()
  const wrapped = buildAuditedSecretsStore(store, { audit, project_slug: 't1', core_slug: 'tasks' })
  await wrapped.put({ internal_handle: 't1', kind: 'oauth_token', label: 'google', plaintext: 'tok' })
  await wrapped.rotate?.('id-1', 'tok2')
  const rows = await audit.list({ project_slug: 't1' })
  expect(rows.find((r) => r.op === 'put' && r.outcome === 'ok')).toBeDefined()
  expect(rows.find((r) => r.op === 'rotate' && r.outcome === 'ok')).toBeDefined()
})

test('buildAuditedSecretsStore audits list call', async () => {
  const store = new FakePlatformStore()
  const wrapped = buildAuditedSecretsStore(store, { audit, project_slug: 't1', core_slug: 'tasks' })
  await wrapped.list({ internal_handle: 't1' })
  const rows = await audit.list({ project_slug: 't1' })
  expect(rows[0]?.op).toBe('list')
  expect(rows[0]?.outcome).toBe('ok')
  expect(rows[0]?.label).toBe('*')
})

// ── Multi-author attribution (connect-spec §4.3 layer 3) ──────────────────

test('record stamps the log default author_id', async () => {
  const ownerAudit = new SecretAuditLog({ db: projectDb, now: () => now, author_id: 'owner' })
  await ownerAudit.record({
    project_slug: 't1', core_slug: 'tasks', op: 'get',
    kind: 'oauth_token', label: 'google', outcome: 'ok',
  })
  const rows = await ownerAudit.list({ project_slug: 't1' })
  expect(rows[0]?.author_id).toBe('owner')
})

test('per-call author_id overrides the log default', async () => {
  const ownerAudit = new SecretAuditLog({ db: projectDb, now: () => now, author_id: 'owner' })
  await ownerAudit.record({
    project_slug: 't1', core_slug: 'tasks', op: 'get',
    kind: 'oauth_token', label: 'google', outcome: 'ok', author_id: 'alice',
  })
  const rows = await ownerAudit.list({ project_slug: 't1' })
  expect(rows[0]?.author_id).toBe('alice')
})

test('author_id is null when neither default nor per-call author is set', async () => {
  await audit.record({
    project_slug: 't1', core_slug: 'tasks', op: 'get',
    kind: 'oauth_token', label: 'google', outcome: 'ok',
  })
  const rows = await audit.list({ project_slug: 't1' })
  expect(rows[0]?.author_id).toBeNull()
})

test('recordToolCall carries per-call author_id', async () => {
  await audit.recordToolCall({
    project_slug: 't1', core_slug: 'tasks', tool_name: 'create_event',
    outcome: 'ok', author_id: 'bob',
  })
  const rows = await audit.list({ project_slug: 't1' })
  expect(rows[0]?.op).toBe('tool_call')
  expect(rows[0]?.author_id).toBe('bob')
})

test('buildAuditedSecretsStore stamps the log default author on get rows', async () => {
  const ownerAudit = new SecretAuditLog({ db: projectDb, now: () => now, author_id: 'owner' })
  const store = new FakePlatformStore()
  await store.put({ internal_handle: 't1', kind: 'oauth_token', label: 'google', plaintext: 'tok' })
  const wrapped = buildAuditedSecretsStore(store, { audit: ownerAudit, project_slug: 't1', core_slug: 'tasks' })
  await wrapped.get({ internal_handle: 't1', kind: 'oauth_token', label: 'google' })
  const rows = await ownerAudit.list({ project_slug: 't1', core_slug: 'tasks' })
  expect(rows.find((r) => r.op === 'get')?.author_id).toBe('owner')
})

test('audit log respects limit', async () => {
  for (let i = 0; i < 5; i++) {
    now = 2_000_000 + i
    await audit.record({ project_slug: 't1', core_slug: 'a', op: 'get',
      kind: 'oauth_token', label: `lbl-${i}`, outcome: 'ok' })
  }
  const rows = await audit.list({ project_slug: 't1', limit: 2 })
  expect(rows).toHaveLength(2)
  expect(rows[0]?.label).toBe('lbl-4')
  expect(rows[1]?.label).toBe('lbl-3')
})
