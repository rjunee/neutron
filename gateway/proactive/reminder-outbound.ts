/**
 * @neutronai/gateway/proactive — chat-surface outbound for fired reminders.
 *
 * L3 (2026-07) — moved UP from `reminders/outbound.ts` into the gateway
 * composition band. The `reminders` service defines the `ReminderOutbound`
 * SEAM (`reminders/dispatcher.ts`); the concrete delivery IMPLEMENTATION —
 * which reaches chat — belongs at the composition root, not inside the service.
 * The composer (`open/composer.ts`) constructs this and injects it as the
 * dispatcher's `outbound`.
 *
 * F5 (2026-07) — this no longer names a registry. A fired reminder is one of
 * three TIMER/CRON producers that post OUTSIDE a request turn; all three now go
 * through the ONE {@link Deliver} seam (`gateway/http/deliver.ts`) so a producer
 * can no longer pick the wrong registry. `deliver` owns the durable-row-first +
 * best-effort-push ordering this outbound used to hand-roll: it persists a
 * resolvable `reply` history row (so the reminder survives in chat history and
 * re-appears on the next hydration / reconnect even with no socket open at fire
 * time — a reminder fires from a timer, not a request) THEN best-effort
 * live-pushes to the socket the topic grammar resolves to.
 *
 * ── 2026-08-09 — THE NATIVE NOTIFICATION IS COMPOSED HERE, and this is the
 * whole point of the change. It used to be composed in the reminder TICK, from
 * the reminder ROW, by `PushDispatcher.pushReminder` on the `on_fired` hook. The
 * row is the wrong source: for a ritual its `message` is the dispatch token
 * `ritual:<id>`, so the owner's lock screen read `ritual:kaizen`, and the payload
 * carried the OWNER slug where the tap needed a project id. Both symptoms were
 * the same mistake.
 *
 * This is the one place that knows the message that was actually posted AND the
 * durable row it became, so it is the only place a truthful notification can be
 * built. A nudge and a ritual reach it through the same `post`, so they cannot
 * produce different notifications — which is what the owner asked for: *"a ritual
 * posting is just a chat message."*
 */

import type { Deliver } from '../http/deliver.ts'
import {
  chatMessagePushScope,
  type ChatMessagePushSink,
} from '../push/chat-message-push.ts'
import type { ReminderOutbound, ReminderOutboundInput } from '@neutronai/reminders/dispatcher.ts'

export interface BuildButtonStoreReminderOutboundInput {
  /** The ONE out-of-turn delivery seam (durable-row-first + best-effort push). */
  deliver: Deliver
  /**
   * Native-notification sink for the message that just landed in chat. Absent →
   * the post is durable + live-pushed exactly as before and no device is
   * notified, which is what a box with no registered device already gets and
   * what every test that does not care about push wants.
   */
  chat_push?: ChatMessagePushSink
}

/**
 * Build a `ReminderOutbound` that persists each fired reminder as a chat
 * history row, best-effort live-pushes it, and best-effort notifies the owner's
 * devices — all via shared seams. `post` returns true when the durable record was
 * written (the guarantee); neither a live-push nor a notification failure costs it.
 */
export function buildButtonStoreReminderOutbound(
  input: BuildButtonStoreReminderOutboundInput,
): ReminderOutbound {
  return {
    async post(msg: ReminderOutboundInput): Promise<boolean> {
      const result = await input.deliver(msg.topic_id, { body: msg.body, durability: 'reply' })
      // ONLY on a durable row. `prompt_id` IS the id the tap anchors on — the
      // client carries it onto the message (`chat-core/types.ts:237`) — so a
      // notification without one could route to the project but not to the
      // message, and a notification for a post that did not persist would point
      // at a transcript that has no such row.
      if (result.persisted && result.prompt_id !== null && input.chat_push !== undefined) {
        // GUARDED HERE TOO, not only inside the sink, and the duplicate is
        // deliberate. `post`'s return value decides whether the tick keeps its
        // claim on the reminder row: a throw out of this line would be read as
        // "the post did not happen" (`reminders/tick.ts` #319), the claim would be
        // reverted, and the SAME message would be posted again on the next tick.
        // A failed notification must never be able to double-post a reminder.
        try {
          await input.chat_push({
            ...chatMessagePushScope(msg.topic_id),
            message_id: result.prompt_id,
            body: msg.body,
          })
        } catch {
          // The chat row is the guarantee; the sink logs its own failures.
        }
      }
      return result.persisted
    },
  }
}
