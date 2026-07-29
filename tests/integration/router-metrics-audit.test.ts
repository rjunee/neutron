// tests/integration/router-metrics-audit.test.ts — P2-v3 S5.
//
// Round-trips deterministic event streams through the audit script's
// pure analysis core. The SSH + sqlite extraction is NOT exercised
// here (that's the responsibility of the live walk on the prod box);
// this test pins the percentile math, the action-distribution roll-up,
// the schema-drift gates, and the Markdown / TSV rendering shapes.

import { describe, expect, test } from 'bun:test'

import {
  analyzeRouterEvents,
  nearestRankPercentile,
  parseRow,
  parseRows,
  renderManualInspectionTsv,
  renderMarkdown,
  validateRouterRow,
  MANUAL_INSPECTION_TSV_COLUMNS,
  type RouterAction,
  type RouterDecisionRow,
} from '../support/router-metrics-audit-core.ts'

function row(over: Partial<RouterDecisionRow>): RouterDecisionRow {
  return {
    id: over.id ?? 'evt-0001',
    ts: over.ts ?? 1716148800000,
    attempt_id: over.attempt_id ?? 'attempt-1',
    user_id: over.user_id ?? 'synthetic:e2e:run-1',
    phase: over.phase ?? 'signup',
    action: over.action ?? 'advance',
    confidence: over.confidence ?? 0.9,
    escalated_to_sonnet: over.escalated_to_sonnet ?? false,
    timed_out: over.timed_out ?? false,
    clarify_synthesised: over.clarify_synthesised ?? false,
    reasoning_redacted: over.reasoning_redacted ?? 'plausible advance',
    latency_ms: over.latency_ms ?? 500,
  }
}

describe('nearestRankPercentile', () => {
  test('empty array returns 0', () => {
    expect(nearestRankPercentile([], 0.5)).toBe(0)
  })

  test('p50 of [1..20] is the 10th value = 10 (nearest-rank exclusive)', () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1)
    // ceil(20 * 0.5) = 10 → index 9 → value 10.
    expect(nearestRankPercentile(sorted, 0.5)).toBe(10)
  })

  test('p95 of [1..20] is the 19th value = 19', () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1)
    // ceil(20 * 0.95) = 19 → index 18 → value 19.
    expect(nearestRankPercentile(sorted, 0.95)).toBe(19)
  })

  test('p99 of [1..20] is the 20th value = 20', () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1)
    // ceil(20 * 0.99) = 20 → index 19 → value 20.
    expect(nearestRankPercentile(sorted, 0.99)).toBe(20)
  })

  test('clamps to max for pct >= 1', () => {
    expect(nearestRankPercentile([1, 2, 3], 1.5)).toBe(3)
  })
})

