import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'

import { CoreInstallationsStore } from '../installations-store.ts'

let tmp: string
let dbPath: string
let projectDb: ProjectDb
let store: CoreInstallationsStore
let now = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cores-runtime-installs-'))
  dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  now = 1_000_000
  store = new CoreInstallationsStore({ db: projectDb, now: () => now })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('record + get round-trip for tables layout', async () => {
  const rec = await store.record({
    project_slug: 't1',
    core_slug: 'tasks',
    package_name: '@neutronai/tasks',
    package_version: '0.1.0',
    capabilities: ['read:project.db', 'write:project.db'],
    data_layout: 'tables',
  })
  expect(rec.installed_at).toBe(1_000_000)
  expect(rec.uninstalled_at).toBeNull()
  expect(rec.data_layout).toBe('tables')
  expect(rec.sidecar_db_path).toBeNull()
  expect(rec.capabilities).toEqual(['read:project.db', 'write:project.db'])

  const got = await store.get('t1', 'tasks')
  expect(got?.package_version).toBe('0.1.0')
})

test('record sidecar layout requires sidecar_db_path', async () => {
  await expect(
    store.record({
      project_slug: 't1',
      core_slug: 'dtc',
      package_name: '@neutronai/dtc-analytics',
      package_version: '0.1.0',
      capabilities: ['read:dtc.db', 'write:dtc.db'],
      data_layout: 'sidecar',
    }),
  ).rejects.toThrow(/sidecar_db_path/)
})

test('record tables layout rejects sidecar_db_path', async () => {
  await expect(
    store.record({
      project_slug: 't1',
      core_slug: 'x',
      package_name: '@x/x',
      package_version: '1.0.0',
      capabilities: [],
      data_layout: 'tables',
      sidecar_db_path: '/some/path.db',
    }),
  ).rejects.toThrow(/must NOT supply sidecar_db_path/)
})

test('listForProject + listLive', async () => {
  await store.record({
    project_slug: 't1', core_slug: 'a', package_name: '@x/a', package_version: '1.0.0',
    capabilities: [], data_layout: 'tables',
  })
  now = 1_000_100
  await store.record({
    project_slug: 't1', core_slug: 'b', package_name: '@x/b', package_version: '1.0.0',
    capabilities: [], data_layout: 'tables',
  })
  now = 1_000_200
  await store.markUninstalled('t1', 'a')

  const all = await store.listForProject('t1')
  expect(all.map((r) => r.core_slug)).toEqual(['a', 'b'])
  const live = await store.listLive('t1')
  expect(live.map((r) => r.core_slug)).toEqual(['b'])
})

test('lifecycle markers update timestamps', async () => {
  await store.record({
    project_slug: 't1', core_slug: 'a', package_name: '@x/a', package_version: '1.0.0',
    capabilities: [], data_layout: 'tables',
  })
  now = 1_000_100
  await store.markConfigured('t1', 'a')
  now = 1_000_200
  await store.markStarted('t1', 'a')
  now = 1_000_300
  await store.markStopped('t1', 'a')

  const got = await store.get('t1', 'a')
  expect(got?.configured_at).toBe(1_000_100)
  expect(got?.started_at).toBe(1_000_200)
  expect(got?.stopped_at).toBe(1_000_300)
})

test('updateVersion rolls forward package_version + capabilities', async () => {
  await store.record({
    project_slug: 't1', core_slug: 'a', package_name: '@x/a', package_version: '1.0.0',
    capabilities: ['read:project.db'], data_layout: 'tables',
  })
  await store.updateVersion({
    project_slug: 't1', core_slug: 'a',
    package_version: '1.1.0',
    capabilities: ['read:project.db', 'write:project.db'],
  })
  const got = await store.get('t1', 'a')
  expect(got?.package_version).toBe('1.1.0')
  expect(got?.capabilities).toEqual(['read:project.db', 'write:project.db'])
})

test('record after markUninstalled re-installs with cleared lifecycle markers', async () => {
  await store.record({
    project_slug: 't1', core_slug: 'a', package_name: '@x/a', package_version: '1.0.0',
    capabilities: ['read:project.db'], data_layout: 'tables',
  })
  now = 1_000_100
  await store.markStarted('t1', 'a')
  now = 1_000_200
  await store.markUninstalled('t1', 'a')

  now = 1_000_500
  const re = await store.record({
    project_slug: 't1', core_slug: 'a', package_name: '@x/a', package_version: '1.2.0',
    capabilities: ['read:project.db', 'write:project.db'], data_layout: 'tables',
  })
  expect(re.installed_at).toBe(1_000_500)
  expect(re.uninstalled_at).toBeNull()
  expect(re.started_at).toBeNull()
  expect(re.package_version).toBe('1.2.0')
})

test('get returns null for unknown core', async () => {
  expect(await store.get('t1', 'nope')).toBeNull()
})

// ── GLOBAL scope CRUD (WAVE 3 PR-2) ────────────────────────────────────────

test('recordGlobal + getGlobal round-trip', async () => {
  const rec = await store.recordGlobal({
    core_slug: 'admin',
    package_name: '@neutronai/admin',
    package_version: '2.0.0',
    capabilities: ['read:project.db'],
  })
  expect(rec.core_slug).toBe('admin')
  expect(rec.installed_at).toBe(1_000_000)
  expect(rec.uninstalled_at).toBeNull()
  expect(rec.install_state).toBe('install_ok')
  expect(rec.capabilities).toEqual(['read:project.db'])

  const got = await store.getGlobal('admin')
  expect(got?.package_version).toBe('2.0.0')
})

test('global installs are SEPARATE from per-project installs (no key collision)', async () => {
  await store.record({
    project_slug: 't1',
    core_slug: 'notes',
    package_name: '@neutronai/notes',
    package_version: '1.0.0',
    capabilities: [],
    data_layout: 'tables',
  })
  await store.recordGlobal({
    core_slug: 'notes',
    package_name: '@neutronai/notes',
    package_version: '1.0.0',
    capabilities: [],
  })
  // Per-project read sees its row; global read sees its own; neither pollutes
  // the other.
  expect((await store.listLive('t1')).map((r) => r.core_slug)).toEqual(['notes'])
  expect((await store.listGlobalLive()).map((r) => r.core_slug)).toEqual(['notes'])
})

test('listGlobalLive excludes tombstoned installs; re-install via UPSERT revives', async () => {
  await store.recordGlobal({
    core_slug: 'admin',
    package_name: '@neutronai/admin',
    package_version: '1.0.0',
    capabilities: [],
  })
  await store.markGlobalUninstalled('admin')
  expect(await store.listGlobalLive()).toHaveLength(0)
  // getGlobal still returns the tombstone row.
  expect((await store.getGlobal('admin'))?.uninstalled_at).toBe(1_000_000)

  // Re-install reuses the PK and clears the tombstone.
  now = 2_000_000
  const revived = await store.recordGlobal({
    core_slug: 'admin',
    package_name: '@neutronai/admin',
    package_version: '1.1.0',
    capabilities: [],
  })
  expect(revived.uninstalled_at).toBeNull()
  expect(revived.installed_at).toBe(2_000_000)
  expect(revived.package_version).toBe('1.1.0')
  expect((await store.listGlobalLive()).map((r) => r.core_slug)).toEqual(['admin'])
})

test('getGlobal returns null for an unknown global core', async () => {
  expect(await store.getGlobal('nope')).toBeNull()
})

test('markGlobalUninstalled is a no-op for an unknown core', async () => {
  await store.markGlobalUninstalled('nope')
  expect(await store.listGlobal()).toHaveLength(0)
})
