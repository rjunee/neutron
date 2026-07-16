import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import {
  OAuthRefreshError,
  OAuthTokenManager,
  refreshLabel,
  metaLabel,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  GOOGLE_REVOKE_URL,
} from '../oauth-token-manager.ts'

let workdir: string
let db: ProjectDb
let dataDir: string
let secretsStore: SecretsStore
const OWNER = asOwnerHandle('alice')
const LABEL = 'google_calendar'

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-cores-token-mgr-'))
  dataDir = join(workdir, 'project')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(workdir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
  secretsStore = new SecretsStore({ data_dir: dataDir, db, now: () => Date.now() })
})

afterEach(() => {
  db.close()
  rmSync(workdir, { recursive: true, force: true })
})

interface FetchCall {
  url: string
  init: RequestInit
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('exchangeAndPersist writes three rows + ciphertexts != plaintext', async () => {
  const fetchCalls: FetchCall[] = []
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    fetchCalls.push({ url: u, init: init ?? {} })
    if (u === GOOGLE_TOKEN_URL) {
      return jsonResponse(200, {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/calendar',
        token_type: 'Bearer',
      })
    }
    if (u === GOOGLE_USERINFO_URL) {
      return jsonResponse(200, { email: 'user@example.com' })
    }
    return jsonResponse(404, {})
  }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  const mgr = new OAuthTokenManager({
    secretsStore,
    internal_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: fakeFetch,
    now: () => 1_700_000_000_000,
  })
  await mgr.exchangeAndPersist({
    code: 'code-1',
    code_verifier: 'v',
    redirect_uri: 'https://auth/cb',
    labels: [LABEL],
  })
  const rows = await secretsStore.list({ internal_handle: OWNER, kind: 'oauth_token' })
  const labels = rows.map((r) => r.label).sort()
  expect(labels).toEqual([LABEL, metaLabel(LABEL), refreshLabel(LABEL)].sort())
  // Ciphertext is not the plaintext.
  const accessRow = rows.find((r) => r.label === LABEL)!
  expect(accessRow.ciphertext.includes('access-1')).toBe(false)
  // access row has expires_at set.
  expect(accessRow.expires_at).toBe(1_700_000_000_000 + 3600 * 1000)
  // refresh row has no expiry.
  const refreshRow = rows.find((r) => r.label === refreshLabel(LABEL))!
  expect(refreshRow.expires_at).toBeNull()
  // meta row contains scopes + email.
  const metaPlain = await secretsStore.get({
    internal_handle: OWNER,
    kind: 'oauth_token',
    label: metaLabel(LABEL),
  })
  expect(metaPlain).not.toBeNull()
  const meta = JSON.parse(metaPlain!) as { scopes: string[]; email: string | null }
  expect(meta.scopes).toEqual(['https://www.googleapis.com/auth/calendar'])
  expect(meta.email).toBe('user@example.com')
})

test('getAccessToken returns cached value when not expired', async () => {
  // Use real Date.now so the platform SecretsStore's expires_at check
  // and the OAuthTokenManager's refresh-lead computation share a clock.
  const mgr = new OAuthTokenManager({
    secretsStore,
    internal_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: (async () => {
      throw new Error('refresh should not be called')
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  })
  await mgr.put({
    label: LABEL,
    access_token: 'access-cached',
    refresh_token: 'refresh-cached',
    expires_in: 3600,
    scopes: ['scope-x'],
  })
  const got = await mgr.getAccessToken(LABEL)
  expect(got).toBe('access-cached')
})

test('getAccessToken refreshes via Google when expired + rotates row + updates meta', async () => {
  let nowVal = 1_700_000_000_000
  const fetchCalls: FetchCall[] = []
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    fetchCalls.push({ url: u, init: init ?? {} })
    if (u === GOOGLE_TOKEN_URL) {
      return jsonResponse(200, {
        access_token: 'access-refreshed',
        expires_in: 3600,
        scope: 'scope-x',
      })
    }
    return jsonResponse(404, {})
  }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  const mgr = new OAuthTokenManager({
    secretsStore,
    internal_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: fakeFetch,
    now: () => nowVal,
  })
  await mgr.put({
    label: LABEL,
    access_token: 'access-stale',
    refresh_token: 'refresh-1',
    expires_in: 1,
    scopes: ['scope-x'],
  })
  // Move clock past expiry.
  nowVal += 10_000
  const got = await mgr.getAccessToken(LABEL)
  expect(got).toBe('access-refreshed')
  expect(fetchCalls.length).toBe(1)
  // Meta row's last_refresh_outcome is 'ok'.
  const metaPlain = await secretsStore.get({
    internal_handle: OWNER,
    kind: 'oauth_token',
    label: metaLabel(LABEL),
  })
  const meta = JSON.parse(metaPlain!) as { last_refresh_outcome: string }
  expect(meta.last_refresh_outcome).toBe('ok')
})

test('getAccessToken on invalid_grant throws + onInvalidGrant fires', async () => {
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString()
    if (u === GOOGLE_TOKEN_URL) {
      return jsonResponse(400, { error: 'invalid_grant' })
    }
    return jsonResponse(404, {})
  }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  const fired: string[] = []
  const mgr = new OAuthTokenManager({
    secretsStore,
    internal_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: fakeFetch,
    now: () => Date.now(),
    onInvalidGrant: (label) => {
      fired.push(label)
    },
  })
  await mgr.put({
    label: LABEL,
    access_token: 'access-stale',
    refresh_token: 'refresh-revoked',
    expires_in: 1,
    scopes: ['scope-x'],
  })
  // Wait so the access_token's expires_at is in the past.
  await new Promise((r) => setTimeout(r, 5))
  await expect(mgr.getAccessToken(LABEL)).rejects.toMatchObject({
    code: 'invalid_grant',
  })
  expect(fired).toEqual([LABEL])
  const metaPlain = await secretsStore.get({
    internal_handle: OWNER,
    kind: 'oauth_token',
    label: metaLabel(LABEL),
  })
  const meta = JSON.parse(metaPlain!) as { last_refresh_outcome: string }
  expect(meta.last_refresh_outcome).toBe('invalid_grant')
})

