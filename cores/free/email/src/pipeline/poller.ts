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
 *
 * ── WHY SEEN, TOLD AND MUTATED ARE THREE SEPARATE FACTS ──────────────────────
 * The row is written BEFORE anything is sent or mutated, so nothing can happen
 * to a message without a durable record of it. The cost is that the row's
 * existence proves only that the message was SEEN — so it cannot also be the
 * test for "finished". Each remaining step therefore carries its own durable
 * mark, and each has its own resume pass:
 *
 *   escalated_at IS NULL  → the owner has not been told  → pass (2)
 *   mutated_at   IS NULL  → Gmail has not been written   → pass (2b)
 *
 * Collapsing either into `hasEmail` is how a failure becomes permanent: the
 * message is skipped forever, and the step that was owed is silently dropped.
 * The order within a message is escalate-THEN-mutate for the same reason —
 * telling the owner is the point, labelling is bookkeeping, and bookkeeping
 * must never gate delivery.
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
/** Gmail page cursor for an in-flight backlog sweep (single-account path). */
export const CHECKPOINT_BACKLOG_CURSOR = 'backlog_cursor'
/** JSON `account_id -> cursor` map for a multi-account backlog sweep. */
export const CHECKPOINT_BACKLOG_CURSORS = 'backlog_cursors'

/** Messages marked per tick while the backlog sweep is running. */
export const DEFAULT_BACKLOG_PAGE_SIZE = 100

/** How much body text is persisted per message. */
export const STORED_BODY_LIMIT = 4000

export const DEFAULT_MAX_RESULTS = 25
export const DEFAULT_MAX_ESCALATION_ATTEMPTS = 5
/**
 * How many list pages ONE steady-state tick may walk looking for unhandled
 * mail. Escalated messages retain INBOX, so the handled set at the top of the
 * inbox grows; without a walk the poll starves behind it, and without a bound
 * a tick could page an entire mailbox. 20 pages x 25 = 500 retained messages
 * before a tick reports it ran out of budget.
 */
export const DEFAULT_MAX_POLL_PAGES = 20

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
  /** List pages one steady-state tick may walk before giving up for now. */
  max_poll_pages?: number
}

export interface EmailPipelineTickResult {
  scanned: number
  escalated: number
  archived: number
  /** Backlog messages marked handled by the one-time sweep on this tick. */
  precutoff: number
  resumed: number
  /** Gmail label/archive writes that failed earlier and succeeded on this tick. */
  remutated: number
  errors: number
  /** True while the backlog sweep is still running — no mail is processed yet. */
  backlog_sweeping: boolean
}

/** Per-account backlog completion. '' is the single-account sentinel. */
export function backlogDoneKey(account_id: string | null): string {
  return `${CHECKPOINT_BACKLOG_DONE}:${account_id ?? ''}`
}

/** The accounts a list response actually covered. */
function accountsOnThisPage(page: {
  accounts?: ReadonlyArray<{ account_id: string; ok: boolean }>
  results: ReadonlyArray<{ account_id?: string }>
}): string[] {
  if (page.accounts !== undefined) {
    return page.accounts.filter((a) => a.ok).map((a) => a.account_id)
  }
  // Single-backend client: no per-account reporting, one implicit mailbox.
  const stamped = new Set<string>()
  for (const row of page.results) stamped.add(row.account_id ?? '')
  return stamped.size > 0 ? [...stamped] : ['']
}

