import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import {
  CapabilityDeniedError,
  CapabilityGuard,
  SecretAuditLog,
} from '../index.ts'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog

const MANIFEST: NeutronManifest = {
  capabilities: ['read:project.db', 'write:project.db'],
  tier_support: ['regular'],
  tools: [
    {
      name: 'list_tasks',
      description: 'list',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      capability_required: 'read:project.db',
    },
    {
      name: 'create_task',
      description: 'create',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      capability_required: 'write:project.db',
    },
  ],
  ui_components: [],
  billing_hooks: [],
  linked_sources: [],
  secrets: [],
  compat: { coreApi: '^0.1.0' },
  build: { neutronVersion: '0.1.0' },
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cores-runtime-guard-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('check returns ok for declared tool with matching capability', () => {
  const guard = new CapabilityGuard({ manifest: MANIFEST, core_slug: 'tasks', project_slug: 't1', audit })
  expect(guard.check({ tool_name: 'list_tasks', capability_required: 'read:project.db' }).ok).toBe(true)
})

test('check returns tool_not_declared for unknown tool', () => {
  const guard = new CapabilityGuard({ manifest: MANIFEST, core_slug: 'tasks', project_slug: 't1', audit })
  const r = guard.check({ tool_name: 'rogue', capability_required: 'read:project.db' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('tool_not_declared')
})

test('check returns capability_mismatch when capability_required does not match manifest', () => {
  const guard = new CapabilityGuard({ manifest: MANIFEST, core_slug: 'tasks', project_slug: 't1', audit })
  const r = guard.check({ tool_name: 'list_tasks', capability_required: 'write:project.db' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('capability_mismatch')
})

test('check returns capability_not_declared if capability is not in manifest.capabilities', () => {
  // Manifest declares list_tasks→read:project.db but doesn't declare write:gmail
  // anywhere. Build a manifest variant where the tool's capability_required
  // matches but the capabilities[] list omits it.
  const broken: NeutronManifest = {
    ...MANIFEST,
    capabilities: [], // empty
    tools: [
      {
        name: 'list_tasks',
        description: 'list',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        capability_required: 'read:project.db',
      },
    ],
  }
  const guard = new CapabilityGuard({ manifest: broken, core_slug: 'tasks', project_slug: 't1', audit })
  const r = guard.check({ tool_name: 'list_tasks', capability_required: 'read:project.db' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('capability_not_declared')
})

test('assertOrDeny throws CapabilityDeniedError + writes audit row on deny', async () => {
  const guard = new CapabilityGuard({ manifest: MANIFEST, core_slug: 'tasks', project_slug: 't1', audit })
  await expect(
    guard.assertOrDeny({ tool_name: 'rogue', capability_required: 'read:project.db' }),
  ).rejects.toThrow(CapabilityDeniedError)

  const rows = await audit.list({ project_slug: 't1' })
  expect(rows[0]?.op).toBe('tool_call')
  expect(rows[0]?.label).toBe('rogue')
  expect(rows[0]?.outcome).toBe('capability_denied')
})

test('assertOrDeny is a no-op on success (no audit row written here)', async () => {
  const guard = new CapabilityGuard({ manifest: MANIFEST, core_slug: 'tasks', project_slug: 't1', audit })
  await guard.assertOrDeny({ tool_name: 'list_tasks', capability_required: 'read:project.db' })
  const rows = await audit.list({ project_slug: 't1' })
  expect(rows).toHaveLength(0)
})

test('wrapToolHandler: success path runs handler + writes ok audit row', async () => {
  const guard = new CapabilityGuard({ manifest: MANIFEST, core_slug: 'tasks', project_slug: 't1', audit })
  const wrapped = guard.wrapToolHandler({
    tool_name: 'list_tasks',
    capability_required: 'read:project.db',
    fn: async (input: { id: number }) => ({ echo: input.id * 2 }),
  })
  const out = await wrapped({ id: 5 })
  expect(out.echo).toBe(10)
  const rows = await audit.list({ project_slug: 't1' })
  expect(rows[0]?.outcome).toBe('ok')
  expect(rows[0]?.label).toBe('list_tasks')
})

test('wrapToolHandler: deny path rejects + writes capability_denied row', async () => {
  const guard = new CapabilityGuard({ manifest: MANIFEST, core_slug: 'tasks', project_slug: 't1', audit })
  const wrapped = guard.wrapToolHandler({
    tool_name: 'rogue',
    capability_required: 'read:project.db',
    fn: async () => ({ ok: true }),
  })
  await expect(wrapped({})).rejects.toThrow(CapabilityDeniedError)
  const rows = await audit.list({ project_slug: 't1' })
  expect(rows[0]?.outcome).toBe('capability_denied')
})

test('wrapToolHandler: inner-handler throw writes error row + rethrows', async () => {
  const guard = new CapabilityGuard({ manifest: MANIFEST, core_slug: 'tasks', project_slug: 't1', audit })
  const wrapped = guard.wrapToolHandler({
    tool_name: 'list_tasks',
    capability_required: 'read:project.db',
    fn: async () => { throw new Error('inner_failure') },
  })
  await expect(wrapped({})).rejects.toThrow('inner_failure')
  const rows = await audit.list({ project_slug: 't1' })
  expect(rows[0]?.outcome).toBe('error')
  expect(rows[0]?.error).toBe('inner_failure')
})

// ── Multi-author attribution (connect-spec §4.3 layer 3) ──────────────────

test('guard stamps the triggering author_id on tool_call rows (ok + deny + error)', async () => {
  const guard = new CapabilityGuard({
    manifest: MANIFEST, core_slug: 'tasks', project_slug: 't1', audit, author_id: 'alice',
  })
  // ok path
  const ok = guard.wrapToolHandler({
    tool_name: 'list_tasks', capability_required: 'read:project.db',
    fn: async () => ({ ok: true }),
  })
  await ok({})
  // deny path
  await expect(
    guard.assertOrDeny({ tool_name: 'rogue', capability_required: 'read:project.db' }),
  ).rejects.toThrow(CapabilityDeniedError)
  // error path
  const boom = guard.wrapToolHandler({
    tool_name: 'create_task', capability_required: 'write:project.db',
    fn: async () => { throw new Error('boom') },
  })
  await expect(boom({})).rejects.toThrow('boom')

  const rows = await audit.list({ project_slug: 't1' })
  expect(rows.length).toBe(3)
  for (const r of rows) expect(r.author_id).toBe('alice')
})

test('guard without author_id leaves the audit-log default to decide attribution', async () => {
  const ownerAudit = new SecretAuditLog({ db: projectDb, author_id: 'owner' })
  const guard = new CapabilityGuard({ manifest: MANIFEST, core_slug: 'tasks', project_slug: 't1', audit: ownerAudit })
  const wrapped = guard.wrapToolHandler({
    tool_name: 'list_tasks', capability_required: 'read:project.db',
    fn: async () => ({ ok: true }),
  })
  await wrapped({})
  const rows = await ownerAudit.list({ project_slug: 't1' })
  expect(rows[0]?.author_id).toBe('owner')
})
