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
  // selects a mode. A box that sets ONLY the alias resolves to the default
  // `open` (NOT `managed`). Accepted trade-off (owner-approved): mode gates
  // managed-only credential isolation, so an alias-only box loses that isolation
  // — no such box exists in either repo (verified); migrate any stray box to
  // `NEUTRON_ROLE`. These pins lock the alias-inert contract against a regression
  // that accidentally re-honors the alias.
  describe('K11b2 — retired NEUTRON_DEPLOYMENT_MODE alias is inert', () => {
    test('alias-only "managed" resolves to open (alias no longer selects a mode)', () => {
      expect(resolveDeploymentMode({ NEUTRON_DEPLOYMENT_MODE: 'managed' })).toBe('open')
    })

    test('alias is ignored even when NEUTRON_ROLE is unknown (no fallthrough)', () => {
      expect(
        resolveDeploymentMode({ NEUTRON_ROLE: 'banana', NEUTRON_DEPLOYMENT_MODE: 'managed' }),
      ).toBe('open')
    })

    test('canonical NEUTRON_ROLE still wins over a stray alias', () => {
      expect(
        resolveDeploymentMode({ NEUTRON_ROLE: 'managed', NEUTRON_DEPLOYMENT_MODE: 'open' }),
      ).toBe('managed')
    })
  })
})
