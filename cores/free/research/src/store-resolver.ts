/**
 * @neutronai/research-core — per-project sidecar resolver.
 *
 * Resolves a `(project_slug, owner_home, project_id)` triple to a
 * `{store, claimStore, db}` handle over
 * `<owner_home>/Projects/<project_id>/research/research.db`,
 * applying the Research Core's own migration tree before construction.
 *
 * Mirrors the sibling free-Core store-resolver pattern in
 * mechanics: init-promise dedup so concurrent first-resolves wait on
 * the same init; one Database handle per project, cached for the
 * gateway lifetime.
 *
 * Per docs/plans/research-core-tier1-brief.md § 6.
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyProjectScopedMigrations } from '@neutronai/migrations/runner.ts'

import { ResearchClaimStore } from './claim-store.ts'
import { ResearchProjectStore } from './research-store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

export const RESEARCH_SIDECAR_DIR = 'research'
export const RESEARCH_SIDECAR_DB = 'research.db'
export const RESEARCH_SCHEMA_VERSION = 1

export const DEFAULT_MIGRATIONS_DIR = join(HERE, '..', 'migrations')

export class ResearchSidecarMismatchError extends Error {
  readonly code = 'research_sidecar_mismatch' as const
  constructor(message: string) {
    super(message)
    this.name = 'ResearchSidecarMismatchError'
  }
}

/**
 * Thrown when a caller-supplied `project_id` resolves to a filesystem
 * path outside the owner's `<owner_home>/Projects/` boundary. The
 * Research Core's MCP tool schemas + chat-command surface accept
 * `project_id` from external input — any value containing `..` (or an
 * absolute path) that escapes the instance boundary would let an
 * attacker read or write `research.db` and the rendered markdown
 * anywhere under (or above) `owner_home`. The resolver MUST throw
 * BEFORE any FS operation runs against the resolved path.
 */
export class ResearchPathTraversalError extends Error {
  readonly code = 'research_path_traversal' as const
  readonly project_id: string
  readonly resolved_path: string
  readonly owner_projects_dir: string
  constructor(
    project_id: string,
    resolved_path: string,
    owner_projects_dir: string,
  ) {
    super(
      `project_id ${JSON.stringify(project_id)} resolves to ${resolved_path}, ` +
        `which escapes the project boundary ${owner_projects_dir}`,
    )
    this.name = 'ResearchPathTraversalError'
    this.project_id = project_id
    this.resolved_path = resolved_path
    this.owner_projects_dir = owner_projects_dir
  }
}

export interface ResearchStoreResolverOptions {
  project_slug: string
  owner_home: string
  resolveProjectRoot?: (project_id: string) => string
  migrations_dir?: string
  nextId?: () => string
  now?: () => number
}

export interface ResearchProjectHandle {
  store: ResearchProjectStore
  claimStore: ResearchClaimStore
  db: Database
  research_db_path: string
}

export class ResearchStoreResolver {
  private readonly project_slug: string
  private readonly owner_home: string
  private readonly owner_projects_dir: string
  private readonly owner_projects_dir_prefix: string
  private readonly resolveProjectRoot: (project_id: string) => string
  private readonly migrations_dir: string
  private readonly nextId: (() => string) | undefined
  private readonly now: (() => number) | undefined
  private readonly handles = new Map<string, ResearchProjectHandle>()
  private readonly initPromises = new Map<string, Promise<ResearchProjectHandle>>()

  constructor(opts: ResearchStoreResolverOptions) {
    this.project_slug = opts.project_slug
    this.owner_home = opts.owner_home
    this.owner_projects_dir = resolvePath(opts.owner_home, 'Projects')
    // Guard against prefix-collision (`/home/Projects-evil/...` matching
    // `/home/Projects`). `startsWith(prefix + sep)` enforces a true
    // directory-boundary check; the bare-prefix equality case is
    // handled separately below.
    this.owner_projects_dir_prefix = this.owner_projects_dir + sep
    this.resolveProjectRoot =
      opts.resolveProjectRoot ??
      ((project_id) => join(opts.owner_home, 'Projects', project_id))
    this.migrations_dir = opts.migrations_dir ?? DEFAULT_MIGRATIONS_DIR
    this.nextId = opts.nextId
    this.now = opts.now
  }

