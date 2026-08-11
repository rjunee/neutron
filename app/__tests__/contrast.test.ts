/**
 * @neutronai/app — WCAG contrast, computed, over all FOUR surfaces.
 *
 * The owner's report was about legibility: next to Telegram our text was
 * *"more difficult"* to read. Measuring it found five body-size tokens below the
 * AA floor across the two clients, and a white-on-blue bubble at 3.65 in dark and
 * 4.02 in light. This test is what stops them coming back.
 *
 * WHY IT COMPUTES RATIOS INSTEAD OF ASSERTING HEXES. A test that pins the new hex
 * strings has ZERO contrast coverage — it passes against any values at all,
 * including a straight revert to the failing ones, because a hex is only ever
 * equal to itself. So nothing here names a colour it expects. Every assertion is
 * a computed light-ratio against the grounds a token is actually drawn on,
 * which means it fails on a REGRESSION rather than on a CHANGE, and a future
 * re-tune of the palette is free as long as it stays legible.
 *
 * THE FOUR SURFACES. Mobile light + dark come from `lib/theme.ts`. Web light +
 * dark are PARSED OUT of `landing/chat-react.html`'s two `:root` blocks, so the
 * browser client cannot drift below the bar while the phone stays above it — and
 * so the failure names which client broke.
 *
 * MUTATION-TESTED (the #388 lesson — a gate that cannot fail is worse than no
 * gate). Re-run with each of these restored and the named case must go red:
 *   web light  --accent        #007aff   4.02
 *   web light  --muted         #8a8a8e   3.44
 *   web light  --faint         #aeb2ba   2.13
 *   web dark   --faint         #5f646e   3.27
 *   web both   --user-bubble   #0a84ff / #007aff   3.65 / 4.02 with white
 *   mobile dark text_muted     #7c848f   4.48 on surface, 3.91 on surface_raised
 * `contrast-gate-selfcheck.test.ts` holds those exact values and asserts the
 * ratio function still reports them as failures, so the gate proves it can fail
 * without anyone having to remember to try it by hand.
 */

import { describe, expect, it } from 'bun:test';

import { DARK_PALETTE, LIGHT_PALETTE, type NeutronPalette } from '../lib/theme';
import { contrastRatio, parseWebThemes, type ColorSurface } from './support/contrast';

/** WCAG 2.1 AA, normal-size text. */
const AA_TEXT = 4.5;
/** WCAG 2.1 AA, non-text UI components + graphical objects (1.4.11). */
const AA_NON_TEXT = 3.0;

/**
 * Tokens that are drawn as TEXT and must clear {@link AA_TEXT} on every ground
 * they can land on. `hairline` is absent because it is a 1px border, and the
 * decorative tokens are listed separately below.
 */
const MOBILE_TEXT_TOKENS = [
  'text_primary',
  'text_secondary',
  'text_muted',
  'accent',
  'danger',
  'warning',
  'link',
] as const;

/**
 * Tokens that are never text: the 1px usage-meter bar fills
 * (`components/UsageMeter.tsx` paints them as `backgroundColor` on a 1px `View`,
 * never as a `color`) and the rail/work activity dots. Held to the non-text bar.
 *
 * `attention` is DELIBERATELY EXEMPT from even that, and this is the one
 * exemption in the file. It is a 6px dot whose value the owner set himself:
 * FIX #345 rejected a darker amber here as "a muddy brown". Its light value
 * measures 2.28 on white. Re-deriving it for contrast would silently overturn a
 * decision he made on sight, so it is recorded here as a known gap for him to
 * rule on rather than quietly changed or quietly passed.
 */
const MOBILE_DECORATIVE_TOKENS = ['work', 'usage_nominal', 'usage_warning', 'usage_critical'] as const;
const DECORATIVE_EXEMPT = ['attention'] as const;

/** Every ground a mobile token can be drawn on. `surface_raised` is the agent
 *  bubble, which is the ground an eyeball check forgets and markdown lands on. */
