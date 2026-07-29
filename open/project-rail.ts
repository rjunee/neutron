/**
 * @neutronai/open — pure per-project RAIL derivation (M1 UX REDESIGN, PR-1).
 *
 * The redesigned project rail shows, per project, ONE derived activity state
 * (idle / working / attention) plus a one-line preview of the last message. The
 * server derives these once (in `open/composer.ts` `readProjectRows`) and ships
 * them on the `projects_changed` frame + the page bootstrap, so the client just
 * renders — no client-side run/board bookkeeping.
 *
 * This module is the PURE core of that derivation (no DB, no clock) so the
 * activity precedence + the preview truncation are unit-testable in isolation.
 */

/** The single per-project rail state. `attention` outranks `working`. */
export type ProjectActivity = 'idle' | 'working' | 'attention'

/** Who sent the previewed message, for the rail's `You: ` prefix. */
export type PreviewFrom = 'user' | 'agent' | null

/**
 * The observable signals that decide a project's activity. The composer collects
 * these from the project's Work-Board items + their bound runs + its live chat
 * turn; this function applies the precedence.
 */
export interface ProjectActivitySignals {
  /** A live chat turn is in progress for this project (composer-tracked). */
  chatTurnInProgress: boolean
  /** Count of the project's board items bound to a LIVE (non-terminal) run. */
  liveRunCount: number
  /** Any board item is `inline_active` (an inline agent action running). */
  hasInlineActive: boolean
  /** Any NOT-done board item whose bound run is `failed` (needs attention). */
  hasFailedNotDone: boolean
  /** Any live bound run has stalled past the display stall threshold. */
  hasStalledLiveRun: boolean
}

/**
 * Derive a project's rail activity from its signals. Precedence (spec):
 *   attention  — a bound run failed on a not-done item, OR a live run stalled.
 *   working    — a live chat turn, OR any live run, OR an inline-active item.
 *   idle       — none of the above.
 * `attention` deliberately WINS over `working`: a failed/stalled build is more
 * important to surface than the fact that something is also running.
 */
export function deriveProjectActivity(s: ProjectActivitySignals): ProjectActivity {
  if (s.hasFailedNotDone || s.hasStalledLiveRun) return 'attention'
  if (s.chatTurnInProgress || s.liveRunCount > 0 || s.hasInlineActive) return 'working'
  return 'idle'
}

/** Default rail-preview budget (chars) — the rail's second line is short. */
export const PREVIEW_MAX_CHARS = 90

/**
 * Strip the common inline Markdown a chat body carries so the rail preview reads
 * as plain text: fenced/inline code, emphasis, headings, blockquotes, list
 * bullets, link/image syntax (keep the visible text), and collapse all runs of
 * whitespace (including newlines) to single spaces. Deterministic + allocation-
 * light; not a full Markdown parser (the rail only needs a legible one-liner).
 */
export function stripMarkdownForPreview(raw: string): string {
  return (
    raw
      // Fenced code blocks → drop the fences, keep inner text.
      .replace(/```+/g, ' ')
      // Images ![alt](url) → alt; links [text](url) → text.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Inline code `code` → code.
      .replace(/`([^`]*)`/g, '$1')
      // Emphasis / bold markers.
      .replace(/[*_~]{1,3}/g, '')
      // Leading heading hashes, blockquote markers, and list bullets per line.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>+\s?/gm, '')
      .replace(/^\s{0,3}[-*+]\s+/gm, '')
      // Collapse all whitespace (incl. newlines) to single spaces.
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * Build the rail preview string from a raw message body: markdown-stripped and
 * truncated to `max` chars with a trailing ellipsis. Returns null for an
 * empty/whitespace body (the rail then shows no second line).
 */
export function truncatePreview(
  raw: string | null | undefined,
  max: number = PREVIEW_MAX_CHARS,
): string | null {
  if (raw === null || raw === undefined) return null
  const stripped = stripMarkdownForPreview(raw)
  if (stripped.length === 0) return null
  if (stripped.length <= max) return stripped
  // Reserve one char for the ellipsis; trim a dangling space before it.
  return stripped.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}
