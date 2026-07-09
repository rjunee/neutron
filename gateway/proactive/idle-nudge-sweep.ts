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

import type { ProjectDb } from '@neutronai/persistence/index.ts'
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
  | 'low_quality'
  | 'deliver_failed'

/**
 * The Vajra dual-rating quality floor. A candidate nudge is rated 1–10 on TWO
 * dimensions; BOTH must be ≥ this to post. Ported verbatim from
 * `~/vajra/prompts/re-engagement-nudge-agent.md` ("If EITHER rating is below 7,
 * output NONE. Better to stay silent than push a middling nudge.").
 */
export const NUDGE_QUALITY_FLOOR = 7

/**
 * The two-dimension self-rating of a candidate nudge (each 1–10):
 *   • `leverage`  — is this the HIGHEST-leverage action visible in the topic,
 *                   not merely a plausible one?
 *   • `gratitude` — would the owner react "good call" (grateful) vs neutral /
 *                   annoyed?
 */
export interface NudgeRating {
  leverage: number
  gratitude: number
}

/**
 * Rate a candidate nudge before it posts. Returns `null` to ABSTAIN (the
 * Vajra "output NONE" path) — treated as a skip, never a post. Production
 * wires an LLM rater (`buildLlmNudgeRater`); tests inject a stub.
 */
export type NudgeRater = (input: {
  project_slug: string
  pick: TodayPick
  candidate: ProactiveTopicCandidate
}) => Promise<NudgeRating | null>

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
  /**
   * Optional dual-rating quality gate (Vajra parity). When supplied, a
   * candidate that clears the idle/dedupe gate is ALSO rated 1–10 on leverage
   * + gratitude and only posts when BOTH are ≥ `NUDGE_QUALITY_FLOOR`; a `null`
   * rating abstains (skip). Absent → no quality gate (the pre-existing
   * idle/dedupe-only behaviour, used by tests / LLM-less instances). Production
   * MUST wire this so the sweep does not nudge on every idle topic.
   */
  rateNudge?: NudgeRater
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
 * The dual-rating quality gate. PURE. Posts iff a rating exists AND both
 * dimensions clear `NUDGE_QUALITY_FLOOR` — a `null` rating (the LLM abstained,
 * "output NONE") or either dimension below the floor rejects. Vajra parity:
 * "If EITHER rating is below 7, output NONE."
 */
export function evaluateQualityGate(
  rating: NudgeRating | null,
):
  | { post: true }
  | { post: false; reason: 'low_quality' } {
  if (rating === null) return { post: false, reason: 'low_quality' }
  if (rating.leverage < NUDGE_QUALITY_FLOOR || rating.gratitude < NUDGE_QUALITY_FLOOR) {
    return { post: false, reason: 'low_quality' }
  }
  return { post: true }
}

/** System prompt for the LLM nudge rater — the Vajra "Quality floor" audit. */
export const LLM_NUDGE_RATER_SYSTEM = [
  "You rate a candidate re-engagement nudge before it is sent to the owner.",
  'Rate it on TWO dimensions, each an integer 1–10:',
  '  LEVERAGE  — is this the HIGHEST-leverage action visible for this topic right',
  '              now, not just a plausible one? (10 = clearly the top priority)',
  '  GRATITUDE — would the owner react "good call" (grateful) vs neutral vs',
  '              annoyed? (10 = strongly grateful for the nudge)',
  'Be strict: a middling nudge is worse than silence.',
  'Output EXACTLY two lines and nothing else:',
  'LEVERAGE=<n>',
  'GRATITUDE=<n>',
].join('\n')

/**
 * Build an LLM-backed nudge rater. Asks the warm LLM to score the candidate
 * nudge on leverage + gratitude and parses the strict `LEVERAGE=`/`GRATITUDE=`
 * lines. ANY parse failure / out-of-range value returns `null` (ABSTAIN →
 * skip) — the safe default, mirroring Vajra's "output NONE when uncertain."
 */
export function buildLlmNudgeRater(
  llm: (input: { system: string; user: string; max_tokens: number }) => Promise<string>,
  opts: { max_tokens?: number } = {},
): NudgeRater {
  const maxTokens = opts.max_tokens ?? 60
  return async ({ project_slug, pick }): Promise<NudgeRating | null> => {
    const user = [
      `Project: ${project_slug}`,
      `Candidate next action: ${pick.title}`,
      `Rationale: ${pick.rationale}`,
      '',
      'Rate this nudge now.',
    ].join('\n')
    let raw: string
    try {
      raw = await llm({ system: LLM_NUDGE_RATER_SYSTEM, user, max_tokens: maxTokens })
    } catch {
      return null
    }
    return parseNudgeRating(raw)
  }
}

/**
 * Parse the rater's `LEVERAGE=<n>` / `GRATITUDE=<n>` lines. Returns null unless
 * BOTH are present as integers in 1–10. Exported for unit tests.
 */
export function parseNudgeRating(raw: string): NudgeRating | null {
  if (typeof raw !== 'string') return null
  const lev = /LEVERAGE\s*=\s*(\d{1,2})/i.exec(raw)
  const grat = /GRATITUDE\s*=\s*(\d{1,2})/i.exec(raw)
  if (lev === null || grat === null) return null
  const leverage = parseInt(lev[1] ?? '', 10)
  const gratitude = parseInt(grat[1] ?? '', 10)
  if (!inRange(leverage) || !inRange(gratitude)) return null
  return { leverage, gratitude }
}

function inRange(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 10
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
    skip_reasons: { active: 0, no_pick: 0, already_nudged: 0, low_quality: 0, deliver_failed: 0 },
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

    // Dual-rating quality gate (Vajra parity) — only when a rater is wired.
    // A candidate that cleared idle/dedupe still must clear the ≥7 leverage +
    // gratitude floor; a null rating abstains. This is what stops the sweep
    // from nudging on every idle topic.
    if (deps.rateNudge !== undefined) {
      let rating: NudgeRating | null
      try {
        rating = await deps.rateNudge({ project_slug: candidate.project_slug, pick, candidate })
      } catch (err) {
        deps.log?.(`[proactive] idle-nudge rater threw for ${candidate.topic_id}: ${err}`)
        rating = null
      }
      const quality = evaluateQualityGate(rating)
      if (!quality.post) {
        result.skipped++
        result.skip_reasons.low_quality++
        continue
      }
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
