import { timelineUsage, type TimelineCard, type TimelineSnapshot } from './build-timeline.ts'

export interface PrCatalogue {
  observedAt: number
  fullObservedAt?: number
  repositories: Array<{
    repository: string
    error: string | null
    prs: Array<{ number: number; title: string; url: string; createdAt: string; updatedAt?: string; closedAt: string | null; mergedAt: string | null; state: string; ciCoverage?: string; ciError?: string | null; ciObservedAt?: number | null; ciPending?: boolean; ciRunning?: boolean }>
  }>
}

export interface DirectObservation {
  eventId: string
  phaseId: string
  links: Array<{ repository: string; prNumber: number }>
  phase: string
  label?: string
  model: string | null
  startedAt: number
  endedAt: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  costUsd: number | null
  observedAt: number
  source: {
    kind: string
    attribution: 'explicit' | 'reconstructed'
    basis: string
  }
}

function validStamp(value: string | null): number | null {
  if (value === null) return null
  const at = Date.parse(value)
  return Number.isFinite(at) && at >= 0 ? at : null
}

/** PR lifecycle is a wall-clock envelope, never a claim that every minute was build work. */
export function combineTimelineSources(catalogue: PrCatalogue, observations: DirectObservation[],
  trident: Array<{ repository: string; snapshot: TimelineSnapshot }>, now = Date.now()): TimelineSnapshot {
  const cards = new Map<string, TimelineCard>()
  const warnings: string[] = []
  if (now - catalogue.observedAt > 60_000) warnings.push('GitHub catalogue is older than 60 seconds; PR metadata may be stale.')
  for (const source of catalogue.repositories) {
    if (source.error) warnings.push(`${source.repository}: ${source.error}`)
    for (const pr of source.prs) {
      const key = `${source.repository}#${pr.number}`
      const start = validStamp(pr.createdAt), closed = validStamp(pr.closedAt) ?? validStamp(pr.mergedAt)
      const active = pr.state.toUpperCase() === 'OPEN'
      const prState = pr.state.toLowerCase()
      const freshCi = source.error === null && !pr.ciError &&
        (pr.ciCoverage === 'head-only' || pr.ciCoverage === 'partial') &&
        typeof pr.ciObservedAt === 'number' && Number.isFinite(pr.ciObservedAt) &&
        pr.ciObservedAt <= now && now - pr.ciObservedAt <= 60_000
      const end = active ? now : closed
      const ordered = start !== null && end !== null && start <= end && start <= now && end <= now
      cards.set(key, {
        key, repository: source.repository, url: /^https:\/\/github\.com\//.test(pr.url) ? pr.url : null,
        lifecycle: `PR ${pr.state.toLowerCase()} · created ${pr.createdAt}${closed === null ? '' : ` · closed ${new Date(closed).toISOString()}`} · envelope includes linked work`,
        pr: pr.number, title: pr.title, start: ordered ? start : null, end: ordered ? end : null,
        latestStart: validStamp(pr.updatedAt ?? null) ?? start, active, runs: [], segments: [], lanes: 1, gaps: [], events: [], phaseTotals: [],
        prState: prState === 'open' || prState === 'merged' || prState === 'closed' ? prState : 'unknown',
        workSignal: { state: freshCi && pr.ciPending ? pr.ciRunning === true ? 'running' : 'pending' : 'unknown',
          observedAt: freshCi ? pr.ciObservedAt! : null, source: 'GitHub check status for sampled PR head' },
        warnings: [
          ...(ordered ? [] : ['PR lifecycle duration unknown: missing or invalid timestamps.']),
          ...(pr.ciCoverage ? [pr.ciCoverage === 'head-only' ? 'CI observations cover the sampled head only; earlier push cycles remain unknown.' :
            `CI coverage ${pr.ciCoverage}${pr.ciError ? `: ${pr.ciError}` : ''}`] : []),
        ],
      })
    }
  }
  for (const source of trident) {
    warnings.push(...source.snapshot.warnings)
    for (const runCard of source.snapshot.cards) {
      const key = runCard.pr === null ? `${source.repository}/${runCard.key}` : `${source.repository}#${runCard.pr}`
      const existing = cards.get(key)
      if (!existing) {
        cards.set(key, { ...runCard, key, repository: source.repository })
      } else {
        existing.runs.push(...runCard.runs)
        existing.segments.push(...runCard.segments)
        existing.events.push(...runCard.events)
        existing.phaseTotals.push(...runCard.phaseTotals)
        existing.warnings.push(...runCard.warnings)
        existing.latestStart = Math.max(existing.latestStart ?? 0, runCard.latestStart ?? 0,
          ...runCard.segments.map(span => span.timing === 'recorded' ? span.end : span.start))
        if (runCard.start !== null) existing.start = Math.min(existing.start ?? runCard.start, runCard.start)
        if (runCard.end !== null) existing.end = Math.max(existing.end ?? runCard.end, runCard.end)
        existing.active ||= runCard.active
      }
    }
  }
  for (const observation of observations) {
    for (const link of observation.links) {
      const key = `${link.repository}#${link.prNumber}`
      let card = cards.get(key)
      if (!card) {
        card = {
          key, repository: link.repository, url: null, lifecycle: 'Direct observations · PR metadata unavailable',
          pr: link.prNumber, title: 'Recorded orchestration', start: observation.startedAt,
          end: observation.endedAt ?? now, latestStart: observation.startedAt, active: observation.endedAt === null,
          runs: [], segments: [], lanes: 1, gaps: [], events: [], phaseTotals: [], warnings: [],
        }
        cards.set(key, card)
      }
      const end = observation.endedAt ?? now
      if (observation.startedAt > end || end > now) {
        card.warnings.push(`${observation.phase}: inconsistent phase timestamps; span omitted.`)
        continue
      }
      card.start = Math.min(card.start ?? observation.startedAt, observation.startedAt)
      card.end = Math.max(card.end ?? end, end)
      card.active ||= observation.endedAt === null
      card.latestStart = Math.max(card.latestStart ?? 0, observation.endedAt ?? observation.startedAt)
      card.segments.push({
        id: observation.phaseId, runId: '', label: observation.label ?? observation.phase, phase: observation.phase,
        start: observation.startedAt, end, timing: observation.endedAt === null ? 'open' : 'recorded', lane: 0,
        model: observation.model,
        usage: timelineUsage({ input_tokens: observation.inputTokens, output_tokens: observation.outputTokens,
          cache_read_tokens: observation.cacheReadTokens, cache_creation_tokens: observation.cacheCreationTokens,
          cost_usd: observation.costUsd, source: observation.source.kind, observed_at: observation.observedAt }),
        detail: `${observation.source.attribution}: ${observation.source.basis}${observation.links.length > 1 ? ' · shared span linked to multiple PRs; not additive' : ''}`,
      })
    }
  }
  for (const card of cards.values()) {
    const lastEnded = Math.max(-1, ...card.segments.filter(s => s.timing === 'recorded').map(s => s.end))
    if ((!card.workSignal || card.workSignal.state === 'unknown') && lastEnded >= 0 && lastEnded <= now && now - lastEnded <= 600_000) {
      card.workSignal = { state: 'recent', observedAt: lastEnded,
        source: 'Recorded phase ended within the last 10 minutes; not evidence that work is still running' }
    }
    card.segments.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id))
    const lanes: number[] = []
    for (const segment of card.segments) {
      let lane = lanes.findIndex(end => end <= segment.start)
      if (lane < 0) lane = lanes.length
      segment.lane = lane
      lanes[lane] = segment.end
    }
    card.lanes = Math.max(1, lanes.length)
    card.gaps = []
    if (card.start !== null && card.end !== null) {
      let cursor = card.start
      for (const segment of card.segments.filter(span => span.timing === 'recorded')) {
        if (segment.start > cursor) card.gaps.push({ start: cursor, end: segment.start })
        cursor = Math.max(cursor, segment.end)
      }
      if (cursor < card.end) card.gaps.push({ start: cursor, end: card.end })
    }
  }
  const sorted = [...cards.values()].sort((a, b) => (b.latestStart ?? -1) - (a.latestStart ?? -1) ||
    (b.start ?? -1) - (a.start ?? -1) || a.key.localeCompare(b.key))
  return { observedAt: now, cards: sorted, prCount: sorted.filter(card => card.pr !== null).length,
    runOnlyCount: sorted.filter(card => card.pr === null).length, maxDurationMs: Math.max(1, ...sorted.map(card =>
    card.start === null || card.end === null ? 0 : card.end - card.start)), limit: sorted.length, warnings }
}
