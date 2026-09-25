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

test('a filter refresh requested during a fetch is replayed with the latest query', async () => {
  const elements = new Map<string, Record<string, unknown>>()
  const requests: string[] = []
  let finishFirst!: (value: { ok: boolean; text: () => Promise<string> }) => void
  const first = new Promise<{ ok: boolean; text: () => Promise<string> }>(resolve => { finishFirst = resolve })
  const location = { search: '', href: 'http://localhost/' }
  const context = createContext({ location, URLSearchParams, AbortSignal, setInterval: () => 0,
    document: { querySelectorAll: () => [], querySelector: () => null, getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { addEventListener: () => {} })
      return elements.get(id)
    } },
    fetch: (url: string) => { requests.push(url); return requests.length === 1 ? first : Promise.resolve({ ok: true, text: async () => 'fresh query results' }) },
  })
  runInContext(TIMELINE_SCRIPT, context)
  location.search = '?search=latest'
  await runInContext('refresh()', context)
  finishFirst({ ok: true, text: async () => 'old results' })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(requests).toEqual(['/timeline', '/timeline?search=latest'])
  expect(elements.get('timeline')!.innerHTML).toBe('fresh query results')
})
