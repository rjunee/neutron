/**
 * @neutronai/codegen-core — per-project SQLite sidecar at
 * `<OWNER_HOME>/Projects/<project_id>/code-gen/code-gen.db`.
 *
 * Mirrors the sibling free-Core store-resolver + store shape:
 * lazy-open + lazy-migrate per project, one Database handle per
 * project cached for the gateway lifetime, init-promise dedup so two
 * concurrent first-writes wait on the same init.
 *
 * Per docs/plans/code-gen-core-tier1-brief.md § 6.
 */

import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyProjectScopedMigrations } from '@neutronai/migrations/runner.ts'
import { mapRow, mapRows, openSidecar, parseJsonColumn, resolveNow } from '@neutronai/persistence/index.ts'

import {
  PROJECT_SIDECAR_DB_FILENAME,
  PROJECT_SIDECAR_DIRNAME,
} from '../manifest.ts'
import type { CodegenSettings, CodegenTaskRow, CodegenTaskStatus } from '../backend.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Default location of the per-project Code-Gen migration tree. The
 * resolver looks here at init time; tests can override via the
 * constructor option.
 */
export const DEFAULT_MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations')

/** Schema version stamped into `code_gen_meta.schema_version`. */
export const CODE_GEN_SCHEMA_VERSION = 2 as const

/**
 * Defence-in-depth against a sidecar getting copied between project
 * dirs. If a stored `code_gen_meta.project_id` doesn't match the
 * caller's expected `project_id` at open time, the resolver throws.
 */
export class CodegenSidecarMismatchError extends Error {
  readonly code = 'codegen_sidecar_mismatch' as const
  constructor(message: string) {
    super(message)
    this.name = 'CodegenSidecarMismatchError'
  }
}

export interface CodegenSidecarOptions {
  /** Override the ULID factory used for primary keys. */
  ulid?: () => string
  /** Override the clock (used for `*_at` columns). */
  now?: () => number
}

/**
 * Project-scoped CRUD over the per-project sidecar. Constructed by the
 * resolver after migrations apply + `code_gen_meta` bootstraps.
 */
export class CodegenSidecar {
  readonly project_id: string
  readonly db_path: string
  private readonly db: Database
  private readonly mintId: () => string
  private readonly now: () => number

  constructor(opts: {
    db: Database
    db_path: string
    project_id: string
    ulid?: () => string
    now?: () => number
  }) {
    this.db = opts.db
    this.db_path = opts.db_path
    this.project_id = opts.project_id
    this.mintId = opts.ulid ?? defaultMintId
    this.now = resolveNow(opts.now)
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }

  /* -------------------- code_tasks ------------------------- */

