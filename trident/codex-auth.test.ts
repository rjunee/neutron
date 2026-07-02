/**
 * `trident/codex-auth.ts` — pure validation + materialize + status.
 *
 * The hard rule under test: SUBSCRIPTION auth (tokens.refresh_token) is accepted
 * + normalized; a metered OPENAI_API_KEY (auth_mode=apikey) or a bare sk- paste
 * is REJECTED. Materialization writes a 0600 auth.json at CODEX_HOME so
 * codex-review.sh's exit-10 NOT_CONNECTED branch is bypassed.
 */

import { describe, expect, test, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexAuthPath,
  deriveCodexStatus,
  materializeCodexAuth,
  readMaterializedAuth,
  removeCodexAuth,
  resolveCodexHome,
  validateCodexSubscriptionAuth,
  type CodexAuthFile,
} from './codex-auth.ts'

const NOW = 1_800_000_000_000 // fixed clock
const now = (): number => NOW

/** Build a minimal JWT access token with the given `exp` (seconds). */
function jwt(expSeconds: number): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: expSeconds })}.sig`
}

/** A well-formed subscription auth.json blob. */
function subscriptionAuth(opts: { exp?: number; openaiKey?: string | null } = {}): string {
  const access = opts.exp !== undefined ? jwt(opts.exp) : 'opaque-access-token'
  return JSON.stringify({
    OPENAI_API_KEY: opts.openaiKey ?? null,
    tokens: {
      id_token: 'id-tok',
      access_token: access,
      refresh_token: 'refresh-tok',
      account_id: 'acct_123',
    },
    last_refresh: '2026-06-30T00:00:00.000Z',
  })
}

describe('validateCodexSubscriptionAuth', () => {
  test('accepts a subscription auth.json and normalizes it (strips OPENAI_API_KEY)', () => {
    const v = validateCodexSubscriptionAuth(subscriptionAuth(), now)
    expect(v.ok).toBe(true)
    expect(v.mode).toBe('subscription')
    const parsed = JSON.parse(v.normalized ?? '{}') as CodexAuthFile
    expect(parsed.tokens.access_token).toBe('opaque-access-token')
    expect(parsed.tokens.refresh_token).toBe('refresh-tok')
    expect(parsed.tokens.id_token).toBe('id-tok')
    // OPENAI_API_KEY must NOT survive into the normalized bundle.
    expect((parsed as { OPENAI_API_KEY?: unknown }).OPENAI_API_KEY).toBeUndefined()
    expect(parsed.last_refresh).toBe('2026-06-30T00:00:00.000Z')
  })

  test('REJECTS a metered OPENAI_API_KEY inside auth.json (auth_mode=apikey)', () => {
    const v = validateCodexSubscriptionAuth(subscriptionAuth({ openaiKey: 'sk-live-abc123' }), now)
    expect(v.ok).toBe(false)
    expect(v.mode).toBe('apikey')
    expect(v.code).toBe('metered_key')
    expect(v.error?.toLowerCase()).toContain('metered')
  })

  test('REJECTS a bare sk- API key paste as metered', () => {
    const v = validateCodexSubscriptionAuth('sk-proj-ABCDEF0123456789', now)
    expect(v.ok).toBe(false)
    expect(v.mode).toBe('apikey')
    expect(v.code).toBe('metered_key')
  })

  test('rejects apikey-mode auth.json (no tokens, only OPENAI_API_KEY)', () => {
    const v = validateCodexSubscriptionAuth(
      JSON.stringify({ OPENAI_API_KEY: 'sk-abc', tokens: null, last_refresh: null }),
      now,
    )
    expect(v.ok).toBe(false)
    expect(v.code).toBe('metered_key')
  })

  test('rejects auth.json missing refresh_token (not a subscription login)', () => {
    const v = validateCodexSubscriptionAuth(
      JSON.stringify({ tokens: { access_token: 'a' }, last_refresh: 'x' }),
      now,
    )
    expect(v.ok).toBe(false)
    expect(v.code).toBe('missing_tokens')
    expect(v.error).toContain('refresh_token')
  })

  test('rejects malformed / non-JSON / empty', () => {
    expect(validateCodexSubscriptionAuth('', now).code).toBe('malformed')
    expect(validateCodexSubscriptionAuth('not json {', now).code).toBe('malformed')
    expect(validateCodexSubscriptionAuth('[1,2,3]', now).code).toBe('malformed')
    expect(validateCodexSubscriptionAuth(42, now).code).toBe('malformed')
  })

  test('defaults last_refresh to now when absent/invalid', () => {
    const v = validateCodexSubscriptionAuth(
      JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } }),
      now,
    )
    expect(v.ok).toBe(true)
    const parsed = JSON.parse(v.normalized ?? '{}') as CodexAuthFile
    expect(parsed.last_refresh).toBe(new Date(NOW).toISOString())
  })
})

describe('materializeCodexAuth + resolveCodexHome', () => {
  let tmp: string
  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true })
  })

  test('resolveCodexHome is <owner_home>/.codex', () => {
    expect(resolveCodexHome({ owner_home: '/data/owner' })).toBe('/data/owner/.codex')
  })

  test('writes auth.json at CODEX_HOME with mode 0600', () => {
    tmp = mkdtempSync(join(tmpdir(), 'codex-mat-'))
    const codexHome = join(tmp, '.codex')
    const { path } = materializeCodexAuth({ codexHome, authJson: subscriptionAuth() })
    expect(path).toBe(codexAuthPath(codexHome))
    expect(existsSync(path)).toBe(true)
    // 0600 — owner rw only (mirrors chatgpt-oauth writeCodexAuthFile).
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readMaterializedAuth(codexHome)).not.toBeNull()
    removeCodexAuth(codexHome)
    expect(readMaterializedAuth(codexHome)).toBeNull()
    // removeCodexAuth is idempotent.
    expect(() => removeCodexAuth(codexHome)).not.toThrow()
  })
})

describe('deriveCodexStatus', () => {
  test('connected when tokens present and access token unexpired', () => {
    const s = deriveCodexStatus(subscriptionAuth({ exp: Math.floor(NOW / 1000) + 3600 }), {
      materialized: true,
      now,
    })
    expect(s.status).toBe('connected')
    expect(s.materialized).toBe(true)
    expect(s.expires_at).toBeDefined()
  })

  test('connected (opaque, non-JWT token) — treated as non-expiring here', () => {
    const s = deriveCodexStatus(subscriptionAuth(), { materialized: true, now })
    expect(s.status).toBe('connected')
    expect(s.expires_at).toBeUndefined()
  })

  test('expired when the access-token JWT exp is in the past', () => {
    const s = deriveCodexStatus(subscriptionAuth({ exp: Math.floor(NOW / 1000) - 10 }), {
      materialized: true,
      now,
    })
    expect(s.status).toBe('expired')
    expect(s.expires_at).toBeDefined()
  })

  test('not_connected for null / unreadable / tokenless', () => {
    expect(deriveCodexStatus(null, { materialized: false, now }).status).toBe('not_connected')
    expect(deriveCodexStatus('{not json', { materialized: false, now }).status).toBe('not_connected')
    expect(
      deriveCodexStatus(JSON.stringify({ tokens: {} }), { materialized: false, now }).status,
    ).toBe('not_connected')
  })
})
