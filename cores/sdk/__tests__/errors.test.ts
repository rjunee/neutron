/**
 * Refactor X4 (item 4) — the unified `CapabilityDeniedError`. SDK-CONTRACT.md
 * LOCKS the historical secret-access constructor `(message, code =
 * 'capability_denied')` + `code` shape, so these tests pin BOTH the locked
 * positional form (third-party Cores) AND the richer options-object form
 * (the tool-dispatch surface) against one class + one `instanceof` identity.
 */

import { describe, expect, test } from 'bun:test'

import { CapabilityDeniedError } from '../index.ts'

describe('CapabilityDeniedError — locked positional constructor (SDK contract)', () => {
  test('new CapabilityDeniedError(message) defaults code to capability_denied', () => {
    const err = new CapabilityDeniedError('denied')
    expect(err).toBeInstanceOf(CapabilityDeniedError)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('denied')
    expect(err.code).toBe('capability_denied')
    expect(err.name).toBe('CapabilityDeniedError')
  })

  test('new CapabilityDeniedError(message, code) honours the explicit code', () => {
    const err = new CapabilityDeniedError('bad store', 'misconfigured')
    expect(err.message).toBe('bad store')
    expect(err.code).toBe('misconfigured')
  })
})

describe('CapabilityDeniedError — options-object constructor (tool-dispatch surface)', () => {
  test('carries code + context fields', () => {
    const err = new CapabilityDeniedError({
      code: 'tool_not_declared',
      message: 'no such tool',
      core_id: 'research_core',
      tool_name: 'research_start',
      capability: 'read:research_core.db',
    })
    expect(err).toBeInstanceOf(CapabilityDeniedError)
    expect(err.code).toBe('tool_not_declared')
    expect(err.message).toBe('no such tool')
    expect(err.core_id).toBe('research_core')
    expect(err.tool_name).toBe('research_start')
    expect(err.capability).toBe('read:research_core.db')
  })

  test('omits absent context fields (does not stamp undefined)', () => {
    const err = new CapabilityDeniedError({
      code: 'manifest_missing',
      message: 'no manifest',
    })
    expect(err.core_id).toBeUndefined()
    expect(err.tool_name).toBeUndefined()
    expect(err.capability).toBeUndefined()
  })
})
