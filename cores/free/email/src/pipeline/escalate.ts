/**
 * @neutronai/email-managed-core — the important-email ESCALATION.
 *
 * ── CHAT IS THE GUARANTEED SURFACE ────────────────────────────────────────────
 * The escalation is `deliver(topic_id, envelope)` with `durability: 'reply'` —
 * the one out-of-turn chat seam (`gateway/http/deliver.ts`), durable-row-first,
 * targeted at the owner's BARE app topic. `durability: 'reply'` is the fired-
 * reminder shape: a row the owner can answer in chat.
 *
 * Mobile push is fired ALONGSIDE, never instead. Its outcome NEVER touches
 * `escalated_at`: treating a push as delivery is how an escalation gets marked
 * done on a box with zero registered devices. It has its own try/catch so its
 * failure cannot affect the chat post either.
 *
 * ── DEDUP ─────────────────────────────────────────────────────────────────────
 * `emails.escalated_at` is the guard, on the same row as the message. Only a
 * SUCCESSFUL deliver sets it; a failure increments `escalation_attempts` and
 * records `last_error`, leaving the row for the next tick's resume step.
 */

import type { EmailPipelineStore, EmailRow } from './store.ts'

/** Structural mirror of `gateway/http/deliver.ts`'s `Deliver` — this Core does
 *  not import the gateway. */
export type EscalationDeliver = (
  topic_id: string,
  envelope: { body: string; durability: 'reply'; idempotency_key?: string },
) => Promise<unknown>

/** Structural mirror of `PushDispatcher.pushAll`. */
export interface EscalationPush {
  pushAll(
    project_slug: string,
    message: { title?: string; body: string },
  ): Promise<unknown>
}

/** The push notification title. Kept generic — no message content in the title. */
export const ESCALATION_PUSH_TITLE = 'Important email'

export interface EscalationSubject {
  sender: string
  subject: string
  reason: string
}

/**
 * The escalation text. It MUST name the sender, the subject and the importance
 * reason — an escalation that fires but says nothing is worse than silence,
 * because the owner now has to go find out what it was about.
 */
export function composeEscalationText(e: EscalationSubject): string {
  return `Important email from ${e.sender}: "${e.subject}" — ${e.reason}.`
}

export interface EscalateDeps {
  deliver: EscalationDeliver
  topic_id: string
  push: EscalationPush | null
  project_slug: string
  store: EmailPipelineStore
  now: () => number
  log?: (message: string, meta?: Record<string, unknown>) => void
}

export interface EscalateResult {
  delivered: boolean
  text: string
}

export async function escalateEmail(
  email: Pick<EmailRow, 'id' | 'sender' | 'subject'> & { reason: string; account_id?: string | null },
  deps: EscalateDeps,
): Promise<EscalateResult> {
  const text = composeEscalationText({
    sender: email.sender,
    subject: email.subject,
    reason: email.reason,
  })

  // TWO FAILURES, NOT ONE. Delivering to chat and recording that we delivered
  // are separate acts that fail separately, and collapsing them into a single
  // try meant a throw from `markEscalated` — the LOCAL write, after the owner
  // had already been told — was recorded as a DELIVERY failure. The row stayed
  // eligible and the next tick posted the same escalation again.
  //
  // So: the deliver call gets its own try, and the acknowledgement gets
  // another. And because a durable post that we failed to record is exactly
  // the case that re-fires, every post carries a deterministic
  // `idempotency_key` — the seam collapses a re-emit of the same key rather
  // than writing a second row (`gateway/http/deliver.ts`). Belt and braces:
  // the key makes the retry harmless, the split makes it rare.
  const account = email.account_id ?? null
  const idempotency_key = `email-escalation:${account ?? ''}:${email.id}`

  let delivered = false
  try {
    await deps.deliver(deps.topic_id, { body: text, durability: 'reply', idempotency_key })
    delivered = true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.store.recordEscalationFailure(email.id, msg, deps.now(), account)
    deps.log?.('email escalation chat delivery failed', { email_id: email.id, error: msg })
  }

  if (delivered) {
    try {
      deps.store.markEscalated(email.id, deps.now(), account)
    } catch (err) {
      // The owner HAS been told; only our note of it failed. Never counted as
      // a delivery failure — the retry is guarded by the idempotency key.
      const msg = err instanceof Error ? err.message : String(err)
      deps.log?.('email escalation delivered but the acknowledgement write failed', {
        email_id: email.id,
        error: msg,
      })
    }
  }

  // Best-effort, ALONGSIDE. Fired regardless of the chat outcome (the owner's
  // phone is often the faster surface), and its result is never delivery.
  if (deps.push !== null) {
    const push = deps.push
    try {
      await push.pushAll(deps.project_slug, { title: ESCALATION_PUSH_TITLE, body: text })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log?.('email escalation push failed (chat is unaffected)', {
        email_id: email.id,
        error: msg,
      })
    }
  }

  return { delivered, text }
}
