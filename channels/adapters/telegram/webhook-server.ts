/**
 * @neutronai/channels — Telegram per-bot webhook server.
 *
 * Bot API 9.6 supports `secret_token` header — verified on every incoming
 * update so a Telegram-spoof attacker can't forge updates against our endpoint.
 *
 * This module exposes a request handler that the gateway's Bun.serve
 * mounts under the per-instance subdomain. The handler decodes the JSON
 * envelope, normalises into `IncomingEvent`, and posts to the configured
 * `IncomingEventReceiver`.
 *
 * Allowed Telegram webhook ports per Bot API: 443/80/88/8443. We serve
 * over Caddy on 443; the upstream `secret_token` check is the only
 * application-layer auth.
 */

import { timingSafeEqual } from 'node:crypto'
import { createLogger } from '@neutronai/logger'
import type { IncomingEvent, IncomingEventReceiver } from '../../types.ts'
import type { SelfEchoFilter } from './sync-message-filter.ts'
import { hashText } from './sync-message-filter.ts'

const log = createLogger('telegram-webhook')

interface TelegramFrom {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
}

interface TelegramMessage {
  message_id: number
  from?: TelegramFrom
  chat: TelegramChat
  date: number
  text?: string
  /** Bot API 9.6 — set inside a forum supergroup. */
  message_thread_id?: number
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  callback_query?: {
    id: string
    from: TelegramFrom
    message?: TelegramMessage
    data?: string
  }
}

export interface WebhookHandlerOptions {
  /**
   * The bot's own user id. Used in concert with the SelfEchoFilter to drop
   * self-echoed updates that some proxies bounce back. Required.
   */
  bot_user_id: number
  /** Per-instance secret token registered with setWebhook. Required. */
  secret_token: string
  receiver: IncomingEventReceiver
  /** Optional self-echo filter; recommended in production. */
  self_echo_filter?: SelfEchoFilter
  /**
   * Optional inline-keyboard callback handler — set by the gateway boot
   * when the channel-agnostic ButtonRouter is wired. When absent (P1
   * default), `update.callback_query` is decoded but dropped at the
   * webhook with a 200 OK so Telegram doesn't retry. P2 S1 lands the
   * `buildTelegramCallbackHandler` factory in
   * `channels/adapters/telegram/callback-router.ts`; the gateway boot
   * passes its result here.
   */
  on_callback_query?: TelegramCallbackQueryHandler
  /**
   * Optional `/start <payload>` bot-command handler — set by the gateway
   * boot when the signup correlator store is wired. When absent (or when
   * the inbound `/start` carries no payload), the message falls through
   * to `decodeUpdate` so a freeform `/start` text still surfaces as a
   * normal user message. The `signup/telegram-start-handler.ts:
   * buildTelegramStartHandler` factory composes the production handler
   * (consume correlator → validate JWT → dispatch onboarding bootstrap).
   */
  on_start_command?: TelegramStartCommandHandler
  /**
   * Optional `/start bind_<token>` bot-command handler — set by the
   * gateway boot when `NEUTRON_TELEGRAM_BIND_SECRET` is wired (ISSUES #65,
   * 2026-05-29). When absent, `/start bind_<x>` payloads fall through to
   * `on_start_command` (which only matches `onboard_` prefixes; non-onboard
   * payloads then fall through to `decodeUpdate`).
   *
   * The webhook dispatches `bind_` BEFORE `onboard_` so the bind handler
   * sees its own deeplinks first. Both prefixes are mutually exclusive by
   * construction (the engine emits exactly one URL shape per [B] tap).
   *
   * Production handler composes from `signup/telegram-bind-handler.ts:
   * buildTelegramBindHandler`.
   */
  on_bind_command?: TelegramBindCommandHandler
}

/**
 * Channel-bound callback handler — receives the parsed payload from a
 * Telegram inline-keyboard tap. Errors propagate to the webhook, which
 * still returns 200 to Telegram (a 5xx would have Telegram retry the
 * callback, amplifying the failure).
 */
export interface TelegramCallbackQueryHandler {
  (cb: {
    id: string
    data: string
    from_user_id: string
    observed_at?: number
  }): Promise<unknown>
}

/**
 * Channel-bound `/start <payload>` handler — receives the parsed payload
 * from a Telegram bot-command. The `payload` is the part after the first
 * space; the canonical `onboard_<correlator>` prefix is stripped before
 * dispatch (handler sees the bare correlator). Errors are caught at the
 * webhook boundary so Telegram still gets a 200 OK and does not retry.
 */
export interface TelegramStartCommandHandler {
  (cmd: {
    payload: string
    from_user_id: string
    chat_id: string
    /** LLM-driven prompts sprint (2026-05-09) — `message.from.first_name`
     *  off the Telegram update. Forwarded to the bootstrap callback so
     *  the engine can stash it in `phase_state.tg_first_name` for the
     *  phase-spec resolver. Optional — privacy-restricted accounts
     *  may omit it. */
    first_name?: string
    observed_at?: number
  }): Promise<unknown>
}

