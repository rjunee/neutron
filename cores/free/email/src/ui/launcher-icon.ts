/**
 * @neutronai/email-managed-core — launcher icon (P5.3 tile binding).
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.1. The P5.3
 * launcher tile resolves a tap on this tile to the primary action
 * (open the email app-tab) and a long-press to the menu (Daily
 * triage / Draft reply / Search).
 *
 * **impeccable design vocabulary applied** — the chosen primary
 * action (`open_app_tab`) matches the user's most-common intent on
 * tapping an inbox tile ("show me what's in there"); the long-press
 * menu surfaces the power-user one-tap affordances (triage, draft,
 * search) without crowding the primary tile UI. Same shape as the
 * Notes / Tasks / Reminders / Calendar Core tiles for muscle-memory
 * consistency.
 */

export const LAUNCHER_ICON = {
  label: 'Email',
  emoji: '📬',
  /** P5.3 launcher resolves a tap on this tile to one of three
   *  primary actions. We pick `open_app_tab` — the user's most-
   *  common intent on tapping is "what's in my inbox" rather than
   *  "let me draft from scratch". The triage / draft / search
   *  affordances all live in the long-press menu below for power-
   *  user one-tap access. */
  primary_action: 'open_app_tab' as const,
  /** The Expo Router path the launcher navigates to. Project-scoped
   *  (P5.2 + P5.3 project view shell pattern). The actual app tab
   *  will be mounted by a P5.x sprint; until then this path 404s
   *  gracefully and the launcher's existing routing-error toast
   *  renders. */
  app_tab_path: '/projects/<project_id>/email' as const,
  /** Long-press menu. Three items mirror the Notes / Tasks /
   *  Reminders / Calendar pattern: a chat-send-prefix for the
   *  daily-triage trigger (the headline differentiator), a chat-send-
   *  prefix for the most frequent power-user surface (compose draft),
   *  and a chat-send-prefix for Gmail-style search. */
  long_press_menu: [
    { id: 'triage', label: 'Daily triage', action: 'chat_send_prefix', prefix: '/email triage' },
    { id: 'draft',  label: 'Draft reply',  action: 'chat_send_prefix', prefix: '/email draft ' },
    { id: 'search', label: 'Search',       action: 'chat_send_prefix', prefix: '/email search ' },
  ] as const,
} as const

export type LauncherIconMeta = typeof LAUNCHER_ICON
