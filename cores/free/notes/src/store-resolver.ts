/**
 * @neutronai/notes — per-project sidecar resolver.
 *
 * Resolves a (owner_home, project_id) pair to a NotesStore handle
 * over `<owner_home>/Projects/<project_id>/notes/notes.db`, applying
 * the Notes Core's own migration tree before constructing the store.
 *
 * Mirrors `gateway/comments/comment-store.ts`'s per-project SQLite
 * pattern (P7.2 S1 precedent): one Database handle per project, cached
 * for the gateway lifetime, init-promise dedup so two concurrent first-
 * writes wait on the same init.
 *
 * Per docs/plans/notes-core-tier1-brief.md § 4.
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyProjectScopedMigrations } from '../../../../migrations/runner.ts'

import {
  NOTES_SCHEMA_VERSION,
  NotesSidecarMismatchError,
  NotesStore,
} from './notes-store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Default per-project sidecar dir name. Visible (no leading dot)
 *  because — unlike `.comments/` / `.docs-versions/` — `notes/` is
 *  user-visible content the P7 file explorer should surface under the
 *  project tree (via a Notes-aware adapter; see brief § 4.1). */
export const NOTES_SIDECAR_DIR = 'notes'
export const NOTES_SIDECAR_DB = 'notes.db'

/** Default location of the per-project Notes migration tree. The
 *  resolver looks here at init time; tests override via the
 *  constructor option. */
export const DEFAULT_MIGRATIONS_DIR = join(HERE, '..', 'migrations')

export interface NotesStoreResolverOptions {
  /** Absolute path to the instance home (`<owner_home>`) dir. */
  owner_home: string
  /** Override per-project root resolution. Default:
   *  `<owner_home>/Projects/<project_id>/`. */
  resolveProjectRoot?: (project_id: string) => string
  /** Override the migrations dir (testing seam). Defaults to the
   *  in-tree `cores/free/notes/migrations/` tree. */
  migrations_dir?: string
  /** Override the ULID factory (passed through to NotesStore). */
  ulid?: () => string
  /** Override the clock (passed through to NotesStore). */
  now?: () => number
}

interface ProjectHandle {
  store: NotesStore
  notes_db_path: string
}

export class NotesStoreResolver {
  private readonly owner_home: string
  private readonly resolveProjectRoot: (project_id: string) => string
  private readonly migrations_dir: string
  private readonly ulid: (() => string) | undefined
  private readonly now: (() => number) | undefined
  private readonly handles = new Map<string, ProjectHandle>()
  private readonly initPromises = new Map<string, Promise<ProjectHandle>>()

  constructor(opts: NotesStoreResolverOptions) {
    this.owner_home = opts.owner_home
    this.resolveProjectRoot =
      opts.resolveProjectRoot ??
      ((project_id) => join(opts.owner_home, 'Projects', project_id))
    this.migrations_dir = opts.migrations_dir ?? DEFAULT_MIGRATIONS_DIR
    this.ulid = opts.ulid
    this.now = opts.now
  }

  /** Path the resolver would (or did) open for the given project. */
  pathFor(project_id: string): string {
    return join(this.resolveProjectRoot(project_id), NOTES_SIDECAR_DIR, NOTES_SIDECAR_DB)
  }

  /** Force-close every cached handle. Useful for tests. */
  closeAll(): void {
    for (const handle of this.handles.values()) {
      handle.store.close()
    }
    this.handles.clear()
    this.initPromises.clear()
  }

  /**
   * Resolve the store for `project_id`. Lazy: first call opens the
   * SQLite handle, applies migrations, stamps `notes_meta`. Subsequent
   * calls return the cached handle.
   *
   * Throws `NotesSidecarMismatchError` if the on-disk `notes_meta.project_id`
   * doesn't match — defence-in-depth against a sidecar getting copied
   * between project dirs.
   */
  async resolve(project_id: string): Promise<NotesStore> {
    const handle = await this.openHandle(project_id)
    return handle.store
  }

  private async openHandle(project_id: string): Promise<ProjectHandle> {
    const cached = this.handles.get(project_id)
    if (cached !== undefined) return cached
    const pending = this.initPromises.get(project_id)
    if (pending !== undefined) return pending
    const init = this.doInit(project_id)
    this.initPromises.set(project_id, init)
    try {
      const handle = await init
      this.handles.set(project_id, handle)
      return handle
    } finally {
      this.initPromises.delete(project_id)
    }
  }

  private async doInit(project_id: string): Promise<ProjectHandle> {
    const projectRoot = this.resolveProjectRoot(project_id)
    const notesDir = join(projectRoot, NOTES_SIDECAR_DIR)
    if (!existsSync(notesDir)) {
      mkdirSync(notesDir, { recursive: true, mode: 0o700 })
    }
    const dbPath = join(notesDir, NOTES_SIDECAR_DB)
    const db = new Database(dbPath, { create: true })
    db.exec('PRAGMA foreign_keys = ON')
    applyProjectScopedMigrations(db, this.migrations_dir)
    // After migrations, notes_meta exists. Insert the bootstrap row if
    // missing; verify project_id matches if present.
    const existing = db
      .query<{ project_id: string; schema_version: number }, []>(
        `SELECT project_id, schema_version FROM notes_meta LIMIT 1`,
      )
      .get()
    if (existing === null) {
      db.run(
        `INSERT INTO notes_meta (schema_version, project_id, initialised_at) VALUES (?, ?, ?)`,
        [NOTES_SCHEMA_VERSION, project_id, Date.now()],
      )
    } else if (existing.project_id !== project_id) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
      throw new NotesSidecarMismatchError(
        `notes.db at ${dbPath} was initialised for project_id='${existing.project_id}', not '${project_id}'`,
      )
    }
    const storeOpts: ConstructorParameters<typeof NotesStore>[0] = {
      db,
      project_id,
    }
    if (this.ulid !== undefined) storeOpts.ulid = this.ulid
    if (this.now !== undefined) storeOpts.now = this.now
    const store = new NotesStore(storeOpts)
    return { store, notes_db_path: dbPath }
  }
}
