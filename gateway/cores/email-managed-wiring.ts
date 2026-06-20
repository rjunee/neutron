/**
 * @neutronai/gateway/cores — Email-Managed Core daily-triage scheduler wiring.
 *
 * Mirrors `calendar-wiring.ts:buildCalendarPreMeetingBriefSchedulerDeps`. The
 * Email-Managed Core ships a `TriageScheduler` (daily 08:00 user-local, 50-msg
 * lookback) that was BUILT but never wired into the gateway (`grep -rln
 * TriageScheduler gateway/` returned nothing pre-scribe-p2). This factory
 * bundles the deps the scheduler consumes; the boot path threads the result
 * into `buildTriageScheduler(...)` + `scheduler.start()` (the scheduler now owns
 * its own self-tick, like the Calendar Core's scheduler + `reminders/tick.ts`,
 * so no external loop is needed here — keeping this wiring timer-free).
 *
 * The `fire` callback does two things on each daily fire:
 *   1. Posts the composed triage to the owner's target project via
 *      `PushDispatcher.pushAll` (same surface the calendar brief uses). When no
 *      dispatcher is wired, the audit row still records `chat_message_id: null`.
 *   2. Scribe phase-2 ride-along: fans each NEW already-fetched inbox message
 *      (`TriageFireInput.inbox` — no second fetch) into scribe's extract→GBrain
 *      path (`trigger:'email'`, source `email:<id>`). A persistent inbox is
 *      extracted exactly once via a per-instance high-watermark on `internal_date`
 *      (`scribeWatermark`) — without it the daily 50-msg lookback would re-fan
 *      the same mail every day, re-spending budget + duplicating provenance.
 *      Fire-and-forget; the per-instance budget governor further bounds how many
 *      of a fire's new messages actually extract (over-budget drop clean).
 *
 * No side effects — the factory opens no handles + schedules no timers.
 */

import { readFile, writeFile } from 'node:fs/promises'

import type {
  GmailClient,
  EmailProjectCache,
  Triage,
  TriageFireInput,
  TriageFireResult,
  TriageSchedulerOpts,
} from '@neutronai/email-managed-core'

import { composeEmailPayload } from '../../scribe/index.ts'
import type { PushDispatcher } from '../push/dispatcher.ts'
import type { ScribeFanOut } from './scribe-fan-out.ts'

/**
 * Cross-day idempotency state for the scribe email fan-out: the epoch-ms of the
 * newest message `internal_date` already handed to scribe. The daily triage
 * re-fetches a 50-msg lookback, so the SAME persistent mail re-appears every
 * fire — this high-watermark lets the fan-out skip what it already extracted.
 */
export interface ScribeEmailWatermarkStore {
  /** Newest fanned `internal_date` in epoch-ms, or 0 when none recorded. */
  get(): Promise<number>
  /** Persist a new high-watermark (callers only ever raise it). */
  set(epochMs: number): Promise<void>
}

/**
 * File-backed `ScribeEmailWatermarkStore` at `path` (a tiny JSON
 * `{ "watermark_ms": <n> }`, e.g. `<owner_home>/.scribe-email-watermark.json`).
 * Best-effort: a missing/corrupt file reads as 0 (the window re-fans once); a
 * write failure is swallowed (the next fire just re-fans) — it never throws into
 * the triage path.
 */
export function fileScribeEmailWatermark(path: string): ScribeEmailWatermarkStore {
  return {
    async get(): Promise<number> {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as { watermark_ms?: unknown }
        const n = parsed.watermark_ms
        return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
      } catch {
        return 0
      }
    },
    async set(epochMs: number): Promise<void> {
      try {
        await writeFile(path, JSON.stringify({ watermark_ms: epochMs }), 'utf8')
      } catch {
        // best-effort — the next fire re-fans the window; never throws.
      }
    },
  }
}

