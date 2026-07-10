/**
 * @neutronai/skill-forge — proposals store.
 *
 * CRUD over `skill_forge_proposals` (migration 0086). Single source of truth
 * for the propose-then-approve gate: which workflows have been proposed, their
 * status, and — once approved — the path of the registered skill. The row
 * persists across gateway restarts, so an approved skill's provenance survives
 * a fresh session.
 */

import { randomUUID } from 'node:crypto'

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type {
  CompletedWorkflow,
  ProposalRecord,
  ProposalStatus,
} from './types.ts'

export interface CreateProposalInput {
  workflow_signature: string
  project_slug: string
  topic_id?: string | null
  proposed_name: string
  triggers: string[]
  what_it_does: string
  artifacts: string[]
  workflow: CompletedWorkflow
}

interface ProposalRow {
  id: string
  workflow_signature: string
  project_slug: string
  topic_id: string | null
  proposed_name: string
  triggers_json: string
  what_it_does: string
  artifacts_json: string
  workflow_json: string
  status: string
  skill_path: string | null
  created_at: number
  decided_at: number | null
}

const COLUMNS = `id, workflow_signature, project_slug, topic_id, proposed_name,
  triggers_json, what_it_does, artifacts_json, workflow_json, status,
  skill_path, created_at, decided_at`

export class SkillForgeProposalsStore {
  private readonly db: ProjectDb
  private readonly now: () => number

  constructor(opts: { db: ProjectDb; now?: () => number }) {
    this.db = opts.db
    this.now = opts.now ?? (() => Date.now())
  }

  /** Insert a new pending proposal. Returns the decoded record. */
  async create(input: CreateProposalInput): Promise<ProposalRecord> {
    const id = randomUUID()
    const ts = this.now()
    await this.db.run(
      `INSERT INTO skill_forge_proposals
         (id, workflow_signature, project_slug, topic_id, proposed_name,
          triggers_json, what_it_does, artifacts_json, workflow_json, status,
          skill_path, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
      [
        id,
        input.workflow_signature,
        input.project_slug,
        input.topic_id ?? null,
        input.proposed_name,
        JSON.stringify(input.triggers),
        input.what_it_does,
        JSON.stringify(input.artifacts),
        JSON.stringify(input.workflow),
        ts,
      ],
    )
    const got = await this.get(id)
    if (got === null) {
      throw new Error(`skill_forge_proposals.create: post-insert read returned null for id=${id}`)
    }
    return got
  }

  async get(id: string): Promise<ProposalRecord | null> {
    const row = this.db
      .get<ProposalRow, [string]>(
        `SELECT ${COLUMNS} FROM skill_forge_proposals WHERE id = ?`,
        [id],
      )
    return row === null ? null : rowToRecord(row)
  }

  /**
   * The most recent non-declined proposal for a signature, if any. Used to
   * dedupe: a workflow is re-proposed only when no pending/approved proposal
   * for the same signature already exists.
   */
  async getActiveBySignature(signature: string): Promise<ProposalRecord | null> {
    const row = this.db
      .get<ProposalRow, [string]>(
        `SELECT ${COLUMNS} FROM skill_forge_proposals
          WHERE workflow_signature = ? AND status IN ('pending', 'approved')
          ORDER BY created_at DESC
          LIMIT 1`,
        [signature],
      )
    return row === null ? null : rowToRecord(row)
  }

  async listPending(): Promise<ProposalRecord[]> {
    const rows = this.db
      .all<ProposalRow, []>(
        `SELECT ${COLUMNS} FROM skill_forge_proposals
          WHERE status = 'pending' ORDER BY created_at ASC`,
      )
    return rows.map(rowToRecord)
  }

  /** Mark a pending proposal approved and record the registered skill path. */
  async markApproved(id: string, skillPath: string): Promise<ProposalRecord> {
    return this.decide(id, 'approved', skillPath)
  }

  /** Mark a pending proposal declined. No skill path. */
  async markDeclined(id: string): Promise<ProposalRecord> {
    return this.decide(id, 'declined', null)
  }

  private async decide(
    id: string,
    status: ProposalStatus,
    skillPath: string | null,
  ): Promise<ProposalRecord> {
    await this.db.run(
      `UPDATE skill_forge_proposals
          SET status = ?, skill_path = ?, decided_at = ?
        WHERE id = ? AND status = 'pending'`,
      [status, skillPath, this.now(), id],
    )
    const got = await this.get(id)
    if (got === null) {
      throw new Error(`skill_forge_proposals.decide: id=${id} not found`)
    }
    if (got.status !== status) {
      throw new Error(
        `skill_forge_proposals.decide: id=${id} was not pending (status=${got.status})`,
      )
    }
    return got
  }
}

function rowToRecord(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    workflow_signature: row.workflow_signature,
    project_slug: row.project_slug,
    topic_id: row.topic_id,
    proposed_name: row.proposed_name,
    triggers: JSON.parse(row.triggers_json) as string[],
    what_it_does: row.what_it_does,
    artifacts: JSON.parse(row.artifacts_json) as string[],
    workflow: JSON.parse(row.workflow_json) as CompletedWorkflow,
    status: row.status as ProposalStatus,
    skill_path: row.skill_path,
    created_at: row.created_at,
    decided_at: row.decided_at,
  }
}
