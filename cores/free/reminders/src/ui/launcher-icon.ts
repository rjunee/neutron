/**
 * @neutronai/reminders-core — launcher icon metadata (P5.3 tile).
 *
 * S1 upgrade — replaces the v0.1.0 label+emoji placeholder with a full
 * P5.3 launcher-tile binding: `primary_action`, `app_tab_path`, and a
 * three-entry `long_press_menu` (capture / browse / smart_capture).
 *
 * The launcher's tile-resolution path
 * (`gateway/http/project-launcher-store.ts:deriveLauncherSeedFromBundledCores`
 * + `app/lib/launcher-state.tsx`) currently reads only `label` + `emoji`
 * from the manifest's `launcher_icon` entry-point module. The richer
 * fields below are forward-compat — the P5.3 launcher will consume
 * `primary_action` + `long_press_menu` when the long-press affordance
 * lands in the Expo client. The byte-stable shape locked here is what
 * the brief's § 7 invariant 6 asserts.
 */

export const LAUNCHER_ICON = {
  label: 'Reminders',
  emoji: '⏰',
  /**
   * P5.3 launcher resolves a tap on this tile to one of three primary
   * actions. We pick `open_app_tab` — P5.5 already ships the reminders
   * tab at `/projects/<id>/reminders` with full CRUD + filter chips +
   * unified edit modal. The "capture-a-reminder-without-leaving-chat"
   * path lives in the chat-command surface (§ 3.2 of the brief) for
   * users who never leave the chat thread.
   */
  primary_action: 'open_app_tab' as const,
  /**
   * Expo Router path the launcher navigates to. Project-scoped — the
   * tab renders the canonical ReminderStore filtered by topic_id =
   * `app-project:<project_id>`. `<project_id>` is substituted by the
   * launcher at navigation time against the active project.
   */
  app_tab_path: '/projects/<project_id>/reminders' as const,
  /**
   * Long-press menu (P5.3 supports this on native + web). Three items:
   * - capture: chat-send-prefix `/remind ` so the user keeps typing in
   *   the chat thread after the tile preselects the verb.
   * - browse: identical to primary action (drilling into the tab).
   * - smart_capture: chat-send-prefix `/remind smart ` — opens the
   *   Shape-B smart-wrap mode for context-aware reminders (the
   *   headline Nova-skill use case: "remind me at 6pm to walk the
   *   dogs and tell me if I need a jacket").
   */
  long_press_menu: [
    {
      id: 'capture',
      label: 'Schedule a reminder',
      action: 'chat_send_prefix',
      prefix: '/remind ',
    },
    {
      id: 'browse',
      label: 'Open reminders list',
      action: 'open_app_tab',
    },
    {
      id: 'smart_capture',
      label: 'Smart reminder (with context)',
      action: 'chat_send_prefix',
      prefix: '/remind smart ',
    },
  ] as const,
} as const

export type LauncherIconMeta = typeof LAUNCHER_ICON
