/**
 * @neutronai/tasks — LLM-primary task prioritization (WAVE 3 PR-7).
 *
 * Promotes task prioritization from the deterministic focus-score
 * formula (`tasks/focus-score.ts`) to an **LLM-primary** ranking. A
 * per-instance pass hands the open backlog to an LLM which returns an
 * explicit ordering + a one-line rationale per task; the result is
 * stamped onto the `llm_rank` / `llm_reason` / `prioritized_by` /
 * `prioritized_at` columns (migration 0085) and the `focus_score`
 * order clause (`tasks/store.ts`) renders `llm_rank ASC` first, falling
 * back to `focus_score DESC` for rows the pass hasn't reached yet.
 *
 * **LLM primary, deterministic fallback — NOT a flag.** There is no
 * toggle. The deterministic path runs ONLY when:
 *   - no LLM is configured (`llm === null`), or
 *   - the LLM call throws / times out, or
 *   - the LLM returns an unparseable / empty / out-of-domain ordering.
 * In every fallback case the pass still stamps the columns (ranking by
 * `focus_score DESC`, `prioritized_by='deterministic'`, `llm_reason`
 * NULL) so the render column is single-source and always populated.
 *
 * Cron shape mirrors `tasks/focus-score-cron.ts`: a
 * `buildTaskPrioritizeHandler(...)` factory + a
 * `registerTaskPrioritizeCron(...)` glue function that drops the job +
 * handler into the shared `CronJobRegistry` / `CronHandlerRegistry`.
 * The handler is a safe deterministic-fallback no-LLM pass when no
 * credential is wired, so registering it before a credential exists is
 * harmless — it just re-derives the focus order until the LLM is
 * available.
 *
 * Spec: docs/plans/wave3-tabbed-interface-build-plan.md § 3.4 (PR-7).
 */

import type {
  CronHandler,
  CronHandlerRegistry,
} from '@neutronai/cron/handlers.ts'
import type {
  CronJobDef,
  CronJobRegistry,
} from '@neutronai/cron/jobs.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { createLogger } from '@neutronai/logger'
import type { LlmCallFn } from '@neutronai/contracts/llm-call.ts'
import { computeFocusScore } from './focus-score.ts'

/**
 * 6-hour cadence — the LLM ranking is more expensive than the pure
 * focus-score recompute (one Anthropic call per instance per tick) and
 * the ordering only needs to track the same daily-tick signals the
 * focus score does, plus whatever the owner just captured. 6h (4 ticks
 * per day) keeps the ranking fresh without spending a call every few
 * minutes. The store stamps `focus_score` synchronously on every write
 * so a brand-new task still sorts via the fallback clause between ticks.
 */
export const DEFAULT_TASK_PRIORITIZE_INTERVAL_MS = 6 * 60 * 60 * 1000

export const TASK_PRIORITIZE_HANDLER_NAME = 'tasks.prioritize_llm'

/** Default model id (overridable via the handler dep). Mirrors the nudge engine. */
export const DEFAULT_TASK_PRIORITIZE_MODEL = 'claude-haiku-4-5'

/** Default LLM timeout — a stuck call must never block the cron tick. */
export const DEFAULT_TASK_PRIORITIZE_TIMEOUT_MS = 8_000

/**
 * Cap on how many open tasks one pass ranks. The prompt fits ~50
 * candidates comfortably; beyond that we rank the top-N by focus_score
 * (so the most urgent work is always LLM-ranked) and leave the long
 * tail to the fallback clause. Mirrors the pick-next candidate cap.
 */
export const DEFAULT_TASK_PRIORITIZE_LIMIT = 50

/** `max_tokens` budget for the ranking response. ~50 tasks × short reason. */
const PRIORITIZE_MAX_TOKENS = 2_048

/** How which mechanism produced a row's current rank. */
export type PrioritizedBy = 'llm' | 'deterministic'

/** One open task as the prioritizer sees it. */
interface OpenTaskRow {
  id: string
  title: string
  description: string | null
  priority: number | null
  due_date: string | null
  focus_score: number | null
  created_at: string
  updated_at: string
}

export interface TaskPrioritizeResult {
  /** Open rows considered this pass. */
  scanned: number
  /** Rows whose rank columns were (re)written. */
  ranked: number
  /** Which mechanism produced the ranking written this pass. */
  prioritized_by: PrioritizedBy
  /** The model id when `prioritized_by === 'llm'`, else null. */
  model_id: string | null
}

export interface PrioritizeTasksForProjectInput {
  db: ProjectDb
  project_slug: string
  /**
   * The LLM call. `null` (or omitted) forces the deterministic
   * fallback — the pass still runs and stamps the columns by
   * `focus_score DESC`.
   */
  llm?: LlmCallFn | null
  /** Test seam — defaults to `() => new Date()`. */
  now?: () => Date
  /** Override the model id label stamped on telemetry. */
  model?: string
  /** Override the LLM timeout. */
  timeout_ms?: number
  /** Override the candidate cap. */
  limit?: number
}

