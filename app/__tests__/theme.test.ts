/**
 * @neutronai/app — theme constants (P5.0 palette, P5.1 extension tokens).
 *
 * Lock-test: the P5.0 brief fixed the dark palette so every component
 * reads from one source. P5.1 layers typography / spacing / motion /
 * density tokens on top — if a future sprint changes these values we
 * want a single failing test that forces a deliberate update.
 */

import { describe, expect, it } from 'bun:test';

import { DENSITY, MOTION, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

describe('THEME', () => {
  it('exports the locked P5.0 dark palette plus the P5.1 warning + link tokens', () => {
    expect(THEME).toEqual({
      background: '#0a0a0a',
      surface: '#121212',
      surface_raised: '#1a1a1a',
      text_primary: '#ffffff',
      text_secondary: '#cfcfcf',
      text_muted: '#8a8a8a',
      accent: '#e0e0e0',
      hairline: '#1f1f1f',
      danger: '#ff5c5c',
      warning: '#ffae42',
      link: '#5fb6ff',
    });
  });

  it('is frozen — no consumer can mutate the palette at runtime', () => {
    expect(Object.isFrozen(THEME)).toBe(true);
  });
});

describe('TYPOGRAPHY', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(TYPOGRAPHY)).toBe(true);
  });

  it('pins the chat-surface typography scale', () => {
    expect(TYPOGRAPHY.h1.fontSize).toBe(22);
    expect(TYPOGRAPHY.h2.fontSize).toBe(19);
    expect(TYPOGRAPHY.h3.fontSize).toBe(17);
    expect(TYPOGRAPHY.h4.fontSize).toBe(15);
    expect(TYPOGRAPHY.body.fontSize).toBe(15);
    expect(TYPOGRAPHY.body.lineHeight).toBe(22);
    expect(TYPOGRAPHY.caption.fontSize).toBe(11);
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
