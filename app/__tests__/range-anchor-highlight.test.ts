/**
 * @neutronai/app — range-anchor highlight unit tests (P7.3 follow-up).
 *
 * Convention note (matching `comments-side-pane.test.tsx`,
 * `task-row-helpers.test.ts`, `citation-chip-row.test.ts`): the
 * Neutron app's bun:test suite does NOT mount React Native
 * components — `react-native` is not loaded in the test runtime and
 * `@testing-library/react-native` is not a dependency. Render-level
 * coverage is provided by the agent-browser smoke pass in the
 * integration step.
 *
 * What this file covers (the load-bearing PURE contracts the doc
 * viewer's highlight overlay + deep-link routing depend on):
 *
 *   1. `computeAnchorLines` — single-line and multi-line anchors map
 *      to the right `{ startLine, endLine }` span. Drives the
 *      `docs-viewer-highlight-line-<N>` vs
 *      `docs-viewer-highlight-range-<N>-<M>` testID branching in the
 *      viewer's overlay.
 *   2. `byteOffsetToLine` — 1-indexed conversion from byte offset to
 *      line number; same heuristic both the deep-link scroll and the
 *      side-pane scroll-to-anchor handler use.
 *   3. `parseRangeParam` — the `?range=N-M` query param parser the
 *      docs route uses to set the highlight span on cold deep-link.
 *      Mirrors the bounds + same-N-M-allowed rules from
 *      `app/lib/doc-links.ts:parseAnchorInt`.
 *   4. `docLinkToRouterPath` round-trip for `range` — confirms a
 *      parsed `?range=N-M` URL produces a router target the docs
 *      route will receive as `?range=N-M`.
 *
 * NOT covered here (acceptable — agent-browser smoke handles render):
 *   - Actual RN overlay rendering / `top` + `height` pixel positions
 *   - Viewer ScrollView.scrollTo invocation
 *   - Mode switching clearing the overlay
 *
 * The render layer just shells these helpers — once they hold, the
 * only thing left is the JSX wiring covered by the smoke pass.
 */

import { describe, expect, it } from 'bun:test';

// The doc-link 'web' channel base is env-configured with NO hosted
// default (`process.env.EXPO_PUBLIC_NEUTRON_WEB_APP_BASE ?? ''`). Set it
// BEFORE importing the doc-link mirror so the web-shape parse case below
// exercises the absolute-web-URL path.
const WEB_BASE = 'https://app.neutron.example';
process.env.EXPO_PUBLIC_NEUTRON_WEB_APP_BASE = WEB_BASE;

import {
  byteOffsetToLine,
  computeAnchorLines,
  formatAnchorLineLabel,
  offsetToLine,
  parseRangeParam,
} from '../lib/anchor-lines';
const { docLinkToRouterPath, parseDocLink } = await import('../lib/doc-links');

/* ─── offsetToLine (and the byteOffsetToLine back-compat alias) ─── */

describe('byteOffsetToLine + offsetToLine back-compat alias', () => {
  it('byteOffsetToLine is the same function as offsetToLine (alias parity)', () => {
    // The legacy name `byteOffsetToLine` carries the gateway-side
    // anchor-field naming forward; the implementation is the same
    // pass-through. A consumer importing either name must get the
    // same UTF-16 code-unit-indexed semantics.
    expect(byteOffsetToLine).toBe(offsetToLine);
  });

  it('counts code units consistently across BMP runes (CJK, accents)', () => {
    // CJK characters are 1 UTF-16 code unit each. A single Japanese
    // glyph followed by a newline + ASCII line should put offset 2
    // (the newline) on line 1 and offset 3 (the 'a' on line 2) on
    // line 2 — proving the helper doesn't treat code units as UTF-8
    // bytes (which would otherwise place the cursor mid-rune).
    const cjk = '日\nabc';
    // '日' is 1 code unit; '\n' at offset 1.
    expect(offsetToLine(cjk, 0)).toBe(1);
    expect(offsetToLine(cjk, 1)).toBe(1);
    expect(offsetToLine(cjk, 2)).toBe(2);
    expect(offsetToLine(cjk, 4)).toBe(2);
  });
});

