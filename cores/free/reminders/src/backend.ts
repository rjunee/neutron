/**
 * @neutronai/reminders-core — Reminders-Core backend interface + engine adapter.
 *
 * The Reminders Core programs against `RemindersBackend` (create /
 * list / snooze / cancel). The wired adapter
 * `buildReminderStoreBackend({project_slug, projectDb})` constructs an
 * internal `ReminderStore` (from `@neutronai/reminders`) bound to the
 * same per-project SQLite that the engine itself uses — that is the
 * substrate-level reminders surface every instance boot resolves at
 * provisioning time (`reminders` table from migration 0004).
 *
 * Why an extra `RemindersBackend` indirection over `ReminderStore`:
 * - The Core exposes a four-tool product surface (create / list /
 *   snooze / cancel) shaped for the launcher UX. `ReminderStore` is a
 *   wider substrate (one-shot + recurring writes, `listDue` for the
 *   tick loop, `markFired`, `advanceRecurrence`). Folding all four
 *   tools straight onto `ReminderStore` would leak engine concerns
 *   (e.g. topic_id, recurrence, listDue vs listPending) into the
 *   Core's MCP contract.
 * - Tests pass `projectDb` and project_slug; the adapter constructs its
 *   own store. The tool wiring stays oblivious to engine shape.
 *
 * OWNERSHIP ISOLATION: every id-based mutation (`snooze`, `cancel`)
 * reads the row first and verifies `project_slug === opts.project_slug`
 * before touching it. The engine's `ReminderStore.cancel(id)` /
 * `get(id)` key on id alone, so without this check a caller that
 * learned another owner's id could mutate a foreign row. The brief
 * locks "engine public API untouched", so the check lives at the
 * adapter layer (per Codex r1 P1 follow-up, 2026-05-18).
 *
 * Snooze atomicity: the engine has no `snooze` for one-shot rows
 * (only `advanceRecurrence` for recurring rows), and the brief locks
 * "engine public API untouched". The adapter implements `snooze` as
 * `cancel + create` WRAPPED IN `projectDb.transaction(...)` so both
 * writes commit together or neither does — protects against the
 * "cancel succeeded, create failed → reminder lost" failure mode
 * (per Codex r1 P2 follow-up, 2026-05-18). When a future sprint adds
 * a first-class `ReminderStore.snooze` the adapter swaps to it; the
 * tool contract here stays unchanged.
 *
 * OWNERSHIP TAG (r2 follow-up, 2026-05-18). The Core writes its
 * package name into the engine row's `source` column on every create
 * — see `CORE_SOURCE_TAG`. On uninstall the deployment wrapper calls
 * `cancelOwnedReminders({...})` BEFORE `uninstallCore({...})`; that
 * sweep cancels every pending row with `source = CORE_SOURCE_TAG`,
 * leaving organic engine reminders (NULL source) untouched. Without
 * this tag a Core uninstall would leak rows that keep firing via the
 * engine's tick loop AND would over-cancel if it grabbed everything
 * for the owner.
 *
 * SOURCE PRESERVATION ON SNOOZE (r3 follow-up, 2026-05-18). `list()`
 * returns every pending row for the owner — including organic engine
 * rows with `source = NULL` that the gateway's own reminder-agents or
 * wow-moment nudges wrote. A user can therefore learn an organic
 * reminder's id and call `snooze` on it. The replacement row MUST
 * carry the ORIGINAL row's source (which may be `CORE_SOURCE_TAG`,
 * NULL, or another tag) and NOT be unconditionally re-tagged as
 * Core-owned — otherwise the uninstall sweep would later cancel a
 * reminder the Core never created (symmetric inverse of the r1 leak).
 */

import {
  ALL_REMINDER_RECURRENCES,
  ReminderStore,
  type CreateReminderInput,
  type CreateRecurringReminderInput,
  type Reminder,
  type ReminderRecurrence,
} from '@neutronai/reminders'
import {
  NO_PROJECT,
  TASK_SOURCE_REMINDER,
  TaskStore,
  type Task,
} from '@neutronai/tasks'

import type { ProjectDb } from '../../../../persistence/index.ts'

import { CORE_PACKAGE_NAME } from './manifest.ts'

