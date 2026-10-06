import { expect, spyOn, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTimelineHandler, startTimelineServer, timelineWindow, timelineSourceReader } from '../build-timeline-server.ts'
import { appendPhaseObservation, appendChangedPhaseObservations, collectCiCheckRuns, collectPullRequestCatalogue, readPhaseObservations } from '../build-timeline-sources.ts'
import { combineTimelineSources } from '@neutronai/trident/build-timeline-catalogue.ts'
import { projectTimeline, type TimelineSnapshot } from '@neutronai/trident/build-timeline.ts'

const auth = `Basic ${Buffer.from('viewer:test-secret').toString('base64')}`
const snapshot = () => combineTimelineSources({ observedAt: 1000, repositories: [] }, [], [], 1000)

test('authenticated API keeps superseded cancelled CI duration fixed across later reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timeline-superseded-check-'))
  const observations = join(dir, 'observations.ndjson'), catalogueFile = join(dir, 'catalogue.json')
  const now = Date.now(), oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40), phaseId = `github-check:example/open#7:${oldHead}:10`
  try {
    await appendPhaseObservation(observations, { eventId: 'old-open', phaseId, links: [{ repository: 'example/open', prNumber: 7 }],
      phase: 'ci', model: null, startedAt: now - 120_000, endedAt: null, observedAt: now - 60_000,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null,
      source: { kind: 'github', sourceEventId: '10', attribution: 'explicit', basis: `check run for PR head ${oldHead}`,
        evidenceRef: 'https://github.com/example/open/actions/runs/100/job/10' } })
    const catalogue = await collectPullRequestCatalogue(['example/open'], { now: () => now,
      fetcher: (async () => Response.json([{ number: 7, title: 'Superseded check', html_url: 'https://github.com/example/open/pull/7',
        created_at: new Date(now - 180_000).toISOString(), closed_at: null, merged_at: null, state: 'open',
        head: { sha: newHead }, updated_at: new Date(now).toISOString() }])) as unknown as typeof fetch })
    const result = await collectCiCheckRuns(catalogue, { observations: await readPhaseObservations(observations), now: () => now,
      fetcher: (async url => Response.json(String(url).includes('/commits/') ? { check_runs: [{ id: 20, name: 'current suite', status: 'completed',
        started_at: new Date(now - 50_000).toISOString(), completed_at: new Date(now - 40_000).toISOString() }] } : {
        id: 10, head_sha: oldHead, name: 'old suite', status: 'completed', conclusion: 'cancelled',
        started_at: new Date(now - 120_000).toISOString(), completed_at: new Date(now - 90_000).toISOString(),
        html_url: 'https://github.com/example/open/actions/runs/100/job/10' })) as typeof fetch })
    await appendChangedPhaseObservations(observations, result.observations)
    await writeFile(catalogueFile, JSON.stringify(result.catalogue))
    const handler = createTimelineHandler({ username: 'viewer', password: 'test-secret', read: timelineSourceReader({ catalogue: catalogueFile, observations, databases: [] }) })
    for (let read = 0; read < 2; read++) {
      const response = await handler(new Request('http://localhost/api/timeline', { headers: { authorization: auth } }))
      expect(response.status).toBe(200)
      const data = await response.json() as TimelineSnapshot, card = data.cards[0]!
      expect(card.segments.find(s => s.id === phaseId)).toMatchObject({ end: now - 90_000, timing: 'recorded', model: null,
        usage: { tokens: null, costUsd: null, coverage: 'unknown' } })
      expect(card.workSignal?.state).toBe('recent')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('page, rendered timeline and JSON all deny anonymous and wrong credentials before reading', async () => {
  let reads = 0
  const handler = createTimelineHandler({ username: 'viewer', password: 'test-secret', read: () => { reads++; return snapshot() } })
  for (const path of ['/', '/timeline', '/api/timeline', '/not-found']) {
    for (const authorization of ['', 'Basic YmFkOmJhZA==', 'Bearer test-secret']) {
      const response = await handler(new Request(`http://localhost${path}`, { headers: { authorization } }))
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toContain('Basic')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  }
  expect(reads).toBe(0)
})

test('authenticated served page refreshes within a minute; view and JSON actually consume the reader', async () => {
  let reads = 0
  const handler = createTimelineHandler({ username: 'viewer', password: 'test-secret', read: () => { reads++; return snapshot() } })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
  try {
    const page = await fetch(`${server.url}`, { headers: { authorization: auth } })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('setInterval(refresh, 30000)')
    expect(html).toContain("fetch('/timeline' + location.search")
    expect(html).toContain('Displayed data may be stale')
    expect(page.headers.get('content-security-policy')).toContain("script-src 'sha256-")
    const view = await fetch(`${server.url}timeline`, { headers: { authorization: auth } })
    expect(view.status).toBe(200)
    expect(await view.text()).toContain('No pull requests match')
    const data = await fetch(`${server.url}api/timeline`, { headers: { authorization: auth } })
    expect(data.status).toBe(200)
    expect(await data.json()).toEqual(snapshot())
    expect(reads).toBe(2)
  } finally { server.stop(true) }
})

test('failures are explicit without leaking source paths; no configured credentials refuses startup', async () => {
  expect(() => startTimelineServer({})).toThrow('TIMELINE_USERNAME is required')
  expect(() => createTimelineHandler({ username: '', password: '', read: snapshot })).toThrow('must be configured')
  const handler = createTimelineHandler({ username: 'viewer', password: 'test-secret', read: () => { throw new Error('/private/source') } })
  const response = await handler(new Request('http://localhost/api/timeline', { headers: { authorization: auth } }))
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain('/private/source')
  expect((await handler(new Request('http://localhost/api/timeline', { method: 'POST', headers: { authorization: auth } }))).status).toBe(405)
  expect((await handler(new Request('http://localhost/nope', { headers: { authorization: auth } }))).status).toBe(404)
})

test('view pagination is explicit and a work window does not manufacture missing phases', () => {
  const raw = combineTimelineSources({ observedAt: 1000, repositories: [{ repository: 'example/open', error: null,
    prs: Array.from({ length: 51 }, (_, index) => ({ number: index + 1, title: `PR ${index + 1}`,
      url: `https://github.com/example/open/pull/${index + 1}`, createdAt: new Date(index).toISOString(),
      closedAt: null, mergedAt: null, state: 'open' })) }] }, [], [], 1000)
  const first = timelineWindow(raw, 0), last = timelineWindow(raw, 1)
  expect(first.cards).toHaveLength(50)
  expect(first).toMatchObject({ prCount: 51, runOnlyCount: 0 })
  expect(first.warnings.join(' ')).toContain('of 51')
  expect(last.cards).toHaveLength(1)
  expect(last).toMatchObject({ prCount: 51, runOnlyCount: 0 })
  expect(last.cards[0]!.start).toBeNull()
  expect(last.cards[0]!.segments).toHaveLength(0)
  expect(last.page).toBe(1)
  expect(last.totalPages).toBe(2)
  expect(timelineWindow(raw, 900).cards).toEqual(timelineWindow(raw, 1).cards)
})

test('authenticated view and API distinguish real PRs from legacy run-only sentinels', async () => {
  const raw = projectTimeline([0, 42].map(pr => ({ id: `run-${pr}`, slug: 'recorded run', phase: 'done',
    pr, published_pr: null, started_at: '2026-09-25T00:00:00Z', last_advanced_at: '2026-09-25T00:01:00Z' })), [], [], [], Date.UTC(2026, 8, 25, 0, 2))
  const combined = combineTimelineSources({ observedAt: raw.observedAt, repositories: [] }, [], [{ repository: 'example/open', snapshot: raw }], raw.observedAt)
  const handler = createTimelineHandler({ username: 'viewer', password: 'test-secret', read: () => combined })
  const view = await handler(new Request('http://localhost/timeline', { headers: { authorization: auth } }))
  expect(view.status).toBe(200)
  const html = await view.text()
  expect(html).not.toContain('PR #0')
  expect(html).not.toContain('/pull/0')
  expect(html).toContain('PR #42')
  expect(html).not.toContain('Unpublished run')
  expect(html).toContain('1 PRs · 1 run-only groups')
  const bookmarked = await handler(new Request('http://localhost/timeline?mode=lifecycle', { headers: { authorization: auth } }))
  expect(await bookmarked.text()).toContain('No phase timing recorded')
  const response = await handler(new Request('http://localhost/api/timeline', { headers: { authorization: auth } }))
  expect(response.status).toBe(200)
  const data = await response.json() as TimelineSnapshot
  expect(data).toMatchObject({ prCount: 1, runOnlyCount: 1 })
  expect(data.cards.map((card: { pr: number | null }) => card.pr).sort()).toEqual([42, null])
})

test('search and repository filters apply before pagination without losing unknown-timing PRs', () => {
  const raw = combineTimelineSources({ observedAt: 1000, repositories: ['example/open', 'example/managed'].map(repository => ({
    repository, error: null, prs: Array.from({ length: 60 }, (_, i) => ({ number: i + 1, title: i === 4 ? 'needle' : 'ordinary',
      url: `https://github.com/${repository}/pull/${i + 1}`, createdAt: new Date(i).toISOString(), closedAt: null, mergedAt: null, state: 'open' })),
  })) }, [], [], 1000)
  const result = timelineWindow(raw, 0, 'needle', 'managed')
  expect(result.cards.map(c => [c.repository, c.pr, c.start])).toEqual([['example/managed', 5, null]])
  expect(result.prCount).toBe(1)
  expect(timelineWindow(raw, 0, 'absent').cards).toHaveLength(0)
  expect(timelineWindow(raw, 1, '', 'open').cards).toHaveLength(10)
})

test('open PRs precede newer merged PRs before paging; focus and fit-all share honest scales', () => {
  const raw = combineTimelineSources({ observedAt: 100_000, repositories: [{ repository: 'example/open', error: null,
    prs: Array.from({ length: 52 }, (_, i) => ({ number: i + 1, title: `PR ${i + 1}`, url: `https://github.com/example/open/pull/${i + 1}`,
      createdAt: new Date(i).toISOString(), closedAt: i === 0 ? null : new Date(i + 1).toISOString(), mergedAt: null, state: i === 0 ? 'open' : 'closed' })) }] }, [], [], 100_000)
  raw.cards.find(c => c.pr === 1)!.segments = [{ id: 'long', runId: '', label: 'Build', phase: 'build', start: 0, end: 46_800_000,
    lane: 0, timing: 'recorded', model: null, detail: 'fixture', usage: { tokens: null, input: null, output: null, cacheRead: null, cacheCreation: null, costUsd: null, source: null, observedAt: null, coverage: 'unknown' } }]
  const focused = timelineWindow(raw, 0), all = timelineWindow(raw, 0, '', '', 'all')
  expect(focused.cards[0]!.pr).toBe(1)
  expect(focused.cards[1]!.pr).toBe(52)
  expect(focused.viewDurationMs).toBe(3_600_000)
  expect(all.viewDurationMs).toBe(46_800_000)
  expect(all.cards).toEqual(focused.cards)
})

test('default authenticated focus makes late recorded work visible while API and fit-all preserve evidence', async () => {
  const hour = 3_600_000
  const raw = combineTimelineSources({ observedAt: 87 * hour, repositories: [{ repository: 'example/open', error: null,
    prs: [{ number: 1, title: 'Late work', url: 'https://github.com/example/open/pull/1', createdAt: new Date(0).toISOString(),
      closedAt: null, mergedAt: null, state: 'open' }] }] }, [], [], 87 * hour)
  raw.cards[0]!.segments = ['ci', 'fix', 'review', 'test'].map((phase, index) => ({ id: phase, runId: '', phase, label: phase,
    start: index ? 86 * hour : 0, end: index ? 87 * hour : 60_000, lane: 0, timing: 'recorded', model: null, detail: 'fixture',
    usage: { tokens: null, input: null, output: null, cacheRead: null, cacheCreation: null, costUsd: null, source: null, observedAt: null, coverage: 'unknown' } }))
  const handler = createTimelineHandler({ username: 'viewer', password: 'test-secret', read: () => raw })
  const get = async (path: string) => handler(new Request(`http://localhost${path}`, { headers: { authorization: auth } }))
  const html = await (await get('/timeline')).text()
  const summary = html.slice(html.indexOf('<summary class="row-summary">'), html.indexOf('</summary>', html.indexOf('<summary class="row-summary">')))
  expect(summary).toContain('>Beyond 1h: Fix · Review · Test ')
  expect(summary).toContain('width:100.00000%')
  expect(html).toContain('0–1h focus window')
  expect(await (await get('/api/timeline')).json()).toEqual(raw)
  expect(await (await get('/timeline?scale=all')).text()).not.toContain('class="overflow-button"')
  raw.cards[0]!.segments = raw.cards[0]!.segments.filter(segment => segment.phase === 'ci')
  expect(await (await get('/timeline')).text()).not.toContain('class="overflow-button"')
})

test('file sources reach authenticated HTML/JSON and import failures preserve catalogue visibility', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timeline-source-'))
  const catalogue = join(dir, 'catalogue.json'), observations = join(dir, 'observations.jsonl'), importStatus = join(dir, 'import.json')
  try {
    const now = Date.now()
    await writeFile(catalogue, JSON.stringify({ observedAt: now, repositories: [{ repository: 'example/open', error: null, prs: [
      { number: 10, title: 'Source consuming test', url: 'https://github.com/example/open/pull/10', state: 'open',
        createdAt: new Date(now - 10000).toISOString(), closedAt: null, mergedAt: null },
    ] }] }))
    await appendPhaseObservation(observations, { eventId: 'e', phaseId: 'p', links: [{ repository: 'example/open', prNumber: 10 }],
      phase: 'test', label: 'Actual suite', model: 'recorded-model', startedAt: now - 5000, endedAt: now - 1000,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null,
      source: { kind: 'codex', attribution: 'explicit', basis: 'Observed command', sourceEventId: 'native-e' }, observedAt: now })
    await writeFile(importStatus, JSON.stringify({ lastSuccessAt: now - 120000, error: 'sensitive raw error' }))
    const read = timelineSourceReader({ catalogue, observations, importStatus, databases: [
      { repository: 'example/other', repoPath: '/example/other', path: join(dir, 'missing.db') },
    ] })
    const handler = createTimelineHandler({ username: 'viewer', password: 'test-secret', read })
    const response = await handler(new Request('http://localhost/timeline', { headers: { authorization: auth } }))
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('Actual suite')
    expect(html).toContain('recorded-model')
    expect(html).toContain('importer is stale or failed')
    expect(html).toContain('Trident records unavailable')
    expect(html).not.toContain('sensitive raw error')
    expect(html).not.toContain(dir)
    await writeFile(observations, 'invalid json')
    const partial = await read()
    expect(partial.cards).toHaveLength(1)
    expect(partial.cards[0]!.segments).toHaveLength(0)
    expect(partial.warnings.join(' ')).toContain('Direct phase observations unavailable')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('fresh partial importer coverage reaches API and expanded HTML without inventing phases or tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timeline-partial-'))
  const catalogue = join(dir, 'catalogue.json'), observations = join(dir, 'observations.jsonl'), importStatus = join(dir, 'import.json')
  try {
    const now = Date.now()
    await writeFile(catalogue, JSON.stringify({ observedAt: now, repositories: [{ repository: 'example/open', error: null, prs: [
      { number: 10, title: 'Known PR without attributed work', url: 'https://github.com/example/open/pull/10', state: 'open',
        createdAt: new Date(now - 10000).toISOString(), closedAt: null, mergedAt: null },
    ] }] }))
    await writeFile(observations, '')
    const read = timelineSourceReader({ catalogue, observations, importStatus, databases: [] })
    const handler = createTimelineHandler({ username: 'viewer', password: 'test-secret', read })
    for (const partial of [true, false]) {
      await writeFile(importStatus, JSON.stringify({ lastSuccessAt: now, error: null, partial,
        coverage: { registered: 2, emitted: 3, unbound: partial ? 7 : 0, incomplete: 0, scanPartial: false },
        privatePath: '/private/never-served', transcript: 'private transcript content' }))
      const response = await handler(new Request('http://localhost/api/timeline', { headers: { authorization: auth } }))
      const data = await response.json() as TimelineSnapshot
      expect(response.status).toBe(200)
      expect(data.cards).toHaveLength(1)
      expect(data.cards[0]!.segments).toHaveLength(0)
      expect(data.cards[0]!.prState).toBe('open')
      const html = await (await handler(new Request('http://localhost/timeline', { headers: { authorization: auth } }))).text()
      expect(html).toContain('PR #10')
      expect(html).toContain('No phase timing recorded')
      if (partial) {
        expect(data.warnings.join(' ')).toContain('7 observations have no verified PR/phase binding')
        expect(data.warnings.join(' ')).toContain('0 registered sources are incomplete')
        expect(data.warnings.join(' ')).not.toContain('stale or failed')
        expect(html).toContain('<details class="source-note" open>')
        expect(html).toContain('Direct phase coverage is partial.')
        expect(html).toContain('7 observations have no verified PR/phase binding')
      } else {
        expect(data.warnings).toEqual([])
        expect(html).not.toContain('Direct phase coverage is partial.')
        expect(html).not.toContain('class="source-note"')
      }
      expect(JSON.stringify(data) + html).not.toContain('/private/never-served')
      expect(JSON.stringify(data) + html).not.toContain('private transcript content')
    }
    for (const status of [{ lastSuccessAt: now, error: null }, { lastSuccessAt: now, error: null, partial: false, coverage: {} }]) {
      await writeFile(importStatus, JSON.stringify(status))
      const data = await (await handler(new Request('http://localhost/api/timeline', { headers: { authorization: auth } }))).json() as TimelineSnapshot
      const html = await (await handler(new Request('http://localhost/timeline', { headers: { authorization: auth } }))).text()
      expect(data.warnings.join(' ')).toContain('coverage is unverified')
      expect(data.warnings.join(' ')).toContain('count unknown')
      expect(data.warnings.join(' ')).not.toContain('stale or failed')
      expect(data.cards[0]!.segments).toHaveLength(0)
      expect(html).toContain('<details class="source-note" open>')
      expect(html).toContain('coverage is unverified')
      expect(html).toContain('count unknown')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('production reader samples importer freshness after a status update during source reads, rejecting future and stale success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timeline-status-clock-'))
  const catalogue = join(dir, 'catalogue.json'), observations = join(dir, 'observations.jsonl'), importStatus = join(dir, 'import.json')
  const startedAt = 100_000, completedAt = startedAt + 10
  const status = (lastSuccessAt: number) => ({ lastSuccessAt, error: null, partial: false,
    coverage: { unbound: 0, incomplete: 0, scanPartial: false } })
  try {
    await writeFile(catalogue, JSON.stringify({ observedAt: startedAt, repositories: [] }))
    await writeFile(observations, '')
    const read = timelineSourceReader({ catalogue, observations, importStatus, databases: [] })
    const handler = createTimelineHandler({ username: 'viewer', password: 'test-secret', read })
    for (const [lastSuccessAt, warns] of [[startedAt + 5, false], [completedAt + 1, true], [completedAt - 60_001, true]] as const) {
      await writeFile(importStatus, JSON.stringify(status(startedAt - 60_001)))
      let clock = startedAt, updated = false
      const now = spyOn(Date, 'now').mockImplementation(() => {
        if (!updated) {
          updated = true
          queueMicrotask(() => {
            writeFileSync(importStatus, JSON.stringify(status(lastSuccessAt)))
            clock = completedAt
          })
        }
        return clock
      })
      try {
        const response = await handler(new Request('http://localhost/api/timeline', { headers: { authorization: auth } }))
        const data = await response.json() as TimelineSnapshot
        expect(response.status).toBe(200)
        expect(updated).toBe(true)
        expect(clock).toBe(completedAt)
        expect(data.warnings.some(warning => warning.includes('stale or failed'))).toBe(warns)
        if (!warns) expect(data.warnings).toEqual([])
      } finally { now.mockRestore() }
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
