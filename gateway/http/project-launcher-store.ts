/**
 * @neutronai/gateway/http — project-scoped launcher store (P5.3).
 *
 * Per SPEC.md § Phases→Steps (P5.3 — "Launcher
 * (project-scoped). Drag-and-drop reorder, long-press menu, 'Build me…'
 * → new icon").
 *
 * The launcher surface exposes per-project ordered lists of installed
 * Cores. In production each entry resolves to a Tier 1 free Core
 * (`cores/free/notes`, `cores/free/tasks`, …) or a Tier 2 paid Core; the
 * gateway surfaces them as iPhone-style tiles in the Expo app.
 *
 * For P5.3 the source of truth is in-memory and per-gateway-process:
 *
 *   - On first access for a (instance, project) pair the store seeds the
 *     ordered list from a configured "default seed". The seed is the
 *     canonical set of bundled Tier 1 free Cores. Production wires
 *     {Notes, Tasks, Reminders} as a forward-decl seed so the launcher
 *     has something to show before any owner has explicitly installed a
 *     Core.
 *
 *   - Reorder + uninstall are mutations against the in-memory map. The
 *     store is intentionally process-local; the next sprint that wires
 *     real per-project install tracking (against
 *     `cores/runtime/installations-store.ts`) replaces this implementation
 *     without changing the surface contract.
 *
 *   - `reorder_index` is the canonical sort key. Entries are ordered by
 *     ascending `reorder_index`; equal indices are stable-ordered by
 *     slug. Reorders compact indices to a [0, n-1] contiguous range so
 *     the client can render them directly without normalisation.
 *
 *   - Uninstall is a soft-remove for the (instance, project) pair only.
 *     The underlying Core installation row in
 *     `core_installations` (when it exists in a later sprint) is NOT
 *     touched — uninstalling from the project's launcher just removes
 *     the tile from this project's view. Cross-project uninstall is a
 *     later P5.x concern.
 *
 * The interface is the contract Argus + tests check; the in-memory
 * implementation is the only one shipped in P5.3.
 */

export type LauncherIconEmoji = { kind: 'emoji'; value: string }
export type LauncherIconUrl = { kind: 'url'; value: string }
export type LauncherIcon = LauncherIconEmoji | LauncherIconUrl

/**
 * One row of a launcher tile's long-press action sheet. Mirrors
 * `LauncherIconLongPressEntry` in `gateway/cores/composer-state.ts` —
 * the manifest field flows from `LAUNCHER_ICON.long_press_menu` →
 * `LauncherIconMeta.long_press_menu` → here, byte-stable.
 */
export interface LauncherEntryLongPressEntry {
  id: string
  label: string
  action: 'open_app_tab' | 'chat_send' | 'chat_send_prefix'
  /** Required when action === 'chat_send_prefix'. */
  prefix?: string
  /** Required when action === 'chat_send'. */
  text?: string
}

export interface LauncherEntry {
  /** Core slug — stable identifier, matches the Core's manifest slug. */
  slug: string
  /** Human-readable name. Mutable per-project via the rename surface. */
  display_name: string
  /** Icon to render on the tile. Mutable per-project. */
  launcher_icon: LauncherIcon
  /** 0-based contiguous sort index. The list is returned sorted ASC. */
  reorder_index: number
  /** Mirrored from LauncherIconMeta. Tile tap-action verb. Optional —
   *  older Cores ship without it and the app falls back to its slug-
   *  derived default tab path. */
  primary_action?: 'open_app_tab' | 'chat_send' | 'chat_send_prefix'
  /** Expo Router path target for `open_app_tab` dispatch. Substitution
   *  for `<project_id>` happens at navigation time in the app. */
  app_tab_path?: string
  /** Ordered list of long-press menu rows. Optional. */
  long_press_menu?: ReadonlyArray<LauncherEntryLongPressEntry>
}

/**
 * The set of bundled-Core defaults used to seed an empty
 * (instance, project) lookup. Surfaces the canonical Tier 1 free Cores
 * (Notes + Tasks already shipped; Reminders forward-decl per sprint
 * roadmap § 3) so the launcher renders something useful in dev/web smoke
 * before any per-project install tracking is wired.
 *
 * Pulled from the Core manifests' `launcher_icon` blocks:
 *   - cores/free/notes/src/ui/launcher-icon.ts:LAUNCHER_ICON
 *   - cores/free/tasks/src/ui/launcher-icon.ts:LAUNCHER_ICON
 *
 * The Reminders Core ships in a later sprint; the launcher pre-knows
 * about it so the Notes/Tasks tile set lines up alongside Reminders on
 * day 1 (no rearrangement when Reminders' real Core lands).
 */