/**
 * Origin tag every reminder this Core creates carries in the engine's
 * `source` column. The cleanup pass keys on this exact string — change
 * it only in lockstep with a migration that rewrites existing rows.
 */
export const CORE_SOURCE_TAG: string = CORE_PACKAGE_NAME

/**
 * The row shape callers receive on `list`. Mirrors the manifest's
 * `reminders_list` output_schema one-for-one: id, message, fire_at,
 * status, and project_id (sourced from the engine's topic_id column).
 */
export interface ReminderRow {
  id: string
  message: string
  fire_at: number
  status: 'pending' | 'fired' | 'cancelled'
  project_id: string | null
}

export interface RemindersCreateInput {
  message: string
  fire_at: number
  /** Optional project scope; persisted as the engine's topic_id under the hood. */
  project_id?: string
  /**
   * Optional cadence. When set, the reminder RECURS: `fire_at` is the first
   * occurrence and the tick loop reschedules the next one after each fire
   * (`weekly` +7d, `monthly` +30d, `occasional` +14d). When omitted the
   * reminder is one-shot. Daily / weekday cadences are NOT representable here —
   * the skill steers those to the nag-until-done pattern instead of falsely
   * claiming recurrence.
   */
  recurrence?: ReminderRecurrence
}

export interface RemindersCreateResult {
  id: string
  fire_at: number
}

export interface RemindersListInput {
  limit?: number
  project_id?: string
  status?: 'pending' | 'fired' | 'cancelled'
}

export interface RemindersSnoozeInput {
  id: string
  new_fire_at: number
}

export interface RemindersSnoozeResult {
  /** Id of the newly-created reminder carrying the new fire_at. */
  id: string
  /** Id of the original reminder that was cancelled. */
  cancelled_id: string
  fire_at: number
}

export interface RemindersCancelInput {
  id: string
}

export interface RemindersCancelResult {
  ok: boolean
}

/**
 * Input for the P6 `reminders_convert_to_task` tool. Promotes a
 * pending reminder into a canonical task. The reminder itself is left
 * pending so the original audit lineage stays intact; the linked task
 * (created via `TaskStore.create({due_date: ...})`) auto-creates a
 * NEW reminder via the task → reminder link path, and the source
 * reminder is then cancelled. The end state: one task, one fresh
 * reminder bound to it, one historical cancelled reminder.
 */
export interface RemindersConvertToTaskInput {
  /** Pending reminder id to convert. */
  id: string
  /** Optional project scope for the new task. Defaults to the reminder's. */
  project_id?: string
  /** Optional priority hint (0..3, 3 = highest). */
  priority?: number
  /** Optional title override. Falls back to the reminder's `message`. */
  title?: string
}

export interface RemindersConvertToTaskResult {
  task_id: string
  /** Id of the freshly-created reminder linked to the new task. */
  linked_reminder_id: string | null
  /** Id of the original reminder that was cancelled. */
  cancelled_reminder_id: string
}

/**
 * S1 — input shape for `update`. Rewrites a pending reminder's message
 * body. Implemented as atomic cancel+create inside
 * `projectDb.transaction(...)` so the change commits together or not at
 * all. Preserves the original row's topic_id + fire_at + recurrence +
 * source verbatim — only the body changes. Ownership check +
 * status='pending' guard mirror the snooze path. See the long-form
 * rationale on `RemindersBackend.update` below.
 */
export interface RemindersUpdateInput {
  id: string
  /** New message body. Replaces the original; original is cancelled. */
  message: string
}

export interface RemindersUpdateResult {
  /** Id of the newly-created reminder carrying the new message. */
  id: string
  /** Id of the original reminder that was cancelled. */
  replaced_id: string
  /** The new message body (echoed for caller confirmation). */
  message: string
}

