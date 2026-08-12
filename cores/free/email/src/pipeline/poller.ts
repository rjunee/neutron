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

import { DEFAULT_LABEL, PAGE_TOKEN_EXHAUSTED, PROCESSED_LABEL_NAME } from '../contract.ts'
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
/**
 * STEADY-STATE continuation cursors. Set only when a tick exhausted its page
 * budget without reaching unhandled mail, so the next tick resumes there
 * instead of re-walking the same opening pages forever. Cleared the moment the
 * walk finds mail or runs out of pages.
 */
export const CHECKPOINT_POLL_CURSOR = 'poll_cursor'
export const CHECKPOINT_POLL_CURSORS = 'poll_cursors'

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
/**
 * How many backlog pages ONE tick may sweep. At the 100-per-page default that
 * is 5,000 messages a tick, so a large inbox is marked in a couple of ticks
 * instead of one page every five minutes — the crawl that kept new mail out of
 * the owner's chat for hours after switch-on. Bounds the tick, not the sweep.
 */
export const DEFAULT_MAX_BACKLOG_PAGES = 50

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
  /**
   * WHEN THE PIPELINE BECAME RESPONSIBLE FOR THIS MAILBOX — captured at BOOT,
   * not at the first fire. The interval cron waits a full period before its
   * first execution, so stamping the boundary inside the tick drew the line
   * five minutes late: mail that arrived in that window was older than the
   * cutoff and the sweep filed it as `preexisting` — never classified, never
   * escalated, permanently. The wrapper captures this the moment the handler
   * is built and threads it here. Absent ⇒ `now()`, the old behaviour, which
   * is correct only for a caller that fires immediately.
   */
  activation_at?: number
  log?: PipelineLog
  max_results?: number
  max_escalation_attempts?: number
  /** Backlog messages marked per tick during the one-time sweep. */
  backlog_page_size?: number
  /** List pages one steady-state tick may walk before giving up for now. */
  max_poll_pages?: number
  /** Backlog pages one tick may sweep before pausing until the next tick. */
  max_backlog_pages?: number
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
  /** Messages seen mid-sweep that arrived AFTER go-live, so were left for the
   *  steady-state pass rather than being filed as history. */
  arrived_during_sweep: number
  /** True while the backlog sweep is still running — no mail is processed yet. */
  backlog_sweeping: boolean
}

/** Per-account backlog completion. '' is the single-account sentinel. */
export function backlogDoneKey(account_id: string | null): string {
  return `${CHECKPOINT_BACKLOG_DONE}:${account_id ?? ''}`
}

/**
 * PER-ACCOUNT sweep boundary: everything in THIS mailbox older than this stamp
 * is that mailbox's existing inbox.
 *
 * It cannot be one global stamp. A mailbox connected weeks after the pipeline
 * went live has a backlog of its own, all of it NEWER than the original
 * `go_live_after` — so a global comparison classed that entire backlog as
 * "arrived while we were sweeping", handed it to the classifier, and escalated
 * it. Each mailbox's history is history relative to when THAT mailbox joined.
 */
export function backlogCutoffKey(account_id: string | null): string {
  return `backlog_cutoff:${account_id ?? ''}`
}

/**
 * The accounts a list response covered.
 *
 * `ok_only` distinguishes two different questions, and conflating them let a
 * mailbox skip its sweep:
 *   - COMPLETION ("whose backlog did we finish?") needs ok-only — an account
 *     that did not answer proves nothing about its inbox.
 *   - PRESENCE ("who is connected?") must count FAILED accounts too. A newly
 *     connected mailbox whose probe happened to fail is still connected, and
 *     treating it as absent left it unswept while the same tick went on to read
 *     its history as new mail.
 */
