/**
 * @neutronai/gateway/proactive — the work-continuation wakeup loop.
 *
 * The owner's ask, verbatim: "I need my sessions to keep working all night, so
 * they need to wake up and check every 5min … and actually take actions to get
 * this moving." The thing that makes that real in the reference system is NOT a
 * session-side scheduler — it is a SERVER-SIDE tick that re-enters the session
 * with a fresh turn. This module is that tick for Neutron, built deliberately on
 * the two mechanisms that already work in production:
 *
 *   • `trident/tick.ts` made this exact migration once before: it replaced the
 *     legacy harness's session-bound ScheduleWakeup driver with an in-process
 *     `SupervisedLoop` sweep, precisely because a session-bound wakeup dies with
 *     its session and a gateway-driven warm REPL has nothing pumping it for a
 *     scheduled re-entry to land in. A wakeup the session schedules for itself
 *     is a scheduler that silently never fires after the next eviction — the
 *     worst failure shape this codebase knows. The server-side tick survives
 *     evictions, deploys, and restarts for free, because the loop is re-armed at
 *     every composition and its state lives in durable rows.
 *
 *   • The fired-reminder dispatcher already proves a server-initiated turn can
 *     land ON the owner's warm project chat session: `liveAgentSubstrate` has no
 *     `projectIdResolver`, so `metering_context.project_id` reaches the warm-pool
 *     key (`build-llm-call-substrate.ts` fallback → `pool.ts poolKeyFor`), and a
 *     turn keyed `(cc-agent-<handle>, owner, <project>)` IS the owner's chat
 *     session for that project. This loop composes exactly the same way.
 *
 * WHAT COUNTS AS "A SESSION WITH WORK OUTSTANDING" — the Work Board, nothing
 * new: an item with `status='in_progress'` whose `linked_run_id` is absent or no
 * longer live. An item a trident/agent-dispatch run is actively driving is NOT
 * woken (the trident tick is already its wakeup driver — waking it here would
 * double-drive one work item from two schedulers). Arming and disarming are
 * therefore board mutations the owner and the agent can both already perform,
 * durable across restarts, with no second queue to drift.
 *
 * "ACTIVELY DRIVING" IS A MEASUREMENT, NOT A PHASE. The first cut of that rule
 * asked only whether the linked run was non-terminal, and a stalled run is
 * non-terminal forever — so on the owner's instance three parked runs suppressed
 * every subsequent tick and the loop went quiet after one firing. The selector
 * (`work-wakeup-selection.ts`) now defers only to a run that has ADVANCED
 * recently, and hands back the deferrals it made so this sweep can log them:
 * going quiet is the one forbidden outcome, and a silent skip is going quiet.
 *
 * THE OWNER-ACTIVITY GATE: a project whose chat has seen a GENUINE owner turn
 * inside `owner_grace_ms` (default 30 min) is skipped — while he is driving, the
 * session does not need a robot poking it, and a wakeup turn would queue ahead
 * of his next message on the same warm REPL. The watermark is
 * `last_user_activity_at` (only a real person moves it — the same field the
 * idle-nudge sweep relies on for exactly the same reason).
 *
 * LOUD ON FAILURE, QUIET ON PROGRESS: every wakeup report is posted as a durable
 * inert chat row (visible in history + live push), but with the native device
 * buzz SUPPRESSED — twelve buzzes an hour all night is a product bug, not a
 * feature. The two cases that DO buzz are the two the owner must see: a turn
 * that answers `BLOCKED:` and a wakeup mechanism failure (posted on the first
 * failure and every `WAKEUP_FAILURE_POST_CADENCE`th thereafter, so a dead
 * substrate is loud without being a siren). Going quiet is the one forbidden
 * outcome.
 */

import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { ToolDef } from '@neutronai/cores-sdk/manifest'
import { SupervisedLoop, type LoopDescriptor } from '@neutronai/loop'
import { createLogger } from '@neutronai/logger'

const log = createLogger('work-wakeup')

/** The owner's stated cadence: wake and act every ~5 minutes. */
export const WORK_WAKEUP_INTERVAL_MS = 5 * 60_000

