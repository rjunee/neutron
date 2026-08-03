/**
 * @neutronai/gateway/http — SQLite-backed `ProjectLauncherStore`.
 *
 * The launcher surface (`app-launcher-surface.ts`) shipped with only an
 * in-memory store, and the production composer never constructed either one, so
 * every `/api/app/projects/<id>/launcher` route 404'd in every install even
 * though the Apps tab is a shipped builtin that routes to it (ISSUES #447).
 * This is the implementation that lets the surface be mounted honestly:
 * mounting against the in-memory store would have replaced a 404 with a rename
 * that forgets itself on the next restart, which is the worse failure — a 404
 * at least tells the truth.
 *
 * THE CATALOGUE IS READ LIVE; ONLY CUSTOMISATION IS STORED. Which tiles exist
 * comes from the bundled-Cores registry on every read (the `seedProvider`),
 * never from the table. The table holds what the owner CHANGED: order, renames,
 * and per-project tile removals. Persisting the catalogue instead would freeze
 * each project's grid at the moment of its first write, so a Core installed
 * afterwards would never appear there.
 *
 * READS NEVER WRITE. Rows are materialised on the first MUTATION, never on a
 * read — see migration 0112's header and ISSUES #412, where the sibling
 * settings store's seed-on-GET turned a read endpoint into a project-creation
 * endpoint and one stray tap manufactured a permanent phantom project. Reads
 * here are far more frequent than settings reads, so the same bug would be
 * worse. A project with no stored customisation reads back the live catalogue
 * verbatim and leaves the table untouched.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  DEFAULT_LAUNCHER_SEED,
  MAX_DISPLAY_NAME_LEN,
  type LauncherEntry,
  type ProjectLauncherStore,
} from './project-launcher-store.ts'

/** One persisted customisation row. */
interface LauncherRow {
  slug: string
  display_name: string | null
  reorder_index: number
  uninstalled: number
}

type SeedEntry = Omit<LauncherEntry, 'reorder_index'>

export interface SqliteProjectLauncherStoreOptions {
  /** Static catalogue used when no provider is supplied. */
  seed?: ReadonlyArray<SeedEntry>
  /**
   * Live catalogue provider, evaluated on EVERY read so a Core installed after
   * a project's first write still shows up. Mirrors the in-memory store's
   * option of the same name; the composer passes the bundled-Cores registry
   * view, which returns the static default until `on_cores_ready` fires.
   */
  seedProvider?: () => ReadonlyArray<SeedEntry>
}

export class SqliteProjectLauncherStore implements ProjectLauncherStore {
  private readonly seed: ReadonlyArray<SeedEntry>
  private readonly seedProvider: (() => ReadonlyArray<SeedEntry>) | undefined

  constructor(
    private readonly db: ProjectDb,
    opts: SqliteProjectLauncherStoreOptions = {},
  ) {
    this.seed = opts.seed ?? DEFAULT_LAUNCHER_SEED
    this.seedProvider = opts.seedProvider
  }

  /** The catalogue as it stands right now. An empty dynamic result falls back
   *  to the static seed rather than blanking the grid. */
  private currentSeed(): ReadonlyArray<SeedEntry> {
    if (this.seedProvider !== undefined) {
      const dyn = this.seedProvider()
      return dyn.length > 0 ? dyn : this.seed
    }
    return this.seed
  }

  private readRows(project_slug: string, project_id: string): LauncherRow[] {
    return this.db.all<LauncherRow, [string, string]>(
      `SELECT slug, display_name, reorder_index, uninstalled
         FROM project_launcher_entries
        WHERE project_slug = ? AND project_id = ?
        ORDER BY reorder_index ASC`,
      [project_slug, project_id],
    )
  }

  /**
   * Overlay stored customisation on the live catalogue.
   *
   * Stored rows come first in their stored order, then any catalogue entry with
   * no row yet (a newly installed Core) in catalogue order. A stored row whose
   * Core has left the catalogue is dropped — the tile would have nothing to
   * open. Indices are compacted to a contiguous [0, n-1] so the client renders
   * the array directly, matching the in-memory store's contract.
   */
  private merge(seed: ReadonlyArray<SeedEntry>, rows: readonly LauncherRow[]): LauncherEntry[] {
    const bySlug = new Map(seed.map((e) => [e.slug, e]))
    const seen = new Set<string>()
    const out: LauncherEntry[] = []

    for (const row of rows) {
      seen.add(row.slug)
      if (row.uninstalled !== 0) continue
      const entry = bySlug.get(row.slug)
      if (entry === undefined) continue
      out.push({
        ...entry,
        display_name: row.display_name ?? entry.display_name,
        reorder_index: 0,
      })
    }
    for (const entry of seed) {
      if (seen.has(entry.slug)) continue
      out.push({ ...entry, reorder_index: 0 })
    }
    return out.map((e, i) => ({ ...e, reorder_index: i }))
  }

