/**
 * @neutronai/tasks-core — launcher icon (P5.3 tile binding).
 *
 * The manifest's `ui_components[0].entry_point` resolves to this
 * module's `LAUNCHER_ICON` export. The runtime composer reads
 * `{label, emoji}` to render the launcher tile; the P5.3 launcher
 * additionally consumes:
 *
 *   - `primary_action` — the action a tap on the tile resolves to.
 *     Tasks Core picks `'open_app_tab'`: P5.4 already ships the tasks
 *     tab at `/projects/<id>/tasks` with full CRUD + focus-score sort
 *     + status filter. The "capture-a-task-without-leaving-chat" path
 *     lives in the chat-command surface (`/task <body>`) for users
 *     who never leave the chat thread.
 *
 *   - `app_tab_path` — the Expo Router path the launcher navigates to.
 *     Project-scoped: the tab renders the canonical TaskStore filtered
 *     by project_id.
 *
 *   - `long_press_menu` — three entries: capture (chat-send-prefix
 *     `/task `), browse (open the tab), pick_next (chat-send
 *     `/task focus` — fires the LLM pick-next + posts the rationale
 *     back to the channel with a tap-to-complete inline button).
 *
 * The runtime composer ALREADY reads `{emoji, label}` from this
 * constant and round-trips them through `launcherIcons.get(slug)` at
 * boot; the new fields are additive and forward-compat — older P5
 * launcher builds simply ignore them until P5.3 fully lands.
 */

export const LAUNCHER_ICON = {
  label: 'Tasks',
  /** Check-mark emoji — task canonical glyph. */
  emoji: '✅',
  primary_action: 'open_app_tab' as const,
  /** Expo Router path. `<project_id>` substitutes at navigation time. */
  app_tab_path: '/projects/<project_id>/tasks' as const,
  long_press_menu: [
    {
      id: 'capture',
      label: 'Capture a task',
      action: 'chat_send_prefix' as const,
      prefix: '/task ',
    },
    {
      id: 'browse',
      label: 'Open task list',
      action: 'open_app_tab' as const,
    },
    {
      id: 'pick_next',
      label: 'What should I focus on?',
      action: 'chat_send' as const,
      text: '/task focus',
    },
  ] as const,
} as const

export type LauncherIconMeta = typeof LAUNCHER_ICON
