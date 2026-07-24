/**
 * auth-failure-signature.test.ts — the CLI auth-failure output-scan signature.
 *
 * Drives the REAL OutputScanner framework (so the doc-quote strip + bottom-N
 * windowing + edge-latch are exercised end-to-end, not mocked) plus the pure
 * matcher. The REAL observed dogfood line (2026-07-24) is the primary fixture:
 *   `Please run /login · API Error: 401 OAuth access token is invalid.`
 */

import { describe, expect, test } from 'bun:test'
import { OutputScanner } from '../output-scan.ts'
import {
  AUTH_FAILURE_DETECTOR_ID,
  authFailurePresent,
  createAuthFailureDetector,
  matchAuthFailure,
} from '../auth-failure-signature.ts'
import { buildDetectorContext } from '../output-scan.ts'

/** The verbatim line the real `claude` child printed before going silent. */
const REAL_401_LINE = '  ⎿  Please run /login · API Error: 401 OAuth access token is invalid.'

/** A scanner wired with the auth-failure detector exactly as the substrate does. */
function authScanner(): OutputScanner {
  const s = new OutputScanner()
  s.register(createAuthFailureDetector())
  return s
}

function firedIds(scanner: OutputScanner, ring: string, now: number): string[] {
  return scanner.scan(ring, now).map((f) => f.id)
}

/** An active pane whose last live content line is the auth error. */
function pane(line: string): string {
  return ['⏺ Calling the model…', '  ⎿  (running)', line].join('\n')
}

describe('auth-failure-signature — matcher', () => {
  test('fires on the REAL observed 401 OAuth-token line', () => {
    expect(matchAuthFailure(pane(REAL_401_LINE).split('\n'))).not.toBeNull()
  })

  test('fires on each credential-shaped variant (all anchored to `API Error`)', () => {
    const variants = [
      '  ⎿  API Error: 401 OAuth access token is invalid.',
      '  ⎿  API Error: invalid x-api-key',
      '  ⎿  API Error: 401 Unauthorized',
    ]
    for (const v of variants) {
      expect(matchAuthFailure([v])).not.toBeNull()
    }
  })

  test('does NOT fire on a bare credential string WITHOUT the `API Error` anchor', () => {
    // Argus r1 BLOCKER (Verdict B): benign dev-chat / assistant prose that merely
    // mentions a credential-shaped phrase must NOT latch the signal — every pattern
    // requires the CLI's own `API Error:` chrome on the SAME line.
    const benign = [
      '  ⎿  Please run /login', // the bare directive is no longer a standalone cue
      'if your OAuth access token is invalid, just reconnect it',
      'the fix is to run /login again',
      'we saw an invalid x-api-key last week in the logs',
      'earlier the api error was a 401, then it recovered', // `api error` + `401` but
      // not adjacent — the boundary check needs `API Error: 401`, not a chatty 401.
    ]
    for (const line of benign) {
      expect(matchAuthFailure([line])).toBeNull()
    }
  })

  test('does NOT fire on a 403 (policy/authorization — a reconnect would not fix it)', () => {
    // Argus r1 Verdict C: a 403 is an authorization/policy error (no model/org
    // access), NOT an invalid credential — excluded so it doesn't mis-surface the
    // reconnect bubble.
    expect(matchAuthFailure(['  ⎿  API Error: 403 Forbidden'])).toBeNull()
  })

  test('boundary-matches the status code — `4015ms` does NOT read as `401`', () => {
    // Argus r1 Verdict B: the numeric status is `\b401\b`, not a substring hit.
    expect(matchAuthFailure(['  ⎿  API Error: request timed out after 4015ms'])).toBeNull()
    // A genuine 401 as a whole token still fires.
    expect(matchAuthFailure(['  ⎿  API Error: 401 rejected'])).not.toBeNull()
  })

  test('does NOT fire on unrelated errors or a bare number', () => {
    expect(matchAuthFailure(['  ⎿  API Error: 500 Internal Server Error'])).toBeNull()
    expect(matchAuthFailure(['the build returned 401 files changed'])).toBeNull()
    expect(matchAuthFailure(['⏺ Working on it…'])).toBeNull()
  })
})

describe('auth-failure-signature — scanner integration', () => {
  test('rising-edge fire, then edge-latched (no re-fire while the line persists)', () => {
    const s = authScanner()
    const ring = pane(REAL_401_LINE)
    // Rising edge: fires once.
    expect(firedIds(s, ring, 1_000)).toEqual([AUTH_FAILURE_DETECTOR_ID])
    // Still present on the next tick → latched, no re-fire (the hourly-re-fire bug).
    expect(firedIds(s, ring, 2_000)).toEqual([])
    // Falls off (line scrolled away) → latch clears.
    expect(firedIds(s, '⏺ new task', 3_000)).toEqual([])
    // Re-appears → fires again (fresh rising edge).
    expect(firedIds(s, ring, 4_000)).toEqual([AUTH_FAILURE_DETECTOR_ID])
  })

  test('a doc-quoted auth line (fenced / diff-marked) does NOT fire', () => {
    const s = authScanner()
    // Inside a ``` fence — the framework's stripDocQuotes removes it.
    const fenced = ['```', REAL_401_LINE, '```'].join('\n')
    expect(firedIds(s, fenced, 1_000)).toEqual([])
    // A diff-add line the agent printed (leading `+`).
    const s2 = authScanner()
    const diff = `+${REAL_401_LINE.trim()}`
    expect(firedIds(s2, diff, 1_000)).toEqual([])
  })

  test('an auth line ABOVE the bottom-N window does NOT fire (stale scrollback)', () => {
    const s = authScanner()
    const filler = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const ring = [REAL_401_LINE, ...filler].join('\n')
    expect(firedIds(s, ring, 1_000)).toEqual([])
  })

  test('authFailurePresent + buildDetectorContext agree with matchAuthFailure', () => {
    const ctx = buildDetectorContext(pane(REAL_401_LINE), 30, 1_000)
    expect(authFailurePresent(ctx)).toBe(true)
  })
})
