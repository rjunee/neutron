/**
 * @neutronai/gateway/push — high-level push dispatcher.
 *
 * P5.6 — glues the device-token store to the Expo Push API client.
 * Exposes two operations:
 *
 *   * `pushReminder(reminder)` — the reminder-fired hook. Reads every
 *     device token for the reminder's instance and POSTs a single push
 *     batch with `{ title: 'Reminder', body: reminder.message, data: {
 *     kind: 'reminder', reminder_id, project_slug } }`. Web push was
 *     removed 2026-05-22 (migration 0042) — the dispatcher trusts the
 *     CHECK constraint to keep web rows out of the table.
 *
 *   * `pushAll(project_slug, message)` — escape hatch for the future
 *     wow-moment / agent-initiated push surface. Not wired into the
 *     reminder loop today; lives here so the next sprint doesn't need
 *     to reach into the store + client primitives directly.
 *
 * Failure semantics per the brief: "Hook is additive — gracefully
 * no-ops if no tokens registered or Expo API unreachable." We:
 *   * return early when there are zero tokens
 *   * catch ExpoPushError / network failures and log a warning
 *   * log a warning per error-status ticket so a future cleanup pass
 *     can prune DeviceNotRegistered tokens
 *
 * The reminder dispatcher (Telegram-side) runs FIRST in
 * `ReminderTickLoop`; this hook runs AFTER markFired via the new
 * `onFired` callback so a push failure cannot stop the row from
 * being marked fired.
 */

import type { Reminder } from '@neutronai/reminders/store.ts'
import type { DevicePushTokenStore } from './store.ts'
import {
  ExpoPushError,
  type ExpoPushClient,
  type ExpoPushMessage,
} from './expo-push-client.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('push')

/** Coerce arbitrary log meta to the logger's primitive `LogValue` shape. */
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

export interface PushDispatcherOptions {
  store: DevicePushTokenStore
  client: ExpoPushClient
  /**
   * Optional title override for reminder pushes. The default 'Reminder'
   * keeps the v1 notification surface anonymous; a later sprint may
   * inject the project name once project metadata is reachable from
   * the reminder row (today reminders only carry a stringly-typed
   * `topic_id`).
   */
  reminder_title?: string
  /**
   * Optional structured logger. Defaults to `console.warn` so a
   * production gateway captures the warning in journald without extra
   * wiring. Tests pass a recording logger.
   */
  logger?: PushDispatcherLogger
}

export interface PushDispatcherLogger {
  warn(message: string, meta?: Record<string, unknown>): void
}

export interface PushDispatcher {
  pushReminder(reminder: Reminder): Promise<PushResult>
  pushAll(
    project_slug: string,
    message: { title?: string; body: string; data?: Record<string, unknown> },
  ): Promise<PushResult>
  /**
   * ISSUE #39 (2026-05-23) — per-user fan-out. Mirror of `pushAll` that
   * reads `store.listByUser(project_slug, user_id)` instead of
   * `listByOwner(...)`, so an owner with multiple users (group projects
   * per master-plan §5.1) only sees pushes for their own device tokens.
   * The wow-moment emitter routes through here when a user_id is
   * threaded from the engine; instance-wide announcements (no per-user
   * identity) keep using `pushAll`.
   */
  pushUser(
    project_slug: string,
    user_id: string,
    message: { title?: string; body: string; data?: Record<string, unknown> },
  ): Promise<PushResult>
  /**
   * P5.6 — `ReminderFiredHook` adapter. Wired into
   * `ReminderTickLoop.on_fired` via the composition's `push_dispatcher`
   * slot. Delegates to `pushReminder` and discards the result so the
   * tick loop's failure-safe wrapper sees a `Promise<void>`.
   */
  onFired(reminder: Reminder): Promise<void>
}

