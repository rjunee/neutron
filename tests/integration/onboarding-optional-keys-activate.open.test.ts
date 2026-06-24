/**
 * WAVE 1 credential-management — onboarding OPTIONAL-key store + activate.
 *
 * Proves the end-to-end activation property the unit test stubs out: a key
 * provided during onboarding and stored through the canonical
 * `storeOptionalKey` seam lands in the REAL per-instance `ApiKeyStore`, and
 * the gateway-side credential resolver then ACTIVATES the matching adapter:
 *
 *   1. Provided OpenAI key → `storeOptionalKey(apiKeys, …)` → ApiKeyStore row
 *      → `resolveLlmCredentials({ provider: 'openai' })` returns a BYO pool.
 *   2. SKIPPED key (never stored) → `resolveLlmCredentials({ provider:
 *      'openai' })` returns null (no OpenAI surface) WHILE the Anthropic Max
 *      path still resolves → the system runs fully on Claude alone.
 *
 * Imports only `@neutronai/onboarding`, `@neutronai/auth`,
 * `@neutronai/gateway`, `@neutronai/migrations`, `@neutronai/persistence`.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ApiKeyStore } from '@neutronai/auth/api-key-store.ts'
import { resolveLlmCredentials } from '@neutronai/gateway/realmode-composer/resolve-llm-credentials.ts'
import { selectCredential } from '@neutronai/runtime/credential-pool.ts'
import { storeOptionalKey } from '@neutronai/onboarding/optional-keys.ts'

const NOW_FIXED = 1_700_000_000_000
const OWNER = 'alice'
const OPENAI_KEY = 'sk-proj-onboarding-abc123DEF456'

let root: string
let dataDir: string
let db: ProjectDb

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'optkeys-open-'))
  dataDir = join(root, 'owner')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(root, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('provided OpenAI key → stored via ApiKeyStore → resolver ACTIVATES the OpenAI adapter', async () => {
  const secrets = new SecretsStore({ data_dir: dataDir, db, now: () => NOW_FIXED })
  const apiKeys = new ApiKeyStore({ db, secrets, now: () => NOW_FIXED })

  // The onboarding step hands the pasted key to the canonical seam.
  const res = await storeOptionalKey(apiKeys, {
    internal_handle: OWNER,
    id: 'openai_api_key',
    plaintext: OPENAI_KEY,
  })
  expect(res.outcome).toBe('stored')
  expect(res.provider).toBe('openai')

  // It is now a real ApiKeyStore row.
  const rows = await apiKeys.list({ internal_handle: OWNER, provider: 'openai' })
  expect(rows).toHaveLength(1)
  expect(rows[0]?.label).toBe('onboarding')

  // The gateway resolver picks it up → the OpenAI adapter is ACTIVATED.
  const pool = await resolveLlmCredentials({
    internal_handle: OWNER,
    apiKeys,
    provider: 'openai',
    env_vars: ['OPENAI_API_KEY'],
    env: {}, // no env key — the credential comes from the store
  })
  expect(pool).not.toBeNull()
  const cred = selectCredential(pool!)
  expect(cred?.kind).toBe('api_key')
  expect(cred?.secret).toBe(OPENAI_KEY)
})

test('SKIPPED OpenAI key → no OpenAI surface, but Claude (Anthropic) still resolves', async () => {
  const secrets = new SecretsStore({ data_dir: dataDir, db, now: () => NOW_FIXED })
  const apiKeys = new ApiKeyStore({ db, secrets, now: () => NOW_FIXED })

  // The user SKIPPED the optional OpenAI offer — nothing is stored.
  const openaiPool = await resolveLlmCredentials({
    internal_handle: OWNER,
    apiKeys,
    provider: 'openai',
    env_vars: ['OPENAI_API_KEY'],
    env: {},
  })
  expect(openaiPool).toBeNull() // no embeddings / cross-model surface — fine

  // The system still works on Claude alone: the Anthropic substrate (here a
  // shared-env key, the OSS single-instance 'open' default) resolves.
  const anthropicPool = await resolveLlmCredentials({
    internal_handle: OWNER,
    apiKeys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY'],
    env: { ANTHROPIC_API_KEY: 'sk-ant-substrate-key' },
  })
  expect(anthropicPool).not.toBeNull()
  expect(selectCredential(anthropicPool!)?.secret).toBe('sk-ant-substrate-key')
})
