/**
 * @neutronai/channels — Telegram callback-query router.
 *
 * Per docs/plans/P2-onboarding.md § 4.4 (Telegram render shim) + § 4.3
 * (channel-agnostic ButtonRouter). The webhook server (`webhook-server.ts`)
 * decodes a Telegram update into a normalized event for text messages.
 * Inline-keyboard taps come back as `update.callback_query` — those don't
 * fit the existing `IncomingEvent` shape (no `body.text`); this module
 * is the dedicated seam.
 *
 * Forge S1 wires the seam but does NOT modify `webhook-server.ts` —
 * upstream of this module, the webhook handler still ignores callback
 * queries (returns 200 OK without dispatch). S2's interview engine will
 * pull this router into the gateway boot path.
 *
 * The router does three things:
 *   1. parse `callback_data` (`btn:<22b64>:<value>`) via
 *      `parseTelegramCallbackData`.
 *   2. dispatch to the channel-agnostic `ButtonRouter.routeChoice`.
 *   3. answer the Telegram `callback_query` with a tooltip-style status
 *      so the loading-spinner clears on the user's device.
 */

import {
  parseTelegramCallbackData,
  type ButtonRouter,
  type RouteChoiceResult,
} from '../../button-routing.ts'
import type { TelegramClient } from './client.ts'

export interface TelegramCallbackQueryPayload {
  /** Telegram callback_query.id — required for answerCallbackQuery. */
  id: string
  /** Raw callback_data field; parsed by this module. */
  data: string
  /** from.id — used as `speaker_user_id`. */
  from_user_id: string
  /** Wall-clock ms when the gateway observed the callback. */
  observed_at?: number
}

export interface TelegramCallbackRouterDeps {
  /** Channel-agnostic router (DefaultButtonRouter). */
  buttonRouter: ButtonRouter
  /** Telegram client used for `answerCallbackQuery`. */
  telegram: Pick<TelegramClient, 'answerCallbackQuery'>
  /** Optional logger; defaults to console.warn for malformed callbacks. */
  logger?: { warn: (msg: string, meta?: unknown) => void }
}

export interface TelegramCallbackHandlerResult {
  /** True when the callback was dispatched to a known prompt. */
  delivered: boolean
  /** True on first delivery; false on a duplicate Telegram retry. */
  was_new: boolean
  /** Reason when not delivered — surfaced for observability. */
  reason?:
    | 'malformed_callback_data'
    | 'unknown_prompt'
    | 'value_did_not_match_options'
}

/** Build the dispatcher. Returned function is what the gateway-side webhook
 *  hook calls when `update.callback_query` is set. */
export function buildTelegramCallbackHandler(
  deps: TelegramCallbackRouterDeps,
): (cb: TelegramCallbackQueryPayload) => Promise<TelegramCallbackHandlerResult> {
  const log = deps.logger ?? { warn: (msg: string, meta?: unknown) => console.warn(msg, meta) }
  return async (cb) => {
    const parsed = parseTelegramCallbackData(cb.data)
    if (parsed === null) {
      log.warn('telegram callback_query: malformed callback_data', { data: cb.data })
      await safeAnswer(deps.telegram, cb.id, 'expired or invalid; reply freeform if needed')
      return { delivered: false, was_new: false, reason: 'malformed_callback_data' }
    }

    let result: RouteChoiceResult
    try {
      result = await deps.buttonRouter.routeChoice({
        prompt_id: parsed.prompt_id,
        raw_value: parsed.value,
        speaker_user_id: cb.from_user_id,
        channel_kind: 'telegram',
        ...(cb.observed_at !== undefined ? { chosen_at: cb.observed_at } : {}),
      })
    } catch (err) {
      // routeChoice itself never throws on unknown prompts (returns
      // delivered:false); a throw here means a real DB / store-side
      // failure. Surface the answerCallbackQuery anyway so the user's
      // loading spinner clears, then rethrow for the webhook to log.
      await safeAnswer(deps.telegram, cb.id, 'something went wrong — try again')
      throw err
    }

    if (!result.delivered) {
      const reason: TelegramCallbackHandlerResult['reason'] =
        result.prompt === undefined ? 'unknown_prompt' : 'value_did_not_match_options'
      await safeAnswer(
        deps.telegram,
        cb.id,
        result.prompt === undefined
          ? 'this prompt expired — type your answer freeform'
          : 'that option is no longer available',
      )
      return { delivered: false, was_new: false, reason }
    }

    await safeAnswer(deps.telegram, cb.id, '')
    return { delivered: true, was_new: result.was_new }
  }
}

async function safeAnswer(
  telegram: Pick<TelegramClient, 'answerCallbackQuery'>,
  callback_query_id: string,
  text: string,
): Promise<void> {
  try {
    await telegram.answerCallbackQuery(text.length > 0 ? { callback_query_id, text } : { callback_query_id })
  } catch (err) {
    // best-effort — if Telegram ack fails the user's spinner will time out
    // on its own. The agent-side advance has already landed.
    console.warn('telegram answerCallbackQuery failed', err)
  }
}
