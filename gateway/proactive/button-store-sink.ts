/**
 * @neutronai/gateway/proactive — durable web OutboundSink.
 *
 * The proactive modules (morning brief + idle-nudge sweep) post through a
 * minimal `OutboundSink` (`sink.ts`). In production on a TELEGRAM instance the
 * core `ChannelRouter` satisfies that seam directly. But Open is single-owner
 * WEB: its topics are `app_socket` and a proactive post fires from a TIMER —
 * there may be no live socket, and the live-only `AppWsAdapter` would silently
 * drop the brief/nudge. So Open wires THIS durable sink instead.
 *
 * F5 (2026-07) — the durable-row-first + best-effort-push mechanics (and the
 * registry pick) now live in the ONE {@link Deliver} seam
 * (`gateway/http/deliver.ts`), shared with fired reminders + the substrate
 * notice bubbles, so no producer names a registry. This sink is a thin adapter
 * from the `OutboundSink` shape onto `deliver`: it persists an INERT
 * (already-resolved) agent history turn — pure history, never the topic's active
 * prompt the next user message attaches to — then best-effort live-pushes.
 *
 * Persist-before-send: a live-push failure never costs the durable record; a
 * durable-persist failure surfaces (the proactive modules treat a throw as a
 * delivery failure → retried, no day/dedupe ledger write).
 */

import type { Deliver } from '../http/deliver.ts'
import type { OutboundSink, OutgoingMessage } from './sink.ts'

export interface BuildButtonStoreProactiveSinkInput {
  /** The ONE out-of-turn delivery seam (durable-row-first + best-effort push). */
  deliver: Deliver
}

/**
 * Build an `OutboundSink` that persists each proactive post as an inert chat
 * history row and best-effort live-pushes it, via the shared {@link Deliver}
 * seam. The send target is the message's `topic.channel_topic_id`. Returns the
 * durable `prompt_id` (the `OutboundSink` contract's string id).
 */
export function buildButtonStoreProactiveSink(
  input: BuildButtonStoreProactiveSinkInput,
): OutboundSink {
  return {
    async send(message: OutgoingMessage): Promise<string> {
      const result = await input.deliver(message.topic.channel_topic_id, {
        body: message.text,
        durability: 'inert',
      })
      // `deliver` throws when the durable persist fails (inert contract), so a
      // resolved result always carries the durable id.
      return result.prompt_id ?? ''
    },
  }
}
