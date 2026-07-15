import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ApiKeyStore } from '@neutronai/auth/api-key-store.ts'
import { selectCredential } from '@neutronai/runtime/credential-pool.ts'
import {
  envSuffixForSlug,
  resolveLlmCredentials,
} from '../resolve-llm-credentials.ts'

// ---------- envSuffixForSlug ---------------------------------------------

test('envSuffixForSlug: casey-test → CASEY_TEST', () => {
  expect(envSuffixForSlug('casey-test')).toBe('CASEY_TEST')
})

test('envSuffixForSlug: bob → BOB', () => {
  expect(envSuffixForSlug('bob')).toBe('BOB')
})

test('envSuffixForSlug: multi-word-slug → MULTI_WORD_SLUG', () => {
  expect(envSuffixForSlug('multi-word-slug')).toBe('MULTI_WORD_SLUG')
})

// ---------- resolveLlmCredentials ----------------------------------------

let workdir: string
let db: ProjectDb
let dataDir: string
let api_keys: ApiKeyStore
// console capture. The composer now logs through `@neutronai/logger`, whose
// default sink routes info→console.log and warn→console.warn (error→console.error).
// So INFO lines land on console.log; capture both console.log and console.info
// into `infoCalls` so the assertions on info-level lines keep working.
let infoCalls: string[]
let warnCalls: string[]
let originalInfo: typeof console.info
let originalWarn: typeof console.warn
let originalLog: typeof console.log

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-resolve-llm-'))
  dataDir = join(workdir, 'project')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(workdir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
  const secrets = new SecretsStore({ data_dir: dataDir, db })
  api_keys = new ApiKeyStore({ db, secrets })

  infoCalls = []
  warnCalls = []
  originalInfo = console.info
  originalWarn = console.warn
  originalLog = console.log
  const pushInfo = (...args: unknown[]): void => {
    infoCalls.push(args.map((a) => String(a)).join(' '))
  }
  console.info = pushInfo
  console.log = pushInfo // logger routes info→console.log
  console.warn = (...args: unknown[]): void => {
    warnCalls.push(args.map((a) => String(a)).join(' '))
  }
})

afterEach(() => {
  console.info = originalInfo
  console.warn = originalWarn
  console.log = originalLog
  rmSync(workdir, { recursive: true, force: true })
})

test('store has key → returns pool with that secret + INFO log', async () => {
  await api_keys.add({
    internal_handle: 'casey-test',
    provider: 'anthropic',
    label: 'primary',
    plaintext: 'sk-ant-stored',
  })
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: { ANTHROPIC_API_KEY: 'should-not-be-used' },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-ant-stored')
  expect(infoCalls.some((line) => line.includes('loaded from store'))).toBe(true)
  expect(warnCalls).toHaveLength(0)
})

test('no store, per-project env present → returns pool + INFO log (not WARN)', async () => {
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      ANTHROPIC_API_KEY_CASEY_TEST: 'sk-ant-per-project',
      ANTHROPIC_API_KEY: 'sk-ant-shared-not-used',
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-ant-per-project')
  expect(
    infoCalls.some((line) =>
      line.includes('loaded from per-project env ANTHROPIC_API_KEY_CASEY_TEST'),
    ),
  ).toBe(true)
  expect(warnCalls).toHaveLength(0)
})

test('no store, only shared env present → returns pool + WARN log', async () => {
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      ANTHROPIC_API_KEY: 'sk-ant-shared',
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-ant-shared')
  expect(
    warnCalls.some((line) =>
      line.includes('SHARED env key ANTHROPIC_API_KEY'),
    ),
  ).toBe(true)
  // No "loaded from per-instance env" or "loaded from store" INFO line should fire
  expect(infoCalls.some((line) => line.includes('per-project env'))).toBe(false)
  expect(infoCalls.some((line) => line.includes('loaded from store'))).toBe(false)
})

test('empty env values are skipped — first non-empty wins', async () => {
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: [
      'ANTHROPIC_API_KEY_CASEY_TEST',
      'ANTHROPIC_API_KEY_FALLBACK',
      'ANTHROPIC_API_KEY',
    ],
    env: {
      ANTHROPIC_API_KEY_CASEY_TEST: '',
      ANTHROPIC_API_KEY_FALLBACK: 'sk-ant-fallback',
      ANTHROPIC_API_KEY: 'sk-ant-shared',
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-ant-fallback')
  // Middle entry — neither shared (last) nor store, INFO log fires
  expect(
    infoCalls.some((line) =>
      line.includes('loaded from per-project env ANTHROPIC_API_KEY_FALLBACK'),
    ),
  ).toBe(true)
  expect(warnCalls).toHaveLength(0)
})

test('nothing anywhere → returns null + no logs', async () => {
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {},
  })
  expect(pool).toBeNull()
  expect(infoCalls).toHaveLength(0)
  expect(warnCalls).toHaveLength(0)
})

