import { Database } from 'bun:sqlite'

export interface TimelineUsage {
  tokens: number | null
  coverage: 'unknown' | 'partial' | 'complete'
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheCreation: number | null
  costUsd: number | null
  source: string | null
  observedAt: number | null
}

interface Counters {
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  cost_usd: number | null
  source: string | null
  observed_at: number | null
}

interface RunRow {
  id: string
  slug: string
  phase: string
  pr: number | null
  published_pr: number | null
  started_at: string
  last_advanced_at: string
}
interface AttemptRow extends Counters {
  run_id: string
  step_id: string
  attempt_id: string
  phase: string
  role: string
  review_seat: string | null
  resolved_model: string
  model_reported: string | null
  queued_at: number
  started_at: number | null
  ended_at: number | null
  outcome: string | null
}
interface StageRow { id: number; run_id: string; stage: string; at: string; meta: string | null }
interface PhaseRow extends Counters { run_id: string; phase: string }

export interface TimelineSegment {
  id: string
  runId: string
  label: string
  phase: string
  start: number
  end: number
  timing: 'recorded' | 'open'
  lane: number
  usage: TimelineUsage
  detail: string
  model: string | null
}
export interface TimelineCard {
  key: string
  repository: string
  url: string | null
  lifecycle: string
  pr: number | null
  title: string
  start: number | null
  end: number | null
  latestStart: number | null
  active: boolean
  runs: Array<{ id: string; phase: string; published: boolean }>
  segments: TimelineSegment[]
  lanes: number
  gaps: Array<{ start: number; end: number }>
  events: Array<{ at: number; stage: string; runId: string }>
  phaseTotals: Array<{ runId: string; phase: string; usage: TimelineUsage }>
  warnings: string[]
}
export interface TimelineSnapshot {
  observedAt: number
  cards: TimelineCard[]
  prCount: number
  runOnlyCount: number
  maxDurationMs: number
  limit: number
  warnings: string[]
  page?: number
  totalPages?: number
}

const TERMINAL = new Set(['done', 'failed', 'stopped'])
const UNKNOWN: Counters = { input_tokens: null, output_tokens: null, cache_read_tokens: null,
  cache_creation_tokens: null, cost_usd: null, source: null, observed_at: null }

const positivePr = (value: number | null): number | null =>
  value !== null && Number.isSafeInteger(value) && value > 0 ? value : null
const runPr = (run: RunRow): number | null => positivePr(run.published_pr) ?? positivePr(run.pr)

export function timelineUsage(row: Counters): TimelineUsage {
  const fields = [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_creation_tokens]
  const known = fields.filter((value): value is number => value !== null)
  return {
    tokens: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
    coverage: known.length === 0 && row.cost_usd === null ? 'unknown' : known.length === 4 && row.cost_usd !== null ? 'complete' : 'partial',
    input: row.input_tokens, output: row.output_tokens, cacheRead: row.cache_read_tokens,
    cacheCreation: row.cache_creation_tokens, costUsd: row.cost_usd,
    source: row.source, observedAt: row.observed_at,
  }
}