export const DEFAULT_LAUNCHER_SEED: ReadonlyArray<Omit<LauncherEntry, 'reorder_index'>> = [
  { slug: 'notes', display_name: 'Notes', launcher_icon: { kind: 'emoji', value: '🧠' } },
  { slug: 'tasks_core', display_name: 'Tasks', launcher_icon: { kind: 'emoji', value: '✅' } },
  { slug: 'reminders', display_name: 'Reminders', launcher_icon: { kind: 'emoji', value: '⏰' } },
]

/**
 * Per-slug fallback launcher-tile metadata. Used when a bundled Core's
 * manifest lacks a `launcher_icon` UI component (`ui_components[]` is
 * empty or surfaces something other than `launcher_icon`). Keyed by
 * `BundledCore.slug` (the lowercased + sanitized package name).
 *
 * The Tier 1 free Cores all SHIP a launcher-icon UI component in their
 * manifest, so in production this map covers only the corner case
 * where a third-party Core forgets the surface; tests rely on it for
 * fixture Cores that omit the UI block.
 */
const SLUG_DISPLAY_DEFAULTS: Readonly<Record<string, { display_name: string; emoji: string }>> = {
  notes: { display_name: 'Notes', emoji: '🧠' },
  tasks_core: { display_name: 'Tasks', emoji: '✅' },
  reminders_core: { display_name: 'Reminders', emoji: '⏰' },
  calendar_core: { display_name: 'Calendar', emoji: '📅' },
  email_managed_core: { display_name: 'Email', emoji: '✉️' },
  research_core: { display_name: 'Research', emoji: '🔍' },
  codegen_core: { display_name: 'Code-gen', emoji: '🛠' },
}

const FALLBACK_EMOJI = '🧩'

/**
 * Derive a launcher seed from a `CoresModuleState`. The result orders
 * Cores lexicographically by slug (matching `BundledRegistry.list()`'s
 * stable order) and filters to slugs that DID install cleanly this
 * boot — Cores that failed install never seed into the launcher
 * (their `/api/cores` row carries `install_state: 'failed'` for ops
 * visibility, but the tile would dispatch into a `not_implemented`
 * stub which is worse UX than not surfacing it).
 *
 * Icon resolution chain (per docs/plans/P3-cores-wireup-sprint-brief.md
 * § 4.1, refined by Argus R2 IMPORTANT #1 on 2026-05-18):
 *
 *   1. `cores.launcherIcons.get(slug)?.emoji` — the manifest's
 *      `launcher_icon` surface entry_point module, pre-resolved at
 *      install time. This is the authoring intent that ships with
 *      the Core's source and is what the test fixture must respect.
 *   2. `SLUG_DISPLAY_DEFAULTS[slug].emoji` — per-slug fallback for the
 *      bundled Tier 1 Cores when the manifest's module didn't load.
 *   3. `FALLBACK_EMOJI` — generic 🧩 for new bundled / third-party
 *      Cores not in the defaults map.
 *
 * Display-name resolution follows the symmetric chain (manifest module
 * `label` → defaults map → raw slug).
 */
export function deriveLauncherSeedFromBundledCores(
  cores: import('../cores/composer-state.ts').CoresModuleState,
): Array<Omit<LauncherEntry, 'reorder_index'>> {
  const entries: Array<Omit<LauncherEntry, 'reorder_index'>> = []
  for (const core of cores.registry.list()) {
    if (!cores.installed.has(core.slug)) continue
    const launcherSurface = core.manifest.ui_components.find(
      (c) => c.surface === 'launcher_icon',
    )
    if (launcherSurface === undefined) continue
    const manifestIcon = cores.launcherIcons.get(core.slug)
    const defaults = SLUG_DISPLAY_DEFAULTS[core.slug]
    const display_name =
      manifestIcon?.label ?? defaults?.display_name ?? core.slug
    const emoji =
      manifestIcon?.emoji ?? defaults?.emoji ?? FALLBACK_EMOJI
    const entry: Omit<LauncherEntry, 'reorder_index'> = {
      slug: core.slug,
      display_name,
      launcher_icon: { kind: 'emoji', value: emoji },
    }
    // ISSUE #17 — propagate the richer P5.3 fields from the Core's
    // resolved `LAUNCHER_ICON` metadata. All optional; omitted when
    // the Core's launcher-icon module didn't declare them.
    if (manifestIcon?.primary_action !== undefined) {
      entry.primary_action = manifestIcon.primary_action
    }
    if (manifestIcon?.app_tab_path !== undefined) {
      entry.app_tab_path = manifestIcon.app_tab_path
    }
    if (
      manifestIcon?.long_press_menu !== undefined &&
      manifestIcon.long_press_menu.length > 0
    ) {
      entry.long_press_menu = manifestIcon.long_press_menu.map((m) => ({
        id: m.id,
        label: m.label,
        action: m.action,
        ...(m.prefix !== undefined ? { prefix: m.prefix } : {}),
        ...(m.text !== undefined ? { text: m.text } : {}),
      }))
    }
    entries.push(entry)
  }
  return entries
}

