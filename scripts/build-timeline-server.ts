import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { openTimelineReader, type TimelineSnapshot } from '../trident/build-timeline.ts'
import { combineTimelineSources, type PrCatalogue } from '../trident/build-timeline-catalogue.ts'
import { renderTimeline, TIMELINE_PAGE, TIMELINE_SCRIPT } from '../trident/build-timeline-html.ts'
import { readPhaseObservations } from './build-timeline-sources.ts'

export interface TimelineServerOptions {
  username: string
  password: string
  read: () => TimelineSnapshot | Promise<TimelineSnapshot>
}

export function timelineWindow(snapshot: TimelineSnapshot, page: number, mode: string): TimelineSnapshot {
  const pageSize = 50
  const total = snapshot.cards.length
  const first = Math.min(Math.max(0, Math.floor(page)) * pageSize, Math.max(0, Math.floor((total - 1) / pageSize) * pageSize))
  const cards = snapshot.cards.slice(first, first + pageSize).map(card => {
    if (mode !== 'work') return card
    if (!card.segments.length) return { ...card, start: null, end: null, gaps: [] }
    const start = Math.min(...card.segments.map(span => span.start)), end = Math.max(...card.segments.map(span => span.end))
    return { ...card, start, end, gaps: card.gaps.map(gap => ({ start: Math.max(start, gap.start), end: Math.min(end, gap.end) })).filter(gap => gap.end > gap.start) }
  })
  return { ...snapshot, cards, page: Math.floor(first / pageSize), totalPages: Math.max(1, Math.ceil(total / pageSize)),
    maxDurationMs: Math.max(1, ...cards.map(card => card.start === null || card.end === null ? 0 : card.end - card.start)),
    warnings: [...snapshot.warnings, `Showing ${total ? first + 1 : 0}–${Math.min(first + pageSize, total)} of ${total} PR / run groups. Page ${Math.floor(first / pageSize) + 1} of ${Math.max(1, Math.ceil(total / pageSize))}. ${mode === 'work' ? 'Observed-work window; PRs without phase evidence have unknown work duration.' : 'PR lifecycle / run envelope; gaps are not proven build time.'}`] }
}

/** One credential gate covers the page, fragment, JSON and unknown routes alike. */
export function createTimelineHandler(options: TimelineServerOptions): (request: Request) => Promise<Response> {
  if (!options.username.trim() || options.username.includes(':') || !options.password.trim()) {
    throw new Error('Timeline Basic credentials must be configured')
  }
  const expected = createHash('sha256').update(`${options.username}:${options.password}`).digest()
  const scriptHash = createHash('sha256').update(TIMELINE_SCRIPT).digest('base64')
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  }
  const reply = (body: string, status: number, extra: Record<string, string> = {}) =>
    new Response(body, { status, headers: { ...headers, ...extra } })
  return async request => {
    const header = request.headers.get('authorization')
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header ?? '')
    const supplied = match ? Buffer.from(match[1]!, 'base64').toString('utf8') : ''
    const digest = createHash('sha256').update(supplied).digest()
    if (!match || !timingSafeEqual(expected, digest)) {
      return reply('Authentication required', 401, { 'WWW-Authenticate': 'Basic realm="Build timelines", charset="UTF-8"' })
    }
    if (request.method !== 'GET') return reply('Method not allowed', 405, { Allow: 'GET' })
    const url = new URL(request.url), path = url.pathname
    if (path === '/') return reply(TIMELINE_PAGE, 200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (path !== '/timeline' && path !== '/api/timeline') return reply('Not found', 404)
    try {
      const snapshot = await options.read()
      return path === '/api/timeline'
        ? reply(JSON.stringify(snapshot), 200, { 'Content-Type': 'application/json' })
        : reply(renderTimeline(timelineWindow(snapshot, Math.max(0, Math.min(100_000, Number(url.searchParams.get('page')) || 0)), url.searchParams.get('mode') ?? 'lifecycle')), 200, { 'Content-Type': 'text/html; charset=utf-8' })
    } catch {
      // Never return database paths, credentials, command output, or raw logs to the browser.
      return reply('Timeline source unavailable. Previous data may be stale.', 503)
    }
  }
}

