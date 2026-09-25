#!/usr/bin/env bun

/** Sources for a build timeline. GitHub describes PRs; only attributed observations describe work. */
import { appendFile, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export type CataloguePullRequest = {
  number: number
  title: string
  url: string
  createdAt: string
  closedAt: string | null
  mergedAt: string | null
  state: 'open' | 'closed' | 'merged'
  headSha: string
  updatedAt: string
  /** Only the listed head is sampled. Earlier pushes remain unknown. */
  ciCoverage: 'not-sampled' | 'head-only' | 'partial' | 'unavailable'
  ciObservedAt: number | null
  ciPending: boolean
  ciError: string | null
}

export type CatalogueSnapshot = {
  observedAt: number
  fullObservedAt: number
  apiRequests: number
  repositories: Array<{
    repository: string
    error: string | null
    prs: CataloguePullRequest[]
  }>
}

export type DirectPhaseObservation = {
  /** Immutable event identity. Later snapshots of one phase use a new eventId. */
  eventId: string
  /** Stable across updates to one phase; distinct for separate attempts or model segments. */
  phaseId: string
  /** Multiple PRs can share one work span; consumers must not sum that span twice. */
  links: Array<{ repository: string; prNumber: number }>
  phase: string
  label?: string
  model: string | null
  startedAt: number
  endedAt: number | null
  /** Absolute counters for this phase segment, never deltas or workflow totals. */
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  costUsd: number | null
  source: {
    kind: 'orchestrator' | 'codex' | 'claude' | 'github' | 'codex-log'
    sessionId?: string
    turnId?: string
    parentSessionId?: string
    sourceEventId?: string
    evidenceRef?: string
    attribution: 'explicit' | 'reconstructed'
    basis: string
  }
  observedAt: number
}

type GithubPull = {
  number?: unknown
  title?: unknown
  html_url?: unknown
  created_at?: unknown
  closed_at?: unknown
  merged_at?: unknown
  state?: unknown
  head?: { sha?: unknown }
  updated_at?: unknown
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function requireRepository(value: string): void {
  if (!repositoryPattern.test(value) || value.includes('..')) {
    throw new Error(`invalid repository identifier: ${value}`)
  }
}

function isoTimestamp(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`GitHub PR has invalid ${field}`)
  }
  return value
}

function cataloguePull(raw: GithubPull): CataloguePullRequest {
  if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(raw.number) || Number(raw.number) < 1 ||
      typeof raw.title !== 'string' || typeof raw.html_url !== 'string' ||
      (raw.state !== 'open' && raw.state !== 'closed')) {
    throw new Error('GitHub PR has invalid identity or state')
  }
  const mergedAt = isoTimestamp(raw.merged_at, 'merged_at', true)
  const closedAt = isoTimestamp(raw.closed_at, 'closed_at', true)
  return {
    number: Number(raw.number), title: raw.title, url: raw.html_url,
    createdAt: isoTimestamp(raw.created_at, 'created_at')!, closedAt, mergedAt,
    state: mergedAt !== null ? 'merged' : raw.state,
    headSha: requiredString(raw.head?.sha, 'GitHub PR head SHA'),
    updatedAt: isoTimestamp(raw.updated_at, 'updated_at')!,
    ciCoverage: 'not-sampled', ciObservedAt: null, ciPending: false, ciError: null,
  }
}

export async function collectPullRequestCatalogue(
  repositories: string[],
  options: { fetcher?: typeof fetch; token?: string; apiUrl?: string; now?: () => number } = {},
): Promise<CatalogueSnapshot> {
  const fetcher = options.fetcher ?? fetch
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  const observedAt = (options.now ?? Date.now)()
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error('invalid observation time')
  const uniqueRepositories = [...new Set(repositories)]
  for (const repository of uniqueRepositories) requireRepository(repository)

  const results: CatalogueSnapshot['repositories'] = []
  let apiRequests = 0
  for (const repository of uniqueRepositories) {
    try {
      const prs: CataloguePullRequest[] = []
      const seen = new Set<number>()
      for (let page = 1; ; page += 1) {
        const path = `/repos/${repository}/pulls?state=all&sort=created&direction=asc&per_page=100&page=${page}`
        apiRequests += 1
        const response = await fetcher(`${apiUrl}${path}`, { headers })
        if (!response.ok) throw new Error(`GitHub API returned ${response.status} on page ${page}`)
        const rows: unknown = await response.json()
        if (!Array.isArray(rows) || rows.length > 100) throw new Error(`GitHub API returned an invalid list on page ${page}`)
        for (const row of rows) {
          const pr = cataloguePull(row as GithubPull)
          if (seen.has(pr.number)) throw new Error(`GitHub API repeated PR #${pr.number}`)
          seen.add(pr.number)
          prs.push(pr)
        }
        if (rows.length < 100) break
      }
      results.push({ repository, error: null, prs })
    } catch (error) {
      // Discard partial pages: an incomplete list must never masquerade as "all PRs".
      results.push({ repository, error: error instanceof Error ? error.message : String(error), prs: [] })
    }
  }
  return { observedAt, fullObservedAt: observedAt, apiRequests, repositories: results }
}

