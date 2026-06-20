/**
 * Pure-function tests for `formatRelativeTime`. The DOM is not involved.
 *
 * Format contract (matches iMessage / Telegram / WhatsApp tradition):
 *   < 60s      → "now"
 *   < 60min    → `${m}m`
 *   < 24h      → `${h}h`
 *   >= 24h     → locale-formatted `HH:MM`
 */

import { describe, expect, test } from 'bun:test'
import { formatRelativeTime } from '../chat.ts'

const NOW = Date.parse('2026-05-09T12:00:00Z')

describe('formatRelativeTime', () => {
  test('< 60s renders as "now"', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('now')
    expect(formatRelativeTime(NOW, NOW - 30_000)).toBe('now')
    expect(formatRelativeTime(NOW, NOW - 59_999)).toBe('now')
  })

  test('60s..60min renders as `${m}m`', () => {
    expect(formatRelativeTime(NOW, NOW - 60_000)).toBe('1m')
    expect(formatRelativeTime(NOW, NOW - 5 * 60_000)).toBe('5m')
    expect(formatRelativeTime(NOW, NOW - 59 * 60_000)).toBe('59m')
  })

  test('60min..24h renders as `${h}h`', () => {
    expect(formatRelativeTime(NOW, NOW - 60 * 60_000)).toBe('1h')
    expect(formatRelativeTime(NOW, NOW - 5 * 60 * 60_000)).toBe('5h')
    expect(formatRelativeTime(NOW, NOW - 23 * 60 * 60_000)).toBe('23h')
  })

  test('>= 24h renders as HH:MM (locale-zero-padded)', () => {
    const out = formatRelativeTime(NOW, NOW - 25 * 60 * 60_000)
    expect(out).toMatch(/^\d{2}:\d{2}$/)
  })

  test('clock-skew (then > now) clamps to "now" rather than going negative', () => {
    expect(formatRelativeTime(NOW, NOW + 60_000)).toBe('now')
  })
})