  /**
   * Resolve `project_id` to its absolute project root AFTER asserting
   * the result stays inside `<owner_home>/Projects/`. Throws
   * `ResearchPathTraversalError` for any `project_id` that contains
   * traversal segments (`..`), embedded NUL bytes, absolute-path
   * separators, or otherwise escapes the instance boundary. Called by
   * `pathFor`, `outputDirFor`, and `doInit` so EVERY FS-touching path
   * is gated.
   */
  private safeResolveProjectRoot(project_id: string): string {
    if (typeof project_id !== 'string' || project_id.length === 0) {
      throw new ResearchPathTraversalError(
        String(project_id),
        '',
        this.owner_projects_dir,
      )
    }
    if (project_id.includes('\0')) {
      throw new ResearchPathTraversalError(
        project_id,
        '',
        this.owner_projects_dir,
      )
    }
    const projectRoot = this.resolveProjectRoot(project_id)
    const resolved = resolvePath(projectRoot)
    const insideBoundary =
      resolved === this.owner_projects_dir ||
      resolved.startsWith(this.owner_projects_dir_prefix)
    if (!insideBoundary || resolved === this.owner_projects_dir) {
      // Disallow the bare-prefix case too — `project_id` MUST resolve
      // to a strict subpath of `<owner_home>/Projects/`, never to the
      // Projects/ dir itself.
      throw new ResearchPathTraversalError(
        project_id,
        resolved,
        this.owner_projects_dir,
      )
    }
    return resolved
  }

  pathFor(project_id: string): string {
    return join(
      this.safeResolveProjectRoot(project_id),
      RESEARCH_SIDECAR_DIR,
      RESEARCH_SIDECAR_DB,
    )
  }

  /** Path to the per-project markdown output dir. */
  outputDirFor(project_id: string): string {
    return join(this.safeResolveProjectRoot(project_id), RESEARCH_SIDECAR_DIR)
  }

  closeAll(): void {
    for (const handle of this.handles.values()) {
      try {
        handle.db.close()
      } catch {
        /* ignore */
      }
    }
    this.handles.clear()
    this.initPromises.clear()
  }

  async resolve(project_id: string): Promise<ResearchProjectHandle> {
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

  private async doInit(project_id: string): Promise<ResearchProjectHandle> {
    const projectRoot = this.safeResolveProjectRoot(project_id)
    const researchDir = join(projectRoot, RESEARCH_SIDECAR_DIR)
    if (!existsSync(researchDir)) {
      mkdirSync(researchDir, { recursive: true, mode: 0o700 })
    }
    const dbPath = join(researchDir, RESEARCH_SIDECAR_DB)
    const db = new Database(dbPath, { create: true })
    db.exec('PRAGMA foreign_keys = ON')
    applyProjectScopedMigrations(db, this.migrations_dir)

    // After migrations, research_meta exists. Insert bootstrap row if
    // missing; verify (project_slug, project_id) match if present.
    const existing = db
      .query<
        { project_slug: string; project_id: string; schema_version: number },
        []
      >(
        `SELECT project_slug, project_id, schema_version FROM research_meta LIMIT 1`,
      )
      .get()
    if (existing === null) {
      db.run(
        `INSERT INTO research_meta
           (id, schema_version, project_slug, project_id, initialised_at)
         VALUES (1, ?, ?, ?, ?)`,
        [RESEARCH_SCHEMA_VERSION, this.project_slug, project_id, Date.now()],
      )
    } else if (
      existing.project_slug !== this.project_slug ||
      existing.project_id !== project_id
    ) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
      throw new ResearchSidecarMismatchError(
        `research.db at ${dbPath} was initialised for ` +
          `project_slug='${existing.project_slug}' project_id='${existing.project_id}', ` +
          `not project_slug='${this.project_slug}' project_id='${project_id}'`,
      )
    }

    const storeOpts: ConstructorParameters<typeof ResearchProjectStore>[0] = {
      db,
      project_slug: this.project_slug,
      project_id,
    }
    if (this.nextId !== undefined) storeOpts.nextId = this.nextId
    if (this.now !== undefined) storeOpts.now = this.now
    const store = new ResearchProjectStore(storeOpts)

    const claimOpts: ConstructorParameters<typeof ResearchClaimStore>[0] = {
      db,
      project_slug: this.project_slug,
    }
    if (this.nextId !== undefined) claimOpts.nextId = this.nextId
    if (this.now !== undefined) claimOpts.now = this.now
    const claimStore = new ResearchClaimStore(claimOpts)

    return { store, claimStore, db, research_db_path: dbPath }
  }
}
