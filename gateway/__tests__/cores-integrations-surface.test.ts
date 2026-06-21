/**
 * WAVE 2 Track A — `/api/cores/integrations` + `/api/cores/api-keys/*`
 * HTTP surface tests (folded into the Cores OAuth surface).
 *
 * Covers:
 *   - GET /api/cores/integrations lists OAuth accounts + API-key slots
 *     with the correct connected status (the data behind the UI).
 *   - POST /api/cores/api-keys/<label> stores a key (real mutation).
 *   - DELETE /api/cores/api-keys/<label> clears it.
 *   - unknown label → 400; missing bearer → 401.
 */

import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { SecretsStore } from '../../auth/secrets-store.ts'
import { ToolRegistry } from '../../tools/registry.ts'
import { createAppWsAuthResolver } from '../../channels/index.ts'
import { installBundledCores } from '../cores/install-bundled.ts'
import { CoresOAuthPendingStore } from '../cores/oauth-pending-store.ts'
import { OAuthTokenManager, GOOGLE_REVOKE_URL, metaLabel } from '../cores/oauth-token-manager.ts'
import { createCoresOAuthSurface } from '../http/cores-oauth-surface.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const OWNER = 'integrations-surface-test'
const SHARED_SECRET = 'test-shared-secret'
const REDIRECT_URI = 'https://auth.test/oauth/cores/google/callback'
const OWNER_BASE_URL = 'https://owner.neutron.example'
const IDENTITY_BASE_URL = 'https://auth.test'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function makeBench() {
  const home = mkdtempSync(join(tmpdir(), 'neutron-integrations-surface-'))
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
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith(GOOGLE_REVOKE_URL)) return new Response('{}', { status: 200 })
    return new Response('not found', { status: 404 })
  }) as (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  const pending = new CoresOAuthPendingStore({ db })
  const tokens = new OAuthTokenManager({
    secretsStore: secrets,
    internal_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: fakeFetch,
  })
  const surface = createCoresOAuthSurface({
    cores,
    pending,
    tokens,
    secretsStore: secrets,
    projectDb: db,
    dataDir: home,
    tools,
    project_slug: OWNER,
    identityBaseUrl: IDENTITY_BASE_URL,
    ownerBaseUrl: OWNER_BASE_URL,
    redirectUri: REDIRECT_URI,
    clientId: 'cid',
    internalSharedSecret: SHARED_SECRET,
    auth,
    fetch: fakeFetch,
  })
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => (await surface.handler(req)) ?? new Response('nf', { status: 404 }),
  })
  cleanups.push(() => server.stop(true).then(() => undefined))
  return { secrets, base: `http://127.0.0.1:${server.port}` }
}

function authed(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', `Bearer dev:${OWNER}`)
  return fetch(`${base}${path}`, { ...init, headers })
}

test('GET /api/cores/integrations lists OAuth + API-key slots with status', async () => {
  const b = await makeBench()
  // Seed one connected Google account + one stored API key.
  await b.secrets.put({
    internal_handle: OWNER,
    kind: 'oauth_token',
    label: 'gmail_compose',
    plaintext: 'access',
    expires_at: Date.now() + 3_600_000,
  })
  await b.secrets.put({
    internal_handle: OWNER,
    kind: 'oauth_token',
    label: metaLabel('gmail_compose'),
    plaintext: JSON.stringify({ email: 'me@example.com', scopes: [] }),
  })
  await b.secrets.put({
    internal_handle: OWNER,
    kind: 'byo_api_key',
    label: 'tavily',
    plaintext: 'tvly-1',
  })

  const res = await authed(b.base, '/api/cores/integrations')
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    oauth: Array<{ label: string; connected: boolean; email: string | null }>
    api_keys: Array<{ label: string; connected: boolean }>
  }
  expect(body.ok).toBe(true)
  const gmail = body.oauth.find((o) => o.label === 'gmail_compose')
  expect(gmail?.connected).toBe(true)
  expect(gmail?.email).toBe('me@example.com')
  expect(body.oauth.find((o) => o.label === 'google_calendar')?.connected).toBe(false)
  expect(body.api_keys.find((k) => k.label === 'tavily')?.connected).toBe(true)
  // No plaintext ever surfaces.
  expect(JSON.stringify(body)).not.toContain('tvly-1')
})

test('POST then DELETE /api/cores/api-keys/tavily mutates stored state', async () => {
  const b = await makeBench()
  const setRes = await authed(b.base, '/api/cores/api-keys/tavily', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'tvly-set' }),
  })
  expect(setRes.status).toBe(200)
  expect(
    await b.secrets.get({ internal_handle: OWNER, kind: 'byo_api_key', label: 'tavily' }),
  ).toBe('tvly-set')

  const delRes = await authed(b.base, '/api/cores/api-keys/tavily', { method: 'DELETE' })
  expect(delRes.status).toBe(200)
  expect((await delRes.json() as { deleted: boolean }).deleted).toBe(true)
  expect(
    await b.secrets.get({ internal_handle: OWNER, kind: 'byo_api_key', label: 'tavily' }),
  ).toBeNull()
})

test('POST /api/cores/api-keys/<unknown> returns 400 unknown_label', async () => {
  const b = await makeBench()
  const res = await authed(b.base, '/api/cores/api-keys/not_a_slot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'x' }),
  })
  expect(res.status).toBe(400)
  expect((await res.json() as { code: string }).code).toBe('unknown_label')
})

test('GET /api/cores/integrations without bearer returns 401', async () => {
  const b = await makeBench()
  const res = await fetch(`${b.base}/api/cores/integrations`)
  expect(res.status).toBe(401)
})