test('single env var entry that hits is treated as per-project, not shared (no WARN)', async () => {
  // Edge case: when env_vars has only 1 entry, the `i > 0` guard prevents
  // it being classified as "shared" — single-entry callers signal intent.
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_ONLY'],
    env: { ANTHROPIC_API_KEY_ONLY: 'sk-ant-only' },
  })
  expect(pool).not.toBeNull()
  expect(warnCalls).toHaveLength(0)
  expect(
    infoCalls.some((line) => line.includes('per-project env ANTHROPIC_API_KEY_ONLY')),
  ).toBe(true)
})

// ---------- Sprint 22: max_oauth source ---------------------------------

test('Sprint 22 — max_oauth wins over store + env when token is present (kind=oauth)', async () => {
  // Stash a BYO key in the store + a per-instance env var so we can prove
  // max_oauth wins over BOTH.
  await api_keys.add({
    internal_handle: 'casey-test',
    provider: 'anthropic',
    label: 'primary',
    plaintext: 'sk-ant-stored',
  })
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      ANTHROPIC_API_KEY_CASEY_TEST: 'sk-ant-per-project',
      ANTHROPIC_API_KEY: 'sk-ant-shared',
    },
    maxOAuth: {
      loadAccessToken: async () => ({
        access_token: 'sk-ant-oauth-bearer',
        expires_at: Date.now() + 3_600_000,
      }),
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-ant-oauth-bearer')
  // CRITICAL: kind must be 'oauth' so the consuming chat-surface
  // adapter emits `Authorization: Bearer ...` (NOT `x-api-key`).
  expect(sel?.kind).toBe('oauth')
  // 2026-05-31 — log line phrasing updated to "credential resolved from
  // max_oauth (will be threaded to claude subprocess as
  // CLAUDE_CODE_OAUTH_TOKEN)" — the credential pool itself doesn't
  // emit Bearer; the CC subprocess does.
  expect(infoCalls.some((line) => line.includes('credential resolved from max_oauth'))).toBe(true)
  expect(warnCalls).toHaveLength(0)
})

test('Sprint 22 — max_oauth returning null falls through to store (BYO)', async () => {
  await api_keys.add({
    internal_handle: 'casey-test',
    provider: 'anthropic',
    label: 'primary',
    plaintext: 'sk-ant-stored',
  })
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY'],
    env: {},
    maxOAuth: {
      loadAccessToken: async () => null,
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-ant-stored')
  expect(sel?.kind).toBe('api_key')
  expect(infoCalls.some((line) => line.includes('loaded from store'))).toBe(true)
})

test('Sprint 22 — max_oauth throwing falls through to next source with WARN', async () => {
  await api_keys.add({
    internal_handle: 'casey-test',
    provider: 'anthropic',
    label: 'primary',
    plaintext: 'sk-ant-stored',
  })
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY'],
    env: {},
    maxOAuth: {
      loadAccessToken: async () => {
        throw new Error('upstream refresh endpoint down')
      },
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  // BYO fallback served the request despite the OAuth throw.
  expect(sel?.secret).toBe('sk-ant-stored')
  expect(
    warnCalls.some((line) => line.includes('max-oauth loadAccessToken threw')),
  ).toBe(true)
})

test('Sprint 22 — max_oauth empty access_token treated as null (no pool emitted from it)', async () => {
  // Defense-in-depth: an empty string from a misbehaving source must
  // NOT mint a pool with empty Bearer header.
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY'],
    env: { ANTHROPIC_API_KEY: 'sk-ant-shared-fallback' },
    maxOAuth: {
      loadAccessToken: async () => ({ access_token: '', expires_at: Date.now() + 3600_000 }),
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-ant-shared-fallback')
  expect(sel?.kind).toBe('api_key')
})

test('Sprint 22 — gemini provider receives undefined maxOAuth, returns null when no key', async () => {
  // Gemini has no max-oauth path in M1; verify the resolver behaves
  // identically to pre-Sprint-22 when `maxOAuth` is undefined.
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'gemini',
    env_vars: ['GEMINI_API_KEY_CASEY_TEST', 'GEMINI_API_KEY'],
    env: {},
  })
  expect(pool).toBeNull()
})

// ---------- Swappable provider: OpenAI credential resolution -------------

test("provider='openai' resolves an api_key pool from OPENAI_API_KEY (tier 4), no maxOAuth", async () => {
  // The swappable-provider path relies on resolveLlmCredentials already
  // supporting non-anthropic providers via the generic env_vars / BYO-store
  // tiers. OpenAI has NO subscription-OAuth path (BYO OPENAI_API_KEY only), so
  // maxOAuth is undefined and the env-OAuth (tier 2) + ambient (tier 5) tiers
  // are correctly anthropic-only no-ops.
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'openai',
    env_vars: ['OPENAI_API_KEY'],
    env: { OPENAI_API_KEY: 'sk-openai-byo' },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-openai-byo')
  // OpenAI keys are x-api-key style → api_key kind (never oauth/ambient).
  expect(sel?.kind).toBe('api_key')
  expect(sel?.id).toBe('openai:OPENAI_API_KEY')
})

test("provider='openai' with a stray CLAUDE_CODE_OAUTH_TOKEN in env is NOT hijacked (anthropic-only tier 2)", async () => {
  // A box that has BOTH an anthropic OAuth token AND an OpenAI key in env must
  // not resolve the anthropic OAuth token for an openai request — tier 2 is
  // anthropic-only.
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'openai',
    env_vars: ['OPENAI_API_KEY'],
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oauth-should-be-ignored',
      OPENAI_API_KEY: 'sk-openai-byo',
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-openai-byo')
  expect(sel?.kind).toBe('api_key')
})

test("provider='openai' with no OpenAI key returns null (→ reconnect/skip)", async () => {
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'openai',
    env_vars: ['OPENAI_API_KEY'],
    env: {},
  })
  expect(pool).toBeNull()
})

