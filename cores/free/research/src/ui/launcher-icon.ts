/**
 * @neutronai/research-core — P5.3 launcher tile binding.
 *
 * Per docs/plans/research-core-tier1-brief.md § 3.1.
 *
 * The P5.3 launcher resolves a tap on this tile to one of three
 * primary actions. Research picks `open_app_tab` — the user's
 * most-common intent on tapping is "show me prior research / let me
 * browse what's in the project's research dir" rather than "let me
 * kick off a fresh research task from scratch". The capture / deep-
 * research / browse affordances all live in the long-press menu for
 * one-tap power-user access.
 *
 * Forward-compat: on Open installs that haven't taken the P5.3 PR yet
 * the launcher resolver only reads `label` + `emoji` (the v0.1.0
 * shape). The added fields (`primary_action`, `app_tab_path`,
 * `long_press_menu`) degrade to "navigate to chat" when the resolver
 * doesn't recognise them.
 *
 * NOTE — `gateway/http/project-launcher-store.ts` currently only
 * serialises `{slug, display_name, launcher_icon}` (ISSUES #17 / #18,
 * cross-Core). The long_press_menu + button postback values declared
 * here are still inert in production until those serialisations land.
 * The values are intentionally future-ready so that a single launcher-
 * store sprint enables every Tier 1 Core's menus at once.
 */

export interface ResearchLauncherIcon {
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

export const LAUNCHER_ICON: ResearchLauncherIcon = {
  label: 'Research',
  /** Microscope emoji — research / inquiry canonical glyph. */
  emoji: '\u{1F52C}',
  primary_action: 'open_app_tab',
  /**
   * The Expo Router path the launcher navigates to. Project-scoped
   * (P5.2 + P5.3 project view shell pattern). The actual app tab will
   * be mounted by a P5.x sprint; until then this path 404s gracefully
   * and the launcher's existing routing-error toast renders.
   */
  app_tab_path: '/projects/<project_id>/research',
  /**
   * Long-press menu — three items mirror sibling Cores: chat-send-
   * prefix for fast quick-research capture, chat-send-prefix for the
   * slower sub-agent deep path, and open-app-tab for the show-prior
   * browse path. Button values that start with `/research` are
   * postback-safe per the brief's HARD CONSTRAINTS.
   */
  long_press_menu: [
    {
      id: 'capture',
      label: 'Quick research',
      action: 'chat_send_prefix',
      prefix: '/research ',
    },
    {
      id: 'deep',
      label: 'Deep research',
      action: 'chat_send_prefix',
      prefix: '/research deep ',
    },
    {
      id: 'show_prior',
      label: 'Show prior briefs',
      action: 'open_app_tab',
    },
  ],
}

/** @deprecated kept for v0.1.0 import sites; same as {@link ResearchLauncherIcon}. */
export type LauncherIconMeta = ResearchLauncherIcon
