import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { terminalRunDisposition } from './run-disposition.ts'
import type { TridentRun } from './store.ts'

export type MeasurementState = 'unknown' | 'partial' | 'complete'

export interface UsageAmount {
  unit: 'tokens'
  value: number | null
  state: MeasurementState
}

export interface UsageBreakdownRow {
  key: string
  amount: UsageAmount
}

export interface UsageAnalytics {
  spend: {
    total: UsageAmount
    by_project: UsageBreakdownRow[]
    by_phase: UsageBreakdownRow[]
    by_topic: UsageBreakdownRow[]
    by_agent: UsageBreakdownRow[]
    /** Historical model identity is not stored yet. Keep the seam without guessing. */
    by_model: { state: 'unknown'; rows: UsageBreakdownRow[] }
  }
  waste: {
    total: UsageAmount
    by_reason: UsageBreakdownRow[]
    unclassified_runs: number
    bands: Array<{ key: 'merged' | 'recoverable' | 'unrecoverable'; amount: UsageAmount }>
  }
  throughput: {
    state: MeasurementState
    runs: Array<{ project: string; seconds: number; outcome: string }>
  }
}

interface RawUsage {
  run_id: string
  usage_phase: string
  usage_topic: string
  usage_agent: string
  status: 'unknown' | 'partial' | 'complete'
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  repo_path: string
  run_phase: TridentRun['phase'] | null
  inner_verdict: TridentRun['inner_verdict']
  inner_checkpoint: string | null
  inner_checkpoint_findings: string | null
  inner_result: string | null
  failure_reason: string | null
  started_at: string
  last_advanced_at: string
  inner_checkpoint_head: string | null
  base_sha: string | null
  cache_is_subset: number
}

function tokens(row: RawUsage): number | null {
  const fields = [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_creation_tokens]
  if (fields.every((v) => v === null)) return null
  return (row.input_tokens ?? 0) + (row.output_tokens ?? 0) +
    (row.cache_is_subset === 1 ? 0 : (row.cache_read_tokens ?? 0) + (row.cache_creation_tokens ?? 0))
}

function projectName(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.at(-1) ?? 'unknown project'
}

function amount(rows: RawUsage[]): UsageAmount {
  const measured = rows.map(tokens).filter((v): v is number => v !== null)
  if (measured.length === 0) return { unit: 'tokens', value: null, state: 'unknown' }
  const exact = rows.every((row) => row.status === 'complete')
  return { unit: 'tokens', value: measured.reduce((a, b) => a + b, 0), state: exact ? 'complete' : 'partial' }
}

function breakdown(rows: RawUsage[], key: (row: RawUsage) => string): UsageBreakdownRow[] {
  const grouped = new Map<string, RawUsage[]>()
  for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row])
  return [...grouped].map(([name, group]) => ({ key: name, amount: amount(group) }))
    .sort((a, b) => (b.amount.value ?? -1) - (a.amount.value ?? -1) || a.key.localeCompare(b.key))
}

function terminalCause(row: RawUsage): string | null {
  if (row.inner_result === null) return null
  try {
    const parsed = JSON.parse(row.inner_result) as Record<string, unknown>
    return typeof parsed['terminalCauseKind'] === 'string' ? parsed['terminalCauseKind'] : null
  } catch { return null }
}

function wasteReason(row: RawUsage): string | null {
  if (wasteClass(row) !== 'unrecoverable') return null
  if (row.run_phase === null) return null
  const disposition = terminalRunDisposition({
    phase: row.run_phase,
    inner_verdict: row.inner_verdict,
    inner_checkpoint: row.inner_checkpoint,
    inner_checkpoint_findings: row.inner_checkpoint_findings,
  })
  if (disposition === 'approved' || disposition === 'not-terminal') return null
  const cause = terminalCause(row)
  if (cause === 'round-budget-exhausted') return 'full review budget, not approved'
  if (row.failure_reason?.toLowerCase().includes('reap')) return 'reaped run'
  if (disposition === 'reviewed-rejected') return 'review rejected'
  if (disposition === 'built-never-reviewed') return 'built, never reviewed'
  return 'failed before build'
}

