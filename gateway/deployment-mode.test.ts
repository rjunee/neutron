import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DEPLOYMENT_MODE,
  DEPLOYMENT_ROLE_ENV,
  resolveDeploymentMode,
} from './deployment-mode.ts'

describe('resolveDeploymentMode', () => {
  test('defaults to open when unset', () => {
    expect(resolveDeploymentMode({})).toBe('open')
    expect(DEFAULT_DEPLOYMENT_MODE).toBe('open')
  })

  test('resolves managed (case-insensitive, trimmed)', () => {
    expect(resolveDeploymentMode({ NEUTRON_ROLE: 'managed' })).toBe('managed')
    expect(resolveDeploymentMode({ NEUTRON_ROLE: '  Managed ' })).toBe('managed')
  })

  test('resolves open explicitly', () => {
    expect(resolveDeploymentMode({ NEUTRON_ROLE: 'open' })).toBe('open')
  })

  test('unknown value falls back to default open', () => {
    expect(resolveDeploymentMode({ NEUTRON_ROLE: 'banana' })).toBe('open')
  })

  // M2.6 Ph0 — connect profile + NEUTRON_ROLE canonical/alias reconciliation
  // (brief § 2, test § 6.6). Alias retired in K11b2.
  describe('M2.6 Ph0 — connect profile + NEUTRON_ROLE', () => {
    test('canonical key name', () => {
      expect(DEPLOYMENT_ROLE_ENV).toBe('NEUTRON_ROLE')
    })

    test('resolves connect via the canonical NEUTRON_ROLE (case-insensitive, trimmed)', () => {
      expect(resolveDeploymentMode({ NEUTRON_ROLE: 'connect' })).toBe('connect')
      expect(resolveDeploymentMode({ NEUTRON_ROLE: '  Connect ' })).toBe('connect')
    })

    test('NEUTRON_ROLE also resolves open / managed', () => {
      expect(resolveDeploymentMode({ NEUTRON_ROLE: 'open' })).toBe('open')
      expect(resolveDeploymentMode({ NEUTRON_ROLE: 'managed' })).toBe('managed')
    })

    test('unset → open', () => {
      expect(resolveDeploymentMode({})).toBe('open')
    })

    test('unknown NEUTRON_ROLE falls straight to default open (no alias fallthrough)', () => {
      expect(resolveDeploymentMode({ NEUTRON_ROLE: 'banana' })).toBe('open')
    })
  })

  // K11b2 — the retired `NEUTRON_DEPLOYMENT_MODE` alias is now INERT: it never
  // selects a mode, and a box that sets ONLY the alias resolves to the default
  // `open` (NOT `managed`). It is loudly flagged so an untracked box can't
  // silently drop managed-only credential isolation.
  describe('K11b2 — retired NEUTRON_DEPLOYMENT_MODE alias is inert', () => {
    test('alias-only "managed" resolves to open (alias no longer selects a mode)', () => {
      expect(resolveDeploymentMode({ NEUTRON_DEPLOYMENT_MODE: 'managed' })).toBe('open')
    })

    test('alias is ignored even when NEUTRON_ROLE is unknown (no fallthrough)', () => {
      expect(
        resolveDeploymentMode({ NEUTRON_ROLE: 'banana', NEUTRON_DEPLOYMENT_MODE: 'managed' }),
      ).toBe('open')
    })

    test('a set alias is surfaced loudly (console.error) for migration', () => {
      const original = console.error
      const calls: string[] = []
      console.error = (...args: unknown[]) => {
        calls.push(args.map(String).join(' '))
      }
      try {
        expect(resolveDeploymentMode({ NEUTRON_DEPLOYMENT_MODE: 'managed' })).toBe('open')
      } finally {
        console.error = original
      }
      expect(
        calls.some(
          (l) => l.includes('NEUTRON_DEPLOYMENT_MODE') && l.includes('NEUTRON_ROLE'),
        ),
      ).toBe(true)
    })

    test('no spurious warning when the alias is absent', () => {
      const original = console.error
      let count = 0
      console.error = () => {
        count += 1
      }
      try {
        expect(resolveDeploymentMode({ NEUTRON_ROLE: 'managed' })).toBe('managed')
        expect(resolveDeploymentMode({})).toBe('open')
      } finally {
        console.error = original
      }
      expect(count).toBe(0)
    })
  })
})
