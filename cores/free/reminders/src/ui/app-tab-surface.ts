/**
 * @neutronai/reminders-core — declarative app-tab UI-component metadata.
 *
 * S1 — the manifest declares an `app_tab` UI component pointing at the
 * EXISTING P5.5 reminders tab at `/projects/<project_id>/reminders`
 * (`gateway/http/app-reminders-surface.ts`). Reminders Core does NOT
 * mount a parallel HTTP surface — the substrate-backed adapter + the
 * P5.5 surface already converge on the canonical store.
 *
 * Surface-kind choice. Per brief § 8 item 10 + § 13 open question 2,
 * Forge picks ONE of three paths:
 *   (i)   the `app_tab` enum value if Notes Core S1 or Tasks Core S1
 *         landed the additive enum on `cores/sdk/manifest.ts`,
 *   (ii)  ship the additive enum in THIS sprint, OR
 *   (iii) use the existing `project_tab` enum value already in the SDK.
 *
 * S1 picks (i) — Notes Core S1 (PR #247, merged 2026-05-20) landed the
 * additive `app_tab` enum value on the single manifest schema
 * (`cores/sdk/manifest.ts:UiComponentSurfaceSchema` — X3 collapsed the
 * former `core-sdk` validator + JSON-schema mirror into this one source).
 * Reminders Core consumes the
 * already-landed enum — no additive SDK change in this sprint. The
 * `app_tab` semantic is the brief's locked target ("Core's in-app
 * full-screen surface, navigated to by P5.3 launcher tiles whose
 * `primary_action='open_app_tab'`").
 *
 * Purely declarative — no runtime logic. The P5.3 launcher consumes
 * the manifest's `app_tab_path` / `label` / `emoji` / `order` to
 * render the tile + handle the long-press menu.
 */

export const APP_TAB_SURFACE = {
  /**
   * Server-relative URL the launcher navigates to when the user taps
   * the tile. P5.5 already mounts this path
   * (`/api/app/projects/<id>/reminders` for the JSON surface; the
   * Expo client renders the tab at `/projects/<id>/reminders`).
   * `<project_id>` is substituted by the launcher at navigation time.
   */
  path: '/projects/<project_id>/reminders' as const,
  /** Tab label rendered in the project-view shell. */
  label: 'Reminders' as const,
  /** Tab emoji rendered alongside the label. */
  emoji: '⏰' as const,
  /**
   * Ordering hint relative to other project tabs in the same shell.
   * Lower numbers render earlier; collisions break by alphabetical
   * label. The Reminders tab sits after Notes (10) + Tasks (20) +
   * Calendar (30) in the canonical Tier 1 row order.
   */
  order: 40,
} as const

export type AppTabSurfaceMeta = typeof APP_TAB_SURFACE