export interface ProjectLauncherStore {
  /** Return the ordered launcher entries for (instance, project). */
  list(project_slug: string, project_id: string): Promise<LauncherEntry[]>

  /**
   * Move the entry with `slug` to `new_index`. Returns the updated
   * ordered list. Indices outside [0, n-1] are clamped. A move on an
   * unknown slug returns the list unchanged.
   *
   * `new_index` is the **final position** of the moved tile in the
   * result array — equivalently, the index of the tile the user
   * dropped onto. After a forward move (`fromIdx < new_index`) the
   * drop target shifts left to fill the gap; after a backward move it
   * shifts right. The Sprint P5.3 web DnD handler passes the drop
   * target's grid index as `new_index`, so the dragged tile lands at
   * the slot the user visually targeted.
   */
  reorder(
    project_slug: string,
    project_id: string,
    slug: string,
    new_index: number,
  ): Promise<LauncherEntry[]>

  /**
   * Remove the entry with `slug` from the project's launcher. Returns
   * the updated ordered list. Uninstall on an unknown slug returns the
   * list unchanged.
   */
  uninstall(project_slug: string, project_id: string, slug: string): Promise<LauncherEntry[]>

  /**
   * Rename the entry with `slug` for the project. Returns the updated
   * ordered list. Rename on an unknown slug returns the list unchanged.
   */
  rename(
    project_slug: string,
    project_id: string,
    slug: string,
    new_display_name: string,
  ): Promise<LauncherEntry[]>
}

export interface InMemoryProjectLauncherStoreOptions {
  /** Default seed used for the first access of any (instance, project) pair. */
  seed?: ReadonlyArray<Omit<LauncherEntry, 'reorder_index'>>
  /**
   * Dynamic seed provider — evaluated lazily on each fresh
   * (instance, project) lookup. When supplied, takes precedence over
   * `seed`. Used by the P3 cores wire-up to derive the seed from the
   * live bundled-Cores registry post-compose; the provider returns
   * `DEFAULT_LAUNCHER_SEED` (the static fallback) until the cores
   * module's `on_cores_ready` hook fires.
   */
  seedProvider?: () => ReadonlyArray<Omit<LauncherEntry, 'reorder_index'>>
}

/**
 * In-memory implementation, keyed by slug + project composite key. Process-
 * local. Production boot ships exactly one instance per gateway process;
 * tests inject their own.
 */
export class InMemoryProjectLauncherStore implements ProjectLauncherStore {
  private readonly map = new Map<string, LauncherEntry[]>()
  private readonly seed: ReadonlyArray<Omit<LauncherEntry, 'reorder_index'>>
  private readonly seedProvider:
    | (() => ReadonlyArray<Omit<LauncherEntry, 'reorder_index'>>)
    | undefined

  constructor(opts: InMemoryProjectLauncherStoreOptions = {}) {
    this.seed = opts.seed ?? DEFAULT_LAUNCHER_SEED
    this.seedProvider = opts.seedProvider
  }

  private currentSeed(): ReadonlyArray<Omit<LauncherEntry, 'reorder_index'>> {
    if (this.seedProvider !== undefined) {
      const dyn = this.seedProvider()
      return dyn.length > 0 ? dyn : this.seed
    }
    return this.seed
  }

  async list(project_slug: string, project_id: string): Promise<LauncherEntry[]> {
    return this.snapshot(this.lookup(project_slug, project_id))
  }

  async reorder(
    project_slug: string,
    project_id: string,
    slug: string,
    new_index: number,
  ): Promise<LauncherEntry[]> {
    const entries = this.lookup(project_slug, project_id)
    const fromIdx = entries.findIndex((e) => e.slug === slug)
    if (fromIdx === -1) return this.snapshot(entries)
    const clamped = Math.max(0, Math.min(Math.floor(new_index), entries.length - 1))
    if (clamped === fromIdx) return this.snapshot(entries)
    const [moved] = entries.splice(fromIdx, 1)
    if (moved === undefined) return this.snapshot(entries)
    entries.splice(clamped, 0, moved)
    this.recomputeIndices(entries)
    return this.snapshot(entries)
  }

