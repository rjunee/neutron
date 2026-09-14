/**
 * @neutronai/reminders — instance-scoped reminder store.
 *
 * Replaces Nova's `gateway/reminders.json` single-file store with the
 * per-project `reminders` table (migration 0004). The fire-time agent composes the
 * actual Telegram body from the stored `message` at fire time; this row is
 * the persistent state.
 *
 * The store handles CRUD over the table. The tick loop in `tick.ts`
 * consumes `listDue()` and dispatches per-row.
 *
 * P2 v2 S9 (docs/plans/P2-onboarding-v2.md § 5.2 / § 9.4) — added the
 * `recurrence` column + `createRecurring()` write API for the wow-moment
 * interest-check-in action. Recurring rows carry one of
 * 'weekly' | 'monthly' | 'occasional'; the dispatch loop uses this on
 * fire to schedule the next occurrence rather than terminate.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { exhaustionReason, type DeliveryObservation, type ReminderDelivery } from './delivery.ts'
import { RITUAL_ID_RE } from './rituals.ts'

/**
 * Recurrence labels recognized by the store. `null` (the default for
 * one-shot reminders) means "fires once and is done."
 */
export type ReminderRecurrence = 'weekly' | 'monthly' | 'occasional'

export const ALL_REMINDER_RECURRENCES: ReadonlyArray<ReminderRecurrence> = [
  'weekly',
  'monthly',
  'occasional',
]

export interface Reminder {
  id: string
  owner_slug: string
  topic_id: string | null
  fire_at: number
  message: string
  status: 'pending' | 'fired' | 'cancelled'
  /** P2 v2 S9 — null for one-shot reminders; coarse cadence label for recurring. */
  recurrence: ReminderRecurrence | null
  /**
   * Cron-cadence parity — a faithful 5-field cron expression (`0 9 * * *`,
   * `0 9 7 2 *`, …) for wall-clock recurring reminders, or `null`. Mutually
   * exclusive with `recurrence`: a row is recurring when EITHER column is set,
   * and the tick loop resolves the next fire from whichever one is populated
   * (coarse → fixed delta; cron → DST-correct wall-clock). Migration 0093.
   */
  recurrence_spec: string | null
  /**
   * Executor-mode ritual tag. NULL for a plain nudge reminder; set to a
   * charset-guarded ritual id (`reminders/rituals.ts` RITUAL_ID_RE) when this
   * row is a ritual dispatch — the tick loop (plan task 4) resolves + validates
   * it and spawns a scoped sub-agent REPL instead of composing a one-shot nudge.
   * Opaque TEXT to SQLite; the in-process ritual registry owns validity.
   * Migration 0106.
   */
  ritual_id: string | null
  /**
   * Optional origin tag. NULL for organic engine writes (gateway
   * reminder agents, wow-moment actions, etc.). A Core that piggybacks
   * on the shared `reminders` table sets this to its package name so
   * uninstall can scope the cancellation pass to just the rows IT
   * created — see `listPendingBySource`. Migration 0031.
   */
  source: string | null
  created_at: number
  fired_at: number | null
  cancelled_at: number | null
}

export interface CreateReminderInput {
  /** Optional caller-supplied id; UUID generated if absent. */
  id?: string
  owner_slug: string
  topic_id: string | null
  /** unix-seconds fire time (UTC). */
  fire_at: number
  message: string
  /**
   * Optional origin tag. Cores that piggyback on the shared engine
   * table SHOULD pass their package name (e.g.
   * `'@neutronai/reminders-core'`) so their uninstall hook can sweep
   * just the rows they own without touching organic engine writes.
   */
  source?: string | null
  /**
   * Executor-mode ritual tag (plan task 8 WRITE path). When set, this row is a
   * RITUAL dispatch: the tick loop resolves + validates the ritual by this id
   * (fail-closed against the in-process registry + approval gate) and spawns a
   * scoped sub-agent REPL instead of composing a one-shot nudge. Must match
   * `RITUAL_ID_RE` — a malformed value THROWS (fail closed) rather than writing
   * an unroutable row. Omit for a plain nudge reminder (defaults NULL).
   */
  ritual_id?: string
}

