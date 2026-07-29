/**
 * @neutronai/calendar-core — launcher icon entry point.
 *
 * The manifest's `ui_components[0].entry_point` points here. The P5.3
 * launcher dynamic-imports this module at install time + reads the
 * exported `LAUNCHER_ICON`. The shape is additive — an instance on a
 * pre-P5.3 launcher that only reads `{label, emoji}` still renders the
 * tile correctly (graceful no-op for forward-compat).
 */

/**
 * Launcher-icon metadata + P5.3 tap-resolution bindings.
 *
 * `primary_action`: tapping the tile routes to `app_tab_path` (the
 * Calendar app tab). Users tapping on a tile mostly want to BROWSE
 * their calendar, not draft from scratch — `chat_send_prefix` would
 * route them to a chat-input pre-filled with `/cal create `, which is
 * the *less* common intent.
 *
 * `long_press_menu`: three items mirror the Notes / Tasks / Reminders
 * Core long-press pattern. Capture (create event) and Find time (the
 * second most-frequent power-user surface) route via
 * `chat_send_prefix`; Show today routes to the app tab (same as
 * primary_action) for one-tap access without the long-press → menu →
 * pick dance.
 */
export const LAUNCHER_ICON = {
  label: 'Calendar',
  /** Calendar emoji — canonical glyph for the surface. */
  emoji: '📅',
  /** P5.3 primary action — `open_app_tab` routes to `app_tab_path`. */
  primary_action: 'open_app_tab' as const,
  /**
   * Expo Router path the launcher navigates to. Project-scoped (P5.2 +
   * P5.3 project view shell pattern). The actual calendar app tab is
   * a P5.x sprint; until then this path 404s gracefully and the
   * launcher renders its existing routing-error toast.
   */
  app_tab_path: '/projects/<project_id>/calendar' as const,
  long_press_menu: [
    {
      id: 'capture',
      label: 'Create event',
      action: 'chat_send_prefix' as const,
      prefix: '/cal create ',
    },
    {
      id: 'find_time',
      label: 'Find time',
      action: 'chat_send_prefix' as const,
      prefix: '/cal find-time ',
    },
    {
      id: 'show_today',
      label: 'Show today',
      action: 'open_app_tab' as const,
    },
  ] as const,
} as const

export type LauncherIconMeta = typeof LAUNCHER_ICON
