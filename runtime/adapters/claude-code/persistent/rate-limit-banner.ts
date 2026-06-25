/**
 * rate-limit-banner.ts — P2: RATE-LIMIT / OVERLOAD BANNER alert (notify-only).
 *
 * § Terminal-detection port, master-table row #10 (docs/research/vajra-terminal-
 * detection-keystroke-port-2026-06-25.md). Ports Vajra's
 * `pane-scan-watchdog.ts decideRateLimitAlert` + `rate-limit-patterns.ts` onto the
 * F1/F3 substrate (`pty-ring.ts` / `output-scan.ts`).
 *
 * WHAT — passively notice the temporary / usage-cap BANNER that `claude` prints in
 * the PTY ring and edge-fire a NOTIFY-ONLY alert so the user learns a transient
 * limit / usage cap is in effect. This is the PASSIVE banner, NOT an interactive
 * prompt — there is nothing to press.
 *
 * DISTINCT from the `rate-limit-options-stop` detector (master-table row #4): that
 * one PRESSES `3` on the interactive `/rate-limit-options` ORG-CAP picker; THIS one
 * never sends a keystroke and never auto-retries — it only informs. (Auto-action +
 * auto-retry are explicitly OUT OF SCOPE here; row #4 owns the keystroke.)
 *
 * THE LESSON — EDGE-TRIGGERED LATCH, never time-dedupe (cross-cutting invariant
 * §1). A pure time-based dedupe re-fired the alert HOURLY FOREVER on a stale banner
 * sitting in an idle pane. The fix is an edge-triggered latch per
 * `threadId::severity`: fire on absent→present, clear ONLY on present→absent. In
 * Neutron that latch IS the OutputScanner framework's per-detector edge-latch
 * (`output-scan.ts` §1): we register ONE detector per severity, so the latch key is
 * `(session.scanner ≡ threadId) × (detector id ≡ severity)` — exactly the Vajra
 * `${threadId}::${severity}` Set, expressed structurally.
 *
 * GUARDS on every match (cross-cutting invariants §1–§3) — exactly the three the
 * spec enumerates:
 *   • doc-quote guard — the framework's `stripDocQuotes` already removes fenced /
 *     diff / bullet / blockquote lines and blanks inline-backtick spans BEFORE this
 *     detector's `present` sees them, so a banner quoted in a doc / brief the agent
 *     printed can't fire (the Vajra PR #117 autonomous-work-brief false-positive).
 *   • bottom-30 positional guard — only the last {@link RATE_LIMIT_BANNER_BOTTOM_N}
 *     lines count; a banner further up the scrollback is stale ring-buffer noise CC
 *     has already retried past (the framework's `bottomN`).
 *   • not-at-idle-prompt — when CC is sitting at an idle input prompt the banner has
 *     by definition cleared (CC recovered / the turn ended). The idle-prompt walk
 *     SKIPS chrome — bypass-permissions banner / "new task?" hint / `ctrl+…`
 *     affordances / box-drawing borders — or a retired 429 ABOVE that chrome
 *     false-fires (book topic, 4 hourly alerts on a long-retired 429, 2026-05-15).
 *
 * NOTIFY-ONLY: the {@link DetectorSpec} carries NO `keys`. When it fires on the
 * rising edge the substrate surfaces a notice through the injected
 * `onRateLimitBanner` seam (mirrors the api5xx dead-turn notifier surface, row #11)
 * — never a keystroke, never an auto-retry.
 */

import { stripAnsi } from './pty-text.ts'
import type { DetectorContext, DetectorSpec } from './output-scan.ts'

/** Severity classes surfaced by this detector.
 *   - `temporary`: Anthropic-side 429 / 529 / overload / 502 — CC retries on its
 *     own; the alert is informational.
 *   - `usage-cap`: the user's subscription window cap — no automatic recovery; they
 *     wait for the window to reset.
 *  (Vajra's third severity, `org-monthly-cap`, is fired EXCLUSIVELY by the separate
 *  `/rate-limit-options` auto-stop handler — row #4 — so it is intentionally absent
 *  here.) */
export type RateLimitBannerSeverity = 'temporary' | 'usage-cap'

/** Severities this detector registers, one edge-latched detector each. */
export const RATE_LIMIT_BANNER_SEVERITIES: readonly RateLimitBannerSeverity[] = [
  'temporary',
  'usage-cap',
]

/** Bottom-N window: a banner must be within the last 30 lines of the viewport to
 *  count as active. Older banners are stale scrollback CC has retried past — a few
 *  screens of recent activity, long enough that a banner shown right before the
 *  user looks still counts, short enough that prior-hour scrollback doesn't keep
 *  tripping. (Vajra `RATE_LIMIT_ACTIVE_TAIL_LINES`.) */