function accountsOnThisPage(
  page: {
    accounts?: ReadonlyArray<{ account_id: string; ok: boolean }>
    results: ReadonlyArray<{ account_id?: string }>
  },
  ok_only = true,
): string[] {
  if (page.accounts !== undefined) {
    return page.accounts.filter((a) => (ok_only ? a.ok : true)).map((a) => a.account_id)
  }
  // Single-backend client: no per-account reporting, one implicit mailbox.
  const stamped = new Set<string>()
  for (const row of page.results) stamped.add(row.account_id ?? '')
  return stamped.size > 0 ? [...stamped] : ['']
}

/**
 * The cursor map to resume from next time.
 *
 * An account that returned NO cursor is FINISHED, and must be carried forward
 * as such — dropping it from the map means "start from the newest page", so a
 * finished mailbox restarts every time a deeper one is still paging and the two
 * never converge. Every account in scope therefore appears in the result:
 * either with its next cursor, or with the exhausted sentinel.
 */
function nextCursorMap(
  scope: readonly string[],
  returned: Readonly<Record<string, string>>,
  previous: Readonly<Record<string, string>>,
  failed: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of scope) {
    // A FAILED account returned no cursor because it returned NOTHING — that is
    // not the same as having no more pages. Marking it exhausted would make the
    // next tick SKIP it (the fan-out honours the sentinel and reports the skip
    // as ok), and the sweep would then declare that mailbox's backlog complete
    // without ever having read a single message from it. Its entire history
    // would land in the classifier as new mail. A failed account keeps whatever
    // cursor it had, or none — either way it stays readable and unfinished.
    if (failed.has(id)) {
      const prior = previous[id]
      if (prior !== undefined && prior !== PAGE_TOKEN_EXHAUSTED) out[id] = prior
      continue
    }
    const next = returned[id]
    out[id] = next !== undefined && next.length > 0 ? next : PAGE_TOKEN_EXHAUSTED
  }
  return out
}

/** Accounts that did NOT answer this read. */
function failedAccounts(page: {
  accounts?: ReadonlyArray<{ account_id: string; ok: boolean }>
}): ReadonlySet<string> {
  const out = new Set<string>()
  for (const a of page.accounts ?? []) if (!a.ok) out.add(a.account_id)
  return out
}