/**
 * Run a single prioritize pass for one instance. LLM-primary with a
 * deterministic fallback baked in — see the module docblock.
 *
 * Writes happen in ONE `db.transaction(...)` so the projection layer's
 * debounced subscriber sees at most one wake-up per instance per tick,
 * mirroring `recomputeFocusScoresForProject`.
 */
export async function prioritizeTasksForProject(
  input: PrioritizeTasksForProjectInput,
): Promise<TaskPrioritizeResult> {
  const now = input.now ?? ((): Date => new Date())
  const nowDate = now()
  const nowIso = nowDate.toISOString()
  const limit = input.limit ?? DEFAULT_TASK_PRIORITIZE_LIMIT
  const model = input.model ?? DEFAULT_TASK_PRIORITIZE_MODEL
  const timeout_ms = input.timeout_ms ?? DEFAULT_TASK_PRIORITIZE_TIMEOUT_MS

  // Pull the FULL open backlog. We rank EVERY open row (not just the
  // top-N) so no row keeps a stale `llm_rank` from a previous pass once
  // it falls outside the prompt cap — `writeRanking` also clears the
  // whole open set first, so a pass is the single source of truth for
  // the project's ranking. The prompt cap (`limit`) only bounds how many
  // rows we hand the LLM; the tail beyond the cap is ranked
  // deterministically by focus_score.
  const rows = input.db
    .prepare<OpenTaskRow, [string]>(
      `SELECT id, title, description, priority, due_date, focus_score, created_at, updated_at
         FROM tasks
        WHERE project_slug = ? AND status = 'open'`,
    )
    .all(input.project_slug)

  if (rows.length === 0) {
    return { scanned: 0, ranked: 0, prioritized_by: 'deterministic', model_id: null }
  }

  // The deterministic order over ALL open rows — recomputed here (not
  // read from the stored column) so the fallback is correct even if the
  // focus-score cron hasn't ticked since the last mutation. This is both
  // the full fallback order AND the order of the tail appended after the
  // LLM-ranked head.
  const deterministicOrder = [...rows].sort(
    (a, b) => focusScoreFor(b, nowDate) - focusScoreFor(a, nowDate),
  )

  // No LLM configured → deterministic fallback, no call attempted.
  if (input.llm === null || input.llm === undefined) {
    const ranked = await writeRanking({
      db: input.db,
      project_slug: input.project_slug,
      order: deterministicOrder.map((r) => ({ id: r.id, reason: null })),
      prioritized_by: 'deterministic',
      prioritized_at: nowIso,
    })
    return { scanned: rows.length, ranked, prioritized_by: 'deterministic', model_id: null }
  }

  // Only the top-N by focus_score go to the LLM (prompt-budget cap); the
  // rest are ranked deterministically in the tail.
  const candidates = deterministicOrder.slice(0, limit)

  // LLM-primary path. Any failure (throw / timeout / unparseable /
  // empty / out-of-domain) drops to the deterministic fallback.
  try {
    const raw = await callWithTimeout(
      input.llm,
      {
        system: PRIORITIZE_SYSTEM_PROMPT,
        user: buildPrioritizeUserPrompt(candidates),
        max_tokens: PRIORITIZE_MAX_TOKENS,
      },
      timeout_ms,
    )
    const parsed = parseRanking(raw, new Set(candidates.map((r) => r.id)))
    if (parsed.length === 0) {
      throw new Error('llm returned no valid ranking')
    }
    // Append every open row the LLM didn't rank (candidates it omitted +
    // the entire beyond-cap tail), in deterministic order, so EVERY open
    // row gets a fresh rank this pass — no NULL gaps, no stale ranks.
    const seen = new Set(parsed.map((p) => p.id))
    const merged = [
      ...parsed,
      ...deterministicOrder
        .filter((r) => !seen.has(r.id))
        .map((r) => ({ id: r.id, reason: null as string | null })),
    ]
    const ranked = await writeRanking({
      db: input.db,
      project_slug: input.project_slug,
      order: merged,
      prioritized_by: 'llm',
      prioritized_at: nowIso,
    })
    return { scanned: rows.length, ranked, prioritized_by: 'llm', model_id: model }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    createLogger('task-prioritize').warn('llm_ranking_failed_fallback_deterministic', {
      project: input.project_slug,
      error: msg,
    })
    const ranked = await writeRanking({
      db: input.db,
      project_slug: input.project_slug,
      order: deterministicOrder.map((r) => ({ id: r.id, reason: null })),
      prioritized_by: 'deterministic',
      prioritized_at: nowIso,
    })
    return { scanned: rows.length, ranked, prioritized_by: 'deterministic', model_id: null }
  }
}

