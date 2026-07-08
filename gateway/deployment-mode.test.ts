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
})
