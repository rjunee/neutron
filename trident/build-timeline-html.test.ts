import { expect, test } from 'bun:test'
import { barIntervals, renderTimeline, TIMELINE_SCRIPT } from './build-timeline-html.ts'
import { createContext, runInContext } from 'node:vm'
import { timelineUsage, type TimelineCard, type TimelineSegment } from './build-timeline.ts'
const usage = timelineUsage({ input_tokens: null, output_tokens: null, cache_read_tokens: null,
  cache_creation_tokens: null, cost_usd: null, source: null, observed_at: null })
const segment = (id: string, start: number, end: number, phase = 'test'): TimelineSegment => ({
  id, start, end, phase, label: phase, lane: 0, runId: 'run', timing: 'recorded', usage, model: null, detail: 'receipt',
})
const card = (segments: TimelineSegment[], end = 100): TimelineCard => ({ key: 'example/open#1', repository: 'example/open',
  url: 'https://github.com/example/open/pull/1', lifecycle: 'PR merged', pr: 1, title: 'Readable PR',
  start: 0, end, latestStart: 0, active: false, runs: [], segments, lanes: 25, gaps: [], events: [], phaseTotals: [], warnings: [],
})

test('recorded phase categories determine bars and detail dots despite conflicting action labels', () => {
  const categories: Array<[string, string, string]> = [
    ['plan', 'plan', '#a78bfa'], ['replan', 'plan', '#a78bfa'],
    ['build', 'build', '#5b9df5'], ['build_mechanical', 'build', '#5b9df5'],
    ['fix', 'fix', '#ed7d94'], ['fix-leak', 'fix', '#ed7d94'],
    ...['review', 'review_rubric', 'review_adversarial', 'review_codex', 'review_kimi', 'synthesis']
      .map(phase => [phase, 'review', '#e7ae55'] as [string, string, string]),
    ['test', 'test', '#5ac8ad'], ['ci', 'test', '#5ac8ad'], ['probe', 'test', '#5ac8ad'],
    ['deploy', 'deploy', '#a8cb73'],
  ]
  for (const [phase, expected, color] of categories) {
    for (const label of ['Action', 'Fixture build/test', 'prefix', 'suffix', 'plan fix review test deploy']) {
      const pr = card([{ ...segment('action', 0, 100, phase), label }])
      expect(barIntervals(pr)[0]!.tones).toEqual([expected])
      const html = renderTimeline({ observedAt: 100, cards: [pr], prCount: 1, runOnlyCount: 0,
        maxDurationMs: 100, limit: 50, warnings: [] })
      expect(html).toContain(`background:${color}\" aria-label=`)
      expect(html).toContain(`class="phase-dot" style="background:${color}"`)
    }
  }
})

test('unknown and legacy phases retain label inference and recognized phases retain review overlap', () => {
  for (const [phase, label, expected] of [
    ['legacy', 'Planning', 'plan'], ['legacy', 'Building', 'build'],
    ['host-stage', 'Shared-host suite', 'test'], ['unknown', 'Fixing leak', 'fix'],
    ['unknown', 'Cross-model review', 'review'], ['unknown', 'Deploy', 'deploy'],
    ['unknown', 'Action', 'build'], ['custom-test', 'Action', 'test'],
  ] as const) {
    expect(barIntervals(card([{ ...segment('action', 0, 100, phase), label }]))[0]!.tones).toEqual([expected])
  }
  expect(barIntervals(card([
    { ...segment('build', 0, 100, 'build'), label: 'Fixture build' },
    { ...segment('review', 0, 100, 'review_codex'), label: 'Plan fix tests' },
    { ...segment('ci', 0, 100, 'ci'), label: 'Fixture test' },
  ]))[0]!.tones).toEqual(['build', 'review', 'test'])
})

test('concurrent CI jobs occupy one wall-clock bar without multiplying its width or height', () => {
  const pr = card(Array.from({ length: 25 }, (_, i) => segment(`job-${i}`, 10, 90)))
  const intervals = barIntervals(pr)
  expect(intervals.map(i => [i.start, i.end, i.tones])).toEqual([[0, 10, []], [10, 90, ['test']], [90, 100, []]])
  expect(intervals.reduce((total, i) => total + i.end - i.start, 0)).toBe(100)
  const html = renderTimeline({ observedAt: 100, cards: [pr, { ...pr, key: 'second', end: 200 }], prCount: 2,
    runOnlyCount: 0, maxDurationMs: 200, limit: 50, warnings: [] })
  expect(html.match(/class="bar"/g)).toHaveLength(2)
  expect(html).toContain('class="bar" style="width:50.00000%"')
  expect(html).toContain('class="bar" style="width:100.00000%"')
  expect(html).not.toContain('top:')
  expect(html).toContain('Tokens unknown')
})

