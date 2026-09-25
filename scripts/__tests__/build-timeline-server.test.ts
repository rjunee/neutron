import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTimelineHandler, startTimelineServer, timelineWindow, timelineSourceReader } from '../build-timeline-server.ts'
import { appendPhaseObservation } from '../build-timeline-sources.ts'
import { combineTimelineSources } from '@neutronai/trident/build-timeline-catalogue.ts'
import { projectTimeline, type TimelineSnapshot } from '@neutronai/trident/build-timeline.ts'

const auth = `Basic ${Buffer.from('viewer:test-secret').toString('base64')}`
const snapshot = () => combineTimelineSources({ observedAt: 1000, repositories: [] }, [], [], 1000)

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
    expect(await view.text()).toContain('No PR or run records')
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
  const first = timelineWindow(raw, 0, 'lifecycle'), last = timelineWindow(raw, 1, 'work')
  expect(first.cards).toHaveLength(50)
  expect(first).toMatchObject({ prCount: 51, runOnlyCount: 0 })
  expect(first.warnings.join(' ')).toContain('of 51')
  expect(last.cards).toHaveLength(1)
  expect(last).toMatchObject({ prCount: 51, runOnlyCount: 0 })
  expect(last.cards[0]!.start).toBeNull()
  expect(last.cards[0]!.segments).toHaveLength(0)
  expect(last.page).toBe(1)
  expect(last.totalPages).toBe(2)
  expect(timelineWindow(raw, 900, 'lifecycle').cards).toEqual(timelineWindow(raw, 1, 'lifecycle').cards)
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
  expect(html).toContain('Unpublished run')
  expect(html).toContain('1 PRs · 1 run-only groups')
  const response = await handler(new Request('http://localhost/api/timeline', { headers: { authorization: auth } }))
  expect(response.status).toBe(200)
  const data = await response.json() as TimelineSnapshot
  expect(data).toMatchObject({ prCount: 1, runOnlyCount: 1 })
  expect(data.cards.map((card: { pr: number | null }) => card.pr).sort()).toEqual([42, null])
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
