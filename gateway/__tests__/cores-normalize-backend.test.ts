/**
 * X2 — `normalizeBackend` maps a Core backend factory's return onto the Core's
 * declared `defineCore().backendKey`. Boundary coverage for the generalized
 * contract that replaced the old hardcoded five-key allow-list: the
 * already-shaped detection is now keyed on the Core's OWN `backendKey`, so a
 * Core with a novel key (e.g. `transport`) is passed through verbatim instead
 * of being double-wrapped.
 */

import { describe, expect, test } from 'bun:test'

import { normalizeBackend } from '../cores/install-bundled.ts'

describe('normalizeBackend', () => {
  test('null/undefined factory result → empty bundle', () => {
    expect(normalizeBackend('backend', null)).toEqual({})
    expect(normalizeBackend('backend', undefined)).toEqual({})
  })

  test('bare primitive maps onto the declared backendKey', () => {
    const client = { call: () => 'ok' }
    expect(normalizeBackend('transport', client)).toEqual({ transport: client })
  })

  test('object already keyed by backendKey passes through verbatim (novel key)', () => {
    const shaped = { transport: { call: () => 'ok' }, helper: { h: 1 } }
    // Same reference — NOT re-wrapped into { transport: { transport, helper } }.
    expect(normalizeBackend('transport', shaped)).toBe(shaped)
  })

  test('legacy multi-key shapes still pass through verbatim', () => {
    const tasks = { store: { s: 1 }, pickNext: { p: 1 } }
    expect(normalizeBackend('store', tasks)).toBe(tasks)
    const email = { client: { c: 1 }, summarizer: { sm: 1 } }
    expect(normalizeBackend('client', email)).toBe(email)
    const reminders = { backend: { b: 1 }, smartWrap: { w: 1 } }
    expect(normalizeBackend('backend', reminders)).toBe(reminders)
  })

  test('a raw backend object NOT keyed by backendKey is wrapped under it', () => {
    const rawClient = { list: () => [], create: () => ({}) }
    expect(normalizeBackend('client', rawClient)).toEqual({ client: rawClient })
  })
})