export const RATE_LIMIT_BANNER_BOTTOM_N = 30

/** Stable per-severity detector ids — the scanner's edge-latch + the substrate's
 *  notice dispatch both key on these. ONE per severity gives the per-severity latch
 *  (the `::severity` half of Vajra's `${threadId}::${severity}` latch key). */
export const RATE_LIMIT_BANNER_TEMPORARY_ID = 'rate-limit-banner-temporary'
export const RATE_LIMIT_BANNER_USAGE_CAP_ID = 'rate-limit-banner-usage-cap'

/** Resolve a fired detector id back to its severity (the substrate's notice
 *  dispatch uses this). Returns undefined for a non-banner id. */
export function severityForBannerDetectorId(id: string): RateLimitBannerSeverity | undefined {
  if (id === RATE_LIMIT_BANNER_TEMPORARY_ID) return 'temporary'
  if (id === RATE_LIMIT_BANNER_USAGE_CAP_ID) return 'usage-cap'
  return undefined
}

/** Detector id for a severity (symmetry with {@link severityForBannerDetectorId}). */
function bannerDetectorId(severity: RateLimitBannerSeverity): string {
  return severity === 'temporary' ? RATE_LIMIT_BANNER_TEMPORARY_ID : RATE_LIMIT_BANNER_USAGE_CAP_ID
}

// ---------------------------------------------------------------------------
// Banner pattern set (brief § PATTERNS — carried verbatim)
// ---------------------------------------------------------------------------

interface BannerPattern {
  readonly id: string
  readonly severity: RateLimitBannerSeverity
  /** ALL of these substrings must appear on ONE line (case-insensitive). Requiring
   *  multiple cues per line is what keeps bare "Rate limited" / "Overloaded" log
   *  noise from firing — they only match alongside the Anthropic `API Error`
   *  framing (or the `api.anthropic.com` host cue for the 502). */
  readonly cues: readonly string[]
}

/** The canonical banner set. Temporary (transient, CC retries) + usage-cap (window
 *  cap, no auto-recovery) — exactly the patterns the spec enumerates. */
export const RATE_LIMIT_BANNER_PATTERNS: readonly BannerPattern[] = [
  // --- temporary (Anthropic-side 429 / 529 / overload / 502) ---
  // Production shape: `⎿  API Error: Server is temporarily limiting requests · …`
  {
    id: 'server-temporarily-limiting',
    severity: 'temporary',
    cues: ['Server is temporarily limiting requests', 'API Error'],
  },
  // Anthropic 529. `Overloaded` alone is too generic — require the `API Error` cue.
  { id: 'overloaded-with-api-error', severity: 'temporary', cues: ['Overloaded', 'API Error'] },
  // 502 from api.anthropic.com. Same-line host cue blocks an unrelated upstream 502.
  {
    id: 'anthropic-502-bad-gateway',
    severity: 'temporary',
    cues: ['502 Bad Gateway', 'api.anthropic.com'],
  },

  // --- usage-cap (subscription window cap — no automatic recovery) ---
  { id: 'claude-usage-limit-reached', severity: 'usage-cap', cues: ['Claude usage limit reached'] },
  { id: '5-hour-rate-limit-reached', severity: 'usage-cap', cues: ['5-hour rate limit reached'] },
  {
    id: 'usage-limit-please-try-again',
    severity: 'usage-cap',
    cues: ['usage limit. Please try again at'],
  },
]

// ---------------------------------------------------------------------------
// Idle-prompt / chrome guard (Vajra `IDLE_PROMPT_PATTERN` + `CC_STATUS_LINE_PATTERN`)
// ---------------------------------------------------------------------------

/** Idle CC input prompt at the bottom of the viewport. When the bottom-most live
 *  (non-chrome) line is one of these, CC is sitting waiting for input — any earlier
 *  banner has by definition cleared. Carried verbatim from Vajra; the leading
 *  box-border is tolerated by {@link unboxLine} first (the Ink TUI wraps the prompt
 *  in a rounded box, `│ > …` / `│ Try "…" │`, which the tmux-era pattern didn't
 *  see — ◆ ADAPTED-AT-BOUNDARY). The trailing `(?:\s|$)` (vs Vajra's bare `\s`)
 *  tolerates a bare caret whose trailing space the line-`trim()` removed — a
 *  content-less `❯`/`>` prompt is still idle. */
const IDLE_PROMPT_PATTERN = /^[>❯](?:\s|$)|^Try\s+"/

