import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SecretsStore } from '../secrets-store.ts'
import { ApiKeyStore } from '../api-key-store.ts'
import { buildBYOApiKeyPool } from '../byo-api-key-fallback.ts'
import { selectCredential } from '@neutronai/runtime/credential-pool.ts'

let workdir: string
let db: ProjectDb
let dataDir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-byo-'))
  dataDir = join(workdir, 'project')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(workdir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

test('returns null when the project has no BYO key for the requested provider', async () => {
  const secrets = new SecretsStore({ data_dir: dataDir, db })
  const api_keys = new ApiKeyStore({ db, secrets })
  const pool = await buildBYOApiKeyPool({
    owner_handle: asOwnerHandle('alice'),
    provider: 'anthropic',
    api_keys,
  })
  expect(pool).toBeNull()
})

test('builds a credential pool with one entry per stored key and exposes plaintext to selectCredential', async () => {
  const secrets = new SecretsStore({ data_dir: dataDir, db })
  const api_keys = new ApiKeyStore({ db, secrets })
  await api_keys.add({
    owner_handle: asOwnerHandle('alice'),
    provider: 'anthropic',
    label: 'k1',
    plaintext: 'sk-ant-1',
  })
  await api_keys.add({
    owner_handle: asOwnerHandle('alice'),
    provider: 'anthropic',
    label: 'k2',
    plaintext: 'sk-ant-2',
  })
  const pool = await buildBYOApiKeyPool({
    owner_handle: asOwnerHandle('alice'),
    provider: 'anthropic',
    api_keys,
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  expect(pool.credentials).toHaveLength(2)
  const seen = new Set<string>()
  for (let i = 0; i < 2; i++) {
    const sel = selectCredential(pool)
    expect(sel).not.toBeNull()
    if (sel !== null) {
      seen.add(sel.secret)
    }
  }
  expect(seen.has('sk-ant-1')).toBe(true)
  expect(seen.has('sk-ant-2')).toBe(true)
})

test('only includes the requested provider', async () => {
  const secrets = new SecretsStore({ data_dir: dataDir, db })
  const api_keys = new ApiKeyStore({ db, secrets })
  await api_keys.add({ owner_handle: asOwnerHandle('alice'), provider: 'anthropic', label: 'a', plaintext: 'a' })
  await api_keys.add({ owner_handle: asOwnerHandle('alice'), provider: 'openai', label: 'b', plaintext: 'b' })
  const pool = await buildBYOApiKeyPool({
    owner_handle: asOwnerHandle('alice'),
    provider: 'anthropic',
    api_keys,
  })
  expect(pool).not.toBeNull()
  expect(pool?.credentials).toHaveLength(1)
  expect(pool?.credentials[0]?.id).toBe('anthropic:a')
})
