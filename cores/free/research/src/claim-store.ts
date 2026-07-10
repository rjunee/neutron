/**
 * @neutronai/research-core — ResearchClaimStore.
 *
 * Owns the `research_claims` table inside the per-project sidecar. Each
 * row is a single fact-with-provenance triple produced by the synthesis
 * pipeline (substrate or sub-agent).
 *
 * Per docs/plans/research-core-tier1-brief.md § 3.5 + § 6.
 */

import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import { resolveNow } from '@neutronai/persistence/index.ts'

export type ResearchClaimConfidence =
  | 'low'
  | 'medium'
  | 'high'
  | 'unverified'

export const RESEARCH_CLAIM_CONFIDENCES: readonly ResearchClaimConfidence[] = [
  'low',
  'medium',
  'high',
  'unverified',
]

export interface ResearchClaim {
  id: string
  task_id: string
  claim: string
  evidence: string | null
  citation: string | null
  confidence: ResearchClaimConfidence
  created_at: number
}

export interface InsertClaimInput {
  task_id: string
  claim: string
  evidence?: string | null
  citation?: string | null
  confidence: ResearchClaimConfidence
}

export interface ResearchClaimStoreOptions {
  db: Database
  project_slug: string
  /** ULID/UUID factory override. */
  nextId?: () => string
  /** Clock override. */
  now?: () => number
}

interface ClaimColumns {
  id: string
  task_id: string
  project_slug: string
  claim: string
  evidence: string | null
  citation: string | null
  confidence: string
  created_at: number
}

function rowFromColumns(c: ClaimColumns): ResearchClaim {
  return {
    id: c.id,
    task_id: c.task_id,
    claim: c.claim,
    evidence: c.evidence,
    citation: c.citation,
    confidence: c.confidence as ResearchClaimConfidence,
    created_at: c.created_at,
  }
}

/**
 * Sidecar-backed persistence for claim rows. Every query scopes by
 * `project_slug`; cross-project lookups (claim_id belonging to another
 * project_slug under the same DB file) surface as `null` from `get`
 * with the same shape as a non-existent id (info-hiding).
 *
 * Single-writer per Database handle — Bun's SQLite is single-thread
 * per open handle so concurrent appends serialise cleanly through the
 * outer NotesStore-pattern locking that the resolver layers on.
 */
export class ResearchClaimStore {
  private readonly db: Database
  private readonly project_slug: string
  private readonly nextId: () => string
  private readonly now: () => number

  constructor(opts: ResearchClaimStoreOptions) {
    this.db = opts.db
    this.project_slug = opts.project_slug
    this.nextId = opts.nextId ?? ((): string => randomUUID())
    this.now = resolveNow(opts.now)
  }

  insertClaim(input: InsertClaimInput): ResearchClaim {
    const id = this.nextId()
    const ts = this.now()
    const evidence =
      input.evidence === undefined ? null : input.evidence
    const citation =
      input.citation === undefined ? null : input.citation
    this.db.run(
      `INSERT INTO research_claims
         (id, task_id, project_slug, claim, evidence, citation, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.task_id, this.project_slug, input.claim, evidence, citation, input.confidence, ts],
    )
    return {
      id,
      task_id: input.task_id,
      claim: input.claim,
      evidence,
      citation,
      confidence: input.confidence,
      created_at: ts,
    }
  }

  listForTask(task_id: string): ResearchClaim[] {
    const stmt = this.db.query<ClaimColumns, [string, string]>(
      `SELECT id, task_id, project_slug, claim, evidence, citation, confidence, created_at
         FROM research_claims
        WHERE task_id = ? AND project_slug = ?
        ORDER BY created_at ASC, id ASC`,
    )
    return stmt.all(task_id, this.project_slug).map(rowFromColumns)
  }

  cite(claim_id: string, citation: string): ResearchClaim | null {
    if (citation.trim().length === 0) {
      throw new Error('cite: citation must be a non-empty string')
    }
    this.db.run(
      `UPDATE research_claims
          SET citation = ?
        WHERE id = ? AND project_slug = ?`,
      [citation, claim_id, this.project_slug],
    )
    return this.getClaim(claim_id)
  }

  markUnverified(claim_id: string): ResearchClaim | null {
    this.db.run(
      `UPDATE research_claims
          SET confidence = 'unverified'
        WHERE id = ? AND project_slug = ?`,
      [claim_id, this.project_slug],
    )
    return this.getClaim(claim_id)
  }

  getClaim(claim_id: string): ResearchClaim | null {
    const stmt = this.db.query<ClaimColumns, [string, string]>(
      `SELECT id, task_id, project_slug, claim, evidence, citation, confidence, created_at
         FROM research_claims
        WHERE id = ? AND project_slug = ?`,
    )
    const row = stmt.get(claim_id, this.project_slug)
    if (row === null || row === undefined) return null
    return rowFromColumns(row)
  }

  countForTask(task_id: string): number {
    const stmt = this.db.query<{ c: number }, [string, string]>(
      `SELECT COUNT(1) AS c FROM research_claims
        WHERE task_id = ? AND project_slug = ?`,
    )
    const row = stmt.get(task_id, this.project_slug)
    return row?.c ?? 0
  }
}
