/**
 * @neutronai/onboarding/overnight — the morning reporter.
 *
 * Fires once at ≥06:50 local. Reports the REAL results of the Trident runs
 * that finished during the just-closed window — it NEVER invents results
 * (hard rule, Vajra parity). Routing:
 *
 *   • General topic — a high-level summary: counts + one line per project.
 *   • Per-project topics — detail: each completed item's real result and
 *     each failure with its reason. Falls back to General when a project has
 *     no bound topic.
 *
 * Quiet night (nothing transitioned) → a single one-line note to General,
 * never a fabricated "analysis ran" claim.
 *
 * `composeGeneralSummary` / `composeProjectDetail` are pure + exported for
 * direct testing; the delivery + topic resolution are injected.
 */

import { currentWindowDate, DEFAULT_TZ } from './dispatcher.ts'
import type { OvernightItem, OvernightQueueStore } from './queue-store.ts'

export interface MorningBriefDeliverInput {
  topic_id: string
  body: string
}

export interface MorningBriefDeps {
  store: OvernightQueueStore
  /** Deliver one message to a topic. Returns true when accepted. */
  deliver(input: MorningBriefDeliverInput): boolean | Promise<boolean>
  /** The General / main topic id for the high-level summary. */
  general_topic_id: string
  /** Resolve a project slug to its bound topic; null → route to General. */
  resolveProjectTopic?(owner_slug: string): string | null
  now(): number
  tz?: string
  /** Override the window date being reported (else derived from `now`). */
  window_date?: string
  log?(msg: string): void
}

export interface MorningBriefResult {
  status: 'reported' | 'quiet' | 'skipped'
  window_date: string | null
  projects_reported: number
  items_reported: number
  detail: string
}

/** A project's transitioned items for the window. */
interface ProjectRollup {
  slug: string
  completed: OvernightItem[]
  failed: OvernightItem[]
}

/**
 * Items that TRANSITIONED to a terminal state during `windowDate` — i.e.
 * the Trident run finished this window. Selected by `window_date_local`
 * (stamped at dispatch) so only this window's real work is reported.
 */
export function selectWindowTransitions(
  items: OvernightItem[],
  windowDate: string,
): OvernightItem[] {
  return items.filter(
    (i) =>
      (i.status === 'completed' || i.status === 'failed') &&
      i.window_date_local === windowDate &&
      i.finished_at !== null,
  )
}

function rollupByProject(items: OvernightItem[]): ProjectRollup[] {
  const map = new Map<string, ProjectRollup>()
  for (const i of items) {
    let r = map.get(i.owner_slug)
    if (!r) {
      r = { slug: i.owner_slug, completed: [], failed: [] }
      map.set(i.owner_slug, r)
    }
    if (i.status === 'completed') r.completed.push(i)
    else r.failed.push(i)
  }
  return [...map.values()].sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * The General high-level summary: total counts + one line per project. Pure;
 * reads only the supplied (already real) results.
 */
export function composeGeneralSummary(rollups: ProjectRollup[], windowDate: string): string {
  const totalCompleted = rollups.reduce((n, r) => n + r.completed.length, 0)
  const totalFailed = rollups.reduce((n, r) => n + r.failed.length, 0)
  const lines: string[] = []
  lines.push(`Overnight work — ${windowDate}`)
  lines.push('')
  lines.push(
    `${totalCompleted} completed, ${totalFailed} failed across ${rollups.length} project${rollups.length === 1 ? '' : 's'}.`,
  )
  lines.push('')
  for (const r of rollups) {
    const parts: string[] = []
    if (r.completed.length > 0) parts.push(`${r.completed.length} done`)
    if (r.failed.length > 0) parts.push(`${r.failed.length} failed`)
    lines.push(`- ${r.slug}: ${parts.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Per-project detail: each completed item's real result, each failure with
 * its reason. Pure. Returns null when the project had no transitions (the
 * caller skips delivery rather than posting an empty body).
 */
export function composeProjectDetail(rollup: ProjectRollup, windowDate: string): string | null {
  if (rollup.completed.length === 0 && rollup.failed.length === 0) return null
  const lines: string[] = []
  lines.push(`${rollup.slug} — overnight results (${windowDate})`)
  if (rollup.completed.length > 0) {
    lines.push('')
    lines.push('Completed:')
    for (const i of rollup.completed) {
      lines.push(`- ${i.description} → ${i.result ?? '(no result recorded)'}`)
    }
  }
  if (rollup.failed.length > 0) {
    lines.push('')
    lines.push('Failed:')
    for (const i of rollup.failed) {
      lines.push(`- ${i.description} → ${i.result ?? 'failed (no reason recorded)'}`)
    }
  }
  return lines.join('\n')
}

/**
 * Compose + deliver the morning brief. Returns a structured result; never
 * throws (delivery failures land as `skipped`/logged so the cron records a
 * clean tick).
 */
export async function runMorningBrief(deps: MorningBriefDeps): Promise<MorningBriefResult> {
  const tz = deps.tz ?? DEFAULT_TZ
  const windowDate = deps.window_date ?? currentWindowDate(deps.now(), tz)
  if (windowDate === null) {
    return {
      status: 'skipped',
      window_date: null,
      projects_reported: 0,
      items_reported: 0,
      detail: 'not in/after an overnight window; nothing to report',
    }
  }

  const transitions = selectWindowTransitions(deps.store.list(), windowDate)
  if (transitions.length === 0) {
    // Quiet night — one honest line to General. Never invent results.
    await safeDeliver(deps, {
      topic_id: deps.general_topic_id,
      body: `Overnight work — ${windowDate}: a quiet night, nothing was queued to run.`,
    })
    return {
      status: 'quiet',
      window_date: windowDate,
      projects_reported: 0,
      items_reported: 0,
      detail: 'no items transitioned this window',
    }
  }

  const rollups = rollupByProject(transitions)

  // 1) General high-level summary.
  await safeDeliver(deps, {
    topic_id: deps.general_topic_id,
    body: composeGeneralSummary(rollups, windowDate),
  })

  // 2) Per-project detail, routed to each project's topic (General fallback).
  let projectsReported = 0
  for (const r of rollups) {
    const detail = composeProjectDetail(r, windowDate)
    if (detail === null) continue
    const topic = deps.resolveProjectTopic?.(r.slug) ?? deps.general_topic_id
    await safeDeliver(deps, { topic_id: topic, body: detail })
    projectsReported++
  }

  return {
    status: 'reported',
    window_date: windowDate,
    projects_reported: projectsReported,
    items_reported: transitions.length,
    detail: `reported ${transitions.length} item(s) across ${rollups.length} project(s)`,
  }
}

async function safeDeliver(deps: MorningBriefDeps, input: MorningBriefDeliverInput): Promise<void> {
  try {
    await deps.deliver(input)
  } catch (err) {
    deps.log?.(`[overnight] morning-brief deliver failed for topic ${input.topic_id}: ${err}`)
  }
}
