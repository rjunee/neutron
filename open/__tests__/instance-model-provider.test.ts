import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SqliteProjectSettingsStore } from '@neutronai/gateway/projects/sqlite-store.ts'
import { createModelProviderResolver } from '@neutronai/gateway/wiring/model-provider-resolution.ts'
import { writeInstanceModelProvider, initializeInstanceModelProvider } from '@neutronai/gateway/storage/owner-metadata.ts'

const dirs: string[] = []
const databases: ProjectDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'provider-config-'))
  dirs.push(dir)
  const path = join(dir, 'instance.db')
  seedMigratedDb(path)
  const db = ProjectDb.open(path)
  databases.push(db)
  const projects = new SqliteProjectSettingsStore(db)
  return { db, path, projects, resolve: createModelProviderResolver(db, 'owner', projects) }
}

test('live instance changes preserve explicit projects and isolate two provisioned instances', async () => {
  const one = fixture()
  const two = fixture()
  for (const id of ['follows', 'explicit']) await one.projects.update('owner', id, { name: id })
  expect(one.resolve('follows')).toEqual({ provider: 'anthropic', source: 'application' })
  await one.projects.update('owner', 'explicit', { model_provider: 'anthropic' })
  // Execute the provisioning producer against the second database while the first remains open.
  const proc = Bun.spawn(['bun', 'open/instance-model-provider.ts', two.path, 'owner', 'openai-codex'], { stdout: 'pipe', stderr: 'pipe' })
  expect(await proc.exited).toBe(0)
  expect(await new Response(proc.stdout).text()).toContain('written')
  expect(two.resolve()).toEqual({ provider: 'openai-codex', source: 'instance' })
  expect(one.resolve()).toEqual({ provider: 'anthropic', source: 'application' })
  expect(await writeInstanceModelProvider(one.db, 'owner', 'openai-codex')).toBe('written')
  expect(await writeInstanceModelProvider(one.db, 'owner', 'openai-codex')).toBe('unchanged')
  expect(one.resolve('follows')).toEqual({ provider: 'openai-codex', source: 'instance' })
  expect(one.resolve('explicit')).toEqual({ provider: 'anthropic', source: 'project' })
  await writeInstanceModelProvider(one.db, 'owner', 'openai')
  expect(one.resolve('follows')).toEqual({ provider: 'openai', source: 'instance' })
  expect(one.resolve('explicit')).toEqual({ provider: 'anthropic', source: 'project' })
  await one.projects.update('owner', 'explicit', { model_provider: null })
  expect(one.resolve('explicit')).toEqual({ provider: 'openai', source: 'instance' })
  await writeInstanceModelProvider(one.db, 'owner', null)
  expect(one.resolve('explicit')).toEqual({ provider: 'anthropic', source: 'application' })
})

test('database refuses an invalid instance selection and retains the previous choice', async () => {
  const { db, resolve } = fixture()
  await writeInstanceModelProvider(db, 'owner', 'openai-codex')
  await expect(writeInstanceModelProvider(db, 'owner', 'misspelled')).rejects.toThrow()
  expect(resolve()).toEqual({ provider: 'openai-codex', source: 'instance' })
})

test('legacy provisioning imports once and never overwrites an explicit inherit on restart', async () => {
  const { db, resolve } = fixture()
  await initializeInstanceModelProvider(db, 'owner', 'openai-codex')
  expect(resolve()).toEqual({ provider: 'openai-codex', source: 'instance' })
  await writeInstanceModelProvider(db, 'owner', null)
  await initializeInstanceModelProvider(db, 'owner', 'openai-codex')
  expect(resolve()).toEqual({ provider: 'anthropic', source: 'application' })
})

test('explicit inheritance on a fresh instance is recorded before legacy import', async () => {
  const { db, resolve } = fixture()
  expect(await writeInstanceModelProvider(db, 'owner', null)).toBe('written')
  await initializeInstanceModelProvider(db, 'owner', 'openai-codex')
  expect(resolve()).toEqual({ provider: 'anthropic', source: 'application' })
})

test('provisioning refuses incomplete arguments before opening a database', async () => {
  const proc = Bun.spawn(['bun', 'open/instance-model-provider.ts'], { stdout: 'pipe', stderr: 'pipe' })
  expect(await proc.exited).not.toBe(0)
  expect(await new Response(proc.stderr).text()).toContain('Expected database, instance, provider')
})