  async uninstall(
    project_slug: string,
    project_id: string,
    slug: string,
  ): Promise<LauncherEntry[]> {
    const entries = this.lookup(project_slug, project_id)
    const idx = entries.findIndex((e) => e.slug === slug)
    if (idx === -1) return this.snapshot(entries)
    entries.splice(idx, 1)
    this.recomputeIndices(entries)
    return this.snapshot(entries)
  }

  async rename(
    project_slug: string,
    project_id: string,
    slug: string,
    new_display_name: string,
  ): Promise<LauncherEntry[]> {
    const entries = this.lookup(project_slug, project_id)
    const entry = entries.find((e) => e.slug === slug)
    if (entry === undefined) return this.snapshot(entries)
    const trimmed = new_display_name.trim()
    // Empty rename is a no-op — the surface validates `non-empty` before
    // calling us, but defend in depth so a future caller can't blank
    // the label.
    if (trimmed.length > 0) entry.display_name = trimmed.slice(0, MAX_DISPLAY_NAME_LEN)
    return this.snapshot(entries)
  }

  /**
   * Test helper — seed a specific (instance, project) pair with a custom
   * ordered list. Not part of the `ProjectLauncherStore` contract.
   */
  seedFor(
    project_slug: string,
    project_id: string,
    entries: ReadonlyArray<Omit<LauncherEntry, 'reorder_index'>>,
  ): void {
    const cloned: LauncherEntry[] = entries.map((e, i) => cloneSeedEntry(e, i))
    this.map.set(keyOf(project_slug, project_id), cloned)
  }

  private lookup(project_slug: string, project_id: string): LauncherEntry[] {
    const k = keyOf(project_slug, project_id)
    const existing = this.map.get(k)
    if (existing !== undefined) return existing
    const seed = this.currentSeed()
    const fresh: LauncherEntry[] = seed.map((e, i) => cloneSeedEntry(e, i))
    this.map.set(k, fresh)
    return fresh
  }

  private recomputeIndices(entries: LauncherEntry[]): void {
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      if (entry !== undefined) entry.reorder_index = i
    }
  }

  private snapshot(entries: LauncherEntry[]): LauncherEntry[] {
    // Defensive copy — callers must not be able to mutate the store's
    // canonical state by mutating the array we return. The richer
    // P5.3 fields (primary_action / app_tab_path / long_press_menu)
    // are likewise deep-cloned so a caller mutating a long-press
    // entry can't reach back into the store's state.
    return entries.map((e) => cloneEntry(e))
  }
}

/**
 * Clone a stored `LauncherEntry`. Deep on the `launcher_icon` shape
 * (always non-null) and on `long_press_menu` (optional).
 */
function cloneEntry(e: LauncherEntry): LauncherEntry {
  const out: LauncherEntry = {
    slug: e.slug,
    display_name: e.display_name,
    launcher_icon: { ...e.launcher_icon },
    reorder_index: e.reorder_index,
  }
  if (e.primary_action !== undefined) out.primary_action = e.primary_action
  if (e.app_tab_path !== undefined) out.app_tab_path = e.app_tab_path
  if (e.long_press_menu !== undefined) {
    out.long_press_menu = e.long_press_menu.map((m) => ({
      id: m.id,
      label: m.label,
      action: m.action,
      ...(m.prefix !== undefined ? { prefix: m.prefix } : {}),
      ...(m.text !== undefined ? { text: m.text } : {}),
    }))
  }
  return out
}

/**
 * Clone a seed entry (no `reorder_index` yet) into a full
 * `LauncherEntry`, stamping the supplied 0-based index. Symmetric
 * with `cloneEntry` so we can never strip the new fields between
 * seed-shape and stored-shape.
 */
function cloneSeedEntry(
  e: Omit<LauncherEntry, 'reorder_index'>,
  reorder_index: number,
): LauncherEntry {
  const out: LauncherEntry = {
    slug: e.slug,
    display_name: e.display_name,
    launcher_icon: { ...e.launcher_icon },
    reorder_index,
  }
  if (e.primary_action !== undefined) out.primary_action = e.primary_action
  if (e.app_tab_path !== undefined) out.app_tab_path = e.app_tab_path
  if (e.long_press_menu !== undefined) {
    out.long_press_menu = e.long_press_menu.map((m) => ({
      id: m.id,
      label: m.label,
      action: m.action,
      ...(m.prefix !== undefined ? { prefix: m.prefix } : {}),
      ...(m.text !== undefined ? { text: m.text } : {}),
    }))
  }
  return out
}

/** Conservative cap on rename payload so a malformed client can't push
 *  unbounded strings through the store / response body. */
export const MAX_DISPLAY_NAME_LEN = 80

function keyOf(project_slug: string, project_id: string): string {
  return `${project_slug}::${project_id}`
}
