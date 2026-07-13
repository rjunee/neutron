/**
 * @neutronai/email-managed-core — daily triage scheduler.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.4. Tick handler
 * the canonical instance scheduler invokes; on the daily schedule
 * (08:00 local default), fires `composeTriage` + posts the result to
 * the owner's "General" project's chat surface (or whichever
 * project the user's per-project `EMAIL_TRIAGE_TARGET_PROJECT_ID`
 * config points at).
 *
 * **Option B substrate (per § 13 open question 2).** Calendar Core's
 * sibling sprint targets Option A — extending `reminders/
 * RemindersEngine.scheduleOneShot(at, handler_kind, payload)` with
 * `email_managed_daily_triage`. As of this S1 sprint that engine
 * extension hasn't landed; we ship Option B (per-Core timer wheel)
 * + tests that exercise the `tick(now)` method directly. The engine
 * extension is a follow-up consolidation sprint; the scheduler's
 * public surface (`start` / `tick(now)` / `stop`) is independent of
 * which substrate fires it.
 */

import type { EmailProjectCache } from './cache.ts'
import type { GmailClient, GmailMessageMeta } from './backend.ts'
import { composeTriage, type Triage } from './triage.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

export interface TriageFireInput {
  triage: Triage
  project_id: string
  /**
   * The inbox metadata the tick ALREADY fetched (`client.listMessages`) to
   * compose the triage — handed to the fire callback so a consumer (scribe
   * phase-2 fan-out) can ride the same fetch with NO second request. Newest-
   * first, capped at `lookback_messages`.
   */
  inbox: readonly GmailMessageMeta[]
}

/** Cancelable timer handle — mirrors the calendar Core's scheduler seam. */
export type TimerHandle = { cancel(): void }

const DEFAULT_TICK_INTERVAL_MS = 60 * 1000

const DEFAULT_TIMER_FACTORY = (fn: () => void, delay_ms: number): TimerHandle => {
  const t = setTimeout(fn, Math.max(0, delay_ms))
  // Unref so the self-tick never keeps the process (or `bun test`) alive on its
  // own — production keeps the event loop alive via the HTTP listener.
  ;(t as { unref?: () => void }).unref?.()
  return { cancel: (): void => clearTimeout(t) }
}

export interface TriageFireResult {
  /** Channel-side message id the chat-bridge issued; `null` on dry-run. */
  chat_message_id: string | null
}

export interface TriageScheduler {
  /** Idempotent. */
  start(): Promise<void>
  /** Drive the wheel forward. Production wires this to a 1-minute
   *  setInterval; tests advance time + invoke directly. */
  tick(now: Date): Promise<void>
  /** Idempotent. */
  stop(): Promise<void>
  /** Days since last fire, by project_id. */
  lastFiredAt(project_id: string): Date | null
}

export interface TriageSchedulerOpts {
  cacheFor: (project_id: string) => Promise<EmailProjectCache>
  client: GmailClient
  /** Resolve the target project_id for the daily fire. */
  targetProjectId: () => Promise<string>
  /** Pluggable fire — composes the post + records the chat message id. */
  fire: (input: TriageFireInput) => Promise<TriageFireResult>
  llm: (prompt: string) => Promise<string>
  /** Resolved Haiku-fast model id. */
  model: string
  /** User-local time zone (e.g. `America/Los_Angeles`). */
  userTz: string
  daily_hour?: number
  daily_minute?: number
  lookback_messages?: number
  /**
   * Self-tick cadence (ms). On `start()` the scheduler arms a recurring tick
   * (default 60s) so production drives the daily-08:00 check without an external
   * loop — mirroring the Calendar Core's scheduler + `reminders/tick.ts`, both
   * of which own their timer. `stop()` cancels it. Tests pass `scheduleTimer` to
   * drive deterministically (or call `tick(now)` directly, the historic path).
   */
  tick_interval_ms?: number
  /** Timer factory override (tests). Default wraps an unref'd setTimeout. */
  scheduleTimer?: (fn: () => void, delay_ms: number) => TimerHandle
  /** Clock for the self-tick (tests). Defaults to `() => new Date()`. */
  now?: () => Date
}

export const DEFAULT_DAILY_HOUR = 8
export const DEFAULT_DAILY_MINUTE = 0
export const DEFAULT_LOOKBACK_MESSAGES = 50

