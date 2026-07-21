/**
 * @neutronai/reminders — fire-time loop.
 *
 * Runs every `tick_interval_ms`
 * (default 30 s — matches Nova's reminder loop), pulls due reminders via
 * `ReminderStore.listDue`, and dispatches each through the configured
 * `ReminderDispatcher`. The dispatcher is the seam to the substrate
 * dispatcher + channel adapter — at fire time the gateway spawns a
 * Haiku-class agent with `prompts/reminder-agent-base.md` and the stored
 * `message` body; that's the dispatcher's responsibility, not this module's.
 *
 * The loop is single-flight: one tick at a time. Long dispatches don't
 * stack; if a tick is still running when the interval fires, the next tick
 * is skipped (logged). This matches Nova's reminder-tick behavior.
 */

import { hostTimeZone, nextCronFire, parseCron } from '@neutronai/cron'
import { createLogger } from '@neutronai/logger'
import { SupervisedLoop, type LoopDescriptor } from '@neutronai/loop'

import { isRecurring, type Reminder, type ReminderRecurrence, type ReminderStore } from './store.ts'
import type { RitualExecutor } from './ritual-executor.ts'

const log = createLogger('reminder-tick')

export interface ReminderDispatcher {
  /**
   * Fire a single reminder. Implementations spawn a Haiku-class agent
   * with the reminder body; on return the store marks fired. Throws
   * surface as logged errors but DO NOT prevent the tick from continuing
   * with other due reminders.
   */
  dispatch(reminder: Reminder): Promise<void>
}

/**
 * P5.6 — optional post-dispatch hook. Fires AFTER `dispatcher.dispatch`
 * has returned AND after the store has been advanced (markFired for
 * one-shot rows; advanceRecurrence for recurring rows). The hook runs
 * once per fired row, with the SAME `Reminder` snapshot the dispatcher
 * saw.
 *
 * Production wires the push dispatcher's `pushReminder` here so
 * registered Expo devices get a native notification at fire time.
 * Failure-safety: thrown errors are caught + logged but never block
 * the tick from continuing with the next reminder. This mirrors the
 * dispatcher try/catch.
 */
export interface ReminderFiredHook {
  onFired(reminder: Reminder): Promise<void>
}

export interface ReminderTickOptions {
  store: ReminderStore
  dispatcher: ReminderDispatcher
  /** Default 30 s — matches Nova. */
  tick_interval_ms?: number
  /** Per-tick max reminders to fire. Default 50. */
  per_tick_limit?: number
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number
  /**
   * IANA timezone for cron-cadence wall-clock resolution ("09:00" means 09:00
   * in this zone, DST-correct). Defaults to the host zone — matching the intent
   * that a user's `0 9 * * *` fires at 9am their local time. Coarse-label
   * cadences are timezone-agnostic fixed deltas and ignore this.
   */
  time_zone?: string
  /**
   * P5.6 — optional post-dispatch hook fired AFTER markFired /
   * advanceRecurrence. Production wires this to the push dispatcher
   * so an Expo notification fans out at the same instant the
   * substrate dispatcher's Telegram send fires. Omitted in tests
   * that don't care about the push path.
   */
  on_fired?: ReminderFiredHook
  /**
   * Executor-mode reminders (plan task 4) — the RITUAL executor. A due row with a
   * non-null `ritual_id` routes to `ritual_executor.fire(reminder)` (fire-and-
   * forget) INSTEAD of the nudge `dispatcher` + `on_fired` push. Omitted in tests
   * / on an LLM-less box that has no ritual surface; a ritual row that fires with
   * NO executor wired is consumed (claimed) and logged (never falls back to the
   * nudge dispatcher — a ritual is not a nudge). Structural so the composition can
   * pass any `{ fire }` — see `reminders/ritual-executor.ts`.
   */
  ritual_executor?: RitualExecutor
}

