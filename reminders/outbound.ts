/**
 * @neutronai/reminders — chat-surface outbound for fired reminders.
 *
 * Posts a composed reminder body into the originating chat topic exactly the
 * way the live-agent turn posts a reply (`build-live-agent-turn.ts` step 4):
 *
 *   • DURABLE — persist a `button_prompts` row via `ButtonStore.emit` so the
 *     reminder survives in chat history and re-appears on the next hydration /
 *     reconnect, even if no socket is open at fire time (a reminder fires from
 *     a timer, not a request — there may be no live client).
 *   • LIVE — best-effort push the `agent_message` envelope through the
 *     `WebChatSenderRegistry` so an open client paints it immediately. A closed
 *     socket makes `registry.send` throw; that is swallowed (the durable row is
 *     the guarantee, the live push is the nicety).
 *
 * Persist-before-send: a live-push failure never costs the durable record.
 */

import { randomUUID } from 'node:crypto'

import { buildButtonPrompt } from '../channels/button-primitive.ts'
import type { ButtonStore } from '../channels/button-store.ts'
import type { ChatOutbound } from '../landing/server.ts'
import type { WebChatSenderRegistry } from '../gateway/http/chat-bridge.ts'
import type { ReminderOutbound, ReminderOutboundInput } from './dispatcher.ts'

/** Reply rows are HISTORY, not pending questions — never expire them out of
 *  hydration. Ten years ≈ never (mirrors build-live-agent-turn's TTL). */
const REPLY_ROW_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1_000

const LOG_TAG = '[reminder-outbound]'

export interface BuildButtonStoreReminderOutboundInput {
  buttonStore: ButtonStore
  /** Optional live-push registry. Absent → durable-persist only. */
  registry?: WebChatSenderRegistry
  log?: (msg: string) => void
}

/**
 * Build a `ReminderOutbound` that persists each fired reminder as a chat
 * history row and best-effort live-pushes it to an open client.
 */
export function buildButtonStoreReminderOutbound(
  input: BuildButtonStoreReminderOutboundInput,
): ReminderOutbound {
  const log = input.log ?? ((msg: string): void => console.warn(msg))
  return {
    async post(msg: ReminderOutboundInput): Promise<boolean> {
      let prompt_id: string | null = null
      try {
        const prompt = buildButtonPrompt({
          body: msg.body,
          options: [],
          allow_freeform: true,
          expires_in_ms: REPLY_ROW_TTL_MS,
          uuid: randomUUID,
        })
        const emitted = await input.buttonStore.emit(prompt, { topic_id: msg.topic_id })
        prompt_id = emitted.prompt_id
      } catch (err) {
        // Durable persist failed — log and bail. Without a durable row there is
        // nothing to recover, and a live-only push to a topic that has no open
        // socket would silently drop the reminder.
        log(
          `${LOG_TAG} persist failed reminder=${msg.reminder_id} topic=${msg.topic_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        return false
      }

      // Best-effort live push — a closed socket throws; swallow it.
      if (input.registry !== undefined) {
        const envelope: ChatOutbound = {
          type: 'agent_message',
          body: msg.body,
          topic_id: msg.topic_id,
          options: [],
          allow_freeform: true,
          ...(prompt_id !== null ? { prompt_id } : {}),
        }
        try {
          input.registry.send(msg.topic_id, envelope)
        } catch (err) {
          log(
            `${LOG_TAG} live push failed (durable row persisted) reminder=${msg.reminder_id} topic=${msg.topic_id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
      return true
    },
  }
}