// ---------- T15: process-env CLAUDE_CODE_OAUTH_TOKEN source -------------

test('T15 — process-env CLAUDE_CODE_OAUTH_TOKEN only → returns oauth-kind pool + WARN log', async () => {
  // No DB Max, no ApiKeyStore entry, no per-instance ANTHROPIC_API_KEY env.
  // Just CLAUDE_CODE_OAUTH_TOKEN exported into the gateway process env
  // (the synthetic-auth + dev/CI shape T11 wires via systemd
  // EnvironmentFile). Resolver must emit an oauth-kind pool so the
  // import substrate maps it onto Bearer auth.
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oauth-env-fallback',
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-ant-oauth-env-fallback')
  // CRITICAL: kind must be 'oauth' so the consuming substrate emits
  // `Authorization: Bearer ...` (NOT `x-api-key`). build-import-substrate
  // routes oauth-kind pools through CLAUDE_CODE_OAUTH_TOKEN (cc-adapter
  // tier 2 Bearer) rather than ANTHROPIC_API_KEY (tier 3 x-api-key).
  expect(sel?.kind).toBe('oauth')
  expect(
    warnCalls.some((line) =>
      line.includes('process-env CLAUDE_CODE_OAUTH_TOKEN'),
    ),
  ).toBe(true)
  // No store / per-instance-env INFO line should fire.
  expect(infoCalls.some((line) => line.includes('loaded from store'))).toBe(false)
  expect(infoCalls.some((line) => line.includes('per-project env'))).toBe(false)
})

test('T15 — DB Max (source 0) wins over CLAUDE_CODE_OAUTH_TOKEN (source 0.5)', async () => {
  // Production semantics: an attached / refreshable Max OAuth token
  // beats a static env-var fallback even when both are set on the same
  // box. This protects production instances that happen to inherit a stale
  // CLAUDE_CODE_OAUTH_TOKEN from the operator's process env.
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oauth-env-should-not-win',
    },
    maxOAuth: {
      loadAccessToken: async () => ({
        access_token: 'sk-ant-oauth-db-max',
        expires_at: Date.now() + 3_600_000,
      }),
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-ant-oauth-db-max')
  expect(sel?.kind).toBe('oauth')
  // 2026-05-31 — log line phrasing updated (see Sprint 22 test above).
  expect(
    infoCalls.some((line) => line.includes('credential resolved from max_oauth')),
  ).toBe(true)
  // Tier 0.5 must NOT have logged its WARN.
  expect(
    warnCalls.some((line) =>
      line.includes('process-env CLAUDE_CODE_OAUTH_TOKEN'),
    ),
  ).toBe(false)
})

