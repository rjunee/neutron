import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DEPLOYMENT_MODE,
  DEPLOYMENT_MODE_ENV,
  DEPLOYMENT_ROLE_ENV,
  resolveDeploymentMode,
} from './deployment-mode.ts'

describe('resolveDeploymentMode', () => {
  test('defaults to open when unset', () => {
    expect(resolveDeploymentMode({})).toBe('open')
    expect(DEFAULT_DEPLOYMENT_MODE).toBe('open')
  })

  test('resolves managed (case-insensitive, trimmed)', () => {
    expect(resolveDeploymentMode({ NEUTRON_DEPLOYMENT_MODE: 'managed' })).toBe('managed')
    expect(resolveDeploymentMode({ NEUTRON_DEPLOYMENT_MODE: '  Managed ' })).toBe('managed')
  })

  test('resolves open explicitly', () => {
    expect(resolveDeploymentMode({ NEUTRON_DEPLOYMENT_MODE: 'open' })).toBe('open')
  })

  test('unknown value falls back to default open', () => {
    expect(resolveDeploymentMode({ NEUTRON_DEPLOYMENT_MODE: 'banana' })).toBe('open')
  })

  // M2.6 Ph0 — connect profile + NEUTRON_ROLE canonical/alias reconciliation
  // (brief § 2, test § 6.6).
  describe('M2.6 Ph0 — connect profile + NEUTRON_ROLE', () => {
    test('canonical key names', () => {
      expect(DEPLOYMENT_ROLE_ENV).toBe('NEUTRON_ROLE')
      expect(DEPLOYMENT_MODE_ENV).toBe('NEUTRON_DEPLOYMENT_MODE')
    })

    test('resolves connect via the canonical NEUTRON_ROLE (case-insensitive, trimmed)', () => {
      expect(resolveDeploymentMode({ NEUTRON_ROLE: 'connect' })).toBe('connect')
      expect(resolveDeploymentMode({ NEUTRON_ROLE: '  Connect ' })).toBe('connect')
    })

    test('NEUTRON_ROLE also resolves open / managed', () => {
      expect(resolveDeploymentMode({ NEUTRON_ROLE: 'open' })).toBe('open')
      expect(resolveDeploymentMode({ NEUTRON_ROLE: 'managed' })).toBe('managed')
    })

    test('back-compat alias intact: NEUTRON_DEPLOYMENT_MODE=managed still resolves', () => {
      expect(resolveDeploymentMode({ NEUTRON_DEPLOYMENT_MODE: 'managed' })).toBe('managed')
    })

    test('NEUTRON_ROLE wins when both are set (canonical > alias)', () => {
      expect(
        resolveDeploymentMode({
          NEUTRON_ROLE: 'connect',
          NEUTRON_DEPLOYMENT_MODE: 'managed',
        }),
      ).toBe('connect')
    })

    test('unset → open', () => {
      expect(resolveDeploymentMode({})).toBe('open')
    })

    test('unknown NEUTRON_ROLE falls through to the alias, then default', () => {
      expect(
        resolveDeploymentMode({
          NEUTRON_ROLE: 'banana',
          NEUTRON_DEPLOYMENT_MODE: 'managed',
        }),
      ).toBe('managed')
      expect(resolveDeploymentMode({ NEUTRON_ROLE: 'banana' })).toBe('open')
    })
  })
})
