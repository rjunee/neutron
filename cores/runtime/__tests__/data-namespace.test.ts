import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'

import {
  CoreInstallError,
  allocateCoreNamespace,
  checkSqlNamespace,
  decideDataLayout,
  releaseCoreNamespace,
  runScopedSql,
  sidecarDbPath,
  tablePrefix,
} from '../index.ts'

let tmp: string
let dataDir: string
let projectDb: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cores-runtime-ns-'))
  dataDir = join(tmp, 'project')
  const dbPath = join(dataDir, 'project.db')
  // mkdir parent before opening
  require('node:fs').mkdirSync(dataDir, { recursive: true })
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('decideDataLayout: tables when no <slug>.db capability declared', () => {
  expect(decideDataLayout(['read:project.db', 'write:project.db'], 'tasks').layout).toBe('tables')
})

test('decideDataLayout: sidecar when read:<slug>.db declared', () => {
  expect(decideDataLayout(['read:dtc.db'], 'dtc').layout).toBe('sidecar')
})

test('decideDataLayout: sidecar when write:<slug>.db declared', () => {
  expect(decideDataLayout(['write:dtc.db'], 'dtc').layout).toBe('sidecar')
})

test('decideDataLayout: stays tables when capability is for OTHER core slug', () => {
  // a Core can't sneak into "sidecar layout" by declaring another core's capability
  expect(decideDataLayout(['read:other.db'], 'me').layout).toBe('tables')
})

test('tablePrefix shape', () => {
  expect(tablePrefix('tasks')).toBe('core_tasks_')
})

test('sidecarDbPath shape', () => {
  expect(sidecarDbPath('/data', 'dtc')).toBe('/data/cores/dtc.db')
})

test('allocateCoreNamespace tables: returns prefix + creates nothing on disk', () => {
  const ns = allocateCoreNamespace({
    project_slug: 't1', slug: 'tasks',
    manifest_capabilities: ['read:project.db'],
    dataDir, layout: 'tables',
  })
  expect(ns.layout).toBe('tables')
  if (ns.layout === 'tables') expect(ns.table_prefix).toBe('core_tasks_')
  expect(existsSync(join(dataDir, 'cores', 'tasks.db'))).toBe(false)
})

test('allocateCoreNamespace sidecar: opens new SQLite file', () => {
  const ns = allocateCoreNamespace({
    project_slug: 't1', slug: 'dtc',
    manifest_capabilities: ['read:dtc.db'],
    dataDir, layout: 'sidecar',
  })
  expect(ns.layout).toBe('sidecar')
  if (ns.layout === 'sidecar') {
    expect(ns.sidecar_db_path).toBe(join(dataDir, 'cores', 'dtc.db'))
    expect(existsSync(ns.sidecar_db_path)).toBe(true)
    ns.sidecar_db.close()
  }
})

test('releaseCoreNamespace tables: drops every core_<slug>_* table', async () => {
  // Manually create some Core tables.
  await projectDb.exec('CREATE TABLE core_tasks_items (id TEXT)')
  await projectDb.exec('CREATE TABLE core_tasks_archive (id TEXT)')
  await projectDb.exec('CREATE TABLE core_other_thing (id TEXT)')

  await releaseCoreNamespace({
    project_slug: 't1', slug: 'tasks', layout: 'tables',
    projectDb, dataDir,
  })

  const remaining = projectDb
    .raw()
    .query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'core_' || ? || '%'`,
    )
    .all('tasks_')
  expect(remaining).toHaveLength(0)

  const otherCore = projectDb
    .raw()
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='core_other_thing'`,
    )
    .get()
  expect(otherCore?.name).toBe('core_other_thing')
})

