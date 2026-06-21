/**
 * @neutronai/gateway/proactive — idle-topic nudge sweep.
 *
 * Closes gap-audit P0-5 (second half). The P6 nudge ranker
 * (`gateway/tasks/p6/nudge-engine.ts`) already picks, once per owner-local
 * day per project, the single highest-leverage open task + a rationale and
 * persists it to `current_focus_pick`. What it has NEVER done is POST that
 * pick to chat. This sweep adds the post path — behind a strict quality gate
 * so it nudges only when genuinely useful and never spams.
 *
 * Per tick, for every active project-bound topic:
 *   1. SKIP active topics — anything with activity inside `idle_threshold_ms`.
 *      A nudge is a re-engagement tool; a live conversation needs none.
 *   2. SKIP empty topics — no `current_focus_pick` row for today, or the
 *      picked task is no longer open. The ranker found nothing to surface.
 *   3. DEDUPE — never re-nudge the same idle topic about the same task while
 *      the user has not returned: a fresh nudge is allowed only when there is
 *      no prior nudge, OR today's pick differs from the last one we nudged,
 *      OR the topic has seen activity since our last nudge (the user came
 *      back and went idle again).
 *
 * Only topics that clear all three get a concise nudge posted (one task, one
 * rationale). The ranker stays the single source of "what to do next"; this
 * module is purely the gate + the post path. Reuses the channel-agnostic
 * `OutboundSink`, exactly like the morning brief + trident async-delivery.
 */

import type { ProjectDb } from '../../persistence/index.ts'
import { resolveOwnerDay } from '../tasks/p6/nudge-engine.ts'
import { proactiveTopic, type OutboundSink, type Topic } from './sink.ts'
import { ProactiveStateStore } from './state-store.ts'

export const DEFAULT_OWNER_TIMEZONE = 'America/Los_Angeles'

/** Default sweep cadence — hourly (Vajra parity). */
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Default idle threshold — 4h of silence before a topic is "idle". Below
 * this the conversation is live and a nudge would interrupt, not re-engage.
 */
export const DEFAULT_IDLE_THRESHOLD_MS = 4 * 60 * 60 * 1000

/** An active project-bound topic the sweep may consider. */
export interface ProactiveTopicCandidate {
  /** The channel topic id (`<chat_id>[:<thread_id>]` for Telegram). */
  topic_id: string
  project_slug: string
  /** Epoch-ms of the topic's most recent activity; null = unknown/never. */
  last_activity_ms: number | null
}

/** Today's ranker pick for a project, joined to the open task it names. */
export interface TodayPick {
  task_id: string
  title: string
  rationale: string
}

export type NudgeSkipReason =
  | 'active'
  | 'no_pick'
  | 'already_nudged'
  | 'deliver_failed'

export interface IdleNudgeSweepResult {
  posted: number
  skipped: number
  skip_reasons: Record<NudgeSkipReason, number>
  /** Topic ids that received a nudge this sweep. */
  posted_topics: string[]
}

export interface IdleNudgeSweepDeps {
  db: ProjectDb
  store: ProactiveStateStore
  sink: OutboundSink
  /** Active project-bound topics to consider (production resolves; tests inject). */
  listTopics(): ProactiveTopicCandidate[] | Promise<ProactiveTopicCandidate[]>
  now(): number
  tz?: string
  idle_threshold_ms?: number
  channel_kind?: Topic['channel_kind']
  log?(msg: string): void
}

/**
 * Read today's ranker pick for `project_slug`, joined to the named task, but
 * ONLY when that task is still open. Returns null when there is no pick for
 * today or the picked task has since closed / vanished (a stale pick the
 * ranker will refresh tomorrow — we never surface it).
 */
export function readTodayPick(
  db: ProjectDb,
  project_slug: string,
  day: string,
): TodayPick | null {
  const row = db
    .prepare<{ task_id: string; llm_rationale: string; title: string | null; status: string | null }, [string, string]>(
      `SELECT p.task_id        AS task_id,
              p.llm_rationale  AS llm_rationale,
              t.title          AS title,
              t.status         AS status
         FROM current_focus_pick p
         LEFT JOIN tasks t ON t.id = p.task_id
        WHERE p.project_slug = ? AND p.day = ?
        LIMIT 1`,
    )
    .get(project_slug, day)
  if (row === undefined || row === null) return null
  if (row.title === null || row.status !== 'open') return null
  return { task_id: row.task_id, title: row.title, rationale: row.llm_rationale }
}

/**
 * Compose the nudge body. PURE. One task, one rationale, concise — a single
 * highest-leverage next action, not a digest.
 */
