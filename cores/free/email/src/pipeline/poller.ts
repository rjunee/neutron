/**
 * @neutronai/email-managed-core — the poll TICK body.
 *
 * One tick: resume failed escalations, then list new INBOX mail, classify it,
 * and act. Everything it needs arrives through `deps` — no clock, no registry,
 * no gateway import; the cron wrapper lives in
 * `gateway/cores/email-pipeline-wiring.ts`.
 *
 * ── THREE INVARIANTS ─────────────────────────────────────────────────────────
 * 1. THE GO-LIVE CUTOFF. The first tick stamps `go_live_after`. Mail that
 *    predates it is archived and recorded with `category NULL` — the
 *    classifier is NEVER invoked on it. Without this, turning the pipeline on
 *    would escalate a decade of backlog into the owner's chat in one tick.
 * 2. THE ROW IS THE IDEMPOTENCY SPINE. An ESCALATED message deliberately stays
 *    in INBOX (the owner still has to deal with it), so the label set cannot
 *    say "handled". `store.hasEmail(id)` is what stops the next tick
 *    reprocessing it, and `escalated_at` is what stops it re-posting.
 * 3. ONE BAD MESSAGE NEVER KILLS THE TICK. Per-message failures are caught,
 *    counted and logged; the tick keeps going and reports `errors`.
 */

import { DEFAULT_LABEL, PROCESSED_LABEL_NAME } from '../contract.ts'
import type { GmailClient, GmailMessageMeta } from '../contract.ts'
import { classifyEmail, type ClassifyDeps, type Classification } from './classify.ts'
import { escalateEmail, type EscalateDeps } from './escalate.ts'
import type { EmailPipelineStore } from './store.ts'

export const CHECKPOINT_GO_LIVE_AFTER = 'go_live_after'
export const CHECKPOINT_LAST_POLL_AT = 'last_poll_at'
export const CHECKPOINT_CONSECUTIVE_ERRORS = 'consecutive_errors'

/** How much body text is persisted per message. */
export const STORED_BODY_LIMIT = 4000

export const DEFAULT_MAX_RESULTS = 25
export const DEFAULT_MAX_ESCALATION_ATTEMPTS = 5

export type PipelineLog = (message: string, meta?: Record<string, unknown>) => void

export interface EmailPipelineTickDeps {
  gmail: GmailClient
  store: EmailPipelineStore
  /** Everything `classifyEmail` needs except `rules`, which are re-read from
   *  the store each tick so a rule added at runtime takes effect next poll. */
  classify: Omit<ClassifyDeps, 'rules'>
  /** Everything `escalateEmail` needs except `store` / `now`, supplied here. */
  escalate: Omit<EscalateDeps, 'store' | 'now'>
  now: () => number
  log?: PipelineLog
  max_results?: number
  max_escalation_attempts?: number
}

export interface EmailPipelineTickResult {
  scanned: number
  escalated: number
  archived: number
  precutoff: number
  resumed: number
  errors: number
}

