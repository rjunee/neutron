/**
 * @neutronai/tasks-core — app-tab UI component metadata.
 *
 * Purely declarative. The Tasks Core does NOT ship its own HTTP
 * surface; P5.4 (`gateway/http/app-tasks-surface.ts`, PR #229) already
 * mounts the routes the tab consumes:
 *
 *   GET    /api/app/projects/<id>/tasks?status=<>&order=<>
 *   POST   /api/app/projects/<id>/tasks
 *   PATCH  /api/app/projects/<id>/tasks/<task_id>
 *   POST   /api/app/projects/<id>/tasks/<task_id>/complete
 *   POST   /api/app/projects/<id>/tasks/<task_id>/cancel
 *   DELETE /api/app/projects/<id>/tasks/<task_id>
 *
 * The manifest's `ui_components[]` entry declares THIS module as the
 * `app_tab` surface. The P5.3 launcher reads the metadata at boot,
 * renders the tile, and resolves a tap → navigate to
 * `/projects/<project_id>/tasks`.
 *
 * Spec input: docs/plans/tasks-core-tier1-brief.md § 3.1 + § 3.3.
 */

export const APP_TAB_META = {
  /** Expo Router path. `<project_id>` substitutes at navigation time. */
  path: '/projects/<project_id>/tasks',
  label: 'Tasks',
  emoji: '✅',
  /**
   * Order hint among project tabs (lower = earlier). Tasks Core sits
   * between Notes (~20) and Reminders (~40) per the locked Cores order
   * in `SPEC.md § Phases→Steps`.
   */
  order: 30,
} as const

export type AppTabMeta = typeof APP_TAB_META
