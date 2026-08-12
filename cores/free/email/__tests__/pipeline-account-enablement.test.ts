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
): ReturnType<typeof runEmailPipelineTick> {
  return runEmailPipelineTick({
    gmail,
    store,
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
  test('UNCONFIGURED is not disabled — with no rows, every account is read', async () => {
    await withStore(async (store) => {
      const fakes = {
        [KEEP]: accountFake([meta('k-1', BOOT - 86_400_000)]),
        [DROP]: accountFake([meta('d-1', BOOT - 86_400_000)]),
      }
      await tick(fanOut(fakes), store, [])
      // A fresh install must not silently do nothing.
      expect(fakes[KEEP].lists.length).toBeGreaterThan(0)
      expect(fakes[DROP].lists.length).toBeGreaterThan(0)
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
      store.setAccountEnabled(KEEP, false, `${KEEP}@example.com`, BOOT)
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
