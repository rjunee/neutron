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
  // The status-family inks, added with the tokens themselves. Every one replaced a
  // hardcoded pastel in an admin pane, a Cores screen or the backup diff viewer —
  // e.g. `#bbf7d0` for an added diff line, which measures 1.21 on white.
  'success',
  'info',
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

    it(`${name}: each status ink clears AA on ITS OWN WASH`, () => {
      // The wash is a GROUND, and it is the ground most easily missed because the
      // same commit introduces both — so there is no "before" in which the pair
      // was ever wrong, and nothing prompts you to measure it. A status callout is
      // exactly `<Text color=ink>` inside `<View backgroundColor=wash>`.
      //
      // This pair is what caught light `success`: the obvious value was
      // `usage_nominal`'s #1a7f37, which measures 4.19 on `surface_raised` and 4.50
      // on its own wash — i.e. it fails on a raised card and sits one hundredth
      // above the floor on the wash. It is #146c2e for that reason.
      const pairs: ReadonlyArray<readonly [keyof typeof c, keyof typeof c]> = [
        ['success', 'success_surface'],
        ['danger', 'danger_surface'],
        ['info', 'info_surface'],
        ['warning', 'warning_surface'],
      ];
      for (const [ink, wash] of pairs) {
        const ratio = contrastRatio(c[ink], c[wash]);
        expect(ratio, `${name} ${String(ink)} on ${String(wash)} ${report(c[ink], c[wash])}`).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
      }
    });

    it(`${name}: body text inside a status callout clears AA on every wash`, () => {
      // A callout is not only its heading: `text_primary`/`text_secondary` carry the
      // sentence under it, on the same wash.
      for (const wash of ['success_surface', 'danger_surface', 'info_surface', 'warning_surface'] as const) {
        for (const ink of ['text_primary', 'text_secondary'] as const) {
          const ratio = contrastRatio(c[ink], c[wash]);
          expect(ratio, `${name} ${ink} on ${wash} ${report(c[ink], c[wash])}`).toBeGreaterThanOrEqual(
            AA_TEXT,
          );
        }
      }
    });

    it(`${name}: ink on a destructive button clears AA`, () => {
      // `danger_fill` is the saturated fill a Delete button takes; `danger_ink` is
      // what is written on it. Separate tokens from `danger` (the ink used ON a
      // page) precisely because one is a fill and one is ink, and reusing `danger`
      // for both is how you end up with mid-red on mid-red.
      const ratio = contrastRatio(c.danger_ink, c.danger_fill);
      expect(ratio, `${name} ${report(c.danger_ink, c.danger_fill)}`).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it(`${name}: the SELECTED row still carries the two inks drawn on it`, () => {
      // `rail_selected` is a text-bearing fill and was previously asserted only
      // against `text_primary`. The docs tree draws its label with `text_secondary`
      // on the same fill (`features/docs/docs-ui.tsx` treeLabel over
      // treeRowSelected), so that pair is a real ground/ink pair too.
      //
      // Scoped to these TWO inks on purpose rather than added to MOBILE_GROUNDS:
      // muted, danger, warning and link are never drawn on a selected row, and
      // asserting them there would fail on pairs the product does not render —
      // a gate that fails on something that cannot happen gets weakened, not fixed.
      for (const ink of ['text_primary', 'text_secondary'] as const) {
        const ratio = contrastRatio(c[ink], c.rail_selected);
        expect(ratio, `${name} ${ink} on rail_selected ${report(c[ink], c.rail_selected)}`).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
      }
    });

    it(`${name}: ink on the media VEIL clears AA over the WORST image behind it`, () => {
      // `veil` is a dark strip over a thumbnail, and a thumbnail can be any colour —
      // so the ground is the veil COMPOSITED over the lightest possible image, which
      // is the worst case for light ink and the only honest thing to measure.
      // `rgba(0,0,0,0.7)` over white composites to #4d4d4d.
      //
      // Measuring against pure black instead would be the best case dressed up as a
      // test: it would pass for any light ink and could never fail.
      const VEIL_OVER_WHITE = '#4d4d4d';
      expect(c.veil, 'the veil must be a 0.7-alpha black for that composite to hold').toBe(
        'rgba(0,0,0,0.7)',
      );

      const ratio = contrastRatio(c.veil_ink, VEIL_OVER_WHITE);
      expect(
        ratio,
        `${name} veil ink ${report(c.veil_ink, VEIL_OVER_WHITE)}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);

      // AND the negative half, which is the whole reason the token exists: the ink
      // this REPLACED fails there. `button-primitives.tsx` inked the caption with
      // `text_primary`, which is near-black in light mode — 2.01 on that composite,
      // so the light theme would have erased a caption dark mode rendered fine.
      if (palette.scheme === 'light') {
        expect(
          contrastRatio(c.text_primary, VEIL_OVER_WHITE),
          'text_primary on a veil should FAIL — that is why veil_ink exists',
        ).toBeLessThan(AA_TEXT);
      }
    });

    it(`${name}: the two theme-INVARIANT fills really are invariant`, () => {
      // `scrim` and `veil` are the same value in both palettes on purpose, and a
      // token that is "the same by accident" is indistinguishable from one that is
      // the same by decision. This is what records the decision mechanically, so a
      // later edit to one palette only has to fail here rather than be noticed.
      expect(DARK_PALETTE.colors.scrim).toBe(LIGHT_PALETTE.colors.scrim);
      expect(DARK_PALETTE.colors.veil).toBe(LIGHT_PALETTE.colors.veil);
      expect(DARK_PALETTE.colors.veil_ink).toBe(LIGHT_PALETTE.colors.veil_ink);
      // ...and every OTHER colour token differs, so "invariant" is a short list and
      // not a creeping habit.
      const invariant = (Object.keys(DARK_PALETTE.colors) as Array<keyof typeof c>).filter(
        (k) => DARK_PALETTE.colors[k] === LIGHT_PALETTE.colors[k],
      );
      expect(invariant.sort()).toEqual([
        'danger_ink',
        'scrim',
        'shadow',
        'user_bubble',
        'user_ink',
        'veil',
        'veil_ink',
      ]);
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
    /**
     * WEB GROUNDS — three, not two.
     *
     * `--agent-bubble` was missing while the MOBILE gate had always included its
     * equivalent (`surface_raised`, with the explicit "this IS the agent bubble"
     * rationale above). That asymmetry was the gap: markdown, meta lines, status
     * text and phase tags all render INSIDE an agent bubble on the web too, so a
     * token measured only against `--bg` and `--surface` was measured on two of
     * the three grounds it lands on, and the third is the lightest one in dark
     * mode and the darkest one in light — i.e. the worst case in both themes.
     *
     * Adding it went red on SIX pairs, none of which any page-level measurement
     * could have shown: dark `--faint` 4.29 and `--danger` 4.41; light `--faint`
     * 4.31, `--danger` 4.44, `--success-fg` 4.19 and `--phase-merged-fg` 4.19.
     * All six are fixed in the stylesheet in this commit.
     */
    const WEB_GROUNDS = ['bg', 'surface', 'agent-bubble'] as const;

    for (const token of WEB_TEXT_TOKENS) {
      for (const ground of WEB_GROUNDS) {
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
