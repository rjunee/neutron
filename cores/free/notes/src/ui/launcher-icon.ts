/**
 * @neutronai/notes — P5.3 launcher tile binding.
 *
 * Per docs/plans/notes-core-tier1-brief.md § 3.1.
 *
 * The P5.3 launcher resolves a tap on this tile to one of three
 * primary actions. Notes picks `open_app_tab` — the user wants the
 * drawer browser, not a free-form chat. The "I want to take a note"
 * path lives in the chat-command surface (§ 3.2) for users who never
 * leave the chat thread, and is also surfaced as a long-press menu
 * item so launcher and chat reach parity.
 *
 * Forward-compat: on Open installs that haven't taken the P5.3 PR yet
 * the launcher resolver only reads `label` + `emoji` (the v0.1.0
 * shape). The added fields (`primary_action`, `app_tab_path`,
 * `long_press_menu`) degrade to "navigate to chat" when the resolver
 * doesn't recognise them.
 */

export interface NotesLauncherIcon {
  readonly label: string
  readonly emoji: string
  readonly primary_action: 'open_app_tab'
  readonly app_tab_path: string
  readonly long_press_menu: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly action: 'chat_send_prefix' | 'open_app_tab'
    readonly prefix?: string
  }>
}

export const LAUNCHER_ICON: NotesLauncherIcon = {
  label: 'Notes',
  emoji: '🧠',
  primary_action: 'open_app_tab',
  /**
   * The Expo Router path the launcher navigates to. Project-scoped
   * (P5.2 + P5.3 project view shell pattern). The `<project_id>`
   * placeholder is resolved at tap time from the active project
   * context.
   */
  app_tab_path: '/projects/<project_id>/notes',
  long_press_menu: [
    {
      id: 'capture',
      label: 'I want to take a note',
      action: 'chat_send_prefix',
      prefix: '/note ',
    },
    {
      id: 'browse',
      label: 'Open drawer browser',
      action: 'open_app_tab',
    },
  ],
}

/** @deprecated kept for v0.1.0 import sites; same as {@link NotesLauncherIcon}. */
export type LauncherIconMeta = NotesLauncherIcon
