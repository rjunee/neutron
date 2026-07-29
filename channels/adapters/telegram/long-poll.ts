/**
 * @neutronai/channels — Telegram long-poll fallback.
 *
 * `getUpdates` fallback used for solo dev instances (no public webhook URL)
 * + as DR fallback if the webhook fails. Production instances run the
 * webhook server in `webhook-server.ts`.
 */

import { createLogger } from '@neutronai/logger'
import type { IncomingEventReceiver } from '../../types.ts'
import type { TelegramClient } from './client.ts'
import {
  decodeUpdate,
  dispatchStartCommandIfOnboarding,
  type TelegramStartCommandHandler,
  type TelegramUpdate,
  type WebhookHandlerOptions,
} from './webhook-server.ts'

const log = createLogger('telegram-long-poll')

export interface LongPollOptions {
  /** Bot user id — same role as in WebhookHandlerOptions. */
  bot_user_id: number
  receiver: IncomingEventReceiver
  /** getUpdates `timeout` parameter (seconds). Default 25. */
  long_poll_timeout_s?: number
  /**
   * Allowed update types to subscribe to. Default ['message',
   * 'edited_message', 'callback_query']. Tightening this saves bandwidth.
   */
  allowed_updates?: string[]
  /**
   * Optional `/start onboard_<correlator>` handler (P2 S2 Argus
   * follow-up). When wired, the long-poll loop intercepts onboarding
   * deeplinks the same way the webhook handler does — so solo-dev /
   * DR-fallback deployments that use long polling stay consistent with
   * production webhook deployments. Group-chat deeplinks fall through
   * to `decodeUpdate`. When omitted, all `/start` text surfaces as a
   * normal user message.
   */
  on_start_command?: TelegramStartCommandHandler
}

/**
 * Loop runner. Runs `getUpdates` with `offset` advancement until aborted.
 * Returns when `signal` aborts; never throws on a single getUpdates failure
 * (logs + backs off so a transient Telegram blip doesn't kill the poller).
 */
export async function runLongPoll(
  client: TelegramClient,
  signal: AbortSignal,
  opts: LongPollOptions,
): Promise<void> {
  const timeout = opts.long_poll_timeout_s ?? 25
  const allowed_updates = opts.allowed_updates ?? ['message', 'edited_message', 'callback_query']
  let offset = 0
  while (!signal.aborted) {
    let updates: TelegramUpdate[] = []
    try {
      updates = await client.call<
        { offset: number; timeout: number; allowed_updates: string[] },
        TelegramUpdate[]
      >('getUpdates', { offset, timeout, allowed_updates })
    } catch (err) {
      if (signal.aborted) return
      log.warn('get_updates_failed', { error: err instanceof Error ? err.message : String(err) })
      // Brief backoff so a sustained outage doesn't tightloop.
      await sleep(2000, signal)
      continue
    }
    for (const u of updates) {
      if (u.update_id >= offset) offset = u.update_id + 1
      // `/start onboard_<correlator>` dispatch — mirrors the webhook
      // path so onboarding deeplinks resolve consistently across both
      // ingress modes.
      if (opts.on_start_command !== undefined) {
        const dispatched = await dispatchStartCommandIfOnboarding(u, opts.on_start_command)
        if (dispatched) continue
      }
      // long-poll path doesn't get the SelfEchoFilter wired automatically —
      // the gateway threads it in by passing the same WebhookHandlerOptions
      // through `runLongPoll`'s ergonomic boundary in a future revision.
      const event = decodeUpdate(u, {
        bot_user_id: opts.bot_user_id,
        secret_token: '',
        receiver: opts.receiver,
      } satisfies WebhookHandlerOptions)
      if (event === null) continue
      try {
        await opts.receiver.receive(event)
      } catch (err) {
        log.error('receiver_threw', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })
}