export interface CreateRecurringReminderInput {
  /** Optional caller-supplied id; UUID generated if absent. */
  id?: string
  owner_slug: string
  topic_id: string | null
  /** unix-seconds for the FIRST occurrence (UTC). */
  fire_at: number
  message: string
  /**
   * Coarse cadence label — drives the tick loop's fixed-delta rescheduler.
   * Mutually exclusive with `recurrence_spec`; provide exactly one.
   */
  recurrence?: ReminderRecurrence
  /**
   * Faithful 5-field cron expression — drives the tick loop's DST-correct
   * wall-clock rescheduler. Mutually exclusive with `recurrence`; provide
   * exactly one. The store does not validate the cron grammar (callers
   * validate at the tool boundary, as they do the coarse label); it only
   * enforces that exactly one cadence is supplied.
   */
  recurrence_spec?: string
  /** Same semantics as `CreateReminderInput.source`. */
  source?: string | null
  /**
   * Executor-mode ritual tag (plan task 8 WRITE path) — same contract as
   * `CreateReminderInput.ritual_id`: when set the recurring row is a ritual
   * dispatch; must match `RITUAL_ID_RE` (throws on malformed). Omit for a
   * plain recurring nudge (defaults NULL).
   */
  ritual_id?: string
}

interface ReminderDbRow {
  id: string
  // SQL column name remains `project_slug`; value is the owner/instance slug
  // (N4: TS-side domain identifiers are `owner_slug`, the frozen column is not).
  project_slug: string
  topic_id: string | null
  fire_at: number
  message: string
  status: 'pending' | 'fired' | 'cancelled'
  recurrence: ReminderRecurrence | null
  recurrence_spec: string | null
  ritual_id: string | null
  source: string | null
  created_at: number
  fired_at: number | null
  cancelled_at: number | null
}

const COLS =
  'id, project_slug, topic_id, fire_at, message, status, recurrence, recurrence_spec, ritual_id, source, created_at, fired_at, cancelled_at'

export class ReminderStore {
  constructor(private readonly db: ProjectDb) {}

