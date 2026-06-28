/**
 * WAVE 2 Track A — Integrations aggregation + mutation unit tests.
 *
 * Uses the REAL bundled-Cores registry (installBundledCores walks the repo
 * root), so the OAuth slots (google_calendar / gmail_compose /
 * google_workspace) and the API-key slot (tavily) are the genuine manifest
 * declarations — no fixtures that can drift from the Cores.
 *
 * Covers:
 *   - buildIntegrationsStatus lists every OAuth + API-key slot with the
 *     correct connected status (the data behind the Integrations UI).
 *   - setApiKey stores a key (real state mutation) + rotate-over-existing.
 *   - deleteApiKey clears it (idempotent on absent).
 *   - unknown-label + empty-value rejection.
 */

import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { SecretsStore } from '../../../auth/secrets-store.ts'
import { ApiKeyStore } from '../../../auth/api-key-store.ts'
import { ToolRegistry } from '../../../tools/registry.ts'
import { installBundledCores } from '../install-bundled.ts'
import {
  OAuthTokenManager,
  GOOGLE_REVOKE_URL,
  metaLabel,
} from '../oauth-token-manager.ts'
import {
  buildIntegrationsStatus,
  collectApiKeySlots,
  collectOAuthSlots,
  deleteApiKey,
  IntegrationsError,
  setApiKey,
} from '../integrations.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const OWNER = 'integrations-test'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function makeBench() {
  const home = mkdtempSync(join(tmpdir(), 'neutron-integrations-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const dbDir = join(home, 'db')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  const secrets = new SecretsStore({ data_dir: home, db })
  const tools = new ToolRegistry()
  const cores = await installBundledCores({
    project_slug: OWNER,
    projectDb: db,
    dataDir: home,
    tools,
    secretsStore: secrets,
    rootDirs: [REPO_ROOT],
  })
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith(GOOGLE_REVOKE_URL)) return new Response('{}', { status: 200 })
    return new Response('not found', { status: 404 })
  }) as (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  const tokens = new OAuthTokenManager({
    secretsStore: secrets,
    internal_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: fakeFetch,
  })
  return { home, db, secrets, cores, tokens, registry: cores.registry }
}

/** Seed an OAuth access row + meta so getStatus reports `connected`. */
async function seedOAuth(
  secrets: SecretsStore,
  label: string,
  email: string,
): Promise<void> {
  await secrets.put({
    internal_handle: OWNER,
    kind: 'oauth_token',
    label,
    plaintext: 'access-token',
    expires_at: Date.now() + 3_600_000,
  })
  await secrets.put({
    internal_handle: OWNER,
    kind: 'oauth_token',
    label: metaLabel(label),
    plaintext: JSON.stringify({
      scopes: ['https://www.googleapis.com/auth/calendar'],
      email,
      connected_at: Date.now(),
      last_refresh_at: null,
      last_refresh_outcome: 'ok',
    }),
  })
}

test('collectOAuthSlots + collectApiKeySlots derive slots from real manifests', async () => {
  const b = await makeBench()
  const oauth = collectOAuthSlots(b.registry)
  const api = collectApiKeySlots(b.registry)
  expect([...oauth.keys()].sort()).toEqual([
    'gmail_compose',
    'google_calendar',
    'google_workspace',
  ])
  // Scraping Core (parity gap #6) adds the `apify` byo_api_key slot
  // alongside Research Core's `tavily`.
  expect([...api.keys()].sort()).toEqual(['apify', 'tavily'])
  expect(api.get('tavily')?.core_slugs.length).toBeGreaterThan(0)
  expect(api.get('apify')?.core_slugs).toContain('scraping_core')
  expect(api.get('apify')?.required).toBe(false)
})

test('buildIntegrationsStatus reflects connected OAuth account + stored API key', async () => {
  const b = await makeBench()
  // Initially nothing connected.
  let status = await buildIntegrationsStatus({
    registry: b.registry,
    tokens: b.tokens,
    secretsStore: b.secrets,
    project_slug: OWNER,
  })
  expect(status.oauth.every((o) => !o.connected)).toBe(true)
  expect(status.api_keys.find((k) => k.label === 'tavily')?.connected).toBe(false)

  // Connect a Google account + store a Tavily key.
  await seedOAuth(b.secrets, 'google_calendar', 'me@example.com')
  await setApiKey({
    registry: b.registry,
    secretsStore: b.secrets,
    project_slug: OWNER,
    label: 'tavily',
    value: 'tvly-123',
  })

  status = await buildIntegrationsStatus({
    registry: b.registry,
    tokens: b.tokens,
    secretsStore: b.secrets,
    project_slug: OWNER,
  })
  const cal = status.oauth.find((o) => o.label === 'google_calendar')
  expect(cal?.connected).toBe(true)
  expect(cal?.email).toBe('me@example.com')
  expect(cal?.kind).toBe('oauth')
  expect(cal?.core_slugs.length).toBeGreaterThan(0)
  // Other OAuth accounts still disconnected.
  expect(status.oauth.find((o) => o.label === 'gmail_compose')?.connected).toBe(false)
  const tav = status.api_keys.find((k) => k.label === 'tavily')
  expect(tav?.connected).toBe(true)
  expect(tav?.kind).toBe('api_key')
})

