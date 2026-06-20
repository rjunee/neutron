// tests/support/router-metrics-audit-core.ts — P2-v3 S5.
//
// Open-side copy of the PURE analysis core from
// scripts/e2e/router-metrics-audit.ts. Self-contained: no node:fs, no
// SSH, no CLI. The original script keeps the file-IO + extraction shell;
// this module carries only the deterministic analysis + rendering core
// so the integration test can round-trip event streams through it.

// ────────────────────────────────────────────────────────────────────
// Pure data types — exported so tests + downstream tooling can import.
// ────────────────────────────────────────────────────────────────────

export type RouterAction = 'advance' | 'answer' | 'amend'

export interface RouterDecisionRow {
  readonly id: string
  readonly ts: number
  readonly attempt_id: string
  readonly user_id: string
  readonly phase: string
  readonly action: RouterAction
  readonly confidence: number
  readonly escalated_to_sonnet: boolean
  readonly timed_out: boolean
  readonly clarify_synthesised: boolean
  readonly reasoning_redacted: string
  readonly latency_ms: number
}

export interface LatencyPercentiles {
  /** p50 latency (ms). Always present when n ≥ 1. */
  readonly p50: number
  /** p95 latency (ms). Always present when n ≥ 1. */
  readonly p95: number
  /**
   * p99 latency (ms). NULL when n < 20 — nearest-rank percentiles below
   * that floor under-report dramatically; the design § 6 S5 acceptance
   * notes call this out explicitly.
   */
  readonly p99: number | null
}

export interface ActionDistribution {
  readonly advance: number
  readonly answer: number
  readonly amend: number
  readonly advance_pct: number
  readonly answer_pct: number
  readonly amend_pct: number
}

export interface PhaseMetrics {
  readonly phase: string
  readonly n: number
  readonly latency: LatencyPercentiles
  readonly action_distribution: ActionDistribution
  readonly escalation_rate_pct: number
  readonly timeout_rate_pct: number
  readonly clarify_rate_pct: number
}

export interface AcceptanceGate {
  readonly name: string
  readonly threshold: string
  readonly observed: string
  readonly passed: boolean
}

export interface AuditReport {
  readonly n: number
  readonly global_latency: LatencyPercentiles
  readonly global_action_distribution: ActionDistribution
  readonly global_escalation_rate_pct: number
  readonly global_timeout_rate_pct: number
  readonly global_clarify_rate_pct: number
  readonly per_phase: ReadonlyArray<PhaseMetrics>
  readonly acceptance_gates: ReadonlyArray<AcceptanceGate>
  /** Warnings raised during analysis (e.g. timed_out=false but latency > 30s). */
  readonly warnings: ReadonlyArray<string>
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers.
// ────────────────────────────────────────────────────────────────────

const KNOWN_ACTIONS: ReadonlySet<RouterAction> = new Set<RouterAction>([
  'advance',
  'answer',
  'amend',
])

/**
 * Nearest-rank percentile, "exclusive" definition (R-2 in Hyndman & Fan
 * 1996 terms — picks `arr[ceil(n*p)-1]`). Matches what most ops dashboards
 * report (Datadog, Grafana). Returns 0 for an empty input.
 *
 * Operates on a SORTED ascending array of finite numbers.
 */
export function nearestRankPercentile(
  sorted: ReadonlyArray<number>,
  pct: number,
): number {
  if (sorted.length === 0) return 0
  if (pct <= 0) {
    return sorted[0] as number
  }
  if (pct >= 1) {
    return sorted[sorted.length - 1] as number
  }
  const rank = Math.ceil(sorted.length * pct)
  const idx = Math.max(0, Math.min(sorted.length - 1, rank - 1))
  return sorted[idx] as number
}

function actionDistribution(rows: ReadonlyArray<RouterDecisionRow>): ActionDistribution {
  let advance = 0, answer = 0, amend = 0
  for (const r of rows) {
    if (r.action === 'advance') advance += 1
    else if (r.action === 'answer') answer += 1
    else amend += 1
  }
  const n = rows.length || 1
  return {
    advance,
    answer,
    amend,
    advance_pct: (advance * 100) / n,
    answer_pct: (answer * 100) / n,
    amend_pct: (amend * 100) / n,
  }
}

function latencyPercentiles(rows: ReadonlyArray<RouterDecisionRow>): LatencyPercentiles {
  const sorted = rows.map((r) => r.latency_ms).slice().sort((a, b) => a - b)
  const p50 = nearestRankPercentile(sorted, 0.5)
  const p95 = nearestRankPercentile(sorted, 0.95)
  const p99 = sorted.length >= 20 ? nearestRankPercentile(sorted, 0.99) : null
  return { p50, p95, p99 }
}

function rateOf(rows: ReadonlyArray<RouterDecisionRow>, pick: (r: RouterDecisionRow) => boolean): number {
  if (rows.length === 0) return 0
  let n = 0
  for (const r of rows) if (pick(r)) n += 1
  return (n * 100) / rows.length
}

/**
 * Validate a single row against the design § 7.4 schema. Returns the
 * first error string or null. Used by both the live extraction (after
 * `json_extract` on `payload_json`) and the offline replay path.
 */
export function validateRouterRow(row: unknown): string | null {
  if (row === null || typeof row !== 'object') return 'row is not an object'
  const o = row as Record<string, unknown>
  if (typeof o.phase !== 'string' || o.phase.length === 0) return 'phase missing/invalid'
  if (typeof o.action !== 'string' || !KNOWN_ACTIONS.has(o.action as RouterAction)) {
    return `unknown action: ${JSON.stringify(o.action)}`
  }
  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) ||
      o.confidence < 0 || o.confidence > 1) {
    return `confidence out of [0,1]: ${o.confidence}`
  }
  if (typeof o.latency_ms !== 'number' || !Number.isFinite(o.latency_ms) || o.latency_ms < 0) {
    return `latency_ms invalid: ${o.latency_ms}`
  }
  return null
}

