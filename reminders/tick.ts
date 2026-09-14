/**
 * @neutronai/reminders — fire-time loop.
 *
 * Runs every `tick_interval_ms`
 * (default 30 s — matches Nova's reminder loop), pulls due reminders via
 * `ReminderStore.listDispatchable`, and dispatches each through the configured
 * `ReminderDispatcher`. Composition — which prompt a row fires with, which model,
 * where it posts — is entirely the dispatcher's responsibility, not this
 * module's.
 *
 * ONE DISPATCH PATH, NO EXCEPTIONS (ISSUES #504, SPEC Decisions Log 2026-08-05).
 * EVERY eligible due row goes through `dispatcher.dispatch`. This loop does not know what
 * a ritual is, and there is deliberately no branch here on `ritual_id` — the
 * branch that used to live at this exact spot routed ritual rows to a separate
 * executor that spawned an ephemeral REPL with no tool bridge, which is why the
 * morning brief could not read the owner's calendar. A ritual is a reminder; it
 * fires down the same path, onto the owner's own warm session, and inherits
 * everything that session has. If you are about to reintroduce a per-kind branch
 * here, the thing you want belongs in the dispatcher's fire plan
 * (`reminders/ritual-fire.ts`), which composes and delivers through the same code
 * a nudge does.
 *
 * The loop is single-flight: one tick at a time. Long dispatches don't
 * stack; if a tick is still running when the interval fires, the next tick
 * is skipped (logged). This matches Nova's reminder-tick behavior. Because a
 * dispatch is AWAITED here, a dispatcher's per-turn budget is also the longest one
 * row can stall the others — see `RITUAL_COMPOSE_TIMEOUT_MS`.
 */

import { nextCronFire, parseCron } from '@neutronai/cron'
import { createLogger } from '@neutronai/logger'
import { SupervisedLoop, type LoopDescriptor } from '@neutronai/loop'

import type { DeliveryObservation } from './delivery.ts'
import { isRecurring, type Reminder, type ReminderRecurrence, type ReminderStore } from './store.ts'

const log = createLogger('reminder-tick')

/**
 * The zone a cron cadence is resolved in when the owner's own zone is not known
 * yet (no client has ever reported one — see `resolve_time_zone`).
 *
 * UTC is chosen because it is the only honest answer available: it is explicit,
 * identical on every machine, and has no DST transitions, so an unknown-zone
 * reminder means exactly one thing and means it everywhere. The alternative —
 * inheriting the host's zone — makes the SAME reminder mean different times on a
 * laptop and on a server, and quietly re-times every recurring reminder if the
 * instance is ever migrated between boxes. A wrong-but-stable default the owner
 * can see and correct beats a right-looking one that depends on the machine.
 *
 * This is a fallback, not a preference: every client (web + mobile) reports its
 * IANA zone on connect, so a real instance leaves this state on first connect.
 */
export const REMINDER_FALLBACK_TIME_ZONE = 'UTC'

export interface ReminderDispatcher {
  /** Only an explicit delivery observation earns fired; void means unknown. */
  dispatch(reminder: Reminder): Promise<DeliveryObservation | void>
}

