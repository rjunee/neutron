/**
 * Round-1 BLOCKER fix — the Open composer must consume the SUBSCRIPTION OAuth
 * token, not just an API-billing key.
 *
 * Before this, `buildOpenGraphComposer` gated the entire LLM substrate on
 * `env['ANTHROPIC_API_KEY']` alone. So a self-hoster who authed via the
 * headline `curl | sh` flow — `claude setup-token`, which yields a
 * `CLAUDE_CODE_OAUTH_TOKEN` — booted the server LLM-less while the installer
 * reported success. `resolveOpenLlmPool` is the extracted, directly-testable
 * credential resolver that fixes it, mirroring the Managed resolver's
 * precedence (OAuth env wins over the shared ANTHROPIC_API_KEY env).
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

  test('neither set → null (box boots LLM-less, static onboarding prompts)', () => {
    expect(resolveOpenLlmPool({})).toBeNull()
  })

  test('empty-string credentials are treated as absent', () => {
    expect(resolveOpenLlmPool({ CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' })).toBeNull()
    // An empty OAuth token must fall through to a real API key, not win.
    const pool = resolveOpenLlmPool({ CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: 'sk-ant-api03-x' })
    expect(pool!.credentials[0]!.kind).toBe('api_key')
  })
})