export class ReminderTickLoop {
  private readonly store: ReminderStore
  private readonly dispatcher: ReminderDispatcher
  private readonly interval_ms: number
  private readonly per_tick_limit: number
  private readonly now: () => number
  private readonly time_zone: string
  private readonly on_fired: ReminderFiredHook | null
  private readonly ritual_executor: RitualExecutor | null
  /** Loop scaffolding — single-flight, per-tick catch-all, quiescing stop (§F1). */
  private readonly loop: SupervisedLoop
  private firedCount = 0

  constructor(options: ReminderTickOptions) {
    this.store = options.store
    this.dispatcher = options.dispatcher
    this.interval_ms = options.tick_interval_ms ?? 30_000
    this.per_tick_limit = options.per_tick_limit ?? 50
    this.now = options.now ?? Date.now
    this.time_zone = options.time_zone ?? hostTimeZone()
    this.on_fired = options.on_fired ?? null
    this.ritual_executor = options.ritual_executor ?? null
    this.loop = new SupervisedLoop({
      name: 'reminders',
      intervalMs: this.interval_ms,
      tick: () => this.tickBody(),
    })
  }

  /**
   * Start the loop. Idempotent — a second `start` is a no-op. Caller
   * pairs this with `stop` in the gateway shutdown path.
   */
  start(): void {
    this.loop.start()
  }

  /** §F2 — live LoopRegistry descriptor (name `reminders`, cadence
   *  `tick_interval_ms`). Call after `start()`. */
  describe(): LoopDescriptor {
    return this.loop.describe()
  }

  /** Stop + quiesce: awaits the in-flight tick so a caller can `await stop()`
   *  before `db.close()`. */
  async stop(): Promise<void> {
    await this.loop.stop()
  }

  /**
   * Run one tick synchronously (well, awaitable). Exposed for tests + for
   * any caller that wants to drive the loop manually rather than via the
   * interval. Single-flight (overlap → skipped) + the per-tick catch-all now
   * live in the {@link SupervisedLoop} that drives {@link tickBody}; the
   * per-tick `fired` count is recovered from `firedCount`'s delta (safe because
   * single-flight guarantees only one tick body runs at a time).
   */
  async runOnce(): Promise<{ fired: number; skipped_due_to_overlap: boolean }> {
    const before = this.firedCount
    const { skipped } = await this.loop.runOnce()
    if (skipped) return { fired: 0, skipped_due_to_overlap: true }
    return { fired: this.firedCount - before, skipped_due_to_overlap: false }
  }

