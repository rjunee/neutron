/**
 * S2 (b) — fail-closed wide-bind policy boundary tests.
 *
 * A WIDE (non-loopback) bind while any dev-auth bypass env is set must FAIL
 * LOUD at boot; a loopback bind (the 127.0.0.1 dogfood default) must be a
 * no-op even with every bypass env set. Each guard is mutation-verified: the
 * loopback exemption AND the wide-bind refusal both have a would-go-red case.
 */
import { describe, expect, it } from 'bun:test'

import {
  DEV_BYPASS_ENV_VARS,
  assertOwnerCredentialPolicy,
  assertWideBindPolicy,
  isLoopbackBindHost,
  type OwnerCredentialSource,
} from '../boot-bind-policy.ts'

describe('isLoopbackBindHost', () => {
  it('treats genuine loopbacks as loopback', () => {
    for (const h of [
      '127.0.0.1',
      '127.0.0.255',
      '127.1.2.3',
      '127.0.0.5',
      ' 127.0.0.1 ',
      'localhost',
      'LOCALHOST',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLoopbackBindHost(h)).toBe(true)
    }
  })
  it('treats every wide bind as NOT loopback', () => {
    for (const h of ['0.0.0.0', '::', '[::]', '192.168.1.20', '10.0.0.3', 'example.com', 'box.local']) {
      expect(isLoopbackBindHost(h)).toBe(false)
    }
  })
  it('STRICTLY validates the 127.0.0.0/8 octets — malformed 127.* is NOT loopback (High)', () => {
    for (const h of [
      '127.0.0.256', // octet overflow
      '127.999.999.999', // wildly invalid (could resolve as a hostname → non-loopback)
      '127.0.0', // too few parts
      '127.0.0.1.5', // too many parts
      '127.0.0.01', // leading-zero ambiguity
      '127.0.0.1.evil.com', // hostname suffix
      '127x0x0x1', // not dotted-quad
      '127..0.1', // empty octet
      '127.0.0.1.', // trailing dot
      '0.0.0.0',
      '10.0.0.1',
      '::ffff:10.0.0.1', // mapped NON-loopback
    ]) {
      expect(isLoopbackBindHost(h)).toBe(false)
    }
  })
})