/** Status / chrome lines CC renders BELOW the idle prompt in bypass-permissions
 *  mode (most production sessions). NOT the idle marker — the walk steps past them
 *  to find the real prompt above. PR #118 didn't account for this shape; first
 *  observed false-positive 2026-05-15 in the book topic — 4 hourly alerts on a 429
 *  CC had long since retried past.
 *
 *  Components (each anchored to its own start-of-line, case-insensitive):
 *   - `^⏵⏵\s`    bypass-permissions banner ("⏵⏵ bypass permissions on …")
 *   - `^new task\?`  "new task? /clear to save N tokens" chrome
 *   - `^ctrl\+`      "ctrl+o to expand", "ctrl+t to …", etc.
 *   - `^[─-╿]+$`     a line composed ENTIRELY of box-drawing characters (the
 *                    `─────…` dividers / box borders). The `+$` end-anchor guards
 *                    against misclassifying a banner that merely contains one box
 *                    char somewhere on the line. */
export const CC_STATUS_LINE_PATTERN = /^⏵⏵\s|^new task\?|^ctrl\+|^[─-╿]+$/i

/** A line that is pure box-drawing chrome once whitespace is allowed BETWEEN the
 *  border glyphs — `╭───╮`, `│        │`, `╰───╮`, `─────`. The Ink box's vertical
 *  side-borders (`│ … │`) enclose interior spaces, so `CC_STATUS_LINE_PATTERN`'s
 *  all-glyph anchor alone wouldn't skip them; this does. */
const BOX_CHROME_LINE = /^[\s─-╿]+$/

/** Strip a single leading box-border glyph (`│`/`┃`/`|`) + its trailing spaces so a
 *  box-wrapped idle prompt (`│ > …`, `│ Try "…"`) still matches the bare
 *  {@link IDLE_PROMPT_PATTERN}. */
function unboxLine(line: string): string {
  return line.replace(/^[│┃|]\s*/, '')
}

/**
 * Walk the (already bottom-N-sliced, doc-quote-stripped) lines from the BOTTOM up,
 * skipping blank lines, CC chrome, and pure box-border lines. The first real line
 * decides:
 *   - it matches {@link IDLE_PROMPT_PATTERN} (box-border tolerant) → CC is idle →
 *     the banner has cleared → return `false` (NOT active).
 *   - anything else (including the banner itself) → `true` (still active so far as
 *     this gate is concerned).
 * Walking past ALL lines without hitting an idle prompt also returns `true` —
 * preserving Vajra's "no idle prompt → assume active" semantic.
 */
export function notAtIdlePrompt(lines: readonly string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = stripAnsi(lines[i] ?? '').trim()
    if (l === '') continue
    if (CC_STATUS_LINE_PATTERN.test(l)) continue
    if (BOX_CHROME_LINE.test(l)) continue
    if (IDLE_PROMPT_PATTERN.test(unboxLine(l))) return false
    return true
  }
  return true
}

/** True iff `line` (ANSI-stripped) contains ALL of `cues` (case-insensitive). */
function lineHasAllCues(line: string, cues: readonly string[]): boolean {
  const lower = stripAnsi(line).toLowerCase()
  return cues.every((c) => lower.includes(c.toLowerCase()))
}

/**
 * Find the active banner line for `severity` in the detector window, or null.
 *
 * The framework has already applied the doc-quote + bottom-N guards to `lines`, so
 * this only adds: (a) the per-severity cue match — the LATEST (highest-index)
 * matching line dominates, since an older match is stale by definition — and (b) the
 * not-at-idle-prompt guard. Returns the verbatim trimmed banner line (surfaced in
 * the notice so the user can cross-check) on a real, active match.
 */
export function matchRateLimitBanner(
  severity: RateLimitBannerSeverity,
  lines: readonly string[],
): string | null {
  const patterns = RATE_LIMIT_BANNER_PATTERNS.filter((p) => p.severity === severity)
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i] ?? ''
    if (patterns.some((p) => lineHasAllCues(raw, p.cues))) {
      // A banner is present in the window; gate on the pane not being idle.
      if (!notAtIdlePrompt(lines)) return null
      return stripAnsi(raw).trim()
    }
  }
  return null
}

/** Boolean presence wrapper for the {@link DetectorSpec} `present` predicate. */
export function rateLimitBannerPresent(
  severity: RateLimitBannerSeverity,
  ctx: DetectorContext,
): boolean {
  return matchRateLimitBanner(severity, ctx.lines) !== null
}

/**
 * Build the notify-only {@link DetectorSpec} for one severity. NO `keys` — the
 * substrate surfaces a notice when it fires (never a keystroke). The framework's
 * per-detector edge-latch makes the notify fire-once per rising edge and clear only
 * on the falling edge — the whole point (cross-cutting invariant §1).
 */
export function createRateLimitBannerDetector(severity: RateLimitBannerSeverity): DetectorSpec {
  return {
    id: bannerDetectorId(severity),
    bottomN: RATE_LIMIT_BANNER_BOTTOM_N,
    present: (ctx) => rateLimitBannerPresent(severity, ctx),
  }
}
