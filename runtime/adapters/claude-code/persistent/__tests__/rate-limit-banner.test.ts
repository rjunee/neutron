/**
 * rate-limit-banner.test.ts — master-table row #10, the edge-triggered rate-limit /
 * overload BANNER notify-only detector.
 *
 * Drives the REAL OutputScanner framework (so the doc-quote strip + bottom-N
 * windowing + edge-latch are exercised end-to-end, not mocked) plus the pure
 * matcher/guard helpers. Mirrors the brief's required test list:
 *   • each temporary + usage-cap pattern fires once on the rising edge,
 *   • a pattern inside a doc-quote → no fire,
 *   • a stale banner persisting across ticks does NOT re-fire (edge-latch); it
 *     clears on absent then can fire again,
 *   • a pattern above the bottom-30 window → no fire,
 *   • chrome lines (bypass-permissions / new task? / borders) don't trip a false
 *     alert (the not-at-idle-prompt walk skips them).
 */

import { describe, expect, test } from 'bun:test'
import { OutputScanner, buildDetectorContext } from '../output-scan.ts'
import {
  createRateLimitBannerDetector,
  matchRateLimitBanner,
  notAtIdlePrompt,
  rateLimitBannerPresent,
  RATE_LIMIT_BANNER_BOTTOM_N,
  RATE_LIMIT_BANNER_SEVERITIES,
  RATE_LIMIT_BANNER_TEMPORARY_ID,
  RATE_LIMIT_BANNER_USAGE_CAP_ID,
  severityForBannerDetectorId,
  type RateLimitBannerSeverity,
} from '../rate-limit-banner.ts'

// Verbatim production banner lines per pattern (the `⎿ ` result-line prefix is how
// CC renders a tool/turn error — survives the framework's doc-quote strip). Named
// constants so tests reference a `string` directly (no index-access undefined).
const T_SERVER = '  ⎿  API Error: Server is temporarily limiting requests · Rate limited'
const T_OVERLOADED = '  ⎿  API Error: Overloaded (overloaded_error)'
const T_502 = '  ⎿  502 Bad Gateway from api.anthropic.com'
const U_USAGE_LIMIT = '  ⎿  Claude usage limit reached. Try again later.'
const U_5_HOUR = '  ⎿  5-hour rate limit reached'
const U_TRY_AGAIN = '  ⎿  You have hit your usage limit. Please try again at 5pm.'

const TEMPORARY: ReadonlyArray<[string, string]> = [
  ['server-temporarily-limiting', T_SERVER],
  ['overloaded-with-api-error', T_OVERLOADED],
  ['anthropic-502-bad-gateway', T_502],
]
const USAGE_CAP: ReadonlyArray<[string, string]> = [
  ['claude-usage-limit-reached', U_USAGE_LIMIT],
  ['5-hour-rate-limit-reached', U_5_HOUR],
  ['usage-limit-please-try-again', U_TRY_AGAIN],
]

/** A scanner with one banner detector per severity, exactly as the substrate wires
 *  it. Returns the scanner so a test can drive `scan()` tick-by-tick. */
function bannerScanner(): OutputScanner {
  const s = new OutputScanner()
  for (const sev of RATE_LIMIT_BANNER_SEVERITIES) s.register(createRateLimitBannerDetector(sev))
  return s
}

/** Fired banner ids from one scan tick. */
function firedIds(scanner: OutputScanner, ring: string, now: number): string[] {
  return scanner.scan(ring, now).map((f) => f.id)
}

/** An "active" pane: the banner is the last live content line, the pane is NOT at
 *  an idle prompt (so the not-at-idle-prompt gate passes). A little scrollback
 *  above keeps it realistic but inside the bottom-30 window. */
function activePane(banner: string): string {
  return ['⏺ Calling the model…', '  ⎿  (running)', banner].join('\n')
}

describe('matchRateLimitBanner — each pattern matches its severity', () => {
  for (const [id, banner] of TEMPORARY) {
    test(`temporary: ${id}`, () => {
      const lines = activePane(banner).split('\n')
      expect(matchRateLimitBanner('temporary', lines)).not.toBeNull()
      // Wrong severity bucket must NOT match the temporary banner.
      expect(matchRateLimitBanner('usage-cap', lines)).toBeNull()
    })
  }
  for (const [id, banner] of USAGE_CAP) {
    test(`usage-cap: ${id}`, () => {
      const lines = activePane(banner).split('\n')
      expect(matchRateLimitBanner('usage-cap', lines)).not.toBeNull()
      expect(matchRateLimitBanner('temporary', lines)).toBeNull()
    })
  }
})

