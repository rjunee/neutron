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

import type { Reminder, ReminderRecurrence, ReminderStore } from './store.ts'

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
   * P5.6 — optional post-dispatch hook fired AFTER markFired /
   * advanceRecurrence. Production wires this to the push dispatcher
   * so an Expo notification fans out at the same instant the
   * substrate dispatcher's Telegram send fires. Omitted in tests
   * that don't care about the push path.
   */
  on_fired?: ReminderFiredHook
}

export class ReminderTickLoop {
  private readonly store: ReminderStore
  private readonly dispatcher: ReminderDispatcher
  private readonly interval_ms: number
  private readonly per_tick_limit: number
  private readonly now: () => number
  private readonly on_fired: ReminderFiredHook | null
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private skippedTicks = 0
  private firedCount = 0

  constructor(options: ReminderTickOptions) {
    this.store = options.store
    this.dispatcher = options.dispatcher
    this.interval_ms = options.tick_interval_ms ?? 30_000
    this.per_tick_limit = options.per_tick_limit ?? 50
    this.now = options.now ?? Date.now
    this.on_fired = options.on_fired ?? null
  }

  /**
   * Start the loop. Idempotent — a second `start` is a no-op. Caller
   * pairs this with `stop` in the gateway shutdown path.
   */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.interval_ms)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Run one tick synchronously (well, awaitable). Exposed for tests + for
   * any caller that wants to drive the loop manually rather than via
   * setInterval.
   */
  async runOnce(): Promise<{ fired: number; skipped_due_to_overlap: boolean }> {
    if (this.running) {
      this.skippedTicks++
      return { fired: 0, skipped_due_to_overlap: true }
    }
    this.running = true
    let fired = 0
    try {
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
        if (reminder.recurrence !== null) {
          const next_fire_at_sec = computeNextRecurrence(
            reminder.fire_at,
            reminder.recurrence,
            this.now() / 1000,
          )
          const advanced = await this.store.advanceRecurrence(reminder.id, next_fire_at_sec)
          if (advanced) {
            // Revert = restore the original (due) fire_at so it re-fires.
            claimRevert = () => this.store.reschedule(reminder.id, reminder.fire_at)
          } else {
            // Defensive: the row stopped being a pending recurring row between
            // listDue + now (e.g. cancelled mid-tick) — finalize as fired.
            await this.store.markFired(reminder.id)
            claimRevert = () => this.store.reopen(reminder.id)
          }
        } else {
          await this.store.markFired(reminder.id)
          claimRevert = () => this.store.reopen(reminder.id)
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
              console.error(`reminder onFired hook failed for ${reminder.id}:`, err)
            }
          }
        } catch (err) {
          // A caught throw means the post did NOT succeed (the dispatcher
          // throws on a rejected/failed post, never after a delivered one) —
          // revert the claim so the row stays pending and retries next tick.
          try {
            await claimRevert()
          } catch (rerr) {
            console.error(`reminder ${reminder.id} claim-revert failed:`, rerr)
          }
          console.error(`reminder dispatch failed for ${reminder.id}:`, err)
        }
      }
      this.firedCount += fired
    } finally {
      this.running = false
    }
    return { fired, skipped_due_to_overlap: false }
  }

  stats(): { fired: number; skipped_ticks: number } {
    return { fired: this.firedCount, skipped_ticks: this.skippedTicks }
  }
}

/**
 * P2 v2 S9 — compute the next occurrence's `fire_at` (unix seconds) for
 * a recurring reminder. Anchors on the LATER of (previous fire_at +
 * cadence) and (now + small slack) so a long-stopped tick loop doesn't
 * fire a stale recurring row repeatedly to catch up.
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