describe('byteOffsetToLine', () => {
  it('returns line 1 for offset 0 in any content', () => {
    expect(byteOffsetToLine('', 0)).toBe(1);
    expect(byteOffsetToLine('hello', 0)).toBe(1);
    expect(byteOffsetToLine('line one\nline two', 0)).toBe(1);
  });

  it('returns the same line for offsets within that line', () => {
    const content = 'first\nsecond\nthird';
    // Offsets 0–4 ('first' chars) all map to line 1.
    expect(byteOffsetToLine(content, 0)).toBe(1);
    expect(byteOffsetToLine(content, 4)).toBe(1);
    // Offset 5 is the '\n' itself — counts as still on line 1 (the
    // newline character lives on line 1; line 2 starts at offset 6).
    expect(byteOffsetToLine(content, 5)).toBe(1);
    expect(byteOffsetToLine(content, 6)).toBe(2);
    expect(byteOffsetToLine(content, 11)).toBe(2);
    expect(byteOffsetToLine(content, 13)).toBe(3);
  });

  it('clamps negative offsets to line 1', () => {
    expect(byteOffsetToLine('a\nb\nc', -10)).toBe(1);
  });

  it('clamps over-large offsets to the last line', () => {
    // 'a\nb\nc' has 3 lines.
    expect(byteOffsetToLine('a\nb\nc', 9999)).toBe(3);
  });
});

/* ─── computeAnchorLines ─── */

describe('computeAnchorLines — single-line vs range', () => {
  it('returns null for incomplete anchors', () => {
    expect(computeAnchorLines({ current_start: null, current_end: 5 }, 'hi')).toBeNull();
    expect(computeAnchorLines({ current_start: 0, current_end: null }, 'hi')).toBeNull();
    expect(computeAnchorLines({ current_start: null, current_end: null }, 'hi')).toBeNull();
  });

  it('collapses an anchor inside one line to startLine === endLine (single-line case)', () => {
    // Line 1: 'first line\n' (offsets 0..10, inclusive of '\n' at 10)
    // Anchor selects "first" — both endpoints stay on line 1.
    const span = computeAnchorLines(
      { current_start: 0, current_end: 5 },
      'first line\nsecond line\nthird line',
    );
    expect(span).not.toBeNull();
    expect(span!.startLine).toBe(1);
    expect(span!.endLine).toBe(1);
  });

  it('returns a multi-line span when offsets cross newlines (range case)', () => {
    // Pre-anchor padding for 11 lines (lines 1..11) plus content that
    // starts the anchor on line 12 and ends it on line 18.
    const padding = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const ranged = Array.from({ length: 7 }, (_, i) => `range line ${i + 12}`).join('\n');
    const content = padding + ranged + '\ntrailing';
    const startOffset = padding.length; // start of line 12
    const endOffset = padding.length + ranged.length; // end of line 18 (one-past)
    const span = computeAnchorLines(
      { current_start: startOffset, current_end: endOffset },
      content,
    );
    expect(span).not.toBeNull();
    expect(span!.startLine).toBe(12);
    expect(span!.endLine).toBe(18);
  });

  it('a one-past-end-of-line anchor stays on the originating line (no bleed)', () => {
    // Anchor end exactly at the '\n' position — half-open offsets +
    // the `end - 1` floor keep the end line at the previous line.
    const content = 'first\nsecond\nthird';
    // Select all of 'first' (chars 0..5, where 5 is '\n'). The
    // anchor's `current_end` is one-past-the-last-byte = 5.
    const span = computeAnchorLines({ current_start: 0, current_end: 5 }, content);
    expect(span).not.toBeNull();
    expect(span!.startLine).toBe(1);
    expect(span!.endLine).toBe(1);
  });

  it('returns null for negative offsets', () => {
    expect(computeAnchorLines({ current_start: -1, current_end: 5 }, 'hi')).toBeNull();
    expect(computeAnchorLines({ current_start: 0, current_end: -1 }, 'hi')).toBeNull();
  });

  it('enforces startLine <= endLine even when end < start (degenerate input)', () => {
    // Should still produce a clamped single-line span rather than an
    // inverted one — the highlight overlay assumes endLine >= startLine.
    const content = 'a\nb\nc';
    const span = computeAnchorLines({ current_start: 4, current_end: 1 }, content);
    expect(span).not.toBeNull();
    expect(span!.endLine).toBeGreaterThanOrEqual(span!.startLine);
  });
});

/* ─── formatAnchorLineLabel ─── */