interface DatabaseSource { path: string; repoPath: string; repository: string }

export function timelineSourceReader(config: { catalogue: string; observations: string; databases: DatabaseSource[]; importStatus?: string }) {
  return async (): Promise<TimelineSnapshot> => {
    const now = Date.now()
    const warnings: string[] = []
    let catalogue: PrCatalogue = { observedAt: now, repositories: [] }
    try {
      const parsed: unknown = JSON.parse(await readFile(config.catalogue, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || !('observedAt' in parsed) ||
        !Number.isFinite(parsed.observedAt) || !('repositories' in parsed) || !Array.isArray(parsed.repositories)) {
        throw new Error('Invalid catalogue')
      }
      catalogue = parsed as PrCatalogue
    } catch { warnings.push('PR catalogue unavailable. PR coverage is incomplete.') }
    let observations: Awaited<ReturnType<typeof readPhaseObservations>> = []
    try { await stat(config.observations); observations = await readPhaseObservations(config.observations) }
    catch { warnings.push('Direct phase observations unavailable or invalid. Phase coverage is incomplete.') }
    if (config.importStatus) {
      try {
        const status = JSON.parse(await readFile(config.importStatus, 'utf8')) as { lastSuccessAt?: unknown; error?: unknown }
        if (status.error || typeof status.lastSuccessAt !== 'number' || !Number.isFinite(status.lastSuccessAt) || now - status.lastSuccessAt > 60_000) {
          warnings.push('Direct command importer is stale or failed. Historical spans remain visible; recent phase coverage may be incomplete.')
        }
      } catch { warnings.push('Direct command importer status unavailable. Recent phase coverage is unverified.') }
    }
    const trident: Array<{ repository: string; snapshot: TimelineSnapshot }> = []
    for (const source of config.databases) {
      try {
        const reader = openTimelineReader(source.path, source.repoPath)
        try { trident.push({ repository: source.repository, snapshot: reader.read(now) }) }
        finally { reader.close() }
      } catch { warnings.push(`${source.repository}: Trident records unavailable. Other sources remain visible.`) }
    }
    const snapshot = combineTimelineSources(catalogue, observations, trident, now)
    snapshot.warnings.push(...warnings)
    return snapshot
  }
}

export function startTimelineServer(env: Record<string, string | undefined> = process.env) {
  const required = (key: string): string => {
    const value = env[key]
    if (!value?.trim()) throw new Error(`${key} is required`)
    return value
  }
  const username = required('TIMELINE_USERNAME'), password = required('TIMELINE_PASSWORD')
  const catalogue = required('TIMELINE_CATALOGUE'), observations = required('TIMELINE_OBSERVATIONS')
  const port = Number(env['TIMELINE_PORT'] ?? '8790')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TIMELINE_PORT')
  const databases: unknown = JSON.parse(env['TIMELINE_DATABASES'] ?? '[]')
  if (!Array.isArray(databases) || databases.some(source => !source || typeof source !== 'object' ||
    ['path', 'repoPath', 'repository'].some(key => typeof source[key] !== 'string' || !source[key].trim()))) {
    throw new Error('Invalid TIMELINE_DATABASES')
  }
  return Bun.serve({ hostname: '127.0.0.1', port, maxRequestBodySize: 1024,
    fetch: createTimelineHandler({ username, password,
      read: timelineSourceReader({ catalogue, observations, databases: databases as DatabaseSource[],
        ...(env['TIMELINE_IMPORT_STATUS'] ? { importStatus: env['TIMELINE_IMPORT_STATUS'] } : {}) }) }) })
}

if (import.meta.main) {
  startTimelineServer()
  console.log('Build timeline listener started on loopback; expose through an HTTPS reverse proxy.')
}