/**
 * Pure analysis core — takes already-parsed rows + returns the audit
 * report. Throws on schema drift (unknown action, out-of-range
 * confidence, n < 5).
 */
export function analyzeRouterEvents(
  rows: ReadonlyArray<RouterDecisionRow>,
): AuditReport {
  if (rows.length < 5) {
    throw new Error(`router-metrics-audit: n=${rows.length} < 5 (percentile floor); refusing to emit metrics from too few samples`)
  }

  const warnings: string[] = []

  for (const r of rows) {
    if (!KNOWN_ACTIONS.has(r.action)) {
      throw new Error(`router-metrics-audit: unknown action '${r.action}' on row id=${r.id} ts=${r.ts} — schema drift?`)
    }
    if (!Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1) {
      throw new Error(`router-metrics-audit: confidence=${r.confidence} out of [0,1] on row id=${r.id}`)
    }
    if (r.latency_ms > 30000 && !r.timed_out) {
      warnings.push(`latency_ms=${r.latency_ms} > 30s on id=${r.id} but timed_out=false (potential router-side timeout bookkeeping drift)`)
    }
  }

  const global_latency = latencyPercentiles(rows)
  const global_action_distribution = actionDistribution(rows)
  const global_escalation_rate_pct = rateOf(rows, (r) => r.escalated_to_sonnet)
  const global_timeout_rate_pct = rateOf(rows, (r) => r.timed_out)
  const global_clarify_rate_pct = rateOf(rows, (r) => r.clarify_synthesised)

  // Per-phase — group by phase, sort by n descending.
  const byPhase = new Map<string, RouterDecisionRow[]>()
  for (const r of rows) {
    const bucket = byPhase.get(r.phase) ?? []
    bucket.push(r)
    byPhase.set(r.phase, bucket)
  }
  const per_phase: PhaseMetrics[] = []
  for (const [phase, bucket] of byPhase) {
    per_phase.push({
      phase,
      n: bucket.length,
      latency: latencyPercentiles(bucket),
      action_distribution: actionDistribution(bucket),
      escalation_rate_pct: rateOf(bucket, (r) => r.escalated_to_sonnet),
      timeout_rate_pct: rateOf(bucket, (r) => r.timed_out),
      clarify_rate_pct: rateOf(bucket, (r) => r.clarify_synthesised),
    })
  }
  per_phase.sort((a, b) => b.n - a.n)

  // Acceptance gates. design § 6 S5.
  const p99Observed = global_latency.p99
  const acceptance_gates: AcceptanceGate[] = [
    {
      name: 'router p95 latency',
      threshold: '≤ 1500 ms',
      observed: `${global_latency.p95.toFixed(0)} ms`,
      passed: global_latency.p95 <= 1500,
    },
    {
      name: 'router p99 latency',
      threshold: '≤ 4000 ms',
      observed: p99Observed === null
        ? `<suppressed: n=${rows.length} < 20>`
        : `${p99Observed.toFixed(0)} ms`,
      passed: p99Observed === null ? true : p99Observed <= 4000,
    },
    {
      name: 'Sonnet escalation rate',
      threshold: '≤ 12%',
      observed: `${global_escalation_rate_pct.toFixed(1)}%`,
      passed: global_escalation_rate_pct <= 12,
    },
  ]

  return {
    n: rows.length,
    global_latency,
    global_action_distribution,
    global_escalation_rate_pct,
    global_timeout_rate_pct,
    global_clarify_rate_pct,
    per_phase,
    acceptance_gates,
    warnings,
  }
}

