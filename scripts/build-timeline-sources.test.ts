import { describe, expect, spyOn, test } from 'bun:test'
import { link, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireObservationJournalLock } from './build-timeline-observation-lock.ts'
import {
  appendPhaseObservation,
  appendChangedPhaseObservations,
  collectCiCheckRuns,
  collectPullRequestCatalogue,
  readPhaseObservations,
  refreshPullRequestCatalogue,
  type DirectPhaseObservation,
} from './build-timeline-sources.ts'

const pull = (number: number, state: 'open' | 'closed' = 'open', mergedAt: string | null = null) => ({
  number, title: `PR ${number}`, html_url: `https://example.test/pull/${number}`,
  created_at: '2026-09-01T00:00:00Z', closed_at: state === 'closed' ? '2026-09-02T00:00:00Z' : null,
  merged_at: mergedAt, state, head: { sha: `head-${number}` }, updated_at: '2026-09-02T00:00:00Z',
})

const observation = (overrides: Partial<DirectPhaseObservation> = {}): DirectPhaseObservation => ({
  eventId: 'event-1', phaseId: 'phase-1',
  links: [{ repository: 'example/open', prNumber: 7 }, { repository: 'example/managed', prNumber: 9 }],
  phase: 'test', label: 'focused suite', model: 'model-a',
  startedAt: 1000, endedAt: 2000,
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null,
  source: { kind: 'orchestrator', sessionId: 'session-1', attribution: 'explicit', basis: 'phase boundary' },
  observedAt: 3000,
  ...overrides,
})

const ciBase = Date.parse('2026-09-02T00:00:00Z'), oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40)
const oldCheck = (id = 10): DirectPhaseObservation => observation({
  eventId: `old-${id}`, phaseId: `github-check:example/open#1:${oldHead}:${id}`,
  links: [{ repository: 'example/open', prNumber: 1 }], phase: 'ci', model: null,
  startedAt: ciBase, endedAt: null, observedAt: ciBase + id,
  source: { kind: 'github', sourceEventId: String(id), attribution: 'explicit',
    evidenceRef: `https://github.com/example/open/actions/runs/100/job/${id}`, basis: `check run for PR head ${oldHead}` },
})
const historicalCheck = (id = 10) => ({ id, head_sha: oldHead, name: 'suite', status: 'completed', conclusion: 'cancelled',
  started_at: new Date(ciBase).toISOString(), completed_at: new Date(ciBase + 60_000).toISOString(),
  html_url: `https://github.com/example/open/actions/runs/100/job/${id}` })
async function nextHeadCatalogue() {
  const catalogue = await collectPullRequestCatalogue(['example/open'], {
    fetcher: (async () => Response.json([{ ...pull(1), head: { sha: newHead } }])) as unknown as typeof fetch, now: () => ciBase + 100_000,
  })
  return catalogue
}

