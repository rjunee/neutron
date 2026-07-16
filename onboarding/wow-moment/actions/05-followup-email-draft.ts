/**
 * Action 5 — follow-up email draft.
 *
 * Per docs/plans/P2-onboarding.md § 2.5 #5. Fires when Pass-2 import
 * found a stalled email thread (last inbound > 14d ago, last outbound
 * from user > 30d ago, ≥ 2 inbound) AND user OAuth'd Gmail with
 * `gmail.compose` + `gmail.readonly` scope.
 *
 * **DRAFTS ONLY — NEVER sends.** This is the highest-blast-radius
 * action; the draft itself is the consent-able artifact. The agent
 * posts a button-prompt with `[A] Open draft in Gmail [B] Discard`.
 *
 * If `gmail.compose` scope is absent at fire time, surfaces "more
 * permission needed" prompt and marks the action skipped.
 *
 * Telemetry: recipient_hash = sha256(email) — never the raw address.
 */

import { createHash } from 'node:crypto'
import { buildButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import type { WowActionContext, WowActionModule, WowActionResult } from '../action-types.ts'
import type { WowEngagement } from '../telemetry.ts'

const ACTION_ID = '05-followup-email-draft' as const
const STALE_INBOUND_MS = 14 * 24 * 60 * 60 * 1000
const STALE_OUTBOUND_MS = 30 * 24 * 60 * 60 * 1000
const MIN_INBOUND_COUNT = 2

const action05: WowActionModule = {
  action_id: ACTION_ID,

  triggerCondition(ctx: WowActionContext): boolean {
    const now = ctx.now()
    return ctx.stalled_threads.some((t) => isStalled(t, now))
  },

  async run(ctx: WowActionContext): Promise<WowActionResult> {
    if (ctx.gmail === null) {
      return {
        fired: false,
        reason: 'gmail_not_wired',
      }
    }
    // Re-check scope at fire time. The interview captured the scope
    // earlier; the user may have revoked between then and now.
    if (ctx.gmail_scopes === null || !ctx.gmail_scopes.has_compose) {
      const prompt = buildButtonPrompt({
        body:
          'I would like to draft a follow-up email for you, but I need draft permission first. Grant access?',
        options: [
          { label: 'A', body: 'Grant access', value: 'grant' },
          { label: 'B', body: 'Skip', value: 'skip' },
        ],
        allow_freeform: false,
        idempotency: {
          project_slug: ctx.owner_slug,
          topic_id: ctx.topic_id,
          seed: 'wow:05:scope-needed',
        },
      })
      const { prompt_id } = await ctx.channel.emitPrompt({
        prompt,
        topic_id: ctx.topic_id,
      })
      return {
        fired: false,
        reason: 'scope_missing',
        redacted_payload: {
          missing_scope: 'gmail.compose',
        },
        follow_up_prompt_id: prompt_id,
      }
    }
    const now = ctx.now()
    const stalled = ctx.stalled_threads.filter((t) => isStalled(t, now))
    if (stalled.length === 0) {
      return { fired: false, reason: 'no_stalled_threads' }
    }
    // Pick the longest-stalled thread by last_inbound_at (oldest = most stalled).
    stalled.sort((a, b) => a.last_inbound_at - b.last_inbound_at)
    const thread = stalled[0]!
    const subject = thread.subject.startsWith('Re: ')
      ? thread.subject
      : `Re: ${thread.subject}`
    const body = composeDraftBody(thread)
    const draft = await ctx.gmail.createDraft({
      to: thread.recipient_email,
      subject,
      body,
    })
    const prompt = buildButtonPrompt({
      body: composePromptBody(thread.recipient_email, thread.subject),
      options: [
        { label: 'A', body: 'Open draft in Gmail', value: 'opened' },
        { label: 'B', body: 'Discard', value: 'discarded' },
      ],
      allow_freeform: false,
      idempotency: {
        project_slug: ctx.owner_slug,
        topic_id: ctx.topic_id,
        seed: `wow:05:${thread.thread_id}`,
      },
    })
    const { prompt_id } = await ctx.channel.emitPrompt({
      prompt,
      topic_id: ctx.topic_id,
    })
    return {
      fired: true,
      reason: 'draft_created',
      redacted_payload: {
        recipient_hash: hashEmail(thread.recipient_email),
        thread_id: thread.thread_id,
        draft_id: draft.draft_id,
        gmail_open_url: draft.gmail_open_url,
      },
      follow_up_prompt_id: prompt_id,
    }
  },

  decodeEngagement(value: string): WowEngagement | null {
    if (value === 'opened') return 'opened'
    if (value === 'discarded') return 'discarded'
    return null
  },
}

function isStalled(
  thread: { last_inbound_at: number; last_outbound_at: number; inbound_count: number },
  now: number,
): boolean {
  if (thread.inbound_count < MIN_INBOUND_COUNT) return false
  if (now - thread.last_inbound_at < STALE_INBOUND_MS) return false
  if (now - thread.last_outbound_at < STALE_OUTBOUND_MS) return false
  return true
}

function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)
}

function composeDraftBody(thread: {
  recipient_email: string
  subject: string
  one_line_preview?: string
}): string {
  // Conservative draft body: no auto-claims, no familiarity. The user
  // will edit before sending. The action's spec is explicit that this
  // is a draft, never a send.
  const lines: string[] = []
  lines.push('Hi,')
  lines.push('')
  lines.push('I wanted to circle back on this thread.')
  if (thread.one_line_preview !== undefined && thread.one_line_preview.length > 0) {
    lines.push('')
    lines.push(`(Re: ${thread.one_line_preview})`)
  }
  lines.push('')
  lines.push('Let me know what works on your end.')
  lines.push('')
  lines.push('Thanks,')
  return lines.join('\n')
}

function composePromptBody(recipient: string, subject: string): string {
  return `I drafted a follow-up to ${recipient} about "${subject}". Want to review and send from Gmail?`
}

export default action05
