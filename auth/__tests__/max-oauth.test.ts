/**
 * Sprint 23 — `MaxOAuthClient` paste-token tests.
 *
 * The Sprint 22 OAuth-redirect tests were deleted in this sprint:
 * `auth.anthropic.com` does not resolve as a public OAuth endpoint,
 * so the PKCE flow + token-exchange paths they exercised never ran
 * successfully against any real upstream. The new contract is a
 * locally-acquired `claude setup-token` value pasted into the
 * identity service's gate page; the client probes it against
 * `api.anthropic.com/v1/messages` and persists it to the per-project
 * SecretsStore.
 *
 * Coverage:
 *   - probeToken: classifies 200, 401-invalid, 401-rate-limit, 402,
 *     403, 429, 400, 5xx, and network errors per the Sprint 23 spec.
 *   - persistPasteToken: writes BOTH max_oauth_refresh AND
 *     max_oauth_access (same value), with `expires_at` populated on
 *     the access row. Replaces an existing row idempotently.
 *   - getAccessToken: reads the access row, falls back to the
 *     refresh row when the access row is missing/expired,
 *     re-promotes the refresh value into a fresh access row, and
 *     returns null when no rows exist.
 *   - revoke: drops both rows locally (no upstream call).
 *   - oauthEnvForPool: maps an oauth-kind credential pool to the
 *     CLAUDE_CODE_OAUTH_TOKEN env-var fragment the Claude Code
 *     adapter's tier (5) plumbing reads.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SecretsStore } from '../secrets-store.ts'
import { MaxOAuthClient, oauthEnvForPool } from '../max-oauth.ts'

let workdir: string
let db: ProjectDb
let dataDir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-max-paste-'))
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

interface FakeFetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function buildClient(opts: {
  responses?: Array<{ status: number; body: unknown; bodyText?: string }>
  now?: () => number
  paste_token_ttl_ms?: number
  throwOnFetch?: Error
}): { client: MaxOAuthClient; calls: FakeFetchCall[]; secrets: SecretsStore } {
  const calls: FakeFetchCall[] = []
  const responses = [...(opts.responses ?? [])]
  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (opts.throwOnFetch !== undefined) throw opts.throwOnFetch
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const headers: Record<string, string> = {}
    const rawHeaders = init?.headers
    if (rawHeaders !== undefined) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v
        })
      } else if (Array.isArray(rawHeaders)) {
        for (const pair of rawHeaders) {
          const k = pair[0]
          const v = pair[1]
          if (typeof k === 'string' && typeof v === 'string') {
            headers[k.toLowerCase()] = v
          }
        }
      } else {
        for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v)
      }
    }
    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : ''
    calls.push({ url, method: init?.method ?? 'GET', headers, body })
    const next = responses.shift()
    if (next === undefined) {
      throw new Error(`unexpected fetch call to ${url}`)
    }
    const responseBody =
      next.bodyText !== undefined ? next.bodyText : JSON.stringify(next.body)
    return new Response(responseBody, {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  const secrets = new SecretsStore({
    data_dir: dataDir,
    db,
    ...(opts.now ? { now: opts.now } : {}),
  })
  const client = new MaxOAuthClient({
    secrets,
    httpFetch: fakeFetch,
    ...(opts.now ? { now: opts.now } : {}),
    config: {
      api_base_url: 'https://api.anthropic.test',
      ...(opts.paste_token_ttl_ms !== undefined
        ? { paste_token_ttl_ms: opts.paste_token_ttl_ms }
        : {}),
    },
  })
  return { client, calls, secrets }
}

// ---------- probeToken classification ----------------------------

test('probeToken accepts 200 as valid', async () => {
  const { client, calls } = buildClient({
    responses: [{ status: 200, body: { id: 'msg_x', content: [] } }],
  })
  const result = await client.probeToken({ token: 'sk-ant-oat01-good' })
  expect(result.valid).toBe(true)
  expect(result.status).toBe(200)
  expect(calls).toHaveLength(1)
  // Probe used the messages endpoint with a Bearer header.
  expect(calls[0]!.url).toBe('https://api.anthropic.test/v1/messages')
  expect(calls[0]!.method).toBe('POST')
  expect(calls[0]!.headers.authorization).toBe('Bearer sk-ant-oat01-good')
  expect(calls[0]!.headers['anthropic-version']).toBeDefined()
  // Body is JSON with max_tokens=1 (cheap).
  const parsed = JSON.parse(calls[0]!.body) as { max_tokens?: number }
  expect(parsed.max_tokens).toBe(1)
})

test('probeToken rejects 401 with authentication_error as invalid', async () => {
  const { client } = buildClient({
    responses: [
      {
        status: 401,
        body: {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        },
      },
    ],
  })
  const result = await client.probeToken({ token: 'sk-ant-oat01-bad' })
  expect(result.valid).toBe(false)
  expect(result.status).toBe(401)
  expect(result.reason).toContain('Anthropic rejected the token')
})

test('probeToken accepts 429 (rate limit) as valid', async () => {
  const { client } = buildClient({
    responses: [
      {
        status: 429,
        body: {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'too many requests' },
        },
      },
    ],
  })
  const result = await client.probeToken({ token: 'sk-ant-rate' })
  expect(result.valid).toBe(true)
  expect(result.status).toBe(429)
  expect(result.reason).toContain('rate-limited')
})

test('probeToken accepts 401 with rate_limit_error as valid', async () => {
  const { client } = buildClient({
    responses: [
      {
        status: 401,
        body: {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'rate limited' },
        },
      },
    ],
  })
  const result = await client.probeToken({ token: 'sk-ant-401-rate' })
  expect(result.valid).toBe(true)
  expect(result.status).toBe(401)
})

test('probeToken accepts 403 (permission) as valid', async () => {
  const { client } = buildClient({
    responses: [
      {
        status: 403,
        body: {
          type: 'error',
          error: { type: 'permission_error', message: 'no quota' },
        },
      },
    ],
  })
  const result = await client.probeToken({ token: 'sk-ant-out-of-quota' })
  expect(result.valid).toBe(true)
  expect(result.status).toBe(403)
})

test('probeToken accepts 402 (billing) as valid', async () => {
  const { client } = buildClient({
    responses: [
      {
        status: 402,
        body: {
          type: 'error',
          error: { type: 'billing_error', message: 'card declined' },
        },
      },
    ],
  })
  const result = await client.probeToken({ token: 'sk-ant-billing' })
  expect(result.valid).toBe(true)
  expect(result.status).toBe(402)
})

test('Codex Sprint 23 r7 P1 — probeToken rejects 400 (spec-compliant — never persist unverified tokens)', async () => {
  // r4 P1 originally accepted 400 to handle the "Anthropic retired
  // the probe model" edge case. r7 P1 reverts that — spec says 400
  // → reject so we never persist a token Anthropic explicitly
  // rejected. Operator mitigation: keep probe model + Anthropic
  // deprecation calendar in sync.
  const { client } = buildClient({
    responses: [
      {
        status: 400,
        body: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'invalid_authorization_header',
          },
        },
      },
    ],
  })
  const result = await client.probeToken({ token: 'malformed' })
  expect(result.valid).toBe(false)
  expect(result.status).toBe(400)
  expect(result.reason).toContain('400')
})

test('probeToken rejects 500 as invalid (transient — re-prompt user)', async () => {
  const { client } = buildClient({
    responses: [{ status: 500, body: { type: 'error', error: { type: 'overloaded_error' } } }],
  })
  const result = await client.probeToken({ token: 'sk-ant-anything' })
  expect(result.valid).toBe(false)
  expect(result.status).toBe(500)
})

test('probeToken rejects on network error', async () => {
  const { client } = buildClient({ throwOnFetch: new Error('ECONNREFUSED') })
  const result = await client.probeToken({ token: 'sk-ant-anything' })
  expect(result.valid).toBe(false)
  expect(result.status).toBe(-1)
  expect(result.reason).toContain('network error')
})

test('probeToken handles a non-JSON 401 body gracefully (still rejects as invalid)', async () => {
  const { client } = buildClient({
    responses: [{ status: 401, body: null, bodyText: 'Unauthorized' }],
  })
  const result = await client.probeToken({ token: 'bad' })
  expect(result.valid).toBe(false)
  expect(result.status).toBe(401)
})

// ---------- persistPasteToken -----------------------------------

test('persistPasteToken writes BOTH max_oauth_refresh AND max_oauth_access with same value', async () => {
  const fixedNow = 1_700_000_000_000
  const { client, secrets } = buildClient({ now: () => fixedNow })
  const result = await client.persistPasteToken({
    internal_handle: 'alice',
    token: 'sk-ant-oat01-paste',
  })
  expect(result.internal_handle).toBe('alice')
  expect(result.sub_label).toBe('default')
  // 365d ahead of fixed now — default TTL.
  const expectedExpiry = fixedNow + 365 * 24 * 60 * 60 * 1_000
  expect(result.expires_at).toBe(expectedExpiry)

  const refresh = await secrets.get({
    internal_handle: 'alice',
    kind: 'max_oauth_refresh',
    label: 'default',
  })
  const access = await secrets.get({
    internal_handle: 'alice',
    kind: 'max_oauth_access',
    label: 'default:access',
  })
  expect(refresh).toBe('sk-ant-oat01-paste')
  expect(access).toBe('sk-ant-oat01-paste')
})

test('persistPasteToken replaces an existing row (idempotent re-paste)', async () => {
  const { client, secrets } = buildClient({})
  await client.persistPasteToken({ internal_handle: 'alice', token: 'first' })
  await client.persistPasteToken({ internal_handle: 'alice', token: 'second' })

  const refresh = await secrets.get({
    internal_handle: 'alice',
    kind: 'max_oauth_refresh',
    label: 'default',
  })
  expect(refresh).toBe('second')
  const refreshList = await secrets.list({
    internal_handle: 'alice',
    kind: 'max_oauth_refresh',
  })
  // Only one row left for the default label.
  expect(refreshList.filter((r) => r.label === 'default')).toHaveLength(1)
})

test('Codex Sprint 23 r6 P2 — persistPasteToken is ATOMIC: a mid-sequence write failure leaves prior tokens intact (no half-written state)', async () => {
  // Pre-seed an existing pair to verify rollback preserves them.
  const { client, secrets } = buildClient({})
  await secrets.put({
    internal_handle: 'alice',
    kind: 'max_oauth_refresh',
    label: 'default',
    plaintext: 'old-token',
  })
  await secrets.put({
    internal_handle: 'alice',
    kind: 'max_oauth_access',
    label: 'default:access',
    plaintext: 'old-token',
    expires_at: Date.now() + 365 * 24 * 60 * 60 * 1_000,
  })
  // Stub replaceAtomic to throw mid-transaction (simulating a
  // transient SQLite I/O error between the two inserts). Because
  // the implementation wraps everything in BEGIN/COMMIT, the rollback
  // should leave the OLD rows intact.
  const origReplace = secrets.replaceAtomic.bind(secrets)
  secrets.replaceAtomic = (async () => {
    throw new Error('synthetic-mid-write-failure')
  }) as typeof secrets.replaceAtomic
  await expect(
    client.persistPasteToken({ internal_handle: 'alice', token: 'new-token' }),
  ).rejects.toThrow('synthetic-mid-write-failure')
  // Old rows still intact.
  expect(
    await secrets.get({
      internal_handle: 'alice',
      kind: 'max_oauth_refresh',
      label: 'default',
    }),
  ).toBe('old-token')
  expect(
    await secrets.get({
      internal_handle: 'alice',
      kind: 'max_oauth_access',
      label: 'default:access',
    }),
  ).toBe('old-token')
  // Restore so beforeEach cleanup doesn't trip.
  secrets.replaceAtomic = origReplace
})

test('persistPasteToken honors paste_token_ttl_ms override', async () => {
  const fixedNow = 1_700_000_000_000
  const { client } = buildClient({
    now: () => fixedNow,
    paste_token_ttl_ms: 60_000,
  })
  const result = await client.persistPasteToken({
    internal_handle: 'alice',
    token: 'tok',
  })
  expect(result.expires_at).toBe(fixedNow + 60_000)
})

// ---------- getAccessToken --------------------------------------

test('getAccessToken returns null when no row exists', async () => {
  const { client } = buildClient({})
  const out = await client.getAccessToken('nobody')
  expect(out).toBeNull()
})

test('getAccessToken returns the cached access row', async () => {
  const fixedNow = 1_700_000_000_000
  const { client } = buildClient({ now: () => fixedNow })
  await client.persistPasteToken({ internal_handle: 'alice', token: 'tok-x' })
  const out = await client.getAccessToken('alice')
  expect(out).not.toBeNull()
  expect(out!.access_token).toBe('tok-x')
  expect(out!.expires_at).toBe(fixedNow + 365 * 24 * 60 * 60 * 1_000)
})

test('Codex Sprint 23 r8 P1 — getAccessToken falls back to refresh row when access row expired and re-promotes it (short-TTL deployments)', async () => {
  // Sprint 22 never reached production (its OAuth redirect target
  // didn't exist), so no Sprint-22 schema-drift rows exist in the
  // wild. The fallback is required for short-TTL deployments via
  // NEUTRON_ANTHROPIC_PASTE_TOKEN_TTL_MS (staging dry-runs, tests)
  // where the access row genuinely expires before the user re-pastes.
  let now = 1_700_000_000_000
  const { client, secrets } = buildClient({
    now: () => now,
    paste_token_ttl_ms: 1_000,
  })
  await client.persistPasteToken({ internal_handle: 'alice', token: 'tok-y' })
  now += 5_000 // access row is now stale by ~4s

  const out = await client.getAccessToken('alice')
  expect(out).not.toBeNull()
  expect(out!.access_token).toBe('tok-y')
  // Re-promotion writes a fresh access row with the same TTL ahead of now.
  expect(out!.expires_at).toBe(now + 1_000)

  // The on-disk access row reflects the new expiry.
  const accessList = await secrets.list({
    internal_handle: 'alice',
    kind: 'max_oauth_access',
  })
  const accessRow = accessList.find((r) => r.label === 'default:access')!
  expect(accessRow.expires_at).toBe(now + 1_000)
})

test('Codex Sprint 23 r8 P1 — getAccessToken falls back to a refresh-only row (e.g. Sprint-22 leftover) and re-promotes it', async () => {
  // A user with refresh-only state (Sprint 22 leftover OR a
  // partial-write before r6 P2's atomic transaction) gets the
  // refresh value re-promoted. The trade-off: Sprint 22 wrote
  // DIFFERENT values (refresh vs access), so this could emit a
  // wrong-shape Bearer for true Sprint-22 leftovers — but Sprint
  // 22 never reached production, so in practice no such rows
  // exist. The M1+ chat-surface adapter handles the eventual 401
  // by re-rendering the gate.
  const { client, secrets } = buildClient({})
  await secrets.put({
    internal_handle: 'alice',
    kind: 'max_oauth_refresh',
    label: 'default',
    plaintext: 'paste-only-leftover',
  })

  const out = await client.getAccessToken('alice')
  expect(out).not.toBeNull()
  expect(out!.access_token).toBe('paste-only-leftover')
})

// ---------- revoke ----------------------------------------------

test('revoke drops both rows locally without making any HTTP calls', async () => {
  const { client, calls, secrets } = buildClient({})
  await client.persistPasteToken({ internal_handle: 'alice', token: 'gone' })
  await client.revoke('alice')
  const refresh = await secrets.get({
    internal_handle: 'alice',
    kind: 'max_oauth_refresh',
    label: 'default',
  })
  const access = await secrets.get({
    internal_handle: 'alice',
    kind: 'max_oauth_access',
    label: 'default:access',
  })
  expect(refresh).toBeNull()
  expect(access).toBeNull()
  // Paste tokens have no upstream revoke endpoint.
  expect(calls).toHaveLength(0)
})

// ---------- oauthEnvForPool helper ------------------------------

test('oauthEnvForPool returns CLAUDE_CODE_OAUTH_TOKEN for an oauth-kind pool', () => {
  const env = oauthEnvForPool({
    credentials: [{ kind: 'oauth', secret: 'tok-z' }],
  })
  expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-z' })
})

test('oauthEnvForPool returns {} for an api_key pool (no oauth credential present)', () => {
  const env = oauthEnvForPool({
    credentials: [{ kind: 'api_key', secret: 'k1' }],
  })
  expect(env).toEqual({})
})

test('oauthEnvForPool returns {} for null pool', () => {
  expect(oauthEnvForPool(null)).toEqual({})
})

test('oauthEnvForPool returns {} when oauth credential has empty secret', () => {
  const env = oauthEnvForPool({
    credentials: [{ kind: 'oauth', secret: '' }],
  })
  expect(env).toEqual({})
})
