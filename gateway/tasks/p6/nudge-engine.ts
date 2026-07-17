/**
 * @neutronai/gateway/tasks/p6 — daily nudge engine (P6.1).
 *
 * Per docs/plans/2026-05-23-002-feat-p6-1-nudge-engine-staleness-current-focus-pick-plan.md
 * Part A.
 *
 * Once-daily per-instance cron pass that:
 *   1. Short-circuits if `current_focus_pick` already has a row for
 *      today's `(project_slug, day)` — same-day re-runs cost zero LLM
 *      tokens (one EXISTS check).
 *   2. Runs `runStalenessPass(...)` first so demoted scores are
 *      reflected in today's slate.
 *   3. Reads the top N=20 open tasks for the owner, ordered by
 *      focus_score DESC.
 *   4. Builds a context bundle (slate + yesterday's completions +
 *      today's resolved count) and feeds it through
 *      `buildNudgePrompt(...)`.
 *   5. Calls the injected `LlmCallFn` (the same Anthropic-Messages
 *      substrate `build-phase-spec-resolver.ts` uses), with the
 *      persona-spliced system prompt via `composeSystemPrompt`.
 *   6. Parses the response (strict JSON inside a fenced ```json
 *      block), validates `task_id` is in the slate, clamps the
 *      rationale.
 *   7. UPSERTs the row into `current_focus_pick` with the top-3 task
 *      ids the staleness engine will use tomorrow.
 *
 * Failure modes are all NO-OP-no-row: missing creds, LLM timeout,
 * parse failure, hallucinated task_id, empty slate. The app surface
 * (`GET /api/app/focus/current`) returns 404 in any of these cases,
 * the bucket-only Focus view remains usable.
 */

import { composeSystemPrompt } from '../../wiring/index.ts'
import type { PersonaPromptLoader } from '../../wiring/persona-loader.ts'
import type { LlmCallFn } from '@neutronai/onboarding/interview/phase-spec-resolver.ts'
import type {
  CronHandler,
  CronHandlerRegistry,
} from '@neutronai/cron/handlers.ts'
import type {
  CronJobDef,
  CronJobRegistry,
} from '@neutronai/cron/jobs.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { TaskStore, type Task } from '@neutronai/tasks/store.ts'
import {
  NUDGE_RATIONALE_MAX_CHARS,
  NUDGE_SLATE_LLM_LIMIT,
  buildNudgePrompt,
  type NudgeSlateRow,
  type YesterdayCompletion,
} from './nudge-engine-prompt.ts'
import {
  DEFAULT_DEMOTION_THRESHOLD,
  DEFAULT_DECAY_FACTOR,
  DEFAULT_SKIP_OR_KILL_THRESHOLD,
  runStalenessPass,
} from './staleness-engine.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('nudge-engine')

/** Coerce arbitrary log meta to the logger's primitive `LogValue` shape —
 *  non-primitives are JSON-stringified so the emitted `k=v` line stays single. */
const coerceLogFields = (
  fields?: Record<string, unknown>,
): Record<string, string | number | boolean | null | undefined> | undefined => {
  if (fields === undefined) return undefined
  const out: Record<string, string | number | boolean | null | undefined> = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] =
      v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)
        ? (v as string | number | boolean | null | undefined)
        : (() => { try { return JSON.stringify(v) } catch { return String(v) } })()
  }
  return out
}

/**
 * Default 24h cadence — the LLM "pick of the day" by definition lasts
 * one day. More-frequent ticks are cheap no-ops (the EXISTS check
 * short-circuits before the LLM call).
 */
export const DEFAULT_NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Default LLM timeout — same 5s budget as the phase-spec resolver. */
export const DEFAULT_NUDGE_TIMEOUT_MS = 5_000

/** Cron handler name (must be unique across the per-boot registry). */
export const NUDGE_ENGINE_HANDLER_NAME = 'tasks.nudge_engine'

/** Default model id (overridable via the handler dep). */
export const DEFAULT_NUDGE_MODEL = 'claude-haiku-4-5'

/**
 * Default owner timezone when `instance_metadata.timezone` is not set.
 * Matches USER.md default + production instance zero.
 */
export const DEFAULT_OWNER_TIMEZONE = 'America/Los_Angeles'

