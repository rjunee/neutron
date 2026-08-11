/**
 * @neutronai/app — proof that the contrast gate can FAIL.
 *
 * `contrast.test.ts` is green. That is only worth something if it would have been
 * red before the palette was fixed, and the repo has already been bitten by the
 * opposite: the roadmap-drift guard (ISSUES #388) passed on its own documentation
 * for days because nobody checked it could still reject a real violation. A gate
 * that cannot fail is worse than no gate — it trains you to trust it.
 *
 * So this file holds the EXACT values that were live before 2026-08-10 and asserts
 * the measurement still calls them failures. It needs no fixtures and no mutation
 * of the real palette: the ratio function is pure, so feeding it the old colours is
 * a complete test of whether the gate's arithmetic still bites.
 *
 * If someone reverts a token, `contrast.test.ts` goes red. If someone breaks the
 * ratio function so that nothing can go red, THIS goes red instead.
 */

import { describe, expect, it } from 'bun:test';

import { contrastRatio, parseWebThemes, wcagLuma } from './support/contrast';

const AA_TEXT = 4.5;

/** The measured failures this work fixed, as (label, fg, bg, ratio-then). */
const REGRESSIONS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['web light --accent (also the link colour)', '#007aff', '#ffffff', 4.02],
  ['web light --muted', '#8a8a8e', '#ffffff', 3.44],
  ['web light --faint', '#aeb2ba', '#ffffff', 2.13],
  ['web dark --faint', '#5f646e', '#0b0d10', 3.27],
  ['white ink on the old dark bubble #0a84ff', '#ffffff', '#0a84ff', 3.65],
  ['white ink on the old light bubble #007aff', '#ffffff', '#007aff', 4.02],
  ['mobile dark text_muted on surface', '#7c848f', '#171d25', 4.48],
  ['mobile dark text_muted on surface_raised', '#7c848f', '#222834', 3.91],
  // The one the brief did not have and the measurement did: white on the pale
  // dark accent, which is what "keep white text on the blue bubble" would have
  // meant if `#6cf` had been used as the fill.
  ['white ink on the pale dark accent #6cf', '#ffffff', '#66ccff', 1.8],
];

describe('the contrast gate still rejects the values it was built to reject', () => {
  for (const [label, fg, bg, expected] of REGRESSIONS) {
    it(`${label} measures ${expected} — below AA`, () => {
      const ratio = contrastRatio(fg, bg);
      // Both halves matter. The first proves the arithmetic has not drifted (a
      // function that returned 21 for everything would satisfy "below AA" for
      // nothing); the second proves the threshold still classifies it as a fail.
      expect(ratio).toBeCloseTo(expected, 1);
      expect(ratio).toBeLessThan(AA_TEXT);
    });
  }

  it('and still ACCEPTS the values that replaced them', () => {
    // The other direction: a threshold moved to 0 would pass everything above,
    // and a ratio function returning 1 for everything would fail everything here.
    expect(contrastRatio('#ffffff', '#1064cc')).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio('#8f97a5', '#222834')).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio('#7d838f', '#16181d')).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio('#57575b', '#f5f5f7')).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio('#6c6c70', '#f5f5f7')).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('anchors the arithmetic on the two ratios that cannot be wrong', () => {
    // Black on white is exactly 21:1 and any colour on itself is exactly 1:1.
    // If either of these drifts, every number in the suite is meaningless.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#1064cc', '#1064cc')).toBeCloseTo(1, 5);
    expect(wcagLuma('#ffffff')).toBeCloseTo(1, 5);
    expect(wcagLuma('#000000')).toBeCloseTo(0, 5);
  });

  it('refuses input it cannot parse instead of scoring it', () => {
    // A parser that returned 0 for `var(--accent)` would report a huge
    // ratio against black and pass. This is the "make the tool prove it can
    // return a positive" habit, applied to the tool itself.
    expect(() => wcagLuma('var(--accent)')).toThrow();
    expect(() => wcagLuma('rgba(0,0,0,.5)')).toThrow();
    expect(() => wcagLuma('')).toThrow();
    // ...but it does understand the short form, which the stylesheet uses (`#6cf`).
    expect(wcagLuma('#6cf')).toBeCloseTo(wcagLuma('#66ccff'), 10);
  });

  it('reads the REAL stylesheet, not an empty string', () => {
    // The positive control for the file read. An unreadable path or a changed
    // selector would yield empty maps, and every web assertion in the gate would
    // pass over nothing at all.
    const themes = parseWebThemes();
    expect(themes.dark['bg']).toBe('#0b0d10');
    expect(themes.light['bg']).toBe('#ffffff');
    // And light must INHERIT the dark block's value for a token it does not
    // override — proving the cascade is modelled, not just the two blocks read.
    expect(themes.light['attention']).toBeDefined();
    expect(themes.dark['scrim']).toBeUndefined(); // rgba() is deliberately dropped
  });
});