async function withLog(run: (file: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'timeline-observations-'))
  try { await run(join(directory, 'observations.ndjson')) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

describe('timeline catalogue', () => {
  test('collects every page and all PR states in each configured repository', async () => {
    const seen: string[] = []
    const fetcher = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      seen.push(`${parsed.pathname}${parsed.search}`)
      const page = Number(parsed.searchParams.get('page'))
      const rows = parsed.pathname.includes('/open/')
        ? page === 1 ? Array.from({ length: 100 }, (_, index) => pull(index + 1))
          : [pull(101, 'closed'), pull(102, 'closed', '2026-09-02T00:00:00Z')]
        : [pull(8)]
      return Response.json(rows)
    }) as typeof fetch
    const result = await collectPullRequestCatalogue(['example/open', 'example/managed'], {
      fetcher, token: 'fixture', now: () => 1234,
    })
    expect(result.observedAt).toBe(1234)
    expect(result.repositories.map((item) => item.prs.length)).toEqual([102, 1])
    expect(result.repositories[0]?.prs.at(-2)?.state).toBe('closed')
    expect(result.repositories[0]?.prs.at(-1)?.state).toBe('merged')
    expect(seen).toHaveLength(3)
    expect(seen.every((path) => path.includes('state=all'))).toBe(true)
  })

  test('marks a failed later page incomplete and keeps other repositories available', async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.includes('/broken/') && parsed.searchParams.get('page') === '2') {
        return new Response('unavailable', { status: 503 })
      }
      return Response.json(parsed.pathname.includes('/broken/')
        ? Array.from({ length: 100 }, (_, index) => pull(index + 1)) : [pull(2)])
    }) as typeof fetch
    const result = await collectPullRequestCatalogue(['example/broken', 'example/healthy'], { fetcher })
    expect(result.repositories[0]?.prs).toEqual([])
    expect(result.repositories[0]?.error).toContain('503')
    expect(result.repositories[1]?.error).toBeNull()
    expect(result.repositories[1]?.prs).toHaveLength(1)
  })

  test('incrementally refreshes changed PRs and retains older baseline until full sweep', async () => {
    const calls: string[] = []
    const fetcher = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      calls.push(parsed.search)
      return Response.json(parsed.search.includes('sort=created')
        ? [pull(1), pull(2)]
        : [{ ...pull(3), updated_at: '2026-09-02T00:00:30Z' },
          { ...pull(1, 'closed'), updated_at: '2026-09-02T00:00:20Z' }])
    }) as typeof fetch
    const baseline = await collectPullRequestCatalogue(['example/open'], {
      fetcher, now: () => Date.parse('2026-09-02T00:00:00Z'),
    })
    const refreshed = await refreshPullRequestCatalogue(baseline, ['example/open'], {
      fetcher, now: () => Date.parse('2026-09-02T00:00:40Z'),
    })
    expect(refreshed.repositories[0]?.prs.map((pr) => pr.number)).toEqual([1, 2, 3])
    expect(refreshed.repositories[0]?.prs[0]?.state).toBe('closed')
    expect(refreshed.fullObservedAt).toBe(baseline.observedAt)
    expect(refreshed.apiRequests).toBe(1)
    expect(calls[1]).toContain('sort=updated')
    const oldPr = refreshed.repositories[0]!.prs.find((pr) => pr.number === 2)!
    oldPr.ciCoverage = 'head-only'
    oldPr.ciObservedAt = refreshed.observedAt
    oldPr.ciPending = true
    oldPr.ciRunning = true
    const incremental = await refreshPullRequestCatalogue(refreshed, ['example/open'], { fetcher, now: () => refreshed.observedAt + 1 })
    expect(incremental.repositories[0]?.prs.find((pr) => pr.number === 2)?.ciRunning).toBe(true)
    const full = await refreshPullRequestCatalogue(refreshed, ['example/open'], {
      fetcher, now: () => baseline.observedAt + 600_000,
    })
    expect(full.repositories[0]?.prs.find((pr) => pr.number === 2)?.ciCoverage).toBe('head-only')
    expect(full.repositories[0]?.prs.find((pr) => pr.number === 2)?.ciRunning).toBe(true)
    expect(full.fullObservedAt).toBe(baseline.observedAt + 600_000)
  })

  test('samples only bounded current heads; parallel checks remain separate lanes and terminal heads are cached', async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/pulls')) return Response.json([pull(1), pull(2), pull(3)])
      return Response.json({ check_runs: [
        { id: 10, name: 'unit', status: 'completed',
          started_at: '2026-09-02T00:00:00Z', completed_at: '2026-09-02T00:01:00Z' },
        { id: 11, name: 'lint', status: 'completed',
          started_at: '2026-09-02T00:00:10Z', completed_at: '2026-09-02T00:00:40Z' },
      ] })
    }) as typeof fetch
    const baseline = await collectPullRequestCatalogue(['example/open'], {
      fetcher, now: () => Date.parse('2026-09-02T00:01:10Z'),
    })
    const first = await collectCiCheckRuns(baseline, {
      fetcher, limit: 1, now: () => Date.parse('2026-09-02T00:01:20Z'),
    })
    expect(first.observations).toHaveLength(2)
    expect(first.observations[0]?.label).toBe('CI · unit')
    expect(first.observations[1]?.startedAt).toBeLessThan(first.observations[0]!.endedAt!)
    expect(first.catalogue.repositories[0]?.prs.filter((pr) => pr.ciCoverage === 'not-sampled')).toHaveLength(2)
    const next = await collectCiCheckRuns(first.catalogue, {
      fetcher: (async () => { throw new Error('cache should avoid fetch') }) as unknown as typeof fetch,
      previous: first.catalogue, limit: 1, now: () => Date.parse('2026-09-02T00:01:50Z'),
    })
    expect(next.observations).toEqual([])
    expect(next.catalogue.repositories[0]?.prs[0]?.ciCoverage).toBe('head-only')
  })

  test('reports zero checks as unknown CI coverage and retries that head', async () => {
    const fetcher = (async (url: string | URL | Request) => Response.json(
      String(url).includes('/check-runs') ? { check_runs: [] } : [pull(1)],
    )) as typeof fetch
    const catalogue = await collectPullRequestCatalogue(['example/open'], { fetcher })
    const result = await collectCiCheckRuns(catalogue, { fetcher, limit: 1 })
    expect(result.observations).toEqual([])
    expect(result.catalogue.repositories[0]?.prs[0]?.ciCoverage).toBe('unavailable')
    expect(result.catalogue.repositories[0]?.prs[0]?.ciError).toContain('No check runs')
  })

  test('only explicit provider statuses establish running or pending check evidence', async () => {
    const base = Date.parse('2026-09-02T00:00:00Z')
    for (const status of ['queued', 'in_progress', 'completed', undefined, 'unexpected']) {
      const fetcher = (async (url: string | URL | Request) => Response.json(String(url).includes('/check-runs') ? {
        check_runs: [{ id: 10, name: 'suite', status, started_at: new Date(base).toISOString(),
          completed_at: status === 'completed' ? new Date(base + 1000).toISOString() : null }],
      } : [pull(1)])) as typeof fetch
      const catalogue = await collectPullRequestCatalogue(['example/open'], { fetcher, now: () => base + 2000 })
      const result = await collectCiCheckRuns(catalogue, { fetcher, now: () => base + 3000 })
      const pr = result.catalogue.repositories[0]!.prs[0]!
      if (status === undefined || status === 'unexpected') {
        expect(pr.ciCoverage).toBe('unavailable')
        expect(result.observations).toHaveLength(0)
      } else {
        expect(pr.ciPending).toBe(status !== 'completed')
        expect(pr.ciRunning).toBe(status === 'in_progress')
      }
    }
  })

  test('collector appends revised GitHub check start snapshots through completion', async () => withLog(async (file) => {
    let cycle = 0
    const base = Date.parse('2026-09-02T00:00:00Z')
    const fetcher = (async (url: string | URL | Request) => Response.json(String(url).includes('/check-runs') ? {
      check_runs: [{ id: 10, name: 'suite', status: cycle === 2 ? 'completed' : 'in_progress',
        started_at: new Date(base + (cycle === 0 ? 0 : 3000)).toISOString(),
        completed_at: cycle === 2 ? new Date(base + 60000).toISOString() : null }],
    } : [pull(1)])) as typeof fetch
    let previous = await collectPullRequestCatalogue(['example/open'], { fetcher, now: () => base })
    for (cycle = 0; cycle < 3; cycle++) {
      const result = await collectCiCheckRuns(previous, { previous, fetcher, now: () => base + 30000 * (cycle + 1) })
      expect(result.catalogue.repositories[0]?.prs[0]?.ciRunning).toBe(cycle !== 2)
      expect(result.catalogue.repositories[0]?.prs[0]?.ciPending).toBe(cycle !== 2)
      expect(await appendChangedPhaseObservations(file, result.observations)).toBe(1)
      previous = result.catalogue
    }
    const latest = await readPhaseObservations(file)
    expect(latest).toHaveLength(1)
    expect(latest[0]).toMatchObject({ startedAt: base + 3000, endedAt: base + 60000,
      phaseId: 'github-check:example/open#1:head-1:10', source: { sourceEventId: '10' } })
    const history = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(history.map(row => row.startedAt)).toEqual([base, base + 3000, base + 3000])
    expect(new Set(history.map(row => row.eventId)).size).toBe(3)
  }))

  test('superseded in-progress check closes at actual cancelled completion without changing current-head readiness', async () => withLog(async file => {
    await appendPhaseObservation(file, oldCheck())
    const before = await readFile(file, 'utf8'), calls: string[] = []
    const result = await collectCiCheckRuns(await nextHeadCatalogue(), {
      observations: await readPhaseObservations(file), now: () => ciBase + 120_000,
      fetcher: (async url => {
        calls.push(new URL(String(url)).pathname)
        return Response.json(String(url).includes('/commits/') ? { check_runs: [{ ...historicalCheck(20), head_sha: newHead, conclusion: 'success' }] } : historicalCheck())
      }) as typeof fetch,
    })
    expect(calls).toEqual([`/repos/example/open/commits/${newHead}/check-runs`, '/repos/example/open/check-runs/10'])
    expect(result.catalogue.repositories[0]!.prs[0]).toMatchObject({ headSha: newHead, ciRunning: false, ciPending: false, ciCoverage: 'head-only' })
    expect(await appendChangedPhaseObservations(file, result.observations)).toBe(2)
    const closed = (await readPhaseObservations(file)).find(r => r.phaseId === oldCheck().phaseId)!
    expect(closed).toMatchObject({ startedAt: ciBase, endedAt: ciBase + 60_000, inputTokens: null, costUsd: null })
    expect((await readFile(file, 'utf8')).startsWith(before)).toBe(true)
    const next = await collectCiCheckRuns(result.catalogue, { previous: result.catalogue, observations: await readPhaseObservations(file),
      now: () => ciBase + 130_000, fetcher: (async () => { throw new Error('terminal checks must not be polled again') }) as unknown as typeof fetch })
    expect(next.observations).toEqual([])
    expect(next.catalogue.apiRequests).toBe(result.catalogue.apiRequests)
  }))

  test('known still-running superseded check stays open while the current head is terminal', async () => {
    const result = await collectCiCheckRuns(await nextHeadCatalogue(), { observations: [oldCheck()], now: () => ciBase + 120_000,
      fetcher: (async url => Response.json(String(url).includes('/commits/') ? { check_runs: [{ ...historicalCheck(20), head_sha: newHead }] }
        : { ...historicalCheck(), status: 'in_progress', conclusion: null, completed_at: null })) as typeof fetch })
    expect(result.observations.some(r => r.phaseId === oldCheck().phaseId)).toBe(false)
    expect(result.catalogue.historicalCiRetries).toEqual([{ phaseId: oldCheck().phaseId, lastAttemptAt: ciBase + 120_000,
      nextAttemptAt: ciBase + 180_000, failures: 0, outcome: 'pending' }])
    expect(result.catalogue.repositories[0]!.prs[0]).toMatchObject({ ciRunning: false, ciPending: false })
  })

  test('genuine check and Actions URLs close after a push, including canonical repository case', async () => {
    for (const path of ['runs/10', 'actions/runs/100', 'actions/runs/100/job/10']) {
      const record = oldCheck()
      record.source.evidenceRef = `https://github.com/example/open/${path}`
      const result = await collectCiCheckRuns(await nextHeadCatalogue(), { observations: [record], now: () => ciBase + 120_000,
        fetcher: (async url => Response.json(String(url).includes('/commits/') ? { check_runs: [] }
          : { ...historicalCheck(), html_url: `https://github.com/Example/Open/${path}` })) as typeof fetch })
      expect(result.observations).toHaveLength(1)
      expect(result.observations[0]).toMatchObject({ phaseId: record.phaseId, endedAt: ciBase + 60_000 })
      expect(result.catalogue.historicalCiRetries).toEqual([])
    }
  })

  test('foreign or mismatched check URL evidence cannot close a historical interval', async () => {
    for (const html_url of ['https://github.com/example/foreign/runs/10', 'https://github.com/example/open/runs/11',
      'https://github.com/example/open/actions/runs/200/job/10', 'https://github.com.evil.test/example/open/runs/10',
      'https://github.com@example.test/example/open/runs/10', 'https://github.com/example/open/../foreign/runs/10']) {
      const result = await collectCiCheckRuns(await nextHeadCatalogue(), { observations: [oldCheck()], now: () => ciBase + 120_000,
        fetcher: (async url => Response.json(String(url).includes('/commits/') ? { check_runs: [] } : { ...historicalCheck(), html_url })) as typeof fetch })
      expect(result.observations).toEqual([])
      expect(result.catalogue.historicalCiRetries?.[0]?.outcome).toBe('unavailable')
    }
  })

  test('a day of failed lookups backs off durably without growing or refreshing phase evidence', async () => withLog(async file => {
    await appendPhaseObservation(file, oldCheck())
    const before = await readFile(file, 'utf8'), original = await readPhaseObservations(file)
    let previous = await nextHeadCatalogue(), attempts = 0
    for (let minute = 0; minute < 24 * 60; minute++) {
      const result = await collectCiCheckRuns(await nextHeadCatalogue(), { previous, observations: original,
        now: () => ciBase + 120_000 + minute * 60_000,
        fetcher: (async url => {
          if (String(url).includes('/commits/')) return Response.json({ check_runs: [] })
          attempts++; return new Response('unavailable', { status: 404 })
        }) as typeof fetch })
      expect(result.observations).toEqual([])
      if (result.observations.length) await appendChangedPhaseObservations(file, result.observations)
      previous = JSON.parse(JSON.stringify(result.catalogue))
    }
    expect(attempts).toBe(29)
    expect(previous.historicalCiRetries).toHaveLength(1)
    expect(previous.historicalCiRetries?.[0]).toMatchObject({ failures: 7, outcome: 'unavailable' })
    expect(previous.historicalCiRetries![0]!.nextAttemptAt - previous.historicalCiRetries![0]!.lastAttemptAt).toBe(3_600_000)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readPhaseObservations(file)).toEqual(original)
    const completed = await collectCiCheckRuns(await nextHeadCatalogue(), { previous, observations: original,
      now: () => ciBase + 120_000 + 25 * 3_600_000,
      fetcher: (async url => Response.json(String(url).includes('/commits/') ? { check_runs: [] } : historicalCheck())) as typeof fetch })
    expect(await appendChangedPhaseObservations(file, completed.observations)).toBe(1)
    expect((await readPhaseObservations(file))[0]).toMatchObject({ startedAt: ciBase, endedAt: ciBase + 60_000 })
    expect(completed.catalogue.historicalCiRetries).toEqual([])
    expect((await readFile(file, 'utf8')).startsWith(before)).toBe(true)
  }))

  test('unchanged running evidence stays unchanged, but a provider start revision appends once', async () => withLog(async file => {
    await appendPhaseObservation(file, oldCheck())
    let previous = await nextHeadCatalogue()
    for (let cycle = 0; cycle < 3; cycle++) {
      const result = await collectCiCheckRuns(await nextHeadCatalogue(), { previous, observations: await readPhaseObservations(file),
        now: () => ciBase + 120_000 + cycle * 60_000,
        fetcher: (async url => Response.json(String(url).includes('/commits/') ? { check_runs: [] } : {
          ...historicalCheck(), status: 'in_progress', conclusion: null, completed_at: null,
          started_at: new Date(ciBase + (cycle ? 3000 : 0)).toISOString(),
        })) as typeof fetch })
      expect(await appendChangedPhaseObservations(file, result.observations)).toBe(cycle === 1 ? 1 : 0)
      previous = JSON.parse(JSON.stringify(result.catalogue))
    }
    expect((await readPhaseObservations(file))[0]).toMatchObject({ startedAt: ciBase + 3000, endedAt: null, observedAt: ciBase + 180_000 })
  }))

  test('malformed durable retries cannot defer known historical checks', async () => {
    const valid = { phaseId: oldCheck().phaseId, lastAttemptAt: ciBase + 119_000, nextAttemptAt: ciBase + 179_000, failures: 1, outcome: 'unavailable' }
    for (const metadata of [null, {}, [null], [{ ...valid, phaseId: 'foreign' }], [valid, valid],
      [{ ...valid, lastAttemptAt: ciBase + 121_000 }], [{ ...valid, nextAttemptAt: Number.MAX_SAFE_INTEGER }],
      [{ ...valid, failures: 8 }], [{ ...valid, outcome: 'completed' }], [{ ...valid, failures: 0 }]]) {
      const previous = await nextHeadCatalogue()
      previous.historicalCiRetries = metadata as unknown as NonNullable<typeof previous.historicalCiRetries>
      const result = await collectCiCheckRuns(await nextHeadCatalogue(), { previous, observations: [oldCheck(), oldCheck(11)], now: () => ciBase + 120_000,
        fetcher: (async url => Response.json(String(url).includes('/commits/') ? { check_runs: [] }
          : historicalCheck(Number(String(url).split('/').at(-1))))) as typeof fetch })
      expect(result.observations).toHaveLength(2)
      expect(result.catalogue.historicalCiRetries).toEqual([])
    }
  })

  test('missing, failed, foreign and invalid historical check evidence retains unknown completion', async () => {
    const replies = [new Response('missing', { status: 404 }), new Response('failed', { status: 503 }),
      Response.json({}), Response.json({ ...historicalCheck(), id: 99 }), Response.json({ ...historicalCheck(), head_sha: newHead }),
      Response.json({ ...historicalCheck(), html_url: 'https://github.com/example/foreign/actions/runs/100/job/10' }),
      Response.json({ ...historicalCheck(), status: 'unexpected' }), Response.json({ ...historicalCheck(), completed_at: null }),
      Response.json({ ...historicalCheck(), started_at: 'invalid' }), Response.json({ ...historicalCheck(), completed_at: new Date(ciBase - 1).toISOString() }),
      Response.json({ ...historicalCheck(), completed_at: new Date(ciBase + 900_000).toISOString() })]
    for (const reply of replies) {
      const result = await collectCiCheckRuns(await nextHeadCatalogue(), { observations: [oldCheck()], now: () => ciBase + 120_000,
        fetcher: (async url => String(url).includes('/commits/') ? Response.json({ check_runs: [] }) : reply) as typeof fetch })
      expect(result.observations).toEqual([])
      expect(result.catalogue.historicalCiRetries?.[0]).toMatchObject({ phaseId: oldCheck().phaseId, failures: 1, outcome: 'unavailable' })
    }
  })

  test('historical polling is bounded and persisted attempts rotate failures and running checks fairly', async () => withLog(async file => {
    for (const id of [10, 11, 12]) await appendPhaseObservation(file, oldCheck(id))
    const calls: number[] = []
    let previous = await nextHeadCatalogue()
    for (let cycle = 0; cycle < 4; cycle++) {
      const result = await collectCiCheckRuns(await nextHeadCatalogue(), { previous, limit: 1, observations: await readPhaseObservations(file), now: () => ciBase + 120_000 + cycle * 60_000,
        fetcher: (async url => {
          const path = new URL(String(url)).pathname
          if (path.includes('/commits/')) return Response.json({ check_runs: [] })
          const id = Number(path.split('/').at(-1)); calls.push(id)
          return id === 10 ? new Response('missing', { status: 404 }) : Response.json({ ...historicalCheck(id), status: 'in_progress', conclusion: null, completed_at: null })
        }) as typeof fetch })
      expect(result.catalogue.apiRequests).toBe(3) // one catalogue, one current head, one known old check
      expect(result.observations).toHaveLength(0)
      expect(await appendChangedPhaseObservations(file, result.observations)).toBe(0)
      previous = JSON.parse(JSON.stringify(result.catalogue))
    }
    expect(calls).toEqual([10, 11, 12, 10])
    expect((await readPhaseObservations(file)).every(r => r.endedAt === null)).toBe(true)
  }))

  test('non-provider, ambiguous and unavailable-repository observations cannot create historical requests', async () => {
    const variants = [oldCheck(), oldCheck(), oldCheck(), oldCheck()]
    variants[0]!.source.kind = 'orchestrator'
    variants[1]!.links.push({ repository: 'example/other', prNumber: 2 })
    variants[2]!.phaseId = `github-check:example/open#1:${newHead}:10`
    variants[3]!.phaseId = `github-check:example/open#1:not-a-head:10`
    const catalogue = await nextHeadCatalogue()
    const result = await collectCiCheckRuns(catalogue, { observations: variants, now: () => ciBase + 120_000,
      fetcher: (async url => { expect(String(url)).toContain('/commits/'); return Response.json({ check_runs: [] }) }) as typeof fetch })
    expect(result.observations).toEqual([])
    catalogue.repositories[0]!.error = 'unavailable'
    expect((await collectCiCheckRuns(catalogue, { observations: [oldCheck()], fetcher: (async () => { throw new Error('must not query failed repository') }) as unknown as typeof fetch })).observations).toEqual([])
  })

  test('historical lookup deadline stops work without fabricating observations for unattempted checks', async () => {
    const catalogue = await nextHeadCatalogue(), calls: string[] = []
    const clock = spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(15_001)
    try {
      const result = await collectCiCheckRuns(catalogue, { observations: [oldCheck(10), oldCheck(11)], now: () => ciBase + 120_000,
        fetcher: (async (url, init) => {
          if (String(url).includes('/commits/')) return Response.json({ check_runs: [] })
          calls.push(String(url)); expect(init?.signal).toBeInstanceOf(AbortSignal)
          return new Response('failed', { status: 503 })
        }) as typeof fetch })
      expect(calls).toHaveLength(1)
      expect(result.observations).toEqual([])
      expect(result.catalogue.historicalCiRetries?.map(r => r.phaseId)).toEqual([oldCheck(10).phaseId])
    } finally { clock.mockRestore() }
  })
})

