/**
 * C6 — Credential-resolver unification. Table-driven precedence tests proving
 * the ONE shared precedence table
 * (`gateway/wiring/resolve-llm-credentials.ts`) resolves IDENTICAL
 * credentials for identical inputs from BOTH call sites:
 *
 *   - Open  — `resolveOpenLlmPool` (sync, single-owner, `allowAmbient: true`)
 *   - realmode / Managed — `resolveLlmCredentials` (async, `allowAmbient` off)
 *
 * Before C6 the two resolvers duplicated the env-OAuth → API-key pool
 * construction by hand-kept comment; these tests pin the precedence
 * (env-OAuth > API-key > ambient) and the ambient-threads-NO-token property so
 * the shared table can never silently drift or leak a secret on the ambient
 * tier.
 *
 * SECURITY: the credential material is `kind` + `secret` (what actually reaches
 * the `claude` child). The pool `id` is internal bookkeeping and is NOT
 * asserted — only kind + secret must match across modes.
 */

import { describe, expect, test } from 'bun:test'

import { resolveOpenLlmPool } from '../composer.ts'
import type { ApiKeyStore } from '@neutronai/auth/api-key-store.ts'
import type { CredentialPool } from '@neutronai/runtime/credential-pool.ts'
import {
  resolveLlmCredentials,
  resolveEnvOAuthTier,
  resolveApiKeyEnvTier,
  resolveAmbientTier,
} from '@neutronai/gateway/wiring/resolve-llm-credentials.ts'

// An empty ApiKeyStore — the Managed resolver's BYO-store tier (3) is a no-op,
// so the ONLY sources are the SHARED env tiers, making the two modes directly
// comparable on the tiers they hold in common.
const EMPTY_STORE = { list: async () => [] } as unknown as ApiKeyStore

/** kind+secret of the single credential in a pool (or null). */
function cred(pool: CredentialPool | null): { kind: string; secret: string } | null {
  if (pool === null) return null
  expect(pool.credentials).toHaveLength(1)
  const c = pool.credentials[0]!
  return { kind: c.kind, secret: c.secret }
}

// ── Shared-tier parity: env-OAuth + API-key resolve identically both modes ──
//
// `probeAmbient` is Open-only (Managed has no ambient tier); every row here
// keeps `probeAmbient: false` so the ONLY difference between modes is the
// ambient tier, which these rows never reach.
type ParityRow = {
  name: string
  env: NodeJS.ProcessEnv
  expected: { kind: string; secret: string } | null
}

const SHARED_TIER_ROWS: ParityRow[] = [
  {
    name: 'env-OAuth only → oauth',
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-shared' },
    expected: { kind: 'oauth', secret: 'sk-ant-oat01-shared' },
  },
  {
    name: 'API-key only → api_key',
    env: { ANTHROPIC_API_KEY: 'sk-ant-api03-shared' },
    expected: { kind: 'api_key', secret: 'sk-ant-api03-shared' },
  },
  {
    name: 'BOTH set → env-OAuth WINS over API-key (precedence pin)',
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-win',
      ANTHROPIC_API_KEY: 'sk-ant-api03-lose',
    },
    expected: { kind: 'oauth', secret: 'sk-ant-oat01-win' },
  },
  {
    name: 'empty OAuth string is treated as unset → falls through to API-key',
    env: { CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: 'sk-ant-api03-x' },
    expected: { kind: 'api_key', secret: 'sk-ant-api03-x' },
  },
  {
    name: 'nothing set (no ambient) → null in both modes',
    env: {},
    expected: null,
  },
]

describe('C6 — shared env tiers resolve identically in Open and Managed', () => {
  for (const row of SHARED_TIER_ROWS) {
    test(`${row.name}`, async () => {
      // Open path — ambient probe forced false so the shared tiers are the
      // sole deciders (matching Managed, which has no ambient tier).
      const openCred = cred(resolveOpenLlmPool(row.env, { probeAmbientAuth: () => false }))

      // Managed path — no maxOAuth, empty store, single-entry env_vars in
      // 'open' mode so the shared-tier gate never refuses the API key.
      const managedCred = cred(
        await resolveLlmCredentials({
          internal_handle: 'owner',
          apiKeys: EMPTY_STORE,
          provider: 'anthropic',
          env_vars: ['ANTHROPIC_API_KEY'],
          env: row.env,
        }),
      )

      expect(openCred).toEqual(row.expected)
      expect(managedCred).toEqual(row.expected)
      // The two modes agree on every shared-tier input.
      expect(openCred).toEqual(managedCred)
    })
  }
})

// ── Ambient tier — Open-ONLY (the one intentional divergence) ───────────────