/** Recompute the focus score for one row against `now` (fallback ordering). */
function focusScoreFor(row: OpenTaskRow, now: Date): number {
  return computeFocusScore({
    priority: row.priority,
    due_date: row.due_date,
    updated_at: row.updated_at,
    now,
  })
}

/**
 * Stamp `llm_rank` (1-based, in `order`), `llm_reason`, `prioritized_by`,
 * and `prioritized_at` for each row in one transaction. Clears the
 * ranking columns for EVERY open row of the project first, so a row that
 * dropped out of this pass (e.g. completed, or no longer ranked) can
 * never keep a stale rank. Returns the count written.
 */
async function writeRanking(input: {
  db: ProjectDb
  project_slug: string
  order: Array<{ id: string; reason: string | null }>
  prioritized_by: PrioritizedBy
  prioritized_at: string
}): Promise<number> {
  let written = 0
  await input.db.transaction(async (tx) => {
    // Reset the open set so no row carries a rank this pass didn't write.
    await tx.run(
      `UPDATE tasks
          SET llm_rank = NULL, llm_reason = NULL, prioritized_by = NULL, prioritized_at = NULL
        WHERE project_slug = ? AND status = 'open'`,
      [input.project_slug],
    )
    for (let i = 0; i < input.order.length; i++) {
      const entry = input.order[i]
      if (entry === undefined) continue
      await tx.run(
        `UPDATE tasks
            SET llm_rank = ?, llm_reason = ?, prioritized_by = ?, prioritized_at = ?
          WHERE id = ?`,
        [i + 1, entry.reason, input.prioritized_by, input.prioritized_at, entry.id],
      )
      written += 1
    }
  })
  return written
}

/**
 * Wrap `llm` in a timeout so a stuck Anthropic call can never block the
 * cron tick. Rejects with an Error on expiry. Mirrors the nudge
 * engine's `callWithTimeout`.
 */
async function callWithTimeout(
  llm: LlmCallFn,
  call: { system: string; user: string; max_tokens: number },
  timeout_ms: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('task_prioritize_llm_timeout')),
      timeout_ms,
    )
    llm(call)
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}

/**
 * Locked v1 system prompt. The owner-voice rules are repeated inline so
 * the model doesn't need SOUL.md access to honour them (same posture as
 * the pick-next prompt).
 */
export const PRIORITIZE_SYSTEM_PROMPT = `You are the owner's task-prioritization engine. You receive the owner's
open tasks (each with an id, title, optional description, priority
(0-3; 3 = most urgent), optional due_date, a deterministic focus_score,
and timestamps). Rank EVERY task from most-important-to-do-next to
least. Optimize for:
- Highest impact toward revenue / customer-growth work first.
- Honor explicit due_dates: anything due within 24h jumps above lower-
  impact work.
- Group related work to avoid context switches.
- The focus_score is a deterministic urgency hint — use it as a prior,
  not a hard rule; your job is to apply judgement the formula can't.

Return ONLY a JSON object, no prose, of the exact shape:
{"ranking":[{"id":"<task id>","reason":"<one terse line, start with a verb>"},...]}

Rules for "reason": 1 short sentence, engineering-first, no validating
openings ("Great", "Sure"), no exclamation marks, start with a verb.
Include EVERY task id you were given, each exactly once.`

/** Build the user message: the compact candidate JSON. */
export function buildPrioritizeUserPrompt(
  rows: ReadonlyArray<OpenTaskRow>,
): string {
  const candidates = rows.map((r) => {
    const c: Record<string, unknown> = { id: r.id, title: r.title }
    if (r.description !== null && r.description.length > 0) {
      c['description'] = r.description.slice(0, 280)
    }
    if (r.priority !== null) c['priority'] = r.priority
    if (r.due_date !== null) c['due_date'] = r.due_date
    if (r.focus_score !== null) c['focus_score'] = r.focus_score
    c['created_at'] = r.created_at
    return c
  })
  return `Open tasks (${rows.length}):\n${JSON.stringify(candidates, null, 2)}`
}

/**
 * Parse the LLM ranking response into an ordered `{id, reason}[]`,
 * keeping only ids in `valid` and dropping duplicates (first wins).
 * Tolerates the model wrapping the JSON in a ```json fence or trailing
 * prose. Returns `[]` when nothing parseable is found — the caller
 * treats that as a fallback trigger.
 */