/** Refresh changed PRs between full sweeps, preserving the last verified baseline. */
export async function refreshPullRequestCatalogue(
  previous: CatalogueSnapshot,
  repositories: string[],
  options: { fetcher?: typeof fetch; token?: string; apiUrl?: string; now?: () => number } = {},
): Promise<CatalogueSnapshot> {
  const now = (options.now ?? Date.now)()
  if (!Number.isSafeInteger(previous.fullObservedAt) || now - previous.fullObservedAt >= 600_000 ||
      now < previous.observedAt || repositories.some((repo) =>
        !previous.repositories.some((entry) => entry.repository === repo && entry.error === null))) {
    return collectPullRequestCatalogue(repositories, options)
  }
  const fetcher = options.fetcher ?? fetch
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  const results: CatalogueSnapshot['repositories'] = []
  let apiRequests = 0
  for (const repository of [...new Set(repositories)]) {
    requireRepository(repository)
    const prior = previous.repositories.find((entry) => entry.repository === repository)!
    try {
      const prs = new Map(prior.prs.map((pr) => [pr.number, pr]))
      for (let page = 1; ; page += 1) {
        const path = `/repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`
        apiRequests += 1
        const response = await fetcher(`${apiUrl}${path}`, { headers })
        if (!response.ok) throw new Error(`GitHub API returned ${response.status} on page ${page}`)
        const rows: unknown = await response.json()
        if (!Array.isArray(rows) || rows.length > 100) throw new Error(`GitHub API returned an invalid list on page ${page}`)
        let crossedWatermark = false
        for (const raw of rows) {
          const pr = cataloguePull(raw as GithubPull)
          if (Date.parse(pr.updatedAt) < previous.observedAt - 60_000) crossedWatermark = true
          const old = prs.get(pr.number)
          // Preserve sampled CI status on unchanged heads; the CI sampler applies its own TTL.
          if (old?.headSha === pr.headSha) {
            pr.ciCoverage = old.ciCoverage
            pr.ciObservedAt = old.ciObservedAt
            pr.ciPending = old.ciPending
            pr.ciError = old.ciError
          }
          prs.set(pr.number, pr)
        }
        if (rows.length < 100 || crossedWatermark) break
      }
      results.push({ repository, error: null, prs: [...prs.values()].sort((a, b) => a.number - b.number) })
    } catch (error) {
      // Retained PRs carry a visible stale error until a successful refresh.
      results.push({ repository, error: `stale catalogue: ${error instanceof Error ? error.message : String(error)}`,
        prs: prior.prs })
    }
  }
  return { observedAt: now, fullObservedAt: previous.fullObservedAt, apiRequests, repositories: results }
}

type GithubCheck = {
  id?: unknown
  name?: unknown
  status?: unknown
  started_at?: unknown
  completed_at?: unknown
  html_url?: unknown
}

export type CiCollection = { catalogue: CatalogueSnapshot; observations: DirectPhaseObservation[] }