test('setApiKey stores then rotates the value (real state mutation)', async () => {
  const b = await makeBench()
  await setApiKey({
    registry: b.registry,
    secretsStore: b.secrets,
    project_slug: OWNER,
    label: 'tavily',
    value: 'tvly-first',
  })
  expect(
    await b.secrets.get({ internal_handle: OWNER, kind: 'byo_api_key', label: 'tavily' }),
  ).toBe('tvly-first')

  // Rotate over the existing row — replaceAtomic keeps a single row.
  await setApiKey({
    registry: b.registry,
    secretsStore: b.secrets,
    project_slug: OWNER,
    label: 'tavily',
    value: 'tvly-second',
  })
  expect(
    await b.secrets.get({ internal_handle: OWNER, kind: 'byo_api_key', label: 'tavily' }),
  ).toBe('tvly-second')
  const rows = await b.secrets.list({ internal_handle: OWNER, kind: 'byo_api_key' })
  expect(rows.filter((r) => r.label === 'tavily')).toHaveLength(1)
})

test('deleteApiKey clears a stored key + is idempotent', async () => {
  const b = await makeBench()
  await setApiKey({
    registry: b.registry,
    secretsStore: b.secrets,
    project_slug: OWNER,
    label: 'tavily',
    value: 'tvly-x',
  })
  const first = await deleteApiKey({
    registry: b.registry,
    secretsStore: b.secrets,
    project_slug: OWNER,
    label: 'tavily',
  })
  expect(first.deleted).toBe(true)
  expect(
    await b.secrets.get({ internal_handle: OWNER, kind: 'byo_api_key', label: 'tavily' }),
  ).toBeNull()
  // Second delete is a no-op.
  const second = await deleteApiKey({
    registry: b.registry,
    secretsStore: b.secrets,
    project_slug: OWNER,
    label: 'tavily',
  })
  expect(second.deleted).toBe(false)
})

test('setApiKey rejects unknown label + empty value', async () => {
  const b = await makeBench()
  await expect(
    setApiKey({
      registry: b.registry,
      secretsStore: b.secrets,
      project_slug: OWNER,
      label: 'not_a_slot',
      value: 'x',
    }),
  ).rejects.toThrow(IntegrationsError)
  await expect(
    setApiKey({
      registry: b.registry,
      secretsStore: b.secrets,
      project_slug: OWNER,
      label: 'tavily',
      value: '   ',
    }),
  ).rejects.toThrow(/non-empty/)
})

test('system openai_api_key slot shares storage with the onboarding key (ND1)', async () => {
  const b = await makeBench()

  // The system slot is surfaced in the panel (colon-free public id), starts
  // disconnected.
  const before = await buildIntegrationsStatus({
    registry: b.registry,
    tokens: b.tokens,
    secretsStore: b.secrets,
    project_slug: OWNER,
  })
  const slotBefore = before.api_keys.find((k) => k.label === 'openai_api_key')
  expect(slotBefore).toBeDefined()
  expect(slotBefore!.connected).toBe(false)

  // Setting it via the admin path (with db) routes through ApiKeyStore, so it
  // persists BOTH the secret under the SAME label the onboarding offer uses
  // (`openai:onboarding`) AND the `api_keys` metadata row the BYO credential
  // read path (resolveLlmCredentials → ApiKeyStore.list) needs.
  const apiKeys = new ApiKeyStore({ db: b.db, secrets: b.secrets })
  await setApiKey({
    registry: b.registry,
    secretsStore: b.secrets,
    db: b.db,
    project_slug: OWNER,
    label: 'openai_api_key',
    value: 'sk-from-admin-panel',
  })
  // Shared secret — readable as the onboarding embeddings key.
  expect(
    await apiKeys.resolveSecret({ internal_handle: OWNER, provider: 'openai', label: 'onboarding' }),
  ).toBe('sk-from-admin-panel')
  // Metadata row exists → credential resolution (GPT-5 reviews) sees it.
  expect((await apiKeys.list({ internal_handle: OWNER, provider: 'openai' })).length).toBe(1)

  // Now reads connected.
  const after = await buildIntegrationsStatus({
    registry: b.registry,
    tokens: b.tokens,
    secretsStore: b.secrets,
    project_slug: OWNER,
  })
  expect(after.api_keys.find((k) => k.label === 'openai_api_key')!.connected).toBe(true)

  // Re-paste over an existing key (rotate) must succeed, not trip duplicate-label.
  await setApiKey({
    registry: b.registry,
    secretsStore: b.secrets,
    db: b.db,
    project_slug: OWNER,
    label: 'openai_api_key',
    value: 'sk-rotated',
  })
  expect(
    await apiKeys.resolveSecret({ internal_handle: OWNER, provider: 'openai', label: 'onboarding' }),
  ).toBe('sk-rotated')

  // Delete clears BOTH the secret AND the metadata row (no orphan → a later
  // onboarding re-paste won't hit a stale duplicate row).
  const del = await deleteApiKey({
    registry: b.registry,
    secretsStore: b.secrets,
    db: b.db,
    project_slug: OWNER,
    label: 'openai_api_key',
  })
  expect(del.deleted).toBe(true)
  expect(
    await apiKeys.resolveSecret({ internal_handle: OWNER, provider: 'openai', label: 'onboarding' }),
  ).toBeNull()
  expect((await apiKeys.list({ internal_handle: OWNER, provider: 'openai' })).length).toBe(0)

  // Idempotent re-add after delete (proves no orphan metadata row blocks it).
  await apiKeys.add({ internal_handle: OWNER, provider: 'openai', label: 'onboarding', plaintext: 'sk-reonboard' })
  expect(
    await apiKeys.resolveSecret({ internal_handle: OWNER, provider: 'openai', label: 'onboarding' }),
  ).toBe('sk-reonboard')
})