test('sequential, parallel, zero and clipped spans retain honest interval geometry and details', () => {
  const pr = card([segment('build', -10, 40, 'build'), segment('review', 20, 70, 'review'), segment('ci', 60, 120), segment('zero', 75, 75)])
  expect(barIntervals(pr).map(i => [i.start, i.end, i.tones])).toEqual([
    [0, 20, ['build']], [20, 40, ['build', 'review']], [40, 60, ['review']], [60, 70, ['review', 'test']], [70, 75, ['test']], [75, 100, ['test']],
  ])
  const html = renderTimeline({ observedAt: 100, cards: [pr], prCount: 1, runOnlyCount: 0, maxDurationMs: 100, limit: 50, warnings: [] })
  expect(html).toContain('linear-gradient(to bottom,')
  expect(html).toContain('data-segment="zero"')
  expect(barIntervals({ ...pr, start: null, end: null })).toEqual([])
})

test('an unrecorded end does not paint unknown elapsed time as recorded work', () => {
  const pr = card([{ ...segment('open-build', 0, 100, 'build'), timing: 'open' }, segment('ci', 20, 40)])
  expect(barIntervals(pr).map(i => [i.start, i.end, i.tones])).toEqual([[0, 20, []], [20, 40, ['test']], [40, 100, []]])
  const html = renderTimeline({ observedAt: 100, cards: [pr], prCount: 1, runOnlyCount: 0, maxDurationMs: 100, limit: 50, warnings: [] })
  expect(html).toContain('repeating-linear-gradient(135deg,')
  expect(html).toContain('end unrecorded')
})

test('PR and phase timestamps expose clock context without turning missing evidence into zero time', () => {
  const opened = Date.parse('2026-09-26T16:33:00Z')
  const started = opened - 60_000
  const completed = opened + 120_000
  const pr = { ...card([
    segment('review', started, completed, 'review'),
    { ...segment('building', completed, completed + 60_000, 'build'), timing: 'open' as const },
  ], completed + 60_000), createdAt: opened }
  pr.start = started
  const html = renderTimeline({ observedAt: completed, cards: [pr], prCount: 1, runOnlyCount: 0,
    maxDurationMs: 180_000, limit: 50, warnings: [] })
  expect(html).toContain(`Opened <time datetime="2026-09-26T16:33:00.000Z" data-local-time="${opened}"`)
  expect(html).toContain(`Work started <time datetime="2026-09-26T16:32:00.000Z" data-local-time="${started}"`)
  expect(html).toContain(`&quot;completedAt&quot;:${completed}`)
  expect(html).toContain('&quot;completedAt&quot;:null')
  expect(html).toContain('Phase data incomplete')
  expect(html).toContain('Completion not recorded')
  expect(html).not.toContain('In progress')
  const unknown = renderTimeline({ observedAt: completed, cards: [{ ...card([]), start: null, end: null }],
    prCount: 1, runOnlyCount: 0, maxDurationMs: 1, limit: 50, warnings: [] })
  expect(unknown).toContain('Opened unknown')
  expect(unknown).toContain('Observed work start: unknown')
  expect(unknown).not.toContain('Completed 1970')
})

test('a build and review without a correction phase does not imply missing phase evidence', () => {
  const pr = card([segment('build', 0, 50, 'build'), segment('review', 50, 100, 'review')])
  const html = renderTimeline({ observedAt: 100, cards: [pr], prCount: 1, runOnlyCount: 0,
    maxDurationMs: 100, limit: 50, warnings: [] })
  expect(html).not.toContain('Phase data incomplete')
  expect(html).not.toContain('Fixing')
  const gap = renderTimeline({ observedAt: 100, cards: [{ ...pr, segments: [segment('ci', 0, 100, 'ci')] }],
    prCount: 1, runOnlyCount: 0, maxDurationMs: 100, limit: 50, warnings: [] })
  expect(gap).toContain('Phase data incomplete')
})

test('focus clips only the viewport and makes every later phase available through the overflow popover', () => {
  const pr = card([segment('first', 0, 60_000, 'build'), segment('late', 7_200_000, 7_260_000, 'review')], 7_260_000)
  pr.prState = 'open'; pr.active = true
  const snapshot = { observedAt: 7_260_000, cards: [pr], prCount: 1, runOnlyCount: 0, maxDurationMs: 7_260_000,
    viewDurationMs: 3_600_000, scaleMode: 'focus' as const, limit: 50, warnings: [] }
  const html = renderTimeline(snapshot)
  expect(html).toContain('0–1h focus window')
  expect(html).toContain('width:100.00000%')
  expect(html).toContain('class="overflow-button"')
  expect(html).toContain('Beyond the focus window')
  expect(html).toContain('>Beyond 1h: Review <span aria-hidden="true">›</span></button>')
  expect(html).toContain('&quot;label&quot;:&quot;review&quot;')
  expect(html).toContain('No live signal')
  expect(html).not.toContain('CI running')
  expect(html).toContain('aria-haspopup="dialog"')
  expect(renderTimeline({ ...snapshot, viewDurationMs: 7_260_000, scaleMode: 'all' })).not.toContain('class="overflow-button"')
})

