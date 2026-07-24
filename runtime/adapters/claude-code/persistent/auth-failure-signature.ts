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
 * type, and a future release can change it — so this matches a SET of credential-
 * shaped cues (an invalid-OAuth-token line, the `Please run /login` directive, an
 * `invalid x-api-key`, or a 401/403 `API Error`) rather than overfitting the one
 * observed line. It can miss a reworded banner (→ falls back to the generic timeout,
 * i.e. no worse than before) and could in principle over-fire if the agent's own
 * reply echoed one of these strings verbatim in live chrome (mitigated by the
 * framework's doc-quote strip + bottom-N window + the specificity of the cues).
 *
 * DISTINCT from the rate-limit BANNER detector: that surfaces a transient/usage-cap
 * limit; THIS surfaces an INVALID CREDENTIAL that needs the owner to reconnect. Like
 * the banner it carries NO `keys` (there is nothing to press headlessly — the fix is
 * an out-of-band reconnect) and never auto-retries.
 */

import { stripAnsi } from './pty-text.ts'
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
  /** ALL of these cues must appear on ONE line (whitespace-insensitive, case-
   *  insensitive). Requiring the multi-cue framing for the generic ones keeps a
   *  bare "401" / "invalid" from firing on unrelated log noise. */
  readonly cues: readonly string[]
}

/**
 * The credential-shaped patterns. Any ONE firing marks the session auth-invalid.
 * Deliberately a small, robust set — the two exact CLI strings observed plus the
 * generic `API Error` + 401/403 framing and the classic `invalid x-api-key`.
 */
export const AUTH_FAILURE_PATTERNS: readonly AuthFailurePattern[] = [
  // The exact observed OAuth-token rejection (`API Error: 401 OAuth access token
  // is invalid.`). The token-invalid phrase alone is specific enough to stand.
  { id: 'oauth-token-invalid', cues: ['OAuth access token is invalid'] },
  // The CLI's headless-unrunnable directive it prints after an auth error. Only
  // appears when `claude` has hit a credential problem, so it stands alone.
  { id: 'please-run-login', cues: ['Please run /login'] },
  // Anthropic's API-key rejection shape.
  { id: 'invalid-x-api-key', cues: ['invalid x-api-key'] },
  // A 401 / 403 credential error surfaced through the CLI's `API Error:` framing.
  // Both cues required so a conversational "401" or a doc mentioning `API Error`
  // can't fire on its own.
  { id: 'api-error-401', cues: ['API Error', '401'] },
  { id: 'api-error-403', cues: ['API Error', '403'] },
]

/** Collapse a line to bare, escape-free, whitespace-free, lower-cased letters so a
 *  cue survives BOTH a normally-streamed error line AND the Ink TUI's per-word
 *  cursor positioning (the same shredding `normalizePtyText` defeats). */
function looseLine(line: string): string {
  return stripAnsi(line).toLowerCase().replace(/\s+/g, '')
}

/** True iff `line` contains every cue (whitespace/case-insensitive). */
function lineHasAllCues(line: string, cues: readonly string[]): boolean {
  const loose = looseLine(line)
  return cues.every((c) => loose.includes(looseLine(c)))
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
    if (AUTH_FAILURE_PATTERNS.some((p) => lineHasAllCues(raw, p.cues))) {
      return stripAnsi(raw).trim()
    }
  }
  return null
}

/** Boolean presence wrapper for the {@link DetectorSpec} `present` predicate. */
export function authFailurePresent(ctx: DetectorContext): boolean {
  return matchAuthFailure(ctx.lines) !== null
}

/**
 * Build the notify-only {@link DetectorSpec}. NO `keys` — the substrate records the
 * session's auth-invalid state + surfaces a notice when it fires (never a
 * keystroke). The framework's per-detector edge-latch makes it fire-once per rising
 * edge (cross-cutting invariant §1).
 */
export function createAuthFailureDetector(): DetectorSpec {
  return {
    id: AUTH_FAILURE_DETECTOR_ID,
    bottomN: AUTH_FAILURE_BOTTOM_N,
    present: authFailurePresent,
  }
}
