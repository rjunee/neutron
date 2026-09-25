import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { TridentAttemptLedger } from './attempt-ledger.ts'
import { openTimelineReader, projectTimeline, timelineUsage } from './build-timeline.ts'
import { combineTimelineSources, type DirectObservation, type PrCatalogue } from './build-timeline-catalogue.ts'
import { renderTimeline } from './build-timeline-html.ts'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
const unknown = { input_tokens: null, output_tokens: null, cache_read_tokens: null,
  cache_creation_tokens: null, cost_usd: null, source: null, observed_at: null }
const at = (second: number) => Date.UTC(2026, 8, 25, 0, 0, second)
const iso = (second: number) => new Date(at(second)).toISOString()

test('token coverage preserves unknown, partial, explicit zero and disjoint cache counts', () => {
  expect(timelineUsage(unknown)).toMatchObject({ tokens: null, coverage: 'unknown', costUsd: null })
  expect(timelineUsage({ ...unknown, input_tokens: 0 })).toMatchObject({ tokens: 0, coverage: 'partial' })
  expect(timelineUsage({ ...unknown, cost_usd: 0 })).toMatchObject({ tokens: null, coverage: 'partial', costUsd: 0 })
  expect(timelineUsage({ ...unknown, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }))
    .toMatchObject({ tokens: 0, coverage: 'partial', costUsd: null })
  expect(timelineUsage({ ...unknown, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0 }))
    .toMatchObject({ tokens: 0, coverage: 'complete', costUsd: 0 })
  expect(timelineUsage({ ...unknown, input_tokens: 5, output_tokens: 3, cache_read_tokens: 12, cache_creation_tokens: 2, cost_usd: 0 }))
    .toMatchObject({ tokens: 22, coverage: 'complete' })
})

test('real SQLite writer → read-only timeline preserves overlaps, receipts, PR lineage and repository scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-timeline-')); temporary.push(dir)
  const path = join(dir, 'project.db')
  seedMigratedDb(path)
  const db = ProjectDb.open(path)
  const store = new TridentRunStore(db, () => iso(0))
  try {
    await store.create({ id: 'one', slug: 'one', project_slug: 'project', repo_path: '/fixture/open', task: 'build' })
    await store.create({ id: 'retry', slug: 'retry', project_slug: 'project', repo_path: '/fixture/open', task: 'retry' })
    await store.create({ id: 'other', slug: 'other', project_slug: 'project', repo_path: '/fixture/other', task: 'private' })
    await db.run("UPDATE code_trident_runs SET pr = 4, phase = 'done', last_advanced_at = ? WHERE id IN ('one', 'retry')", [iso(30)])
    await db.run("UPDATE code_trident_runs SET started_at = ? WHERE id = 'retry'", [iso(25)])
    const ledger = new TridentAttemptLedger(db)
    for (const [step, phase, role, start, end] of [
      ['build', 'build', 'build', 2, 10], ['review', 'review_rubric', 'review', 12, 20],
      ['cross', 'review_codex', 'review', 12, 24],
    ] as const) {
      const key = { run_id: 'one', step_id: step, attempt_id: 'dispatch' }
      await ledger.admit({ ...key, phase, role, task_id: 'task', head_sha: 'a'.repeat(40),
        review_seat: role === 'review' ? step : null, provider: 'codex', requested_model: 'model',
        resolved_model: 'requested-model', placement: 'headless', queued_at: at(1) })
      await ledger.lifecycle(key, { started_at: at(start), ended_at: at(end), outcome: 'completed' })
      if (step === 'build') await ledger.observe(key, { receipt_id: 'receipt', source: 'provider',
        observed_at: at(10), model_reported: 'observed-model', input_tokens: 5, output_tokens: 3,
        cache_read_tokens: 12, cache_creation_tokens: 0, cost_usd: null })
    }
    const reader = openTimelineReader(path, '/fixture/open', 1)
    try {
      const snapshot = reader.read(at(40))
      expect(snapshot.cards).toHaveLength(1)
      const card = snapshot.cards[0]!
      expect(card.runs.map(run => run.id).sort()).toEqual(['one', 'retry'])
      expect(card.end! - card.start!).toBe(30_000)
      expect(card.segments.map(span => span.lane)).toEqual([0, 0, 1])
      expect(card.segments[0]!.usage.tokens).toBe(20)
      expect(card.segments[0]!.detail).toContain('provider-reported model')
      expect(card.segments[1]!.detail).toContain('actual model unreported')
      expect(card.segments[0]!.model).toBe('observed-model')
      expect(card.segments[1]!.model).toBe('requested-model')
      expect(card.segments[1]!.usage.tokens).toBeNull()
      expect(card.phaseTotals.some(row => row.runId === 'one' && row.phase === 'build')).toBe(false)
      expect(card.gaps.map(gap => [gap.start - at(0), gap.end - at(0)])).toEqual([[0, 2000], [10000, 12000], [24000, 30000]])
      // A second read observes new snapshots without replaying or summing them.
      expect(reader.read(at(45)).cards[0]!.segments[0]!.usage.tokens).toBe(20)
    } finally { reader.close() }
  } finally { db.close() }
})