/**
 * Channel-bound `/start bind_<token>` handler (ISSUES #65, 2026-05-29) —
 * receives the parsed payload from the final-handoff deeplink. The
 * `bind_` prefix is stripped before dispatch (handler sees the bare
 * token). Same error-swallow contract as the start handler: webhook
 * always returns 200 OK so Telegram never retries.
 *
 * Production handler is `signup/telegram-bind-handler.ts:
 * buildTelegramBindHandler` which verifies the HMAC against the shared
 * `NEUTRON_TELEGRAM_BIND_SECRET` and persists the `(chat_id, user_id)`
 * binding in `telegram_bindings`.
 */
export interface TelegramBindCommandHandler {
  (cmd: {
    /** The bare token (post-`bind_` prefix strip). */
    payload: string
    from_user_id: string
    chat_id: string
    first_name?: string
    observed_at?: number
  }): Promise<unknown>
}

/**
 * Try to dispatch `/start bind_<token>` to the supplied handler. Returns
 * true when the message was a 1:1 private-chat bind deeplink (and was
 * dispatched / log-and-swallowed), false otherwise so the caller can fall
 * through to the next dispatcher (`dispatchStartCommandIfOnboarding`) and
 * eventually `decodeUpdate`.
 *
 * Byte-equivalent shape to `dispatchStartCommandIfOnboarding` — only the
 * prefix differs. Kept as its own function (instead of a parameterised
 * helper) so the production import surface is symmetric with the existing
 * onboarding handler and the call sites read top-to-bottom.
 *
 * ISSUES #65 (2026-05-29).
 */