  tasks = {
    insert: (input: {
      task_id: string
      request: string
      status: CodegenTaskStatus
      runner_kind?: CodegenTaskRow['runner_kind']
      subagent_run_id?: string
    }): CodegenTaskRow => {
      const now = this.now()
      const runner_kind = input.runner_kind ?? 'runtime'
      this.db.run(
        `INSERT INTO code_tasks (id, project_id, request_json, status, runner_kind, subagent_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.task_id,
          this.project_id,
          JSON.stringify({ task: input.request }),
          input.status,
          runner_kind,
          input.subagent_run_id ?? null,
          now,
          now,
        ],
      )
      const row = this.tasks.get(input.task_id)
      if (row === null) {
        throw new Error(`codegen sidecar: insert failed for ${input.task_id}`)
      }
      return row
    },
    update: (
      task_id: string,
      patch: Partial<{
        status: CodegenTaskStatus
        branch: string | null
        pr_number: number | null
        worktree: string | null
        summary: string | null
        error_code: string | null
        error_message: string | null
        subagent_run_id: string | null
      }>,
    ): CodegenTaskRow | null => {
      const fields: string[] = []
      const values: Array<string | number | null> = []
      for (const k of Object.keys(patch) as Array<keyof typeof patch>) {
        fields.push(`${k} = ?`)
        const v = patch[k]
        values.push(v as string | number | null)
      }
      if (fields.length === 0) return this.tasks.get(task_id)
      fields.push('updated_at = ?')
      values.push(this.now())
      values.push(task_id)
      this.db.run(
        `UPDATE code_tasks SET ${fields.join(', ')} WHERE id = ?`,
        values,
      )
      return this.tasks.get(task_id)
    },
    get: (task_id: string): CodegenTaskRow | null => {
      const raw = this.db
        .query<RawCodeTaskRow, [string]>(
          `SELECT id, project_id, request_json, status, runner_kind, branch, pr_number,
                  worktree, summary, error_code, error_message, created_at, updated_at
           FROM code_tasks WHERE id = ?`,
        )
        .get(task_id)
      return mapRow(raw, decodeTaskRow)
    },
    list: (input: { limit?: number } = {}): CodegenTaskRow[] => {
      const limit = Math.max(1, Math.min(input.limit ?? 10, 100))
      const rows = this.db
        .query<RawCodeTaskRow, [string, number]>(
          `SELECT id, project_id, request_json, status, runner_kind, branch, pr_number,
                  worktree, summary, error_code, error_message, created_at, updated_at
           FROM code_tasks WHERE project_id = ?
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(this.project_id, limit)
      return mapRows(rows, decodeTaskRow)
    },
    findByPr: (pr_number: number): CodegenTaskRow | null => {
      const raw = this.db
        .query<RawCodeTaskRow, [string, number]>(
          `SELECT id, project_id, request_json, status, runner_kind, branch, pr_number,
                  worktree, summary, error_code, error_message, created_at, updated_at
           FROM code_tasks WHERE project_id = ? AND pr_number = ?
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(this.project_id, pr_number)
      return mapRow(raw, decodeTaskRow)
    },
  }

  /* -------------------- code_settings ---------------------- */

  settings = {
    get: (): CodegenSettings => {
      const raw = this.db
        .query<RawSettingsRow, [string]>(
          `SELECT project_id, default_branch, repo_slug, gh_owner,
                  max_argus_rounds, subagent_timeout_ms, updated_at
           FROM code_settings WHERE project_id = ?`,
        )
        .get(this.project_id)
      if (raw !== null) return decodeSettings(raw)
      // Bootstrap a default row if missing.
      const now = this.now()
      this.db.run(
        `INSERT INTO code_settings (project_id, default_branch,
           repo_slug, gh_owner, max_argus_rounds, subagent_timeout_ms, updated_at)
         VALUES (?, 'main', NULL, NULL, 8, 1800000, ?)`,
        [this.project_id, now],
      )
      const r = this.db
        .query<RawSettingsRow, [string]>(
          `SELECT project_id, default_branch, repo_slug, gh_owner,
                  max_argus_rounds, subagent_timeout_ms, updated_at
           FROM code_settings WHERE project_id = ?`,
        )
        .get(this.project_id)
      if (r === null) {
        throw new Error('codegen sidecar: settings bootstrap insert failed')
      }
      return decodeSettings(r)
    },
    update: (patch: {
      default_branch?: string
      repo_slug?: string | null
      gh_owner?: string | null
      max_argus_rounds?: number
      subagent_timeout_ms?: number
    }): CodegenSettings => {
      this.settings.get()
      const fields: string[] = []
      const values: Array<string | number | null> = []
      for (const k of Object.keys(patch) as Array<keyof typeof patch>) {
        fields.push(`${k} = ?`)
        const v = patch[k]
        values.push(v === undefined ? null : (v as string | number | null))
      }
      if (fields.length === 0) return this.settings.get()
      fields.push('updated_at = ?')
      values.push(this.now())
      values.push(this.project_id)
      this.db.run(
        `UPDATE code_settings SET ${fields.join(', ')} WHERE project_id = ?`,
        values,
      )
      return this.settings.get()
    },
  }

  /* -------------------- code_subagent_transcripts ---------- */

  transcripts = {
    append: (input: {
      task_id: string | null
      role: 'forge' | 'argus' | 'forge_fix' | 'judge' | 'breaks_analysis'
      round?: number
      prompt_hash: string
      response_excerpt?: string
      model: string
      fired_at?: number
      completed_at?: number
      outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out'
      subagent_run_id?: string
    }): string => {
      const id = this.mintId()
      const fired_at = input.fired_at ?? this.now()
      this.db.run(
        `INSERT INTO code_subagent_transcripts (id, task_id, role, round, prompt_hash,
            response_excerpt, model, fired_at, completed_at, outcome, subagent_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.task_id,
          input.role,
          input.round ?? 1,
          input.prompt_hash,
          input.response_excerpt ?? null,
          input.model,
          fired_at,
          input.completed_at ?? null,
          input.outcome,
          input.subagent_run_id ?? null,
        ],
      )
      return id
    },
    listForTask: (task_id: string): RawTranscriptRow[] => {
      return this.db
        .query<RawTranscriptRow, [string]>(
          `SELECT id, task_id, role, round, prompt_hash, response_excerpt, model,
                  fired_at, completed_at, outcome, subagent_run_id
           FROM code_subagent_transcripts WHERE task_id = ? ORDER BY fired_at DESC`,
        )
        .all(task_id)
    },
  }

  /* -------------------- code_merge_audit ------------------- */

  audit = {
    append: (input: {
      task_id: string | null
      pr_number: number
      merge_strategy?: 'squash' | 'merge' | 'rebase'
      who_confirmed: 'user_confirm_token' | 'automerge_gate' | 'mcp_tool_confirm' | 'autonomous'
      gh_response_excerpt?: string
    }): string => {
      const id = this.mintId()
      this.db.run(
        `INSERT INTO code_merge_audit (id, task_id, pr_number, merge_strategy, merged_at,
            who_confirmed, gh_response_excerpt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.task_id,
          input.pr_number,
          input.merge_strategy ?? 'squash',
          this.now(),
          input.who_confirmed,
          input.gh_response_excerpt ?? null,
        ],
      )
      return id
    },
    countForPr: (pr_number: number): number => {
      const row = this.db
        .query<{ n: number }, [number]>(
          `SELECT COUNT(*) AS n FROM code_merge_audit WHERE pr_number = ?`,
        )
        .get(pr_number)
      return row === null ? 0 : row.n
    },
  }
}

/* ===================== resolver ============================ */

export interface CodegenSidecarResolverOptions {
  owner_home: string
  resolveProjectRoot?: (project_id: string) => string
  migrations_dir?: string
  ulid?: () => string
  now?: () => number
}

interface ProjectHandle {
  sidecar: CodegenSidecar
  db_path: string
}

/**
 * Lazy-init per-project sidecar handles. One Database per project,
 * cached for the gateway lifetime, init-promise dedup so two concurrent
 * first-writes wait on the same init.
 */
export class CodegenSidecarResolver {
  private readonly owner_home: string
  private readonly resolveProjectRoot: (project_id: string) => string
  private readonly migrations_dir: string
  private readonly ulid: (() => string) | undefined
  private readonly now: (() => number) | undefined
  private readonly handles = new Map<string, ProjectHandle>()
  private readonly initPromises = new Map<string, Promise<ProjectHandle>>()

  constructor(opts: CodegenSidecarResolverOptions) {
    this.owner_home = opts.owner_home
    this.resolveProjectRoot =
      opts.resolveProjectRoot ??
      ((project_id) => join(opts.owner_home, 'Projects', project_id))
    this.migrations_dir = opts.migrations_dir ?? DEFAULT_MIGRATIONS_DIR
    this.ulid = opts.ulid
    this.now = opts.now
  }

  pathFor(project_id: string): string {
    return join(
      this.resolveProjectRoot(project_id),
      PROJECT_SIDECAR_DIRNAME,
      PROJECT_SIDECAR_DB_FILENAME,
    )
  }

  closeAll(): void {
    for (const handle of this.handles.values()) handle.sidecar.close()
    this.handles.clear()
    this.initPromises.clear()
  }

  async resolve(project_id: string): Promise<CodegenSidecar> {
    const handle = await this.openHandle(project_id)
    return handle.sidecar
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
    const sidecarDir = join(projectRoot, PROJECT_SIDECAR_DIRNAME)
    if (!existsSync(sidecarDir)) {
      mkdirSync(sidecarDir, { recursive: true, mode: 0o700 })
    }
    const dbPath = join(sidecarDir, PROJECT_SIDECAR_DB_FILENAME)
    // P3 shared open — previously foreign_keys only; now additionally gains
    // WAL/synchronous/busy_timeout/temp_store/cache_size (strictly more
    // tolerant under contention, no semantic change).
    const db = openSidecar(dbPath)
    applyProjectScopedMigrations(db, this.migrations_dir)
    // After migrations, code_gen_meta exists. Bootstrap if missing;
    // verify project_id matches if present.
    const existing = db
      .query<{ project_id: string; schema_version: number }, []>(
        `SELECT project_id, schema_version FROM code_gen_meta LIMIT 1`,
      )
      .get()
    if (existing === null) {
      db.run(
        `INSERT INTO code_gen_meta (schema_version, project_id, initialised_at) VALUES (?, ?, ?)`,
        [CODE_GEN_SCHEMA_VERSION, project_id, Date.now()],
      )
    } else if (existing.project_id !== project_id) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
      throw new CodegenSidecarMismatchError(
        `code-gen.db at ${dbPath} was initialised for project_id='${existing.project_id}', not '${project_id}'`,
      )
    }
    const opts: ConstructorParameters<typeof CodegenSidecar>[0] = {
      db,
      db_path: dbPath,
      project_id,
    }
    if (this.ulid !== undefined) opts.ulid = this.ulid
    if (this.now !== undefined) opts.now = this.now
    const sidecar = new CodegenSidecar(opts)
    return { sidecar, db_path: dbPath }
  }
}

/* ===================== internal helpers ==================== */

interface RawCodeTaskRow {
  id: string
  project_id: string
  request_json: string
  status: CodegenTaskStatus
  runner_kind: CodegenTaskRow['runner_kind']
  branch: string | null
  pr_number: number | null
  worktree: string | null
  summary: string | null
  error_code: string | null
  error_message: string | null
  created_at: number
  updated_at: number
}

function decodeTaskRow(raw: RawCodeTaskRow): CodegenTaskRow {
  // Corrupt-JSON policy (explicit, historical): raw — a request_json column
  // that doesn't parse (pre-JSON rows stored the bare task string) surfaces
  // as the raw column text.
  const parsed = parseJsonColumn(raw.request_json, { onCorrupt: 'raw' })
  const task =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { task?: unknown }).task
      : undefined
  const request = typeof task === 'string' ? task : raw.request_json
  return {
    task_id: raw.id,
    project_id: raw.project_id,
    request,
    status: raw.status,
    runner_kind: raw.runner_kind,
    branch: raw.branch,
    pr_number: raw.pr_number,
    worktree: raw.worktree,
    summary: raw.summary,
    error_code: raw.error_code,
    error_message: raw.error_message,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  }
}

interface RawSettingsRow {
  project_id: string
  default_branch: string
  repo_slug: string | null
  gh_owner: string | null
  max_argus_rounds: number
  subagent_timeout_ms: number
  updated_at: number
}

function decodeSettings(raw: RawSettingsRow): CodegenSettings {
  return {
    project_id: raw.project_id,
    default_branch: raw.default_branch,
    repo_slug: raw.repo_slug,
    gh_owner: raw.gh_owner,
    max_argus_rounds: raw.max_argus_rounds,
    subagent_timeout_ms: raw.subagent_timeout_ms,
    updated_at: raw.updated_at,
  }
}

interface RawTranscriptRow {
  id: string
  task_id: string | null
  role: string
  round: number
  prompt_hash: string
  response_excerpt: string | null
  model: string
  fired_at: number
  completed_at: number | null
  outcome: string
  subagent_run_id: string | null
}

function defaultMintId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `csg-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}
