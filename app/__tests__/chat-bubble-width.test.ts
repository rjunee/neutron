/**
 * @neutronai/app — the chat bubble has exactly ONE width cap (mobile defect,
 * 2026-07-29).
 *
 * Ryan on device: the bubbles are "arbitrarily narrow, should fill the screen" —
 * an assistant reply wrapped after roughly five words. Cause: TWO percentage
 * `maxWidth` declarations in one ancestor chain (`bubbleColumn` at 82% wrapping
 * `bubble` at 82%), which Yoga MULTIPLIES into an effective 67% of an already
 * rail-narrowed row.
 *
 * WHY PART OF THIS SUITE IS STRUCTURAL. The bug is not a wrong value, it is a
 * wrong SHAPE: two caps that each look correct in isolation. No value assertion
 * can catch someone adding `maxWidth: '82%'` back onto `styles.bubble` — the
 * constant would still be 90%, the arithmetic would still be right, and the app
 * would still be broken. So the regression guard reads the component's source and
 * pins the shape: one percentage cap in the file, and every bubble-bearing row
 * routed through the single node that carries it. This suite has no RN mount
 * harness (see `project-card-interactivity.test.ts`), so a source assertion is the
 * only executable form this invariant has.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BUBBLE_MAX_WIDTH,
  BUBBLE_MAX_WIDTH_PCT,
  RAIL_WIDTH_PT,
  bubbleMaxWidthPt,
  bubbleOppositeGutterPt,
  bubbleRowWidthPt,
} from '../lib/chat-bubble-metrics';
import { SPACING } from '../lib/theme';

const SURFACE_SRC = readFileSync(
  join(import.meta.dir, '..', 'components', 'ChatSyncSurface.tsx'),
  'utf8',
);
const RAIL_SRC = readFileSync(
  join(import.meta.dir, '..', 'components', 'ProjectRail.tsx'),
  'utf8',
);

/** Every percentage `maxWidth:` declaration in the chat surface, in file order. */
function percentMaxWidths(src: string): string[] {
  return [...src.matchAll(/maxWidth:\s*(?:BUBBLE_MAX_WIDTH\b|'(\d+)%')/g)].map((m) => m[0]);
}

describe('chat bubble — exactly ONE percentage width cap in the chain', () => {
  it('declares a single percentage maxWidth in the whole chat surface', () => {
    // THE regression. Two caps here multiply (0.82 x 0.82 = 67%) and the bubble
    // collapses to a few words per line.
    expect(percentMaxWidths(SURFACE_SRC)).toHaveLength(1);
  });

  it('puts that one cap on bubbleColumn, sourced from the shared constant', () => {
    expect(SURFACE_SRC).toContain('bubbleColumn: { maxWidth: BUBBLE_MAX_WIDTH }');
    // ...and NOT re-declared inline, which is how the second cap got in.
    expect(SURFACE_SRC).not.toMatch(/maxWidth:\s*'\d+%'/);
  });

  it('routes EVERY bubble row through the capped column', () => {
    // `bubbleWrap` is the flex row; `bubbleColumn` is the capped child. One of
    // each per row. The streaming bubble and the typing indicator used to skip
    // the column, so they rendered WIDER than the settled bubble they become.
    const wraps = SURFACE_SRC.match(/styles\.bubbleWrap/g) ?? [];
    const columns = SURFACE_SRC.match(/styles\.bubbleColumn/g) ?? [];
    expect(wraps.length).toBeGreaterThan(0);
    expect(columns.length).toBe(wraps.length);
  });

  it('keeps the left/right speaker asymmetry', () => {
    // A single wide cap is only safe while the two sides still align opposite.
    expect(SURFACE_SRC).toContain("userWrap: { justifyContent: 'flex-end' }");
    expect(SURFACE_SRC).toContain("agentWrap: { justifyContent: 'flex-start' }");
  });
});

describe('chat bubble — the cap is sized for a phone with a permanent rail', () => {
  const GUTTER = SPACING.md; // `listContent.paddingHorizontal`
  const row = (screen: number): number =>
    bubbleRowWidthPt({ screen_width: screen, list_gutter: GUTTER });

  it('agrees with the style value', () => {
    expect(BUBBLE_MAX_WIDTH_PCT).toBe(90);
    expect(BUBBLE_MAX_WIDTH).toBe('90%');
  });

  it('mirrors the rail width the bubble actually competes with', () => {
    // Drift guard: `RAIL_WIDTH_PT` is a copy of ProjectRail's own constant,
    // because that module pulls in react-native and this arithmetic must stay
    // dependency-free. If the rail is re-sized, this must move with it.
    expect(RAIL_SRC).toContain(`const RAIL_WIDTH = ${RAIL_WIDTH_PT};`);
    expect(SURFACE_SRC).toContain('paddingHorizontal: SPACING.md');
    expect(GUTTER).toBe(12);
  });

  it('is far wider than the doubled cap it replaces', () => {
    // iPhone 15: 393 - 72 rail - 24 gutters = 297pt row.
    expect(row(393)).toBe(297);
    const doubled = row(393) * 0.82 * 0.82; // ~200pt — the shipped bug
    expect(bubbleMaxWidthPt(row(393))).toBeGreaterThan(doubled * 1.3);
  });

  it('still leaves an unmistakable gutter on the far side', () => {
    // The gap that carries the speaker distinction. ~30pt on a 393pt phone.
    expect(bubbleOppositeGutterPt(row(393))).toBeGreaterThanOrEqual(24);
    // ...and does not become a wasteful margin on a large phone.
    expect(bubbleOppositeGutterPt(row(430))).toBeLessThanOrEqual(56);
  });

  it('keeps a visible gutter on the smallest supported phone', () => {
    // iPhone SE (320pt): 224pt row. A percentage cap must not vanish here.
    expect(row(320)).toBe(224);
    expect(bubbleOppositeGutterPt(row(320))).toBeGreaterThanOrEqual(16);
  });

  it('treats a rail-less surface (web wide layout) as full width', () => {
    expect(bubbleRowWidthPt({ screen_width: 1200, list_gutter: GUTTER, rail_width: 0 })).toBe(1176);
  });
});