function wasteClass(row: RawUsage): 'merged' | 'recoverable' | 'unrecoverable' | null {
  if (row.run_phase === null || (row.run_phase !== 'done' && row.run_phase !== 'failed' && row.run_phase !== 'stopped')) return null
  if (row.run_phase === 'done' && row.inner_verdict === 'APPROVE') return 'merged'
  if (row.inner_checkpoint_head !== null && row.base_sha !== null && row.inner_checkpoint_head !== row.base_sha) return 'recoverable'
  return 'unrecoverable'
}

export class TridentUsageAnalytics {
  constructor(private readonly db: ProjectDb) {}

  read(): UsageAnalytics {
    const rows = this.db.all<RawUsage>(`SELECT u.run_id, u.phase AS usage_phase, '' AS usage_topic,
      'trident' AS usage_agent, u.status,
      u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens,
      r.repo_path, r.phase AS run_phase, r.inner_verdict, r.inner_checkpoint,
      r.inner_checkpoint_findings, r.inner_result, r.failure_reason, r.started_at, r.last_advanced_at,
      r.inner_checkpoint_head, r.base_sha, 0 AS cache_is_subset
      FROM code_trident_phase_usage u JOIN code_trident_runs r ON r.id = u.run_id
      UNION ALL
      SELECT e.run_id, e.phase, e.topic, e.agent, 'complete', e.input_tokens, e.output_tokens,
      e.cache_read_tokens, 0, e.project, r.phase, r.inner_verdict, r.inner_checkpoint,
      r.inner_checkpoint_findings, r.inner_result, r.failure_reason,
      COALESCE(r.started_at, datetime(e.observed_at / 1000, 'unixepoch')),
      COALESCE(r.last_advanced_at, datetime(e.observed_at / 1000, 'unixepoch')),
      r.inner_checkpoint_head, r.base_sha, 1
      FROM transcript_usage_events e LEFT JOIN code_trident_runs r ON r.id = e.run_id`)
    // Keep the unknown phase rows in each wasted run. Dropping them would turn a
    // measured subset into an exact-looking total.
    const wasteRows = rows.filter((row) => wasteReason(row) !== null)
    const terminalRuns = new Map<string, RawUsage>()
    for (const row of rows) {
      if (row.run_phase === 'done' || row.run_phase === 'failed' || row.run_phase === 'stopped') {
        terminalRuns.set(row.run_id, row)
      }
    }
    const durations: UsageAnalytics['throughput']['runs'] = []
    let invalidDurations = 0
    for (const row of terminalRuns.values()) {
      const start = Date.parse(row.started_at)
      const end = Date.parse(row.last_advanced_at)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) { invalidDurations += 1; continue }
      durations.push({ project: projectName(row.repo_path), seconds: Math.round((end - start) / 1000), outcome: row.run_phase! })
    }
    durations.sort((a, b) => b.seconds - a.seconds)
    const unclassified = [...terminalRuns.values()].filter((row) => {
      const runRows = rows.filter((candidate) => candidate.run_id === row.run_id)
      return wasteReason(row) !== null && (amount(runRows).state === 'unknown' || terminalCause(row) === null)
    }).length
    return {
      spend: {
        total: amount(rows),
        by_project: breakdown(rows, (row) => projectName(row.repo_path)),
        by_phase: breakdown(rows, (row) => row.usage_phase),
        by_topic: breakdown(rows.filter((row) => row.usage_topic !== ''), (row) => row.usage_topic),
        by_agent: breakdown(rows, (row) => row.usage_agent),
        by_model: { state: 'unknown', rows: [] },
      },
      waste: {
        total: amount(wasteRows),
        by_reason: breakdown(wasteRows, (row) => wasteReason(row)!),
        unclassified_runs: unclassified,
        bands: (['merged', 'recoverable', 'unrecoverable'] as const).map((key) => ({
          key,
          amount: amount(rows.filter((row) => wasteClass(row) === key)),
        })),
      },
      throughput: {
        state: terminalRuns.size === 0 ? 'unknown' : invalidDurations === 0 ? 'complete' : 'partial',
        runs: durations.slice(0, 10),
      },
    }
  }
}
