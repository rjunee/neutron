import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})

describe('direct phase observations', () => {
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
