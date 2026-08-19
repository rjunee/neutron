/**
 * Email pipeline — the ACTIVATION WINDOW: the two ways switch-on could silently
 * swallow the owner's first important message.
 *
 * Both arms are regressions of real defects, and both are about the SAME
 * promise — "an important message reaches chat within one poll interval"
 * (IMPLEMENTATION_PLAN.md P1 acceptance) — failing precisely at the moment the
 * owner is most likely to be watching, the minutes right after they turn it on.
 *
 *   1. SWITCH-ON IS NOT THE FIRST FIRE. An `interval_ms` cron waits a full
 *      interval before its first execution, so a cutoff stamped inside the tick
 *      is five minutes late. Mail that arrived in that window is older than the
 *      line and the sweep files it as `preexisting` — history the owner already
 *      triaged. Nothing ever revisits it.
 *
 *      Since per-account enablement became opt-in, the moment being defended is
 *      the ENABLE (`account_settings.enabled_at`), with instance activation as
 *      the fallback for a boundary that was never stamped. `BOOT` below is that
 *      moment and `FIRST_FIRE` is the store's clock, five minutes later — so an
 *      implementation that reads the clock instead of the decision fails here.
 *
 *   2. A BIG INBOX IS NOT AN EXCUSE. The sweep is bounded per tick, so an inbox
 *      larger than that budget used to push live mail to the NEXT cron fire —
 *      and on a large enough mailbox, to many fires later.
 *
 * Every fixture address is `*.example.com`.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  GmailClient,
  GmailListInput,
  GmailListResult,
  GmailMessageFull,
  GmailMessageMeta,
} from '../src/contract.ts'
import { runEmailPipelineTick } from '../src/pipeline/poller.ts'
import { openEmailPipelineStore, type EmailPipelineStore } from '../src/pipeline/store.ts'

/** Owner boots the instance. */
const BOOT = Date.parse('2026-08-12T09:00:00.000Z')
/** The cron's first fire, one full default interval later. */
const FIRST_FIRE = BOOT + 5 * 60_000

interface Fixture {
  id: string
  subject: string
  from: string
  body_text: string
  internal_date: string
}

function important(id: string, at: number): Fixture {
  return {
    id,
    subject: 'Action required: payment failed',
    from: 'Vendor Billing <billing@vendor.example.com>',
    body_text: 'Your payment method was declined and the account is at risk.',
    internal_date: new Date(at).toISOString(),
  }
}

/**
 * A PAGINATING inbox. The shipped in-memory backend returns everything in one
 * page, which cannot express "the sweep ran out of budget" — the exact
 * condition arm 2 is about.
 */
function paginatingClient(fixtures: Fixture[]): GmailClient & {
  modified: string[]
  bodies_read: string[]
} {
  const newest_first = [...fixtures].sort(
    (a, b) => Date.parse(b.internal_date) - Date.parse(a.internal_date),
  )
  const modified: string[] = []
  const bodies_read: string[] = []
  const toMeta = (f: Fixture): GmailMessageMeta =>
    ({
      id: f.id,
      thread_id: `thread-${f.id}`,
      subject: f.subject,
      from: f.from,
      snippet: f.body_text.slice(0, 40),
      internal_date: f.internal_date,
      label_ids: ['INBOX'],
    }) as GmailMessageMeta

  return {
    modified,
    bodies_read,
    async listMessages(input: GmailListInput): Promise<GmailListResult> {
      const limit = input.max_results ?? 25
      const start = input.page_token === undefined ? 0 : Number(input.page_token)
      const slice = newest_first.slice(start, start + limit)
      const next = start + limit
      return {
        results: slice.map(toMeta),
        ...(next < newest_first.length ? { next_page_token: String(next) } : {}),
      } as GmailListResult
    },
    async getMessage(input: { message_id: string }): Promise<GmailMessageFull> {
      bodies_read.push(input.message_id)
      const f = newest_first.find((m) => m.id === input.message_id)
      if (f === undefined) throw new Error(`no such message ${input.message_id}`)
      return {
        ...toMeta(f),
        body_text: f.body_text,
        to: ['owner@example.com'],
      } as unknown as GmailMessageFull
    },
    async ensureLabel(): Promise<{ label_id: string }> {
      return { label_id: 'Label_processed' }
    },
    async modifyMessage(input: { message_id: string }): Promise<unknown> {
      modified.push(input.message_id)
      return {}
    },
  } as unknown as GmailClient & { modified: string[]; bodies_read: string[] }
}

