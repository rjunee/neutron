/**
 * Ambient/Keychain `claude` auth probe — the fresh-install 503 fix.
 *
 * The probe must be: platform-correct (Keychain on macOS, creds-file elsewhere),
 * fail-closed (any error/timeout → false, never throws), and cached (one probe
 * per TTL, not per `/chat` hit). These are exercised via the injected `deps`
 * seam so the suite is hermetic — it never depends on the runner actually having
 * a Keychain-authed `claude`.
 */

import { describe, expect, test, beforeEach } from 'bun:test'

import {
  detectAmbientClaudeAuth,
  detectAmbientClaudeAuthCached,
  __resetAmbientAuthCacheForTests,
  type AmbientAuthProbeDeps,
} from '../ambient-claude-auth.ts'

function deps(over: Partial<AmbientAuthProbeDeps>): AmbientAuthProbeDeps {
  return {
    platform: 'darwin',
    hasKeychainItem: () => false,
    hasCredentialsFile: () => false,
    ...over,
  }
}

beforeEach(() => __resetAmbientAuthCacheForTests())

describe('detectAmbientClaudeAuth — platform routing', () => {
  test('macOS: Keychain item present → true', () => {
    expect(detectAmbientClaudeAuth({}, deps({ platform: 'darwin', hasKeychainItem: () => true }))).toBe(true)
  })

  test('macOS: Keychain item absent → false (gate stays up)', () => {
    expect(detectAmbientClaudeAuth({}, deps({ platform: 'darwin', hasKeychainItem: () => false }))).toBe(false)
  })

  test('macOS consults the Keychain, NOT the creds file', () => {
    let credsChecked = false
    const r = detectAmbientClaudeAuth(
      {},
      deps({
        platform: 'darwin',
        hasKeychainItem: () => true,
        hasCredentialsFile: () => {
          credsChecked = true
          return false
        },
      }),
    )
    expect(r).toBe(true)
    expect(credsChecked).toBe(false)
  })

  test('linux: creds file present → true', () => {
    expect(detectAmbientClaudeAuth({}, deps({ platform: 'linux', hasCredentialsFile: () => true }))).toBe(true)
  })

  test('linux: creds file absent → false', () => {
    expect(detectAmbientClaudeAuth({}, deps({ platform: 'linux', hasCredentialsFile: () => false }))).toBe(false)
  })

  test('linux consults the creds file, NOT the Keychain', () => {
    let keychainChecked = false
    const r = detectAmbientClaudeAuth(
      {},
      deps({
        platform: 'linux',
        hasCredentialsFile: () => true,
        hasKeychainItem: () => {
          keychainChecked = true
          return false
        },
      }),
    )
    expect(r).toBe(true)
    expect(keychainChecked).toBe(false)
  })
})

describe('detectAmbientClaudeAuth — fail-closed (never throws, never hangs)', () => {
  test('a throwing Keychain probe → false, not a throw', () => {
    expect(() =>
      detectAmbientClaudeAuth(
        {},
        deps({
          platform: 'darwin',
          hasKeychainItem: () => {
            throw new Error('security: spawn ENOENT (or timed out)')
          },
        }),
      ),
    ).not.toThrow()
    expect(
      detectAmbientClaudeAuth(
        {},
        deps({
          platform: 'darwin',
          hasKeychainItem: () => {
            throw new Error('boom')
          },
        }),
      ),
    ).toBe(false)
  })

  test('a throwing creds-file probe → false', () => {
    expect(
      detectAmbientClaudeAuth(
        {},
        deps({
          platform: 'linux',
          hasCredentialsFile: () => {
            throw new Error('EACCES')
          },
        }),
      ),
    ).toBe(false)
  })
})

describe('detectAmbientClaudeAuthCached — memoization', () => {
  test('probes once within the TTL, returns the cached value thereafter', () => {
    let calls = 0
    const d = deps({
      platform: 'darwin',
      hasKeychainItem: () => {
        calls += 1
        return true
      },
    })
    expect(detectAmbientClaudeAuthCached({}, d)).toBe(true)
    expect(detectAmbientClaudeAuthCached({}, d)).toBe(true)
    expect(detectAmbientClaudeAuthCached({}, d)).toBe(true)
    expect(calls).toBe(1)
  })

  test('cache reset re-probes', () => {
    let calls = 0
    const d = deps({
      platform: 'darwin',
      hasKeychainItem: () => {
        calls += 1
        return false
      },
    })
    expect(detectAmbientClaudeAuthCached({}, d)).toBe(false)
    __resetAmbientAuthCacheForTests()
    expect(detectAmbientClaudeAuthCached({}, d)).toBe(false)
    expect(calls).toBe(2)
  })
})
