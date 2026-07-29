/**
 * @neutronai/research-core — per-project ResearchProjectStore.
 *
 * S1 promotion of the legacy `ResearchStore` (instance-scoped sidecar at
 * `<dataDir>/cores/research_core.db`) to a per-project sidecar at
 * `<OWNER_HOME>/Projects/<project_id>/research/research.db`.
 *
 * The legacy `ResearchStore` from `./backend.ts` stays in tree for
 * backward-compat with installs that haven't taken the S1 schema (and
 * for the `applyResearchSchema` install-lifecycle path which still
 * provisions the legacy single-table form when the per-project
 * resolver isn't wired). This module owns the EXTENDED schema with
 * project_id, claim_count, key_findings_flat, recommendations_flat,
 * confidence_level, topic + the FTS5 mirror.
 *
 * Per docs/plans/research-core-tier1-brief.md § 6.
 */

import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import { mapRow, mapRows, parseJsonColumn, resolveNow } from '@neutronai/persistence/index.ts'

import {
  validateResearchBrief,
  type ResearchBrief,
  type ResearchDepth,
  type ResearchStatus,
} from './backend.ts'

export interface ResearchProjectTaskRow {
  id: string
  project_slug: string
  project_id: string
  query: string
  depth: ResearchDepth
  sources: string[]
  status: ResearchStatus
  brief: ResearchBrief | null
  topic: string | null
  key_findings_flat: string | null
  recommendations_flat: string | null
  confidence_level: 'low' | 'medium' | 'high' | null
  claim_count: number
  error: string | null
  attempt_count: number
  created_at: number
  updated_at: number
  completed_at: number | null
}

interface TaskColumns {
  id: string
  project_slug: string
  project_id: string
  query: string
  depth: string
  sources_json: string
  status: string
  brief_json: string | null
  topic: string | null
  key_findings_flat: string | null
  recommendations_flat: string | null
  confidence_level: string | null
  claim_count: number
  error: string | null
  attempt_count: number
  created_at: number
  updated_at: number
  completed_at: number | null
}

function rowFromColumns(c: TaskColumns): ResearchProjectTaskRow {
  // Corrupt-JSON policy (explicit, historical): throw — corrupt sources_json
  // / brief_json propagates the SyntaxError to the caller.
  const sourcesRaw: unknown = parseJsonColumn(c.sources_json, { onCorrupt: 'throw' })
  const sources = Array.isArray(sourcesRaw)
    ? (sourcesRaw.filter((v) => typeof v === 'string') as string[])
    : []
  let brief: ResearchBrief | null = null
  if (c.brief_json !== null) {
    const parsed: unknown = parseJsonColumn(c.brief_json, { onCorrupt: 'throw' })
    const validated = validateResearchBrief(parsed)
    brief = validated.ok ? validated.brief : null
  }
  return {
    id: c.id,
    project_slug: c.project_slug,
    project_id: c.project_id,
    query: c.query,
    depth: c.depth as ResearchDepth,
    sources,
    status: c.status as ResearchStatus,
    brief,
    topic: c.topic,
    key_findings_flat: c.key_findings_flat,
    recommendations_flat: c.recommendations_flat,
    confidence_level:
      c.confidence_level === null
        ? null
        : (c.confidence_level as 'low' | 'medium' | 'high'),
    claim_count: c.claim_count,
    error: c.error,
    attempt_count: c.attempt_count,
    created_at: c.created_at,
    updated_at: c.updated_at,
    completed_at: c.completed_at,
  }
}

export interface ResearchProjectStoreOptions {
  db: Database
  project_slug: string
  project_id: string
  nextId?: () => string
  now?: () => number
}

export class ResearchProjectStore {
  private readonly db: Database
  private readonly project_slug: string
  private readonly project_id: string
  private readonly nextId: () => string
  private readonly now: () => number

  constructor(opts: ResearchProjectStoreOptions) {
    this.db = opts.db
    this.project_slug = opts.project_slug
    this.project_id = opts.project_id
    this.nextId = opts.nextId ?? ((): string => randomUUID())
    this.now = resolveNow(opts.now)
  }

  get ownerSlug(): string {
    return this.project_slug
  }

  get projectId(): string {
    return this.project_id
  }

  database(): Database {
    return this.db
  }

  insertPending(input: {
    query: string
    depth: ResearchDepth
    sources: readonly string[]
  }): ResearchProjectTaskRow {
    const id = this.nextId()
    const ts = this.now()
    const sources_json = JSON.stringify([...input.sources])
    this.db.run(
      `INSERT INTO research_tasks
         (id, project_slug, project_id, query, depth, sources_json, status,
          brief_json, topic, key_findings_flat, recommendations_flat,
          confidence_level, claim_count, error,
          attempt_count, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, 0, NULL, 0, ?, ?, NULL)`,
      [id, this.project_slug, this.project_id, input.query, input.depth, sources_json, ts, ts],
    )
    return {
      id,
      project_slug: this.project_slug,
      project_id: this.project_id,
      query: input.query,
      depth: input.depth,
      sources: [...input.sources],
      status: 'pending',
      brief: null,
      topic: null,
      key_findings_flat: null,
      recommendations_flat: null,
      confidence_level: null,
      claim_count: 0,
      error: null,
      attempt_count: 0,
      created_at: ts,
      updated_at: ts,
      completed_at: null,
    }
  }