const catalogue = (): PrCatalogue => ({ observedAt: at(40), repositories: [
  { repository: 'example/open', error: null, prs: [
    { number: 1, title: '<script>bad</script>', url: 'https://github.com/example/open/pull/1', createdAt: iso(1), closedAt: iso(30), mergedAt: iso(30), state: 'merged' },
    { number: 2, title: 'direct build', url: 'https://github.com/example/open/pull/2', createdAt: iso(20), closedAt: null, mergedAt: null, state: 'open' },
  ] },
  { repository: 'example/hosted', error: null, prs: [
    { number: 1, title: 'host deployment', url: 'https://github.com/example/hosted/pull/1', createdAt: iso(10), closedAt: null, mergedAt: null, state: 'open' },
  ] },
] })

const observation = (overrides: Partial<DirectObservation> = {}): DirectObservation => ({
  eventId: 'event', phaseId: 'phase', links: [{ repository: 'example/open', prNumber: 2 }], phase: 'test',
  label: 'Full host suite', model: 'initiating-model', startedAt: at(22), endedAt: at(32),
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null,
  observedAt: at(40), source: { kind: 'codex', attribution: 'reconstructed', basis: 'Exact command start/end events' },
  ...overrides,
})

test('real legacy PR sentinels stay separate run-only rows before SQLite group limiting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timeline-sentinel-')); temporary.push(dir)
  const path = join(dir, 'project.db'); seedMigratedDb(path)
  const db = ProjectDb.open(path), store = new TridentRunStore(db, () => iso(0))
  try {
    for (const [id, pr, published, start] of [
      ['zero', 0, null, 5], ['other-zero', 0, 0, 10],
      ['positive', 7, 0, 1], ['published', 0, 8, 2],
    ] as const) {
      await store.create({ id, slug: id, project_slug: 'project', repo_path: '/fixture/open', task: 'test' })
      await db.run("UPDATE code_trident_runs SET pr = ?, published_pr = ?, started_at = ?, phase = 'done', last_advanced_at = ? WHERE id = ?", [pr, published, iso(start), iso(20), id])
    }
    const reader = openTimelineReader(path, '/fixture/open'), limited = openTimelineReader(path, '/fixture/open', 1)
    try {
      const snapshot = reader.read(at(30))
      expect(snapshot).toMatchObject({ prCount: 2, runOnlyCount: 2 })
      expect(snapshot.cards.map(card => [card.key, card.pr])).toEqual([
        ['run:other-zero', null], ['run:zero', null], ['pr:8', 8], ['pr:7', 7],
      ])
      expect(snapshot.cards.flatMap(card => card.runs).filter(run => run.published).map(run => run.id)).toEqual(['published'])
      expect(limited.read(at(30)).cards.map(card => card.key)).toEqual(['run:other-zero'])
      const html = renderTimeline(snapshot)
      expect(html).not.toContain('PR #0')
      expect(html).toContain('Unpublished run')
      expect(html).toContain('PR #7')
      expect(html).toContain('PR #8')
      expect(html).toContain('2 PRs · 2 run-only groups')
    } finally { reader.close(); limited.close() }
  } finally { db.close() }
})

test('projection rejects invalid identifiers while retaining real PR identity', () => {
  const snapshot = projectTimeline([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 42].map((pr, index) => ({
    id: `run-${index}`, slug: 'run', phase: 'done', pr, published_pr: null, started_at: iso(0), last_advanced_at: iso(1),
  })), [], [], [], at(2))
  expect(snapshot.cards.filter(card => card.pr === null)).toHaveLength(4)
  expect(snapshot.cards.filter(card => card.pr !== null).map(card => card.pr)).toEqual([42])
  expect(snapshot).toMatchObject({ prCount: 1, runOnlyCount: 4 })
})

