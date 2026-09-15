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
