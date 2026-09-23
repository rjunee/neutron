import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Placement, WorkerRole } from '@neutronai/runtime/bounded-work.ts'
import { projectAttemptUsage } from './phase-usage.ts'

export interface AttemptKey { run_id: string; step_id: string; attempt_id: string }
export interface AttemptIdentity extends AttemptKey {
  phase: string
  task_id: string
  head_sha: string
  role: WorkerRole
  review_seat: string | null
  provider: string
  requested_model: string
  resolved_model: string
  placement: Placement
  queued_at: number
}
export type AttemptOutcome = 'completed' | 'blocked' | 'refused' | 'failed' | 'unknown' | 'interrupted'
export interface AttemptRow extends AttemptIdentity {
  prepared_at: number | null
  started_at: number | null
  ended_at: number | null
  outcome: AttemptOutcome | null
}
export interface AttemptReceipt {
  /** Provider event/session identity, scoped by source and run; never invented token data. */
  receipt_id: string
  source: string
  observed_at: number
  model_reported: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  cost_usd: number | null
}
export type AttemptReceiptRow = AttemptKey & AttemptReceipt
const identityFields = ['run_id', 'step_id', 'attempt_id', 'phase', 'task_id', 'head_sha', 'role',
  'review_seat', 'provider', 'requested_model', 'resolved_model', 'placement', 'queued_at'] as const
const receiptFields = ['receipt_id', 'source', 'observed_at', 'model_reported', 'input_tokens',
  'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost_usd'] as const
const keyValues = (key: AttemptKey) => [key.run_id, key.step_id, key.attempt_id]
const predicate = 'run_id = ? AND step_id = ? AND attempt_id = ?'
function finite(values: readonly (number | null)[]): void {
  if (values.some((value) => value !== null && !Number.isFinite(value))) {
    throw new TypeError('attempt measurements must be finite or null')
  }
}

/** Storage only. A receipt establishes accounting, never permission to reuse a result. */
export class TridentAttemptLedger {
  constructor(private readonly db: ProjectDb) {}

  get(key: AttemptKey): AttemptRow | null {
    return this.db.get<AttemptRow>(`SELECT * FROM code_trident_attempts WHERE ${predicate}`, keyValues(key))
  }

  list(runId: string): AttemptRow[] {
    return this.db.all<AttemptRow>('SELECT * FROM code_trident_attempts WHERE run_id = ? ORDER BY step_id, attempt_id', [runId])
  }

  receipt(key: AttemptKey): AttemptReceiptRow | null {
    return this.db.get<AttemptReceiptRow>(`SELECT * FROM code_trident_attempt_receipts WHERE ${predicate}`, keyValues(key))
  }

  async admit(identity: AttemptIdentity): Promise<'recorded' | 'duplicate'> {
    finite([identity.queued_at])
    return this.db.transaction((tx) => {
      const existing = this.get(identity)
      if (existing) {
        if (identityFields.some((field) => existing[field] !== identity[field])) {
          throw new Error('attempt identity conflict')
        }
        return 'duplicate'
      }
      const phase = tx.get<{ source: string | null }>(
        'SELECT source FROM code_trident_phase_usage WHERE run_id = ? AND phase = ?', [identity.run_id, identity.phase])
      if (!phase) throw new Error('unknown run or phase')
      const hasAttempts = tx.get('SELECT 1 FROM code_trident_attempts WHERE run_id = ? AND phase = ? LIMIT 1', [identity.run_id, identity.phase])
      if (phase.source !== null && !hasAttempts) {
        throw new Error('cannot replace unattributed legacy phase accounting')
      }
      tx.runSync(`INSERT INTO code_trident_attempts (${identityFields.join(', ')}) VALUES (${identityFields.map(() => '?').join(', ')})`,
        identityFields.map((field) => identity[field]))
      projectAttemptUsage(tx, identity.run_id, identity.phase)
      return 'recorded'
    })
  }

  /** Late recovery may fill missing times, but cannot rewrite an observed event. */
  async lifecycle(key: AttemptKey, event: { prepared_at?: number; started_at?: number; ended_at?: number; outcome?: AttemptOutcome }): Promise<void> {
    finite([event.prepared_at ?? null, event.started_at ?? null, event.ended_at ?? null])
    await this.db.transaction((tx) => {
      const row = this.get(key)
      if (!row) throw new Error('unknown attempt')
      const fields = ['prepared_at', 'started_at', 'ended_at', 'outcome'] as const
      for (const field of fields) {
        if (event[field] !== undefined && row[field] !== null && event[field] !== row[field]) {
          throw new Error('attempt lifecycle conflict')
        }
      }
      tx.runSync(`UPDATE code_trident_attempts SET prepared_at = ?, started_at = ?, ended_at = ?, outcome = ? WHERE ${predicate}`,
        [...fields.map((field) => event[field] ?? row[field]), ...keyValues(key)])
    })
  }

  /** One cumulative receipt per call. Newer observations replace; replay never adds. */
  async observe(key: AttemptKey, receipt: AttemptReceipt): Promise<'recorded' | 'stale'> {
    finite([receipt.observed_at, receipt.input_tokens, receipt.output_tokens,
      receipt.cache_read_tokens, receipt.cache_creation_tokens, receipt.cost_usd])
    return this.db.transaction((tx) => {
      const row = this.get(key)
      if (!row) throw new Error('unknown attempt')
      const previous = this.receipt(key)
      if (previous) {
        if (previous.receipt_id !== receipt.receipt_id || previous.source !== receipt.source) {
          throw new Error('attempt receipt ownership conflict')
        }
        if (receipt.observed_at <= previous.observed_at) return 'stale'
        if (previous.model_reported !== null && receipt.model_reported !== previous.model_reported) {
          throw new Error('attempt reported model conflict')
        }
        // Streaming reports may omit an already measured field. They cannot erase it.
        for (const field of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost_usd'] as const) {
          if (previous[field] !== null && (receipt[field] === null || receipt[field]! < previous[field]!)) {
            throw new Error('attempt cumulative measurement regressed')
          }
        }
      }
      tx.runSync(`INSERT INTO code_trident_attempt_receipts (run_id, step_id, attempt_id, ${receiptFields.join(', ')})
        VALUES (${Array.from({ length: 3 + receiptFields.length }, () => '?').join(', ')})
        ON CONFLICT (run_id, step_id, attempt_id) DO UPDATE SET ${receiptFields.map((field) => `${field} = excluded.${field}`).join(', ')}`,
        [...keyValues(key), ...receiptFields.map((field) => receipt[field])])
      projectAttemptUsage(tx, row.run_id, row.phase)
      return 'recorded'
    })
  }
}