  setRunning(task_id: string): void {
    const ts = this.now()
    this.db.run(
      `UPDATE research_tasks
          SET status = 'running', updated_at = ?
        WHERE id = ? AND project_slug = ? AND project_id = ?`,
      [ts, task_id, this.project_slug, this.project_id],
    )
  }

  bumpAttempt(task_id: string): void {
    const ts = this.now()
    this.db.run(
      `UPDATE research_tasks
          SET attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND project_slug = ? AND project_id = ?`,
      [ts, task_id, this.project_slug, this.project_id],
    )
  }

  setCompleted(
    task_id: string,
    brief: ResearchBrief,
    claim_count: number,
  ): void {
    const ts = this.now()
    const brief_json = JSON.stringify(brief)
    const key_findings_flat = brief.key_findings.join('\n')
    const recommendations_flat = brief.recommendations.join('\n')
    this.db.run(
      `UPDATE research_tasks
          SET status = 'completed',
              brief_json = ?,
              topic = ?,
              key_findings_flat = ?,
              recommendations_flat = ?,
              confidence_level = ?,
              claim_count = ?,
              error = NULL,
              updated_at = ?,
              completed_at = ?
        WHERE id = ? AND project_slug = ? AND project_id = ?`,
      [
        brief_json,
        brief.topic,
        key_findings_flat,
        recommendations_flat,
        brief.confidence_level,
        claim_count,
        ts,
        ts,
        task_id,
        this.project_slug,
        this.project_id,
      ],
    )
    // Mirror into FTS5 for `/research find <q>`.
    this.db.run(`DELETE FROM research_briefs_fts WHERE task_id = ?`, [task_id])
    this.db.run(
      `INSERT INTO research_briefs_fts
         (task_id, topic, key_findings_flat, recommendations_flat)
       VALUES (?, ?, ?, ?)`,
      [task_id, brief.topic, key_findings_flat, recommendations_flat],
    )
  }

  setFailed(task_id: string, error: string): void {
    const ts = this.now()
    this.db.run(
      `UPDATE research_tasks
          SET status = 'failed', error = ?,
              updated_at = ?, completed_at = ?
        WHERE id = ? AND project_slug = ? AND project_id = ?`,
      [error, ts, ts, task_id, this.project_slug, this.project_id],
    )
  }

  get(task_id: string): ResearchProjectTaskRow | null {
    const stmt = this.db.query<TaskColumns, [string, string, string]>(
      `SELECT id, project_slug, project_id, query, depth, sources_json, status,
              brief_json, topic, key_findings_flat, recommendations_flat,
              confidence_level, claim_count, error, attempt_count,
              created_at, updated_at, completed_at
         FROM research_tasks
        WHERE id = ? AND project_slug = ? AND project_id = ?`,
    )
    const row = stmt.get(task_id, this.project_slug, this.project_id)
    // `?? null`: keep the historical defensive undefined-miss handling.
    return mapRow(row ?? null, rowFromColumns)
  }

  list(opts: { limit?: number; since?: number }): ResearchProjectTaskRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200)
    if (opts.since !== undefined) {
      const stmt = this.db.query<TaskColumns, [string, string, number, number]>(
        `SELECT id, project_slug, project_id, query, depth, sources_json, status,
                brief_json, topic, key_findings_flat, recommendations_flat,
                confidence_level, claim_count, error, attempt_count,
                created_at, updated_at, completed_at
           FROM research_tasks
          WHERE project_slug = ? AND project_id = ? AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      return mapRows(
        stmt.all(this.project_slug, this.project_id, opts.since, limit),
        rowFromColumns,
      )
    }
    const stmt = this.db.query<TaskColumns, [string, string, number]>(
      `SELECT id, project_slug, project_id, query, depth, sources_json, status,
              brief_json, topic, key_findings_flat, recommendations_flat,
              confidence_level, claim_count, error, attempt_count,
              created_at, updated_at, completed_at
         FROM research_tasks
        WHERE project_slug = ? AND project_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    return mapRows(stmt.all(this.project_slug, this.project_id, limit), rowFromColumns)
  }

  recordSubAgentRun(input: {
    task_id: string
    model: string
    budget_ms: number
    elapsed_ms: number
    tool_call_count: number
    outcome: 'ok' | 'timeout' | 'error' | 'concurrency_rejected'
    error?: string | null
  }): void {
    const ts = this.now()
    this.db.run(
      `INSERT INTO research_sub_agent_runs
         (id, task_id, project_slug, model, budget_ms, elapsed_ms,
          tool_call_count, outcome, error, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.nextId(),
        input.task_id,
        this.project_slug,
        input.model,
        input.budget_ms,
        input.elapsed_ms,
        input.tool_call_count,
        input.outcome,
        input.error ?? null,
        ts,
        ts,
      ],
    )
  }
}