/**
 * THERE IS NO POST-DISPATCH PUSH HOOK, and its absence is deliberate (2026-08-09).
 *
 * `on_fired` used to live here and the composition attached the Expo push
 * dispatcher to it, composing a notification from the `Reminder` row. The tick can
 * only ever see the ROW, and the row is not the message: a ritual's stored
 * `message` is the dispatch token `ritual:<id>`, so the notification the owner
 * received read `ritual:kaizen`. No title override fixes that, because the text he
 * wanted is produced downstream, at compose+post time.
 *
 * So the notification is built where the message is DELIVERED — the shared
 * out-of-turn seam `gateway/http/deliver.ts`, which holds the posted body and the
 * durable row id the tap anchors on, and composes through
 * `gateway/push/chat-message-push.ts`. It is NOT in
 * `gateway/proactive/reminder-outbound.ts`: putting it there cured the reported
 * reminder and left the brief, the nudge and the overnight report silent, because
 * they reach chat through the same seam and not through that file. The tick's job
 * ends at "dispatch it and advance the row".
 */
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
   * Resolve the OWNER's IANA timezone for cron-cadence wall-clock resolution
   * ("09:00" means 09:00 in the OWNER's zone, DST-correct). Called PER FIRE with
   * the row's `owner_slug`, so a zone learned (or changed) after the loop was
   * constructed takes effect on the next tick without a restart — the same
   * resolve-at-invocation contract the nudge engine's `resolveTimezone` uses.
   *
   * Returning `null` / `undefined` means "the owner's zone is not known yet";
   * the loop then falls back to {@link REMINDER_FALLBACK_TIME_ZONE}.
   *
   * There is deliberately NO host-zone fallback. A recurring reminder means a
   * wall-clock time in the OWNER's life; resolving it against whatever zone the
   * SERVER happens to be set to silently mistimes every recurring reminder by
   * the offset between them, and reports no error while doing it — the reminder
   * still arrives, just at the wrong hour. Production wires this to the stored
   * per-instance zone (`instance_metadata.timezone`, ISSUES #40).
   *
   * Coarse-label cadences are timezone-agnostic fixed deltas and ignore this.
   */
  resolve_time_zone?: (owner_slug: string) => string | null | undefined
}

export class ReminderTickLoop {
  private readonly store: ReminderStore
  private readonly dispatcher: ReminderDispatcher
  private readonly interval_ms: number
  private readonly per_tick_limit: number
  private readonly now: () => number
  private readonly resolve_time_zone: (owner_slug: string) => string | null | undefined
  /** Loop scaffolding — single-flight, per-tick catch-all, quiescing stop (§F1). */
  private readonly loop: SupervisedLoop
  private firedCount = 0

  constructor(options: ReminderTickOptions) {
    this.store = options.store
    this.dispatcher = options.dispatcher
    this.interval_ms = options.tick_interval_ms ?? 30_000
    this.per_tick_limit = options.per_tick_limit ?? 50
    this.now = options.now ?? Date.now
    this.resolve_time_zone = options.resolve_time_zone ?? (() => null)
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

  private async tickBody(): Promise<void> {
    await this.store.initializeDelivery()
    const due = this.store.listDispatchable(this.now() / 1000, this.per_tick_limit)
    for (const reminder of due) {
      const next = isRecurring(reminder)
        ? computeNextFire(reminder, this.now() / 1000, this.ownerTimeZone(reminder.owner_slug))
        : null
      const attempt = await this.store.beginDelivery(
        reminder, this.now() / 1000, this.interval_ms / 1000, next,
      )
      if (attempt === null) continue
      let observation: DeliveryObservation
      try {
        observation = await this.dispatcher.dispatch(reminder) ?? {
          state: 'not-yet-known', reason: 'dispatcher returned without a delivery observation',
        }
      } catch (err) {
        // A throw can follow a side effect; it is not proof of non-delivery.
        observation = { state: 'not-yet-known', reason: String(err) }
        log.error('dispatch_failed', { reminder: reminder.id, error: String(err) })
      }
      if (await this.store.observeDelivery(reminder, attempt, observation, this.now() / 1000, next)) {
        this.firedCount++
      }
    }
  }

  /**
   * The zone a cron cadence for `owner_slug` resolves in, asked FRESH at every
   * fire so a zone the owner's client reports after boot applies immediately.
   *
   * A resolver that returns nothing — or throws, which a DB-backed resolver can
   * do — degrades to {@link REMINDER_FALLBACK_TIME_ZONE} and says so in the log,
   * because a reminder firing in the wrong zone is invisible to the owner and so
   * has to be visible to whoever reads the logs. It never degrades to the host
   * zone: that is the failure this resolver exists to remove.
   */
  private ownerTimeZone(owner_slug: string): string {
    let resolved: string | null | undefined
    try {
      resolved = this.resolve_time_zone(owner_slug)
    } catch (err) {
      log.warn('owner_timezone_resolver_threw', {
        owner: owner_slug,
        fallback: REMINDER_FALLBACK_TIME_ZONE,
        error: err instanceof Error ? err.message : String(err),
      })
      return REMINDER_FALLBACK_TIME_ZONE
    }
    if (typeof resolved === 'string' && resolved.length > 0) return resolved
    log.warn('owner_timezone_unknown_using_fallback', {
      owner: owner_slug,
      fallback: REMINDER_FALLBACK_TIME_ZONE,
    })
    return REMINDER_FALLBACK_TIME_ZONE
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