test('T15 — CLAUDE_CODE_OAUTH_TOKEN (source 0.5) wins over ApiKeyStore (source 1)', async () => {
  // The env-var OAuth fallback sits between DB Max and the BYO
  // ApiKeyStore. Verifies the priority is correct: a synthetic-auth
  // an instance with a CLAUDE_CODE_OAUTH_TOKEN export AND a stored BYO key
  // uses the OAuth token (so the import substrate doesn't get an
  // x-api-key fragment when Max-OAuth headers are what the user
  // actually wants to exercise).
  await api_keys.add({
    internal_handle: 'casey-test',
    provider: 'anthropic',
    label: 'primary',
    plaintext: 'sk-ant-stored-byo',
  })
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oauth-env-wins',
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-ant-oauth-env-wins')
  expect(sel?.kind).toBe('oauth')
  expect(
    warnCalls.some((line) =>
      line.includes('process-env CLAUDE_CODE_OAUTH_TOKEN'),
    ),
  ).toBe(true)
  expect(infoCalls.some((line) => line.includes('loaded from store'))).toBe(false)
})

test('T15 — empty CLAUDE_CODE_OAUTH_TOKEN string is treated as unset (falls through)', async () => {
  // Defense-in-depth: an empty string from a misbehaving env-loader
  // must NOT mint an oauth pool with an empty Bearer header. Falls
  // through to the next source (here: per-instance API key env var).
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_API_KEY_CASEY_TEST: 'sk-ant-per-project',
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-ant-per-project')
  expect(sel?.kind).toBe('api_key')
  expect(
    warnCalls.some((line) =>
      line.includes('process-env CLAUDE_CODE_OAUTH_TOKEN'),
    ),
  ).toBe(false)
})

test('T15 — max_oauth THROWS + CLAUDE_CODE_OAUTH_TOKEN set + BYO store key → BYO wins (env tier 0.5 skipped)', async () => {
  // Codex r1 P2. The pre-T15 contract: when the Max refresh path throws
  // (revoked refresh token / network blip), the resolver falls through
  // to the stable BYO store so an instance with both a Max sub AND a
  // stored API key keeps working. Adding tier 0.5 between source 0 and
  // source 1 must NOT regress this — a stale operator-process
  // CLAUDE_CODE_OAUTH_TOKEN must not short-circuit the BYO recovery
  // path. Verified: tier 0.5 is skipped when source 0 threw.
  await api_keys.add({
    internal_handle: 'casey-test',
    provider: 'anthropic',
    label: 'primary',
    plaintext: 'sk-ant-stored-recovery',
  })
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY'],
    env: {
      // A stale env-var token also exported into the operator's process
      // env — must NOT win after the Max throw.
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-stale-env-oauth-from-operator',
    },
    maxOAuth: {
      loadAccessToken: async () => {
        throw new Error('upstream refresh endpoint down')
      },
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  const sel = selectCredential(pool)
  // Stable BYO recovery path served the request.
  expect(sel?.secret).toBe('sk-ant-stored-recovery')
  expect(sel?.kind).toBe('api_key')
  expect(
    warnCalls.some((line) => line.includes('max-oauth loadAccessToken threw')),
  ).toBe(true)
  // Tier 0.5 must NOT have logged its WARN — it was correctly skipped.
  expect(
    warnCalls.some((line) =>
      line.includes('process-env CLAUDE_CODE_OAUTH_TOKEN'),
    ),
  ).toBe(false)
})

test('T15 — gemini provider ignores CLAUDE_CODE_OAUTH_TOKEN (Anthropic-only env source)', async () => {
  // CLAUDE_CODE_OAUTH_TOKEN is Anthropic-specific by name. The cc-adapter
  // is the only consumer wired to it. For gemini / openai the env var
  // must NOT silently mint an oauth pool — those providers fall through
  // to their own per-instance + shared env API-key sources.
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'gemini',
    env_vars: ['GEMINI_API_KEY_CASEY_TEST', 'GEMINI_API_KEY'],
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oauth-should-not-be-used-for-gemini',
    },
  })
  expect(pool).toBeNull()
  expect(
    warnCalls.some((line) =>
      line.includes('process-env CLAUDE_CODE_OAUTH_TOKEN'),
    ),
  ).toBe(false)
})

// ---------- Item 3 bundle (2026-06-10): managed-mode shared-env gate ------
//
// On the MANAGED hosted deployment the shared trailing env key
// (the single-owner-box global credential, e.g. a bare ANTHROPIC_API_KEY
// exported box-wide) must be UNREACHABLE: an instance with no/expired Max
// OAuth gets `null` (→ the /chat reconnect gate), NEVER a silently
// borrowed box-global credential. On the OSS single-owner self-host
// ('open', the default) the shared key stays the legit, simplest auth
// model. The deployment-shape signal is `resolveDeploymentMode(env)` —
// the SAME env bag callers already pass (process.env in production,
// where systemd sets NEUTRON_ROLE).