describe('C6 — ambient tier is Open-only and threads NO token', () => {
  test('no env cred + ambient present → Open yields ambient, Managed yields null', async () => {
    const openPool = resolveOpenLlmPool({}, { probeAmbientAuth: () => true })
    const openCred = cred(openPool)
    expect(openCred).not.toBeNull()
    expect(openCred!.kind).toBe('ambient')

    // Managed never enables the ambient tier for the SAME inputs.
    const managedPool = await resolveLlmCredentials({
      internal_handle: 'owner',
      apiKeys: EMPTY_STORE,
      provider: 'anthropic',
      env_vars: ['ANTHROPIC_API_KEY'],
      env: {},
    })
    expect(managedPool).toBeNull()
  })

  test('ambient-threads-NO-token: the ambient credential secret is the empty string', () => {
    const pool = resolveOpenLlmPool({}, { probeAmbientAuth: () => true })
    expect(pool!.credentials[0]!.kind).toBe('ambient')
    // CRITICAL: an ambient pool must carry NO secret — the substrate threads
    // nothing and the spawned `claude` child auths via its own Keychain.
    expect(pool!.credentials[0]!.secret).toBe('')
  })

  test('explicit env token wins over ambient — probe not consulted', () => {
    let probed = false
    const pool = resolveOpenLlmPool(
      { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-explicit' },
      {
        probeAmbientAuth: () => {
          probed = true
          return true
        },
      },
    )
    expect(cred(pool)).toEqual({ kind: 'oauth', secret: 'sk-ant-oat01-explicit' })
    expect(probed).toBe(false)
  })
})

// ── The tier helpers themselves (unit-level flag coverage) ──────────────────

describe('C6 — resolveAmbientTier flag coverage', () => {
  test('allowAmbient=false → null even when the probe would pass (Managed shape)', () => {
    const pool = resolveAmbientTier({
      provider: 'anthropic',
      allowAmbient: false,
      probeAmbientAuth: () => true,
    })
    expect(pool).toBeNull()
  })

  test('allowAmbient=true + probe false → null', () => {
    const pool = resolveAmbientTier({
      provider: 'anthropic',
      allowAmbient: true,
      probeAmbientAuth: () => false,
    })
    expect(pool).toBeNull()
  })

  test('allowAmbient=true + probe true → ambient pool, secret empty', () => {
    const pool = resolveAmbientTier({
      provider: 'anthropic',
      allowAmbient: true,
      probeAmbientAuth: () => true,
    })
    expect(cred(pool)).toEqual({ kind: 'ambient', secret: '' })
  })

  test('anthropic-only: gemini/openai never mint an ambient pool even when probe passes', () => {
    // Ambient/Keychain auth is a Claude-Code concept; a non-anthropic provider
    // has no ambient credential. Guard mirrors resolveEnvOAuthTier.
    for (const provider of ['gemini', 'openai'] as const) {
      const pool = resolveAmbientTier({
        provider,
        allowAmbient: true,
        probeAmbientAuth: () => true,
      })
      expect(pool).toBeNull()
    }
  })
})

describe('C6 — resolveEnvOAuthTier is anthropic-only', () => {
  test('gemini provider ignores CLAUDE_CODE_OAUTH_TOKEN', () => {
    const pool = resolveEnvOAuthTier({
      provider: 'gemini',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-should-not-be-used' },
    })
    expect(pool).toBeNull()
  })

  test('anthropic + non-empty token → oauth pool', () => {
    const pool = resolveEnvOAuthTier({
      provider: 'anthropic',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-a' },
    })
    expect(cred(pool)).toEqual({ kind: 'oauth', secret: 'sk-ant-oat01-a' })
  })
})

describe('C6 — resolveApiKeyEnvTier shared-tier gate (allowSharedEnvTier)', () => {
  const env_vars = ['ANTHROPIC_API_KEY_OWNER', 'ANTHROPIC_API_KEY'] as const

  test('per-project entry resolves regardless of the shared-tier flag', () => {
    const pool = resolveApiKeyEnvTier({
      provider: 'anthropic',
      env: { ANTHROPIC_API_KEY_OWNER: 'sk-ant-per-project' },
      env_vars: [...env_vars],
      allowSharedEnvTier: false,
    })
    expect(cred(pool)).toEqual({ kind: 'api_key', secret: 'sk-ant-per-project' })
  })

  test('shared trailing entry + allowSharedEnvTier=false → REFUSED (null)', () => {
    const pool = resolveApiKeyEnvTier({
      provider: 'anthropic',
      env: { ANTHROPIC_API_KEY: 'sk-ant-shared-global' },
      env_vars: [...env_vars],
      allowSharedEnvTier: false,
      deploymentModeLabel: 'managed',
    })
    expect(pool).toBeNull()
  })

  test('shared trailing entry + allowSharedEnvTier=true → resolves', () => {
    const pool = resolveApiKeyEnvTier({
      provider: 'anthropic',
      env: { ANTHROPIC_API_KEY: 'sk-ant-shared-global' },
      env_vars: [...env_vars],
      allowSharedEnvTier: true,
    })
    expect(cred(pool)).toEqual({ kind: 'api_key', secret: 'sk-ant-shared-global' })
  })

  test('single-entry env_vars is per-owner box key, never "shared" (Open shape)', () => {
    // allowSharedEnvTier=false must NOT refuse it — the i>0 guard means a lone
    // entry is never the shared tier. This is exactly the Open call shape.
    const pool = resolveApiKeyEnvTier({
      provider: 'anthropic',
      env: { ANTHROPIC_API_KEY: 'sk-ant-box' },
      env_vars: ['ANTHROPIC_API_KEY'],
      allowSharedEnvTier: false,
    })
    expect(cred(pool)).toEqual({ kind: 'api_key', secret: 'sk-ant-box' })
  })
})
