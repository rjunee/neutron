/**
 * @neutronai/gateway/proactive — durable web OutboundSink.
 *
 * The proactive modules (morning brief + idle-nudge sweep) post through a
 * minimal `OutboundSink` (`sink.ts`). In production on a TELEGRAM instance the
 * core `ChannelRouter` satisfies that seam directly. But Open is single-owner
 * WEB: its topics are `app_socket` (`web:<owner>[:<project>]`) and a proactive
 * post fires from a TIMER — there may be no live socket, and the live-only
 * `AppWsAdapter` would silently drop the brief/nudge.
 *
 * So Open wires THIS sink instead (the SAME durable path fired reminders use,
 * `reminders/outbound.ts`):
 *   • DURABLE — persist a `button_prompts` history row via `ButtonStore.emit`
 *     so the brief/nudge survives in chat history and re-appears on the next
 *     hydration / reconnect, even with no socket open at post time.
 *   • LIVE — best-effort push the `agent_message` envelope through the
 *     `WebChatSenderRegistry` so an open client paints it immediately. A
 *     missing / stale sender is swallowed — the durable row is the guarantee.
 *
 * Persist-before-send: a live-push failure never costs the durable record.
 */

import { randomUUID } from 'node:crypto'

import { buildButtonPrompt } from '../../channels/button-primitive.ts'
import type { ButtonStore } from '../../channels/button-store.ts'
import type { ChatOutbound } from '../../landing/server.ts'
import type { WebChatSenderRegistry } from '../http/chat-bridge.ts'
import type { OutboundSink, OutgoingMessage } from './sink.ts'

/** Brief/nudge rows are HISTORY, not pending questions — never expire them out
 *  of hydration. Ten years ≈ never (mirrors the reminder-outbound TTL). */
const HISTORY_ROW_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1_000

const LOG_TAG = '[proactive-sink]'

export interface BuildButtonStoreProactiveSinkInput {
  buttonStore: ButtonStore
  /** Optional live-push registry. Absent → durable-persist only. */
  registry?: WebChatSenderRegistry
  log?: (msg: string) => void
}

/**
 * Build an `OutboundSink` that persists each proactive post as a chat history
 * row and best-effort live-pushes it. The send target is the message's
 * `topic.channel_topic_id` (the `web:<owner>[:<project>]` key the client
 * subscribes to). Returns the durable `prompt_id` (the `OutboundSink`
 * contract's string id).
 */
export function buildButtonStoreProactiveSink(
  input: BuildButtonStoreProactiveSinkInput,
): OutboundSink {
  const log = input.log ?? ((msg: string): void => console.warn(msg))
  return {
    async send(message: OutgoingMessage): Promise<string> {
      const topic_id = message.topic.channel_topic_id
      const body = message.text
      let prompt_id: string
      try {
        const prompt = buildButtonPrompt({
          body,
          options: [],
          allow_freeform: true,
          expires_in_ms: HISTORY_ROW_TTL_MS,
          uuid: randomUUID,
        })
        const emitted = await input.buttonStore.emit(prompt, { topic_id })
        prompt_id = emitted.prompt_id
      } catch (err) {
        // Durable persist failed — surface it. The proactive modules treat a
        // throw as a delivery failure (no day/dedupe ledger write → retried).
        log(
          `${LOG_TAG} persist failed topic=${topic_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        throw err instanceof Error ? err : new Error(String(err))
      }

      // Best-effort live push — a closed/stale socket throws; swallow it. The
      // durable row already guarantees delivery on the next hydration.
      if (input.registry !== undefined) {
        const envelope: ChatOutbound = {
          type: 'agent_message',
          body,
          topic_id,
          options: [],
          allow_freeform: true,
          prompt_id,
        }
        try {
          input.registry.send(topic_id, envelope)
        } catch (err) {
          log(
            `${LOG_TAG} live push failed (durable row persisted) topic=${topic_id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
      return prompt_id
    },
  }
}
