/**
 * @neutronai/app — theme constants (P5.0 palette, P5.1 extension tokens).
 *
 * Lock-test: the P5.0 brief fixed the dark palette so every component
 * reads from one source. P5.1 layers typography / spacing / motion /
 * density tokens on top — if a future sprint changes these values we
 * want a single failing test that forces a deliberate update.
 */

import { describe, expect, it } from 'bun:test';

import {
  DARK_THEME as THEME,
  DENSITY,
  LIGHT_THEME,
  MOTION,
  SPACING,
  TYPOGRAPHY,
} from '../lib/theme';

describe('DARK_THEME', () => {
  it('exports the locked dark palette plus the P5.1 warning + link + PR-6 rail tokens', () => {
    expect(THEME).toEqual({
      // LIFTED + BLUE-TINTED 2026-08-07 on owner feedback ("colors are too dark …
      // more variation between the chat bubbles and the background"). This lock
      // test is what forced the change to be deliberate — it did its job.
      background: '#101419',
      surface: '#171d25',
      surface_raised: '#222834',
      text_primary: '#eceff4',
      text_secondary: '#b6becb',
      text_muted: '#8f97a5',
      accent: '#e0e0e0',
      hairline: '#2b3240',
      danger: '#ff5c5c',
      warning: '#ffae42',
      link: '#5fb6ff',
      user_bubble: '#1064cc',
      user_ink: '#ffffff',
      // SELECTED RAIL ROW 2026-08-07 on owner feedback ("it's VERY hard to see what
      // project is selected"). Selection moved from elevation to HUE, so this is
      // deliberately NOT another neutral step. Pushed further up the blue, and the
      // companion border token DELETED, when he rejected the border outright — see
      // the note in theme.ts.
      rail_selected: '#1e4b87',
      // M1 UX REDESIGN PR-6 — rail work-activity dot tokens (mirror web).
      work: '#66ccff',
      attention: '#ffd27d',
      // Usage-meter bands (mirror the web `--usage-*` tokens).
      usage_nominal: '#4bbf73',
      usage_warning: '#e0a832',
      usage_critical: '#e0553f',
    });
  });

  it('is frozen — no consumer can mutate the palette at runtime', () => {
    expect(Object.isFrozen(THEME)).toBe(true);
    expect(Object.isFrozen(LIGHT_THEME)).toBe(true);
  });

  it('the two palettes have EXACTLY the same token set', () => {
    // A light palette missing a token would resolve to `undefined` at paint time,
    // which React Native renders as "no colour" rather than as an error — an
    // invisible label instead of a failing test. Shape equality is what stops it.
    expect(Object.keys(LIGHT_THEME).sort()).toEqual(Object.keys(THEME).sort());
  });

  it('the two palettes are actually DIFFERENT, and inverted', () => {
    // Guards the copy-paste failure: a light palette that is a duplicate of dark
    // would satisfy every shape assertion above and ship a dark "light mode".
    expect(LIGHT_THEME).not.toEqual(THEME);
    const luma = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16);
      return 0.2126 * ((n >> 16) & 0xff) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff);
    };
    // The grounds invert: light's page is brighter than its cards' text, dark's
    // is darker. Asserted as a RELATION so it survives any future re-tuning.
    expect(luma(LIGHT_THEME.background)).toBeGreaterThan(luma(LIGHT_THEME.text_primary));
    expect(luma(THEME.background)).toBeLessThan(luma(THEME.text_primary));
  });

  it('the owner\'s bubble is the SAME blue in both palettes, with white ink', () => {
    // Owner decision 2026-08-10: white text on blue in both themes. One hex, so
    // the most recognisable object in the product does not change hue with theme.
    expect(LIGHT_THEME.user_bubble).toBe(THEME.user_bubble);
    expect(LIGHT_THEME.user_ink).toBe('#ffffff');
    expect(THEME.user_ink).toBe('#ffffff');
  });
});