  async list(project_slug: string, project_id: string): Promise<LauncherEntry[]> {
    return this.merge(this.currentSeed(), this.readRows(project_slug, project_id))
  }

  /**
   * Write the CURRENT merged view back as rows, so subsequent mutations have a
   * concrete order to move within. Called only from mutations — never a read.
   */
  private async materialise(
    tx: ProjectDb,
    project_slug: string,
    project_id: string,
    entries: readonly LauncherEntry[],
    uninstalled_slugs: ReadonlySet<string>,
  ): Promise<void> {
    await tx.run(
      `DELETE FROM project_launcher_entries WHERE project_slug = ? AND project_id = ?`,
      [project_slug, project_id],
    )
    for (const e of entries) {
      await tx.run(
        `INSERT INTO project_launcher_entries
           (project_slug, project_id, slug, display_name, reorder_index, uninstalled)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [project_slug, project_id, e.slug, e.display_name, e.reorder_index],
      )
    }
    // Uninstalled tiles keep a tombstone row so they stay hidden even though
    // they are still in the live catalogue. They sort after the visible tiles.
    let idx = entries.length
    for (const slug of uninstalled_slugs) {
      await tx.run(
        `INSERT INTO project_launcher_entries
           (project_slug, project_id, slug, display_name, reorder_index, uninstalled)
         VALUES (?, ?, ?, NULL, ?, 1)`,
        [project_slug, project_id, slug, idx++],
      )
    }
  }

  /** Slugs this project has removed from its grid. */
  private uninstalledSlugs(project_slug: string, project_id: string): Set<string> {
    return new Set(
      this.readRows(project_slug, project_id)
        .filter((r) => r.uninstalled !== 0)
        .map((r) => r.slug),
    )
  }

  /**
   * Shared mutation path: read the merged view, let `apply` transform it, then
   * persist the result. `apply` returning `null` means "no change" and skips
   * the write entirely, so an unknown slug never materialises rows.
   */
  private async mutate(
    project_slug: string,
    project_id: string,
    apply: (entries: LauncherEntry[], hidden: Set<string>) => LauncherEntry[] | null,
  ): Promise<LauncherEntry[]> {
    const hidden = this.uninstalledSlugs(project_slug, project_id)
    const current = await this.list(project_slug, project_id)
    const next = apply(current, hidden)
    if (next === null) return current
    const renumbered = next.map((e, i) => ({ ...e, reorder_index: i }))
    await this.db.transaction(async (tx) => {
      await this.materialise(tx, project_slug, project_id, renumbered, hidden)
    })
    return renumbered
  }

  async reorder(
    project_slug: string,
    project_id: string,
    slug: string,
    new_index: number,
  ): Promise<LauncherEntry[]> {
    return this.mutate(project_slug, project_id, (entries) => {
      const fromIdx = entries.findIndex((e) => e.slug === slug)
      if (fromIdx === -1) return null
      const clamped = Math.max(0, Math.min(Math.floor(new_index), entries.length - 1))
      if (clamped === fromIdx) return null
      const [moved] = entries.splice(fromIdx, 1)
      if (moved === undefined) return null
      entries.splice(clamped, 0, moved)
      return entries
    })
  }

  async uninstall(
    project_slug: string,
    project_id: string,
    slug: string,
  ): Promise<LauncherEntry[]> {
    return this.mutate(project_slug, project_id, (entries, hidden) => {
      const idx = entries.findIndex((e) => e.slug === slug)
      if (idx === -1) return null
      entries.splice(idx, 1)
      hidden.add(slug)
      return entries
    })
  }

  async rename(
    project_slug: string,
    project_id: string,
    slug: string,
    new_display_name: string,
  ): Promise<LauncherEntry[]> {
    return this.mutate(project_slug, project_id, (entries) => {
      const entry = entries.find((e) => e.slug === slug)
      if (entry === undefined) return null
      const trimmed = new_display_name.trim()
      // Empty rename is a no-op. The surface validates non-empty before calling
      // us; defend in depth so a future caller cannot blank the label.
      if (trimmed.length === 0) return null
      entry.display_name = trimmed.slice(0, MAX_DISPLAY_NAME_LEN)
      return entries
    })
  }
}