test('managed mode: shared env key is REFUSED → null + refusal WARN (reconnect signal)', async () => {
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      NEUTRON_ROLE: 'managed',
      ANTHROPIC_API_KEY: 'sk-ant-shared-global',
    },
  })
  expect(pool).toBeNull()
  expect(
    warnCalls.some(
      (line) =>
        line.includes('SHARED env key ANTHROPIC_API_KEY') &&
        line.includes('managed') &&
        line.includes('refusing'),
    ),
  ).toBe(true)
  // The old "loaded from SHARED env key" success WARN must NOT fire.
  expect(warnCalls.some((line) => line.includes('loaded from SHARED'))).toBe(false)
})

// K11b2 boundary characterization (owner-approved trade-off, made explicit so
// it's greppable, not hidden): the retired `NEUTRON_DEPLOYMENT_MODE` alias no
// longer confers managed isolation. A box that set ONLY the alias resolves to
// `open` (see deployment-mode.ts) and therefore MAY load the shared env key —
// the exact opposite of the deleted alias-keyed test. Nothing sets the alias in
// either repo; the managed-mode security pin now lives solely on `NEUTRON_ROLE`
// (the WARN-checking test above). This test documents the accepted new behavior.
test('K11b2: retired NEUTRON_DEPLOYMENT_MODE alias → open → shared key IS usable (isolation now keyed on NEUTRON_ROLE only)', async () => {
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      NEUTRON_DEPLOYMENT_MODE: 'managed', // retired alias — ignored, resolves 'open'
      ANTHROPIC_API_KEY: 'sk-ant-shared-global',
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  // Prove the SHARED env key was actually loaded (not merely a non-null pool):
  // the alias resolving to 'open' is exactly what lets the box-global fallback
  // through — the contract this pins.
  const sel = selectCredential(pool)
  expect(sel?.secret).toBe('sk-ant-shared-global')
  expect(sel?.kind).toBe('api_key')
})

test('connect mode: shared env key also refused (only open may use it)', async () => {
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      NEUTRON_ROLE: 'connect',
      ANTHROPIC_API_KEY: 'sk-ant-shared-global',
    },
  })
  expect(pool).toBeNull()
})

test('managed mode: per-project tiers stay INTACT (per-project env resolves)', async () => {
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      NEUTRON_ROLE: 'managed',
      ANTHROPIC_API_KEY_CASEY_TEST: 'sk-ant-per-project',
      ANTHROPIC_API_KEY: 'sk-ant-shared-global',
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  expect(selectCredential(pool)?.secret).toBe('sk-ant-per-project')
})

test('managed mode: SecretsStore tier stays INTACT (BYO key resolves)', async () => {
  await api_keys.add({
    internal_handle: 'casey-test',
    provider: 'anthropic',
    label: 'primary',
    plaintext: 'sk-ant-stored',
  })
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      NEUTRON_ROLE: 'managed',
      ANTHROPIC_API_KEY: 'sk-ant-shared-global',
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  expect(selectCredential(pool)?.secret).toBe('sk-ant-stored')
})

test('managed mode: Max OAuth tier stays INTACT and wins', async () => {
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      NEUTRON_ROLE: 'managed',
      ANTHROPIC_API_KEY: 'sk-ant-shared-global',
    },
    maxOAuth: {
      loadAccessToken: async () => ({
        access_token: 'sk-ant-oauth-bearer',
        expires_at: Date.now() + 3_600_000,
      }),
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  expect(selectCredential(pool)?.secret).toBe('sk-ant-oauth-bearer')
})

test('open mode (explicit): shared env fallback still resolves — OSS self-host unbroken', async () => {
  const pool = await resolveLlmCredentials({
    internal_handle: 'casey-test',
    apiKeys: api_keys,
    provider: 'anthropic',
    env_vars: ['ANTHROPIC_API_KEY_CASEY_TEST', 'ANTHROPIC_API_KEY'],
    env: {
      NEUTRON_ROLE: 'open',
      ANTHROPIC_API_KEY: 'sk-ant-shared',
    },
  })
  expect(pool).not.toBeNull()
  if (pool === null) return
  expect(selectCredential(pool)?.secret).toBe('sk-ant-shared')
  expect(
    warnCalls.some((line) => line.includes('SHARED env key ANTHROPIC_API_KEY')),
  ).toBe(true)
})