/**
 * Skip a project whose chat saw a genuine owner turn this recently — he is
 * driving; the session is not asleep.
 */
export const WORK_WAKEUP_OWNER_GRACE_MS = 30 * 60_000

/**
 * Per-turn wall-clock budget. Below the 5-min cadence so a hung turn cannot
 * make the single-flight loop skip forever; above the reminder default because
 * a wakeup turn does real tool work, not one-line composition.
 */
export const WORK_WAKEUP_TURN_TIMEOUT_MS = 4 * 60_000

/** Reply budget — the report is 1–3 sentences; the WORK happens in the turn. */
export const WORK_WAKEUP_MAX_TOKENS = 4096

/** Upper bound on a posted report; the overflow is truncated, never dropped. */
export const MAX_WAKEUP_REPORT_CHARS = 2_000

/** Cap on titles folded into one prompt (the rest are counted, not listed). */
export const MAX_WAKEUP_PROMPT_ITEMS = 6

/**
 * A failing project posts its failure on streak 1 and every Nth failure after
 * — loud, but not one buzz per 5-minute tick for the same dead substrate.
 */
export const WAKEUP_FAILURE_POST_CADENCE = 6

/** A reply starting with this is a blocked declaration and posts LOUD. */
export const WAKEUP_BLOCKED_PREFIX = 'BLOCKED:'

/**
 * Re-log a STANDING deferral at most this often, PER ITEM. A deferral is a
 * per-tick decision, so logging every one of them would write 288 lines a day per
 * item for as long as the build runs — a volume that stops being a signal. The
 * window is edge-friendly rather than edge-triggered: a newly deferred item has no
 * window and logs on the first sweep that defers it, so the interesting transition
 * is never delayed, while a standing deferral repeats every half hour instead of
 * every five minutes. Half an hour is chosen against the reader, not the writer:
 * short enough that "is anything progressing?" is answerable from a glance at the
 * tail, long enough that the answer is not buried in itself.
 *
 * PER ITEM, NOT PER RUN, and the distinction is the whole point of the line. One
 * trident run can drive several board items; keying the window on the run made the
 * SECOND and third items on that run silent — the sweep would report three
 * deferrals in its counters and name one of them, which is the same partial
 * invisibility this logging exists to remove. The item is the thing the owner is
 * asking about, so the item is the key.
 */
export const WAKEUP_DEFERRAL_LOG_WINDOW_MS = 30 * 60_000

/** One in-progress, un-driven Work Board item. */
export interface WakeupWorkItem {
  title: string
}

/**
 * One in-progress item this sweep did NOT wake because a live trident run is
 * still driving it. Carried so the decision is LOGGED rather than silent — the
 * failure this cured was three items disappearing from the only autonomy
 * mechanism with nothing written anywhere to say so.
 */
export interface WakeupDeferredItem {
  title: string
  /** The `work_board_items.id` — the deferral log's rate-limit key. */
  item_id: string
  /** The `code_trident_runs.id` the item is bound to. */
  run_id: string
  /** That run's phase, verbatim (`forge-init`, `argus`, …). */
  phase: string
  /** ms since the run's `last_advanced_at` — how fresh the deferral's basis is. */
  since_advance_ms: number
}

/** Everything the sweep needs to wake ONE project. */
export interface WakeupProjectWork {
  /** Work Board storage key (bare owner slug for General, project id otherwise). */
  project_key: string
  /**
   * The chat/session scope for the compose turn's `metering_context.project_id`
   * — `'general'` for General, the project id verbatim otherwise. This is the
   * live-chat convention (`build-live-agent-turn.ts` `turn.project_id ?? 'general'`),
   * and matching it is what lands the turn ON the owner's warm session instead
   * of a parallel one.
   */
  chat_scope: string
  /** Human label for the prompt + failure notices. */
  label: string
  items: WakeupWorkItem[]
  /**
   * In-progress items withheld from `items` because a live run is driving them.
   * Reported, never acted on. A project may legitimately arrive with `items`
   * EMPTY and this non-empty — that is the "everything is being built" state, and
   * the sweep still logs it rather than looking like it found no work at all.
   */
  deferred: WakeupDeferredItem[]
}