export interface RemindersBackend {
  create(input: RemindersCreateInput): Promise<RemindersCreateResult>
  list(input: RemindersListInput): Promise<ReminderRow[]>
  snooze(input: RemindersSnoozeInput): Promise<RemindersSnoozeResult>
  cancel(input: RemindersCancelInput): Promise<RemindersCancelResult>
  /**
   * P6 — convert a pending reminder into a canonical task. The
   * implementation requires a TaskStore to be wired; backends without
   * one MAY throw `ReminderConvertUnsupportedError`. The Tier 1
   * canonical adapter does wire one.
   */
  convertToTask?(input: RemindersConvertToTaskInput): Promise<RemindersConvertToTaskResult>
  /**
   * S1 — rewrite a pending reminder's message body. Implemented as
   * atomic cancel + create inside `projectDb.transaction(...)` so the
   * change commits together or not at all. Preserves the original
   * row's topic_id + fire_at + recurrence + source (NULL for organic,
   * `CORE_SOURCE_TAG` for Core-owned). Ownership check +
   * status='pending' guard mirror the snooze path.
   *
   * Why update is NOT a SQL UPDATE on `reminders.message`: the engine's
   * `ReminderStore` deliberately has no `updateMessage` method —
   * preserving the row id across content changes would muddle the
   * audit lineage (the fire-time agent that picks up a re-written
   * reminder body would not see the original phrasing the user agreed
   * to). The adapter implements `update` as cancel + create so the
   * user sees a new id, the audit trail records both writes, and the
   * engine surface stays untouched. The Nova `remind` skill's
   * "update the reminder to say X" UX still works — the chat surface
   * confirms with `(updated → new id <abc>)`.
   *
   * Throws if id is not found, belongs to a foreign owner (info-
   * hidden as "not found"), or is not pending (status != 'pending').
   */
  update(input: RemindersUpdateInput): Promise<RemindersUpdateResult>
}

export class ReminderConvertUnsupportedError extends Error {
  override readonly name = 'ReminderConvertUnsupportedError'
  readonly code = 'convert_unsupported' as const
}

/**
 * Default page size when callers omit `limit`. Generous enough for a
 * launcher preview list, conservative enough that an unbounded query
 * doesn't fan out the entire reminders table.
 */
const DEFAULT_LIST_LIMIT = 50

export interface ReminderStoreBackendOptions {
  /**
   * Owner slug the adapter binds to — every write/read scopes to
   * this slug so the Core never leaks reminders across instances.
   */
  project_slug: string
  /**
   * The per-project `ProjectDb` the engine writes through. The adapter
   * constructs its own `ReminderStore` over the same DB so it can
   * wrap multi-step writes (snooze) in `projectDb.transaction(...)`.
   */
  projectDb: ProjectDb
  /**
   * Optional canonical `TaskStore` for the P6
   * `reminders_convert_to_task` tool. When omitted, calling
   * `convertToTask(...)` throws `ReminderConvertUnsupportedError`.
   * Production composition wires the shared TaskStore here.
   */
  taskStore?: TaskStore
}

/**
 * Adapter from the substrate `ReminderStore` to the Core's
 * product-level `RemindersBackend`. Stateless wrapper bound to a
 * single owner slug.
 *
 * `list` uses `ReminderStore.listPending(project_slug)` which already
 * sorts ASCENDING by `fire_at` (soonest-firing first) — the natural
 * reminder semantic, inverse of Notes' newest-first list semantic.
 *
 * `status !== 'pending'` returns an empty array in v1 — the engine
 * has no `listAll` or `listFired` surface, and the brief locks the
 * engine public API untouched. Forward-compat handled when the engine
 * grows a wider list method.
 */
