/**
 * Unit tests for the host LOCAL timezone resolver — the single source the Open
 * composer threads into the morning-brief scheduler so a non-Pacific owner gets
 * the brief at their real local hour (Ryan: "Detect local computer time not
 * hardcode pt"). Pins the resolution order: `process.env.TZ` → runtime zone →
 * the defensive last-resort floor.
 */

import { describe, expect, test } from 'bun:test'

import { LAST_RESORT_TIMEZONE, resolveLocalTimezone } from '../local-timezone.ts'

describe('resolveLocalTimezone', () => {
  test('prefers an explicit process.env.TZ override (IANA zone)', () => {
    const tz = resolveLocalTimezone({
      env: { TZ: 'Asia/Tokyo' },
      // Even if the runtime resolves a different zone, the explicit override wins.
      intlTimeZone: () => 'America/Los_Angeles',
    })
    expect(tz).toBe('Asia/Tokyo')
  })

  test('trims a padded TZ override', () => {
    const tz = resolveLocalTimezone({ env: { TZ: '  Europe/Berlin  ' } })
    expect(tz).toBe('Europe/Berlin')
  })

  test('falls back to the runtime resolved zone when TZ is unset', () => {
    const tz = resolveLocalTimezone({
      env: {},
      intlTimeZone: () => 'Europe/Paris',
    })
    expect(tz).toBe('Europe/Paris')
  })

  test('treats a blank TZ as unset and uses the runtime zone', () => {
    const tz = resolveLocalTimezone({
      env: { TZ: '   ' },
      intlTimeZone: () => 'Australia/Sydney',
    })
    expect(tz).toBe('Australia/Sydney')
  })

  test('rejects an invalid TZ override (ICU-unsupported) and falls through to the runtime zone', () => {
    // A colon-prefixed / typo'd TZ would throw RangeError downstream in
    // resolveOwnerDay's Intl.DateTimeFormat — skip it instead of wedging.
    // (Legacy POSIX aliases like `PST8PDT`/`EST5EDT` ARE ICU-valid and are
    // intentionally NOT rejected — they never throw.)
    for (const bad of [':America/New_York', 'Not/AZone', 'America/Nowhere', 'totally-bogus']) {
      const tz = resolveLocalTimezone({
        env: { TZ: bad },
        intlTimeZone: () => 'Europe/Madrid',
      })
      expect(tz).toBe('Europe/Madrid')
    }
  })

  test('an invalid TZ with no usable runtime zone lands on the defensive floor (never an invalid zone)', () => {
    const tz = resolveLocalTimezone({
      env: { TZ: 'Not/AZone' },
      intlTimeZone: () => undefined,
    })
    expect(tz).toBe(LAST_RESORT_TIMEZONE)
  })

  test('the returned zone is always accepted by Intl.DateTimeFormat (no downstream RangeError)', () => {
    const tz = resolveLocalTimezone({ env: { TZ: 'totally-bogus' } })
    // Must not throw — this is exactly what the brief scheduler does.
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow()
  })

  test('uses the defensive last-resort floor only when both sources are unavailable', () => {
    const tz = resolveLocalTimezone({
      env: {},
      intlTimeZone: () => undefined,
    })
    expect(tz).toBe(LAST_RESORT_TIMEZONE)
  })

  test('a real host (no injection) resolves a non-empty IANA-looking zone', () => {
    // Smoke: the default path reads the actual runtime zone and never throws.
    const tz = resolveLocalTimezone()
    expect(typeof tz).toBe('string')
    expect(tz.length).toBeGreaterThan(0)
  })
})