export function parseRanking(
  raw: string,
  valid: ReadonlySet<string>,
): Array<{ id: string; reason: string | null }> {
  const json = extractJsonObject(raw)
  if (json === null) return []
  let obj: unknown
  try {
    obj = JSON.parse(json)
  } catch {
    return []
  }
  if (typeof obj !== 'object' || obj === null) return []
  const ranking = (obj as { ranking?: unknown }).ranking
  if (!Array.isArray(ranking)) return []

  const out: Array<{ id: string; reason: string | null }> = []
  const seen = new Set<string>()
  for (const entry of ranking) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string') continue
    if (!valid.has(id) || seen.has(id)) continue
    const reasonRaw = (entry as { reason?: unknown }).reason
    const reason =
      typeof reasonRaw === 'string' && reasonRaw.trim().length > 0
        ? reasonRaw.replace(/\s+/g, ' ').trim().slice(0, 200)
        : null
    out.push({ id, reason })
    seen.add(id)
  }
  return out
}

/**
 * Extract the first balanced top-level JSON object substring from `raw`.
 * Handles fenced (```json ... ```) and prose-wrapped responses without
 * a regex-with-backtracking risk.
 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Build the per-instance cron handler that runs the LLM-primary
 * prioritize pass. Safe when `llm` is null — the handler runs the
 * deterministic fallback every tick until a credential is wired.
 */
export function buildTaskPrioritizeHandler(deps: {
  db: ProjectDb
  llm: LlmCallFn | null
  now?: () => Date
  model?: string
  timeout_ms?: number
  limit?: number
}): CronHandler {
  return async (ctx) => {
    const passInput: PrioritizeTasksForProjectInput = {
      db: deps.db,
      project_slug: ctx.owner_slug,
      llm: deps.llm,
    }
    if (deps.now !== undefined) passInput.now = deps.now
    if (deps.model !== undefined) passInput.model = deps.model
    if (deps.timeout_ms !== undefined) passInput.timeout_ms = deps.timeout_ms
    if (deps.limit !== undefined) passInput.limit = deps.limit
    const result = await prioritizeTasksForProject(passInput)
    if (result.scanned === 0) {
      return { status: 'skipped', detail: 'no_open_tasks' }
    }
    return {
      status: 'ok',
      detail: `scanned=${result.scanned} ranked=${result.ranked} by=${result.prioritized_by}`,
    }
  }
}

/** Build the per-instance cron job definition for the prioritize pass. */
export function buildTaskPrioritizeJob(input: {
  project_slug: string
  interval_ms?: number
}): CronJobDef {
  // Cron job name budget is 64 chars (validateJobName /^[a-z][a-z0-9-]{0,63}$/);
  // 'tasks-prioritize-' (17) leaves 46 chars for the instance slug. The
  // slug allocator caps at 50 chars, so we fall back to a hash for the
  // worst case (mirrors buildFocusScoreRecomputeJob).
  const slug = input.project_slug
  const candidate = `tasks-prioritize-${slug}`
  const name = candidate.length <= 64 ? candidate : `tasks-prioritize-${hashSlug(slug)}`
  return {
    name,
    description: `LLM-primary task prioritization for ${input.project_slug}`,
    schedule: {
      kind: 'interval_ms',
      interval_ms: input.interval_ms ?? DEFAULT_TASK_PRIORITIZE_INTERVAL_MS,
    },
    handler: TASK_PRIORITIZE_HANDLER_NAME,
    skip_if_running: true,
    expected_duration_ms: 30_000,
  }
}

/**
 * Register the prioritize cron + handler against the per-instance
 * `CronJobRegistry` + `CronHandlerRegistry`. Idempotent on the handler
 * side — the registry rejects duplicate handler names, so a
 * multi-instance boot that calls this once per instance only registers
 * the shared handler the first time.
 */
export function registerTaskPrioritizeCron(input: {
  project_slug: string
  jobs: CronJobRegistry
  handlers: CronHandlerRegistry
  handler: CronHandler
  interval_ms?: number
}): { job_name: string } {
  const jobInput: Parameters<typeof buildTaskPrioritizeJob>[0] =
    input.interval_ms !== undefined
      ? { project_slug: input.project_slug, interval_ms: input.interval_ms }
      : { project_slug: input.project_slug }
  const job = buildTaskPrioritizeJob(jobInput)
  input.jobs.register(job)
  if (input.handlers.get(TASK_PRIORITIZE_HANDLER_NAME) === undefined) {
    input.handlers.register(TASK_PRIORITIZE_HANDLER_NAME, input.handler)
  }
  return { job_name: job.name }
}

/**
 * Deterministic 8-char djb2 hash for the cron job-name fallback (same
 * as `tasks/focus-score-cron.ts`).
 */
function hashSlug(slug: string): string {
  let h = 5381
  for (let i = 0; i < slug.length; i++) {
    h = ((h << 5) + h) ^ slug.charCodeAt(i)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8)
}