test('releaseCoreNamespace sidecar: deletes file + WAL siblings', async () => {
  const path = sidecarDbPath(dataDir, 'dtc')
  const ns = allocateCoreNamespace({
    project_slug: 't1', slug: 'dtc',
    manifest_capabilities: ['write:dtc.db'],
    dataDir, layout: 'sidecar',
  })
  if (ns.layout !== 'sidecar') throw new Error('expected sidecar')
  // Force a write so a -wal sibling shows up.
  await ns.sidecar_db.exec('CREATE TABLE x (id TEXT)')
  await ns.sidecar_db.run(`INSERT INTO x VALUES (?)`, ['a'])

  await releaseCoreNamespace({
    project_slug: 't1', slug: 'dtc', layout: 'sidecar',
    projectDb, dataDir, sidecarDb: ns.sidecar_db,
  })

  expect(existsSync(path)).toBe(false)
  expect(existsSync(`${path}-wal`)).toBe(false)
})

test('checkSqlNamespace: own prefix accepted', () => {
  const r = checkSqlNamespace({
    sql: 'CREATE TABLE core_tasks_items (id TEXT)',
    slug: 'tasks',
    manifest_capabilities: [],
  })
  expect(r.ok).toBe(true)
})

test('checkSqlNamespace: other-core prefix rejected', () => {
  const r = checkSqlNamespace({
    sql: 'SELECT * FROM core_other_secret',
    slug: 'tasks',
    manifest_capabilities: ['read:project.db'],
    other_core_slugs: ['other'],
  })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toMatch(/cross-Core access denied/)
})

test('checkSqlNamespace: project.db table requires capability', () => {
  const r = checkSqlNamespace({
    sql: 'SELECT * FROM sessions',
    slug: 'tasks',
    manifest_capabilities: [],
  })
  expect(r.ok).toBe(false)
  const ok = checkSqlNamespace({
    sql: 'SELECT * FROM sessions',
    slug: 'tasks',
    manifest_capabilities: ['read:project.db'],
  })
  expect(ok.ok).toBe(true)
})

test('checkSqlNamespace: canonical project.db capability gates shared tables (C4-a § 2.3)', () => {
  // The canonical project.db form grants the same project-shared-table
  // access as the legacy alias. Both must be accepted so a running
  // instance survives mid-migration.
  const viaProject = checkSqlNamespace({
    sql: 'SELECT * FROM sessions',
    slug: 'tasks',
    manifest_capabilities: ['read:project.db'],
  })
  expect(viaProject.ok).toBe(true)
  const viaWriteProject = checkSqlNamespace({
    sql: 'SELECT * FROM sessions',
    slug: 'tasks',
    manifest_capabilities: ['write:project.db'],
  })
  expect(viaWriteProject.ok).toBe(true)
  // Reason string now uses project vocabulary.
  const denied = checkSqlNamespace({
    sql: 'SELECT * FROM sessions',
    slug: 'tasks',
    manifest_capabilities: [],
  })
  expect(denied.ok).toBe(false)
  if (!denied.ok) expect(denied.reason).toMatch(/read:project\.db or write:project\.db/)
})

test('checkSqlNamespace: string literal containing core_other not flagged', () => {
  const r = checkSqlNamespace({
    sql: `INSERT INTO core_tasks_log (msg) VALUES ('core_other_secret')`,
    slug: 'tasks',
    manifest_capabilities: [],
  })
  expect(r.ok).toBe(true)
})

test('checkSqlNamespace: comments stripped before check', () => {
  const r = checkSqlNamespace({
    sql: `-- core_other_secret\nCREATE TABLE core_tasks_x (id TEXT)`,
    slug: 'tasks',
    manifest_capabilities: [],
  })
  expect(r.ok).toBe(true)
})

test('runScopedSql: own-prefix table create succeeds', async () => {
  await runScopedSql({
    sql: 'CREATE TABLE core_tasks_items (id TEXT)',
    params: [],
    slug: 'tasks',
    manifest_capabilities: [],
    projectDb,
  })
  const r = projectDb
    .raw()
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE name='core_tasks_items'`,
    )
    .get()
  expect(r?.name).toBe('core_tasks_items')
})

test('runScopedSql: cross-Core access throws CoreInstallError', async () => {
  await expect(
    runScopedSql({
      sql: 'SELECT * FROM core_other_secret',
      params: [],
      slug: 'tasks',
      manifest_capabilities: ['read:project.db'],
      other_core_slugs: ['other'],
      projectDb,
    }),
  ).rejects.toThrow(CoreInstallError)
})