function withStore(run: (store: EmailPipelineStore) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'email-activation-'))
  const store = openEmailPipelineStore({ owner_home: home, now: () => FIRST_FIRE })
  // The mailbox is turned on AT BOOT — that is what makes this the switch-on
  // window rather than an arbitrary interval. `''` is the single-account
  // sentinel. Enabling here is not scaffolding: under the opt-in default the
  // enable moment IS the line these arms are about, and `FIRST_FIRE` (the
  // store's clock) is deliberately not it.
  store.setAccountEnabled('', true, null, BOOT)
  return run(store).finally(() => {
    store.close()
    rmSync(home, { recursive: true, force: true })
  })
}

function tick(
  gmail: GmailClient,
  store: EmailPipelineStore,
  delivered: string[],
  over: { activation_at?: number; backlog_page_size?: number; max_backlog_pages?: number } = {},
): ReturnType<typeof runEmailPipelineTick> {
  return runEmailPipelineTick({
    gmail,
    store,
    classify: {
      cache_lookup: () => null,
      cache_store: () => undefined,
      llm: null,
    },
    escalate: {
      deliver: async (_topic, envelope): Promise<unknown> => {
        delivered.push(envelope.body)
        return { prompt_id: 'p1', persisted: true, delivered_live: true }
      },
      topic_id: 'app:owner',
      push: null,
      project_slug: 'instance',
    },
    now: () => FIRST_FIRE,
    ...over,
  })
}

describe('the boot-to-first-fire window', () => {
  test('mail that arrives before the first tick is NEW mail, not backlog', async () => {
    await withStore(async (store) => {
      const gmail = paginatingClient([
        // The owner's existing inbox — a year old, already triaged by hand.
        important('old-1', BOOT - 365 * 86_400_000),
        // Arrived one minute after boot, four minutes before the first fire.
        // This is the message the whole phase exists to deliver.
        important('window-1', BOOT + 60_000),
      ])
      const delivered: string[] = []

      const r = await tick(gmail, store, delivered, { activation_at: BOOT })

      expect(delivered.length).toBe(1)
      expect(delivered[0]).toContain('Vendor Billing')
      expect(r.escalated).toBe(1)
      // And the year-old one is still filed as history, untouched.
      expect(store.getEmail('old-1')?.handling).toBe('preexisting')
      expect(gmail.modified).not.toContain('old-1')
    })
  })

  test('a mailbox connected LATER still has its own history excluded', async () => {
    // The other direction, and the reason activation is not simply used for
    // every cutoff forever: an account added after the sweep completed has its
    // own untriaged back-catalogue, right up to the moment it was connected.
    await withStore(async (store) => {
      const gmail = paginatingClient([important('late-history-1', BOOT + 86_400_000)])
      const delivered: string[] = []

      await tick(gmail, store, delivered, { activation_at: BOOT })
      // The first sweep marked it as history relative to ACTIVATION only if it
      // predates activation; this one does not, so it is live mail. The arm
      // that matters is the inverse: nothing older than activation escalates.
      expect(delivered.length).toBe(1)
    })
  })
})

describe('a backlog bigger than one tick', () => {
  test('new mail is escalated on the FIRST tick, not after the sweep finishes', async () => {
    await withStore(async (store) => {
      // 12 historical messages with a sweep budget of 2 pages x 2 per page —
      // the sweep cannot possibly finish on this tick.
      const history = Array.from({ length: 12 }, (_v, n) =>
        important(`old-${n}`, BOOT - (n + 1) * 86_400_000),
      )
      const gmail = paginatingClient([...history, important('window-1', BOOT + 60_000)])
      const delivered: string[] = []

      const r = await tick(gmail, store, delivered, {
        activation_at: BOOT,
        backlog_page_size: 2,
        max_backlog_pages: 2,
      })

      // The sweep is still running...
      expect(r.backlog_sweeping).toBe(true)
      // ...and the owner has been told anyway.
      expect(r.escalated).toBe(1)
      expect(delivered.length).toBe(1)
      expect(delivered[0]).toContain('payment failed')
    })
  })

  test('the restricted pass classifies ONLY post-cutoff mail', async () => {
    await withStore(async (store) => {
      const history = Array.from({ length: 12 }, (_v, n) =>
        important(`old-${n}`, BOOT - (n + 1) * 86_400_000),
      )
      const gmail = paginatingClient(history)
      const delivered: string[] = []

      const r = await tick(gmail, store, delivered, {
        activation_at: BOOT,
        backlog_page_size: 2,
        max_backlog_pages: 2,
      })

      expect(r.backlog_sweeping).toBe(true)
      // Nothing escalated, nothing even READ — a body fetch is a classification,
      // and classifying the owner's back-catalogue is one conditional away from
      // escalating it.
      expect(delivered.length).toBe(0)
      expect(gmail.bodies_read.length).toBe(0)
      expect(gmail.modified.length).toBe(0)
    })
  })
})
