import { asOwnerHandle } from '@neutronai/persistence/index.ts'
/**
 * Cores OAuth secret-resolution sprint — `/api/cores/oauth/google/*`
 * HTTP surface tests.
 *
 * Covers:
 *   - GET /start returns authorize_url + state + persists pending row
 *   - GET /start without bearer returns 401
 *   - GET /start?labels=bogus returns 400 unknown_label
 *   - POST /ingest happy path writes secrets + re-installs failed Cores
 *   - POST /ingest with unknown state returns 400
 *   - POST /ingest without HMAC returns 401
 *   - POST /disconnect deletes rows + marks affected Cores
 *   - GET /status reflects connection state from :meta rows
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { installBundledCores } from '../cores/install-bundled.ts'
import { CoresOAuthPendingStore } from '../cores/oauth-pending-store.ts'
import {
  OAuthTokenManager,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  GOOGLE_REVOKE_URL,
  refreshLabel,
  metaLabel,
} from '../cores/oauth-token-manager.ts'
import { createCoresOAuthSurface } from '../http/cores-oauth-surface.ts'
// ISSUES #219: import the HMAC signer from its canonical Open home in
// runtime/ (identity/oauth/internal-signature.ts is a thin re-export of
// this module and lives in a Managed-carved dir).
import { signInternalRequest } from '@neutronai/runtime/internal-signature.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const OWNER = asOwnerHandle('oauth-test')
const SHARED_SECRET = 'test-shared-secret'
const REDIRECT_URI = 'https://auth.test/oauth/cores/google/callback'
const OWNER_BASE_URL = 'https://oauth-test.neutron.example'
const IDENTITY_BASE_URL = 'https://auth.test'

interface Bench {
  ownerHome: string
  db: ProjectDb
  base: string
  server: import('bun').Server<unknown>
  /** Identity-side register hits go here */
  identityRegisterCalls: Array<{ url: string; body: string; sig: string }>
}

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    await fn()
  }
})