export interface NudgeEngineHandlerDeps {
  db: ProjectDb
  /**
   * Pre-built LLM call function — production wires the same
   * `buildAnthropicLlmCall(...)` shape the phase-spec resolver uses.
   * Pass `null` for instances without an Anthropic credential (the
   * handler then no-ops every tick).
   */
  llm: LlmCallFn | null
  /**
   * Persona loader — same instance the phase-spec resolver uses so
   * the mtime cache is shared. Pass `null` to skip persona splicing
   * (legacy / test paths).
   */
  personaLoader?: PersonaPromptLoader | null
  /** Override Date.now (test seam). */
  now?: () => number
  /** Override IANA timezone (test seam; production reads instance_metadata). */
  timezone?: string
  /**
   * Resolve the owner's IANA timezone AT EACH tick, keyed on the DISPATCHED
   * `owner_slug` (NOT a composition-time capture). Production wires this to
   * read `instance_metadata.timezone` per-invocation (the schema contract in
   * migrations/0045_p6_1_nudge_staleness.sql resolves the zone "at engine
   * invocation") so a mid-run timezone change takes effect on the next tick
   * without a gateway restart. Keying on `owner_slug` matters in the hosted
   * first-handler-wins model (`registerNudgeEngineCron`): one shared handler
   * services every instance's tick via `ctx.owner_slug`, so the resolver must
   * look up the tick's owner — matching how the rest of the pass already
   * queries `deps.db` with `project_slug = ctx.owner_slug`. Returns
   * `undefined` when the instance has no stored zone → the pass falls back to
   * the static `timezone` then `DEFAULT_OWNER_TIMEZONE`. When it returns a
   * value it WINS over the static `timezone` field.
   */
  resolveTimezone?: (owner_slug: string) => string | undefined
  /** Override the LLM call timeout. Default `DEFAULT_NUDGE_TIMEOUT_MS`. */
  timeout_ms?: number
  /** Override model id. Default `DEFAULT_NUDGE_MODEL`. */
  model?: string
  /** Demotion threshold for staleness engine. Default 3. */
  demotion_threshold?: number
  /** Decay factor for staleness engine. Default 0.5. */
  decay_factor?: number
  /** Skip-or-kill flag threshold for prompt-builder. Default 3. */
  skip_or_kill_threshold?: number
  /** Structured logger; defaults to `console.info` / `console.warn`. */
  log?: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void
}

export type NudgePassOutcome =
  | { kind: 'ok'; task_id: string; day: string }
  | { kind: 'skipped'; reason: string }

export interface NudgePassInput {
  db: ProjectDb
  project_slug: string
  llm: LlmCallFn | null
  personaLoader?: PersonaPromptLoader | null
  now?: () => number
  timezone?: string
  timeout_ms?: number
  model?: string
  demotion_threshold?: number
  decay_factor?: number
  skip_or_kill_threshold?: number
  log?: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void
}

/**
 * Compute the owner-local YYYY-MM-DD string for `nowMs`. We use
 * `Intl.DateTimeFormat` with the owner's IANA zone so the day boundary
 * matches the user's wall clock.
 */
export function resolveOwnerDay(nowMs: number, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  // en-CA returns YYYY-MM-DD; safer than locale-en-US's M/D/Y.
  return fmt.format(new Date(nowMs))
}

interface SlateTaskRow {
  id: string
  title: string
  project_id: string
  priority: number | null
  due_date: string | null
  focus_score: number | null
  staleness_demotion_count: number
}

interface YesterdayCompletionRow {
  id: string
  title: string
}

interface ResolvedTodayCountRow {
  count: number
}

interface PickExistsRow {
  one: number
}

/**
 * Parse the LLM's JSON response. Accepts the response with or without
 * a ```json fence; returns null on any parse failure or missing fields.
 */
export function parseLlmNudgeResponse(
  raw: string,
): { task_id: string; rationale: string } | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced !== null ? (fenced[1] ?? '') : raw
  let parsed: unknown
  try {
    parsed = JSON.parse(body.trim())
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const obj = parsed as { task_id?: unknown; rationale?: unknown }
  if (typeof obj.task_id !== 'string' || obj.task_id.length === 0) return null
  if (typeof obj.rationale !== 'string' || obj.rationale.length === 0) return null
  return { task_id: obj.task_id, rationale: obj.rationale }
}