export interface EmailTriageSchedulerDepsInput {
  project_slug: string
  client: GmailClient
  cacheFor: (project_id: string) => Promise<EmailProjectCache>
  /** Resolve the target project_id for the daily fire (e.g. General). */
  targetProjectId: () => Promise<string>
  /** Haiku-fast triage composer LLM (the same substrate-backed call the chat
   *  `/email` command uses). */
  llm: (prompt: string) => Promise<string>
  /** Resolved Haiku-fast model id. */
  model: string
  /** User-local time zone. Defaults to `America/Los_Angeles`. */
  userTz?: string
  /** Optional push dispatcher. When `null`, the triage composes + the audit row
   *  records but no chat post happens (`chat_message_id: null`). */
  pushDispatcher: PushDispatcher | null
  /**
   * Scribe phase-2 fan-out (optional). `undefined` when scribe is not live
   * (owner has no Anthropic credentials) — the triage post then behaves
   * exactly as if scribe were absent.
   */
  scribeFanOut?: ScribeFanOut
  /**
   * Cross-day idempotency watermark for the scribe fan-out (optional). When
   * provided, the daily fire fans ONLY inbox messages strictly newer than the
   * stored mark, so a persistent inbox is extracted exactly once instead of
   * re-spending the per-instance budget + appending duplicate timeline provenance
   * every day. `undefined` → no watermark (every fire re-fans the whole window;
   * the pre-watermark behaviour, kept for tests that don't exercise idempotency).
   */
  scribeWatermark?: ScribeEmailWatermarkStore
}

/** Render the composed triage's top items into a chat post body. */
export function renderTriageText(triage: Triage): string {
  if (triage.items.length === 0) {
    return 'No notable emails in your inbox today.'
  }
  const lines = triage.items.map((it) => {
    const reason = it.reason.trim().length > 0 ? ` — ${it.reason.trim()}` : ''
    return `${it.rank}. ${it.subject} (${it.from})${reason}`
  })
  return `Top ${triage.items.length} emails today:\n${lines.join('\n')}`
}

/**
 * Build the `TriageSchedulerOpts` bundle. The boot path passes the result to
 * `buildTriageScheduler(...)`.
 */
export function buildEmailTriageSchedulerDeps(
  input: EmailTriageSchedulerDepsInput,
): TriageSchedulerOpts {
  const userTz = input.userTz ?? 'America/Los_Angeles'
  return {
    client: input.client,
    cacheFor: input.cacheFor,
    targetProjectId: input.targetProjectId,
    llm: input.llm,
    model: input.model,
    userTz,
    fire: async (fireInput: TriageFireInput): Promise<TriageFireResult> => {
      const { triage, project_id, inbox } = fireInput
      // 1. Post the triage to the target project (best-effort).
      let chat_message_id: string | null = null
      if (input.pushDispatcher !== null) {
        try {
          const pushed = await input.pushDispatcher.pushAll(input.project_slug, {
            title: 'Daily email triage',
            body: renderTriageText(triage),
            data: {
              kind: 'email_daily_triage',
              project_id,
              project_slug: input.project_slug,
            },
          })
          if (pushed.ok && pushed.attempted > 0) {
            chat_message_id = `push:triage:${project_id}`
          }
        } catch {
          // best-effort — the audit row records the null chat_message_id.
        }
      }
      // 2. Scribe phase-2 ride-along over the SAME already-fetched inbox.
      //    Cross-day idempotency: the daily 50-msg lookback re-returns the same
      //    persistent mail every fire, so without a watermark each message would
      //    re-extract daily — re-spending the per-instance budget AND appending a
      //    fresh-`ts` timeline entry every day (scribe keys its timeline dedup on
      //    the write `ts`, not the message id). The high-watermark fans each
      //    message exactly once: only an `internal_date` strictly newer than the
      //    last fanned mark rides into scribe. Within a fire the per-message
      //    fan-out is still budget-bounded (bucket 10 / refill 6-per-min /
      //    inflight 3) — overflow drops CLEAN. Bodies are NOT fetched (list
      //    metadata only → no second request); richer body extraction is a
      //    documented follow-up, not a silent cap.
      if (input.scribeFanOut !== undefined) {
        const prior =
          input.scribeWatermark !== undefined ? await input.scribeWatermark.get() : 0
        let maxMs = prior
        for (const msg of inbox) {
          const ms = Date.parse(msg.internal_date)
          // Skip a message already fanned on a prior day (parseable date at/below
          // the mark). An unparseable date fails OPEN (fans) — vanishingly rare,
          // and a rare re-extract beats a silent drop.
          if (input.scribeWatermark !== undefined && Number.isFinite(ms) && ms <= prior) {
            continue
          }
          input.scribeFanOut('email', composeEmailPayload(msg), `email:${msg.id}`)
          if (Number.isFinite(ms) && ms > maxMs) maxMs = ms
        }
        if (input.scribeWatermark !== undefined && maxMs > prior) {
          await input.scribeWatermark.set(maxMs)
        }
      }
      return { chat_message_id }
    },
  }
}
