/**
 * Round-1 BLOCKER fix — the Open composer must consume the SUBSCRIPTION OAuth
 * token, not just an API-billing key.
 *
 * Before this, `buildOpenGraphComposer` gated the entire LLM substrate on
 * `env['ANTHROPIC_API_KEY']` alone. So a self-hoster who authed via the
 * headline `curl | sh` flow — `claude setup-token`, which yields a
 * `CLAUDE_CODE_OAUTH_TOKEN` — booted the server LLM-less while the installer
 * reported success. `resolveOpenLlmPool` is the extracted, directly-testable
 * credential resolver that fixes it. C6 (2026-07-09): it now walks the SHARED
 * precedence table in `gateway/realmode-composer/resolve-llm-credentials.ts`
 * (OAuth env wins over the ANTHROPIC_API_KEY env, then ambient) — the same
 * tier helpers the Managed resolver consumes, so the two can no longer drift.
 * Cross-mode parity is pinned in `credential-precedence-c6.test.ts`.
 */

import { describe, expect, test } from 'bun:test'

import { resolveOpenLlmPool } from '../composer.ts'

describe('resolveOpenLlmPool — Open single-owner credential resolution', () => {
  test('CLAUDE_CODE_OAUTH_TOKEN (subscription) → oauth-kind pool', () => {
    const pool = resolveOpenLlmPool({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abc' })
    expect(pool).not.toBeNull()
    expect(pool!.credentials).toHaveLength(1)
    expect(pool!.credentials[0]!.kind).toBe('oauth')
    expect(pool!.credentials[0]!.secret).toBe('sk-ant-oat01-abc')
  })

  test('ANTHROPIC_API_KEY (API billing) → api_key-kind pool', () => {
    const pool = resolveOpenLlmPool({ ANTHROPIC_API_KEY: 'sk-ant-api03-xyz' })
    expect(pool).not.toBeNull()
    expect(pool!.credentials).toHaveLength(1)
    expect(pool!.credentials[0]!.kind).toBe('api_key')
    expect(pool!.credentials[0]!.secret).toBe('sk-ant-api03-xyz')
  })

  test('both set → subscription OAuth wins (mirrors Managed resolver precedence)', () => {
    const pool = resolveOpenLlmPool({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-win',
      ANTHROPIC_API_KEY: 'sk-ant-api03-lose',
    })
    expect(pool!.credentials[0]!.kind).toBe('oauth')
    expect(pool!.credentials[0]!.secret).toBe('sk-ant-oat01-win')
  })

  test('neither env token set AND no ambient auth → null (box boots LLM-less)', () => {
    // Inject `probeAmbientAuth: () => false` so the result does not depend on
    // whether the test runner happens to have a Keychain-authed `claude`.
    expect(resolveOpenLlmPool({}, { probeAmbientAuth: () => false })).toBeNull()
  })

  test('no env token BUT ambient/Keychain auth present → ambient-kind pool (fresh-install 503 fix)', () => {
    const pool = resolveOpenLlmPool({}, { probeAmbientAuth: () => true })
    expect(pool).not.toBeNull()
    expect(pool!.credentials).toHaveLength(1)
    expect(pool!.credentials[0]!.kind).toBe('ambient')
    // The ambient cred carries NO secret — the substrate threads nothing and the
    // spawned `claude` child auths via its own Keychain.
    expect(pool!.credentials[0]!.secret).toBe('')
  })

  test('explicit env token wins over ambient — probe is NOT consulted', () => {
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
    expect(pool!.credentials[0]!.kind).toBe('oauth')
    expect(pool!.credentials[0]!.secret).toBe('sk-ant-oat01-explicit')
    // The explicit-token branch short-circuits BEFORE the probe (no subprocess).
    expect(probed).toBe(false)
  })

  test('empty-string credentials are treated as absent (then fall through to ambient probe)', () => {
    expect(
      resolveOpenLlmPool(
        { CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' },
        { probeAmbientAuth: () => false },
      ),
    ).toBeNull()
    // An empty OAuth token must fall through to a real API key, not win.
    const pool = resolveOpenLlmPool(
      { CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: 'sk-ant-api03-x' },
      { probeAmbientAuth: () => false },
    )
    expect(pool!.credentials[0]!.kind).toBe('api_key')
    // Both env vars empty + ambient auth present → ambient pool (gate clears).
    const ambient = resolveOpenLlmPool(
      { CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' },
      { probeAmbientAuth: () => true },
    )
    expect(ambient!.credentials[0]!.kind).toBe('ambient')
  })
})

describe('chat auth-gate predicate — ambient/Keychain clears the 503 (single-owner)', () => {
  // The Open composer wires `chatAuthGate.isUnauthenticated = () =>
  // resolveOpenLlmPool(env) === null`. These assert the gate decision the way
  // `GET /chat` consumes it: pool present → serve the chat shell; pool null →
  // 503 "Authenticate Claude".
  const isUnauthenticated = (env: NodeJS.ProcessEnv, probe: () => boolean): boolean =>
    resolveOpenLlmPool(env, { probeAmbientAuth: probe }) === null

  test('fresh single-owner box, no env token but `claude` Keychain-authed → gate INERT (serves chat)', () => {
    expect(isUnauthenticated({}, () => true)).toBe(false)
  })

  test('truly no auth (no env token, no ambient) → gate ENGAGED (503)', () => {
    expect(isUnauthenticated({}, () => false)).toBe(true)
  })

  test('explicit env token → gate inert regardless of ambient state', () => {
    expect(isUnauthenticated({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' }, () => false)).toBe(false)
  })
})