export interface PushResult {
  /** Tokens that were attempted (post web-filter). */
  attempted: number
  /** Tickets that came back `ok`. */
  delivered: number
  /** Tickets that came back `error`. */
  errored: number
  /**
   * True iff the dispatch completed without an HTTP-level / network
   * exception. Partial per-ticket errors leave this `true` (the
   * gateway still received the tickets); only thrown failures (Expo
   * 5xx, DNS, fetch reject) set it to `false`.
   */
  ok: boolean
  /**
   * When the network/HTTP call failed, the wrapped reason. `null`
   * when the call succeeded.
   */
  error: { name: string; message: string } | null
}

const DEFAULT_REMINDER_TITLE = 'Reminder'

export function createPushDispatcher(opts: PushDispatcherOptions): PushDispatcher {
  const reminderTitle = opts.reminder_title ?? DEFAULT_REMINDER_TITLE
  const logger: PushDispatcherLogger = opts.logger ?? {
    warn(message, meta) {
      moduleLog.warn(message, coerceLogFields(meta))
    },
  }

  async function dispatch(
    project_slug: string,
    messages: ExpoPushMessage[],
  ): Promise<PushResult> {
    if (messages.length === 0) {
      return { attempted: 0, delivered: 0, errored: 0, ok: true, error: null }
    }
    try {
      const result = await opts.client.send(messages)
      const errored = result.tickets.filter((t) => t.status === 'error')
      if (errored.length > 0) {
        for (const ticket of errored) {
          logger.warn('expo push ticket error', {
            project_slug,
            error: ticket.details?.error ?? ticket.message ?? 'unknown',
          })
        }
      }
      return {
        attempted: messages.length,
        delivered: messages.length - errored.length,
        errored: errored.length,
        ok: true,
        error: null,
      }
    } catch (err) {
      // ExpoPushError (non-200 HTTP) and any other throw (DNS, network)
      // are downgraded to a warning + non-ok PushResult so the
      // reminder tick loop is never blocked by an unreachable Expo.
      const name = err instanceof Error ? err.name : 'UnknownError'
      const message = err instanceof Error ? err.message : String(err)
      const status = err instanceof ExpoPushError ? err.status : undefined
      logger.warn('expo push send failed', {
        project_slug,
        name,
        message,
        ...(status !== undefined ? { status } : {}),
      })
      return {
        attempted: messages.length,
        delivered: 0,
        errored: messages.length,
        ok: false,
        error: { name, message },
      }
    }
  }

  async function pushReminder(reminder: Reminder): Promise<PushResult> {
    const tokens = opts.store.listByOwner(reminder.project_slug)
    const messages: ExpoPushMessage[] = tokens.map((t) => ({
      to: t.device_token,
      title: reminderTitle,
      body: reminder.message,
      sound: 'default',
      data: {
        kind: 'reminder',
        reminder_id: reminder.id,
        project_slug: reminder.project_slug,
        ...(reminder.topic_id !== null ? { topic_id: reminder.topic_id } : {}),
      },
    }))
    return await dispatch(reminder.project_slug, messages)
  }
  return {
    pushReminder,
    async pushAll(project_slug, message) {
      const tokens = opts.store.listByOwner(project_slug)
      const messages: ExpoPushMessage[] = tokens.map((t) => ({
        to: t.device_token,
        title: message.title ?? '',
        body: message.body,
        sound: 'default',
        ...(message.data !== undefined ? { data: message.data } : {}),
      }))
      return await dispatch(project_slug, messages)
    },
    async pushUser(project_slug, user_id, message) {
      // ISSUE #39 (2026-05-23) — per-user fan-out via the existing
      // `listByUser` index path on the store; `pushAll`'s instance-wide
      // read is preserved for instance-level announcements (no per-user
      // identity in scope). Dispatch + chunking + ticket-error logging
      // are shared with `pushAll` via the common `dispatch` helper, so
      // the two paths cannot drift on ExpoPushError handling.
      const tokens = opts.store.listByUser(project_slug, user_id)
      const messages: ExpoPushMessage[] = tokens.map((t) => ({
        to: t.device_token,
        title: message.title ?? '',
        body: message.body,
        sound: 'default',
        ...(message.data !== undefined ? { data: message.data } : {}),
      }))
      return await dispatch(project_slug, messages)
    },
    async onFired(reminder) {
      await pushReminder(reminder)
    },
  }
}