function stamp(value: string): number | null {
  // Legacy SQLite stamps without an offset are UTC, not the viewer's local zone.
  const parsed = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function label(attempt: AttemptRow): string {
  if (attempt.phase === 'review_codex' || attempt.phase === 'review_kimi') return 'Cross-model review'
  const names: Record<string, string> = { plan: 'Planning', replan: 'Replanning', build: 'Building',
    fix: 'Fixing', 'fix-leak': 'Fixing leak', review: 'Review', synthesis: 'Synthesis',
    probe: 'Probe', resolve: 'Resolving', arbitrate: 'Arbitration' }
  return names[attempt.role] ?? attempt.role
}

/** Derive only spans with named endpoints. Ambiguous legacy reviewer pairs stay as event ticks. */
const LEGACY_PAIRS = [
  ['plan-start', 'build-agent-start', 'Planning'],
  ['codex-exec-start', 'codex-exec-end', 'Building'],
] as const

export function projectTimeline(
  runs: RunRow[], attempts: AttemptRow[], stages: StageRow[], phases: PhaseRow[], now: number, limit = 100,
): TimelineSnapshot {
  const groups = new Map<string, RunRow[]>()
  for (const run of runs) {
    const pr = runPr(run)
    const key = pr === null ? `run:${run.id}` : `pr:${pr}`
    const group = groups.get(key) ?? []
    group.push(run)
    groups.set(key, group)
  }
  const cards: TimelineCard[] = []
  for (const [key, group] of groups) {
    const ids = new Set(group.map(run => run.id))
    const starts = group.map(run => stamp(run.started_at)).filter((at): at is number => at !== null && at <= now)
    const active = group.some(run => !TERMINAL.has(run.phase))
    const ends = group.map(run => stamp(run.last_advanced_at)).filter((at): at is number => at !== null && at <= now)
    const card: TimelineCard = {
      key, repository: '', url: null, lifecycle: 'Recorded Trident run span', pr: runPr(group[0]!), title: group[0]!.slug,
      start: starts.length ? Math.min(...starts) : null,
      latestStart: starts.length ? Math.max(...starts) : null,
      end: active ? now : ends.length ? Math.max(...ends) : null, active,
      runs: group.map(run => ({ id: run.id, phase: run.phase, published: positivePr(run.published_pr) !== null })),
      segments: [], lanes: 1, gaps: [], events: [], phaseTotals: [], warnings: [],
    }
    if (starts.length !== group.length || ends.length !== group.length) card.warnings.push('Some run timestamps are missing, invalid, or in the future.')
    if (card.start === null || card.end === null || card.end < card.start) {
      card.start = null
      card.end = null
      card.warnings.push('Elapsed duration unknown: valid ordered run boundaries are unavailable.')
    }
    for (const attempt of attempts.filter(row => ids.has(row.run_id))) {
      const usage = timelineUsage(attempt)
      const detail = `${attempt.step_id} · ${attempt.review_seat ?? attempt.role} · ${attempt.outcome ?? 'no recorded outcome'} · ${attempt.model_reported === null ? 'resolved model request; actual model unreported' : 'provider-reported model'}`
      if (attempt.started_at === null || card.start === null || card.end === null) {
        card.warnings.push(`${detail}: start unrecorded; tokens ${usage.tokens ?? 'unknown'} (${usage.coverage}).`)
        continue
      }
      const end = attempt.ended_at ?? card.end
      if (attempt.started_at < card.start || end < attempt.started_at || end > now) {
        card.warnings.push(`${detail}: inconsistent timing; segment omitted.`)
        continue
      }
      // Keep late recorded evidence visible even if the run transition predates it.
      card.end = Math.max(card.end, end)
      card.segments.push({
        id: `${attempt.run_id}/${attempt.step_id}/${attempt.attempt_id}`, runId: attempt.run_id,
        label: label(attempt), phase: attempt.phase, start: attempt.started_at, end,
        timing: attempt.ended_at === null ? 'open' : 'recorded', lane: 0, usage, detail, model: attempt.model_reported ?? attempt.resolved_model,
      })
    }
    for (const run of group) {
      const events = stages.filter(row => row.run_id === run.id)
      const intervals = new Map<string, { stage: string; start: number; end: number | null; starts: number; ends: number }>()
      for (const event of events) {
        if (event.stage !== 'build-stage-started' && event.stage !== 'build-stage-ended') continue
        try {
          const meta = JSON.parse(event.meta ?? '') as Record<string, unknown>
          if (typeof meta['stage'] !== 'string' || typeof meta['started_at'] !== 'number' ||
            !Number.isSafeInteger(meta['started_at']) || meta['started_at'] < 0) continue
          const key = JSON.stringify([meta['stage'], meta['started_at']])
          const interval = intervals.get(key) ?? { stage: meta['stage'], start: meta['started_at'], end: null, starts: 0, ends: 0 }
          if (event.stage === 'build-stage-started') interval.starts++
          else if (typeof meta['ended_at'] === 'number' && Number.isSafeInteger(meta['ended_at'])) {
            interval.ends++
            interval.end = meta['ended_at']
          }
          intervals.set(key, interval)
        } catch { card.warnings.push('Malformed stage interval metadata; timing remains unknown.') }
      }
      for (const [key, interval] of intervals) {
        if (interval.starts !== 1 || interval.ends > 1 || card.start === null || card.end === null) {
          card.warnings.push(`${interval.stage}: ambiguous or missing start/end observations.`)
          continue
        }
        const end = interval.end ?? card.end
        if (interval.start < card.start || end < interval.start || end > now) continue
        card.end = Math.max(card.end, end)
        card.segments.push({ id: `${run.id}/stage/${key}`, runId: run.id, label: interval.stage, phase: 'host-stage',
          start: interval.start, end, timing: interval.end === null ? 'open' : 'recorded', lane: 0,
          model: null, usage: timelineUsage(UNKNOWN), detail: 'Host stage timestamps; model and usage unreported' })
      }
      for (const event of events) {
        const at = stamp(event.at)
        if (at !== null && card.start !== null && card.end !== null && at >= card.start && at <= now) {
          card.end = Math.max(card.end, at)
          card.events.push({ at, stage: event.stage, runId: run.id })
        }
      }
      if (!attempts.some(row => row.run_id === run.id)) {
        // A repeated start/end has no dispatch identity. Never guess its pairing.
        for (const [from, to, name] of LEGACY_PAIRS) {
          const fromRows = events.filter(row => row.stage === from)
          const toRows = events.filter(row => row.stage === to)
          if (fromRows.length !== 1 || toRows.length !== 1) continue
          const start = stamp(fromRows[0]!.at), end = stamp(toRows[0]!.at)
          if (start === null || end === null || card.start === null || card.end === null ||
            start < card.start || end < start || end > now) continue
          card.segments.push({ id: `${run.id}/${from}`, runId: run.id, label: name, phase: 'legacy',
            start, end, timing: 'recorded', lane: 0, usage: timelineUsage(UNKNOWN), model: null, detail: `Legacy stages: ${from} → ${to}` })
        }
      }
    }
    // Phase projections duplicate attempt receipts. Only legacy, non-attempt phases belong here.
    card.phaseTotals = phases.filter(row => ids.has(row.run_id) &&
      !attempts.some(attempt => attempt.run_id === row.run_id && attempt.phase === row.phase))
      .map(row => ({ runId: row.run_id, phase: row.phase, usage: timelineUsage(row) }))
    card.segments.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id))
    const laneEnds: number[] = []
    for (const segment of card.segments) {
      let lane = laneEnds.findIndex(end => end <= segment.start)
      if (lane === -1) lane = laneEnds.length
      segment.lane = lane
      laneEnds[lane] = segment.end
    }
    card.lanes = Math.max(1, laneEnds.length)
    if (card.start !== null && card.end !== null) {
      let cursor = card.start
      // Open extents do not establish phase coverage. Keep their background unknown.
      for (const segment of card.segments.filter(row => row.timing === 'recorded')) {
        if (segment.start > cursor) card.gaps.push({ start: cursor, end: segment.start })
        cursor = Math.max(cursor, segment.end)
      }
      if (cursor < card.end) card.gaps.push({ start: cursor, end: card.end })
    }
    cards.push(card)
  }
  cards.sort((a, b) => (b.latestStart ?? -1) - (a.latestStart ?? -1) || a.key.localeCompare(b.key))
  return { observedAt: now, cards, prCount: cards.filter(card => card.pr !== null).length,
    runOnlyCount: cards.filter(card => card.pr === null).length, maxDurationMs: Math.max(1, ...cards.map(card =>
    card.start === null || card.end === null ? 0 : card.end - card.start)), limit, warnings: [] }
}