describe('assertWideBindPolicy', () => {
  it('is a no-op on a loopback bind even with EVERY dev-bypass env set', () => {
    const env: Record<string, string> = {}
    for (const name of DEV_BYPASS_ENV_VARS) env[name] = '1'
    // Loopback (dogfood) — dev ergonomics untouched.
    expect(() => assertWideBindPolicy('127.0.0.1', env)).not.toThrow()
    expect(() => assertWideBindPolicy('localhost', env)).not.toThrow()
  })

  it('is a no-op on a wide bind with NO dev-bypass env set (operator-fronted)', () => {
    expect(() => assertWideBindPolicy('0.0.0.0', {})).not.toThrow()
    expect(() => assertWideBindPolicy('192.168.1.10', { NODE_ENV: 'production' })).not.toThrow()
  })

  it('REFUSES a wide bind for EACH dev-bypass env individually (mutation per-var)', () => {
    for (const name of DEV_BYPASS_ENV_VARS) {
      expect(() => assertWideBindPolicy('0.0.0.0', { [name]: name.includes('SECRET') ? 's3cr3t' : '1' })).toThrow(
        new RegExp(name),
      )
    }
  })

  it('REFUSES a wide bind when a SECRET-valued bypass var is "0" / "false" (#4)', () => {
    // A *_SECRET var activates on ANY non-empty string (HS256 secret length>0),
    // so "false" / "0" are LIVE secrets — must be caught, not exempted.
    for (const name of ['NEUTRON_APP_WS_DEV_SECRET', 'NEUTRON_E2E_DEV_SECRET']) {
      for (const val of ['false', '0']) {
        expect(() => assertWideBindPolicy('0.0.0.0', { [name]: val })).toThrow(new RegExp(name))
      }
    }
  })

  it('REFUSES a wide bind when a SECRET-valued bypass var is WHITESPACE-only (Blocker #1)', () => {
    // The consumer keys on the UNTRIMMED length (`hs256_secret.length > 0`), so a
    // 3-space secret is live HS256 — the guard must NOT trim it away.
    for (const name of ['NEUTRON_APP_WS_DEV_SECRET', 'NEUTRON_E2E_DEV_SECRET']) {
      for (const val of ['   ', '\t', ' \n ']) {
        expect(() => assertWideBindPolicy('0.0.0.0', { [name]: val })).toThrow(new RegExp(name))
      }
    }
  })

  it('an EMPTY SECRET var is UNSET (consumer length === 0 → HS256 off)', () => {
    for (const name of ['NEUTRON_APP_WS_DEV_SECRET', 'NEUTRON_E2E_DEV_SECRET']) {
      expect(() => assertWideBindPolicy('0.0.0.0', { [name]: '' })).not.toThrow()
    }
  })

  it('names all offending vars when several are set at once', () => {
    let thrown: Error | null = null
    try {
      assertWideBindPolicy('0.0.0.0', { NEUTRON_DEV_AUTH: '1', NEUTRON_APP_WS_BYPASS: '1' })
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).not.toBeNull()
    expect(thrown!.message).toContain('NEUTRON_DEV_AUTH')
    expect(thrown!.message).toContain('NEUTRON_APP_WS_BYPASS')
  })

  it('treats a FLAG bypass var off/empty as UNSET (consumer activates only on "1")', () => {
    // NEUTRON_DEV_AUTH / NEUTRON_APP_WS_BYPASS activate strictly on "1", so any
    // other value is genuinely off — no false-positive boot refusal.
    for (const name of ['NEUTRON_DEV_AUTH', 'NEUTRON_APP_WS_BYPASS']) {
      for (const off of ['0', 'false', 'FALSE', 'true', 'yes', '', '   ']) {
        expect(() => assertWideBindPolicy('0.0.0.0', { [name]: off })).not.toThrow()
      }
    }
  })
})

describe('assertOwnerCredentialPolicy (S1)', () => {
  const WIDE = ['0.0.0.0', '::', '192.168.1.20', '10.0.0.3', 'box.local'] as const
  const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'] as const

  it('is a no-op on a LOOPBACK bind for EVERY source (dev bypass preserved, incl. ephemeral)', () => {
    for (const host of LOOPBACK) {
      for (const source of ['env', 'persisted', 'ephemeral'] as OwnerCredentialSource[]) {
        expect(() => assertOwnerCredentialPolicy(host, source)).not.toThrow()
      }
    }
  })

  it('ALLOWS a WIDE bind with a PERSISTENT owner credential (env / persisted)', () => {
    for (const host of WIDE) {
      expect(() => assertOwnerCredentialPolicy(host, 'env')).not.toThrow()
      expect(() => assertOwnerCredentialPolicy(host, 'persisted')).not.toThrow()
    }
  })

  it('REFUSES a WIDE bind whose owner credential is only EPHEMERAL (fail-closed)', () => {
    for (const host of WIDE) {
      expect(() => assertOwnerCredentialPolicy(host, 'ephemeral')).toThrow(/refusing to boot/)
    }
  })

  it('the refusal names the host and points at the three remedies', () => {
    let thrown: Error | null = null
    try {
      assertOwnerCredentialPolicy('0.0.0.0', 'ephemeral')
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).not.toBeNull()
    expect(thrown!.message).toContain('0.0.0.0')
    expect(thrown!.message).toContain('NEUTRON_OWNER_BEARER')
    expect(thrown!.message).toContain('NEUTRON_HOST=127.0.0.1')
  })

  it('mutation guard: the loopback exemption AND the wide refusal each have a red case', () => {
    // Loopback ephemeral must NOT throw (exemption); wide ephemeral MUST throw
    // (refusal). Swapping either branch flips exactly one of these.
    expect(() => assertOwnerCredentialPolicy('127.0.0.1', 'ephemeral')).not.toThrow()
    expect(() => assertOwnerCredentialPolicy('0.0.0.0', 'ephemeral')).toThrow()
  })
})