/**
 * The composition seam — structurally identical to `ReminderLlm`, so the
 * composer passes the SAME `buildSubstrateReminderLlm(liveAgentSubstrate)`
 * wrapper the fired-reminder path uses. One substrate entry, two callers.
 */
export interface WakeupLlm {
  compose(spec: AgentSpec, opts?: { timeout_ms?: number }): Promise<string>
}

export interface WorkWakeupDeps {
  /** Projects with outstanding, un-driven in-progress work. Empty ⇒ no-op tick. */
  listOutstanding(): WakeupProjectWork[] | Promise<WakeupProjectWork[]>
  /**
   * Epoch-ms of the most recent GENUINE owner turn in the project's chat
   * (`last_user_activity_at` semantics), or null when he has never spoken there.
   */
  ownerActivityMs(project_key: string): number | null | Promise<number | null>
  llm: WakeupLlm
  /**
   * Post one report/notice to the project's chat topic. `loud: false` ⇒ durable
   * + live-pushed with the device buzz suppressed; `loud: true` ⇒ a normal
   * notifying post. Returns whether the durable row was written.
   */
  post(input: { project_key: string; body: string; loud: boolean }): boolean | Promise<boolean>
  /**
   * ⚠️ MUST be the owner's live-chat surface verbatim (`LIVE_AGENT_TOOL_NAMES`).
   * The warm-pool reuse guard evicts a child whose requested `--tools` surface
   * differs from the one it was spawned with, so a narrower list here would tear
   * down the owner's chat REPL on every wakeup (`reminders/dispatcher.ts`
   * carries the same warning for the same reason).
   */
  tool_names: ReadonlyArray<string>
  /** Live best-model thunk (`getBestModel`) — overnight work gets the real model. */
  resolveModel(): string
  now?: () => number
  interval_ms?: number
  owner_grace_ms?: number
  turn_timeout_ms?: number
}

/** Per-tick outcome summary (returned for tests + logged). */
export interface WakeupSweepResult {
  woke: number
  skipped_active: number
  failed: number
  /** Items left to a live run this tick (one `wakeup_deferred_to_live_run` each). */
  deferred_to_run: number
}

