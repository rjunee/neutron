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
  assertWideBindPolicy,
  isLoopbackBindHost,
} from '../boot-bind-policy.ts'

describe('isLoopbackBindHost', () => {
  it('treats loopback literals as loopback', () => {
    for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', '127.0.0.5', ' 127.0.0.1 ']) {
      expect(isLoopbackBindHost(h)).toBe(true)
    }
  })
  it('treats every wide bind as NOT loopback', () => {
    for (const h of ['0.0.0.0', '::', '[::]', '192.168.1.20', '10.0.0.3', 'example.com', 'box.local']) {
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

  it('REFUSES a wide bind when a SECRET-valued bypass var is "0" / "false" (High #4)', () => {
    // A *_SECRET var activates on ANY non-empty string (HS256 secret length>0),
    // so "false" / "0" are LIVE secrets — must be caught, not exempted.
    for (const name of ['NEUTRON_APP_WS_DEV_SECRET', 'NEUTRON_E2E_DEV_SECRET']) {
      for (const val of ['false', '0']) {
        expect(() => assertWideBindPolicy('0.0.0.0', { [name]: val })).toThrow(new RegExp(name))
      }
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