async function makeBench(): Promise<Bench> {
  const ownerHome = mkdtempSync(join(tmpdir(), 'neutron-cores-oauth-surface-'))
  cleanups.push(() => rmSync(ownerHome, { recursive: true, force: true }))
  const dbDir = join(ownerHome, 'db')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  const secrets = new SecretsStore({ data_dir: ownerHome, db })
  const tools = new ToolRegistry()
  const cores = await installBundledCores({
    project_slug: OWNER,
    projectDb: db,
    dataDir: ownerHome,
    tools,
    secretsStore: secrets,
    rootDirs: [REPO_ROOT],
  })
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })

  const identityRegisterCalls: Array<{ url: string; body: string; sig: string }> = []
  // Fake fetch: intercepts identity-side register + Google token/userinfo.
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const body = (init?.body as string | undefined) ?? ''
    const sig =
      (init?.headers as Record<string, string> | undefined)?.['x-internal-signature'] ?? ''
    if (url.endsWith('/oauth/cores/pending/register')) {
      identityRegisterCalls.push({ url, body, sig })
      return new Response('{"ok":true}', { status: 200 })
    }
    if (url === GOOGLE_TOKEN_URL) {
      return new Response(
        JSON.stringify({
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 3600,
          scope:
            'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.compose',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url === GOOGLE_USERINFO_URL) {
      return new Response(JSON.stringify({ email: 'user@example.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.startsWith(GOOGLE_REVOKE_URL)) {
      return new Response('{}', { status: 200 })
    }
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
    dataDir: ownerHome,
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
    fetch: async (req) => {
      const r = await surface.handler(req)
      return r ?? new Response('not found', { status: 404 })
    },
  })
  cleanups.push(() => server.stop(true).then(() => undefined))
  return {
    ownerHome,
    db,
    base: `http://127.0.0.1:${server.port}`,
    server,
    identityRegisterCalls,
  }
}

async function authedFetch(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', `Bearer dev:${OWNER}`)
  return fetch(`${base}${path}`, { ...init, headers })
}

describe('GET /api/cores/oauth/google/start', () => {
  test('returns authorize_url + state and registers with identity', async () => {
    const bench = await makeBench()
    const res = await authedFetch(
      bench.base,
      '/api/cores/oauth/google/start?labels=google_calendar,gmail_compose',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      authorize_url: string
      state: string
      expires_at: number
    }
    expect(body.ok).toBe(true)
    expect(body.authorize_url).toContain('https://accounts.google.com')
    expect(body.authorize_url).toContain('scope=')
    expect(body.state.length).toBeGreaterThan(0)
    expect(bench.identityRegisterCalls).toHaveLength(1)
  })

  test('401 without bearer', async () => {
    const bench = await makeBench()
    const res = await fetch(
      `${bench.base}/api/cores/oauth/google/start?labels=google_calendar`,
    )
    expect(res.status).toBe(401)
  })

  test('400 unknown_label when label not in any manifest', async () => {
    const bench = await makeBench()
    const res = await authedFetch(
      bench.base,
      '/api/cores/oauth/google/start?labels=bogus_label',
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('unknown_label')
  })

  test('400 missing_labels when query missing', async () => {
    const bench = await makeBench()
    const res = await authedFetch(bench.base, '/api/cores/oauth/google/start')
    expect(res.status).toBe(400)
  })
})

describe('POST /api/cores/oauth/google/ingest', () => {
  test('happy path writes secrets + re-installs failed Cores', async () => {
    const bench = await makeBench()
    // First /start
    const startRes = await authedFetch(
      bench.base,
      '/api/cores/oauth/google/start?labels=google_calendar,gmail_compose',
    )
    const startBody = (await startRes.json()) as { state: string }

    // Then /ingest with platform HMAC
    const body = JSON.stringify({ code: 'fake-code', state: startBody.state })
    const timestamp_ms = Date.now()
    const sig = signInternalRequest({
      method: 'POST',
      path: '/api/cores/oauth/google/ingest',
      body,
      shared_secret: SHARED_SECRET,
      timestamp_ms,
    })
    const ingestRes = await fetch(`${bench.base}/api/cores/oauth/google/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': sig,
        'x-internal-timestamp': String(timestamp_ms),
      },
      body,
    })
    expect(ingestRes.status).toBe(200)
    const ingestBody = (await ingestRes.json()) as {
      ok: boolean
      labels: string[]
      reinstalled: string[]
    }
    expect(ingestBody.ok).toBe(true)
    expect(ingestBody.labels.sort()).toEqual(['gmail_compose', 'google_calendar'])
    // Both Calendar + Email-Managed should reinstall.
    expect(ingestBody.reinstalled.sort()).toEqual(
      ['calendar_core', 'email_managed_core'].sort(),
    )
  })

  test('400 unknown_state when state never registered', async () => {
    const bench = await makeBench()
    const body = JSON.stringify({ code: 'fake', state: 'never-registered' })
    const timestamp_ms = Date.now()
    const sig = signInternalRequest({
      method: 'POST',
      path: '/api/cores/oauth/google/ingest',
      body,
      shared_secret: SHARED_SECRET,
      timestamp_ms,
    })
    const res = await fetch(`${bench.base}/api/cores/oauth/google/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': sig,
        'x-internal-timestamp': String(timestamp_ms),
      },
      body,
    })
    expect(res.status).toBe(400)
    const body2 = (await res.json()) as { code: string }
    expect(body2.code).toBe('unknown_state')
  })

  test('401 without valid HMAC signature', async () => {
    const bench = await makeBench()
    const res = await fetch(`${bench.base}/api/cores/oauth/google/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'x', state: 'y' }),
    })
    expect(res.status).toBe(401)
  })

  test('401 stale_internal_timestamp when timestamp is > 5 min skewed', async () => {
    const bench = await makeBench()
    const body = JSON.stringify({ code: 'fake', state: 'never-registered' })
    // 10 min in the past — outside the ±5 min replay window.
    const timestamp_ms = Date.now() - 10 * 60 * 1_000
    const sig = signInternalRequest({
      method: 'POST',
      path: '/api/cores/oauth/google/ingest',
      body,
      shared_secret: SHARED_SECRET,
      timestamp_ms,
    })
    const res = await fetch(`${bench.base}/api/cores/oauth/google/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': sig,
        'x-internal-timestamp': String(timestamp_ms),
      },
      body,
    })
    expect(res.status).toBe(401)
    const j = (await res.json()) as { code: string }
    expect(j.code).toBe('stale_internal_timestamp')
  })

  test('401 missing_internal_timestamp when header absent', async () => {
    const bench = await makeBench()
    const body = JSON.stringify({ code: 'fake', state: 'never-registered' })
    const sig = signInternalRequest({
      method: 'POST',
      path: '/api/cores/oauth/google/ingest',
      body,
      shared_secret: SHARED_SECRET,
      timestamp_ms: Date.now(),
    })
    const res = await fetch(`${bench.base}/api/cores/oauth/google/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': sig,
      },
      body,
    })
    expect(res.status).toBe(401)
    const j = (await res.json()) as { code: string }
    expect(j.code).toBe('missing_internal_timestamp')
  })
})

describe('POST /api/cores/oauth/google/disconnect/<label>', () => {
  test('deletes secret rows + marks affected Cores dependency_missing', async () => {
    const bench = await makeBench()
    // First connect via the happy path
    const startRes = await authedFetch(
      bench.base,
      '/api/cores/oauth/google/start?labels=google_calendar',
    )
    const startBody = (await startRes.json()) as { state: string }
    const body = JSON.stringify({ code: 'fake', state: startBody.state })
    const timestamp_ms = Date.now()
    const sig = signInternalRequest({
      method: 'POST',
      path: '/api/cores/oauth/google/ingest',
      body,
      shared_secret: SHARED_SECRET,
      timestamp_ms,
    })
    await fetch(`${bench.base}/api/cores/oauth/google/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': sig,
        'x-internal-timestamp': String(timestamp_ms),
      },
      body,
    })
    // Disconnect
    const disconnectRes = await authedFetch(
      bench.base,
      '/api/cores/oauth/google/disconnect/google_calendar',
      { method: 'POST' },
    )
    expect(disconnectRes.status).toBe(200)
    const d = (await disconnectRes.json()) as {
      ok: boolean
      disconnected: string[]
      affected_cores: string[]
    }
    expect(d.disconnected).toContain('google_calendar')
    expect(d.affected_cores).toContain('calendar_core')
    // Confirm install_state column updated.
    const row = bench.db
      .raw()
      .query<{ install_state: string }, [string, string]>(
        `SELECT install_state FROM core_installations WHERE project_slug = ? AND core_slug = ?`,
      )
      .get(OWNER, 'calendar_core')
    expect(row?.install_state).toBe('install_failed_dependency_missing')
  })
})