const MOBILE_GROUNDS = ['background', 'surface', 'surface_raised'] as const;

function report(fg: string, bg: string): string {
  return `${fg} on ${bg} = ${contrastRatio(fg, bg).toFixed(2)}`;
}

describe('mobile palettes clear AA on every ground', () => {
  const palettes: Array<[string, NeutronPalette]> = [
    ['dark', DARK_PALETTE],
    ['light', LIGHT_PALETTE],
  ];

  for (const [name, palette] of palettes) {
    const c = palette.colors;
    for (const token of MOBILE_TEXT_TOKENS) {
      for (const ground of MOBILE_GROUNDS) {
        it(`${name}: ${token} on ${ground}`, () => {
          const ratio = contrastRatio(c[token], c[ground]);
          expect(
            ratio,
            `${name} ${token} ${report(c[token], c[ground])} is below AA ${AA_TEXT}`,
          ).toBeGreaterThanOrEqual(AA_TEXT);
        });
      }
    }

    for (const token of MOBILE_DECORATIVE_TOKENS) {
      it(`${name}: decorative ${token} clears the non-text bar`, () => {
        const worst = Math.min(...MOBILE_GROUNDS.map((g) => contrastRatio(c[token], c[g])));
        expect(worst, `${name} ${token} worst ratio ${worst.toFixed(2)}`).toBeGreaterThanOrEqual(
          AA_NON_TEXT,
        );
      });
    }

    it(`${name}: white ink on the OUTGOING bubble clears AA`, () => {
      // The owner's decision: white text on a blue bubble in BOTH themes. This is
      // the assertion that makes the decision survivable — it is why the bubble
      // fill is not the pale accent, which would have measured 1.80.
      const ratio = contrastRatio(c.user_ink, c.user_bubble);
      expect(ratio, `${name} ${report(c.user_ink, c.user_bubble)}`).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it(`${name}: primary text on the INCOMING bubble clears AA`, () => {
      const ratio = contrastRatio(c.text_primary, c.surface_raised);
      expect(ratio, `${name} ${report(c.text_primary, c.surface_raised)}`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    });

    it(`${name}: the outgoing bubble is VISIBLE against the page`, () => {
      // A bubble is a UI component, so 3:1 — but it does have to be findable.
      // This is the constraint that stops the blue being darkened indefinitely to
      // buy more room on the white-ink assertion above.
      const ratio = contrastRatio(c.user_bubble, c.background);
      expect(ratio, `${name} ${report(c.user_bubble, c.background)}`).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    });

    it(`${name}: ink on an accent-filled primary button clears AA`, () => {
      // `lib/button-primitives.tsx` fills with `accent` and inks with `background`.
      const ratio = contrastRatio(c.background, c.accent);
      expect(ratio, `${name} ${report(c.background, c.accent)}`).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it(`${name}: the selected rail row still carries its label`, () => {
      const ratio = contrastRatio(c.text_primary, c.rail_selected);
      expect(ratio, `${name} ${report(c.text_primary, c.rail_selected)}`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    });

    it(`${name}: every work-phase tag label clears AA on its ground`, () => {
      // The tag's fill is a low-alpha wash of its own hue over `surface`, so it
      // is the ground that matters. The dark set's pastels measure under 2:1 on
      // white, which is why there are two phase ramps at all.
      for (const [phaseName, phase] of Object.entries(palette.phase)) {
        const ratio = contrastRatio(phase.fg, c.surface);
        expect(ratio, `${name} phase ${phaseName} ${report(phase.fg, c.surface)}`).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
      }
    });
  }

  it('records the one decorative exemption, so it cannot be forgotten', () => {
    // Not an assertion about contrast — an assertion that the exemption list is
    // exactly what the docblock says it is. If someone adds a second exemption,
    // this fails and they have to say why in the same commit.
    expect(DECORATIVE_EXEMPT).toEqual(['attention']);
  });
});

describe('the web stylesheet clears AA on every ground', () => {
  const themes = parseWebThemes();

  it('parsed BOTH web themes out of the stylesheet', () => {
    // The positive control. A parser that silently matched nothing would make
    // every assertion below vacuously true — a green gate over an unread file.
    expect(Object.keys(themes).sort()).toEqual(['dark', 'light']);
    for (const name of ['dark', 'light'] as const) {
      expect(Object.keys(themes[name]).length).toBeGreaterThan(30);
      expect(themes[name]['bg']).toMatch(/^#[0-9a-f]{3,6}$/i);
    }
  });

  /** Web tokens drawn as text, and the grounds they land on. */
  const WEB_TEXT_TOKENS = [
    'fg',
    'fg-2',
    'muted',
    'faint',
    'accent',
    'danger',
    'error-fg',
    'warn-fg',
    'info-fg',
    'success-fg',
    'active-fg',
    'phase-build-fg',
    'phase-review-fg',
    'phase-fix-fg',
    'phase-merged-fg',
    'phase-failed-fg',
  ] as const;

  for (const name of ['dark', 'light'] as const) {
    const t: ColorSurface = themes[name];
    for (const token of WEB_TEXT_TOKENS) {
      for (const ground of ['bg', 'surface'] as const) {
        it(`web ${name}: --${token} on --${ground}`, () => {
          const fg = t[token];
          const bg = t[ground];
          expect(fg, `--${token} missing from the ${name} block`).toBeDefined();
          const ratio = contrastRatio(fg!, bg!);
          expect(
            ratio,
            `web ${name} --${token} ${report(fg!, bg!)} is below AA ${AA_TEXT}`,
          ).toBeGreaterThanOrEqual(AA_TEXT);
        });
      }
    }

    it(`web ${name}: ink on the OUTGOING bubble clears AA`, () => {
      const ratio = contrastRatio(t['user-fg']!, t['user-bubble']!);
      expect(ratio, `web ${name} ${report(t['user-fg']!, t['user-bubble']!)}`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    });

    it(`web ${name}: ink on the INCOMING bubble clears AA`, () => {
      const ratio = contrastRatio(t['agent-fg']!, t['agent-bubble']!);
      expect(
        ratio,
        `web ${name} ${report(t['agent-fg']!, t['agent-bubble']!)}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it(`web ${name}: ink on an accent-filled control clears AA`, () => {
      const ratio = contrastRatio(t['on-accent']!, t['accent']!);
      expect(ratio, `web ${name} ${report(t['on-accent']!, t['accent']!)}`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    });

    it(`web ${name}: each status banner's text clears AA on its own fill`, () => {
      for (const kind of ['warn', 'info', 'error'] as const) {
        const fg = t[`banner-${kind}-fg`]!;
        const bg = t[`banner-${kind}-bg`]!;
        expect(contrastRatio(fg, bg), `web ${name} banner-${kind} ${report(fg, bg)}`).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
      }
    });
  }
});

describe('the two clients agree about the outgoing bubble', () => {
  it('the phone and the browser paint the SAME Neutron blue with the SAME ink', () => {
    // The bubble is the product's most recognisable object. Two clients drifting
    // to two blues is the drift this catches — and it is a real risk, because the
    // values live in two files (a TS palette and a CSS block) that no compiler
    // relates to each other.
    const themes = parseWebThemes();
    for (const [webName, mobile] of [
      ['dark', DARK_PALETTE],
      ['light', LIGHT_PALETTE],
    ] as const) {
      expect(themes[webName]['user-bubble']!.toLowerCase()).toBe(
        mobile.colors.user_bubble.toLowerCase(),
      );
      expect(themes[webName]['user-fg']!.toLowerCase()).toBe(mobile.colors.user_ink.toLowerCase());
    }
  });
});
