/**
 * @neutronai/app — launcher-grid layout math unit tests (P5.3).
 *
 * Pure-function coverage of the iPhone-style adaptive grid math.
 * Asserts the four web bands (4 / 5 / 6 / 7 columns) + the native
 * 4-column lock + the [TILE_MIN, TILE_MAX] clamp.
 */

import { describe, expect, it } from 'bun:test';

import {
  PHONE_BAND_MAX,
  TABLET_PORTRAIT_BAND_MAX,
  TILE_MAX,
  TILE_MIN,
  WIDE_WEB_BAND_MAX,
  columnsForWidth,
  tileSizeFor,
} from '../lib/launcher-grid-layout';

describe('columnsForWidth (web)', () => {
  it('returns 4 columns at the phone band (≤ 480)', () => {
    expect(columnsForWidth(320, true)).toBe(4);
    expect(columnsForWidth(414, true)).toBe(4);
    expect(columnsForWidth(PHONE_BAND_MAX, true)).toBe(4);
  });

  it('returns 5 columns at the tablet-portrait band (481–799)', () => {
    expect(columnsForWidth(PHONE_BAND_MAX + 1, true)).toBe(5);
    expect(columnsForWidth(600, true)).toBe(5);
    expect(columnsForWidth(TABLET_PORTRAIT_BAND_MAX, true)).toBe(5);
  });

  it('returns 6 columns at the wide-web band (800–1280)', () => {
    expect(columnsForWidth(TABLET_PORTRAIT_BAND_MAX + 1, true)).toBe(6);
    expect(columnsForWidth(1024, true)).toBe(6);
    expect(columnsForWidth(WIDE_WEB_BAND_MAX, true)).toBe(6);
  });

  it('returns 7 columns at the very-wide band (≥ 1281)', () => {
    expect(columnsForWidth(WIDE_WEB_BAND_MAX + 1, true)).toBe(7);
    expect(columnsForWidth(1440, true)).toBe(7);
    expect(columnsForWidth(1920, true)).toBe(7);
  });

  it('falls back to 4 columns on zero / NaN / negative width', () => {
    expect(columnsForWidth(0, true)).toBe(4);
    expect(columnsForWidth(Number.NaN, true)).toBe(4);
    expect(columnsForWidth(-10, true)).toBe(4);
  });
});

describe('columnsForWidth (native)', () => {
  it('locks to 4 columns regardless of width — iPhone paradigm', () => {
    expect(columnsForWidth(320, false)).toBe(4);
    expect(columnsForWidth(414, false)).toBe(4);
    expect(columnsForWidth(800, false)).toBe(4);
    expect(columnsForWidth(1024, false)).toBe(4);
    expect(columnsForWidth(2000, false)).toBe(4);
  });
});

describe('tileSizeFor', () => {
  it('produces a sensible iPhone-band size (4 cols × 414px)', () => {
    const size = tileSizeFor(4, 414);
    expect(size).toBeGreaterThanOrEqual(TILE_MIN);
    expect(size).toBeLessThanOrEqual(TILE_MAX);
    // 4 tiles + 3 gutters + 2 paddings should land roughly mid-range
    // for a typical phone width.
    expect(size).toBeGreaterThan(80);
    expect(size).toBeLessThan(110);
  });

  it('clamps to TILE_MIN at extreme narrow widths', () => {
    expect(tileSizeFor(4, 100)).toBe(TILE_MIN);
  });

  it('clamps to TILE_MAX at extreme wide widths with few columns', () => {
    expect(tileSizeFor(2, 2000)).toBe(TILE_MAX);
  });

  it('falls back to TILE_MIN on zero / NaN inputs', () => {
    expect(tileSizeFor(0, 414)).toBe(TILE_MIN);
    expect(tileSizeFor(Number.NaN, 414)).toBe(TILE_MIN);
    expect(tileSizeFor(4, 0)).toBe(TILE_MIN);
    expect(tileSizeFor(4, Number.NaN)).toBe(TILE_MIN);
  });

  it('scales down per-tile as columns increase at the same width', () => {
    const cols4 = tileSizeFor(4, 1024);
    const cols6 = tileSizeFor(6, 1024);
    const cols7 = tileSizeFor(7, 1024);
    expect(cols4).toBeGreaterThanOrEqual(cols6);
    expect(cols6).toBeGreaterThanOrEqual(cols7);
  });
});
