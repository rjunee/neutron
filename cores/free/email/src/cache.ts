/**
 * @neutronai/email-managed-core — per-project SQLite sidecar resolver
 * + typed CRUD helpers.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 6. Opens
 * `<OWNER_HOME>/Projects/<project_id>/email/email-cache.db`, applies
 * migration `0001_email_cache.sql`, returns a typed
 * `EmailProjectCache` handle.
 *
 * The Gmail API is the source of truth. This cache holds:
 *   - triage_cache              — audit log of every triage fire
 *   - summary_cache             — TTL'd prose-brief cache
 *   - draft_audit               — audit log of every draft + labels
 *   - email_project_label_cache — project_id → gmail_label_id
 *   - email_meta                — schema_version + project_id sentinel
 */

import type { Database } from 'bun:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ProjectSidecarResolver,
  type ProjectSidecarResolverOptions,
} from '@neutronai/cores-runtime'
import { applyProjectScopedMigrations } from '@neutronai/migrations/runner.ts'
import { openSidecar, parseJsonColumn, resolveNow } from '@neutronai/persistence/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Default per-project sidecar dir name. No leading dot — `email/` is
 *  user-visible content the P7 file explorer should list under the
 *  project tree (mirrors Notes Core's `notes/`). */
export const EMAIL_SIDECAR_DIR = 'email'
export const EMAIL_SIDECAR_DB = 'email-cache.db'
export const EMAIL_SCHEMA_VERSION = 1

/** Default summary-cache TTL — 24h. */
export const SUMMARY_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export const DEFAULT_MIGRATIONS_DIR = join(HERE, '..', 'migrations')

export class EmailSidecarMismatchError extends Error {
  readonly code = 'email_sidecar_mismatch' as const
  constructor(message: string) {
    super(message)
    this.name = 'EmailSidecarMismatchError'
  }
}

export interface TriageCacheRow {
  id: number
  fired_at: number
  model: string
  outcome: 'ok' | 'llm_error'
  prompt_hash: string
  top5_json: string
  chat_message_id: string | null
}

export interface SummaryCacheRow {
  message_id: string
  template_hash: string
  brief_text: string
  model: string
  prompt_hash: string
  cached_at: number
}

export interface DraftAuditRow {
  id: number
  draft_id: string
  thread_id: string
  message_id: string
  project_id: string | null
  applied_labels: string[]
  created_at: number
  model: string | null
  outcome: 'ok' | 'labeling_failed'
  prompt_hash: string | null
  response_excerpt: string | null
  chat_message_id: string | null
}

export interface ProjectLabelCacheRow {
  project_id: string
  gmail_label_id: string
  label_name: string
  created_at: number
}

export interface EmailProjectCacheOptions {
  db: Database
  project_id: string
  now?: () => number
}

export class EmailProjectCache {
  private readonly db: Database
  private readonly project_id: string
  private readonly now: () => number

  constructor(opts: EmailProjectCacheOptions) {
    this.db = opts.db
    this.project_id = opts.project_id
    this.now = resolveNow(opts.now)
  }

  upsertTriage(input: {
    fired_at: number
    model: string
    outcome: 'ok' | 'llm_error'
    prompt_hash: string
    top5_json: string
    chat_message_id?: string | null
  }): { id: number } {
    const stmt = this.db.prepare(
      `INSERT INTO triage_cache (fired_at, model, outcome, prompt_hash, top5_json, chat_message_id)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    const row = stmt.get(
      input.fired_at,
      input.model,
      input.outcome,
      input.prompt_hash,
      input.top5_json,
      input.chat_message_id ?? null,
    ) as { id: number } | null
    if (row === null) throw new Error('upsertTriage: no row returned')
    return row
  }

  listRecentTriage(limit: number = 10): TriageCacheRow[] {
    const rows = this.db
      .query<TriageCacheRow, [number]>(
        `SELECT id, fired_at, model, outcome, prompt_hash, top5_json, chat_message_id
         FROM triage_cache ORDER BY fired_at DESC LIMIT ?`,
      )
      .all(limit)
    return rows
  }

  upsertSummary(input: {
    message_id: string
    template_hash: string
    brief_text: string
    model: string
    prompt_hash: string
  }): void {
    this.db.run(
      `INSERT INTO summary_cache (message_id, template_hash, brief_text, model, prompt_hash, cached_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id, template_hash) DO UPDATE SET
         brief_text = excluded.brief_text,
         model = excluded.model,
         prompt_hash = excluded.prompt_hash,
         cached_at = excluded.cached_at`,
      [
        input.message_id,
        input.template_hash,
        input.brief_text,
        input.model,
        input.prompt_hash,
        this.now(),
      ],
    )
  }

  getSummary(input: {
    message_id: string
    template_hash: string
    ttl_ms?: number
  }): SummaryCacheRow | null {
    const ttl = input.ttl_ms ?? SUMMARY_CACHE_TTL_MS
    const row = this.db
      .query<SummaryCacheRow, [string, string]>(
        `SELECT message_id, template_hash, brief_text, model, prompt_hash, cached_at
         FROM summary_cache WHERE message_id = ? AND template_hash = ?`,
      )
      .get(input.message_id, input.template_hash)
    if (row === null) return null
    if (this.now() - row.cached_at > ttl) return null
    return row
  }

  recordDraftAudit(input: {
    draft_id: string
    thread_id: string
    message_id: string
    project_id?: string | null
    applied_labels: readonly string[]
    model?: string | null
    outcome: 'ok' | 'labeling_failed'
    prompt_hash?: string | null
    response_excerpt?: string | null
    chat_message_id?: string | null
  }): { id: number } {
    const stmt = this.db.prepare(
      `INSERT INTO draft_audit (draft_id, thread_id, message_id, project_id, applied_labels, created_at, model, outcome, prompt_hash, response_excerpt, chat_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    const row = stmt.get(
      input.draft_id,
      input.thread_id,
      input.message_id,
      input.project_id ?? null,
      JSON.stringify([...input.applied_labels]),
      this.now(),
      input.model ?? null,
      input.outcome,
      input.prompt_hash ?? null,
      input.response_excerpt ?? null,
      input.chat_message_id ?? null,
    ) as { id: number } | null
    if (row === null) throw new Error('recordDraftAudit: no row returned')
    return row
  }

  listDraftAudit(limit: number = 50): DraftAuditRow[] {
    const rows = this.db
      .query<
        Omit<DraftAuditRow, 'applied_labels'> & { applied_labels: string },
        [number]
      >(
        `SELECT id, draft_id, thread_id, message_id, project_id, applied_labels,
                created_at, model, outcome, prompt_hash, response_excerpt, chat_message_id
         FROM draft_audit ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit)
    return rows.map((r) => ({
      ...r,
      // Corrupt-JSON policy (explicit, historical): throw — a corrupt
      // applied_labels column propagates the SyntaxError to the caller.
      applied_labels: parseJsonColumn(r.applied_labels, { onCorrupt: 'throw' }) as string[],
    }))
  }

  getProjectLabelId(project_id: string): ProjectLabelCacheRow | null {
    return this.db
      .query<ProjectLabelCacheRow, [string]>(
        `SELECT project_id, gmail_label_id, label_name, created_at
         FROM email_project_label_cache WHERE project_id = ?`,
      )
      .get(project_id)
  }

  setProjectLabelId(input: {
    project_id: string
    gmail_label_id: string
    label_name: string
  }): void {
    this.db.run(
      `INSERT INTO email_project_label_cache (project_id, gmail_label_id, label_name, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET
         gmail_label_id = excluded.gmail_label_id,
         label_name = excluded.label_name`,
      [input.project_id, input.gmail_label_id, input.label_name, this.now()],
    )
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

export interface EmailProjectCacheResolverOptions {
  owner_home: string
  resolveProjectRoot?: (project_id: string) => string
  migrations_dir?: string
  now?: () => number
}

/**
 * Refactor X4: the lazy-init/cache/dedup mechanics + the path-traversal
 * guard now live in the shared `ProjectSidecarResolver` (this Core PREVIOUSLY
 * did a BARE `join()` on the tool-supplied `project_id` — it now rejects
 * `..`/NUL/absolute-path payloads exactly like the Research Core). This
 * class is a thin binding supplying the email-specific `buildHandle`.
 */
export class EmailProjectCacheResolver {
  private readonly migrations_dir: string
  private readonly now: (() => number) | undefined
  private readonly inner: ProjectSidecarResolver<EmailProjectCache>

  constructor(opts: EmailProjectCacheResolverOptions) {
    this.migrations_dir = opts.migrations_dir ?? DEFAULT_MIGRATIONS_DIR
    this.now = opts.now
    const innerOpts: ProjectSidecarResolverOptions<EmailProjectCache> = {
      owner_home: opts.owner_home,
      sidecar_dir: EMAIL_SIDECAR_DIR,
      db_filename: EMAIL_SIDECAR_DB,
      buildHandle: (init) => this.buildHandle(init),
      closeHandle: (cache) => cache.close(),
    }
    if (opts.resolveProjectRoot !== undefined) {
      innerOpts.resolveProjectRoot = opts.resolveProjectRoot
    }
    this.inner = new ProjectSidecarResolver(innerOpts)
  }

  pathFor(project_id: string): string {
    return this.inner.pathFor(project_id)
  }

  closeAll(): void {
    this.inner.closeAll()
  }

  async resolve(project_id: string): Promise<EmailProjectCache> {
    return this.inner.resolve(project_id)
  }

  private async buildHandle(init: {
    project_id: string
    db_path: string
  }): Promise<EmailProjectCache> {
    const { project_id, db_path } = init
    // P3 shared open — previously foreign_keys only; now additionally gains
    // WAL/synchronous/busy_timeout/temp_store/cache_size (strictly more
    // tolerant under contention, no semantic change).
    const db = openSidecar(db_path)
    applyProjectScopedMigrations(db, this.migrations_dir)
    const existing = db
      .query<{ project_id: string; schema_version: number }, []>(
        `SELECT project_id, schema_version FROM email_meta LIMIT 1`,
      )
      .get()
    if (existing === null) {
      db.run(
        `INSERT INTO email_meta (schema_version, project_id, initialised_at) VALUES (?, ?, ?)`,
        [EMAIL_SCHEMA_VERSION, project_id, Date.now()],
      )
    } else if (existing.project_id !== project_id) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
      throw new EmailSidecarMismatchError(
        `email-cache.db at ${db_path} was initialised for project_id='${existing.project_id}', not '${project_id}'`,
      )
    }
    const cacheOpts: EmailProjectCacheOptions = { db, project_id }
    if (this.now !== undefined) cacheOpts.now = this.now
    return new EmailProjectCache(cacheOpts)
  }
}