export function buildReminderStoreBackend(
  opts: ReminderStoreBackendOptions,
): RemindersBackend {
  const store = new ReminderStore(opts.projectDb)

  function ownsRow(row: Reminder | null): row is Reminder {
    return row !== null && row.project_slug === opts.project_slug
  }

  return {
    async create(input: RemindersCreateInput): Promise<RemindersCreateResult> {
      // A cadence makes the reminder RECUR: route through the engine's
      // `createRecurring` so the tick loop reschedules the next occurrence
      // after each fire (instead of a one-shot that fires once and dies — the
      // bug where the agent confirmed "every week" but the row never repeated).
      if (input.recurrence !== undefined) {
        // The MCP boundary passes untyped JSON, so a model could send a cadence
        // the engine can't represent (e.g. 'daily'). Reject it clearly rather
        // than writing a row whose `computeNextRecurrence` delta is undefined →
        // NaN fire_at that silently never reschedules.
        if (!ALL_REMINDER_RECURRENCES.includes(input.recurrence)) {
          throw new Error(
            `reminders_create: unsupported recurrence '${String(input.recurrence)}' ` +
              `(allowed: ${ALL_REMINDER_RECURRENCES.join(', ')})`,
          )
        }
        const recurring_input: CreateRecurringReminderInput = {
          project_slug: opts.project_slug,
          topic_id: input.project_id ?? null,
          fire_at: input.fire_at,
          message: input.message,
          recurrence: input.recurrence,
          source: CORE_SOURCE_TAG,
        }
        const row = await store.createRecurring(recurring_input)
        return { id: row.id, fire_at: row.fire_at }
      }
      const create_input: CreateReminderInput = {
        project_slug: opts.project_slug,
        topic_id: input.project_id ?? null,
        fire_at: input.fire_at,
        message: input.message,
        source: CORE_SOURCE_TAG,
      }
      const row = await store.create(create_input)
      return { id: row.id, fire_at: row.fire_at }
    },

    async list(input: RemindersListInput): Promise<ReminderRow[]> {
      // v1 only lists pending reminders — the manifest's input_schema
      // now declares the status enum as just ['pending'] so callers
      // can't ask for fired/cancelled. The default-on-omit kept here
      // because the schema makes the field optional.
      const pending = store.listPending(opts.project_slug)
      const filtered = input.project_id === undefined
        ? pending
        : pending.filter((r) => r.topic_id === input.project_id)
      const limit = input.limit ?? DEFAULT_LIST_LIMIT
      return filtered.slice(0, limit).map(reminderToRow)
    },

    async snooze(input: RemindersSnoozeInput): Promise<RemindersSnoozeResult> {
      return opts.projectDb.transaction(async (tx) => {
        // Re-build a tx-bound store so cancel + create commit together.
        // Without the transaction, a failure between cancel and create
        // would lose the reminder permanently.
        const txStore = new ReminderStore(tx)
        const original = txStore.get(input.id)
        if (original === null) {
          throw new Error(`reminders_snooze: id=${input.id} not found`)
        }
        if (!ownsRow(original)) {
          // Cross-instance access — the caller learned an id that
          // doesn't belong to them. Surface as "not found" to avoid
          // confirming the id exists in another instance.
          throw new Error(`reminders_snooze: id=${input.id} not found`)
        }
        if (original.status !== 'pending') {
          throw new Error(
            `reminders_snooze: id=${input.id} is not pending (status=${original.status})`,
          )
        }
        const cancelled = await txStore.cancel(input.id)
        if (!cancelled) {
          // Race with another cancel — the row stopped being pending
          // between `get` and `cancel`. Surface the conflict rather
          // than silently re-create.
          throw new Error(
            `reminders_snooze: id=${input.id} no longer pending`,
          )
        }
        // Preserve the ORIGINAL row's source on the replacement.
        // `list()` returns every pending row for the owner — incl.
        // organic engine rows whose source is NULL — so a user can
        // snooze a row this Core did not create. Re-tagging the
        // replacement as CORE_SOURCE_TAG would make the uninstall
        // sweep cancel a reminder the Core never owned (symmetric
        // inverse of the r1 leak). `source` may be NULL, the Core
        // tag, or another tag — round-trip it verbatim.
        //
        // Recurring rows go through `createRecurring(...)` so snoozing a
        // recurring reminder PRESERVES its cadence — otherwise a weekly/monthly
        // reminder would silently become a one-shot after the first snooze and
        // stop repeating (mirrors the `update` path's same branch).
        let replacement: Reminder
        if (original.recurrence !== null) {
          replacement = await txStore.createRecurring({
            project_slug: original.project_slug,
            topic_id: original.topic_id,
            fire_at: input.new_fire_at,
            message: original.message,
            recurrence: original.recurrence,
            source: original.source,
          })
        } else {
          replacement = await txStore.create({
            project_slug: original.project_slug,
            topic_id: original.topic_id,
            fire_at: input.new_fire_at,
            message: original.message,
            source: original.source,
          })
        }
        return {
          id: replacement.id,
          cancelled_id: input.id,
          fire_at: replacement.fire_at,
        }
      })
    },

    async update(input: RemindersUpdateInput): Promise<RemindersUpdateResult> {
      return opts.projectDb.transaction(async (tx) => {
        // Re-build a tx-bound store so cancel + create commit together.
        // Without the transaction, a failure between cancel and create
        // would lose the reminder permanently (same atomicity rationale
        // as `snooze`).
        const txStore = new ReminderStore(tx)
        const original = txStore.get(input.id)
        if (original === null) {
          throw new Error(`reminders_update: id=${input.id} not found`)
        }
        if (!ownsRow(original)) {
          // Cross-instance access — the caller learned an id that doesn't
          // belong to them. Surface as "not found" to avoid confirming
          // the id exists in another instance.
          throw new Error(`reminders_update: id=${input.id} not found`)
        }
        if (original.status !== 'pending') {
          throw new Error(
            `reminders_update: id=${input.id} is not pending (status=${original.status})`,
          )
        }
        const cancelled = await txStore.cancel(input.id)
        if (!cancelled) {
          // Race with another cancel — the row stopped being pending
          // between `get` and `cancel`. Surface the conflict rather
          // than silently re-create.
          throw new Error(
            `reminders_update: id=${input.id} no longer pending`,
          )
        }
        // Recurring rows go through `createRecurring(...)` so the
        // replacement preserves cadence; one-shot rows go through
        // `create(...)`. The engine surface stays untouched in both
        // cases (no new method needed on `ReminderStore`).
        let replacement: Reminder
        if (original.recurrence !== null) {
          const create_input: CreateRecurringReminderInput = {
            project_slug: original.project_slug,
            topic_id: original.topic_id,
            fire_at: original.fire_at,
            message: input.message,
            recurrence: original.recurrence,
            // Preserve the ORIGINAL row's source on the replacement —
            // same rationale as snooze's r3 follow-up (organic rows
            // stay organic, Core-owned rows stay Core-owned).
            source: original.source,
          }
          replacement = await txStore.createRecurring(create_input)
        } else {
          const create_input: CreateReminderInput = {
            project_slug: original.project_slug,
            topic_id: original.topic_id,
            fire_at: original.fire_at,
            message: input.message,
            // Preserve the ORIGINAL row's source on the replacement —
            // see snooze r3 follow-up.
            source: original.source,
          }
          replacement = await txStore.create(create_input)
        }
        return {
          id: replacement.id,
          replaced_id: input.id,
          message: replacement.message,
        }
      })
    },

    async cancel(input: RemindersCancelInput): Promise<RemindersCancelResult> {
      const existing = store.get(input.id)
      if (!ownsRow(existing)) {
        // Either the row doesn't exist OR it belongs to a different
        // owner. Treat both as a no-op cancel; the API contract for
        // `ok: false` already covers "already cancelled / unknown id",
        // so returning false here keeps the surface uniform and avoids
        // leaking the existence of a foreign row to this owner.
        return { ok: false }
      }
      const ok = await store.cancel(input.id)
      return { ok }
    },

    async convertToTask(
      input: RemindersConvertToTaskInput,
    ): Promise<RemindersConvertToTaskResult> {
      if (opts.taskStore === undefined) {
        throw new ReminderConvertUnsupportedError(
          'convertToTask: no canonical TaskStore wired',
        )
      }
      const taskStore = opts.taskStore
      const reminder = store.get(input.id)
      if (!ownsRow(reminder)) {
        throw new Error(`reminders_convert_to_task: id=${input.id} not found`)
      }
      if (reminder.status !== 'pending') {
        throw new Error(
          `reminders_convert_to_task: id=${input.id} is not pending (status=${reminder.status})`,
        )
      }
      const title =
        typeof input.title === 'string' && input.title.trim().length > 0
          ? input.title.trim()
          : reminder.message
      const project_id = resolveTaskProjectId(reminder, input.project_id)
      const dueIso = new Date(Math.round(reminder.fire_at * 1000)).toISOString()
      const created: Task = await taskStore.create({
        project_slug: opts.project_slug,
        project_id,
        title,
        due_date: dueIso,
        priority: typeof input.priority === 'number' ? input.priority : null,
        source: TASK_SOURCE_REMINDER,
      })
      // Cancel the source reminder — the task's auto-create just spawned
      // a fresh reminder bound to the canonical row, so the original
      // would otherwise fire twice. The cancellation preserves the
      // audit lineage.
      await store.cancel(input.id)
      // Best-effort lookup of the freshly-created linked reminder so
      // the caller can surface its id; we read from the link table
      // lazily so the Reminders Core doesn't have to depend on the
      // tasks workspace for the link query.
      let linked_reminder_id: string | null = null
      try {
        const row = opts.projectDb
          .prepare<{ reminder_id: string }, [string]>(
            `SELECT reminder_id
               FROM task_reminder_links
              WHERE task_id = ?
              ORDER BY created_at DESC
              LIMIT 1`,
          )
          .get(created.id)
        if (row !== null) linked_reminder_id = row.reminder_id
      } catch {
        // best-effort; if the link table query failed (e.g. migration
        // 0037 not applied to this test fixture), surface null.
        linked_reminder_id = null
      }
      return {
        task_id: created.id,
        linked_reminder_id,
        cancelled_reminder_id: input.id,
      }
    },
  }
}

