/**
 * @neutronai/email-managed-core — the poll TICK body.
 *
 * One tick: resume failed escalations, then list new INBOX mail, classify it,
 * and act. Everything it needs arrives through `deps` — no clock, no registry,
 * no gateway import; the cron wrapper lives in
 * `gateway/cores/email-pipeline-wiring.ts`.
 *
 * ── THREE INVARIANTS ─────────────────────────────────────────────────────────
 * 1. THE BACKLOG IS MARKED ONCE, NOT RE-JUDGED FOREVER. Before the pipeline
 *    processes anything, a one-time sweep records every message already in the
 *    inbox as `handling='preexisting'` — and touches NOTHING else. No label is
 *    added, no message is archived, nothing is classified, nothing is
 *    escalated. The owner has already triaged that mail by hand; it stays
 *    exactly where they left it. Afterwards, "is this history?" is answered by
 *    `store.hasEmail(id)` — a row lookup — instead of a date comparison on
 *    every message for the rest of the install's life. Without this, turning
 *    the pipeline on would escalate a decade of backlog in one tick.
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
/** Set to '1' once every message already in the inbox has been marked handled. */
export const CHECKPOINT_BACKLOG_DONE = 'backlog_marked'
/** Gmail page cursor for an in-flight backlog sweep. */
export const CHECKPOINT_BACKLOG_CURSOR = 'backlog_cursor'

/** Messages marked per tick while the backlog sweep is running. */
export const DEFAULT_BACKLOG_PAGE_SIZE = 100

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
  /** Backlog messages marked per tick during the one-time sweep. */
  backlog_page_size?: number
}

export interface EmailPipelineTickResult {
  scanned: number
  escalated: number
  archived: number
  /** Backlog messages marked handled by the one-time sweep on this tick. */
  precutoff: number
  resumed: number
  errors: number
  /** True while the backlog sweep is still running — no mail is processed yet. */
  backlog_sweeping: boolean
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
    backlog_sweeping: false,
  }

  const escalateDeps: EscalateDeps = { ...deps.escalate, store, now }

  try {
    // (1) The go-live stamp. Recorded once for provenance (P2 reports from it);
    // it is NOT a per-message gate — see invariant 1.
    if (store.getCheckpoint(CHECKPOINT_GO_LIVE_AFTER) === null) {
      const go_live_after = now()
      store.setCheckpoint(CHECKPOINT_GO_LIVE_AFTER, String(go_live_after))
      log?.('email pipeline go-live checkpoint stamped', { go_live_after })
    }

    // (1b) THE BACKLOG SWEEP. Until every message already in the inbox is
    // recorded as `preexisting`, this tick does nothing else — no
    // classification, no escalation, no label writes. Returning early is what
    // guarantees the owner's existing mail can never reach the classifier: the
    // code path that could escalate it has not been entered yet.
    if (store.getCheckpoint(CHECKPOINT_BACKLOG_DONE) !== '1') {
      result.backlog_sweeping = true
      const cursor = store.getCheckpoint(CHECKPOINT_BACKLOG_CURSOR)
      const page = await gmail.listMessages({
        label: DEFAULT_LABEL,
        max_results: deps.backlog_page_size ?? DEFAULT_BACKLOG_PAGE_SIZE,
        ...(cursor !== null && cursor.length > 0 ? { page_token: cursor } : {}),
      })
      for (const meta of page.results) {
        if (store.hasEmail(meta.id)) continue
        const received_at = Date.parse(meta.internal_date)
        store.insertEmail({
          id: meta.id,
          thread_id: meta.thread_id,
          account_id: meta.account_id ?? null,
          sender: meta.from,
          subject: meta.subject,
          snippet: meta.snippet,
          body_text: null,
          received_at: Number.isNaN(received_at) ? now() : received_at,
          processed_at: now(),
          category: null,
          handling: 'preexisting',
        })
        result.precutoff++
      }
      const next = page.next_page_token
      if (next !== undefined && next.length > 0) {
        store.setCheckpoint(CHECKPOINT_BACKLOG_CURSOR, next)
        log?.('email pipeline backlog sweep advancing', { marked: result.precutoff })
      } else {
        store.setCheckpoint(CHECKPOINT_BACKLOG_DONE, '1')
        store.setCheckpoint(CHECKPOINT_BACKLOG_CURSOR, '')
        log?.('email pipeline backlog sweep complete', { marked: result.precutoff })
      }
      store.setCheckpoint(CHECKPOINT_LAST_POLL_AT, String(now()))
      return result
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

      // Anything reaching here is NEW: the backlog sweep has completed, and
      // `store.hasEmail` (below) has already excluded every message it marked.
      // No date comparison is involved or needed.
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
