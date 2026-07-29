/**
 * @neutronai/codegen-core — launcher icon metadata (P5.3 tile).
 *
 * S2 narrowed the chat surface to `/code <task>` + `/code stop` — the
 * old `/code review` long-press affordance is gone because the
 * autonomous Forge → Argus → auto-merge loop does the review step
 * itself with no user touch. The remaining affordances are "Build
 * something" (prefills the chat input with `/code `) and "Open diff
 * viewer" (navigates to the project's app-tab path; the actual
 * browser diff viewer is a P5.x sprint).
 *
 * NOTE — the long_press_menu surface is currently inert across all
 * Tier 1 Cores (ISSUES #17 in the gateway / app pipeline): the P5.3
 * launcher does NOT yet consume long_press_menu beyond the
 * label+emoji core. Declaring it here is forward-compat — the Tasks
 * Core (PR #249) shipped the same shape; once #17 lands, every Tier 1
 * Core's long_press_menu activates uniformly.
 *
 * Per docs/plans/code-gen-core-tier1-brief.md § 3.1.
 */

export const LAUNCHER_ICON = {
  label: 'Code-Gen',
  /** Hammer-and-wrench emoji — productizes the trident/forge/argus
   *  surface for non-technical users, so the icon nods to a tool belt
   *  rather than a code-file glyph. (Carries forward from v0.1.0.) */
  emoji: '\u{1F6E0}',
  /**
   * P5.3 launcher resolves a tap on this tile to one of three primary
   * actions. We pick `open_app_tab` — the most-common intent on
   * tapping is "show me my latest build / PR / diff" rather than "let
   * me start a new task from scratch". The Build affordance lives in
   * the long-press menu for one-tap power-user access.
   */
  primary_action: 'open_app_tab' as const,
  /**
   * The Expo Router path the launcher navigates to. Project-scoped
   * (P5.2 + P5.3 project view shell pattern). The actual app tab
   * (browser-based diff viewer + build-history list) is a P5.x sprint;
   * until then this path 404s gracefully and the launcher's existing
   * routing-error toast renders.
   */
  app_tab_path: '/projects/<project_id>/code-gen' as const,
  long_press_menu: [
    { id: 'capture',          label: 'Build something',  action: 'chat_send_prefix', prefix: '/code ' },
    { id: 'open_diff_viewer', label: 'Open diff viewer', action: 'open_app_tab' },
  ] as const,
} as const

export type LauncherIconMeta = typeof LAUNCHER_ICON
