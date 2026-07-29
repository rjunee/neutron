/**
 * @neutronai/app — anchor → line helpers (P7.3 range UI consumer).
 *
 * Pure helpers shared by the doc viewer (`app/app/projects/[id]/docs.tsx`)
 * and the comments side-pane (`app/components/CommentsSidePane.tsx`).
 * Both surfaces need to:
 *
 *   1. Convert a comment thread's offset anchor (`current_start`,
 *      `current_end`) into 1-indexed line numbers so the side-pane can
 *      render a "Line 12" / "Lines 12–18" label and the viewer can
 *      render a single- or multi-line highlight overlay.
 *   2. Parse a deep-link `?range=N-M` query param so the docs route can
 *      route the viewer to the same line span the parser shape in
 *      `app/lib/doc-links.ts` already accepts.
 *
 * Offset convention: anchors are UTF-16 code-unit indices into the
 * file body string — the same convention the gateway-side persistence
 * uses (`gateway/comments/anchor-walker.ts:relocateAnchor` derives
 * `anchor_start`/`anchor_end` via `String.prototype.indexOf`, which
 * returns code-unit positions, not UTF-8 bytes). The historical
 * field name `byte` survives in some prose for legacy reasons; the
 * actual semantics are JS string indices. Multi-byte runes (emoji,
 * CJK, supplementary planes) count as 1 or 2 code units depending
 * on whether they live above or below the U+FFFF BMP boundary — the
 * gateway walker + this helper agree by construction.
 *
 * Convention: 1-indexed lines, inclusive endpoints. Newline count uses
 * LF (`\n`) only — markdown content is normalised by the gateway before
 * persistence; CRLF is not part of the on-disk shape.
 *
 * Pure, no React Native imports — safe to load from bun:test.
 */

/**
 * Map a code-unit offset to a 1-indexed line number by counting LF
 * characters up to (but not including) the offset. Clamps to
 * `[0, content.length]`.
 *
 * Mirrors the inline newline-count loop the docs route originally used
 * in `handleScrollToAnchor` (which only computed a single start line);
 * extracting it here so both the start and end of a range can use the
 * same convention.
 */
export function offsetToLine(content: string, offset: number): number {
  if (typeof content !== 'string' || content.length === 0) return 1;
  const clamped = Math.min(Math.max(offset, 0), content.length);
  let line = 1;
  for (let i = 0; i < clamped; i += 1) {
    if (content.charCodeAt(i) === 10 /* \n */) line += 1;
  }
  return line;
}

/**
 * Inclusive line span derived from a comment thread's anchor. Returns
 * `null` when the anchor is incomplete (both endpoints required), or
 * when the offsets cannot be resolved against the supplied content
 * (e.g. content is empty). Endpoints are clamped to `[1, ∞)` and
 * `startLine <= endLine` is enforced.
 */
export interface AnchorLineSpan {
  startLine: number;
  endLine: number;
}

export interface AnchorOffsets {
  current_start: number | null;
  current_end: number | null;
}

export function computeAnchorLines(
  anchor: AnchorOffsets,
  content: string,
): AnchorLineSpan | null {
  const start = anchor.current_start;
  const end = anchor.current_end;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < 0) return null;
  const startLine = offsetToLine(content, start);
  // `end` is a code-unit offset one-past the last selected unit,
  // matching standard half-open offset conventions. Subtract 1 so a
  // comment anchored exactly at the end of line N stays on line N
  // rather than bleeding into N+1. Clamp to startLine to keep the
  // invariant startLine <= endLine even if the anchor is degenerate.
  const endLine = Math.max(startLine, offsetToLine(content, Math.max(start, end - 1)));
  return { startLine, endLine };
}

/**
 * Format a span as a side-pane label. Single-line spans collapse to
 * "Line N"; multi-line spans render as "Lines N–M" with an en-dash
 * (U+2013) — NOT a hyphen-minus — per the sprint's design discipline.
 */
export function formatAnchorLineLabel(span: AnchorLineSpan): string {
  if (span.startLine === span.endLine) return `Line ${span.startLine}`;
  return `Lines ${span.startLine}–${span.endLine}`;
}

/**
 * Parse a `?range=N-M` query-param value. Returns `null` for anything
 * that doesn't match `<positive int>-<positive int>` with start ≤ end
 * and both bounds ≤ `0x7fffffff` (mirrors the parser bounds in
 * `app/lib/doc-links.ts:parseAnchorInt`). Tolerant of leading / trailing
 * whitespace from URL noise.
 */
export interface ParsedRangeParam {
  range_start: number;
  range_end: number;
}

/**
 * Legacy alias kept while we settle on the cleaner `offsetToLine` name.
 * Callers (and the test suite) historically referred to "byte offset"
 * because the gateway-side anchor fields carry that legacy name. The
 * implementation has always been UTF-16-code-unit-indexed — the alias
 * is a no-op pass-through that preserves the public API.
 */
export const byteOffsetToLine = offsetToLine;

export function parseRangeParam(raw: unknown): ParsedRangeParam | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const dash = trimmed.indexOf('-');
  if (dash <= 0) return null;
  const startStr = trimmed.slice(0, dash);
  const endStr = trimmed.slice(dash + 1);
  if (!/^[1-9][0-9]*$/.test(startStr)) return null;
  if (!/^[1-9][0-9]*$/.test(endStr)) return null;
  const s = Number(startStr);
  const e = Number(endStr);
  if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e)) return null;
  if (s < 1 || e < 1 || s > 0x7fffffff || e > 0x7fffffff) return null;
  if (s > e) return null;
  return { range_start: s, range_end: e };
}