describe('cue requirements — bare tokens without framing do NOT match', () => {
  test('"Rate limited" / "Overloaded" without API Error context → no match', () => {
    const lines = activePane(
      '  ⎿  Rate limited login attempts from 1.2.3.4 (Overloaded queue)',
    ).split('\n')
    expect(matchRateLimitBanner('temporary', lines)).toBeNull()
  })
  test('502 Bad Gateway from an unrelated host → no match', () => {
    const lines = activePane('  ⎿  502 Bad Gateway from cdn.example.com').split('\n')
    expect(matchRateLimitBanner('temporary', lines)).toBeNull()
  })
})

describe('OutputScanner integration — rising edge fires once per severity', () => {
  for (const [id, banner] of [...TEMPORARY, ...USAGE_CAP]) {
    test(`fires once on rising edge: ${id}`, () => {
      const scanner = bannerScanner()
      const ring = activePane(banner)
      const expectedId = TEMPORARY.some(([tid]) => tid === id)
        ? RATE_LIMIT_BANNER_TEMPORARY_ID
        : RATE_LIMIT_BANNER_USAGE_CAP_ID
      // Rising edge → exactly one fire, on the right severity detector, NO keys.
      const fired = scanner.scan(ring, 1000)
      expect(fired.map((f) => f.id)).toEqual([expectedId])
      expect(fired[0]?.keys).toBeUndefined()
      // Still present next tick → latched → no re-fire.
      expect(firedIds(scanner, ring, 2000)).toEqual([])
    })
  }
})

describe('doc-quote guard — quoted banners never fire', () => {
  test('inline-backtick-wrapped banner → no fire', () => {
    const ring = activePane('The CLI prints `' + T_SERVER.trim() + '` when throttled.')
    expect(firedIds(bannerScanner(), ring, 1000)).toEqual([])
  })
  test('banner inside a ``` fenced block → no fire', () => {
    const ring = ['Example output:', '```', T_SERVER, '```', '❯ '].join('\n')
    expect(firedIds(bannerScanner(), ring, 1000)).toEqual([])
  })
  test('banner on a diff/blockquote line (+/-/>) → no fire', () => {
    for (const marker of ['+', '-', '>']) {
      const ring = activePane(`${marker}${T_SERVER.trim()}`)
      expect(firedIds(bannerScanner(), ring, 1000)).toEqual([])
    }
  })
})

describe('edge-latch — stale banner does NOT re-fire; clears then re-arms', () => {
  test('present→present→absent→present: fire, hold, clear, fire', () => {
    const scanner = bannerScanner()
    const withBanner = activePane(T_OVERLOADED)
    const cleared = ['⏺ Done.', '  ⎿  ok', '❯ '].join('\n') // idle prompt, no banner

    // tick1: rising edge → fire.
    expect(firedIds(scanner, withBanner, 1000)).toEqual([RATE_LIMIT_BANNER_TEMPORARY_ID])
    // tick2: still present (hours could pass) → latched → NO re-fire. This is the
    // exact bug a pure time-dedupe caused (hourly re-fire on a stale banner).
    expect(firedIds(scanner, withBanner, 1000 + 60 * 60 * 1000)).toEqual([])
    // tick3: banner gone (CC recovered, idle prompt) → falling edge clears the latch.
    expect(firedIds(scanner, cleared, 1000 + 2 * 60 * 60 * 1000)).toEqual([])
    // tick4: a NEW episode → fires again.
    expect(firedIds(scanner, withBanner, 1000 + 3 * 60 * 60 * 1000)).toEqual([
      RATE_LIMIT_BANNER_TEMPORARY_ID,
    ])
  })
})

describe('bottom-30 positional guard — banners above the window are stale', () => {
  test('banner pushed above the bottom-30 lines → no fire', () => {
    // banner, then >30 lines of fresh output below it → out of the window.
    const tail = Array.from({ length: RATE_LIMIT_BANNER_BOTTOM_N + 5 }, (_, i) => `line ${i}`)
    const ring = [T_SERVER, ...tail].join('\n')
    // Within-window sanity: the matcher on the bottom-30 slice sees no banner.
    const ctx = buildDetectorContext(ring, RATE_LIMIT_BANNER_BOTTOM_N, 1000)
    expect(matchRateLimitBanner('temporary', ctx.lines)).toBeNull()
    expect(firedIds(bannerScanner(), ring, 1000)).toEqual([])
  })
  test('banner just inside the bottom-30 window → fires', () => {
    const tail = Array.from({ length: RATE_LIMIT_BANNER_BOTTOM_N - 2 }, (_, i) => `line ${i}`)
    const ring = [T_SERVER, ...tail].join('\n')
    expect(firedIds(bannerScanner(), ring, 1000)).toEqual([RATE_LIMIT_BANNER_TEMPORARY_ID])
  })
})

