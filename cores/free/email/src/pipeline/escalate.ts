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
  envelope: { body: string; durability: 'reply' },
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
  email: Pick<EmailRow, 'id' | 'sender' | 'subject'> & { reason: string },
  deps: EscalateDeps,
): Promise<EscalateResult> {
  const text = composeEscalationText({
    sender: email.sender,
    subject: email.subject,
    reason: email.reason,
  })

  let delivered = false
  try {
    await deps.deliver(deps.topic_id, { body: text, durability: 'reply' })
    deps.store.markEscalated(email.id, deps.now())
    delivered = true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.store.recordEscalationFailure(email.id, msg, deps.now())
    deps.log?.('email escalation chat delivery failed', { email_id: email.id, error: msg })
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