describe('formatAnchorLineLabel — single-line vs multi-line', () => {
  it('single-line span renders as "Line N"', () => {
    expect(formatAnchorLineLabel({ startLine: 12, endLine: 12 })).toBe('Line 12');
    expect(formatAnchorLineLabel({ startLine: 1, endLine: 1 })).toBe('Line 1');
  });

  it('multi-line span renders as "Lines N–M" with en-dash (U+2013), NOT hyphen-minus', () => {
    const label = formatAnchorLineLabel({ startLine: 12, endLine: 18 });
    expect(label).toBe('Lines 12–18');
    // Defensive: the literal character must be U+2013 (en-dash), not
    // U+002D (hyphen-minus). Catches accidental ASCII regressions.
    expect(label.includes('–')).toBe(true);
    expect(label.includes('-')).toBe(false);
  });
});

/* ─── parseRangeParam ─── */

describe('parseRangeParam — query-param parsing', () => {
  it('parses a well-formed "N-M" string into { range_start, range_end }', () => {
    expect(parseRangeParam('12-18')).toEqual({ range_start: 12, range_end: 18 });
    expect(parseRangeParam('1-1')).toEqual({ range_start: 1, range_end: 1 });
  });

  it('trims surrounding whitespace', () => {
    expect(parseRangeParam('  12-18  ')).toEqual({ range_start: 12, range_end: 18 });
  });

  it('rejects malformed input', () => {
    expect(parseRangeParam('')).toBeNull();
    expect(parseRangeParam('abc-def')).toBeNull();
    expect(parseRangeParam('12')).toBeNull();
    expect(parseRangeParam('-12')).toBeNull();
    expect(parseRangeParam('12-')).toBeNull();
    expect(parseRangeParam('0-5')).toBeNull(); // 0 not allowed (1-indexed)
    expect(parseRangeParam('20-10')).toBeNull(); // start > end
    // The helper splits at the FIRST dash, so endStr = '18-24' which
    // fails the digit-only regex on the end side → null.
    expect(parseRangeParam('12-18-24')).toBeNull();
  });

  it('rejects non-string inputs', () => {
    expect(parseRangeParam(undefined)).toBeNull();
    expect(parseRangeParam(null)).toBeNull();
    expect(parseRangeParam(12)).toBeNull();
    expect(parseRangeParam([])).toBeNull();
  });

  it('rejects bounds above 0x7fffffff', () => {
    expect(parseRangeParam(`${0x7fffffff + 1}-${0x7fffffff + 2}`)).toBeNull();
    expect(parseRangeParam(`1-${0x7fffffff + 1}`)).toBeNull();
  });
});

/* ─── docLinkToRouterPath round-trip for range ─── */

describe('docLinkToRouterPath threads range_start/range_end as ?range=N-M', () => {
  it('appends &range=N-M when the parsed link carries range_start + range_end', () => {
    const parsed = parseDocLink('neutron://docs/proj/foo.md?range=12-18');
    expect(parsed).not.toBeNull();
    expect(parsed!.range_start).toBe(12);
    expect(parsed!.range_end).toBe(18);
    const target = docLinkToRouterPath(parsed!);
    expect(target).toBe('/projects/proj/docs?path=foo.md&range=12-18');
  });

  it('the web shape ?path=...&range=N-M parses and round-trips identically', () => {
    const parsed = parseDocLink(
      `${WEB_BASE}/projects/proj/docs?path=foo.md&range=10-20`,
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.range_start).toBe(10);
    expect(parsed!.range_end).toBe(20);
    const target = docLinkToRouterPath(parsed!);
    expect(target).toBe('/projects/proj/docs?path=foo.md&range=10-20');
  });

  it('line wins over range when both are present (defensive — parser already rejects pairings)', () => {
    const target = docLinkToRouterPath({
      project_id: 'proj',
      path: 'foo.md',
      line: 5,
      range_start: 12,
      range_end: 18,
    });
    expect(target).toBe('/projects/proj/docs?path=foo.md&line=5');
  });

  it('omits the anchor query when neither line nor range is present', () => {
    const parsed = parseDocLink('neutron://docs/proj/foo.md');
    expect(parsed).not.toBeNull();
    expect(docLinkToRouterPath(parsed!)).toBe('/projects/proj/docs?path=foo.md');
  });
});