test('collapsed focus rows visibly name later explicit categories in start order without inferring work', () => {
  const hour = 3_600_000
  const render = (segments: TimelineSegment[], end = 87 * hour) => renderTimeline({ observedAt: end,
    cards: [card(segments, end)], prCount: 1, runOnlyCount: 0, maxDurationMs: end,
    viewDurationMs: hour, scaleMode: 'focus', limit: 50, warnings: [] })
  const visibleOverflow = (html: string) => html.match(/class="overflow-button"[^>]*>(.*?)<\/button>/s)?.[1]
  const late = [segment('ci', 0, 60_000, 'ci'), segment('test', 86 * hour + 1000, 87 * hour, 'test'),
    segment('fix', 86 * hour, 87 * hour, 'fix'), segment('review', 86 * hour + 500, 87 * hour, 'review'),
    segment('repeat', 86 * hour + 2000, 87 * hour, 'review')]
  const html = render(late)
  expect(visibleOverflow(html)).toBe('Beyond 1h: Fix · Review · Test <span aria-hidden="true">›</span>')
  expect(html.indexOf('class="overflow-button"')).toBeLessThan(html.indexOf('class="bar-track"'))
  expect(html.match(/class="bar"/g)).toHaveLength(1)
  expect(html).toContain('width:100.00000%')
  expect(html).toContain('Tokens unknown')
  expect(visibleOverflow(render([segment('ci', 0, 2 * hour, 'ci')], 2 * hour))).toContain('Beyond 1h: CI ')
  expect(visibleOverflow(render([{ ...segment('unknown', hour, 2 * hour, 'custom<&>'), label: 'Build fix review test' }], 2 * hour)))
    .toContain('Beyond 1h: custom&lt;&amp;&gt; ')
  expect(visibleOverflow(render([]))).toContain('Beyond 1h: View timeline ')
  expect(visibleOverflow(render([segment('boundary', 0, hour, 'build'), segment('crossing', hour - 1, hour + 1, 'review')], hour + 1)))
    .toContain('Beyond 1h: Review ')
  expect(render([segment('boundary', 0, hour, 'build')], hour)).not.toContain('class="overflow-button"')
  expect(visibleOverflow(render(late.concat([segment('extra', 86 * hour + 3000, 87 * hour, 'ci')]))))
    .toContain('Fix · Review · Test · +1 categories')
  expect(render(late.concat([segment('extra', 86 * hour + 3000, 87 * hour, 'ci')]))).toContain('Fix, Review, Test, CI. Show phase details')
})

test('unknown later categories never acquire action-label inferred phases and absent timing has no overflow', () => {
  const hour = 3_600_000
  const snapshot = { observedAt: 2 * hour, cards: [card([{ ...segment('unknown', hour, 2 * hour, 'custom'), label: 'Build fix review test' }], 2 * hour)],
    prCount: 1, runOnlyCount: 0, maxDurationMs: 2 * hour, viewDurationMs: hour, scaleMode: 'focus' as const, limit: 50, warnings: [] }
  expect(renderTimeline(snapshot)).toContain('>Beyond 1h: custom <span')
  expect(renderTimeline({ ...snapshot, cards: [card([segment('unknown', hour, 2 * hour, '__proto__')], 2 * hour)] }))
    .toContain('>Beyond 1h: __proto__ <span')
  expect(renderTimeline({ ...snapshot, cards: [{ ...card([]), start: null, end: null }] })).not.toContain('class="overflow-button"')
})

test('a filter refresh requested during a fetch is replayed with the latest query', async () => {
  const elements = new Map<string, Record<string, unknown>>()
  const requests: string[] = []
  let finishFirst!: (value: { ok: boolean; text: () => Promise<string> }) => void
  const first = new Promise<{ ok: boolean; text: () => Promise<string> }>(resolve => { finishFirst = resolve })
  const location = { search: '', href: 'http://localhost/' }
  const context = createContext({ location, URLSearchParams, AbortSignal, setInterval: () => 0, clearTimeout,
    window: { addEventListener: () => {} },
    document: { addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { addEventListener: () => {} })
      return elements.get(id)
    } },
    fetch: (url: string) => { requests.push(url); return requests.length === 1 ? first : Promise.resolve({ ok: true, text: async () => 'fresh query results' }) },
  })
  runInContext(TIMELINE_SCRIPT, context)
  const clock = runInContext('formatTimelineClock(new Date(2026, 8, 26, 16, 33).getTime())', context) as string
  expect(clock).toMatch(/^4:33 PM · Sep 26, 2026/)
  expect(clock).toMatch(/(?:UTC|GMT|[A-Z]{2,5}|GMT[+-]\d+)/)
  expect(runInContext('formatTimelineClock(new Date(2026, 8, 26, 23, 59).getTime())', context))
    .toMatch(/^11:59 PM · Sep 26, 2026/)
  expect(runInContext('formatTimelineClock(new Date(2026, 8, 27, 0, 1).getTime())', context))
    .toMatch(/^12:01 AM · Sep 27, 2026/)
  location.search = '?search=latest'
  await runInContext('refresh()', context)
  finishFirst({ ok: true, text: async () => 'old results' })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(requests).toEqual(['/timeline', '/timeline?search=latest'])
  expect(elements.get('timeline')!.innerHTML).toBe('fresh query results')
})
