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
 * ── 2026-08-09 — THE NOTIFICATION IS NOT HERE, deliberately. The owner's phone
 * said `ritual:kaizen`, and the first fix for that composed the native
 * notification in this file, from the delivered body. It cured the reported
 * message and left the morning brief, the idle nudge and the overnight report
 * silent, because they post through `deliver` on a DIFFERENT sink. So the
 * notification moved down into `deliver` itself, which is the one thing all four
 * producers share (`gateway/http/deliver.ts` — "the native notification is a
 * fourth thing deliver owns"). Nothing about a fired reminder's notification is
 * special, so nothing about it is written here.
 */

import type { Deliver } from '../http/deliver.ts'
import type { ReminderOutbound, ReminderOutboundInput } from '@neutronai/reminders/dispatcher.ts'

export interface BuildButtonStoreReminderOutboundInput {
  /** The ONE out-of-turn delivery seam (durable-row-first + best-effort push). */
  deliver: Deliver
}

/**
 * Build a `ReminderOutbound` that persists each fired reminder as a chat
 * history row and best-effort live-pushes it, via the shared {@link Deliver}
 * seam. `post` returns true when the durable record was written (the guarantee);
 * a live-push failure never costs it.
 */
export function buildButtonStoreReminderOutbound(
  input: BuildButtonStoreReminderOutboundInput,
): ReminderOutbound {
  return {
    async post(msg: ReminderOutboundInput): Promise<boolean> {
      const result = await input.deliver(msg.topic_id, { body: msg.body, durability: 'reply' })
      return result.persisted
    },
  }
}