/** Truncate for a prompt line / a log field — bounded, marked, never thrown. */
function bound(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * The wakeup turn prompt. Exported for tests (and so the composer's prompt and
 * the tests can never drift apart). Deliberately imperative about ACTING: the
 * failure mode being cured is a session that plans instead of moving.
 */
export function buildWakeupPrompt(input: {
  label: string
  items: WakeupWorkItem[]
  now_iso: string
}): string {
  const listed = input.items.slice(0, MAX_WAKEUP_PROMPT_ITEMS)
  const extra = input.items.length - listed.length
  const lines = listed.map((it) => `- ${bound(it.title, 140)}`)
  if (extra > 0) lines.push(`- (+${extra} more in-progress item${extra === 1 ? '' : 's'})`)
  return [
    `[SCHEDULED WAKEUP — ${input.now_iso}]`,
    `You are waking on your recurring work cadence for ${input.label}. The owner is away;`,
    'you are expected to make real progress, not wait for instructions.',
    'The Work Board shows these in-progress items with no live background run:',
    ...lines,
    '',
    'In THIS turn:',
    '1. Take the single most valuable CONCRETE action toward one of these items using your',
    '   tools (read/edit files, run commands, dispatch work). Not a plan — an action.',
    '2. If an item is actually complete, update the Work Board to say so.',
    '3. Reply with 1-3 short sentences: what you just did, and the immediate next step.',
    `If you genuinely cannot act (missing access, missing decision), reply starting with`,
    `"${WAKEUP_BLOCKED_PREFIX}" and state exactly what is needed.`,
  ].join('\n')
}

/**
 * Run ONE sweep. Sequential across projects on purpose: each wakeup is a real
 * agentic turn on a warm REPL, and a parallel fan-out would spike N children at
 * once for no owner-visible benefit. `failureStreaks` is process-local state —
 * a restart resets it, which merely means the first post-restart failure is
 * loud again. That is the right direction to fail in.
 */
export async function runWorkWakeupSweep(
  deps: WorkWakeupDeps,
  failureStreaks: Map<string, number>,
  deferralLog: Map<string, number> = new Map(),
): Promise<WakeupSweepResult> {
  const now = deps.now ?? ((): number => Date.now())
  const grace = deps.owner_grace_ms ?? WORK_WAKEUP_OWNER_GRACE_MS
  const turn_timeout = deps.turn_timeout_ms ?? WORK_WAKEUP_TURN_TIMEOUT_MS
  const result: WakeupSweepResult = { woke: 0, skipped_active: 0, failed: 0, deferred_to_run: 0 }

  const projects = await deps.listOutstanding()
  // Drop streak entries for projects that no longer have outstanding work, so
  // the map cannot grow without bound across long uptimes.
  const liveKeys = new Set(projects.map((p) => p.project_key))
  for (const key of [...failureStreaks.keys()]) {
    if (!liveKeys.has(key)) failureStreaks.delete(key)
  }
  // THE SAME PRUNE, FOR THE SAME REASON, ON THE DEFERRAL WINDOWS. This window is
  // owned by the loop rather than taken from `log.rateLimited`, whose state is a
  // module-global map pruned only by `resetLoggerStateForTests`
  // (`logger/index.ts:237-247`). Every other caller of that helper keys it on a
  // bounded vocabulary; a board item id is not one — it is fresh per item, for as
  // long as the process lives. Owning the map keeps the keyspace bounded by what
  // is CURRENTLY deferred, which is the same discipline the streak map fifteen
  // lines up already follows.
  const deferredKeys = new Set(
    projects.flatMap((p) => p.deferred.map((d) => `${p.project_key}:${d.item_id}`)),
  )
  for (const key of [...deferralLog.keys()]) {
    if (!deferredKeys.has(key)) deferralLog.delete(key)
  }

  for (const project of projects) {
    // SAY WHAT WAS WITHHELD, BEFORE ANY GATE. A deferral is a decision to leave a
    // work item to another driver, and the tick that made it is the only place
    // that knows. Logged at INFO (not debug, unlike the owner-active gate) because
    // this is the line that answers "is anything actually progressing?" — it names
    // the run and how long since it last moved, so a parked driver is legible as a
    // parked driver rather than as an empty board. Rate-limited PER ITEM so a long
    // build says so periodically instead of 288 times a day; the COUNT in
    // `WakeupSweepResult` is unconditional and is logged every tick by
    // `buildWorkWakeupLoop`, so the rate limit costs volume and never costs the
    // fact — an operator reading the summary sees three deferrals even on a tick
    // where all three per-item lines are inside their window.
    for (const d of project.deferred) {
      result.deferred_to_run += 1
      const logKey = `${project.project_key}:${d.item_id}`
      const lastLoggedAt = deferralLog.get(logKey)
      if (lastLoggedAt !== undefined && now() - lastLoggedAt < WAKEUP_DEFERRAL_LOG_WINDOW_MS) {
        continue
      }
      deferralLog.set(logKey, now())
      log.info('wakeup_deferred_to_live_run', {
        project: project.project_key,
        item: bound(d.title, 140),
        item_id: d.item_id,
        run_id: d.run_id,
        phase: d.phase,
        since_advance_ms: d.since_advance_ms,
      })
    }
    if (project.items.length === 0) continue

    // Owner-activity gate: while he is driving this project, stay out of it.
    const last = await deps.ownerActivityMs(project.project_key)
    if (last !== null && now() - last < grace) {
      result.skipped_active += 1
      log.debug('wakeup_skipped_owner_active', {
        project: project.project_key,
        idle_ms: now() - last,
      })
      continue
    }

    const tools: ToolDef[] = deps.tool_names.map((name) => ({
      name,
      description: `Built-in Claude Code tool '${name}' (work-wakeup surface)`,
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      capability_required: 'fs:project_data',
    }))
    const spec: AgentSpec = {
      prompt: buildWakeupPrompt({
        label: project.label,
        items: project.items,
        now_iso: new Date(now()).toISOString(),
      }),
      tools,
      model_preference: [deps.resolveModel()],
      max_tokens: WORK_WAKEUP_MAX_TOKENS,
      // The warm-pool key — what lands this turn ON the owner's chat session
      // for this project rather than a parallel one.
      metering_context: { project_id: project.chat_scope },
    }

    let reply: string
    try {
      reply = (await deps.llm.compose(spec, { timeout_ms: turn_timeout })).trim()
      if (reply.length === 0) throw new Error('the wakeup turn returned an empty reply')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const streak = (failureStreaks.get(project.project_key) ?? 0) + 1
      failureStreaks.set(project.project_key, streak)
      result.failed += 1
      // The journal line carries the full cause; the chat notice a bounded one.
      log.error('wakeup_turn_failed', {
        project: project.project_key,
        streak,
        reason: bound(reason, 400),
      })
      if (streak === 1 || streak % WAKEUP_FAILURE_POST_CADENCE === 0) {
        try {
          await deps.post({
            project_key: project.project_key,
            body: `Scheduled wakeup for ${project.label} failed to run (attempt ${streak}): ${bound(reason, 200)} — retrying every 5 minutes.`,
            loud: true,
          })
        } catch (postErr) {
          log.error('wakeup_failure_post_failed', {
            project: project.project_key,
            reason: bound(postErr instanceof Error ? postErr.message : String(postErr), 200),
          })
        }
      }
      continue
    }

    failureStreaks.delete(project.project_key)
    const blocked = reply.startsWith(WAKEUP_BLOCKED_PREFIX)
    try {
      const persisted = await deps.post({
        project_key: project.project_key,
        body: bound(reply, MAX_WAKEUP_REPORT_CHARS),
        // A BLOCKED declaration is exactly the "say so loudly" case; routine
        // progress stays quiet (durable + visible, no buzz).
        loud: blocked,
      })
      if (!persisted) {
        log.warn('wakeup_report_not_persisted', { project: project.project_key })
      }
    } catch (err) {
      log.error('wakeup_report_post_failed', {
        project: project.project_key,
        reason: bound(err instanceof Error ? err.message : String(err), 200),
      })
    }
    result.woke += 1
    log.info('wakeup_fired', { project: project.project_key, blocked })
  }
  return result
}

export interface WorkWakeupLoop {
  loop: SupervisedLoop
  describe(): LoopDescriptor
}

/**
 * Build (never start) the `work-wakeup` loop. The composer registers the
 * descriptor, starts the loop last (register-before-start), and awaits
 * `loop.stop()` on shutdown — the same lifecycle every other loop follows.
 */
export function buildWorkWakeupLoop(deps: WorkWakeupDeps): WorkWakeupLoop {
  const failureStreaks = new Map<string, number>()
  const deferralLog = new Map<string, number>()
  const loop = new SupervisedLoop({
    name: 'work-wakeup',
    intervalMs: deps.interval_ms ?? WORK_WAKEUP_INTERVAL_MS,
    tick: async (): Promise<void> => {
      const result = await runWorkWakeupSweep(deps, failureStreaks, deferralLog)
      // THE SWEEP'S OWN COUNTERS NEEDED A READER. `WakeupSweepResult` was returned
      // and then dropped on the floor by this — its only production caller — so
      // the claim that a rate-limited per-item line "never costs the fact" was
      // true of a number nothing printed. That is an aspirational docblock, and
      // the repo has a rule about those. One line per tick, at INFO when there is
      // anything at all to say, is what makes the fact reachable.
      //
      // A fully idle tick stays SILENT: on a box with no outstanding work this
      // loop runs 288 times a day and a summary of zeros would drown the ticks
      // that mean something.
      if (result.woke > 0 || result.failed > 0 || result.deferred_to_run > 0 || result.skipped_active > 0) {
        log.info('wakeup_sweep', {
          woke: result.woke,
          failed: result.failed,
          deferred_to_run: result.deferred_to_run,
          skipped_owner_active: result.skipped_active,
        })
      }
    },
  })
  return { loop, describe: (): LoopDescriptor => loop.describe() }
}