test('concurrent getAccessToken calls share one fetch (refresh dedupe)', async () => {
  let nowVal = 1_700_000_000_000
  let fetchCount = 0
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString()
    if (u === GOOGLE_TOKEN_URL) {
      fetchCount += 1
      // Slow exchange so both callers race for the in-flight Promise.
      await new Promise((r) => setTimeout(r, 25))
      return jsonResponse(200, {
        access_token: `access-fresh-${fetchCount}`,
        expires_in: 3600,
        scope: 'scope-x',
      })
    }
    return jsonResponse(404, {})
  }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  const mgr = new OAuthTokenManager({
    secretsStore,
    internal_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: fakeFetch,
    now: () => nowVal,
  })
  await mgr.put({
    label: LABEL,
    access_token: 'access-stale',
    refresh_token: 'refresh-1',
    expires_in: 1,
    scopes: ['scope-x'],
  })
  nowVal += 10_000
  const [a, b] = await Promise.all([
    mgr.getAccessToken(LABEL),
    mgr.getAccessToken(LABEL),
  ])
  expect(a).toBe(b)
  expect(fetchCount).toBe(1)
})

test('disconnect deletes all three rows + best-effort revoke', async () => {
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString()
    if (u.startsWith(GOOGLE_REVOKE_URL)) {
      return new Response('{}', { status: 200 })
    }
    return jsonResponse(404, {})
  }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  const mgr = new OAuthTokenManager({
    secretsStore,
    internal_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: fakeFetch,
    now: () => Date.now(),
  })
  await mgr.put({
    label: LABEL,
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 3600,
    scopes: ['scope-x'],
  })
  const result = await mgr.disconnect(LABEL)
  expect(result.deleted).toBe(true)
  const rows = await secretsStore.list({ internal_handle: OWNER, kind: 'oauth_token' })
  expect(rows.length).toBe(0)
})

test('getStatus reports not-connected when no rows exist', async () => {
  const mgr = new OAuthTokenManager({
    secretsStore,
    internal_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: (async () => jsonResponse(404, {})) as unknown as (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>,
    now: () => Date.now(),
  })
  const status = await mgr.getStatus(LABEL)
  expect(status.connected).toBe(false)
  expect(status.scopes).toEqual([])
})

test('OAuthRefreshError carries no_refresh_token code when refresh row absent', async () => {
  const mgr = new OAuthTokenManager({
    secretsStore,
    internal_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: (async () => jsonResponse(404, {})) as unknown as (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>,
    now: () => Date.now(),
  })
  // Insert ONLY the access row (no :refresh) — expired so refresh runs.
  await secretsStore.put({
    internal_handle: OWNER,
    kind: 'oauth_token',
    label: LABEL,
    plaintext: 'access-stale',
    expires_at: Date.now() - 1_000,
  })
  await expect(mgr.getAccessToken(LABEL)).rejects.toBeInstanceOf(OAuthRefreshError)
})
