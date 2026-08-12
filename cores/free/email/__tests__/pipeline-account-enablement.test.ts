/**
 * Email pipeline — PER-ACCOUNT ENABLEMENT.
 *
 * The owner connects mailboxes for many reasons; wanting the agent to read one
 * of them is a separate decision. Before this, connecting any Google account
 * enrolled its entire history in the backlog sweep and its new mail in
 * escalation-to-chat.
 *
 * The promise these arms pin is stronger than "we ignore that mailbox": a
 * disabled account is NEVER QUERIED. Read-then-discard would still hit its API,
 * still surface its read failures in the tick, and would be a lie about what
 * the setting does — so the assertion is on the per-account client's call log,
 * not on the merged rows.
 *
 * IT FAILS CLOSED (owner decision, 2026-08-12). Absence of a row means DISABLED,
 * so an install where nothing has been enabled polls nothing at all. The first
 * cut defaulted the other way to keep a fresh install from looking broken; the
 * defaults are not symmetric, because a mailbox that posts to chat uninvited
 * cannot be un-posted while a quiet one costs a switch. The price is paid by
 * being LOUD, which is itself pinned here rather than left to a comment.
 *
 * Every fixture address is `*.example.com`.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildMultiAccountGmailClient,
  type GmailAccountDescriptor,
  type GmailClient,
  type GmailListInput,
  type GmailListResult,
  type GmailMessageFull,
  type GmailMessageMeta,
} from '../index.ts'
import { runEmailPipelineTick } from '../src/pipeline/poller.ts'
import { openEmailPipelineStore, type EmailPipelineStore } from '../src/pipeline/store.ts'

const BOOT = Date.parse('2026-08-12T09:00:00.000Z')
const FIRST_FIRE = BOOT + 5 * 60_000

const KEEP = 'keep'
const DROP = 'drop'

function meta(id: string, at: number): GmailMessageMeta {
  return {
    id,
    thread_id: `t-${id}`,
    subject: 'Action required: payment failed',
    from: 'Vendor Billing <billing@vendor.example.com>',
    snippet: 'declined',
    internal_date: new Date(at).toISOString(),
    label_ids: ['INBOX'],
  }
}

interface AccountFake {
  client: GmailClient
  lists: GmailListInput[]
  modified: string[]
}

function accountFake(rows: GmailMessageMeta[]): AccountFake {
  const lists: GmailListInput[] = []
  const modified: string[] = []
  const client = {
    async listMessages(input: GmailListInput): Promise<GmailListResult> {
      lists.push(input)
      return { results: rows }
    },
    async getMessage(input: { message_id: string }): Promise<GmailMessageFull> {
      const row = rows.find((r) => r.id === input.message_id)
      if (row === undefined) throw new Error(`no such message ${input.message_id}`)
      return {
        ...row,
        body_text: 'Your card was declined and the account is at risk.',
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
  } as unknown as GmailClient
  return { client, lists, modified }
}

function fanOut(fakes: Record<string, AccountFake>): GmailClient {
  return buildMultiAccountGmailClient({
    accounts: async (): Promise<GmailAccountDescriptor[]> =>
      Object.keys(fakes).map((id) => ({
        account_id: id,
        account_email: `${id}@example.com`,
        accessToken: async () => `token-${id}`,
      })),
    buildClient: (account) => (fakes[account.account_id] as AccountFake).client,
  })
}

function withStore(run: (store: EmailPipelineStore) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'email-enablement-'))
  const store = openEmailPipelineStore({ owner_home: home, now: () => FIRST_FIRE })
  return run(store).finally(() => {
    store.close()
    rmSync(home, { recursive: true, force: true })
  })
}

function tick(
  gmail: GmailClient,
  store: EmailPipelineStore,
  delivered: string[],
  now: () => number = () => FIRST_FIRE,
  log?: (message: string, fields?: Record<string, unknown>) => void,
): ReturnType<typeof runEmailPipelineTick> {
  return runEmailPipelineTick({
    gmail,
    store,
    ...(log !== undefined ? { log } : {}),
    classify: { cache_lookup: () => null, cache_store: () => undefined, llm: null },
    escalate: {
      deliver: async (_topic, envelope): Promise<unknown> => {
        delivered.push(envelope.body)
        return { prompt_id: 'p', persisted: true, delivered_live: true }
      },
      topic_id: 'app:owner',
      push: null,
      project_slug: 'instance',
    },
    now,
    activation_at: BOOT,
  })
}

describe('per-account enablement', () => {
  test('UNCONFIGURED IS DISABLED — with no rows, no mailbox is read at all', async () => {
    // THE DEFAULT, and the whole point of the owner's 2026-08-12 decision. A
    // mailbox connected for Calendar or Drive must not become one the agent
    // reads just because it is reachable. The cost — a fresh install that does
    // nothing — is real and is paid by the log arm below, not by the default.
    await withStore(async (store) => {
      const fakes = {
        [KEEP]: accountFake([meta('k-1', BOOT - 86_400_000)]),
        [DROP]: accountFake([meta('d-1', BOOT - 86_400_000)]),
      }
      const r = await tick(fanOut(fakes), store, [])

      expect(fakes[KEEP].lists).toEqual([])
      expect(fakes[DROP].lists).toEqual([])
      expect(r.scanned).toBe(0)
      expect(r.precutoff).toBe(0)
      // Not one row recorded either — an unenabled mailbox leaves no trace.
      expect(store.getEmail('k-1', KEEP)).toBeNull()
      expect(store.getEmail('d-1', DROP)).toBeNull()
    })
  })

  test('an unconfigured pipeline SAYS SO on every tick', async () => {
    // Failing closed is only defensible if the closed state is legible. A
    // pipeline that is deliberately silent and one that is broken look
    // identical in a log that reports only work done, and under an opt-in
    // default the silent case is where every new install starts.
    await withStore(async (store) => {
      const logged: string[] = []
      await tick(fanOut({ [KEEP]: accountFake([]) }), store, [], () => FIRST_FIRE, (m) =>
        logged.push(m),
      )
      const line = logged.find((m) => m.includes('no enabled accounts'))
      expect(line).toBeDefined()
      // It must distinguish "never configured" from "all switched off" — the
      // remedy differs, and a single message for both sends the owner looking
      // for a setting they never made.
      expect(line).toContain('none configured')

      // …and the other case says the other thing.
      const off: string[] = []
      store.setAccountEnabled(KEEP, true, null, BOOT)
      store.setAccountEnabled(KEEP, false, null, BOOT + 1_000)
      await tick(fanOut({ [KEEP]: accountFake([]) }), store, [], () => FIRST_FIRE, (m) =>
        off.push(m),
      )
      expect(off.find((m) => m.includes('every configured account is off'))).toBeDefined()
    })
  })

  test('a disabled-only row enables nothing — a typo is inert, not load-bearing', async () => {
    // Under the opt-out default this WAS destructive: the first row flipped the
    // pipeline into allow-list mode, so `disable typo` silenced every real
    // mailbox. Failing closed removes the hazard outright — a row nobody
    // enabled is indistinguishable from a row that does not exist.
    await withStore(async (store) => {
      store.setAccountEnabled('never-enabled-typo', false, null, BOOT)
      store.setAccountEnabled(KEEP, true, `${KEEP}@example.com`, BOOT)
      const fakes = {
        [KEEP]: accountFake([meta('k-1', BOOT - 86_400_000)]),
        [DROP]: accountFake([meta('d-1', BOOT - 86_400_000)]),
      }

      await tick(fanOut(fakes), store, [])

      expect(fakes[KEEP].lists.length).toBeGreaterThan(0)
      expect(fakes[DROP].lists).toEqual([])
    })
  })

  test('a backend that IGNORES account_ids still cannot reach a disabled mailbox', async () => {
    // The allow-list is applied at the QUERY, which is the property worth
    // having — a disabled mailbox is never contacted. But a guarantee that
    // depends on a remote honouring a request parameter is not a guarantee, so
    // the ingest path re-checks. Here the fan-out is replaced by a client that
    // returns rows for a mailbox that was never enabled.
    await withStore(async (store) => {
      store.setAccountEnabled(KEEP, true, `${KEEP}@example.com`, BOOT)
      const delivered: string[] = []
      const leaky = {
        async listMessages(): Promise<GmailListResult> {
          return {
            results: [
              // Old enough for the SWEEP to want to record it as history…
              { ...meta('leaked-old', BOOT - 300 * 86_400_000), account_id: DROP },
              // …and new enough for the LIVE pass to want to classify it.
              { ...meta('leaked-new', FIRST_FIRE + 1_000), account_id: DROP },
            ] as GmailMessageMeta[],
          }
        },
        async getMessage(): Promise<GmailMessageFull> {
          throw new Error('a disabled mailbox must never be read')
        },
        async ensureLabel(): Promise<{ label_id: string }> {
          return { label_id: 'Label_processed' }
        },
        async modifyMessage(): Promise<unknown> {
          throw new Error('a disabled mailbox must never be written')
        },
      } as unknown as GmailClient

      const r = await tick(leaky, store, delivered)

      expect(delivered).toEqual([])
      expect(r.scanned).toBe(0)
      // NOT EVEN A ROW. Recording someone's mail as history is not a harmless
      // read — it is a durable record of a mailbox the owner never turned on.
      expect(r.precutoff).toBe(0)
      expect(store.getEmail('leaked-old', DROP)).toBeNull()
      expect(store.getEmail('leaked-new', DROP)).toBeNull()

      // And a disabled mailbox appearing on a page must not drag the whole
      // pipeline back into a sweep on the next tick either: "this account has
      // no completion mark" is only a question worth asking about an account
      // that is switched on.
      const second = await tick(leaky, store, delivered)
      expect(second.backlog_sweeping).toBe(false)
    })
  })

  test('a disabled account is NEVER QUERIED — not queried then filtered', async () => {
    await withStore(async (store) => {
      store.setAccountEnabled(KEEP, true, `${KEEP}@example.com`, BOOT)
      store.setAccountEnabled(DROP, false, `${DROP}@example.com`, BOOT)
      const fakes = {
        [KEEP]: accountFake([meta('k-1', BOOT - 86_400_000)]),
        [DROP]: accountFake([meta('d-1', BOOT - 86_400_000)]),
      }

      await tick(fanOut(fakes), store, [])

      expect(fakes[KEEP].lists.length).toBeGreaterThan(0)
      // The whole promise of the setting, in one assertion.
      expect(fakes[DROP].lists).toEqual([])
      // And nothing was written about it: no row, no label, no archive.
      expect(store.getEmail('d-1', DROP)).toBeNull()
      expect(fakes[DROP].modified).toEqual([])
    })
  })

  test('EVERYTHING off is a decision, not an absence — no reads at all', async () => {
    await withStore(async (store) => {
      // Turned ON and then OFF again — a curated list the owner emptied, which
      // is different from a list that never existed. The pipeline honours it.
      store.setAccountEnabled(KEEP, true, `${KEEP}@example.com`, BOOT)
      store.setAccountEnabled(KEEP, false, `${KEEP}@example.com`, BOOT + 1_000)
      const fakes = { [KEEP]: accountFake([meta('k-1', BOOT - 86_400_000)]) }

      const r = await tick(fanOut(fakes), store, [])

      expect(fakes[KEEP].lists).toEqual([])
      expect(r.scanned).toBe(0)
      expect(r.precutoff).toBe(0)
    })
  })

  test('an account turned on LATER is swept from when it was turned on', async () => {
    await withStore(async (store) => {
      // KEEP is on from boot. DROP has a year of history and is switched on a
      // fortnight later — none of that history may reach the owner.
      store.setAccountEnabled(KEEP, true, `${KEEP}@example.com`, BOOT)
      const LATER = BOOT + 14 * 86_400_000
      const delivered: string[] = []

      const fakes = {
        [KEEP]: accountFake([meta('k-1', BOOT - 86_400_000)]),
        [DROP]: accountFake([
          meta('d-old', BOOT - 300 * 86_400_000),
          meta('d-older', BOOT - 320 * 86_400_000),
        ]),
      }
      const gmail = fanOut(fakes)

      await tick(gmail, store, delivered)
      expect(delivered).toEqual([])

      store.setAccountEnabled(DROP, true, `${DROP}@example.com`, LATER)
      let clock = LATER + 60_000
      await tick(gmail, store, delivered, () => clock)

      // Its back-catalogue is marked as history, not escalated.
      expect(delivered).toEqual([])
      expect(store.getEmail('d-old', DROP)?.handling).toBe('preexisting')
      expect(fakes[DROP].modified).toEqual([])

      // Mail that arrives AFTER it was switched on does reach the owner.
      const fresh = accountFake([meta('d-new', LATER + 30_000), meta('d-old', BOOT - 300 * 86_400_000)])
      const gmail2 = fanOut({ [KEEP]: fakes[KEEP], [DROP]: fresh })
      clock = LATER + 120_000
      await tick(gmail2, store, delivered, () => clock)
      expect(delivered.length).toBe(1)
    })
  })

  test('the enable-time boundary is ENABLED_AT, not whenever the sweep got round to it', async () => {
    // The sweep can run long after the switch was flipped — the cron was down,
    // the box was asleep, the tick was busy elsewhere. Stamping the boundary at
    // sweep time instead of enable time silently files everything that arrived
    // in the gap as history the owner had already triaged.
    await withStore(async (store) => {
      const LATER = BOOT + 14 * 86_400_000
      const SWEPT_AT = LATER + 3 * 86_400_000
      const delivered: string[] = []

      store.setAccountEnabled(KEEP, true, `${KEEP}@example.com`, BOOT)
      await tick(fanOut({ [KEEP]: accountFake([]) }), store, delivered)

      store.setAccountEnabled(DROP, true, `${DROP}@example.com`, LATER)
      const fakes = {
        [KEEP]: accountFake([]),
        [DROP]: accountFake([
          meta('d-history', BOOT - 300 * 86_400_000),
          // One hour after the owner switched it on, three days before the
          // sweep actually ran.
          meta('d-in-the-gap', LATER + 3_600_000),
        ]),
      }
      await tick(fanOut(fakes), store, delivered, () => SWEPT_AT)

      expect(store.getEmail('d-history', DROP)?.handling).toBe('preexisting')
      expect(delivered.length).toBe(1)
      expect(store.getEmail('d-in-the-gap', DROP)?.handling).toBe('escalate')
    })
  })

  test('OFF then ON again is a new sweep — mail that piled up while it was off is history', async () => {
    // The stale completion marker is the trap. An account that has already been
    // swept carries `backlog_marked:<id>='1'` forever, and the sweep only
    // re-opens for accounts WITHOUT that mark — so a re-enabled mailbox skipped
    // straight to steady state and everything that accumulated while it was off
    // went to the classifier, and to chat.
    await withStore(async (store) => {
      const delivered: string[] = []
      store.setAccountEnabled(DROP, true, `${DROP}@example.com`, BOOT)

      // Swept once, while on.
      const first = accountFake([meta('d-original', BOOT - 86_400_000)])
      await tick(fanOut({ [DROP]: first }), store, delivered)
      expect(store.getEmail('d-original', DROP)?.handling).toBe('preexisting')

      // Off for a fortnight. Important mail arrives during the silence.
      const OFF_AT = BOOT + 86_400_000
      const BACK_ON = BOOT + 14 * 86_400_000
      store.setAccountEnabled(DROP, false, null, OFF_AT)
      const whileOff = meta('d-while-off', BOOT + 7 * 86_400_000)

      store.setAccountEnabled(DROP, true, null, BACK_ON)
      const after = accountFake([whileOff, meta('d-original', BOOT - 86_400_000)])
      await tick(fanOut({ [DROP]: after }), store, delivered, () => BACK_ON + 60_000)

      // The CLI promises "only mail arriving after you turned it on". A message
      // from the silent fortnight is not that.
      expect(delivered).toEqual([])
      expect(store.getEmail('d-while-off', DROP)?.handling).toBe('preexisting')
      expect(after.modified).toEqual([])
    })
  })

  test('an owed escalation for a disabled account is left alone, not delivered', async () => {
    await withStore(async (store) => {
      store.setAccountEnabled(KEEP, true, `${KEEP}@example.com`, BOOT)
      store.setAccountEnabled(DROP, false, `${DROP}@example.com`, BOOT)
      // A row from before it was switched off, still owed a chat post.
      store.insertEmail({
        id: 'd-owed',
        thread_id: 't-d-owed',
        account_id: DROP,
        sender: 'billing@vendor.example.com',
        subject: 'Action required: payment failed',
        received_at: BOOT,
        processed_at: BOOT,
        category: 'billing',
        handling: 'escalate',
        escalation_attempts: 1,
      })
      const delivered: string[] = []

      await tick(fanOut({ [KEEP]: accountFake([]) }), store, delivered)

      expect(delivered).toEqual([])
      // Left retryable rather than consumed — switching the account back on
      // must not have silently burned the attempt.
      expect(store.getEmail('d-owed', DROP)?.escalated_at ?? null).toBeNull()
    })
  })
})