/** Sample only current heads. Terminal heads are rechecked after a short TTL for late reruns. */
export async function collectCiCheckRuns(
  catalogue: CatalogueSnapshot,
  options: {
    fetcher?: typeof fetch
    token?: string
    apiUrl?: string
    now?: () => number
    previous?: CatalogueSnapshot
    limit?: number
  } = {},
): Promise<CiCollection> {
  const fetcher = options.fetcher ?? fetch
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  const now = (options.now ?? Date.now)()
  const limit = options.limit ?? 20
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 20) throw new Error('CI sample limit must be 0–20')
  const previous = new Map(options.previous?.repositories.flatMap((repo) =>
    repo.prs.map((pr) => [`${repo.repository}#${pr.number}`, pr] as const)) ?? [])
  const eligible = catalogue.repositories.flatMap((repo) =>
    repo.error === null ? repo.prs.map((pr) => ({ repository: repo.repository, pr })) : [])
  eligible.sort((a, b) =>
    Number(b.pr.state === 'open') - Number(a.pr.state === 'open') ||
    Date.parse(b.pr.updatedAt) - Date.parse(a.pr.updatedAt))
  const openQuota = Math.ceil(limit * 0.75)
  const priority = [
    ...eligible.filter(({ pr }) => pr.state === 'open').slice(0, openQuota),
    ...eligible.filter(({ pr }) => pr.state !== 'open').slice(0, limit),
  ]
  const selected = [...priority, ...eligible.filter((candidate) => !priority.includes(candidate))].slice(0, limit)
  const observations: DirectPhaseObservation[] = []
  for (const { repository, pr } of selected) {
    const old = previous.get(`${repository}#${pr.number}`)
    if (old?.headSha === pr.headSha && old.ciObservedAt !== null &&
        old.ciCoverage === 'head-only' && !old.ciPending && now - old.ciObservedAt < 300_000) {
      pr.ciCoverage = old.ciCoverage
      pr.ciObservedAt = old.ciObservedAt
      pr.ciPending = old.ciPending
      continue
    }
    try {
      let partial = false
      let pending = false
      const checkIds = new Set<number>()
      for (let page = 1; ; page += 1) {
        const path = `/repos/${repository}/commits/${pr.headSha}/check-runs?filter=all&per_page=100&page=${page}`
        catalogue.apiRequests += 1
        const response = await fetcher(`${apiUrl}${path}`, { headers })
        if (!response.ok) throw new Error(`GitHub checks API returned ${response.status} on page ${page}`)
        const body: unknown = await response.json()
        if (!isRecord(body) || !Array.isArray(body.check_runs) || body.check_runs.length > 100) {
          throw new Error(`GitHub checks API returned an invalid list on page ${page}`)
        }
        for (const raw of body.check_runs as GithubCheck[]) {
          if (!raw || !Number.isSafeInteger(raw.id) || Number(raw.id) < 1 || typeof raw.name !== 'string') {
            throw new Error('GitHub check run has invalid identity')
          }
          if (checkIds.has(Number(raw.id))) throw new Error('GitHub check run repeated across pages')
          checkIds.add(Number(raw.id))
          if (raw.status !== 'completed') pending = true
          if (raw.started_at === null) { partial = true; continue }
          const startedAt = Date.parse(isoTimestamp(raw.started_at, 'check started_at')!)
          const endedAt = raw.completed_at === null
            ? null : Date.parse(isoTimestamp(raw.completed_at, 'check completed_at')!)
          if (raw.status === 'completed' && endedAt === null) partial = true
          observations.push(validatePhaseObservation({
            eventId: `github-check:${repository}#${pr.number}:${pr.headSha}:${raw.id}:${now}`,
            phaseId: `github-check:${repository}#${pr.number}:${pr.headSha}:${raw.id}`,
            links: [{ repository, prNumber: pr.number }], phase: 'ci', label: `CI · ${raw.name}`,
            model: null, startedAt, endedAt,
            inputTokens: null, outputTokens: null, cacheReadTokens: null,
            cacheCreationTokens: null, costUsd: null,
            source: { kind: 'github', sourceEventId: String(raw.id),
              ...(typeof raw.html_url === 'string' ? { evidenceRef: raw.html_url } : {}),
              attribution: 'explicit', basis: `check run for PR head ${pr.headSha}` },
            observedAt: now,
          }))
        }
        if (body.check_runs.length < 100) break
      }
      pr.ciCoverage = checkIds.size === 0 ? 'unavailable' : partial ? 'partial' : 'head-only'
      pr.ciObservedAt = now
      pr.ciPending = pending
      if (checkIds.size === 0) pr.ciError = 'No check runs reported for sampled head'
    } catch (error) {
      pr.ciCoverage = 'unavailable'
      pr.ciObservedAt = now
      pr.ciError = error instanceof Error ? error.message : String(error)
      // A partial page is not trustworthy; discard this PR's check spans.
      for (let index = observations.length - 1; index >= 0; index -= 1) {
        if (observations[index]?.links.some((link) => link.repository === repository && link.prNumber === pr.number)) {
          observations.splice(index, 1)
        }
      }
    }
  }
  return { catalogue, observations }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`invalid ${name}`)
  return value
}