function resolveTaskProjectId(
  reminder: Reminder,
  override: string | undefined,
): string {
  if (override !== undefined) {
    return override.length === 0 ? NO_PROJECT : override
  }
  const topic = reminder.topic_id
  if (typeof topic !== 'string') return NO_PROJECT
  if (topic.startsWith('app-project:')) {
    const pid = topic.slice('app-project:'.length)
    return pid.length === 0 ? NO_PROJECT : pid
  }
  // The Reminders Core's own create path stores the project_id as the
  // raw topic_id (see `buildReminderStoreBackend.create`); fall through
  // to treat that raw value as the project_id. Telegram thread ids and
  // other engine topics will look like numeric ids, which aren't valid
  // project ids — but the canonical task store doesn't reject them and
  // they sort cleanly as "instance-level reminders" once a real project
  // surface attaches.
  if (topic.length > 0 && !topic.includes(':')) {
    return topic
  }
  return NO_PROJECT
}

function reminderToRow(r: Reminder): ReminderRow {
  return {
    id: r.id,
    message: r.message,
    fire_at: r.fire_at,
    status: r.status,
    project_id: r.topic_id,
  }
}

export interface CancelOwnedRemindersInput {
  /** Owner whose Core-created reminders should be swept. */
  project_slug: string
  /** Project DB the engine wrote the rows into. */
  projectDb: ProjectDb
}