  /** Module-owned ledger: bootstrap before querying it; writes use ProjectDb's lock. */
  async initializeDelivery(): Promise<void> {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS reminder_delivery (
      reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
      fire_at REAL NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('delivered', 'known-not-delivered', 'not-yet-known')),
      reason TEXT,
      observed_at REAL,
      delivered_at REAL,
      next_attempt_at REAL NOT NULL,
      exhausted_reason TEXT,
      PRIMARY KEY (reminder_id, fire_at)
    )`)
  }

  /** Call after initializeDelivery; historical occurrences remain queryable. */
  getDelivery(id: string, fire_at: number): ReminderDelivery | null {
    return this.db.prepare<ReminderDelivery, [string, number]>(
      'SELECT * FROM reminder_delivery WHERE reminder_id = ? AND fire_at = ?',
    ).get(id, fire_at)
  }

  listDispatchable(as_of: number, limit: number): Reminder[] {
    return this.db.prepare<ReminderDbRow, [number, number, number]>(
      `SELECT ${COLS} FROM reminders WHERE status = 'pending' AND fire_at <= ?
       AND NOT EXISTS (SELECT 1 FROM reminder_delivery d
         WHERE d.reminder_id = reminders.id AND d.fire_at = reminders.fire_at
         AND (d.exhausted_reason IS NOT NULL OR d.state = 'delivered' OR d.next_attempt_at > ?))
       ORDER BY fire_at ASC LIMIT ?`,
    ).all(as_of, as_of, limit).map(rowToReminder)
  }

  /** Persist uncertainty BEFORE dispatch. A restarted loop inherits both bounds. */
  async beginDelivery(reminder: Reminder, now: number, cadence: number, next_fire_at: number | null = null): Promise<number | null> {
    return this.db.transaction(async () => {
      const current = this.get(reminder.id)
      if (current?.status !== 'pending' || current.fire_at !== reminder.fire_at) return null
      const before = this.getDelivery(reminder.id, reminder.fire_at)
      if (before?.exhausted_reason || before?.state === 'delivered') return null
      const exhausted = exhaustionReason(before?.attempts ?? 0, reminder.fire_at, now)
      if (exhausted) {
        await this.db.run(`INSERT INTO reminder_delivery
          (reminder_id, fire_at, state, reason, next_attempt_at, exhausted_reason)
          VALUES (?, ?, 'not-yet-known', 'no delivery observation', ?, ?)
          ON CONFLICT (reminder_id, fire_at) DO UPDATE SET exhausted_reason = excluded.exhausted_reason`,
        [reminder.id, reminder.fire_at, now, exhausted])
        if (next_fire_at !== null) await this.advanceRecurrence(reminder.id, next_fire_at)
        return null
      }
      if (before && before.next_attempt_at > now) return null
      const attempts = (before?.attempts ?? 0) + 1
      await this.db.run(`INSERT INTO reminder_delivery
        (reminder_id, fire_at, attempts, state, reason, next_attempt_at)
        VALUES (?, ?, ?, 'not-yet-known', 'attempt has no delivery observation', ?)
        ON CONFLICT (reminder_id, fire_at) DO UPDATE SET attempts = excluded.attempts,
          state = excluded.state, reason = excluded.reason, observed_at = NULL,
          next_attempt_at = excluded.next_attempt_at`,
      [reminder.id, reminder.fire_at, attempts, now + cadence])
      return attempts
    })
  }

  /** Settle only this attempt; an old completion cannot overwrite a newer attempt. */
  async observeDelivery(
    reminder: Reminder, attempt: number, observation: DeliveryObservation,
    now: number, next_fire_at: number | null,
  ): Promise<boolean> {
    return this.db.transaction(async () => {
      const before = this.getDelivery(reminder.id, reminder.fire_at)
      if (before?.attempts !== attempt || before.state === 'delivered') return false
      const delivered = observation.state === 'delivered'
      const exhausted = delivered ? null : exhaustionReason(attempt, reminder.fire_at, now)
      await this.db.run(`UPDATE reminder_delivery SET state = ?, reason = ?, observed_at = ?,
        delivered_at = ?, exhausted_reason = ? WHERE reminder_id = ? AND fire_at = ?`,
      [observation.state, delivered ? null : observation.reason,
        observation.state === 'not-yet-known' ? null : now, delivered ? now : null,
        exhausted, reminder.id, reminder.fire_at])
      const current = this.get(reminder.id)
      if (current?.fire_at !== reminder.fire_at) return delivered
      if (delivered || exhausted) {
        if (next_fire_at !== null) await this.advanceRecurrence(reminder.id, next_fire_at)
        else if (delivered) await this.markFired(reminder.id, now)
      }
      return delivered
    })
  }

  async create(input: CreateReminderInput): Promise<Reminder> {
    const id = input.id ?? crypto.randomUUID()
    const created_at = Date.now() / 1000
    const source = input.source ?? null
    // ritual_id WRITE path (plan task 8, migration 0106 column): NULL for a plain
    // nudge; a charset-guarded ritual id when this row is a ritual dispatch. A
    // malformed id FAILS CLOSED (throws) rather than writing an unroutable row —
    // the tick loop keys the ritual branch off this column.
    const ritual_id = normalizeRitualId(input.ritual_id)
    await this.db.run(
      `INSERT INTO reminders
         (id, project_slug, topic_id, fire_at, message, status, recurrence, recurrence_spec, ritual_id, source, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)`,
      [id, input.owner_slug, input.topic_id, input.fire_at, input.message, ritual_id, source, created_at],
    )
    return {
      id,
      owner_slug: input.owner_slug,
      topic_id: input.topic_id,
      fire_at: input.fire_at,
      message: input.message,
      status: 'pending',
      recurrence: null,
      recurrence_spec: null,
      ritual_id,
      source,
      created_at,
      fired_at: null,
      cancelled_at: null,
    }
  }

  /**
   * P2 v2 S9 — create a recurring reminder. The row carries a `recurrence`
   * cadence; the tick loop is responsible for advancing the next-occurrence
   * fire_at after each dispatch.
   *
   * The store does not validate that `fire_at` matches the cadence — callers
   * (the interest-check-in action; future cron-style schedulers) compute
   * the first occurrence themselves.
   */
  async createRecurring(input: CreateRecurringReminderInput): Promise<Reminder> {
    const recurrence = input.recurrence ?? null
    const recurrence_spec = input.recurrence_spec ?? null
    // Exactly one cadence must be supplied. Both → ambiguous next-fire
    // resolution; neither → a "recurring" row that never advances (fires once
    // then dies), the exact bug recurrence was added to prevent.
    if (recurrence !== null && recurrence_spec !== null) {
      throw new Error(
        'createRecurring: pass exactly one of recurrence (coarse label) or recurrence_spec (cron), not both',
      )
    }
    if (recurrence === null && recurrence_spec === null) {
      throw new Error(
        'createRecurring: a recurring reminder needs a cadence — pass recurrence or recurrence_spec',
      )
    }
    const id = input.id ?? crypto.randomUUID()
    const created_at = Date.now() / 1000
    const source = input.source ?? null
    // ritual_id WRITE path (plan task 8) — same contract as create(): a recurring
    // ritual dispatch carries its charset-guarded id here; a malformed id throws.
    const ritual_id = normalizeRitualId(input.ritual_id)
    await this.db.run(
      `INSERT INTO reminders
         (id, project_slug, topic_id, fire_at, message, status, recurrence, recurrence_spec, ritual_id, source, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [
        id,
        input.owner_slug,
        input.topic_id,
        input.fire_at,
        input.message,
        recurrence,
        recurrence_spec,
        ritual_id,
        source,
        created_at,
      ],
    )
    return {
      id,
      owner_slug: input.owner_slug,
      topic_id: input.topic_id,
      fire_at: input.fire_at,
      message: input.message,
      status: 'pending',
      recurrence,
      recurrence_spec,
      ritual_id,
      source,
      created_at,
      fired_at: null,
      cancelled_at: null,
    }
  }

  /** Cancel a pending reminder. Returns true if it was pending. */
  async cancel(id: string): Promise<boolean> {
    const before = this.get(id)
    if (!before || before.status !== 'pending') return false
    const cancelled_at = Date.now() / 1000
    await this.db.run(
      `UPDATE reminders SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'pending'`,
      [cancelled_at, id],
    )
    return true
  }

  /** Mark a reminder fired after an affirmative delivery observation. */
  async markFired(id: string, fired_at = Date.now() / 1000): Promise<void> {
    await this.db.run(
      `UPDATE reminders SET status = 'fired', fired_at = ? WHERE id = ? AND status = 'pending'`,
      [fired_at, id],
    )
  }

  /**
   * P2 v2 S9 (Codex S9-r1 P1) — advance a recurring reminder's `fire_at`
   * to its next occurrence. Used by the tick loop INSTEAD of `markFired`
   * for rows where `recurrence !== null`: the row stays `pending` and
   * re-fires on the next tick that crosses the new fire_at. Without
   * this, every recurring row would fire exactly once and then be lost
   * (the v1 store had no recurrence concept; the new tick-loop branch
   * + this writer give the row its proper lifecycle).
   *
   * Returns `true` iff the row was advanced (was `pending` AND recurring —
   * a coarse `recurrence` label OR a cron `recurrence_spec`). Returns `false`
   * for one-shot rows or already-fired/cancelled rows. A refusal does not
   * establish delivery and must not manufacture a fired stamp.
   */
  async advanceRecurrence(id: string, next_fire_at: number): Promise<boolean> {
    const before = this.get(id)
    if (before === null || before.status !== 'pending' || !isRecurring(before)) {
      return false
    }
    await this.db.run(
      `UPDATE reminders SET fire_at = ? WHERE id = ? AND status = 'pending'
        AND (recurrence IS NOT NULL OR recurrence_spec IS NOT NULL)`,
      [next_fire_at, id],
    )
    return true
  }

  /**
   * Return up to `limit` pending reminders whose fire_at <= now (`as_of`).
   * Sorted by fire_at ascending so the oldest-due fire first.
   */
  listDue(as_of: number, limit: number = 50): Reminder[] {
    return this.db
      .prepare<ReminderDbRow, [number, number]>(
        `SELECT ${COLS}
           FROM reminders
          WHERE status = 'pending' AND fire_at <= ?
          ORDER BY fire_at ASC
          LIMIT ?`,
      )
      .all(as_of, limit)
      .map(rowToReminder)
  }

  get(id: string): Reminder | null {
    const row = this.db
      .prepare<ReminderDbRow, [string]>(
        `SELECT ${COLS} FROM reminders WHERE id = ?`,
      )
      .get(id)
    return row === null ? null : rowToReminder(row)
  }

  /**
   * Plan task 8 — is this ritual ALREADY scheduled? The schedule-on-approve path
   * (`reminders/ritual-registration.ts`) calls this before creating the ritual's
   * reminder row so a repeated approval tap (or an approval landing after a row
   * already exists) can never schedule the same ritual twice.
   *
   * Argus r2 BLOCKER 1 (replay): the predicate is `status <> 'cancelled'`, NOT
   * `status = 'pending'`. A one-shot ritual's row is 'fired' once it runs, so a
   * pending-only check let a re-tapped Approve mint a FRESH reminder for an
   * already-completed ritual. Any non-cancelled row (pending live/recurring OR
   * fired one-shot) counts as "already scheduled"; a 'cancelled' row does NOT, so
   * an owner who cancels a ritual can re-propose and reschedule it. This mirrors
   * the partial UNIQUE index `idx_reminders_ritual_scheduled` (migration 0107)
   * that makes the invariant atomic — this read is the friendly-message fast
   * path; the index is the race-proof guarantee.
   *
   * Charset-guarded query — a malformed id throws (fail closed) rather than
   * scanning with an unroutable value.
   */
  hasScheduledRitualRow(ritual_id: string): boolean {
    if (typeof ritual_id !== 'string' || !RITUAL_ID_RE.test(ritual_id)) {
      throw new Error(
        `hasScheduledRitualRow: ritual_id ${JSON.stringify(ritual_id)} fails RITUAL_ID_RE`,
      )
    }
    const row = this.db
      .prepare<{ one: number }, [string]>(
        `SELECT 1 AS one FROM reminders WHERE ritual_id = ? AND status <> 'cancelled' LIMIT 1`,
      )
      .get(ritual_id)
    return row !== null
  }

  /** Snapshot of pending reminders for an instance (oldest-due first). */
  listPending(owner_slug: string): Reminder[] {
    return this.db
      .prepare<ReminderDbRow, [string]>(
        `SELECT ${COLS}
           FROM reminders
          WHERE project_slug = ? AND status = 'pending'
          ORDER BY fire_at ASC`,
      )
      .all(owner_slug)
      .map(rowToReminder)
  }

  /**
   * P5.5 — pending reminders for an instance whose `fire_at <= cutoff_s`,
   * capped at `limit`. The `listDue` shape requires `fire_at <= now`
   * (already due); `listPending` returns ALL pending. The Focus
   * aggregator needs the in-between: pending reminders firing in the
   * next 24h. Without this helper the aggregator had to call
   * `listPending` then filter in-process, which materialised every
   * pending row in JS heap before the cap took effect — a DoS vector
   * on instances with a year of recurring reminders. Bounded at the
   * SQL layer keeps the request flat-cost.
   */
  listPendingFiringBefore(
    owner_slug: string,
    cutoff_s: number,
    limit: number,
  ): Reminder[] {
    return this.db
      .prepare<ReminderDbRow, [string, number, number]>(
        `SELECT ${COLS}
           FROM reminders
          WHERE project_slug = ? AND status = 'pending' AND fire_at <= ?
          ORDER BY fire_at ASC
          LIMIT ?`,
      )
      .all(owner_slug, cutoff_s, limit)
      .map(rowToReminder)
  }

  /**
   * Snapshot of pending reminders for an instance whose `source` matches
   * the given tag — used by Cores that piggyback on the shared table
   * to scope their uninstall cleanup to the rows they created.
   *
   * Rows with NULL `source` (every organic engine write) are
   * intentionally excluded: matching on `source = ?` filters them out
   * regardless of the comparison value, so a Core's cleanup pass
   * never sweeps the engine's own reminders.
   */
  listPendingBySource(owner_slug: string, source: string): Reminder[] {
    return this.db
      .prepare<ReminderDbRow, [string, string]>(
        `SELECT ${COLS}
           FROM reminders
          WHERE project_slug = ? AND status = 'pending' AND source = ?
          ORDER BY fire_at ASC`,
      )
      .all(owner_slug, source)
      .map(rowToReminder)
  }

  /**
   * P5.4 — snapshot of pending reminders for an instance scoped to a single
   * `topic_id`. The Expo-app reminders tab uses this to surface only
   * reminders that belong to a given project (project_id is encoded into
   * `topic_id` as `app-project:<project_id>` when the row is created via
   * the app surface). The instance + topic_id together form the join key.
   *
   * Mirrors `listPending` ordering (fire_at ASC, next-firing first).
   */
  listPendingByTopic(owner_slug: string, topic_id: string): Reminder[] {
    return this.db
      .prepare<ReminderDbRow, [string, string]>(
        `SELECT ${COLS}
           FROM reminders
          WHERE project_slug = ? AND status = 'pending' AND topic_id = ?
          ORDER BY fire_at ASC`,
      )
      .all(owner_slug, topic_id)
      .map(rowToReminder)
  }

  /**
   * P5.4 — reschedule a pending reminder to a new `fire_at`. Used by
   * the Expo-app snooze action on one-shot rows; recurring rows
   * advance via `advanceRecurrence` from the tick loop instead.
   *
   * Returns `true` iff the row was pending and updated. Already
   * fired / cancelled rows return `false` without mutation so the
   * caller can surface a 404 to the client.
   */
  async reschedule(id: string, next_fire_at: number): Promise<boolean> {
    const before = this.get(id)
    if (before === null || before.status !== 'pending') return false
    await this.db.run(
      `UPDATE reminders SET fire_at = ? WHERE id = ? AND status = 'pending'`,
      [next_fire_at, id],
    )
    return true
  }

  /**
   * Rewrite a PENDING reminder's message body in place.
   *
   * Exists for the task ↔ reminder link (`tasks/reminder-link.ts`): a
   * task-derived reminder's message IS the task title, so renaming the task
   * without this would leave the owner being reminded, by name, of a task that
   * no longer goes by that name. Same pending-only contract as `reschedule` —
   * a fired or cancelled row is history and is never rewritten.
   *
   * Returns `true` iff the row was pending and updated.
   */
  async retitle(id: string, message: string): Promise<boolean> {
    const before = this.get(id)
    if (before === null || before.status !== 'pending') return false
    if (before.message === message) return false
    await this.db.run(
      `UPDATE reminders SET message = ? WHERE id = ? AND status = 'pending'`,
      [message, id],
    )
    return true
  }
}