describe('GET /api/cores/oauth/google/status', () => {
  test('reports not_connected initially + connected after ingest', async () => {
    const bench = await makeBench()
    const first = await authedFetch(bench.base, '/api/cores/oauth/google/status')
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as {
      google: { connected: boolean; labels: Array<{ label: string; connected: boolean }> }
    }
    expect(firstBody.google.connected).toBe(false)
    expect(firstBody.google.labels.every((l) => !l.connected)).toBe(true)

    // Connect
    const startRes = await authedFetch(
      bench.base,
      '/api/cores/oauth/google/start?labels=google_calendar,gmail_compose',
    )
    const startBody = (await startRes.json()) as { state: string }
    const body = JSON.stringify({ code: 'fake', state: startBody.state })
    const timestamp_ms = Date.now()
    const sig = signInternalRequest({
      method: 'POST',
      path: '/api/cores/oauth/google/ingest',
      body,
      shared_secret: SHARED_SECRET,
      timestamp_ms,
    })
    await fetch(`${bench.base}/api/cores/oauth/google/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': sig,
        'x-internal-timestamp': String(timestamp_ms),
      },
      body,
    })

    const second = await authedFetch(bench.base, '/api/cores/oauth/google/status')
    const secondBody = (await second.json()) as {
      google: { connected: boolean; labels: Array<{ label: string; connected: boolean; email: string | null }> }
    }
    expect(secondBody.google.connected).toBe(true)
    const calendarStatus = secondBody.google.labels.find(
      (l) => l.label === 'google_calendar',
    )
    expect(calendarStatus?.connected).toBe(true)
    expect(calendarStatus?.email).toBe('user@example.com')
  })
})

// Suppress unused-import lints — these are imported for type-relevant
// re-export checks elsewhere in the suite.
void refreshLabel
void metaLabel
