/**
 * @neutronai/gateway/proactive — outbound seam.
 *
 * The proactive layer (morning brief + idle-topic nudge sweep) posts to chat
 * through the SAME minimal structural seam the trident async-delivery module
 * uses (`trident/delivery.ts` `OutboundSink`): a single `send(OutgoingMessage)`
 * method that the production `ChannelRouter` satisfies structurally. Kept
 * local (not an import of `ChannelRouter`) so the proactive modules stay free
 * of the channels runtime and are trivially faked in tests with a recording
 * sink.
 *
 * L2 (2026-07) — `OutboundSink` (independently declared here AND in
 * `trident/delivery.ts`, byte-identical shape) unified onto
 * `trident/outbound-sink.ts`; this file re-exports it so existing import
 * specifiers stay valid.
 */

import type { OutgoingMessage, Topic } from '@neutronai/channels/types.ts'
import type { OutboundSink } from '@neutronai/trident/outbound-sink.ts'

export type { OutgoingMessage, Topic, OutboundSink }

/**
 * Build a `Topic` for a proactive post from a raw `channel_topic_id`
 * (`<chat_id>[:<thread_id>]` for Telegram — the shape the webhook decoder
 * emits and the adapter parses back). The non-routing `Topic` fields carry
 * safe placeholders; the outbound send path reads only `channel_kind` +
 * `channel_topic_id`. Mirrors `trident/delivery.ts` `topicForRun`.
 */
export function proactiveTopic(
  channel_topic_id: string,
  channel_kind: Topic['channel_kind'] = 'telegram',
  project_id: string | null = null,
): Topic {
  return {
    topic_id: channel_topic_id,
    channel_kind,
    channel_topic_id,
    project_id,
    privacy_mode: 'regular',
  }
}