export async function dispatchStartCommandIfBind(
  update: TelegramUpdate,
  handler: TelegramBindCommandHandler,
): Promise<boolean> {
  const msg = update.message
  if (msg === undefined) return false
  if (msg.from === undefined) return false
  if (msg.chat.type !== 'private') return false
  if (typeof msg.text !== 'string') return false
  if (!msg.text.startsWith('/start ')) return false
  const rawPayload = msg.text.slice('/start '.length).trim()
  if (!rawPayload.startsWith('bind_')) return false
  const payload = rawPayload.slice('bind_'.length)
  try {
    const first_name =
      typeof msg.from.first_name === 'string' && msg.from.first_name.length > 0
        ? msg.from.first_name
        : undefined
    await handler({
      payload,
      from_user_id: String(msg.from.id),
      chat_id: String(msg.chat.id),
      ...(first_name !== undefined ? { first_name } : {}),
      observed_at: Date.now(),
    })
  } catch (err) {
    log.error('start_bind_command_handler_threw', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
  }
  return true
}

/**
 * Try to dispatch `/start onboard_<correlator>` to the supplied handler.
 * Returns true when the message was a 1:1 private-chat onboarding
 * deeplink (and was dispatched / log-and-swallowed), false otherwise so
 * the caller can fall through to `decodeUpdate`. Shared between the
 * webhook server and the long-poll fallback.
 */
export async function dispatchStartCommandIfOnboarding(
  update: TelegramUpdate,
  handler: TelegramStartCommandHandler,
): Promise<boolean> {
  const msg = update.message
  if (msg === undefined) return false
  if (msg.from === undefined) return false
  if (msg.chat.type !== 'private') return false
  if (typeof msg.text !== 'string') return false
  if (!msg.text.startsWith('/start ')) return false
  const rawPayload = msg.text.slice('/start '.length).trim()
  if (!rawPayload.startsWith('onboard_')) return false
  const payload = rawPayload.slice('onboard_'.length)
  try {
    const first_name =
      typeof msg.from.first_name === 'string' && msg.from.first_name.length > 0
        ? msg.from.first_name
        : undefined
    await handler({
      payload,
      from_user_id: String(msg.from.id),
      chat_id: String(msg.chat.id),
      ...(first_name !== undefined ? { first_name } : {}),
      observed_at: Date.now(),
    })
  } catch (err) {
    log.error('start_command_handler_threw', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
  }
  return true
}

/**
 * Build a minimal `(req: Request) => Promise<Response>` handler. The
 * gateway mounts this under its per-instance Bun.serve. The handler is
 * defensive: any decode error yields 200 OK + a logged warning so
 * Telegram doesn't retry a malformed update for hours.
 */
export function buildWebhookHandler(opts: WebhookHandlerOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') {
      return new Response('method not allowed', { status: 405 })
    }
    const provided = req.headers.get('x-telegram-bot-api-secret-token')
    // Constant-time compare. Length-check first because timingSafeEqual
    // throws on length mismatch (its same-length precondition); buffer
    // both sides and only call timingSafeEqual when lengths match.
    const providedBuf = Buffer.from(provided ?? '')
    const expectedBuf = Buffer.from(opts.secret_token)
    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return new Response('forbidden', { status: 403 })
    }

    let body: TelegramUpdate
    try {
      body = (await req.json()) as TelegramUpdate
    } catch (err) {
      log.warn('malformed_json', { error: err instanceof Error ? err.message : String(err) })
      return new Response('ok', { status: 200 })
    }

    // Inline-keyboard tap path (P2 S1 button primitive). Dispatch to the
    // gateway-supplied callback handler when wired; otherwise drop with a
    // 200 OK so Telegram doesn't retry. The callback handler does its own
    // best-effort answerCallbackQuery so the user's loading spinner clears.
    if (body.callback_query !== undefined && opts.on_callback_query !== undefined) {
      const cb = body.callback_query
      const data = cb.data
      // Codex r10 P2 — gate on `typeof data === 'string'` only, not
      // `data.length > 0`. The button primitive allows an option whose
      // `value` is empty (callback_data renders as `btn:<wire>:`); the
      // ButtonRouter handles malformed/empty data downstream by
      // returning delivered:false, so dropping at the boundary would
      // silently swallow a legitimate empty-value tap and leave the
      // user's spinner spinning.
      if (typeof data === 'string') {
        try {
          await opts.on_callback_query({
            id: cb.id,
            data,
            from_user_id: String(cb.from.id),
            observed_at: Date.now(),
          })
        } catch (err) {
          log.error('callback_handler_threw', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
        }
      }
      return new Response('ok', { status: 200 })
    }

    // `/start bind_<token>` bot-command path (ISSUES #65, 2026-05-29).
    // Dispatched BEFORE the onboarding handler so the bind deeplinks the
    // final-handoff prompt emits hit the bind handler first. Mutually
    // exclusive with `onboard_` by construction; the engine emits exactly
    // one URL shape per [B] tap.
    if (opts.on_bind_command !== undefined) {
      const dispatched = await dispatchStartCommandIfBind(body, opts.on_bind_command)
      if (dispatched) return new Response('ok', { status: 200 })
    }

    // `/start onboard_<correlator>` bot-command path (P2 S2 follow-up).
    // Helper dispatches only for 1:1 private-chat onboarding deeplinks;
    // every other `/start <something>` (`/start help`, group chats with
    // a pasted deeplink, freeform text) falls through to `decodeUpdate`
    // so it surfaces as a normal user message.
    if (opts.on_start_command !== undefined) {
      const dispatched = await dispatchStartCommandIfOnboarding(body, opts.on_start_command)
      if (dispatched) return new Response('ok', { status: 200 })
    }

    const event = decodeUpdate(body, opts)
    if (event === null) {
      return new Response('ok', { status: 200 })
    }

    try {
      await opts.receiver.receive(event)
    } catch (err) {
      log.error('receiver_threw', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
      // Still 200 — letting Telegram retry would amplify the failure.
    }
    return new Response('ok', { status: 200 })
  }
}

/**
 * Translate a Telegram update into a Neutron `IncomingEvent`. Returns null
 * for updates we ignore (no message, no text, self-echoes, etc.).
 *
 * Exported for tests + so the long-poll path can reuse the same decode.
 */
export function decodeUpdate(
  update: TelegramUpdate,
  opts: WebhookHandlerOptions,
): IncomingEvent | null {
  const msg = update.message ?? update.edited_message
  if (!msg || !msg.from || !msg.text) return null
  if (msg.from.is_bot && msg.from.id === opts.bot_user_id) return null
  if (opts.self_echo_filter !== undefined) {
    const channel_topic_id = renderTopicId(msg)
    if (
      opts.self_echo_filter.isSelfEcho({
        channel_topic_id,
        text_hash: hashText(msg.text),
      })
    ) {
      return null
    }
  }
  const composedName = [msg.from.first_name, msg.from.last_name]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ')
  const display_name = msg.from.username ?? (composedName.length > 0 ? composedName : String(msg.from.id))
  return {
    channel_kind: 'telegram',
    channel_topic_id: renderTopicId(msg),
    user: {
      channel_user_id: String(msg.from.id),
      display_name,
    },
    body: { text: msg.text },
    event_id: `${msg.chat.id}:${msg.message_id}`,
    received_at: Date.now(),
  }
}

/**
 * Compose the `(chat_id, message_thread_id?)` pair into a deterministic
 * channel_topic_id string. Forum-topic supergroups get `chat:thread`,
 * everything else is just `chat`.
 */
function renderTopicId(msg: TelegramMessage): string {
  return msg.message_thread_id !== undefined
    ? `${msg.chat.id}:${msg.message_thread_id}`
    : String(msg.chat.id)
}