export async function runEmailPipelineTick(
  deps: EmailPipelineTickDeps,
): Promise<EmailPipelineTickResult> {
  const { store, gmail } = deps
  const now = deps.now
  const log = deps.log
  const max_results = deps.max_results ?? DEFAULT_MAX_RESULTS
  const max_attempts = deps.max_escalation_attempts ?? DEFAULT_MAX_ESCALATION_ATTEMPTS
  const result: EmailPipelineTickResult = {
    scanned: 0,
    escalated: 0,
    archived: 0,
    precutoff: 0,
    resumed: 0,
    errors: 0,
  }

  const escalateDeps: EscalateDeps = { ...deps.escalate, store, now }

  try {
    // (1) The go-live cutoff. Absent ⇒ this is the first tick ever; everything
    // already in the mailbox is backlog and is archived unclassified.
    const stamped = store.getCheckpoint(CHECKPOINT_GO_LIVE_AFTER)
    let go_live_after: number
    if (stamped === null) {
      go_live_after = now()
      store.setCheckpoint(CHECKPOINT_GO_LIVE_AFTER, String(go_live_after))
      log?.('email pipeline go-live checkpoint stamped', { go_live_after })
    } else {
      go_live_after = Number(stamped)
    }

    // (2) RESUME — escalations whose chat delivery failed on an earlier tick.
    // The query's `escalated_at IS NULL` is itself the dedup guard.
    for (const pending of store.listPendingEscalations(max_attempts)) {
      try {
        const outcome = await escalateEmail(
          {
            id: pending.id,
            sender: pending.sender,
            subject: pending.subject,
            // The classifier's prose reason is not a column (the schema keeps
            // the verdict, not its wording), so a resume quotes the category
            // — the part of the verdict that survives a restart.
            reason: pending.category ?? 'important',
          },
          escalateDeps,
        )
        if (outcome.delivered) result.resumed++
      } catch (err) {
        result.errors++
        log?.('email pipeline resume failed', {
          email_id: pending.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // (3) POLL. Merged across accounts by the fan-out client; every row is
    // stamped with the account it was read from.
    const listed = await gmail.listMessages({ label: DEFAULT_LABEL, max_results })
    const rules = store.listSenderRules()
    const classifyDeps: ClassifyDeps = { ...deps.classify, rules }
    /** Processed-label id PER ACCOUNT, cached for the tick. */
    const processedLabels = new Map<string, string>()

    async function processedLabelId(account_id: string | undefined): Promise<string> {
      const key = account_id ?? ''
      const cached = processedLabels.get(key)
      if (cached !== undefined) return cached
      const ensured = await gmail.ensureLabel({
        name: PROCESSED_LABEL_NAME,
        ...(account_id !== undefined ? { account_id } : {}),
      })
      processedLabels.set(key, ensured.label_id)
      return ensured.label_id
    }

    async function handleMessage(meta: GmailMessageMeta): Promise<void> {
      const received_at = Date.parse(meta.internal_date)
      const label_id = await processedLabelId(meta.account_id)
      const account_id = meta.account_id ?? null

      // PRE-CUTOFF: archive + label, record with category NULL. The classifier
      // is never invoked, so no backlog message can ever escalate.
      if (!Number.isNaN(received_at) && received_at < go_live_after) {
        await gmail.modifyMessage({
          message_id: meta.id,
          add_label_ids: [label_id],
          remove_label_ids: [DEFAULT_LABEL],
          ...(meta.account_id !== undefined ? { account_id: meta.account_id } : {}),
        })
        store.insertEmail({
          id: meta.id,
          thread_id: meta.thread_id,
          account_id,
          sender: meta.from,
          subject: meta.subject,
          snippet: meta.snippet,
          body_text: null,
          received_at: Number.isNaN(received_at) ? now() : received_at,
          processed_at: now(),
          category: null,
          handling: 'archive',
        })
        result.precutoff++
        return
      }

      // POST-CUTOFF: read the body, classify, act.
      const full = await gmail.getMessage({ message_id: meta.id })
      const body_text = full.body_text.slice(0, STORED_BODY_LIMIT)
      const verdict: Classification = await classifyEmail(
        {
          sender: meta.from,
          subject: meta.subject,
          snippet: meta.snippet,
          body_text: full.body_text,
          label_ids: meta.label_ids,
        },
        classifyDeps,
      )

      if (verdict.important) {
        // KEEP INBOX — an escalated message is one the owner still has to
        // handle in their mail client. Only the processed label is added.
        await gmail.modifyMessage({
          message_id: meta.id,
          add_label_ids: [label_id],
          ...(meta.account_id !== undefined ? { account_id: meta.account_id } : {}),
        })
        store.insertEmail({
          id: meta.id,
          thread_id: meta.thread_id,
          account_id,
          sender: meta.from,
          subject: meta.subject,
          snippet: meta.snippet,
          body_text,
          received_at: Number.isNaN(received_at) ? now() : received_at,
          processed_at: now(),
          category: verdict.category,
          handling: 'escalate',
        })
        const outcome = await escalateEmail(
          { id: meta.id, sender: meta.from, subject: meta.subject, reason: verdict.reason },
          escalateDeps,
        )
        if (outcome.delivered) result.escalated++
        return
      }

      // NOT IMPORTANT: archive + label. No chat post, no push — the row's
      // existence is what queues it for the P2 brief.
      await gmail.modifyMessage({
        message_id: meta.id,
        add_label_ids: [label_id],
        remove_label_ids: [DEFAULT_LABEL],
        ...(meta.account_id !== undefined ? { account_id: meta.account_id } : {}),
      })
      store.insertEmail({
        id: meta.id,
        thread_id: meta.thread_id,
        account_id,
        sender: meta.from,
        subject: meta.subject,
        snippet: meta.snippet,
        body_text,
        received_at: Number.isNaN(received_at) ? now() : received_at,
        processed_at: now(),
        category: verdict.category,
        handling: 'archive',
      })
      result.archived++
    }

    for (const meta of listed.results) {
      if (store.hasEmail(meta.id)) continue
      result.scanned++
      try {
        await handleMessage(meta)
      } catch (err) {
        result.errors++
        log?.('email pipeline message failed', {
          email_id: meta.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // (4) Checkpoints. A clean tick clears the failure streak.
    store.setCheckpoint(CHECKPOINT_LAST_POLL_AT, String(now()))
    store.setCheckpoint(CHECKPOINT_CONSECUTIVE_ERRORS, '0')
    return result
  } catch (err) {
    // A TICK-level failure (the list call itself, the store) — count the
    // streak and rethrow so the cron handler records an 'error' status.
    const prior = Number(store.getCheckpoint(CHECKPOINT_CONSECUTIVE_ERRORS) ?? '0')
    store.setCheckpoint(
      CHECKPOINT_CONSECUTIVE_ERRORS,
      String(Number.isNaN(prior) ? 1 : prior + 1),
    )
    throw err
  }
}