/** Read back the persisted per-account cursor map; a corrupt value restarts the sweep. */
function parseCursorMap(raw: string | null): Record<string, string> {
  if (raw === null || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
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
    remutated: 0,
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
    // A NEWLY CONNECTED MAILBOX HAS ITS OWN BACKLOG. The global flag alone said
    // "the backlog is done" forever, so a mailbox connected afterwards had its
    // entire history read as new mail — classified, labelled and escalated. A
    // cheap probe re-opens the sweep whenever a connected account has no
    // completion mark of its own.
    let backlogPending = store.getCheckpoint(CHECKPOINT_BACKLOG_DONE) !== '1'
    if (!backlogPending) {
      const probe = await gmail.listMessages({ label: DEFAULT_LABEL, max_results: 1 })
      const unmarked = accountsOnThisPage(probe).filter(
        (id) => store.getCheckpoint(backlogDoneKey(id)) !== '1',
      )
      if (unmarked.length > 0) {
        backlogPending = true
        log?.('email pipeline backlog sweep re-opened for newly connected accounts', {
          accounts: unmarked,
        })
      }
    }

    if (backlogPending) {
      result.backlog_sweeping = true
      const cursor = store.getCheckpoint(CHECKPOINT_BACKLOG_CURSOR)
      const perAccount = parseCursorMap(store.getCheckpoint(CHECKPOINT_BACKLOG_CURSORS))
      const page = await gmail.listMessages({
        label: DEFAULT_LABEL,
        max_results: deps.backlog_page_size ?? DEFAULT_BACKLOG_PAGE_SIZE,
        // Every row that was READ must be marked. `max_results` is per-account,
        // so N mailboxes return up to N pages; a merged set capped back to one
        // page would leave the rest unmarked while every cursor advanced past
        // them — and unmarked backlog is exactly what reaches the classifier
        // once the sweep completes.
        exhaustive: true,
        ...(cursor !== null && cursor.length > 0 ? { page_token: cursor } : {}),
        ...(Object.keys(perAccount).length > 0 ? { page_tokens: perAccount } : {}),
      })
      // FAIL LOUD, NEVER COMPLETE. A capped page carries no cursor, so there is
      // nothing to resume from and "capped" would be indistinguishable from
      // "exhausted" — the sweep would mark itself done over a partial inbox.
      // Throwing records a tick error and leaves the sweep pending; the next
      // tick retries. Unreachable while `exhaustive` is honoured, which is the
      // point: a client that quietly ignores it is caught here, not in the
      // owner's chat six months of backlog later.
      if (page.truncated === true) {
        throw new Error(
          'backlog sweep received a TRUNCATED page (cursors withheld) — refusing to mark the backlog complete over a partial inbox',
        )
      }
      // ONLY the mailboxes that still owe a sweep are marked. A re-opened
      // sweep sees EVERY account's mail, and marking all of it `preexisting`
      // would bury genuinely new mail that arrived in an already-swept mailbox
      // while a second one was being connected — never classified, never
      // escalated, and indistinguishable from history ever after. Mail from an
      // already-marked account is left untouched here: it is not recorded, so
      // the steady-state pass picks it up normally once the sweep finishes.
      const sweepTargets = new Set(
        accountsOnThisPage(page).filter(
          (id) => store.getCheckpoint(backlogDoneKey(id)) !== '1',
        ),
      )
      for (const meta of page.results) {
        if (!sweepTargets.has(meta.account_id ?? '')) continue
        if (store.hasEmail(meta.id, meta.account_id ?? null)) continue
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
      // COMPLETION IS EARNED, NOT ASSUMED. Two ways this used to end early:
      //
      //  (a) `next_page_token` is omitted by the fan-out whenever MORE THAN ONE
      //      account is connected (`multi-account.ts`), because one cursor
      //      cannot address N mailboxes. Reading that absence as "no more mail"
      //      marked the sweep done after a single page, and every remaining
      //      historical message then entered live classification — the exact
      //      escalation-of-old-mail this sweep exists to prevent. So the
      //      per-account cursor map is authoritative when present.
      //  (b) One account failing while others answered. Fan-out returns partial
      //      success by design (a dead grant must not empty the inbox), but a
      //      partial page cannot prove the unread accounts are exhausted.
      const next = page.next_page_token
      const nextPerAccount = page.next_page_tokens ?? {}
      const outcomes = page.accounts
      const allAccountsAnswered = outcomes === undefined || outcomes.every((a) => a.ok)
      const cursorsRemain =
        Object.keys(nextPerAccount).length > 0 || (next !== undefined && next.length > 0)

      if (cursorsRemain || !allAccountsAnswered) {
        if (next !== undefined && next.length > 0) {
          store.setCheckpoint(CHECKPOINT_BACKLOG_CURSOR, next)
        }
        store.setCheckpoint(CHECKPOINT_BACKLOG_CURSORS, JSON.stringify(nextPerAccount))
        log?.('email pipeline backlog sweep advancing', {
          marked: result.precutoff,
          accounts_pending: outcomes?.filter((a) => !a.ok).length ?? 0,
        })
      } else {
        // Mark the ACCOUNTS, not just "the backlog". The connected set is
        // dynamic — the resolver re-reads it per request so a mailbox can be
        // added after boot — and a single global flag made that new mailbox's
        // entire history look like new mail: classified, labelled, and
        // escalated into the owner's chat. Completion is therefore recorded
        // per account, and `backlogPending` below re-opens the sweep for any
        // account that has not had one.
        // Mark exactly the accounts this sweep was FOR. Marking every account
        // on the page would claim a completed sweep for a mailbox whose mail
        // was deliberately skipped above.
        for (const id of sweepTargets) {
          store.setCheckpoint(backlogDoneKey(id), '1')
        }
        store.setCheckpoint(CHECKPOINT_BACKLOG_DONE, '1')
        store.setCheckpoint(CHECKPOINT_BACKLOG_CURSOR, '')
        store.setCheckpoint(CHECKPOINT_BACKLOG_CURSORS, '')
        log?.('email pipeline backlog sweep complete', {
          marked: result.precutoff,
          accounts: [...sweepTargets],
        })
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
            account_id: pending.account_id,
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

    /**
     * The Gmail write one row still owes, derived from how it was handled.
     * An escalated message KEEPS `INBOX` — the owner still has to deal with
     * it — so only the archive path removes the label.
     */
    async function applyMutation(row: {
      id: string
      account_id: string | null
      handling: string
    }): Promise<void> {
      const account_id = row.account_id === null || row.account_id === '' ? undefined : row.account_id
      const label_id = await processedLabelId(account_id)
      await gmail.modifyMessage({
        message_id: row.id,
        add_label_ids: [label_id],
        ...(row.handling === 'archive' ? { remove_label_ids: [DEFAULT_LABEL] } : {}),
        ...(account_id !== undefined ? { account_id } : {}),
      })
      store.markMutated(row.id, now(), row.account_id)
    }

    // (2b) RETRY OWED GMAIL WRITES. A message whose label/archive call failed
    // after its row was written is skipped by `hasEmail` forever, so nothing
    // in the poll path can ever come back to it. This pass is the only thing
    // that finishes it — without re-classifying (costly) and without
    // re-escalating (the owner was already told, on the row's own record).
    for (const pending of store.listPendingMutations(max_attempts)) {
      try {
        await applyMutation(pending)
        result.remutated++
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        store.recordMutationFailure(pending.id, error, pending.account_id)
        result.errors++
        log?.('email pipeline mutation retry failed', { email_id: pending.id, error })
      }
    }

    // (3) POLL. Merged across accounts by the fan-out client; every row is
    // stamped with the account it was read from. `exhaustive` because every
    // listed row is processed here — a capped merge would drop rows that no
    // later tick re-lists once they age out of the newest page.
    // PAGE UNTIL NEW MAIL IS REACHED, not once. An ESCALATED message keeps
    // INBOX on purpose — the owner still has to act on it — so the top of the
    // inbox fills with messages this pipeline has already handled. A
    // single-page poll therefore starves: with `max_results` retained
    // escalations sitting at the top, every tick re-reads the same handled
    // page, skips all of it via `hasEmail`, and NEVER reaches the message
    // behind them. The owner's next important email would simply never arrive.
    //
    // So the tick walks pages until it has seen unhandled mail or run out,
    // bounded by a page budget so one tick cannot run forever. Hitting the
    // budget is LOGGED, never silent — a silently truncated poll is the same
    // starvation wearing a different hat.
    const rules = store.listSenderRules()
    const classifyDeps: ClassifyDeps = { ...deps.classify, rules }

    async function handleMessage(meta: GmailMessageMeta): Promise<void> {
      const received_at = Date.parse(meta.internal_date)
      const account_id = meta.account_id ?? null

      // Anything reaching here is NEW: the backlog sweep has completed, and
      // `store.hasEmail` (below) has already excluded every message it marked.
      // No date comparison is involved or needed.
      //
      // The account is NAMED. Gmail ids are account-local, so an unqualified
      // read returns whichever mailbox recognises the id first — on a
      // collision that is a DIFFERENT message's body, classified as if it were
      // this one while the label write correctly targets the right mailbox.
      const full = await gmail.getMessage({
        message_id: meta.id,
        ...(meta.account_id !== undefined ? { account_id: meta.account_id } : {}),
      })
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
        // RECORD → TELL → LABEL, in that order, and each step durably marked.
        //
        // Record first so nothing happens to a message without a row to find
        // it by. Tell the owner NEXT, ahead of the label write: escalation is
        // what this pipeline exists to do, and a Gmail API failure must never
        // be able to swallow it. Label last, marked by `mutated_at`; if that
        // call fails the row survives with the mark unset and pass (2b)
        // finishes it on a later tick.
        //
        // KEEP INBOX — an escalated message is one the owner still has to
        // handle in their mail client, so only the processed label is added.
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
          {
            id: meta.id,
            sender: meta.from,
            subject: meta.subject,
            reason: verdict.reason,
            account_id,
          },
          escalateDeps,
        )
        if (outcome.delivered) result.escalated++
        await applyMutation({ id: meta.id, account_id, handling: 'escalate' })
        return
      }

      // NOT IMPORTANT: record FIRST, then archive. No chat post, no push — the
      // row's existence is what queues it for the P2 brief.
      //
      // ORDER IS LOAD-BEARING. Archiving first would remove `INBOX` and only
      // then try to persist: if the insert throws (disk full, SQLite error),
      // the message is gone from every future poll AND was never queued, so it
      // silently misses the brief with nothing left to find it by. Persisting
      // first can only fail the other way — an archive that did not happen
      // leaves `mutated_at` unset, and pass (2b) retries exactly that.
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
      await applyMutation({ id: meta.id, account_id, handling: 'archive' })
      result.archived++
    }

    const page_budget = deps.max_poll_pages ?? DEFAULT_MAX_POLL_PAGES
    let cursor: string | undefined
    let cursors: Record<string, string> = {}
    let pages = 0
    let exhausted = false

    while (pages < page_budget) {
      const listed = await gmail.listMessages({
        label: DEFAULT_LABEL,
        max_results,
        exhaustive: true,
        ...(cursor !== undefined ? { page_token: cursor } : {}),
        ...(Object.keys(cursors).length > 0 ? { page_tokens: cursors } : {}),
      })
      pages++

      for (const meta of listed.results) {
        if (store.hasEmail(meta.id, meta.account_id ?? null)) continue
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

      // Stop as soon as this tick has done real work: the remaining pages are
      // older mail that is not going anywhere, and the next tick resumes from
      // the top in five minutes. Only a page that was ENTIRELY already-handled
      // forces the walk onward — that is the starvation case.
      if (result.scanned > 0) {
        exhausted = true
        break
      }
      cursor = listed.next_page_token
      cursors = { ...(listed.next_page_tokens ?? {}) }
      if (cursor === undefined && Object.keys(cursors).length === 0) {
        exhausted = true
        break
      }
    }

    if (!exhausted) {
      log?.('email pipeline poll hit its page budget without reaching unhandled mail', {
        pages,
        page_budget,
      })
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
