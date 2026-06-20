/**
 * @neutronai/calendar-core — app-tab UI component metadata.
 *
 * The manifest's `ui_components[1]` (`surface: 'app_tab'`) points
 * here. P5.3 dynamic-imports this module at install time + reads the
 * exported `APP_TAB_META` constant to register the calendar tab in
 * the per-project nav.
 *
 * The actual app-tab UI (the React Native / Expo Router screen) is a
 * P5.x sprint — this module only declares the binding so the launcher
 * resolves taps the moment the tab mounts. Mirrors the Notes Core
 * `app_tab` pattern.
 *
 * Forward-compat: an instance on a pre-P5.3 build that doesn't yet read
 * this module renders nothing — the manifest's launcher_icon entry
 * still draws the tile, and the long-press `Show today` item falls
 * back to a routing-error toast.
 */

export const APP_TAB_META = {
  /** Display label for the tab. */
  label: 'Calendar',
  /** Tab emoji glyph. */
  emoji: '📅',
  /**
   * Expo Router path the launcher routes into.
   * `<project_id>` substituted at navigation time by the P5.3
   * launcher's tap-resolution code.
   */
  path: '/projects/<project_id>/calendar',
  /** Suggested ordering hint among the owner's tabs — lower sorts
   *  first. Calendar lands between Tasks (10) and Reminders (12). */
  order_hint: 11,
} as const

export type AppTabMeta = typeof APP_TAB_META