/** True when at least one account in the map still has pages to read. */
function anyCursorsRemain(map: Readonly<Record<string, string>>): boolean {
  return Object.values(map).some((t) => t !== PAGE_TOKEN_EXHAUSTED)
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
    arrived_during_sweep: 0,
    backlog_sweeping: false,
  }

  const escalateDeps: EscalateDeps = { ...deps.escalate, store, now }

  try {
    // (1) The go-live stamp. Recorded once, BEFORE the first sweep page, and it
    // is the sweep's boundary: everything older is the owner's existing inbox,
    // everything newer arrived after we started and is real mail. It is NOT a
    // per-message gate in steady state — see invariant 1.
    // BOOT, NOT FIRST FIRE. `activation_at` is when this pipeline started
    // being responsible for the mailbox; `now()` is five minutes later on a
    // default interval cron. The gap is not academic — it is the window right
    // after switch-on, when the owner is most likely to be watching.
    const activation = deps.activation_at ?? now()
    const stamped = store.getCheckpoint(CHECKPOINT_GO_LIVE_AFTER)
    let go_live_after: number
    if (stamped === null) {
      go_live_after = activation
      store.setCheckpoint(CHECKPOINT_GO_LIVE_AFTER, String(go_live_after))
      log?.('email pipeline go-live checkpoint stamped', { go_live_after })
    } else {
      const parsed = Number(stamped)
      go_live_after = Number.isNaN(parsed) ? now() : parsed
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
    // (1a) PER-ACCOUNT ENABLEMENT. The owner connects mailboxes for many
    // reasons; wanting the agent to READ one is a separate decision. The
    // allow-list is threaded into every list call as `account_ids`, so a
    // disabled mailbox is never queried — not queried-then-filtered, which
    // would still hit its API and still surface its read failures.
    //
    // UNCONFIGURED IS NOT DISABLED. Zero rows in `account_settings` means the
    // owner has never expressed a preference, and the pipeline behaves as it
    // always has (every connected account) rather than silently doing nothing
    // on a fresh install. The moment ONE row exists the owner has curated, and
    // from then on the list is authoritative — including when they have turned
    // everything off, which is a decision, not an absence.
    const account_settings = store.listAccountSettings()
    const enabled_accounts = store.enabledAccounts()
    const account_filter: readonly string[] | null =
      account_settings.length === 0 ? null : [...enabled_accounts]
    const listScope = account_filter === null ? {} : { account_ids: account_filter }
    /**
     * Is this row's mailbox still switched on? `null` filter ⇒ unconfigured ⇒
     * everything, unchanged. The '' single-account sentinel is only ever
     * enabled explicitly, which is correct: a single-backend install has no
     * account ids to curate, so it also has no `account_settings` rows and
     * takes the unconfigured path.
     */
    const accountEnabled = (account_id: string | null): boolean =>
      account_filter === null || enabled_accounts.has(account_id ?? '')
    if (account_filter !== null && account_filter.length === 0) {
      // Every account explicitly off. Say so on every tick — a pipeline that is
      // deliberately silent and one that is broken look identical in a log that
      // only reports work done.
      log?.('email pipeline has no enabled accounts; nothing will be polled', {
        configured: account_settings.length,
      })
      store.setCheckpoint(CHECKPOINT_LAST_POLL_AT, String(now()))
      return result
    }

    // The FIRST sweep — the migration itself — versus a mailbox connected
    // later. They need different cutoffs and the difference matters both ways:
    // the initial accounts' line is ACTIVATION (anything after boot is real
    // mail, however late the first fire runs), while an account connected
    // afterwards has its own untriaged history right up to the moment it was
    // connected, so its line is NOW. Using activation for a late-joining
    // mailbox would escalate months of its back-catalogue.
    const initial_sweep = store.getCheckpoint(CHECKPOINT_BACKLOG_DONE) !== '1'
    let backlogPending = store.getCheckpoint(CHECKPOINT_BACKLOG_DONE) !== '1'
    if (!backlogPending) {
      const probe = await gmail.listMessages({ label: DEFAULT_LABEL, max_results: 1, ...listScope })
      // PRESENCE, not success — include accounts that failed this probe. A new
      // mailbox whose probe errors is still connected; skipping it here left it
      // unswept while the same tick's steady-state list read its history as new
      // mail the moment it recovered.
      const unmarked = accountsOnThisPage(probe, false).filter(
        (id) => store.getCheckpoint(backlogDoneKey(id)) !== '1',
      )
      if (unmarked.length > 0) {
        backlogPending = true
        log?.('email pipeline backlog sweep re-opened for newly connected accounts', {
          accounts: unmarked,
        })
      }
    }

    // THE SWEEP PAGES WITHIN THE TICK, and hands over the moment it finishes.
    //
    // One page per tick made the sweep a five-minute-per-page crawl: a 10,000
    // message inbox is 100 pages, so no NEW important mail could reach the
    // owner's chat for something like eight hours after switching the pipeline
    // on — while the acceptance criterion promises one poll interval. The
    // sweep is a migration, not the product; it must not hold the product
    // hostage for a working day.
    //
    // So it loops here up to a page budget, and when it completes it does NOT
    // return — it falls through to steady state on this same tick, so the first
    // real message is handled immediately rather than five minutes later.
    let sweepPages = 0
    const sweep_budget = deps.max_backlog_pages ?? DEFAULT_MAX_BACKLOG_PAGES
    while (backlogPending && sweepPages < sweep_budget) {
      result.backlog_sweeping = true
      sweepPages++
      const cursor = store.getCheckpoint(CHECKPOINT_BACKLOG_CURSOR)
      const perAccount = parseCursorMap(store.getCheckpoint(CHECKPOINT_BACKLOG_CURSORS))
      const page = await gmail.listMessages({
        label: DEFAULT_LABEL,
        ...listScope,
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
      // Stamp each target's own boundary the first time we sweep it. For the
      // original mailbox this lands beside `go_live_after`; for one connected
      // later it is that mailbox's join moment, which is the only line that
      // makes its backlog "history" rather than a fortnight of new mail.
      const cutoffFor = new Map<string, number>()
      for (const id of sweepTargets) {
        const key = backlogCutoffKey(id)
        const stored = store.getCheckpoint(key)
        const parsed = stored === null ? Number.NaN : Number(stored)
        if (Number.isNaN(parsed)) {
          // AN ACCOUNT TURNED ON LATER IS SWEPT FROM WHEN IT WAS TURNED ON.
          // `enabled_at` is the exact moment the owner took responsibility for
          // that mailbox; falling back to `now()` would draw the line at
          // whichever tick happened to notice, and everything in between would
          // read as new mail and escalate.
          const enabled_at = store.getAccountSetting(id)?.enabled_at ?? null
          const stamp = enabled_at ?? (initial_sweep ? activation : now())
          store.setCheckpoint(key, String(stamp))
          cutoffFor.set(id, stamp)
          log?.('email pipeline backlog cutoff stamped for account', { account: id, stamp })
        } else {
          cutoffFor.set(id, parsed)
        }
      }
      for (const meta of page.results) {
        if (!sweepTargets.has(meta.account_id ?? '')) continue
        if (store.hasEmail(meta.id, meta.account_id ?? null)) continue
        const received_at = Date.parse(meta.internal_date)
        // MAIL THAT ARRIVED WHILE WE WERE SWEEPING IS NOT HISTORY. The sweep
        // can span several pages and several ticks, and a message landing
        // mid-sweep would otherwise be marked `preexisting` — filed as
        // something the owner had already triaged, never classified, never
        // escalated, and indistinguishable from a decade-old newsletter.
        //
        // `go_live_after` is stamped before the first page, so it is exactly
        // the "everything older than this is the owner's existing inbox" line.
        // NOTE this is the ONE place a date is still compared, and it is a
        // one-time migration boundary — not the per-message gate on every
        // incoming email forever that this design deliberately removed.
        //
        // An unparseable date is treated as HISTORY here: during a sweep the
        // overwhelming majority of mail is history, and wrongly escalating the
        // owner's back-catalogue is the failure the sweep exists to prevent.
        // Such a message is still recorded, so it reaches the P2 brief.
        const cutoff = cutoffFor.get(meta.account_id ?? '') ?? go_live_after
        if (!Number.isNaN(received_at) && received_at > cutoff) {
          result.arrived_during_sweep++
          continue
        }
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
      // Carry FINISHED accounts forward as exhausted rather than dropping them:
      // an absent account restarts from its newest page, so with mailboxes of
      // unequal depth the maps alternate and the sweep never completes.
      const nextPerAccount = nextCursorMap(
        accountsOnThisPage(page, false),
        page.next_page_tokens ?? {},
        perAccount,
        failedAccounts(page),
      )
      const outcomes = page.accounts
      const allAccountsAnswered = outcomes === undefined || outcomes.every((a) => a.ok)
      const cursorsRemain =
        anyCursorsRemain(nextPerAccount) || (next !== undefined && next.length > 0)

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
        // DONE — fall out of the loop and carry straight on into steady state
        // on this same tick. The owner's next important email should not wait
        // for the next cron fire just because the migration happened to finish
        // during this one.
        backlogPending = false
        break
      }
    }

    if (backlogPending) {
      // Still sweeping and out of budget for this tick.
      //
      // THIS USED TO RETURN. The reasoning was sound — never enter the code
      // path that could escalate history — but the bound it accepted was not:
      // one tick sweeps at most `max_backlog_pages × backlog_page_size`
      // messages, so an inbox larger than that made the owner's next important
      // email wait for the NEXT cron fire, and a big enough inbox made it wait
      // for many. That breaks the acceptance criterion this phase is written
      // against ("an important message reaches chat within one poll interval")
      // precisely on the installs where switch-on is most visible.
      //
      // So the tick carries on into a RESTRICTED live pass: the top of the
      // inbox only, and only messages that arrived after the account's cutoff.
      // The safety property is unchanged and now explicit rather than
      // structural — history is excluded by the same one-time migration
      // boundary the sweep itself uses, not by not looking.
      log?.('email pipeline backlog sweep paused at its page budget', {
        pages: sweepPages,
        marked: result.precutoff,
      })
      result.backlog_sweeping = true
    }
    // Restricted mode: sweep still running, so the live pass sees only the
    // newest page and only post-cutoff arrivals.
    const sweeping = backlogPending

    // (2) RESUME — escalations whose chat delivery failed on an earlier tick.
    // The query's `escalated_at IS NULL` is itself the dedup guard.
    for (const pending of store.listPendingEscalations(max_attempts)) {
      // A row belonging to a mailbox the owner has since turned OFF is left
      // exactly where it is: not delivered, not failed, not counted. Turning an
      // account off is a statement about what should reach the owner from now
      // on, and finishing an owed escalation from it would be the pipeline
      // arguing with the setting. Turning it back on resumes the row untouched.
      if (!accountEnabled(pending.account_id)) continue
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
            // Carry the push mark so a resumed escalation does not buzz again.
            pushed_at: pending.pushed_at,
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
      // Same rule, and here it is a WRITE — a disabled mailbox must not be
      // labelled or archived by a pipeline the owner has switched off for it.
      if (!accountEnabled(pending.account_id)) continue
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

      // Anything reaching here is NEW: either the backlog sweep has completed
      // and `store.hasEmail` (below) has already excluded every message it
      // marked, or the sweep is still running and the caller has filtered this
      // page down to post-cutoff arrivals. No date comparison in steady state.
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

    /**
     * The account's one-time migration boundary, re-read from the store rather
     * than carried out of the sweep block — the sweep may have run on an
     * EARLIER tick, and the boundary has to mean the same thing on every one.
     */
    function cutoffForAccount(account_id: string | null): number {
      const stored = store.getCheckpoint(backlogCutoffKey(account_id))
      const parsed = stored === null ? Number.NaN : Number(stored)
      return Number.isNaN(parsed) ? go_live_after : parsed
    }

    /**
     * Restricted-mode admission. A message is live mail only if we can PROVE
     * it arrived after the boundary — an unparseable or missing date is
     * treated as history, the same direction the sweep errs in, because
     * escalating the owner's back-catalogue is the failure this design exists
     * to prevent. Such a message is not lost: the sweep still reaches it.
     */
    function arrivedAfterCutoff(meta: GmailMessageMeta): boolean {
      const received_at = Date.parse(meta.internal_date)
      if (Number.isNaN(received_at)) return false
      return received_at > cutoffForAccount(meta.account_id ?? null)
    }

    // ONE page while the sweep runs. New mail is at the TOP of an INBOX
    // listing, so the newest page is where it is; walking deeper would just
    // re-read the history the sweep is already marking, page by page, twice.
    const page_budget = sweeping ? 1 : deps.max_poll_pages ?? DEFAULT_MAX_POLL_PAGES
    // RESUME WHERE THE LAST TICK RAN OUT. A budget that always restarts at the
    // top is not a bound on work, it is permanent starvation: with more than
    // `page_budget × max_results` handled messages retained above it, an
    // unhandled message is never reached, because every tick re-walks the same
    // opening pages and gives up in the same place. The continuation cursor is
    // what turns "bounded per tick" into "bounded per tick AND eventually
    // reached". It is cleared as soon as the walk finds mail or runs out, so
    // the next tick starts at the top again where new mail arrives.
    //
    // In RESTRICTED mode the continuation cursor is deliberately ignored: it
    // points wherever the last full walk ran out, and what this pass needs is
    // the top of the inbox, every tick, for as long as the sweep lasts.
    const savedCursor = sweeping ? null : store.getCheckpoint(CHECKPOINT_POLL_CURSOR)
    const savedCursors = sweeping
      ? {}
      : parseCursorMap(store.getCheckpoint(CHECKPOINT_POLL_CURSORS))
    let cursor: string | undefined =
      savedCursor !== null && savedCursor.length > 0 ? savedCursor : undefined
    let cursors: Record<string, string> = savedCursors
    let pages = 0
    let exhausted = false

    while (pages < page_budget) {
      const listed = await gmail.listMessages({
        label: DEFAULT_LABEL,
        ...listScope,
        max_results,
        exhaustive: true,
        ...(cursor !== undefined ? { page_token: cursor } : {}),
        ...(Object.keys(cursors).length > 0 ? { page_tokens: cursors } : {}),
      })
      pages++

      let handledOnThisPage = 0
      for (const meta of listed.results) {
        if (store.hasEmail(meta.id, meta.account_id ?? null)) continue
        // History stays invisible to the classifier while the sweep is still
        // deciding what history is.
        if (sweeping && !arrivedAfterCutoff(meta)) continue
        result.scanned++
        try {
          await handleMessage(meta)
          handledOnThisPage++
        } catch (err) {
          result.errors++
          log?.('email pipeline message failed', {
            email_id: meta.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // DO NOT STOP JUST BECAUSE THIS PAGE HAD WORK. Two earlier versions
      // stopped early and both starved deeper mail:
      //
      //   - stopping on `scanned > 0` counted ATTEMPTS, so one permanently
      //     unreadable message became a wall across the whole mailbox;
      //   - stopping on real progress starved page 2 whenever page 1 kept
      //     receiving mail. A busy inbox would never reach the important
      //     message sitting behind the busy part.
      //
      // The page BUDGET is what bounds a tick, not an early exit. So the walk
      // continues to the end of the budget or the end of the cursors, and if it
      // runs out of budget it remembers where it was.
      void handledOnThisPage
      cursor = listed.next_page_token
      cursors = nextCursorMap(
        accountsOnThisPage(listed, false),
        listed.next_page_tokens ?? {},
        cursors,
        failedAccounts(listed),
      )
      if (cursor === undefined && !anyCursorsRemain(cursors)) {
        exhausted = true
        break
      }
    }

    if (sweeping) {
      // Restricted mode writes NO continuation cursor. Its budget of one page
      // is a deliberate scope, not a place it ran out of — persisting it would
      // hand the next full walk a cursor into the middle of the inbox and
      // strand everything above it.
      store.setCheckpoint(CHECKPOINT_LAST_POLL_AT, String(now()))
      store.setCheckpoint(CHECKPOINT_CONSECUTIVE_ERRORS, '0')
      return result
    }

    if (!exhausted) {
      // Out of budget: REMEMBER the place. Discarding the cursor here is what
      // made the budget a wall instead of a pause — the next tick would restart
      // at the top and give up in exactly the same spot, forever.
      store.setCheckpoint(CHECKPOINT_POLL_CURSOR, cursor ?? '')
      store.setCheckpoint(CHECKPOINT_POLL_CURSORS, JSON.stringify(cursors))
      log?.('email pipeline poll hit its page budget; will resume from here', {
        pages,
        page_budget,
        scanned: result.scanned,
      })
    } else {
      // Reached the end of the mailbox. Next tick starts at the top, which is
      // where new mail arrives.
      store.setCheckpoint(CHECKPOINT_POLL_CURSOR, '')
      store.setCheckpoint(CHECKPOINT_POLL_CURSORS, '')
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