  /**
   * The domain tick body. Everything below is UNCHANGED from the original
   * hand-rolled loop — including the #319 claim-before-dispatch +
   * compare-and-swap revert ordering, which must not move. Only the loop
   * scaffolding (single-flight guard, error catch-all, quiescing stop) was
   * lifted out into {@link SupervisedLoop}.
   */
  private async tickBody(): Promise<void> {
    let fired = 0
    // Scoped block: the body below is lifted verbatim from the old `runOnce`
    // (its `try` block); the brace keeps it byte-identical for review.
    {
      const due = this.store.listDue(this.now() / 1000, this.per_tick_limit)
      for (const reminder of due) {
        // #319 — CLAIM the row BEFORE dispatch. The terminal state-change
        // (markFired for one-shot rows; advanceRecurrence for recurring rows,
        // per P2 v2 S9 / Codex S9-r1 P1 so weekly/monthly nudges keep firing
        // instead of vanishing after one fire) is committed FIRST, THEN the
        // post happens. This closes the crash-window double-fire: previously
        // the row stayed `pending` until AFTER the post, so a process crash
        // between a successful post and `markFired` left a due `pending` row
        // that re-fired (double-sent) on restart. Claiming first means a crash
        // at any point leaves an already-fired/advanced row that listDue won't
        // re-pick. `claimRevert` un-does the claim on a (caught) dispatch
        // throw, which always means the post did NOT succeed — so the row goes
        // back to pending and retries next tick, preserving the existing
        // deliver-or-retry contract. Only a true crash (no catch runs) takes
        // the at-most-once path, which is the whole point.
        let claimRevert: (() => Promise<unknown>) | null = null
        // A row recurs when EITHER cadence column is set (coarse label OR cron
        // spec) — `computeNextFire` resolves the next instant from whichever
        // one is populated. A `null` return means an uncomputable cadence (a
        // corrupt cron that can never fire); we degrade that row to a one-shot
        // so a poison expression can't wedge the tick loop re-throwing forever.
        const next_fire_at_sec = isRecurring(reminder)
          ? computeNextFire(reminder, this.now() / 1000, this.time_zone)
          : null
        if (next_fire_at_sec !== null) {
          const advanced = await this.store.advanceRecurrence(reminder.id, next_fire_at_sec)
          if (advanced) {
            // Revert = restore the original (due) fire_at so it re-fires — but
            // ONLY if the row still carries the fire_at this claim wrote. A
            // compare-and-swap so a concurrent owner reschedule during the
            // dispatch await isn't clobbered by the revert (#319).
            claimRevert = () =>
              this.store.revertRecurrenceAdvance(reminder.id, next_fire_at_sec, reminder.fire_at)
          } else {
            // Defensive: the row stopped being a pending recurring row between
            // listDue + now (e.g. cancelled mid-tick) — finalize as fired.
            await this.store.markFired(reminder.id)
            claimRevert = () => this.store.reopen(reminder.id)
          }
        } else {
          if (isRecurring(reminder)) {
            log.error('uncomputable_cadence_fire_once_then_retire', {
              reminder: reminder.id,
              recurrence_spec: JSON.stringify(reminder.recurrence_spec),
            })
          }
          await this.store.markFired(reminder.id)
          claimRevert = () => this.store.reopen(reminder.id)
        }

        // Executor-mode reminders (plan task 4). A ritual row NEVER reaches the
        // nudge dispatcher and NEVER fires the `on_fired` push (a 45-min executor
        // run would push-notify up to 45 min BEFORE any output, even for a silent
        // ritual — task 5 owns ritual delivery). The #319 claim above already
        // ran (advanceRecurrence for a recurring ritual / markFired for a one-shot)
        // and is NEVER reverted for a ritual: a claimed attempt is CONSUMED — the
        // durable `code_ritual_runs` history rows are the record, and a recurring
        // row has already advanced to its next cadence, so re-firing the same
        // attempt every 30 s (the nudge deliver-or-retry contract) is wrong here.
        // fire()'s STARTUP — fail-closed validate → ritual-lane spawn → durable
        // `code_ritual_runs` 'running' (or skipped/failed) row — is AWAITED so it
        // completes INSIDE the tick body, i.e. inside SupervisedLoop's stop()
        // quiescence await (tick.ts:135-137). stop() can therefore never resolve
        // between a consumed #319 claim and its durable run row (the Argus task-5
        // data-loss blocker). Only the long-running substrate TURN is detached,
        // INSIDE the executor (fireAndForget('ritual-run'), ritual-executor.ts step
        // (f)) — the tick never blocks on an up-to-45-min execution; startup is
        // milliseconds of local DB writes plus one prompt-file read.
        if (reminder.ritual_id !== null) {
          if (this.ritual_executor !== null) {
            try {
              await this.ritual_executor.fire(reminder)
            } catch (err) {
              // fire() is contracted never to reject; guard the call defensively
              // so a ritual can never wedge the tick loop (the guard now also
              // covers async rejections).
              log.error('ritual_fire_threw', {
                reminder: reminder.id,
                ritual_id: reminder.ritual_id,
                error: err instanceof Error ? (err.stack ?? err.message) : String(err),
              })
            }
          } else {
            // No executor wired (LLM-less box / test): the row is already claimed
            // — consume it and log. NEVER fall back to the nudge dispatcher.
            log.error('ritual_executor_unwired', {
              reminder: reminder.id,
              ritual_id: reminder.ritual_id,
            })
          }
          fired++
          continue
        }

        try {
          await this.dispatcher.dispatch(reminder)
          fired++
          // P5.6 — fire the optional push hook AFTER the claim + dispatch
          // succeed. Wrapped in its own try/catch so a push-side failure
          // (network, Expo 5xx) NEVER stops the tick from processing the next
          // reminder and can't undo the claim we already committed.
          if (this.on_fired !== null) {
            try {
              await this.on_fired.onFired(reminder)
            } catch (err) {
              log.error('on_fired_hook_failed', {
                reminder: reminder.id,
                error: err instanceof Error ? (err.stack ?? err.message) : String(err),
              })
            }
          }
        } catch (err) {
          // A caught throw means the post did NOT succeed (the dispatcher
          // throws on a rejected/failed post, never after a delivered one) —
          // revert the claim so the row stays pending and retries next tick.
          try {
            await claimRevert()
          } catch (rerr) {
            log.error('claim_revert_failed', {
              reminder: reminder.id,
              error: rerr instanceof Error ? (rerr.stack ?? rerr.message) : String(rerr),
            })
          }
          log.error('dispatch_failed', {
            reminder: reminder.id,
            error: err instanceof Error ? (err.stack ?? err.message) : String(err),
          })
        }
      }
      this.firedCount += fired
    }
  }