describe('analyzeRouterEvents — happy path', () => {
  test('20-row fixture: p50/p95/p99 match the nearest-rank values', () => {
    const rows: RouterDecisionRow[] = Array.from({ length: 20 }, (_, i) =>
      row({
        id: `evt-${String(i).padStart(4, '0')}`,
        latency_ms: (i + 1) * 100,
        phase: i % 4 === 0 ? 'signup' : 'import_upload_pending',
      }),
    )
    const report = analyzeRouterEvents(rows)
    expect(report.n).toBe(20)
    expect(report.global_latency.p50).toBe(1000)
    expect(report.global_latency.p95).toBe(1900)
    expect(report.global_latency.p99).toBe(2000)

    const p99gate = report.acceptance_gates.find((g) => g.name === 'router p99 latency')
    expect(p99gate).toBeDefined()
    expect(p99gate?.passed).toBe(true)
    expect(p99gate?.observed).toBe('2000 ms')
  })

  test('action distribution with 30 rows over 5 phases', () => {
    // 30 rows: 18 advance, 8 answer, 4 amend. 5 phases (6 rows each).
    const phases = ['signup', 'ai_substrate_offered', 'import_upload_pending', 'personality_offered', 'agent_name_chosen']
    const actions: RouterAction[] = []
    for (let i = 0; i < 18; i++) actions.push('advance')
    for (let i = 0; i < 8; i++) actions.push('answer')
    for (let i = 0; i < 4; i++) actions.push('amend')

    const rows: RouterDecisionRow[] = actions.map((action, i) => row({
      id: `evt-${i}`,
      action,
      phase: phases[i % 5]!,
      latency_ms: 400 + (i % 7) * 50,
    }))
    const report = analyzeRouterEvents(rows)
    expect(report.global_action_distribution.advance).toBe(18)
    expect(report.global_action_distribution.answer).toBe(8)
    expect(report.global_action_distribution.amend).toBe(4)
    expect(report.global_action_distribution.advance_pct).toBeCloseTo(60.0, 5)
    expect(report.global_action_distribution.answer_pct).toBeCloseTo(26.6666, 3)
    expect(report.global_action_distribution.amend_pct).toBeCloseTo(13.3333, 3)
    expect(report.per_phase).toHaveLength(5)
    // Per-phase rows sorted by n descending. All five buckets have 6 rows.
    for (const p of report.per_phase) {
      expect(p.n).toBe(6)
    }
  })

  test('100-row fixture with 12 sonnet escalations yields 12.0% (gate edge)', () => {
    const rows: RouterDecisionRow[] = Array.from({ length: 100 }, (_, i) =>
      row({
        id: `evt-${i}`,
        latency_ms: 600,
        escalated_to_sonnet: i < 12,
      }),
    )
    const report = analyzeRouterEvents(rows)
    expect(report.global_escalation_rate_pct).toBeCloseTo(12.0, 5)
    const gate = report.acceptance_gates.find((g) => g.name === 'Sonnet escalation rate')
    expect(gate?.passed).toBe(true)
    expect(gate?.observed).toBe('12.0%')
  })

  test('100-row fixture with 13 sonnet escalations breaches the gate (13.0%)', () => {
    const rows: RouterDecisionRow[] = Array.from({ length: 100 }, (_, i) =>
      row({
        id: `evt-${i}`,
        escalated_to_sonnet: i < 13,
      }),
    )
    const report = analyzeRouterEvents(rows)
    expect(report.global_escalation_rate_pct).toBeCloseTo(13.0, 5)
    const gate = report.acceptance_gates.find((g) => g.name === 'Sonnet escalation rate')
    expect(gate?.passed).toBe(false)
  })

  test('n < 20 suppresses p99', () => {
    const rows: RouterDecisionRow[] = Array.from({ length: 10 }, (_, i) =>
      row({ id: `evt-${i}`, latency_ms: 100 * (i + 1) }),
    )
    const report = analyzeRouterEvents(rows)
    expect(report.global_latency.p99).toBeNull()
    const gate = report.acceptance_gates.find((g) => g.name === 'router p99 latency')
    expect(gate?.passed).toBe(true)
    expect(gate?.observed).toContain('suppressed')
  })

  test('latency > 30s with timed_out=false raises a warning', () => {
    const rows: RouterDecisionRow[] = Array.from({ length: 5 }, (_, i) =>
      row({ id: `evt-${i}`, latency_ms: i === 0 ? 31000 : 600, timed_out: false }),
    )
    const report = analyzeRouterEvents(rows)
    expect(report.warnings.length).toBeGreaterThan(0)
    expect(report.warnings[0]).toContain('31000')
  })
})

describe('analyzeRouterEvents — failure modes', () => {
  test('n < 5 throws with a clear message', () => {
    const rows: RouterDecisionRow[] = Array.from({ length: 4 }, (_, i) =>
      row({ id: `evt-${i}` }),
    )
    expect(() => analyzeRouterEvents(rows)).toThrow(/n=4 < 5/)
  })

  test('unknown action throws with the offending value', () => {
    const rows: RouterDecisionRow[] = Array.from({ length: 5 }, (_, i) =>
      row({ id: `evt-${i}` }),
    )
    // Cast to bypass the type narrowing; we want to exercise the runtime
    // schema-drift guard, not the compile-time one.
    ;(rows[0] as { action: string }).action = 'nonexistent'
    expect(() => analyzeRouterEvents(rows)).toThrow(/unknown action 'nonexistent'/)
  })

  test('confidence out of range throws', () => {
    const rows: RouterDecisionRow[] = Array.from({ length: 5 }, (_, i) =>
      row({ id: `evt-${i}` }),
    )
    ;(rows[0] as { confidence: number }).confidence = 1.5
    expect(() => analyzeRouterEvents(rows)).toThrow(/confidence=1.5 out of/)
  })
})