// ────────────────────────────────────────────────────────────────────
// Markdown / TSV emitters.
// ────────────────────────────────────────────────────────────────────

function fmtPct(p: number): string {
  return `${p.toFixed(1)}%`
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(0)} ms`
}

function fmtLatency(l: LatencyPercentiles): { p50: string; p95: string; p99: string } {
  return {
    p50: fmtMs(l.p50),
    p95: fmtMs(l.p95),
    p99: l.p99 === null ? '—' : fmtMs(l.p99),
  }
}

export interface RenderHeader {
  readonly slug: string
  readonly since_ms: number
  readonly until_ms: number
}

export function renderMarkdown(
  header: RenderHeader,
  report: AuditReport,
): string {
  const lines: string[] = []
  const sinceIso = new Date(header.since_ms).toISOString()
  const untilIso = new Date(header.until_ms).toISOString()

  lines.push(`# Router metrics — \`${header.slug}\``)
  lines.push('')
  lines.push(`Window: \`${sinceIso}\` → \`${untilIso}\` (${header.until_ms - header.since_ms} ms)`)
  lines.push(`Rows: **${report.n}**`)
  lines.push('')

  // Rolled-up table.
  lines.push('## Rolled-up')
  lines.push('')
  lines.push('| metric | value |')
  lines.push('|---|---|')
  const gl = fmtLatency(report.global_latency)
  lines.push(`| p50 latency | ${gl.p50} |`)
  lines.push(`| p95 latency | ${gl.p95} |`)
  lines.push(`| p99 latency | ${gl.p99}${report.global_latency.p99 === null ? ' _(suppressed: n < 20)_' : ''} |`)
  lines.push(`| Sonnet escalation rate | ${fmtPct(report.global_escalation_rate_pct)} |`)
  lines.push(`| Router timeout rate | ${fmtPct(report.global_timeout_rate_pct)} |`)
  lines.push(`| Clarify-synth rate | ${fmtPct(report.global_clarify_rate_pct)} |`)
  const gad = report.global_action_distribution
  lines.push(`| Action \`advance\` | ${gad.advance} (${fmtPct(gad.advance_pct)}) |`)
  lines.push(`| Action \`answer\` | ${gad.answer} (${fmtPct(gad.answer_pct)}) |`)
  lines.push(`| Action \`amend\` | ${gad.amend} (${fmtPct(gad.amend_pct)}) |`)
  lines.push('')

  // Per-phase table.
  lines.push('## Per-phase')
  lines.push('')
  lines.push('| phase | n | p50 | p95 | p99 | escalation% | %advance / %answer / %amend |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const p of report.per_phase) {
    const pl = fmtLatency(p.latency)
    const ad = p.action_distribution
    lines.push(
      `| \`${p.phase}\` | ${p.n} | ${pl.p50} | ${pl.p95} | ${pl.p99} | ${fmtPct(p.escalation_rate_pct)} | ${fmtPct(ad.advance_pct)} / ${fmtPct(ad.answer_pct)} / ${fmtPct(ad.amend_pct)} |`,
    )
  }
  lines.push('')

  // Acceptance gates.
  lines.push('## Acceptance gates (design § 6 S5)')
  lines.push('')
  for (const g of report.acceptance_gates) {
    const tick = g.passed ? '✅' : '❌'
    lines.push(`- ${tick} **${g.name}** — threshold ${g.threshold}, observed ${g.observed}`)
  }
  lines.push('')

  if (report.warnings.length > 0) {
    lines.push('## Warnings')
    lines.push('')
    for (const w of report.warnings) lines.push(`- ${w}`)
    lines.push('')
  }

  return lines.join('\n')
}