  stats(): { fired: number; skipped_ticks: number } {
    return { fired: this.firedCount, skipped_ticks: this.loop.stats().skipped }
  }
}

/**
 * Compute the next fire time (unix seconds) for a recurring reminder — the
 * SINGLE next-fire resolution path the tick loop uses for BOTH cadence kinds:
 *
 *   • cron `recurrence_spec` → the next wall-clock instant STRICTLY after now,
 *     DST-correct in `time_zone` (delegates to `@neutronai/cron`). Cron is
 *     wall-clock-anchored ("next 9am after now"), so it keys off `now`, not the
 *     row's `fire_at`. Returns `null` if the stored expression can't be parsed
 *     or has no occurrence (a corrupt/impossible cron) so the caller can retire
 *     the poison row instead of the tick loop throwing every interval.
 *
 *   • coarse `recurrence` label → the previous `fire_at` plus a fixed delta
 *     (weekly 7d / monthly 30d / occasional 14d), floored at `now + 1m` so a
 *     long-stopped loop doesn't fire a stale row repeatedly to catch up. This
 *     is the P2 v2 S9 behaviour, unchanged.
 *
 * Returns `null` only for the uncomputable-cron case; the coarse path always
 * returns a number. A one-shot row (neither column set) never reaches here.
 */
export function computeNextFire(
  reminder: Pick<Reminder, 'fire_at' | 'recurrence' | 'recurrence_spec'>,
  now_sec: number,
  time_zone: string,
): number | null {
  if (reminder.recurrence_spec !== null) {
    try {
      const next_ms = nextCronFire(parseCron(reminder.recurrence_spec), now_sec * 1000, time_zone)
      return next_ms / 1000
    } catch {
      return null
    }
  }
  // recurrence_spec is null and the caller only invokes this for recurring
  // rows, so recurrence is non-null here.
  return computeNextRecurrence(reminder.fire_at, reminder.recurrence as ReminderRecurrence, now_sec)
}

/**
 * P2 v2 S9 — the coarse-label fixed-delta rescheduler. Anchors on the LATER of
 * (previous fire_at + cadence) and (now + small slack) so a long-stopped tick
 * loop doesn't fire a stale recurring row repeatedly to catch up.
 *
 * Cadence durations:
 *   weekly      → 7 days
 *   monthly     → 30 days   (calendar-month math deferred — wall-clock
 *                            drift is acceptable for nudges)
 *   occasional  → 14 days
 */
function computeNextRecurrence(
  current_fire_at_sec: number,
  recurrence: ReminderRecurrence,
  now_sec: number,
): number {
  const SECONDS_PER_DAY = 24 * 60 * 60
  const delta_sec: Record<ReminderRecurrence, number> = {
    weekly: 7 * SECONDS_PER_DAY,
    monthly: 30 * SECONDS_PER_DAY,
    occasional: 14 * SECONDS_PER_DAY,
  }
  const candidate = current_fire_at_sec + delta_sec[recurrence]
  // Floor the next-fire by `now + 1m` so if the loop was paused for a
  // week, we don't fire 7 weekly rows back-to-back.
  const floor = now_sec + 60
  return candidate > floor ? candidate : floor
}