describe('parseRow / parseRows', () => {
  test('coerces sqlite3 -json shapes (0/1 ints for booleans, strings for nums)', () => {
    const raw = [
      {
        id: 'evt-0001',
        ts: 1716148800000,
        attempt_id: 'attempt-1',
        user_id: 'synthetic:e2e:r1',
        phase: 'signup',
        action: 'advance',
        confidence: 0.92,
        escalated_to_sonnet: 0,
        timed_out: 0,
        clarify_synthesised: 1,
        reasoning_redacted: 'plausible',
        latency_ms: 500,
      },
    ]
    const parsed = parseRows(raw)
    expect(parsed).toHaveLength(1)
    const r = parsed[0]!
    expect(r.escalated_to_sonnet).toBe(false)
    expect(r.timed_out).toBe(false)
    expect(r.clarify_synthesised).toBe(true)
    expect(r.confidence).toBe(0.92)
    expect(r.latency_ms).toBe(500)
  })

  test('unknown action surfaces at parse time', () => {
    expect(() => parseRow({
      id: 'evt-1',
      ts: 1,
      attempt_id: '',
      user_id: '',
      phase: 'signup',
      action: 'mystery',
      confidence: 0.5,
      escalated_to_sonnet: 0,
      timed_out: 0,
      clarify_synthesised: 0,
      reasoning_redacted: '',
      latency_ms: 0,
    })).toThrow(/unknown action/)
  })

  test('parseRows rejects non-array input', () => {
    expect(() => parseRows({ foo: 'bar' })).toThrow(/expected JSON array/)
  })
})

describe('validateRouterRow', () => {
  test('null returns a string', () => {
    expect(validateRouterRow(null)).toBe('row is not an object')
  })
  test('valid row returns null', () => {
    expect(validateRouterRow({
      phase: 'signup',
      action: 'advance',
      confidence: 0.8,
      latency_ms: 400,
    })).toBeNull()
  })
  test('out-of-range confidence is rejected', () => {
    expect(validateRouterRow({
      phase: 'signup',
      action: 'advance',
      confidence: 2,
      latency_ms: 400,
    })).toMatch(/confidence/)
  })
})

describe('renderMarkdown', () => {
  test('headline + rolled-up + per-phase + gates sections all render', () => {
    const rows: RouterDecisionRow[] = Array.from({ length: 25 }, (_, i) =>
      row({
        id: `evt-${i}`,
        latency_ms: 400 + i * 20,
        phase: i < 13 ? 'signup' : 'ai_substrate_offered',
        action: i % 5 === 0 ? 'answer' : 'advance',
      }),
    )
    const report = analyzeRouterEvents(rows)
    const md = renderMarkdown({ slug: 'test-fixture', since_ms: 0, until_ms: 1000 }, report)
    expect(md).toContain('# Router metrics — `test-fixture`')
    expect(md).toContain('## Rolled-up')
    expect(md).toContain('## Per-phase')
    expect(md).toContain('## Acceptance gates (design § 6 S5)')
    expect(md).toContain('`signup`')
    expect(md).toContain('`ai_substrate_offered`')
    // Gate ticks present.
    expect(md).toMatch(/✅|❌/)
  })

  test('p99 suppression renders the explanatory tag', () => {
    const rows: RouterDecisionRow[] = Array.from({ length: 10 }, (_, i) =>
      row({ id: `evt-${i}`, latency_ms: 500 }),
    )
    const report = analyzeRouterEvents(rows)
    const md = renderMarkdown({ slug: 'small-fixture', since_ms: 0, until_ms: 1 }, report)
    expect(md).toContain('suppressed: n < 20')
  })
})

describe('renderManualInspectionTsv', () => {
  test('header column set is the documented contract', () => {
    const tsv = renderManualInspectionTsv([])
    const header = tsv.split('\n')[0]
    expect(header).toBe(MANUAL_INSPECTION_TSV_COLUMNS.join('\t'))
    expect(MANUAL_INSPECTION_TSV_COLUMNS).toEqual([
      'ts_iso',
      'phase',
      'action',
      'confidence',
      'escalated_to_sonnet',
      'timed_out',
      'clarify_synthesised',
      'latency_ms',
      'reasoning_redacted',
    ])
  })

  test('reasoning with tabs/newlines is normalized to spaces (one row per line)', () => {
    const r = row({ reasoning_redacted: 'line1\ttabbed\nnewline' })
    const tsv = renderManualInspectionTsv([r])
    const lines = tsv.split('\n')
    expect(lines).toHaveLength(2)
    const dataLine = lines[1]!
    expect(dataLine).not.toMatch(/\n/)
    // Tab inside the reasoning field would corrupt the column count;
    // the renderer collapses internal tabs to a space.
    expect(dataLine.split('\t')).toHaveLength(MANUAL_INSPECTION_TSV_COLUMNS.length)
  })
})
