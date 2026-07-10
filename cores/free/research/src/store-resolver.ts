/**
 * @neutronai/research-core — per-project sidecar resolver.
 *
 * Resolves a `(project_slug, owner_home, project_id)` triple to a
 * `{store, claimStore, db}` handle over
 * `<owner_home>/Projects/<project_id>/research/research.db`,
 * applying the Research Core's own migration tree before construction.
 *
 * Refactor X4: the lazy-init/cache/dedup mechanics + the path-traversal
 * guard now live in the shared `ProjectSidecarResolver<H>` +
 * `safeResolveProjectRoot` (`@neutronai/cores-runtime`). This class is a
 * thin binding that supplies the Research-specific `buildHandle`
 * (migrations + `research_meta` bootstrap/mismatch + store construction).
 *
 * Per docs/plans/research-core-tier1-brief.md § 6.
 */

import type { Database } from 'bun:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CorePathTraversalError,
  ProjectSidecarResolver,
  type ProjectSidecarResolverOptions,
} from '@neutronai/cores-runtime'
import { applyProjectScopedMigrations } from '@neutronai/migrations/runner.ts'
import { openSidecar } from '@neutronai/persistence/index.ts'

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
 * Thrown when a caller-supplied `project_id` escapes the
 * `<owner_home>/Projects/` boundary. Refactor X4: the guard was hoisted into
 * the shared `@neutronai/cores-runtime` `safeResolveProjectRoot`, but this
 * subclass PRESERVES the Research Core's historical public error contract —
 * `name === 'ResearchPathTraversalError'` and `code === 'research_path_traversal'`
 * — while being `instanceof CorePathTraversalError`. Threaded into the shared
 * guard via `makeError` so the resolver still throws THIS class.
 */
export class ResearchPathTraversalError extends CorePathTraversalError {
  constructor(
    project_id: string,
    resolved_path: string,
    owner_projects_dir: string,
  ) {
    super(
      project_id,
      resolved_path,
      owner_projects_dir,
      'ResearchPathTraversalError',
      'research_path_traversal',
    )
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
  private readonly migrations_dir: string
  private readonly nextId: (() => string) | undefined
  private readonly now: (() => number) | undefined
  private readonly inner: ProjectSidecarResolver<ResearchProjectHandle>

  constructor(opts: ResearchStoreResolverOptions) {
    this.project_slug = opts.project_slug
    this.migrations_dir = opts.migrations_dir ?? DEFAULT_MIGRATIONS_DIR
    this.nextId = opts.nextId
    this.now = opts.now
    const innerOpts: ProjectSidecarResolverOptions<ResearchProjectHandle> = {
      owner_home: opts.owner_home,
      sidecar_dir: RESEARCH_SIDECAR_DIR,
      db_filename: RESEARCH_SIDECAR_DB,
      makeError: (project_id, resolved_path, boundary) =>
        new ResearchPathTraversalError(project_id, resolved_path, boundary),
      buildHandle: (init) => this.buildHandle(init),
      closeHandle: (handle) => handle.db.close(),
    }
    if (opts.resolveProjectRoot !== undefined) {
      innerOpts.resolveProjectRoot = opts.resolveProjectRoot
    }
    this.inner = new ProjectSidecarResolver(innerOpts)
  }

  pathFor(project_id: string): string {
    return this.inner.pathFor(project_id)
  }

  /** Path to the per-project markdown output dir. */
  outputDirFor(project_id: string): string {
    return this.inner.dirFor(project_id)
  }

  closeAll(): void {
    this.inner.closeAll()
  }

  async resolve(project_id: string): Promise<ResearchProjectHandle> {
    return this.inner.resolve(project_id)
  }

  private async buildHandle(init: {
    project_id: string
    db_path: string
  }): Promise<ResearchProjectHandle> {
    const { project_id, db_path } = init
    // P3 shared open — previously foreign_keys only; now additionally gains
    // WAL/synchronous/busy_timeout/temp_store/cache_size (strictly more
    // tolerant under contention, no semantic change).
    const db = openSidecar(db_path)
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
        `research.db at ${db_path} was initialised for ` +
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

    return { store, claimStore, db, research_db_path: db_path }
  }
}