function epochMs(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`invalid ${name}`)
  return Number(value)
}

function tokenCount(value: unknown, name: string): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`invalid ${name}`)
  return Number(value)
}

/** Validate on both write and read, so a bad imported line cannot become a claimed measurement. */
export function validatePhaseObservation(value: unknown): DirectPhaseObservation {
  if (!isRecord(value)) throw new Error('invalid phase observation')
  const eventId = requiredString(value.eventId, 'eventId')
  const phaseId = requiredString(value.phaseId, 'phaseId')
  const phase = requiredString(value.phase, 'phase')
  if (!Array.isArray(value.links) || value.links.length === 0) throw new Error('phase observation needs PR links')
  const links = value.links.map((link: unknown) => {
    if (!isRecord(link) || typeof link.repository !== 'string' || !Number.isSafeInteger(link.prNumber) ||
        Number(link.prNumber) < 1) throw new Error('invalid PR link')
    requireRepository(link.repository)
    return { repository: link.repository, prNumber: Number(link.prNumber) }
  })
  const linkKeys = links.map((link) => `${link.repository}#${link.prNumber}`)
  if (new Set(linkKeys).size !== links.length) throw new Error('duplicate PR link')
  const startedAt = epochMs(value.startedAt, 'startedAt')
  const endedAt = value.endedAt === null ? null : epochMs(value.endedAt, 'endedAt')
  const observedAt = epochMs(value.observedAt, 'observedAt')
  if (endedAt !== null && endedAt < startedAt) throw new Error('phase ends before it starts')
  if (observedAt < startedAt) throw new Error('observation predates phase start')
  if (endedAt !== null && observedAt < endedAt) throw new Error('observation predates phase end')
  if (value.model !== null && typeof value.model !== 'string') throw new Error('invalid model')
  if (value.label !== undefined && typeof value.label !== 'string') throw new Error('invalid label')
  const inputTokens = tokenCount(value.inputTokens, 'inputTokens')
  const outputTokens = tokenCount(value.outputTokens, 'outputTokens')
  const cacheReadTokens = tokenCount(value.cacheReadTokens, 'cacheReadTokens')
  const cacheCreationTokens = tokenCount(value.cacheCreationTokens, 'cacheCreationTokens')
  let costUsd: number | null = null
  if (value.costUsd !== null) {
    if (typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd) || value.costUsd < 0) {
      throw new Error('invalid costUsd')
    }
    costUsd = value.costUsd
  }
  if (!isRecord(value.source) || !['orchestrator', 'codex', 'claude', 'github', 'codex-log'].includes(String(value.source.kind)) ||
      !['explicit', 'reconstructed'].includes(String(value.source.attribution))) {
    throw new Error('invalid observation source')
  }
  const source = value.source as DirectPhaseObservation['source']
  requiredString(source.basis, 'source basis')
  const refs = [source.sessionId, source.turnId, source.sourceEventId, source.evidenceRef]
  if (!refs.some((ref) => typeof ref === 'string' && ref.trim() !== '')) {
    throw new Error('observation source needs an evidence reference')
  }
  for (const [name, ref] of Object.entries(source)) {
    if (name !== 'kind' && name !== 'attribution' && name !== 'basis' && ref !== undefined) {
      requiredString(ref, `source ${name}`)
    }
  }
  return {
    eventId, phaseId, links, phase,
    ...(value.label === undefined ? {} : { label: value.label as string }),
    model: value.model as string | null, startedAt, endedAt,
    inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd,
    source, observedAt,
  }
}

function identity(record: DirectPhaseObservation): string {
  return JSON.stringify({
    links: [...record.links].sort((a, b) => a.repository.localeCompare(b.repository) || a.prNumber - b.prNumber),
    phase: record.phase, model: record.model, startedAt: record.startedAt,
    sourceKind: record.source.kind, sourceSession: record.source.sessionId ?? null,
    sourceTurn: record.source.turnId ?? null,
  })
}

function resolveObservations(records: DirectPhaseObservation[]): DirectPhaseObservation[] {
  const eventIds = new Set<string>()
  const latest = new Map<string, DirectPhaseObservation>()
  for (const record of records) {
    if (eventIds.has(record.eventId)) throw new Error(`duplicate phase eventId ${record.eventId}`)
    eventIds.add(record.eventId)
    const previous = latest.get(record.phaseId)
    if (previous && identity(previous) !== identity(record)) {
      throw new Error(`conflicting phase identity ${record.phaseId}`)
    }
    if (!previous || record.observedAt > previous.observedAt) latest.set(record.phaseId, record)
    else if (record.observedAt === previous.observedAt) throw new Error(`ambiguous phase snapshot ${record.phaseId}`)
  }
  return [...latest.values()].sort((a, b) => a.startedAt - b.startedAt || a.phaseId.localeCompare(b.phaseId))
}

