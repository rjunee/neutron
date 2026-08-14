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

export type {
  ProjectActivity,
  PreviewFrom,
  ProjectActivitySignals,
  RailScanItem,
} from '@neutronai/contracts/project-rail.ts'
export {
  deriveProjectActivity,
  scanItemsForRailSignals,
} from '@neutronai/contracts/project-rail.ts'

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
