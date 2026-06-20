/**
 * @neutronai/app — launcher grid layout math (P5.3).
 *
 * Pure-TS helpers for the iPhone-style adaptive launcher grid. No
 * React, no React Native — `bun test` can exercise these directly
 * without the RN bridge.
 *
 * The iPhone paradigm is the locked design language for the launcher
 * tab (per docs/master-plan-snapshot.md § 1.3): always 4 columns on
 * native, regardless of physical width. Web targets adapt to the
 * viewport — 4 columns at the phone band (≤ 480 CSS px), 5 at tablet
 * portrait (481–`BREAKPOINTS.narrow_max`), 6 at wide web
 * (`narrow_max + 1` – 1280), 7 at very wide web (1281+).
 *
 * Tile size is fluid: derived from the container width via
 * flex-basis arithmetic so the same iPhone paradigm survives every
 * viewport. Clamped to `[TILE_MIN, TILE_MAX]` so extreme aspect
 * ratios don't break the rounded-rect feel.
 */

import { BREAKPOINTS, SPACING } from './theme';

/** Lower bound on tile size — keeps the rounded-rect readable at very narrow phones. */
export const TILE_MIN = 88;
/** Upper bound on tile size — past this the iPhone-paradigm rounded rect starts to look like a card. */
export const TILE_MAX = 144;

/** Phone band — locked iPhone home-screen 4-column grid. */
export const PHONE_BAND_MAX = 480;
/** Tablet-portrait band — last width that renders 5 columns on web. */
export const TABLET_PORTRAIT_BAND_MAX = BREAKPOINTS.narrow_max;
/** Wide web band — last width that renders 6 columns. */
export const WIDE_WEB_BAND_MAX = 1280;

/**
 * Number of grid columns for a given container width.
 *
 * - Native (`platformIsWeb = false`): always 4. The iPhone paradigm is
 *   the locked design language; an Android tablet does NOT get a
 *   widescreen launcher — the visual register stays the home screen.
 * - Web: 4 / 5 / 6 / 7 across the four bands above.
 */
export function columnsForWidth(width: number, platformIsWeb: boolean): number {
  if (!platformIsWeb) return 4;
  if (!Number.isFinite(width) || width <= 0) return 4;
  if (width <= PHONE_BAND_MAX) return 4;
  if (width <= TABLET_PORTRAIT_BAND_MAX) return 5;
  if (width <= WIDE_WEB_BAND_MAX) return 6;
  return 7;
}

/**
 * Tile edge length for a given column count + container width.
 *
 * Math: `(container - row_padding * 2 - gutter * (cols - 1)) / cols`,
 * clamped to `[TILE_MIN, TILE_MAX]`. The row padding is `SPACING.lg`
 * on each side; the gutter between tiles is `SPACING.md`. Square
 * tile — width === height === tile size.
 */
export function tileSizeFor(cols: number, containerWidth: number): number {
  if (!Number.isFinite(cols) || cols <= 0) return TILE_MIN;
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return TILE_MIN;
  const gutter = SPACING.md;
  const padding = SPACING.lg;
  const available = containerWidth - padding * 2 - gutter * (cols - 1);
  const raw = available / cols;
  if (!Number.isFinite(raw)) return TILE_MIN;
  if (raw < TILE_MIN) return TILE_MIN;
  if (raw > TILE_MAX) return TILE_MAX;
  return raw;
}