export function composeNudge(project_slug: string, pick: TodayPick): string {
  return `👋 One thing for ${project_slug}: ${pick.title}\n${pick.rationale}`
}

/**
 * Decide whether a candidate topic should be nudged this tick. PURE — all
 * inputs explicit so the quality gate is unit-testable without a DB or sink.
 * Returns either `{ post: true }` or `{ post: false, reason }`.
 */
export function evaluateNudgeGate(input: {
  candidate: ProactiveTopicCandidate
  pick: TodayPick | null
  prior: { last_nudged_task_id: string | null; last_activity_at_ms: number | null } | null
  now_ms: number
  idle_threshold_ms: number
}):
  | { post: true }
  | { post: false; reason: NudgeSkipReason } {
  const { candidate, pick, prior, now_ms, idle_threshold_ms } = input

  // 1) Active topic — silence shorter than the idle threshold. Unknown
  //    last-activity (null) is treated as idle (never spoken in → fair game).
  if (candidate.last_activity_ms !== null && now_ms - candidate.last_activity_ms < idle_threshold_ms) {
    return { post: false, reason: 'active' }
  }

  // 2) Empty — the ranker surfaced no open task for today.
  if (pick === null) return { post: false, reason: 'no_pick' }

  // 3) Dedupe — skip when we've already nudged this topic about this exact
  //    task AND the user has not returned (activity has not advanced past the
  //    watermark we stored at the last nudge).
  if (prior !== null && prior.last_nudged_task_id === pick.task_id) {
    // "The user came back and went idle again." Advancement requires a known
    // current activity timestamp. When the watermark we stored at the last
    // nudge was null (the first nudge fired with unknown activity), ANY later
    // known activity counts as a return — otherwise a null watermark would
    // dedupe the topic forever for that task (Codex review P2).
    const activityAdvanced =
      candidate.last_activity_ms !== null &&
      (prior.last_activity_at_ms === null ||
        candidate.last_activity_ms > prior.last_activity_at_ms)
    if (!activityAdvanced) return { post: false, reason: 'already_nudged' }
  }

  return { post: true }
}

/**
 * Run one idle-topic nudge sweep. Posts a nudge for each topic that clears
 * the quality gate; records the nudge in the dedupe ledger. Never throws — a
 * per-topic deliver failure is counted + logged and the sweep continues.
 */
export async function runIdleNudgeSweep(
  deps: IdleNudgeSweepDeps,
): Promise<IdleNudgeSweepResult> {
  const tz = deps.tz ?? DEFAULT_OWNER_TIMEZONE
  const idleThreshold = deps.idle_threshold_ms ?? DEFAULT_IDLE_THRESHOLD_MS
  const channelKind = deps.channel_kind ?? 'telegram'
  const nowMs = deps.now()
  const day = resolveOwnerDay(nowMs, tz)

  const result: IdleNudgeSweepResult = {
    posted: 0,
    skipped: 0,
    skip_reasons: { active: 0, no_pick: 0, already_nudged: 0, deliver_failed: 0 },
    posted_topics: [],
  }

  const candidates = await deps.listTopics()
  for (const candidate of candidates) {
    const pick = readTodayPick(deps.db, candidate.project_slug, day)
    const prior = deps.store.getTopicState(candidate.topic_id)
    const gate = evaluateNudgeGate({
      candidate,
      pick,
      prior:
        prior === null
          ? null
          : {
              last_nudged_task_id: prior.last_nudged_task_id,
              last_activity_at_ms: prior.last_activity_at_ms,
            },
      now_ms: nowMs,
      idle_threshold_ms: idleThreshold,
    })

    if (!gate.post) {
      result.skipped++
      result.skip_reasons[gate.reason]++
      continue
    }
    // `gate.post === true` guarantees a non-null pick (gate returns 'no_pick'
    // otherwise), but narrow explicitly for the type checker.
    if (pick === null) {
      result.skipped++
      result.skip_reasons.no_pick++
      continue
    }

    const topic = proactiveTopic(candidate.topic_id, channelKind)
    const text = composeNudge(candidate.project_slug, pick)
    try {
      await deps.sink.send({ topic, text })
    } catch (err) {
      deps.log?.(`[proactive] idle-nudge deliver failed for ${candidate.topic_id}: ${err}`)
      result.skipped++
      result.skip_reasons.deliver_failed++
      continue
    }

    await deps.store.recordNudge({
      topic_id: candidate.topic_id,
      project_slug: candidate.project_slug,
      task_id: pick.task_id,
      nudged_at_iso: new Date(nowMs).toISOString(),
      last_activity_at_ms: candidate.last_activity_ms,
    })
    result.posted++
    result.posted_topics.push(candidate.topic_id)
  }

  return result
}
