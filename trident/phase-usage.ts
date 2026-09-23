import type { ProjectDb } from '@neutronai/persistence/index.ts'

/** Absolute totals across every attempt of this model phase in this run. */
export interface PhaseUsageReport {
  status: 'partial' | 'complete'
  /** Uncached input; cache counters below are disjoint. */
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  /** Reported USD, not an estimate derived from a subscription capacity sample. */
  cost_usd: number | null
  source: string
  observed_at: number
}

export interface PhaseUsageRow extends Omit<PhaseUsageReport, 'status' | 'source' | 'observed_at'> {
  run_id: string
  phase: string
  status: 'unknown' | 'partial' | 'complete'
  source: string | null
  observed_at: number | null
}

/** SQLite constraints protect direct writers too. */
export class TridentPhaseUsageStore {
  constructor(private readonly db: ProjectDb) {}

  /** null = unknown run; unknown rows = known run without phase reports. */
  list(runId: string): PhaseUsageRow[] | null {
    if (!this.db.get('SELECT id FROM code_trident_runs WHERE id = ?', [runId])) return null
    return this.db.all<PhaseUsageRow>(
      'SELECT * FROM code_trident_phase_usage WHERE run_id = ? ORDER BY phase', [runId],
    )
  }

  /** Accepted writes are validated by SQLite constraints. */
  async record(runId: string, phase: string, report: PhaseUsageReport): Promise<'recorded' | 'stale' | 'unknown-target'> {
    // SQLite binds NaN as NULL; refuse before that conversion erases evidence.
    for (const value of [report.input_tokens, report.output_tokens, report.cache_read_tokens,
      report.cache_creation_tokens, report.cost_usd, report.observed_at]) {
      if (value !== null && !Number.isFinite(value)) throw new TypeError('usage measurements must be finite or null')
    }
    return this.db.transaction((tx) => {
      if (tx.get('SELECT 1 FROM code_trident_attempts WHERE run_id = ? AND phase = ? LIMIT 1', [runId, phase])) {
        throw new Error('attempt accounting owns this phase projection')
      }
      const row = tx.get<{ observed_at: number | null }>(
        'SELECT observed_at FROM code_trident_phase_usage WHERE run_id = ? AND phase = ?', [runId, phase],
      )
      if (row === null) return 'unknown-target'
      if (row.observed_at !== null && report.observed_at <= row.observed_at) return 'stale'
      tx.runSync(
        `UPDATE code_trident_phase_usage SET status = ?, input_tokens = ?, output_tokens = ?,
          cache_read_tokens = ?, cache_creation_tokens = ?, cost_usd = ?, source = ?, observed_at = ?
          WHERE run_id = ? AND phase = ?`,
        [report.status, report.input_tokens, report.output_tokens, report.cache_read_tokens,
          report.cache_creation_tokens, report.cost_usd, report.source, report.observed_at, runId, phase],
      )
      return 'recorded'
    })
  }
}

/** Called in the attempt writer's transaction. Unknown operands never become zero. */
export function projectAttemptUsage(db: ProjectDb, runId: string, phase: string): void {
  const metrics = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost_usd'] as const
  const rows = db.all<Pick<PhaseUsageRow, typeof metrics[number] | 'observed_at'>>(
    `SELECT r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens, r.cost_usd, r.observed_at
     FROM code_trident_attempts a LEFT JOIN code_trident_attempt_receipts r
       ON a.run_id = r.run_id AND a.step_id = r.step_id AND a.attempt_id = r.attempt_id
     WHERE a.run_id = ? AND a.phase = ? ORDER BY a.step_id, a.attempt_id`, [runId, phase])
  const values = metrics.map((field) => rows.length === 0 || rows.some((row) => row[field] === null)
    ? null : rows.reduce((sum, row) => sum + row[field]!, 0))
  const known = values.filter((value) => value !== null).length
  const status = known === 0 ? 'unknown' : known === metrics.length ? 'complete' : 'partial'
  db.runSync(`UPDATE code_trident_phase_usage SET status = ?, input_tokens = ?, output_tokens = ?,
    cache_read_tokens = ?, cache_creation_tokens = ?, cost_usd = ?, source = ?, observed_at = ?
    WHERE run_id = ? AND phase = ?`,
  [status, ...values, known ? 'attempt-ledger/v1' : null,
    known ? Math.max(...rows.map((row) => row.observed_at ?? 0)) : null, runId, phase])
}