async function readObservationEvents(file: string): Promise<DirectPhaseObservation[]> {
  let contents: string
  try {
    contents = await readFile(file, 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return []
    throw error
  }
  const records = contents.split(/\r?\n/).filter((line) => line.trim() !== '').map((line, index) => {
    try { return validatePhaseObservation(JSON.parse(line)) }
    catch (error) { throw new Error(`invalid observation line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`) }
  })
  return records
}

export async function readPhaseObservations(file: string): Promise<DirectPhaseObservation[]> {
  return resolveObservations(await readObservationEvents(file))
}

export async function appendPhaseObservation(file: string, value: DirectPhaseObservation): Promise<void> {
  const observation = validatePhaseObservation(value)
  // Exclusive lock makes duplicate/conflict checking and append one operation across writers.
  const lockFile = `${file}.lock`
  const lock = await open(lockFile, 'wx')
  try {
    resolveObservations([...await readObservationEvents(file), observation])
    await appendFile(file, `${JSON.stringify(observation)}\n`, { encoding: 'utf8', flag: 'a' })
  } finally {
    await lock.close()
    await unlink(lockFile)
  }
}

/** A polling collector only writes when a check's measured state changes. */
export async function appendChangedPhaseObservations(
  file: string, values: DirectPhaseObservation[],
): Promise<number> {
  const current = new Map((await readPhaseObservations(file)).map((record) => [record.phaseId, record]))
  let appended = 0
  for (const value of values) {
    const record = validatePhaseObservation(value)
    const old = current.get(record.phaseId)
    if (old) {
      const comparable = (item: DirectPhaseObservation) => {
        const { eventId: _eventId, observedAt: _observedAt, ...rest } = item
        return JSON.stringify(rest)
      }
      if (comparable(old) === comparable(record)) continue
    }
    await appendPhaseObservation(file, record)
    current.set(record.phaseId, record)
    appended += 1
  }
  return appended
}

async function writeSnapshot(file: string, snapshot: CatalogueSnapshot): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, file)
}

function cliOptions(args: string[]): { command: string; file: string; observationsFile: string | null; repositories: string[] } {
  const [command, ...rest] = args
  if (command !== 'catalogue' && command !== 'record') {
    throw new Error('usage: build-timeline-sources.ts catalogue --repo owner/name --output file | record --output file < observation.json')
  }
  const repositories: string[] = []
  let file = ''
  let observationsFile: string | null = null
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!value) throw new Error(`missing value for ${flag}`)
    if (flag === '--repo') repositories.push(value)
    else if (flag === '--output') file = value
    else if (flag === '--observations') observationsFile = value
    else throw new Error(`unknown option ${flag}`)
  }
  if (!file || (command === 'catalogue' && repositories.length === 0) ||
      (command === 'record' && (repositories.length > 0 || observationsFile !== null))) {
    throw new Error('missing or incompatible command options')
  }
  return { command, file, observationsFile, repositories }
}

if (import.meta.main) {
  try {
    const { command, file, observationsFile, repositories } = cliOptions(process.argv.slice(2))
    if (command === 'catalogue') {
      const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
      let previous: CatalogueSnapshot | undefined
      try { previous = JSON.parse(await readFile(file, 'utf8')) as CatalogueSnapshot }
      catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error
      }
      const options = { ...(token ? { token } : {}) }
      let snapshot = previous
        ? await refreshPullRequestCatalogue(previous, repositories, options)
        : await collectPullRequestCatalogue(repositories, options)
      if (observationsFile !== null) {
        const collected = await collectCiCheckRuns(snapshot, { ...options, ...(previous ? { previous } : {}) })
        snapshot = collected.catalogue
        await appendChangedPhaseObservations(observationsFile, collected.observations)
      }
      await writeSnapshot(file, snapshot)
      if (snapshot.repositories.some((repository) => repository.error !== null)) process.exitCode = 2
    } else {
      const input = await Bun.stdin.text()
      await appendPhaseObservation(file, JSON.parse(input))
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