export interface CancelOwnedRemindersResult {
  /** Count of pending rows the cleanup pass cancelled. */
  cancelled: number
}

/**
 * Uninstall-time cleanup hook. Wraps the deployment's invocation of
 * `uninstallCore(...)` from `@neutronai/cores-runtime` — the runtime
 * deletes the sidecar but knows nothing about rows the Core piggybacked
 * into the shared engine `reminders` table; without this sweep those
 * rows would orphan in `project.db` and KEEP FIRING via the engine's
 * tick loop after the Core is gone.
 *
 * The sweep scopes on `source = CORE_SOURCE_TAG` so it only touches
 * rows this Core created. Organic engine reminders (gateway reminder
 * agents, wow-moment lifestyle nudges, interest-check-ins, etc.) carry
 * `source = NULL` and are intentionally excluded.
 *
 * Idempotent: a second call after every row is cancelled returns
 * `{ cancelled: 0 }`. Safe to invoke even on an instance that never
 * installed the Core.
 *
 * MUST be called BEFORE `uninstallCore(...)`. Calling after is
 * harmless but defeats the point — the runtime has already marked the
 * `core_installations` row uninstalled by then.
 */
export async function cancelOwnedReminders(
  input: CancelOwnedRemindersInput,
): Promise<CancelOwnedRemindersResult> {
  const store = new ReminderStore(input.projectDb)
  const owned = store.listPendingBySource(input.project_slug, CORE_SOURCE_TAG)
  let cancelled = 0
  for (const row of owned) {
    const ok = await store.cancel(row.id)
    if (ok) cancelled++
  }
  return { cancelled }
}