describe('TYPOGRAPHY', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(TYPOGRAPHY)).toBe(true);
  });

  it('pins the chat-surface typography scale', () => {
    expect(TYPOGRAPHY.h1.fontSize).toBe(24);
    expect(TYPOGRAPHY.h2.fontSize).toBe(21);
    expect(TYPOGRAPHY.h3.fontSize).toBe(19);
    expect(TYPOGRAPHY.h4.fontSize).toBe(17);
    expect(TYPOGRAPHY.body.fontSize).toBe(17);
    expect(TYPOGRAPHY.body.lineHeight).toBe(25);
    expect(TYPOGRAPHY.caption.fontSize).toBe(13);
  });

  it('uses platform-specific monospace stack', () => {
    expect(typeof TYPOGRAPHY.mono.fontFamily).toBe('string');
    expect(TYPOGRAPHY.mono.fontFamily!.length).toBeGreaterThan(0);
  });
});

describe('SPACING', () => {
  it('is frozen and exposes the locked 8-pt rhythm', () => {
    expect(Object.isFrozen(SPACING)).toBe(true);
    expect(SPACING).toEqual({ xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 });
  });
});

describe('MOTION', () => {
  it('pins the chat-surface motion grammar', () => {
    expect(Object.isFrozen(MOTION)).toBe(true);
    expect(MOTION.fast).toBe(150);
    expect(MOTION.base).toBe(250);
    expect(MOTION.slow).toBe(400);
    expect(MOTION.pulse).toBe(600);
    expect(MOTION.ease).toBe('ease-in-out');
  });
});

describe('DENSITY', () => {
  it('pins the bubble / composer / chip radii', () => {
    expect(Object.isFrozen(DENSITY)).toBe(true);
    expect(DENSITY.bubble_radius).toBe(14);
    expect(DENSITY.bubble_max_width).toBe('85%');
    expect(DENSITY.composer_radius).toBe(12);
    expect(DENSITY.chip_radius).toBe(999);
  });
});

/**
 * The palette's INTENT, not just its literals.
 *
 * The lock test above pins exact hex values, which is right — it forces any change
 * to be deliberate. But it would pass just as happily on a palette that had drifted
 * back to flat near-black greys with the same shape. These encode the two things the
 * owner actually asked for, so a future edit that satisfies the letter and loses the
 * point fails here instead.
 */
describe('DARK_THEME — the properties the owner asked for', () => {
  /** Perceived lightness, 0–255, weighted for how the eye reads each channel. */
  function luma(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  /** How far a colour is from being a pure grey — its blue-vs-red spread. */
  function tint(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    return (n & 0xff) - ((n >> 16) & 0xff);
  }

  it('an agent bubble is CLEARLY lighter than the ground it sits on', () => {
    // "some more variation between the chat bubbles and the background". The old
    // palette had a step of ~16/255 and read as one flat sheet.
    const step = luma(THEME.surface_raised) - luma(THEME.background);
    expect(step).toBeGreaterThan(14);
  });

  it('the ramp lifts EVENLY — raised reads as raised at every level', () => {
    const a = luma(THEME.surface) - luma(THEME.background);
    const b = luma(THEME.surface_raised) - luma(THEME.surface);
    expect(a).toBeGreaterThan(4);
    expect(b).toBeGreaterThan(4);
  });

  it('nothing is near-black any more', () => {
    // "our colors are too dark, can you make it a little bit lighter".
    expect(luma(THEME.background)).toBeGreaterThan(14);
  });

  it('the neutrals are TINTED toward the product blue, not pure grey', () => {
    // A pure grey has tint 0. A dark UI built from pure greys looks switched-off
    // rather than composed, which is the difference he was seeing against Telegram.
    expect(tint(THEME.background)).toBeGreaterThan(4);
    expect(tint(THEME.surface_raised)).toBeGreaterThan(4);
  });

  it('the owner\'s bubble is BLUE and distinct from accent', () => {
    // It used to BE `accent` — a near-white capsule. Reusing accent again would
    // silently undo the fix while every hex assertion above still passed.
    expect(THEME.user_bubble).not.toBe(THEME.accent);
    expect(tint(THEME.user_bubble)).toBeGreaterThan(60);
    expect(luma(THEME.user_bubble)).toBeLessThan(luma(THEME.user_ink));
  });
});
