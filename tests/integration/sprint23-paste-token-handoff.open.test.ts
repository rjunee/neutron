/**
 * Sprint 23 — Max paste-token credential-resolution path (OPEN carve).
 *
 * The original Sprint 23 integration test was flagged likely-SPLIT: it
 * booted the central identity service + Hono app, seeded a provisioning
 * registry row, drove the `/oauth/max/start` → `/oauth/max/callback` HTTP
 * handoff, and asserted a `systemctl restart` of the per-owner systemd unit.
 * All of that lives in the Managed `identity/*` + provisioning trees and is
 * OUT of the Open carve.
 *
 * What SURVIVES into Open — and is what this file keeps as a real kernel —
 * is the single-owner Max-OAuth paste-token CREDENTIAL path:
 *
 *   1. The owner pastes a locally-acquired `claude setup-token` value.
 *   2. `MaxOAuthClient.probeToken` validates it against api.anthropic.com
 *      (mocked 200) using a Bearer header — exactly the production probe.
 *   3. `MaxOAuthClient.persistPasteToken` writes BOTH `max_oauth_refresh`
 *      AND `max_oauth_access` rows (same value) into the per-owner
 *      encrypted `SecretsStore`.
 *   4. The gateway-side credential resolver (`resolveLlmCredentials`)
 *      picks the persisted token up first, `selectCredential` returns a
 *      pool with kind='oauth', and `oauthEnvForPool` maps it to
 *      `CLAUDE_CODE_OAUTH_TOKEN` — what the Claude Code adapter consumes.
 *   5. Returning-owner path: a pre-seeded SecretsStore resolves to the
 *      same env without any re-paste.
 *
 * DROPPED vs the Managed original (all require identity/ + provisioning):
 *   - identity service boot (`openIdentityDb`, `buildService`, KeyManager).
 *   - provisioning registry seeding + `SignInTrigger.handleFirstSignin`.
 *   - the `/oauth/max/start` + `/oauth/max/callback` HTTP handoff + the
 *     install-token pipeline.
 *   - the `systemctl restart` of the per-owner systemd unit assertion.
 *   - the redirect-URL-shape assertions and the `/oauth/max/skip` HTTP test.
 *
 * Everything here imports only from `@neutronai/auth`, `@neutronai/runtime`,
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
import { MaxOAuthClient, oauthEnvForPool } from '@neutronai/auth/max-oauth.ts'
import {
  resolveLlmCredentials,
  wrapMaxOAuthSource,
} from '@neutronai/gateway/realmode-composer/resolve-llm-credentials.ts'
import { selectCredential } from '@neutronai/runtime/credential-pool.ts'

const NOW_FIXED = 1_700_000_000_000
const PASTED_TOKEN = 'sk-ant-oat01-goodXXXX'
const OWNER = 'alice'

let root: string
let dataDir: string
let db: ProjectDb

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sprint23-paste-open-'))
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

test('owner pastes Max OAuth token → probe 200 → persist → resolver returns Bearer pool → CLAUDE_CODE_OAUTH_TOKEN env', async () => {
  const secrets = new SecretsStore({
    data_dir: dataDir,
    db,
    now: () => NOW_FIXED,
  })

  // Mock api.anthropic.com — single 200 probe. Injected via httpFetch so
  // the global fetch is never patched.
  let probeHits = 0
  let lastProbeAuth = ''
  const fakeFetch = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    probeHits += 1
    const headers = init?.headers as Record<string, string> | undefined
    lastProbeAuth = headers?.['authorization'] ?? headers?.['Authorization'] ?? ''
    return new Response(JSON.stringify({ id: 'msg_x', content: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const maxClient = new MaxOAuthClient({
    secrets,
    httpFetch: fakeFetch,
    config: { api_base_url: 'https://api.anthropic.test' },
    now: () => NOW_FIXED,
  })

  // 1. Probe the pasted token (the paste-form's server-side validation).
  const probe = await maxClient.probeToken({ token: PASTED_TOKEN })
  expect(probe.valid).toBe(true)
  expect(probe.status).toBe(200)
  // The probe used the pasted token as a Bearer header.
  expect(probeHits).toBe(1)
  expect(lastProbeAuth).toBe(`Bearer ${PASTED_TOKEN}`)

  // 2. Persist — writes BOTH refresh AND access rows (same value; paste
  //    tokens have no separate access/refresh distinction).
  const persisted = await maxClient.persistPasteToken({
    internal_handle: OWNER,
    token: PASTED_TOKEN,
  })
  expect(persisted.internal_handle).toBe(OWNER)

  expect(
    await secrets.get({
      internal_handle: OWNER,
      kind: 'max_oauth_refresh',
      label: 'default',
    }),
  ).toBe(PASTED_TOKEN)
  expect(
    await secrets.get({
      internal_handle: OWNER,
      kind: 'max_oauth_access',
      label: 'default:access',
    }),
  ).toBe(PASTED_TOKEN)

  // 3. The gateway-side credential resolver picks up the token.
  const apiKeys = new ApiKeyStore({ db, secrets })
  const maxOAuth = wrapMaxOAuthSource(maxClient)
  const pool = await resolveLlmCredentials({
    internal_handle: OWNER,
    apiKeys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_ALICE', 'ANTHROPIC_API_KEY'],
    env: {},
    maxOAuth,
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe(PASTED_TOKEN)
  expect(sel?.kind).toBe('oauth')

  // 4. Tier-(5) plumbing: oauthEnvForPool maps the pool to the env var the
  //    Claude Code adapter consumes.
  const env = oauthEnvForPool(pool)
  expect(env).toEqual({
    CLAUDE_CODE_OAUTH_TOKEN: PASTED_TOKEN,
  })
})

test('returning owner with pre-seeded Max tokens resolves to CLAUDE_CODE_OAUTH_TOKEN without re-paste', async () => {
  const secrets = new SecretsStore({
    data_dir: dataDir,
    db,
    now: () => NOW_FIXED,
  })

  // Pre-seed Max paste-token rows (returning-owner path — no probe, no
  // re-paste; the encrypted store already holds the credential).
  await secrets.put({
    internal_handle: OWNER,
    kind: 'max_oauth_refresh',
    label: 'default',
    plaintext: 'pre-seeded-token',
  })
  await secrets.put({
    internal_handle: OWNER,
    kind: 'max_oauth_access',
    label: 'default:access',
    plaintext: 'pre-seeded-token',
    expires_at: NOW_FIXED + 3_600_000,
  })

  const maxClient = new MaxOAuthClient({
    secrets,
    // No probe should fire on the returning path; a throwing fetch proves
    // the resolver reads the persisted access row, not the network.
    httpFetch: async () => {
      throw new Error('returning-owner path must not hit the network')
    },
    config: { api_base_url: 'https://api.anthropic.test' },
    now: () => NOW_FIXED,
  })

  const apiKeys = new ApiKeyStore({ db, secrets })
  const maxOAuth = wrapMaxOAuthSource(maxClient)
  const pool = await resolveLlmCredentials({
    internal_handle: OWNER,
    apiKeys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_ALICE', 'ANTHROPIC_API_KEY'],
    env: {},
    maxOAuth,
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('pre-seeded-token')
  expect(sel?.kind).toBe('oauth')

  expect(oauthEnvForPool(pool)).toEqual({
    CLAUDE_CODE_OAUTH_TOKEN: 'pre-seeded-token',
  })
})

test('re-paste replaces the stored token (idempotent) and the resolver returns the new value', async () => {
  const secrets = new SecretsStore({
    data_dir: dataDir,
    db,
    now: () => NOW_FIXED,
  })
  const maxClient = new MaxOAuthClient({
    secrets,
    httpFetch: async () =>
      new Response(JSON.stringify({ id: 'msg_x', content: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    config: { api_base_url: 'https://api.anthropic.test' },
    now: () => NOW_FIXED,
  })

  await maxClient.persistPasteToken({ internal_handle: OWNER, token: 'first' })
  await maxClient.persistPasteToken({ internal_handle: OWNER, token: 'second' })

  // Only the latest value survives for the default label.
  const refreshList = await secrets.list({
    internal_handle: OWNER,
    kind: 'max_oauth_refresh',
  })
  expect(refreshList.filter((r) => r.label === 'default')).toHaveLength(1)

  const apiKeys = new ApiKeyStore({ db, secrets })
  const maxOAuth = wrapMaxOAuthSource(maxClient)
  const pool = await resolveLlmCredentials({
    internal_handle: OWNER,
    apiKeys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY'],
    env: {},
    maxOAuth,
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  expect(oauthEnvForPool(pool)).toEqual({
    CLAUDE_CODE_OAUTH_TOKEN: 'second',
  })
})