test('all repositories and manual PRs remain visible with shared spans and honest lifecycle gaps', () => {
  const snapshot = combineTimelineSources(catalogue(), [observation({ links: [
    { repository: 'example/open', prNumber: 2 }, { repository: 'example/hosted', prNumber: 1 },
  ] })], [], at(40))
  expect(snapshot.cards.map(card => card.key)).toEqual(['example/open#2', 'example/hosted#1', 'example/open#1'])
  expect(snapshot.cards[2]!.segments).toHaveLength(0)
  expect(snapshot.cards[2]!.gaps).toEqual([{ start: at(1), end: at(30) }])
  expect(snapshot.cards[0]!.segments[0]!.model).toBe('initiating-model')
  expect(snapshot.cards[0]!.segments[0]!.usage.tokens).toBeNull()
  expect(snapshot.cards[0]!.segments[0]!.detail).toContain('not additive')
  expect(snapshot.cards[1]!.segments[0]!.id).toBe(snapshot.cards[0]!.segments[0]!.id)
  const html = renderTimeline(snapshot)
  expect(html).toContain('example/hosted')
  expect(html).toContain('Full host suite')
  expect(html).toContain('initiating-model')
  expect(html).toContain('data-duration-ms="10000"')
  expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;')
  expect(html).not.toContain('<script>bad</script>')
})

test('unfinished direct phases retain open extents and unknown background, parallel vs sequential lanes differ', () => {
  const observations = [observation(), observation({ phaseId: 'review', phase: 'review', label: 'Review', startedAt: at(25), endedAt: null }),
    observation({ phaseId: 'next', startedAt: at(32), endedAt: at(38) })]
  const card = combineTimelineSources(catalogue(), observations, [], at(40)).cards[0]!
  expect(card.segments.map(span => span.lane)).toEqual([0, 1, 0])
  expect(card.segments[1]).toMatchObject({ timing: 'open', end: at(40) })
  expect(card.gaps).toEqual([{ start: at(20), end: at(22) }, { start: at(38), end: at(40) }])
})

test('source failure preserves the readable repository and stale catalogue is explicit', () => {
  const source = catalogue()
  source.repositories[1] = { repository: 'example/hosted', error: 'GitHub unavailable', prs: [] }
  const snapshot = combineTimelineSources(source, [], [], at(120))
  expect(snapshot.cards).toHaveLength(2)
  expect(snapshot.warnings.join(' ')).toContain('GitHub unavailable')
  expect(snapshot.warnings.join(' ')).toContain('older than 60 seconds')
})

test('an older PR with a fresh recorded retry sorts above a newer quiet PR', () => {
  const snapshot = combineTimelineSources(catalogue(), [observation({
    links: [{ repository: 'example/open', prNumber: 1 }], startedAt: at(33), endedAt: at(39),
  })], [], at(40))
  expect(snapshot.cards[0]!.key).toBe('example/open#1')
  expect(snapshot.cards[0]!.start).toBe(at(1))
})

test('host stage identity preserves repeat suites and overlapping CI waits; missing starts never invent spans', () => {
  const runs = [{ id: 'run', slug: 'run', phase: 'done', pr: 1, published_pr: 1, started_at: iso(0), last_advanced_at: iso(40) }]
  const event = (id: number, stage: string, start: number, end: number | null) => ({ id, run_id: 'run',
    stage: end === null ? 'build-stage-started' : 'build-stage-ended', at: iso(end ?? start),
    meta: JSON.stringify({ stage, started_at: at(start), ...(end === null ? {} : { ended_at: at(end) }) }) })
  const events = [event(1, 'host-suite', 2, null), event(2, 'host-suite', 2, 10),
    event(3, 'host-suite', 20, null), event(4, 'host-suite', 20, 30),
    event(5, 'ci-readiness', 22, null), event(6, 'ci-readiness', 22, 35),
    event(7, 'orphan-end', 25, 36), event(8, 'ongoing-suite', 37, null)]
  const card = projectTimeline(runs, [], events, [], at(40)).cards[0]!
  expect(card.segments.map(span => [span.label, span.start, span.end, span.lane])).toEqual([
    ['host-suite', at(2), at(10), 0], ['host-suite', at(20), at(30), 0],
    ['ci-readiness', at(22), at(35), 1], ['ongoing-suite', at(37), at(40), 0],
  ])
  expect(card.segments.every(span => span.usage.tokens === null && span.model === null)).toBe(true)
  expect(card.segments[3]!.timing).toBe('open')
  expect(card.warnings.join(' ')).toContain('orphan-end')
  const ambiguous = projectTimeline(runs, [], [...events, event(9, 'host-suite', 2, null)], [], at(40)).cards[0]!
  expect(ambiguous.segments.filter(span => span.label === 'host-suite')).toHaveLength(1)
})
