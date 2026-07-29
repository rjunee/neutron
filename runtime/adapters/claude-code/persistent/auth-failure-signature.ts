/**
 * auth-failure-signature.ts — CLI auth-failure output-scan signature (notify-only).
 *
 * § Terminal-detection port (sibling of `rate-limit-banner.ts`). Passively notices
 * the `claude` CLI's auth-failure error TEXT in the PTY ring and edge-fires a
 * NOTIFY-ONLY signal so the substrate can classify the turn's eventual failure as a
 * DISTINCT `auth_invalid` reason instead of the generic freeze-timeout.
 *
 * WHY THIS EXISTS — a real dogfood failure (2026-07-24): a chat turn's underlying
 * `claude` child hit `API Error: 401 OAuth access token is invalid` from Anthropic.
 * The CLI's response to a 401 is to print `Please run /login` and then produce ZERO
 * further PTY output (headless, so it can never actually run /login). The
 * activity-based inactivity watchdog correctly detects the resulting silence as
 * "frozen", but the frozen-turn error message string carries no auth context, so it
 * was MISCLASSIFIED as a generic timeout ("That one took too long… tap Retry") — a
 * useless prompt when the real, actionable problem is "your Claude token needs to be
 * reconnected". This detector gives the freeze path the missing visibility.
 *
 * BEST-EFFORT, HONEST LIMITATION: this is a text-scrape of a human-facing CLI error
 * banner, NOT a structured API. The CLI's exact wording varies by version and error
 * type, and a future release can change it — so this matches a SMALL set of
 * credential-shaped patterns, EACH anchored to the CLI's own `API Error:` chrome
 * (the sibling multi-cue rule in `rate-limit-banner.ts`: a bare `401` / `invalid` /
 * `/login` never fires; it must co-occur with the `API Error` framing on ONE line).
 * It can miss a reworded banner (→ falls back to the generic timeout, i.e. no worse
 * than before).
 *
 * TWO-STAGE FALSE-POSITIVE DEFENCE (Argus r1 BLOCKER — the detector must NOT abort a
 * healthy in-flight turn whose OWN reply prose happens to contain credential-shaped
 * words):
 *   1. HERE — anchoring every pattern to `API Error` chrome + boundary-matching the
 *      numeric status (`\b401\b`, not a `.includes('401')` that also hits `4015ms`)
 *      keeps benign dev-chat prose ("just reconnect if you see an invalid token")
 *      from even latching the signal.
 *   2. IN THE WATCHDOG (`pool.ts`) — the DECISIVE guard: a latched auth signal only
 *      RECLASSIFIES a turn that has ALREADY frozen (the inactivity/ceiling window
 *      elapsed with no further PTY output). The real failure shape is "banner THEN
 *      zero further output", so a healthy turn that prints one of these strings and
 *      keeps streaming never freezes → never gets the auth verdict; only a genuinely
 *      silent post-banner turn does. Mere presence NO LONGER fast-fails.
 * `403` is intentionally excluded (a 403 is a policy/authorization error — no
 * model/org access — that a token reconnect would NOT fix; Argus r1 Verdict C).
 *
 * DISTINCT from the rate-limit BANNER detector: that surfaces a transient/usage-cap
 * limit; THIS surfaces an INVALID CREDENTIAL that needs the owner to reconnect. Like
 * the banner it carries NO `keys` (there is nothing to press headlessly — the fix is
 * an out-of-band reconnect) and never auto-retries.
 */

import { stripAnsi } from './pty-text.ts'
import { buildDetectorContext } from './output-scan.ts'
import type { DetectorContext, DetectorSpec } from './output-scan.ts'

/** Stable detector id — the scanner's edge-latch keys on this and the substrate's
 *  `runOutputScan` routes a fire here to the auth-failure notice dispatch. */
export const AUTH_FAILURE_DETECTOR_ID = 'auth-failure'

/** Bottom-N window: an auth-failure line must be within the last 30 lines of the
 *  viewport to count (mirrors the rate-limit banner's window — a credential error
 *  further up the scrollback is stale ring-buffer noise from an earlier turn). */
export const AUTH_FAILURE_BOTTOM_N = 30

interface AuthFailurePattern {
  readonly id: string
  /** ALL of these lower-cased substrings must appear on ONE line (case-insensitive).
   *  Every pattern includes the `api error` anchor so a bare credential-shaped word
   *  in benign prose can't fire (the sibling multi-cue rule, `rate-limit-banner.ts`).
   *  Matched by plain lower-cased `.includes()` — the SAME normalization the sibling
   *  `API Error` banner detector uses in production (those error lines are plain PTY
   *  text, not Ink per-word-positioned widget chrome, so no whitespace-strip is
   *  needed or wanted — stripping whitespace is what let `401` match inside `4015`). */
  readonly cues?: readonly string[]
  /** A regex matched against the already-ANSI-stripped, lower-cased line. Used for
   *  the numeric status, which must appear ADJACENT to the CLI's `API Error:` chrome
   *  (the CLI prints `API Error: 401 …`) and as a WHOLE token (`\b401\b`, so `4015ms`
   *  can't match — Argus r1 Verdict B) — NOT merely somewhere on a line that also
   *  says "api error" (a chatty "…the api error was a 401…" must not fire). Used
   *  INSTEAD of `cues`. */
  readonly re?: RegExp
}

