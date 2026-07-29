/**
 * @neutronai/app — comments side-pane "Line N" / "Lines N–M" label
 * unit tests (P7.3 range UI consumer).
 *
 * Convention note (matching `comments-side-pane.test.tsx`): the
 * Neutron app's bun:test suite does NOT mount React Native
 * components — `react-native` is not loaded in the test runtime and
 * `@testing-library/react-native` is not a dependency. Render-level
 * coverage is provided by the agent-browser smoke pass in the
 * integration step.
 *
 * The side-pane reads its line label from a callback the parent
 * (`app/app/projects/[id]/docs.tsx`) supplies via the
 * `format_anchor_line_label` prop. The parent's implementation
 * delegates to `computeAnchorLines(anchor, file.content)` +
 * `formatAnchorLineLabel(span)` from `app/lib/anchor-lines.ts`. This
 * file asserts the pure contract of that callback:
 *
 *   1. A single-line anchor renders as "Line N".
 *   2. A range anchor (offsets spanning multiple lines) renders as
 *      "Lines N–M" (with an en-dash, NOT a hyphen-minus).
 *   3. An incomplete anchor (null offsets) returns `null`, which the
 *      side-pane interprets as "hide the label row entirely".
 *   4. An absent file (no doc loaded) returns `null` for the same
 *      reason.
 *
 * Time-dependent test discipline (Neutron CLAUDE.md hard rule):
 *   - All fixture timestamps via `Date.now()`-relative helpers.
 *   - No hardcoded `2026-xx-xxT...` ISO strings.
 */

import { describe, expect, it } from 'bun:test';

import {
  computeAnchorLines,
  formatAnchorLineLabel,
} from '../lib/anchor-lines';
import type { ThreadSummary } from '../lib/docs-client';

/**
 * Mirror of the parent's `formatAnchorLineLabelForSidePane` closure
 * shape — pure version for testing without mounting RN. The parent
 * has `file.content` in scope; here we accept it as an arg.
 */
function makeLabelProvider(
  file_content: string | null,
): (anchor: ThreadSummary['anchor']) => string | null {
  return (anchor) => {
    if (file_content === null) return null;
    const span = computeAnchorLines(anchor, file_content);
    if (span === null) return null;
    return formatAnchorLineLabel(span);
  };
}

function makeAnchor(
  current_start: number | null,
  current_end: number | null,
  excerpt = '',
): ThreadSummary['anchor'] {
  return {
    current_start,
    current_end,
    status: 'live',
    drift_hint_start: null,
    drift_hint_end: null,
    excerpt: excerpt.length > 0 ? excerpt : null,
  };
}

describe('side-pane anchor-line label provider', () => {
  /**
   * Pre-anchor padding for 11 lines (lines 1..11) plus a 7-line
   * "ranged" block on lines 12..18. The 12-18 range corresponds to
   * `current_start = padding.length`, `current_end = padding.length +
   * ranged.length` (one-past-end of line 18).
   */
  const padding =
    Array.from({ length: 11 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const ranged = Array.from({ length: 7 }, (_, i) => `range line ${i + 12}`).join(
    '\n',
  );
  const file_content = padding + ranged + '\ntrailing line';

  it('range anchor across lines 12..18 renders "Lines 12–18" (en-dash)', () => {
    const provider = makeLabelProvider(file_content);
    const label = provider(
      makeAnchor(padding.length, padding.length + ranged.length, 'range line 12'),
    );
    expect(label).toBe('Lines 12–18');
    // Defensive: literal must be U+2013 en-dash, not U+002D hyphen.
    expect(label!.includes('–')).toBe(true);
    expect(label!.includes('-')).toBe(false);
  });

  it('single-line anchor entirely on line 12 renders "Line 12"', () => {
    const provider = makeLabelProvider(file_content);
    // Anchor a few chars inside line 12 only.
    const start = padding.length + 2;
    const end = padding.length + 6;
    expect(provider(makeAnchor(start, end))).toBe('Line 12');
  });

  it('returns null when offsets are incomplete (drift_hint-only / missing endpoints)', () => {
    const provider = makeLabelProvider(file_content);
    expect(provider(makeAnchor(null, 5))).toBeNull();
    expect(provider(makeAnchor(0, null))).toBeNull();
    expect(provider(makeAnchor(null, null))).toBeNull();
  });

  it('returns null when the parent has no file content loaded yet', () => {
    const provider = makeLabelProvider(null);
    expect(provider(makeAnchor(0, 5))).toBeNull();
  });

  it('anchor at the very top of the file renders "Line 1"', () => {
    const provider = makeLabelProvider(file_content);
    expect(provider(makeAnchor(0, 3))).toBe('Line 1');
  });

  it('range anchor at lines 2..3 renders "Lines 2–3"', () => {
    const provider = makeLabelProvider(file_content);
    // 'line 1\nline 2\nline 3\n...' — start at top of line 2, end at
    // top of line 4 (one-past end of line 3).
    const startOfLine2 = 'line 1\n'.length;
    const endOfLine3 = 'line 1\nline 2\nline 3'.length;
    expect(provider(makeAnchor(startOfLine2, endOfLine3))).toBe('Lines 2–3');
  });
});