export function buildTriageScheduler(opts: TriageSchedulerOpts): TriageScheduler {
  const dailyHour = opts.daily_hour ?? DEFAULT_DAILY_HOUR
  const dailyMinute = opts.daily_minute ?? DEFAULT_DAILY_MINUTE
  const lookback = opts.lookback_messages ?? DEFAULT_LOOKBACK_MESSAGES
  const tickIntervalMs = opts.tick_interval_ms ?? DEFAULT_TICK_INTERVAL_MS
  const scheduleTimer = opts.scheduleTimer ?? DEFAULT_TIMER_FACTORY
  const nowFn = opts.now ?? ((): Date => new Date())
  let started = false
  let selfTickTimer: TimerHandle | null = null
  const lastFired = new Map<string, Date>()

  function isFireTime(now: Date, userTz: string): boolean {
    // Resolve the user-local wall-clock for the supplied `now`.
    const local = new Date(now.toLocaleString('en-US', { timeZone: userTz }))
    return local.getHours() === dailyHour && local.getMinutes() === dailyMinute
  }

  function ymdKey(date: Date, userTz: string): string {
    const local = new Date(date.toLocaleString('en-US', { timeZone: userTz }))
    return `${local.getFullYear()}-${local.getMonth()}-${local.getDate()}`
  }

  function armSelfTick(): void {
    selfTickTimer = scheduleTimer(() => {
      fireAndForget('triage-scheduler.task', (async (): Promise<void> => {
        // Re-arm regardless of outcome (a single tick failure must not stop the
        // loop) via `finally`, but let the failure PROPAGATE to the
        // fireAndForget wrapper so it is logged, not silently swallowed.
        try {
          await self.tick(nowFn())
        } finally {
          if (started) armSelfTick()
        }
      })())
    }, tickIntervalMs)
  }

  const self: TriageScheduler = {
    async start(): Promise<void> {
      if (started) return
      started = true
      // Codex r1 P2 — run one tick IMMEDIATELY so a gateway (re)start DURING
      // the daily fire minute (e.g. boot at 08:00:10 local) doesn't wait a full
      // interval and miss that day's only window. `tick()` is idempotent per
      // local day, so the immediate tick + the recurring self-tick never
      // double-fire.
      try {
        await self.tick(nowFn())
      } catch {
        // best-effort — a first-tick failure must not stop the loop arming.
      }
      // Own our cadence (like the Calendar Core's scheduler + reminders/tick.ts)
      // so production needs no external tick driver. Unref'd default timer.
      armSelfTick()
    },
    async stop(): Promise<void> {
      started = false
      selfTickTimer?.cancel()
      selfTickTimer = null
    },
    lastFiredAt(project_id: string): Date | null {
      return lastFired.get(project_id) ?? null
    },
    async tick(now: Date): Promise<void> {
      if (!started) return
      if (!isFireTime(now, opts.userTz)) return
      const project_id = await opts.targetProjectId()
      // Idempotent per local day — repeated ticks within the same
      // wall-clock minute should not double-fire.
      const key = `${project_id}::${ymdKey(now, opts.userTz)}`
      if (lastFired.get(key) !== undefined) return
      const cache = await opts.cacheFor(project_id)
      const { results: inbox } = await opts.client.listMessages({
        label: 'INBOX',
        max_results: lookback,
        project_id,
      })
      const triage = await composeTriage({
        inbox,
        userTz: opts.userTz,
        llm: opts.llm,
        model: opts.model,
      })
      let fired: TriageFireResult
      try {
        // Hand the already-fetched `inbox` to the fire callback so a consumer
        // (scribe phase-2) rides the same fetch — no second request.
        fired = await opts.fire({ triage, project_id, inbox })
      } catch (err) {
        // Best-effort record of the failure; never silently drop.
        cache.upsertTriage({
          fired_at: now.getTime(),
          model: triage.model,
          outcome: 'llm_error',
          prompt_hash: triage.prompt_hash,
          top5_json: JSON.stringify(triage.items),
          chat_message_id: null,
        })
        throw err
      }
      cache.upsertTriage({
        fired_at: now.getTime(),
        model: triage.model,
        outcome: triage.outcome,
        prompt_hash: triage.prompt_hash,
        top5_json: JSON.stringify(triage.items),
        chat_message_id: fired.chat_message_id,
      })
      lastFired.set(key, now)
      lastFired.set(project_id, now)
    },
  }

  return self
}
