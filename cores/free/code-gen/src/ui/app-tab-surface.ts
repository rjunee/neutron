/**
 * @neutronai/codegen-core — `app_tab` UI-component metadata.
 *
 * Declarative-only. P5.3 launcher navigates to `app_tab_path`; the
 * actual browser-based diff viewer is a P5.x sprint. Until then the
 * path 404s gracefully and the launcher renders its routing-error
 * toast.
 *
 * The `app_tab` surface kind was added to `cores/sdk/manifest.ts` Zod
 * schema + `core-sdk/types.ts:UiComponentSurface` in the Notes Core
 * S1 sprint (PR #240). No SDK surgery this sprint.
 *
 * Per docs/plans/code-gen-core-tier1-brief.md § 3.1 +  § 3.7.
 */

export const APP_TAB_SURFACE = {
  label: 'Code-Gen',
  emoji: '\u{1F6E0}',
  /** Project-scoped path. The token `<project_id>` is substituted by
   *  the launcher at navigation time against the active project. */
  app_tab_path: '/projects/<project_id>/code-gen' as const,
  /** Ordering hint — appears AFTER Notes / Tasks / Reminders / Calendar
   *  / Email / Research in the project shell tab list. */
  order: 70,
} as const

export type CodeGenAppTabMeta = typeof APP_TAB_SURFACE