/** Read-only connection: no migrations, reporters, workflow commands, or provider requests. */
export function openTimelineReader(path: string, repoPath: string, limit = -1) {
  if (!repoPath.trim() || !Number.isInteger(limit) || (limit !== -1 && (limit < 1 || limit > 500))) throw new Error('Invalid timeline scope')
  const db = new Database(path, { readonly: true, strict: true })
  db.exec('PRAGMA query_only = ON')
  return {
    close: () => db.close(),
    read: (now = Date.now()): TimelineSnapshot => db.transaction(() => {
      // Select complete PR lineages for the newest groups, not a truncated page of run rows.
      const runs = db.query<RunRow, [string, number]>(`WITH normalized AS (
        SELECT id, slug, phase,
          CASE WHEN typeof(pr) = 'integer' AND pr BETWEEN 1 AND 9007199254740991 THEN pr END AS pr,
          CASE WHEN typeof(published_pr) = 'integer' AND published_pr BETWEEN 1 AND 9007199254740991 THEN published_pr END AS published_pr,
          started_at, last_advanced_at FROM code_trident_runs WHERE repo_path = ?
      ), scoped AS (
        SELECT id, slug, phase, pr, published_pr, started_at, last_advanced_at,
          CASE WHEN COALESCE(published_pr, pr) IS NULL THEN 'run:' || id ELSE 'pr:' || COALESCE(published_pr, pr) END AS card_key
        FROM normalized
      ), latest AS (SELECT card_key FROM scoped GROUP BY card_key ORDER BY MAX(started_at) DESC LIMIT ?)
      SELECT id, slug, phase, pr, published_pr, started_at, last_advanced_at FROM scoped
      WHERE card_key IN (SELECT card_key FROM latest) ORDER BY started_at DESC`).all(repoPath, limit)
      const attempts: AttemptRow[] = [], stages: StageRow[] = [], phases: PhaseRow[] = []
      for (const run of runs) {
        attempts.push(...db.query<AttemptRow, [string]>(`SELECT a.run_id, a.step_id, a.attempt_id, a.phase,
          a.role, a.review_seat, a.resolved_model, r.model_reported, a.queued_at, a.started_at, a.ended_at, a.outcome,
          r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens, r.cost_usd, r.source, r.observed_at
          FROM code_trident_attempts a LEFT JOIN code_trident_attempt_receipts r
          ON a.run_id = r.run_id AND a.step_id = r.step_id AND a.attempt_id = r.attempt_id WHERE a.run_id = ?`).all(run.id))
        stages.push(...db.query<StageRow, [string]>('SELECT id, run_id, stage, at, meta FROM code_trident_stage_events WHERE run_id = ? ORDER BY at, id').all(run.id))
        phases.push(...db.query<PhaseRow, [string]>('SELECT * FROM code_trident_phase_usage WHERE run_id = ?').all(run.id))
      }
      return projectTimeline(runs, attempts, stages, phases, now, limit)
    })(),
  }
}
