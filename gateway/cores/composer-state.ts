/**
 * @neutronai/gateway/cores — composer state contract (P3 cores wire-up).
 *
 * The `cores` module exposes this shape to the graph; HTTP surfaces +
 * launcher seed read it via `graph.get<CoresModuleState>('cores')`.
 *
 * Shape (locked by `docs/plans/P3-cores-wireup-sprint-brief.md § 2.2`):
 *   - `registry`  — bundled-Cores catalog from `buildBundledRegistry(...)`.
 *                   Independent of per-instance install state.
 *   - `installed` — slug → live `InstallCoreResult` for Cores whose
 *                   install lifecycle ran cleanly at boot. Used by the
 *                   launcher seed (filter to installed slugs) and by
 *                   `/api/cores`'s `install_state: 'installed'` branch.
 *   - `failures` — per-Core failure transcript. Routed through the
 *                  boot warning sink AND surfaced via
 *                  `/api/cores`'s `install_state: 'failed'` branch +
 *                  `install_error.{code,message}` so ops dashboards can
 *                  tell a missing-secret manifest apart from a
 *                  broken-packaging failure without scanning logs.
 */

import type { BundledRegistry } from '../../cores/runtime/bundled-registry.ts'
import type { InstallCoreResult } from '../../cores/runtime/lifecycle.ts'

export interface CoreInstallFailure {
  /** Stable slug — matches `BundledCore.slug` so `/api/cores` can
   *  cross-reference the manifest. */
  core_slug: string
  /** `CoreInstallErrorCode` (`manifest_invalid`, `package_not_found`,
   *  `duplicate_install`, etc.) or `'unknown'` for non-typed throws. */
  code: string
  /** Operator-friendly summary. The structured-log event carries the
   *  full `details` object; this is what surfaces in the HTTP body. */
  message: string
}

/**
 * Resolved launcher-icon metadata for a successfully-installed Core.
 * Sourced at install time by dynamic-importing the Core's
 * `ui_components[].entry_point` for any entry whose `surface ===
 * 'launcher_icon'` and reading the exported `LAUNCHER_ICON` constant
 * (`{ emoji, label, primary_action?, app_tab_path?, long_press_menu? }`).
 * Read by `deriveLauncherSeedFromBundledCores` so the launcher tile
 * mirrors what the Core's authoring intent declares — falling back to
 * the per-slug `SLUG_DISPLAY_DEFAULTS` map (and ultimately the generic
 * 🧩) only when the Core lacks a `launcher_icon` surface or its module
 * fails to load.
 *
 * Forward-compat: when the SDK manifest schema grows a first-class
 * `launcher_icon` field on the ui_components entry, this map's
 * hydrator switches to a pure manifest read and drops the dynamic-
 * import path. Until then, the entry_point module IS the manifest of
 * the icon.
 *
 * Per ISSUE #17 closure (2026-05-22): the runtime composer now reads
 * the richer `primary_action`, `app_tab_path`, and `long_press_menu`
 * fields out of the LAUNCHER_ICON module too — Cores like Tasks +
 * Reminders + Notes declare them at the source (`./src/ui/launcher-
 * icon.ts`) and the launcher tile's tap + long-press affordances
 * dispatch off them in the app. All three fields are optional so a
 * Core whose LAUNCHER_ICON ships only `{emoji, label}` (the v0.1.0
 * shape) still installs cleanly with a tap → default tab inference
 * and no long-press menu.
 */
export interface LauncherIconLongPressEntry {
  /** Stable id — used by the app for tracking which row was tapped
   *  and for analytics. Required. */
  id: string
  /** Human label rendered in the action-sheet row. Required. */
  label: string
  /** Dispatch verb. The app maps each value to a concrete handler:
   *   - 'open_app_tab' → router.push(app_tab_path-with-project-id)
   *   - 'chat_send_prefix' → prefill the chat composer with `prefix`
   *   - 'chat_send' → send `text` immediately as a user message
   */
  action: 'open_app_tab' | 'chat_send' | 'chat_send_prefix'
  /** Body the composer is prefilled with. Required when action ===
   *  'chat_send_prefix'. Ignored for other actions. */
  prefix?: string
  /** Message body sent immediately. Required when action ===
   *  'chat_send'. Ignored for other actions. */
  text?: string
}

export interface LauncherIconMeta {
  emoji: string
  label?: string
  /** Tile tap-action verb (mirrors LauncherIconLongPressEntry.action).
   *  When omitted the app falls back to its slug-derived default
   *  (slug minus a `_core` suffix → `/projects/<id>/<slug>`). */
  primary_action?: 'open_app_tab' | 'chat_send' | 'chat_send_prefix'
  /** Expo Router path for `open_app_tab` dispatch. `<project_id>` in
   *  the string is substituted at navigation time. */
  app_tab_path?: string
  /** Ordered list of long-press menu rows. Empty / undefined → the
   *  launcher renders only the legacy Rename/Move/Delete affordances. */
  long_press_menu?: ReadonlyArray<LauncherIconLongPressEntry>
}

export interface CoresModuleState {
  /**
   * The bundled-Cores catalog. Always present at boot — a manifest-
   * validation failure during registry construction is fatal (it's a
   * code bug, not a per-instance fault), so by the time `cores` exposes
   * a `CoresModuleState` the registry has cleanly loaded every well-
   * formed Core. The `failures` array tracks per-Core INSTALL failures
   * (lifecycle step), which is downstream of registry construction.
   */
  readonly registry: BundledRegistry
  /**
   * Map of installed Cores keyed by slug. Each entry is the live
   * `InstallCoreResult` from `installCore(...)`, carrying the loaded
   * manifest, allocated namespace, `core_installations` row, and the
   * capability-gated `SecretsAccessor` the Core's tools dispatch
   * through. A Core that failed install is absent from this map and
   * appears in `failures` instead — `install_state: 'failed'` over HTTP.
   */
  readonly installed: ReadonlyMap<string, InstallCoreResult>
  /**
   * Per-Core install failures. One entry per Core whose `installCore`
   * threw (typed `CoreInstallError` or any other throw — see
   * `composeInstallBundled.ts § 5b/5c`). Hard-fail at boot when MORE
   * than half of the discovered Cores end up here (§ 5d failure-rate
   * gate); below that, the gateway continues serving the surviving
   * Cores.
   */
  readonly failures: ReadonlyArray<CoreInstallFailure>
  /**
   * Map of resolved launcher-icon metadata keyed by Core slug. Only
   * Cores that BOTH installed cleanly AND declare a `launcher_icon`
   * surface in their manifest appear here. A failed-install Core
   * never seeds the launcher (its tile would dispatch into the Core's
   * tool surface which never registered), so omitting failed slugs
   * from this map is intentional.
   */
  readonly launcherIcons: ReadonlyMap<string, LauncherIconMeta>
}
