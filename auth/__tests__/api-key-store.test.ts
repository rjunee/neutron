import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SecretsStore } from '../secrets-store.ts'
import { ApiKeyStore, ApiKeyStoreError } from '../api-key-store.ts'

let workdir: string
let db: ProjectDb
let dataDir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-apikey-'))
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

function buildStores(now: () => number = () => 1_700_000_000_000): {
  secrets: SecretsStore
  api_keys: ApiKeyStore
} {
  const secrets = new SecretsStore({ data_dir: dataDir, db, now })
  const api_keys = new ApiKeyStore({ db, secrets, now })
  return { secrets, api_keys }
}

test('add stores ciphertext via SecretsStore + writes api_keys metadata row', async () => {
  const { api_keys, secrets } = buildStores()
  const result = await api_keys.add({
    internal_handle: asOwnerHandle('alice'),
    provider: 'anthropic',
    label: 'prod',
    plaintext: 'sk-ant-prod-1',
  })
  expect(typeof result.id).toBe('string')
  expect(typeof result.secret_id).toBe('string')

  const list = await api_keys.list({ internal_handle: asOwnerHandle('alice') })
  expect(list).toHaveLength(1)
  expect(list[0]?.provider).toBe('anthropic')
  expect(list[0]?.label).toBe('prod')
  expect(list[0]?.last_used_at).toBeNull()

  const plaintext = await secrets.get({
    internal_handle: asOwnerHandle('alice'),
    kind: 'byo_api_key',
    label: 'anthropic:prod',
  })
  expect(plaintext).toBe('sk-ant-prod-1')
})

test('duplicate add raises ApiKeyStoreError(duplicate_label)', async () => {
  const { api_keys } = buildStores()
  await api_keys.add({
    internal_handle: asOwnerHandle('alice'),
    provider: 'anthropic',
    label: 'prod',
    plaintext: 'k1',
  })
  await expect(
    api_keys.add({
      internal_handle: asOwnerHandle('alice'),
      provider: 'anthropic',
      label: 'prod',
      plaintext: 'k2',
    }),
  ).rejects.toBeInstanceOf(ApiKeyStoreError)
})

test('resolveSecret decrypts the stored value via the SecretsStore', async () => {
  const { api_keys } = buildStores()
  await api_keys.add({
    internal_handle: asOwnerHandle('alice'),
    provider: 'openai',
    label: 'main',
    plaintext: 'sk-openai-zzz',
  })
  const fetched = await api_keys.resolveSecret({
    internal_handle: asOwnerHandle('alice'),
    provider: 'openai',
    label: 'main',
  })
  expect(fetched).toBe('sk-openai-zzz')
})

test('list filters by project + optional provider', async () => {
  const { api_keys } = buildStores()
  await api_keys.add({ internal_handle: asOwnerHandle('alice'), provider: 'anthropic', label: 'a', plaintext: 'k' })
  await api_keys.add({ internal_handle: asOwnerHandle('alice'), provider: 'openai', label: 'b', plaintext: 'k' })
  await api_keys.add({ internal_handle: asOwnerHandle('bobby'), provider: 'anthropic', label: 'c', plaintext: 'k' })
  const aliceAll = await api_keys.list({ internal_handle: asOwnerHandle('alice') })
  expect(aliceAll.map((r) => r.label).sort()).toEqual(['a', 'b'])
  const aliceAnthropic = await api_keys.list({ internal_handle: asOwnerHandle('alice'), provider: 'anthropic' })
  expect(aliceAnthropic.map((r) => r.label)).toEqual(['a'])
})

test('markUsed bumps last_used_at; unknown id throws not_found', async () => {
  let nowVal = 1_700_000_000_000
  const { api_keys } = buildStores(() => nowVal)
  const { id } = await api_keys.add({
    internal_handle: asOwnerHandle('alice'),
    provider: 'gemini',
    label: 'main',
    plaintext: 'g',
  })
  nowVal += 5_000
  await api_keys.markUsed(id)
  const list = await api_keys.list({ internal_handle: asOwnerHandle('alice') })
  expect(list[0]?.last_used_at).toBe(nowVal)
  await expect(api_keys.markUsed('does-not-exist')).rejects.toBeInstanceOf(ApiKeyStoreError)
})

test('delete drops both api_keys row AND the underlying secret', async () => {
  const { api_keys, secrets } = buildStores()
  await api_keys.add({
    internal_handle: asOwnerHandle('alice'),
    provider: 'anthropic',
    label: 'tmp',
    plaintext: 'k',
  })
  await api_keys.delete({ internal_handle: asOwnerHandle('alice'), provider: 'anthropic', label: 'tmp' })
  const list = await api_keys.list({ internal_handle: asOwnerHandle('alice') })
  expect(list).toHaveLength(0)
  const stale = await secrets.get({
    internal_handle: asOwnerHandle('alice'),
    kind: 'byo_api_key',
    label: 'anthropic:tmp',
  })
  expect(stale).toBeNull()
})
