/**
 * Unit tests for the pure tab-overflow fit calculation (FIX #350). No DOM — just
 * the width arithmetic that decides how many tabs render inline before the rest
 * collapse into the "⋯" menu.
 */

import { describe, expect, it } from 'bun:test'

import { computeVisibleCount } from '../tab-overflow.tsx'

describe('computeVisibleCount', () => {
  it('shows every tab when they all fit (no overflow, no reserved button)', () => {
    // 3 tabs @ 80px + 2 gaps @ 2px = 244 ≤ 300.
    expect(computeVisibleCount([80, 80, 80], 300, 46, 2)).toBe(3)
  })

  it('collapses trailing tabs when the band is too narrow, reserving room for ⋯', () => {
    // 5 tabs @ 80px overflow 300px. budget = 300 - 46 - 2 = 252.
    // fit: 80 (=80) , +82 (=162), +82 (=244), +82 (=326 > 252 stop) → 3 inline.
    expect(computeVisibleCount([80, 80, 80, 80, 80], 300, 46, 2)).toBe(3)
  })

  it('always keeps at least one tab inline even in an impossibly narrow band', () => {
    expect(computeVisibleCount([80, 80, 80], 20, 46, 2)).toBe(1)
  })

  it('treats an unmeasured band (zero width) as "show all" — gaps alone never fake overflow', () => {
    // happy-dom / pre-layout: clientWidth 0. Must NOT collapse to the ⋯ menu.
    expect(computeVisibleCount([80, 80, 80], 0, 46, 2)).toBe(3)
  })

  it('treats zero measured widths as unmeasured (show all)', () => {
    expect(computeVisibleCount([0, 0, 0, 0], 300, 46, 2)).toBe(4)
  })

  it('returns the count unchanged for 0 or 1 tabs', () => {
    expect(computeVisibleCount([], 0, 46, 2)).toBe(0)
    expect(computeVisibleCount([80], 10, 46, 2)).toBe(1)
  })

  it('reserves for ⋯ exactly at the boundary (all-but-one fits triggers overflow)', () => {
    // 4 tabs @ 100 + gaps = 100+102+102+102 = 406 > 400 → overflow.
    // budget = 400 - 40 - 2 = 358. fit: 100, 202, 304, +102=406>358 stop → 3.
    expect(computeVisibleCount([100, 100, 100, 100], 400, 40, 2)).toBe(3)
  })
})