describe('not-at-idle-prompt guard — chrome-skip (book topic, 2026-05-15)', () => {
  test('retired banner ABOVE an idle prompt + chrome → no fire', () => {
    // The 2026-05-15 incident shape: a long-retired banner sits in scrollback, CC
    // is idle, and bypass-permissions / new-task / box chrome renders BELOW the
    // idle prompt. The walk must skip the chrome, find the idle prompt, and bail.
    const ring = [
      U_USAGE_LIMIT,
      '⏺ Recovered, waiting for input.',
      '╭───────────────────────────────╮',
      '│ ❯ Try "edit foo.ts"           │',
      '╰───────────────────────────────╯',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
      'new task? /clear to save 12k tokens',
      'ctrl+o to expand',
      '────────────────────────────────',
    ].join('\n')
    expect(firedIds(bannerScanner(), ring, 1000)).toEqual([])
  })

  test('active banner + chrome but NO idle prompt → still fires', () => {
    // Same chrome, but the pane is mid-turn (no idle prompt) — a genuine live
    // banner. Chrome alone must NOT suppress a real active banner.
    const ring = [
      '⏺ Calling the model…',
      U_USAGE_LIMIT,
      '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
      'ctrl+o to expand',
      '────────────────────────────────',
    ].join('\n')
    expect(firedIds(bannerScanner(), ring, 1000)).toEqual([RATE_LIMIT_BANNER_USAGE_CAP_ID])
  })

  test('notAtIdlePrompt skips chrome and detects the idle prompt directly', () => {
    expect(
      notAtIdlePrompt([
        'Claude usage limit reached',
        '❯ ',
        '⏵⏵ bypass permissions on (shift+tab to cycle)',
        'new task? /clear',
        '────────────',
      ]),
    ).toBe(false)
    // No idle prompt anywhere → assume active.
    expect(notAtIdlePrompt(['Claude usage limit reached', '⏵⏵ bypass permissions on'])).toBe(true)
  })
})

describe('severity independence — temporary and usage-cap latch separately', () => {
  test('both present → both fire; each holds its own latch', () => {
    const scanner = bannerScanner()
    const ring = [T_SERVER, U_5_HOUR].join('\n')
    const fired = scanner
      .scan(ring, 1000)
      .map((f) => f.id)
      .sort()
    expect(fired).toEqual(
      [RATE_LIMIT_BANNER_TEMPORARY_ID, RATE_LIMIT_BANNER_USAGE_CAP_ID].sort(),
    )
    // Both latched on the next identical tick.
    expect(firedIds(scanner, ring, 2000)).toEqual([])
  })
})

describe('notify-only contract — detectors carry no keystrokes', () => {
  test('a fired banner detection has no `keys` (never auto-acts)', () => {
    const scanner = bannerScanner()
    const ring = activePane(T_502)
    for (const f of scanner.scan(ring, 1000)) expect(f.keys).toBeUndefined()
  })
})

describe('detector-id ⇄ severity mapping', () => {
  test('round-trips both severities; unknown id → undefined', () => {
    const pairs: [string, RateLimitBannerSeverity][] = [
      [RATE_LIMIT_BANNER_TEMPORARY_ID, 'temporary'],
      [RATE_LIMIT_BANNER_USAGE_CAP_ID, 'usage-cap'],
    ]
    for (const [id, sev] of pairs) expect(severityForBannerDetectorId(id)).toBe(sev)
    expect(severityForBannerDetectorId('wedged-interactive-prompt')).toBeUndefined()
  })
})

describe('rateLimitBannerPresent — boolean wrapper agrees with the matcher', () => {
  test('present iff matcher returns a line', () => {
    const active = buildDetectorContext(activePane(T_OVERLOADED), RATE_LIMIT_BANNER_BOTTOM_N, 0)
    expect(rateLimitBannerPresent('temporary', active)).toBe(true)
    const idle = buildDetectorContext(['⏺ done', '❯ '].join('\n'), RATE_LIMIT_BANNER_BOTTOM_N, 0)
    expect(rateLimitBannerPresent('temporary', idle)).toBe(false)
  })
})
