/**
 * X3 — one-release path-shim regression tests.
 *
 * Guards that the deprecated `@neutronai/core-sdk` barrel + its legacy
 * `validator.ts` subpath keep resolving (their contents are now re-exported
 * from the single Zod source `@neutronai/cores-sdk`). If a future change drops
 * one of these forwarding exports, this fails instead of breaking a consumer
 * silently.
 */

import { describe, expect, test } from 'bun:test'

import * as barrel from './index.ts'
import {
  ERROR_CODES,
  KNOWN_CAPABILITIES,
  KNOWN_TIER_SUPPORTS,
  WARNING_CODES,
  isKnownCapability,
  isValidSemverRange,
  validateNeutronManifest,
} from './validator.ts'

const validManifest = {
  capabilities: ['read:gmail'],
  tier_support: ['regular'],
  tools: [],
  ui_components: [],
  billing_hooks: [],
  linked_sources: [],
  secrets: [],
  compat: { coreApi: '^1.0.0' },
  build: { neutronVersion: '0.1.0' },
}

describe('@neutronai/core-sdk barrel forwards the legacy surface', () => {
  test('index.ts re-exports the validator entrypoints + KNOWN_* sets', () => {
    expect(typeof barrel.validateNeutronManifest).toBe('function')
    expect(typeof barrel.isValidSemverRange).toBe('function')
    expect(typeof barrel.isKnownCapability).toBe('function')
    expect(barrel.ERROR_CODES.REQUIRED_MISSING).toBe('E_REQUIRED_MISSING')
    expect(barrel.KNOWN_CAPABILITIES.length).toBe(22)
    expect(barrel.KNOWN_TIER_SUPPORTS).toContain('regular')
  })
})

describe('@neutronai/core-sdk/validator.ts subpath still resolves', () => {
  test('valid manifest → { valid: true }', () => {
    expect(validateNeutronManifest(validManifest).valid).toBe(true)
  })

  test('legacy ERROR_CODES / WARNING_CODES present', () => {
    expect(ERROR_CODES.TYPE_MISMATCH).toBe('E_TYPE_MISMATCH')
    expect(WARNING_CODES.EMPTY_TARGET_KINDS).toBe('W_EMPTY_TARGET_KINDS')
    expect(KNOWN_CAPABILITIES).toContain('read:gmail')
    expect(KNOWN_TIER_SUPPORTS).toContain('both')
    expect(isValidSemverRange('^1.0.0')).toBe(true)
    expect(isKnownCapability('read:gmail')).toBe(true)
  })
})