/**
 * The credential-shaped patterns. Any ONE firing marks the session auth-invalid.
 * Deliberately small + robust — every pattern anchored to the CLI's `API Error:`
 * chrome. `403` is deliberately absent (a policy/authorization 403 is NOT fixed by a
 * token reconnect — Argus r1 Verdict C).
 */
export const AUTH_FAILURE_PATTERNS: readonly AuthFailurePattern[] = [
  // The exact observed OAuth-token rejection: `API Error: 401 OAuth access token
  // is invalid.` — anchored to `api error` so the phrase alone (e.g. an agent
  // explaining the error) can't fire.
  { id: 'api-error-oauth-invalid', cues: ['api error', 'oauth access token is invalid'] },
  // Anthropic's API-key rejection shape, same anchor.
  { id: 'api-error-invalid-x-api-key', cues: ['api error', 'invalid x-api-key'] },
  // A 401 Unauthorized surfaced through the CLI's `API Error: 401 …` framing. 401 is
  // the definitive "credential rejected" status (reconnect is the right fix); the
  // status must sit ADJACENT to the `api error` chrome and be a whole token, so
  // neither `4015ms` nor a chatty "…the api error was a 401…" can fire.
  { id: 'api-error-401', re: /api error[:\s]+401\b/ },
]

/** True iff `lower` (an already-ANSI-stripped, lower-cased line) matches `pattern`:
 *  its regex tests, OR (when it carries `cues` instead) every cue substring is
 *  present. */
function lineMatchesPattern(lower: string, pattern: AuthFailurePattern): boolean {
  if (pattern.re !== undefined) return pattern.re.test(lower)
  return (pattern.cues ?? []).every((c) => lower.includes(c))
}

/**
 * Find the active auth-failure line in the detector window, or null. The framework
 * has already applied the doc-quote + bottom-N guards to `lines`; this adds the
 * per-pattern cue match, LATEST (highest-index) matching line wins. Returns the
 * verbatim trimmed line (surfaced in the notice so an operator can cross-check
 * which error fired) on a real match.
 */
export function matchAuthFailure(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i] ?? ''
    const lower = stripAnsi(raw).toLowerCase()
    if (AUTH_FAILURE_PATTERNS.some((p) => lineMatchesPattern(lower, p))) {
      return stripAnsi(raw).trim()
    }
  }
  return null
}

/** Boolean presence wrapper for the {@link DetectorSpec} `present` predicate. Matches
 *  over the WHOLE-ring bottom-N window the framework passes in. Used directly only
 *  when the detector is built with no turn-scope closure (the unit-test wiring); the
 *  production detector overrides this to scope the match to the current turn — see
 *  {@link createAuthFailureDetector}. */
export function authFailurePresent(ctx: DetectorContext): boolean {
  return matchAuthFailure(ctx.lines) !== null
}

/**
 * Build the notify-only {@link DetectorSpec}. NO `keys` — the substrate records the
 * session's auth-invalid state + surfaces a notice when it fires (never a
 * keystroke). The framework's per-detector edge-latch makes it fire-once per rising
 * edge (cross-cutting invariant §1).
 *
 * PER-TURN OUTPUT SCOPING (codex r3 CONFIRMED BLOCKER fix). When `getTurnScopedRing`
 * is supplied (the production wiring — it returns `ring.textSince(turnOutputMark)`,
 * i.e. ONLY the PTY text produced during the current turn), `present` re-derives its
 * detection window from THAT slice instead of the whole rolling ring. This is the
 * decisive guard against the stale-banner re-arm: a credential banner that printed
 * on an EARLIER turn (and completed normally without poisoning the session) can
 * still sit inside the detector's bottom-N window when the NEXT turn starts. With
 * the whole-ring window + the per-turn latch reset, that stale banner would re-fire
 * on the next turn's first scan and re-stamp `authFailureAt` — so if THAT turn then
 * froze for an unrelated reason, the watchdog would misclassify it non-retryable
 * `auth_invalid`. Scoping to the current turn's own output means only a banner
 * ACTUALLY printed this turn can arm the signal; a stale one is invisible to
 * `present`, so it falls off (falling edge) and never re-stamps. A genuine NEW 401
 * on a warm second turn IS in the current-turn slice, so it still fires + re-stamps
 * (the latch reset guarantees the rising edge) — the feature's real target is
 * preserved. When the closure is omitted (unit-test scanner wiring, which scans raw
 * panes directly) it falls back to the whole-window {@link authFailurePresent}.
 */
export function createAuthFailureDetector(getTurnScopedRing?: () => string): DetectorSpec {
  return {
    id: AUTH_FAILURE_DETECTOR_ID,
    bottomN: AUTH_FAILURE_BOTTOM_N,
    present:
      getTurnScopedRing === undefined
        ? authFailurePresent
        : (ctx) => {
            const turnRing = getTurnScopedRing()
            if (turnRing === '') return false
            // Re-window on the current-turn slice with the SAME bottom-N + doc-quote
            // guards the framework applies, so all the existing false-positive
            // defences (fenced/quoted lines, bottom-N positional guard) still hold —
            // we only ADD the "must be this turn's output" constraint.
            const turnCtx = buildDetectorContext(turnRing, AUTH_FAILURE_BOTTOM_N, ctx.now)
            return matchAuthFailure(turnCtx.lines) !== null
          },
  }
}