function rowToReminder(row: ReminderDbRow): Reminder {
  return {
    id: row.id,
    owner_slug: row.project_slug,
    topic_id: row.topic_id,
    fire_at: row.fire_at,
    message: row.message,
    status: row.status,
    recurrence: row.recurrence,
    recurrence_spec: row.recurrence_spec,
    ritual_id: row.ritual_id,
    source: row.source,
    created_at: row.created_at,
    fired_at: row.fired_at,
    cancelled_at: row.cancelled_at,
  }
}

/**
 * A reminder recurs when EITHER cadence column is populated: a coarse
 * `recurrence` label (fixed-delta rescheduling) OR a `recurrence_spec` cron
 * expression (wall-clock rescheduling). One-shot rows have both `null`. This
 * is the single "is recurring?" predicate the store's claim/advance guards key
 * on so cron and coarse rows share one lifecycle.
 */
export function isRecurring(r: Pick<Reminder, 'recurrence' | 'recurrence_spec'>): boolean {
  return r.recurrence !== null || r.recurrence_spec !== null
}

/**
 * True when `err` is the SQLite UNIQUE-constraint violation from the partial
 * index `idx_reminders_ritual_scheduled` (migration 0107) — i.e. a concurrent
 * approval answer already inserted the ritual's reminder row between this
 * caller's dedup pre-check and its own INSERT (Argus r2 BLOCKER 2, the
 * double-schedule race). The schedule-on-approve path catches this and reports
 * "already scheduled" rather than a transient error. Matched on the stable
 * SQLite message text — `bun:sqlite` surfaces a partial-unique-index violation
 * as `UNIQUE constraint failed: reminders.ritual_id` (the indexed COLUMN, not
 * the index name; verified against bun:sqlite). `reminders.ritual_id` is unique
 * ONLY via `idx_reminders_ritual_scheduled` (migration 0107), so this is scoped
 * — an unrelated uniqueness error is NOT swallowed.
 */
export function isRitualScheduleConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /UNIQUE constraint failed/i.test(msg) && msg.includes('reminders.ritual_id')
  )
}

/**
 * Normalize the optional `ritual_id` on a create input: `undefined`/`null`
 * → `null` (a plain nudge row); a present value is charset-validated against
 * `RITUAL_ID_RE` and THROWS on a malformed value (fail closed — never write an
 * unroutable ritual tag the tick loop can't resolve). Plan task 8 WRITE path.
 */
function normalizeRitualId(ritual_id: string | null | undefined): string | null {
  if (ritual_id === undefined || ritual_id === null) return null
  if (typeof ritual_id !== 'string' || !RITUAL_ID_RE.test(ritual_id)) {
    throw new Error(
      `create: ritual_id ${JSON.stringify(ritual_id)} fails RITUAL_ID_RE (^[a-z0-9][a-z0-9-]{0,63}$)`,
    )
  }
  return ritual_id
}