const TSV_COLUMNS: ReadonlyArray<string> = [
  'ts_iso',
  'phase',
  'action',
  'confidence',
  'escalated_to_sonnet',
  'timed_out',
  'clarify_synthesised',
  'latency_ms',
  'reasoning_redacted',
]

export function renderManualInspectionTsv(rows: ReadonlyArray<RouterDecisionRow>): string {
  const lines: string[] = [TSV_COLUMNS.join('\t')]
  for (const r of rows) {
    const cols: string[] = [
      new Date(r.ts).toISOString(),
      r.phase,
      r.action,
      r.confidence.toFixed(2),
      r.escalated_to_sonnet ? '1' : '0',
      r.timed_out ? '1' : '0',
      r.clarify_synthesised ? '1' : '0',
      String(r.latency_ms),
      // TSV — replace tabs/newlines in the reasoning with single spaces
      // to keep one row per line. Truncate at 100 chars per design § 7.4.
      r.reasoning_redacted.replace(/[\t\n\r]+/g, ' ').slice(0, 100),
    ]
    lines.push(cols.join('\t'))
  }
  return lines.join('\n')
}

export { TSV_COLUMNS as MANUAL_INSPECTION_TSV_COLUMNS }

// ────────────────────────────────────────────────────────────────────
// Row parser — coerce sqlite3 -json output into RouterDecisionRow.
// ────────────────────────────────────────────────────────────────────

interface RawRow {
  readonly id: unknown
  readonly ts: unknown
  readonly attempt_id: unknown
  readonly user_id: unknown
  readonly phase: unknown
  readonly action: unknown
  readonly confidence: unknown
  readonly escalated_to_sonnet: unknown
  readonly timed_out: unknown
  readonly clarify_synthesised: unknown
  readonly reasoning_redacted: unknown
  readonly latency_ms: unknown
}

function coerceBoolean(value: unknown, field: string, id: string): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    if (value === '1' || value === 'true') return true
    if (value === '0' || value === 'false' || value === '') return false
  }
  if (value === null || value === undefined) return false
  throw new Error(`row id=${id} field=${field}: cannot coerce ${JSON.stringify(value)} to boolean`)
}

function coerceNumber(value: unknown, field: string, id: string): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  throw new Error(`row id=${id} field=${field}: cannot coerce ${JSON.stringify(value)} to number`)
}

function coerceString(value: unknown, field: string, id: string): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return String(value)
  throw new Error(`row id=${id} field=${field}: cannot coerce ${JSON.stringify(value)} to string`)
}

export function parseRow(raw: unknown): RouterDecisionRow {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`row is not an object: ${JSON.stringify(raw)}`)
  }
  const r = raw as RawRow
  const id = typeof r.id === 'string' ? r.id : '<unknown>'
  const action = coerceString(r.action, 'action', id)
  if (!KNOWN_ACTIONS.has(action as RouterAction)) {
    throw new Error(`row id=${id}: unknown action ${JSON.stringify(action)}`)
  }
  return {
    id,
    ts: coerceNumber(r.ts, 'ts', id),
    attempt_id: coerceString(r.attempt_id, 'attempt_id', id),
    user_id: coerceString(r.user_id, 'user_id', id),
    phase: coerceString(r.phase, 'phase', id),
    action: action as RouterAction,
    confidence: coerceNumber(r.confidence, 'confidence', id),
    escalated_to_sonnet: coerceBoolean(r.escalated_to_sonnet, 'escalated_to_sonnet', id),
    timed_out: coerceBoolean(r.timed_out, 'timed_out', id),
    clarify_synthesised: coerceBoolean(r.clarify_synthesised, 'clarify_synthesised', id),
    reasoning_redacted: coerceString(r.reasoning_redacted, 'reasoning_redacted', id),
    latency_ms: coerceNumber(r.latency_ms, 'latency_ms', id),
  }
}

export function parseRows(raw: unknown): RouterDecisionRow[] {
  if (!Array.isArray(raw)) {
    throw new Error(`expected JSON array of rows; got ${typeof raw}`)
  }
  return raw.map(parseRow)
}