/**
 * Clamp the rationale to `NUDGE_RATIONALE_MAX_CHARS`. Single trailing
 * ellipsis on overflow.
 */
export function clampRationale(s: string): string {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= NUDGE_RATIONALE_MAX_CHARS) return collapsed
  return `${collapsed.slice(0, NUDGE_RATIONALE_MAX_CHARS - 1)}…`
}

/**
 * Wrap `llm` in a timeout so a stuck Anthropic call can never block
 * the cron tick. Throws `'timeout'` (string) on expiry.
 */
async function callWithTimeout(
  llm: LlmCallFn,
  call: { system: string; user: string; max_tokens: number },
  timeout_ms: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nudge_llm_timeout')), timeout_ms)
    llm(call)
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

/**
 * Run a single nudge pass for one instance. Idempotent: if a row already
 * exists for today's `(project_slug, day)`, no LLM call is made.
 */
export async function runNudgePass(
  input: NudgePassInput,
): Promise<NudgePassOutcome> {
  const log =
    input.log ??
    ((level, msg, meta): void => {
      moduleLog[level](msg, coerceLogFields(meta))
    })
  const now = input.now ?? ((): number => Date.now())
  const tz = input.timezone ?? DEFAULT_OWNER_TIMEZONE
  const nowMs = now()
  const day = resolveOwnerDay(nowMs, tz)

  // Step 1: existence guard — short-circuit on same-day re-run.
  const exists = input.db
    .prepare<PickExistsRow, [string, string]>(
      `SELECT 1 AS one FROM current_focus_pick
        WHERE project_slug = ? AND day = ? LIMIT 1`,
    )
    .get(input.project_slug, day)
  if (exists !== null && exists !== undefined) {
    return { kind: 'skipped', reason: 'already_picked_today' }
  }

  // Step 2: staleness pass FIRST so demoted scores reflect in slate.
  const stalenessInput: Parameters<typeof runStalenessPass>[0] = {
    db: input.db,
    project_slug: input.project_slug,
    today: day,
    now,
  }
  if (input.demotion_threshold !== undefined) {
    stalenessInput.demotion_threshold = input.demotion_threshold
  }
  if (input.decay_factor !== undefined) {
    stalenessInput.decay_factor = input.decay_factor
  }
  const stalenessResult = await runStalenessPass(stalenessInput)
  log('info', `staleness pass complete`, {
    project_slug: input.project_slug,
    day,
    bumped: stalenessResult.bumped,
    demoted: stalenessResult.demoted,
  })

  // Step 3: read slate (top N by focus_score DESC).
  const slateRows = input.db
    .prepare<SlateTaskRow, [string, number]>(
      `SELECT id, title, project_id, priority, due_date, focus_score,
              staleness_demotion_count
         FROM tasks
        WHERE project_slug = ? AND status = 'open'
        ORDER BY CASE WHEN focus_score IS NULL THEN 1 ELSE 0 END ASC,
                 focus_score DESC,
                 CASE WHEN due_date IS NULL THEN 1 ELSE 0 END ASC,
                 due_date ASC,
                 created_at DESC
        LIMIT ?`,
    )
    .all(input.project_slug, NUDGE_SLATE_LLM_LIMIT)

  if (slateRows.length === 0) {
    log('info', `no open tasks; skipping`, { project_slug: input.project_slug })
    return { kind: 'skipped', reason: 'empty_slate' }
  }

  // Step 4: required deps for the LLM step. Either no credential or
  // no LLM substrate → no-op (the engine never persists a fallback row).
  if (input.llm === null) {
    log('info', `no LLM credential; skipping`, { project_slug: input.project_slug })
    return { kind: 'skipped', reason: 'no_llm' }
  }

  // Step 5: yesterday's completions + today's resolved count. Day
  // boundaries are computed in the owner's local timezone so a task
  // completed at 23:30 local on May 22 (which is 06:30 UTC May 23)
  // counts as yesterday — not today — for owners outside UTC.
  const yesterdayStart = localMidnightUtc(day, tz, -1)
  const todayStart = localMidnightUtc(day, tz, 0)
  const tomorrowStart = localMidnightUtc(day, tz, 1)

  const yesterdayCompletions = input.db
    .prepare<YesterdayCompletionRow, [string, string, string]>(
      `SELECT id, title FROM tasks
        WHERE project_slug = ? AND status = 'done'
          AND completed_at >= ? AND completed_at < ?
        ORDER BY completed_at DESC
        LIMIT 20`,
    )
    .all(input.project_slug, yesterdayStart, todayStart)

  const resolvedTodayRow = input.db
    .prepare<ResolvedTodayCountRow, [string, string, string]>(
      `SELECT COUNT(*) as count FROM tasks
        WHERE project_slug = ?
          AND completed_at >= ? AND completed_at < ?`,
    )
    .get(input.project_slug, todayStart, tomorrowStart)
  const resolvedTodayCount = resolvedTodayRow?.count ?? 0

  // Step 6: build the prompt.
  const slate: NudgeSlateRow[] = slateRows.map((r) => ({
    id: r.id,
    title: r.title,
    project_id: r.project_id,
    priority: r.priority,
    due_date: r.due_date,
    focus_score: r.focus_score,
    staleness_demotion_count: r.staleness_demotion_count,
  }))
  const yesterday: YesterdayCompletion[] = yesterdayCompletions.map((r) => ({
    id: r.id,
    title: r.title,
  }))
  const skipFlagThreshold =
    input.skip_or_kill_threshold ?? DEFAULT_SKIP_OR_KILL_THRESHOLD
  const userPrompt = buildNudgePrompt({
    day,
    slate,
    yesterday_completions: yesterday,
    resolved_today_count: resolvedTodayCount,
    skip_or_kill_flag_threshold: skipFlagThreshold,
  })

  // Step 7: persona-spliced system prompt.
  const personaBody =
    input.personaLoader === null || input.personaLoader === undefined
      ? ''
      : await input.personaLoader.load().catch(() => '')
  const baseSystem =
    'You are the daily focus picker. Choose ONE task for the user to do next. Return strict JSON inside a single ```json fence.'
  const system = composeSystemPrompt({ base: baseSystem, persona: personaBody })

  // Step 8: invoke LLM with timeout.
  const timeoutMs = input.timeout_ms ?? DEFAULT_NUDGE_TIMEOUT_MS
  let raw: string
  try {
    raw = await callWithTimeout(
      input.llm,
      { system, user: userPrompt, max_tokens: 400 },
      timeoutMs,
    )
  } catch (err) {
    log('warn', `LLM call failed; no pick today`, {
      project_slug: input.project_slug,
      day,
      err: err instanceof Error ? err.message : String(err),
    })
    return { kind: 'skipped', reason: 'llm_error' }
  }

  const parsed = parseLlmNudgeResponse(raw)
  if (parsed === null) {
    log('warn', `LLM returned unparseable response; no pick today`, {
      project_slug: input.project_slug,
      day,
      raw_preview: raw.slice(0, 200),
    })
    return { kind: 'skipped', reason: 'parse_error' }
  }

  const slateIds = new Set(slate.map((r) => r.id))
  if (!slateIds.has(parsed.task_id)) {
    log('warn', `LLM picked unknown task_id; no pick today`, {
      project_slug: input.project_slug,
      day,
      picked: parsed.task_id,
    })
    return { kind: 'skipped', reason: 'unknown_task_id' }
  }

  // Step 9: persist. Top-3 are the top of the slate (post-staleness)
  // — the staleness engine reads this tomorrow.
  const top3 = slate.slice(0, 3).map((r) => r.id)
  const rationale = clampRationale(parsed.rationale)
  const model = input.model ?? DEFAULT_NUDGE_MODEL
  const createdAt = new Date(nowMs).toISOString()

  try {
    await input.db.run(
      `INSERT INTO current_focus_pick
        (project_slug, day, task_id, llm_rationale, top_3_task_ids,
         created_at, llm_model, llm_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        input.project_slug,
        day,
        parsed.task_id,
        rationale,
        JSON.stringify(top3),
        createdAt,
        model,
      ],
    )
  } catch (err) {
    // PK collision = another tick raced us to the row. Treat as a
    // benign skip; the existing row is the authoritative pick.
    log('info', `INSERT race; row already present`, {
      project_slug: input.project_slug,
      day,
      err: err instanceof Error ? err.message : String(err),
    })
    return { kind: 'skipped', reason: 'insert_race' }
  }

  log('info', `picked task`, {
    project_slug: input.project_slug,
    day,
    task_id: parsed.task_id,
  })
  return { kind: 'ok', task_id: parsed.task_id, day }
}

/**
 * Compute the UTC ISO-8601 timestamp of midnight owner-local on the
 * date `today + dayOffset days`. `today` is the YYYY-MM-DD string
 * already resolved in the owner's local timezone.
 *
 * For owners outside UTC this matters: a task completed at 23:30
 * local on May 22 (06:30 UTC May 23) must count as "yesterday" when
 * the owner's wall-clock day is May 23 — using a UTC-midnight
 * boundary would mis-bucket it as "today."
 *
 * Approach: start with a naive Date.UTC at midnight on the target Y/M/D,
 * format that instant in `tz` via `Intl.DateTimeFormat`, compute the
 * wall-clock delta, and subtract the delta to land on the actual
 * UTC instant of midnight-in-tz.
 *
 * Exported so the nudge-engine tests can pin owner-local boundary
 * behavior without re-implementing the helper.
 */
export function localMidnightUtc(
  today: string,
  tz: string,
  dayOffset: number,
): string {
  const [yStr, mStr, dStr] = today.split('-')
  if (yStr === undefined || mStr === undefined || dStr === undefined) {
    throw new Error(`localMidnightUtc: invalid today '${today}'`)
  }
  let year = Number(yStr)
  let month = Number(mStr)
  let day = Number(dStr)
  if (dayOffset !== 0) {
    const shifted = new Date(Date.UTC(year, month - 1, day))
    shifted.setUTCDate(shifted.getUTCDate() + dayOffset)
    year = shifted.getUTCFullYear()
    month = shifted.getUTCMonth() + 1
    day = shifted.getUTCDate()
  }
  const naiveMs = Date.UTC(year, month - 1, day, 0, 0, 0)
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(naiveMs))
  let lY = 0
  let lM = 0
  let lD = 0
  let lH = 0
  let lMin = 0
  let lSec = 0
  for (const p of parts) {
    if (p.type === 'year') lY = Number(p.value)
    else if (p.type === 'month') lM = Number(p.value)
    else if (p.type === 'day') lD = Number(p.value)
    else if (p.type === 'hour') {
      // en-CA renders midnight as '24' on some Bun / ICU builds — normalize.
      lH = Number(p.value === '24' ? '0' : p.value)
    } else if (p.type === 'minute') lMin = Number(p.value)
    else if (p.type === 'second') lSec = Number(p.value)
  }
  // `naiveMs` as a UTC instant is `lY-lM-lD lH:lMin:lSec` in tz.
  // Wall-clock delta from the desired midnight (year-month-day 00:00):
  const seenWallMs = Date.UTC(lY, lM - 1, lD, lH, lMin, lSec)
  const targetWallMs = Date.UTC(year, month - 1, day, 0, 0, 0)
  const wallDelta = seenWallMs - targetWallMs
  // `wallDelta > 0` means tz is ahead of UTC; the actual UTC instant of
  // midnight-in-tz lies `wallDelta` before naiveMs.
  return new Date(naiveMs - wallDelta).toISOString()
}

/**
 * Build a per-instance cron handler that runs the nudge engine. Mirrors
 * `buildFocusScoreRecomputeHandler` so the registration helper below
 * can drop the handler into the shared `CronHandlerRegistry`.
 */
export function buildNudgeEngineHandler(deps: NudgeEngineHandlerDeps): CronHandler {
  return async (ctx) => {
    const input: NudgePassInput = {
      db: deps.db,
      project_slug: ctx.owner_slug,
      llm: deps.llm,
    }
    if (deps.personaLoader !== undefined) {
      input.personaLoader = deps.personaLoader
    }
    if (deps.now !== undefined) input.now = deps.now
    // Resolve the zone at THIS tick (contract: "at engine invocation"), keyed
    // on the dispatched owner so the shared hosted handler picks the right
    // instance's zone. A per-tick resolver result wins over the static
    // `timezone`; when it returns undefined we fall through to the static
    // field, then the pass's own `DEFAULT_OWNER_TIMEZONE` default.
    const resolvedTz = deps.resolveTimezone?.(ctx.owner_slug)
    if (resolvedTz !== undefined) input.timezone = resolvedTz
    else if (deps.timezone !== undefined) input.timezone = deps.timezone
    if (deps.timeout_ms !== undefined) input.timeout_ms = deps.timeout_ms
    if (deps.model !== undefined) input.model = deps.model
    if (deps.demotion_threshold !== undefined) {
      input.demotion_threshold = deps.demotion_threshold
    }
    if (deps.decay_factor !== undefined) input.decay_factor = deps.decay_factor
    if (deps.skip_or_kill_threshold !== undefined) {
      input.skip_or_kill_threshold = deps.skip_or_kill_threshold
    }
    if (deps.log !== undefined) input.log = deps.log
    const outcome = await runNudgePass(input)
    if (outcome.kind === 'ok') {
      return { status: 'ok', detail: `day=${outcome.day} task_id=${outcome.task_id}` }
    }
    return { status: 'skipped', detail: outcome.reason }
  }
}

/**
 * Build the per-instance nudge cron job definition. Job name budget:
 * 64 chars (`/^[a-z][a-z0-9-]{0,63}$/`). `'tasks-nudge-' (12)` leaves
 * 52 chars for the slug. Instance slugs cap at 50 chars
 * (allocate-slug.ts) so the candidate name always fits — the hash
 * fallback below is defense-in-depth for pathological test slugs.
 */
export function buildNudgeEngineJob(input: {
  project_slug: string
  interval_ms?: number
}): CronJobDef {
  const candidate = `tasks-nudge-${input.project_slug}`
  const name =
    candidate.length <= 64 ? candidate : `tasks-nudge-${hashSlug(input.project_slug)}`
  return {
    name,
    description: `Daily nudge pick + staleness pass for ${input.project_slug}`,
    schedule: {
      kind: 'interval_ms',
      interval_ms: input.interval_ms ?? DEFAULT_NUDGE_INTERVAL_MS,
    },
    handler: NUDGE_ENGINE_HANDLER_NAME,
    skip_if_running: true,
    expected_duration_ms: 15_000,
  }
}

/**
 * Register the nudge engine cron + handler into the shared registries.
 * Idempotent on the handler side — duplicate registrations are
 * rejected by the registry, so the first instance in a hosted
 * boot wins the handler registration and subsequent instances
 * piggy-back on the same handler instance.
 */
export function registerNudgeEngineCron(input: {
  project_slug: string
  jobs: CronJobRegistry
  handlers: CronHandlerRegistry
  handler: CronHandler
  interval_ms?: number
}): { job_name: string } {
  const jobInput: Parameters<typeof buildNudgeEngineJob>[0] =
    input.interval_ms !== undefined
      ? { project_slug: input.project_slug, interval_ms: input.interval_ms }
      : { project_slug: input.project_slug }
  const job = buildNudgeEngineJob(jobInput)
  input.jobs.register(job)
  if (input.handlers.get(NUDGE_ENGINE_HANDLER_NAME) === undefined) {
    input.handlers.register(NUDGE_ENGINE_HANDLER_NAME, input.handler)
  }
  return { job_name: job.name }
}

function hashSlug(slug: string): string {
  let h = 5381
  for (let i = 0; i < slug.length; i++) {
    h = ((h << 5) + h) ^ slug.charCodeAt(i)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8)
}

/**
 * Convenience helper for tests: project a `Task` returned by
 * `TaskStore` into the slate row shape (with the staleness columns
 * the engine reads via raw SQL).
 *
 * Production path reads the columns directly; this helper is only
 * for tests that build slates from TaskStore-shaped data.
 */
export function slateRowFromTask(
  task: Task,
  staleness_demotion_count = 0,
): NudgeSlateRow {
  return {
    id: task.id,
    title: task.title,
    project_id: task.project_id,
    priority: task.priority,
    due_date: task.due_date,
    focus_score: task.focus_score,
    staleness_demotion_count,
  }
}

// Re-export TaskStore for downstream consumers that build the engine
// alongside the canonical store.
export { TaskStore }