describe('direct phase observations', () => {
  test('shared lock refuses a live writer, then recovers after SIGKILL without replacing its inode', async () => withLog(async (file) => {
    const ready = `${file}.ready`
    const holderScript = `${file}.holder.ts`
    await writeFile(holderScript, `
      import { writeFileSync } from 'node:fs'
      import { acquireObservationJournalLock } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'build-timeline-observation-lock.ts')).href)}
      const release = acquireObservationJournalLock(${JSON.stringify(file)})
      writeFileSync(${JSON.stringify(ready)}, 'held')
      await Bun.sleep(60_000)
      release()
    `)
    const holder = Bun.spawn([process.execPath, holderScript], { stdout: 'ignore', stderr: 'pipe' })
    try {
      const deadline = Date.now() + 3000
      while (!(await Bun.file(ready).exists())) {
        if (Date.now() > deadline) throw new Error('lock holder did not start')
        await Bun.sleep(10)
      }
      await expect(appendPhaseObservation(file, observation())).rejects.toThrow('lock unavailable')
    } finally {
      holder.kill('SIGKILL')
      await holder.exited
    }
    const before = await stat(`${file}.lock`)
    await appendPhaseObservation(file, observation())
    const after = await stat(`${file}.lock`)
    expect(after.ino).toBe(before.ino)
    expect((await readPhaseObservations(file)).map(row => row.eventId)).toEqual(['event-1'])
  }))

  test('legacy and foreign lock markers fail closed, rather than guessed stale', async () => withLog(async (file) => {
    await writeFile(`${file}.lock`, '')
    await expect(appendPhaseObservation(file, observation())).rejects.toThrow('lock unavailable')
    await writeFile(`${file}.lock`, 'foreign')
    await expect(appendPhaseObservation(file, observation())).rejects.toThrow('lock unavailable')
    expect(await Bun.file(file).exists()).toBe(false)
  }))

  test('SIGKILL after atomic publication but before temp unlink retains one usable lock inode', async () => withLog(async (file) => {
    const temporary = `${file}.lock.publication.tmp`
    await writeFile(temporary, 'neutron-observation-lock-v2\n', { mode: 0o600 })
    await link(temporary, `${file}.lock`)
    const before = await stat(`${file}.lock`)
    expect(before.nlink).toBe(2)
    const release = acquireObservationJournalLock(file)
    try { await expect(appendPhaseObservation(file, observation())).rejects.toThrow('lock unavailable') }
    finally { release() }
    await appendPhaseObservation(file, observation())
    expect((await stat(`${file}.lock`)).ino).toBe(before.ino)
    expect((await readPhaseObservations(file)).map(row => row.eventId)).toEqual(['event-1'])
  }))

  test('timestamp revisions stay forbidden outside exact GitHub CI check identity', async () => withLog(async (file) => {
    await appendPhaseObservation(file, observation())
    await expect(appendPhaseObservation(file, observation({ eventId: 'revised', observedAt: 4000, startedAt: 1001 })))
      .rejects.toThrow('conflicting phase identity')
    const check = observation({ eventId: 'check', phaseId: 'github-check:example/open#7:head:10', phase: 'ci',
      source: { kind: 'github', sourceEventId: '10', attribution: 'explicit', basis: 'check run' } })
    await appendPhaseObservation(file, check)
    await expect(appendPhaseObservation(file, { ...check, eventId: 'wrong-check', observedAt: 4000,
      source: { ...check.source, sourceEventId: '11' } })).rejects.toThrow('conflicting phase identity')
    const other = { ...check, eventId: 'other', phaseId: 'other-github-event' }
    await appendPhaseObservation(file, other)
    await expect(appendPhaseObservation(file, { ...other, eventId: 'other-revised', observedAt: 4000, startedAt: 1001 }))
      .rejects.toThrow('conflicting phase identity')
    expect((await readPhaseObservations(file)).map(row => row.startedAt)).toEqual([1000, 1000, 1000])
  }))
  test('keeps unknown measurements null and explicit zero observed', async () => withLog(async (file) => {
    expect(await readPhaseObservations(file)).toEqual([])
    await appendPhaseObservation(file, observation())
    expect((await readPhaseObservations(file))[0]?.inputTokens).toBeNull()
    await appendPhaseObservation(file, observation({
      eventId: 'event-2', observedAt: 4000,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
    }))
    const latest = await readPhaseObservations(file)
    expect(latest).toHaveLength(1)
    expect(latest[0]?.inputTokens).toBe(0)
    expect(latest[0]?.links).toHaveLength(2)
  }))

  test('only exact native task models may revise; ownership, category, source and start remain immutable', async () => withLog(async (file) => {
    const task = observation({ phaseId: 'codex-turn:session:turn', model: 'model-a',
      source: { kind: 'codex-log', sessionId: 'session', turnId: 'turn', sourceEventId: 'turn',
        attribution: 'reconstructed', evidenceRef: 'codex:fixture', basis: 'native task snapshot' } })
    await appendPhaseObservation(file, task)
    const revised = { ...task, eventId: 'revised-model', observedAt: 4000, model: null }
    await appendPhaseObservation(file, revised)
    expect((await readPhaseObservations(file))[0]!.model).toBeNull()
    for (const mutation of [
      { startedAt: 999 }, { phase: 'review' }, { links: [{ repository: 'example/other', prNumber: 9 }] },
      { source: { ...task.source, turnId: 'other' } }, { source: { ...task.source, sourceEventId: 'other' } },
    ]) await expect(appendPhaseObservation(file, { ...revised, eventId: 'bad', observedAt: 5000, ...mutation })).rejects.toThrow('conflicting phase identity')
    await expect(appendPhaseObservation(file, { ...revised, eventId: 'tied', model: 'model-b' })).rejects.toThrow('ambiguous phase snapshot')
    const command = { ...task, phaseId: 'codex:session:command', eventId: 'command' }
    await appendPhaseObservation(file, command)
    await expect(appendPhaseObservation(file, { ...command, eventId: 'changed-command', observedAt: 5000, model: null })).rejects.toThrow('conflicting phase identity')
  }))

  test('rejects conflicting phase identity and duplicate events, including superseded events', async () => withLog(async (file) => {
    await appendPhaseObservation(file, observation())
    await appendPhaseObservation(file, observation({ eventId: 'event-2', observedAt: 4000 }))
    await expect(appendPhaseObservation(file, observation())).rejects.toThrow('duplicate phase eventId')
    await expect(appendPhaseObservation(file, observation({
      eventId: 'event-3', phase: 'deploy', observedAt: 5000,
    }))).rejects.toThrow('conflicting phase identity')
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(2)
  }))

  test('refuses negative counts, unreferenced attribution, and malformed stored lines', async () => withLog(async (file) => {
    await expect(appendPhaseObservation(file, observation({ inputTokens: -1 }))).rejects.toThrow('inputTokens')
    await expect(appendPhaseObservation(file, observation({
      source: { kind: 'codex-log', attribution: 'reconstructed', basis: 'shell operation' },
    }))).rejects.toThrow('evidence reference')
    await writeFile(file, '{bad json}\n')
    await expect(readPhaseObservations(file)).rejects.toThrow('invalid observation line 1')
  }))

  test('polling only appends a changed check snapshot', async () => withLog(async (file) => {
    const initial = observation({ phase: 'ci', endedAt: null })
    expect(await appendChangedPhaseObservations(file, [initial])).toBe(1)
    expect(await appendChangedPhaseObservations(file, [observation({
      phase: 'ci', endedAt: null, eventId: 'event-2', observedAt: 4000,
    })])).toBe(0)
    expect(await appendChangedPhaseObservations(file, [observation({
      phase: 'ci', endedAt: 2500, eventId: 'event-3', observedAt: 5000,
    })])).toBe(1)
    expect((await readPhaseObservations(file))[0]?.endedAt).toBe(2500)
  }))
})
