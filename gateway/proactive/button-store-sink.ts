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
 *   • DURABLE — persist an INERT (already-resolved) agent history turn via
 *     `ButtonStore.persistInertAgentTurn` so the brief/nudge survives in chat
 *     history and re-appears on the next hydration / reconnect, even with no
 *     socket open at post time. It is NOT an unresolved zero-option prompt (the
 *     `emit` path): a passive scheduled statement must not become the topic's
 *     active prompt that the next user message attaches to — exactly what
 *     `persistInertAgentTurn` exists to avoid (same primitive the wow-moment
 *     passive posts use).
 *   • LIVE — best-effort push the `agent_message` envelope through the supplied
 *     `WebChatSenderRegistry` so an open client paints it immediately. A
 *     missing / stale sender is swallowed — the durable row is the guarantee.
 *
 * This mirrors the fired-reminder outbound exactly (same registry, same web
 * topic), so the proactive brief has delivery PARITY with reminders. The live
 * push reaches the web (`web:`) chat registry; the durable row is what the Expo
 * app-ws (`app:`) client picks up on its next history hydration. Full live
 * parity across both client namespaces is a platform-wide concern shared with
 * reminders, not specific to this sink.
 *
 * Persist-before-send: a live-push failure never costs the durable record.
 */

import type { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'
import type { WebChatSenderRegistry } from '../http/chat-sender-registry.ts'
import type { OutboundSink, OutgoingMessage } from './sink.ts'

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
        // INERT, already-resolved agent turn — pure history, never an active
        // unresolved prompt the next user message would attach to.
        const persisted = await input.buttonStore.persistInertAgentTurn({ topic_id, body })
        prompt_id = persisted.prompt_id
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
