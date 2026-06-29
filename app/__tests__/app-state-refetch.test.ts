/**
 * The foreground-refetch predicate that fixes the stale "Not connected" status
 * after an OAuth grant (M1 E2E Round 4, bug A). Connect hands off to the system
 * browser, so the screen must refetch when the app returns to 'active'.
 */
import { describe, expect, test } from 'bun:test'

import { appStateBecameActive } from '../lib/app-state-refetch'

describe('appStateBecameActive', () => {
  test('fires when returning to the foreground from the browser (the OAuth case)', () => {
    expect(appStateBecameActive('background', 'active')).toBe(true)
    expect(appStateBecameActive('inactive', 'active')).toBe(true)
  })

  test('does not fire on a spurious active->active event (no duplicate refetch)', () => {
    expect(appStateBecameActive('active', 'active')).toBe(false)
  })

  test('does not fire when leaving the foreground', () => {
    expect(appStateBecameActive('active', 'background')).toBe(false)
    expect(appStateBecameActive('active', 'inactive')).toBe(false)
  })
})
