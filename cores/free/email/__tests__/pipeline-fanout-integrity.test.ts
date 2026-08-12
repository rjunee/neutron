/**
 * Email pipeline — the FAN-OUT boundaries, exercised through the REAL
 * multi-account client rather than a scripted merged page.
 *
 * `pipeline-backlog-sweep.test.ts` hands the poller a pre-merged result, so it
 * pins how the poller reacts to a merge but proves nothing about the merge
 * itself. Every defect below lived in `multi-account.ts` and was invisible to
 * that shape of test:
 *
 *   1. The merged set was capped to `max_results` while EVERY account's cursor
 *      advanced past everything it returned — so with two mailboxes the
 *      overflow was never marked `preexisting`, and became eligible for live
 *      classification the moment the sweep completed. Backlog escalation, from
 *      inside the sweep that exists to prevent it.
 *   2. The merge deduped by message id alone. Gmail ids are ACCOUNT-LOCAL, so a
 *      collision silently dropped the second mailbox's message.
 *   3. `getMessage` took no account selector, so a colliding id was read from
 *      whichever mailbox answered first — the WRONG body, classified as if it
 *      belonged to the row being processed.
 *   4. A failed label/archive call was permanent: the row was already written,
 *      `hasEmail` skipped it forever, and the Gmail write was never retried.
 *
 * Every fixture address is `*.example.com`.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildMultiAccountGmailClient,
  MessageNotFoundError,
  type GmailAccountDescriptor,
  type GmailClient,
  type GmailMessageMeta,
} from '../index.ts'
import {
  CHECKPOINT_BACKLOG_DONE,
  runEmailPipelineTick,
} from '../src/pipeline/poller.ts'
import { openEmailPipelineStore, type EmailPipelineStore } from '../src/pipeline/store.ts'

const NOW = Date.parse('2026-08-12T09:00:00.000Z')

/** A subject the deterministic cascade rates IMPORTANT, with no LLM in play. */
const IMPORTANT_SUBJECT = 'Action required: payment failed'
const ORDINARY_SUBJECT = 'Weekly design notes'

interface FakeMessage {
  id: string
  subject?: string
  /** Distinguishes one mailbox's copy of a colliding id from the other's. */
  body?: string
  minutes_old?: number
}

interface FakeAccount {
  id: string
  /** Successive pages this mailbox returns, oldest cursor first. */
  pages: FakeMessage[][]
  /** Throw from `modifyMessage` until this many calls have been made. */
  fail_modify_times?: number
}

interface FakeMailbox {
  client: GmailClient
  /** Every message this mailbox was asked to modify, in order. */
  modified: Array<{ id: string; add: string[]; remove: string[] }>
  /** Every message body this mailbox served. */
  read: string[]
}

function toMeta(m: FakeMessage): GmailMessageMeta {
  return {
    id: m.id,
    thread_id: `t-${m.id}`,
    subject: m.subject ?? ORDINARY_SUBJECT,
    from: 'Vendor Billing <billing@vendor.example.com>',
    snippet: '',
    internal_date: new Date(NOW - (m.minutes_old ?? 60) * 60_000).toISOString(),
    label_ids: ['INBOX'],
  }
}

/**
 * One mailbox. Pages are addressed by an opaque cursor exactly as Gmail's are:
 * absent ⇒ page 0, `p<N>` ⇒ page N. Nothing here knows the merge exists.
 */
function fakeMailbox(account: FakeAccount): FakeMailbox {
  const modified: FakeMailbox['modified'] = []
  const read: string[] = []
  let modifyCalls = 0
  const all = account.pages.flat()
  const notImplemented = (): never => {
    throw new Error('not used in this test')
  }
  const client: GmailClient = {
    async listMessages(input) {
      const index =
        input.page_token === undefined ? 0 : Number(input.page_token.replace(/^p/, ''))
      const page = account.pages[index] ?? []
      const more = index + 1 < account.pages.length
      return {
        results: page.map(toMeta),
        ...(more ? { next_page_token: `p${index + 1}` } : {}),
      }
    },
    async search() {
      return { results: all.map(toMeta) }
    },
    async getMessage(input) {
      const found = all.find((r) => r.id === input.message_id)
      if (found === undefined) throw new MessageNotFoundError(input.message_id)
      const body = found.body ?? `body-${account.id}-${found.id}`
      read.push(body)
      return { ...toMeta(found), to: [], cc: [], body_text: body }
    },
    getThread: notImplemented,
    createDraft: notImplemented,
    sendMessage: notImplemented,
    ensureProjectLabel: notImplemented,
    async ensureLabel(input) {
      return { label_id: `label-${account.id}`, label_name: input.name, created: false }
    },
    modifyThread: notImplemented,
    async modifyMessage(input) {
      modifyCalls++
      if (modifyCalls <= (account.fail_modify_times ?? 0)) {
        throw new Error(`gmail 503 on ${input.message_id}`)
      }
      const found = all.find((r) => r.id === input.message_id)
      if (found === undefined) throw new MessageNotFoundError(input.message_id)
      modified.push({
        id: input.message_id,
        add: [...input.add_label_ids],
        remove: [...(input.remove_label_ids ?? [])],
      })
      return { message_id: input.message_id, label_ids: [...input.add_label_ids] }
    },
  }
  return { client, modified, read }
}

function fanOut(accounts: FakeAccount[]): {
  gmail: GmailClient
  mailboxes: Map<string, FakeMailbox>
} {
  const mailboxes = new Map(accounts.map((a) => [a.id, fakeMailbox(a)]))
  const gmail = buildMultiAccountGmailClient({
    accounts: async (): Promise<GmailAccountDescriptor[]> =>
      accounts.map((a) => ({
        account_id: a.id,
        account_email: `${a.id}@example.com`,
        accessToken: async () => `token-${a.id}`,
      })),
    buildClient: (account) =>
      (mailboxes.get(account.account_id) as FakeMailbox).client,
  })
  return { gmail, mailboxes }
}

function withStore(run: (store: EmailPipelineStore) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'email-fanout-'))
  const store = openEmailPipelineStore({ owner_home: home, now: () => NOW })
  return run(store).finally(() => {
    store.close()
    rmSync(home, { recursive: true, force: true })
  })
}

function tick(
  gmail: GmailClient,
  store: EmailPipelineStore,
  delivered: string[],
  over: { backlog_page_size?: number; max_results?: number } = {},
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
      deliver: async (_topic_id, envelope): Promise<unknown> => {
        delivered.push(envelope.body)
        return { prompt_id: 'p1', persisted: true, delivered_live: true }
      },
      topic_id: 'app:owner',
      push: null,
      project_slug: 'instance',
    },
    now: () => NOW,
    // One page per tick: this suite steps the sweep deliberately to assert each
    // mailbox resumes from ITS OWN cursor. Production pages within the tick.
    max_backlog_pages: 1,
    ...over,
  })
}

/** Run ticks until the sweep declares itself complete, or the guard trips. */
async function sweepToCompletion(
  gmail: GmailClient,
  store: EmailPipelineStore,
  delivered: string[],
  backlog_page_size: number,
): Promise<number> {
  let ticks = 0
  while (store.getCheckpoint(CHECKPOINT_BACKLOG_DONE) !== '1') {
    if (++ticks > 20) throw new Error('sweep did not converge')
    await tick(gmail, store, delivered, { backlog_page_size })
  }
  return ticks
}

describe('backlog sweep over the real fan-out', () => {
  test('TWO MAILBOXES, OVERFLOWING PAGE: every row read is marked, none escape into live mail', async () => {
    await withStore(async (store) => {
      // Each account returns a FULL page of 3 for a page size of 3, so the
      // merge holds 6. Capping back to 3 while both cursors advanced was the
      // defect: the other 3 were never marked and, once the sweep completed,
      // were classified and escalated as new mail.
      const { gmail } = fanOut([
        { id: 'acct-a', pages: [[{ id: 'a-1' }, { id: 'a-2' }, { id: 'a-3' }]] },
        {
          id: 'acct-b',
          // One of these is the exact escalation the sweep exists to suppress.
          pages: [
            [{ id: 'b-1', subject: IMPORTANT_SUBJECT }, { id: 'b-2' }, { id: 'b-3' }],
          ],
        },
      ])
      const delivered: string[] = []

      await sweepToCompletion(gmail, store, delivered, 3)

      for (const id of ['a-1', 'a-2', 'a-3']) {
        expect(store.getEmail(id, 'acct-a')?.handling).toBe('preexisting')
      }
      for (const id of ['b-1', 'b-2', 'b-3']) {
        expect(store.getEmail(id, 'acct-b')?.handling).toBe('preexisting')
      }

      // The sweep is over and the whole inbox is accounted for, so a steady
      // -state tick has nothing new to see and nothing to say.
      const after = await tick(gmail, store, delivered)
      expect(after.backlog_sweeping).toBe(false)
      expect(after.scanned).toBe(0)
      expect(delivered).toEqual([])
    })
  })

  test('MULTI-PAGE: each mailbox is paged to exhaustion from its own cursor', async () => {
    await withStore(async (store) => {
      const { gmail } = fanOut([
        { id: 'acct-a', pages: [[{ id: 'a-1' }], [{ id: 'a-2' }], [{ id: 'a-3' }]] },
        { id: 'acct-b', pages: [[{ id: 'b-1' }]] },
      ])
      const delivered: string[] = []

      const ticks = await sweepToCompletion(gmail, store, delivered, 2)

      expect(ticks).toBeGreaterThan(1)
      for (const id of ['a-1', 'a-2', 'a-3']) {
        expect(store.hasEmail(id, 'acct-a')).toBe(true)
      }
      expect(store.hasEmail('b-1', 'acct-b')).toBe(true)
    })
  })

  test('THE SWEEP NEVER WRITES: a two-mailbox backlog is left exactly as the owner left it', async () => {
    await withStore(async (store) => {
      const { gmail, mailboxes } = fanOut([
        { id: 'acct-a', pages: [[{ id: 'a-1', subject: IMPORTANT_SUBJECT }]] },
        { id: 'acct-b', pages: [[{ id: 'b-1', subject: IMPORTANT_SUBJECT }]] },
      ])
      const delivered: string[] = []

      await sweepToCompletion(gmail, store, delivered, 5)

      expect(delivered).toEqual([])
      for (const box of mailboxes.values()) {
        expect(box.modified).toEqual([])
        expect(box.read).toEqual([])
      }
    })
  })
})

describe('account-local message ids', () => {
  test('COLLISION: both messages survive the merge and each body comes from its OWN mailbox', async () => {
    await withStore(async (store) => {
      const { gmail } = fanOut([
        { id: 'acct-a', pages: [[{ id: 'shared', body: 'BODY FROM A' }]] },
        { id: 'acct-b', pages: [[{ id: 'shared', body: 'BODY FROM B' }]] },
      ])
      const delivered: string[] = []

      // Mark the backlog against an EMPTY inbox first, so the collision below
      // arrives as live mail rather than history.
      const empty = fanOut([
        { id: 'acct-a', pages: [[]] },
        { id: 'acct-b', pages: [[]] },
      ])
      await sweepToCompletion(empty.gmail, store, delivered, 5)

      const live = await tick(gmail, store, delivered)

      // Two distinct rows, not one: the merge deduped by id alone before.
      expect(live.scanned).toBe(2)
      expect(store.hasEmail('shared', 'acct-a')).toBe(true)
      expect(store.hasEmail('shared', 'acct-b')).toBe(true)

      // And each row carries ITS OWN mailbox's body — the by-id probe used to
      // serve whichever account answered first, for both rows.
      expect(store.getEmail('shared', 'acct-a')?.body_text).toBe('BODY FROM A')
      expect(store.getEmail('shared', 'acct-b')?.body_text).toBe('BODY FROM B')
    })
  })
})

describe('an owed Gmail write is finished, not forgotten', () => {
  test('ARCHIVE: a failed label call is retried on the next tick and the message is archived', async () => {
    await withStore(async (store) => {
      const { gmail, mailboxes } = fanOut([
        { id: 'solo', pages: [[]], fail_modify_times: 1 },
      ])
      const delivered: string[] = []
      await sweepToCompletion(gmail, store, delivered, 5)

      // Now the same mailbox has one ordinary message. Its archive call throws.
      const live = fanOut([
        { id: 'solo', pages: [[{ id: 'm-1' }]], fail_modify_times: 1 },
      ])
      const first = await tick(live.gmail, store, delivered)
      expect(first.errors).toBe(1)
      expect(first.archived).toBe(0)
      // The row exists — so `hasEmail` alone would skip it forever...
      expect(store.hasEmail('m-1', 'solo')).toBe(true)
      // ...which is why the owed write is its OWN fact.
      expect(store.getEmail('m-1', 'solo')?.mutated_at).toBe(null)

      const second = await tick(live.gmail, store, delivered)
      expect(second.remutated).toBe(1)
      expect(second.errors).toBe(0)
      expect(store.getEmail('m-1', 'solo')?.mutated_at).toBe(NOW)

      const box = live.mailboxes.get('solo') as FakeMailbox
      expect(box.modified).toEqual([
        { id: 'm-1', add: ['label-solo'], remove: ['INBOX'] },
      ])
    })
  })

  test('ESCALATE: the owner is told even when the label write fails, and is told only once', async () => {
    await withStore(async (store) => {
      const seed = fanOut([{ id: 'solo', pages: [[]] }])
      const delivered: string[] = []
      await sweepToCompletion(seed.gmail, store, delivered, 5)

      const live = fanOut([
        {
          id: 'solo',
          pages: [[{ id: 'm-1', subject: IMPORTANT_SUBJECT }]],
          fail_modify_times: 1,
        },
      ])

      const first = await tick(live.gmail, store, delivered)
      // DELIVERY IS NOT GATED ON BOOKKEEPING. The label write failed; the
      // owner was told anyway. The old order escalated AFTER the mutation, so
      // this message would have been silently lost.
      expect(first.escalated).toBe(1)
      expect(delivered).toHaveLength(1)
      expect(store.getEmail('m-1', 'solo')?.escalated_at).toBe(NOW)
      expect(store.getEmail('m-1', 'solo')?.mutated_at).toBe(null)

      const second = await tick(live.gmail, store, delivered)
      expect(second.remutated).toBe(1)
      // Retrying the WRITE must not re-post to chat.
      expect(delivered).toHaveLength(1)

      const box = live.mailboxes.get('solo') as FakeMailbox
      // An escalated message KEEPS its INBOX label.
      expect(box.modified).toEqual([{ id: 'm-1', add: ['label-solo'], remove: [] }])
    })
  })

  test('THE CAP: a mutation that keeps failing stops being retried instead of spinning forever', async () => {
    await withStore(async (store) => {
      const seed = fanOut([{ id: 'solo', pages: [[]] }])
      const delivered: string[] = []
      await sweepToCompletion(seed.gmail, store, delivered, 5)

      const live = fanOut([
        { id: 'solo', pages: [[{ id: 'm-1' }]], fail_modify_times: 999 },
      ])
      await tick(live.gmail, store, delivered)
      let attempts = 0
      for (let i = 0; i < 8; i++) {
        await tick(live.gmail, store, delivered)
        attempts = store.getEmail('m-1', 'solo')?.mutation_attempts ?? 0
      }
      // Bounded by max_escalation_attempts (5), not unbounded.
      expect(attempts).toBe(5)
      expect(store.getEmail('m-1', 'solo')?.mutated_at).toBe(null)
    })
  })
})

describe('the cap and the cursor cannot disagree', () => {
  test('DISPLAY PATH: a capped merge withholds the cursors and says it was capped', async () => {
    const { gmail } = fanOut([
      { id: 'acct-a', pages: [[{ id: 'a-1' }, { id: 'a-2' }], [{ id: 'a-3' }]] },
      { id: 'acct-b', pages: [[{ id: 'b-1' }, { id: 'b-2' }], [{ id: 'b-3' }]] },
    ])
    const capped = await gmail.listMessages({ label: 'INBOX', max_results: 2 })
    expect(capped.results).toHaveLength(2)
    expect(capped.truncated).toBe(true)
    // THE POINT: no cursor. One that advanced past the two dropped rows would
    // make them unreachable forever.
    expect(capped.next_page_token).toBeUndefined()
    expect(capped.next_page_tokens).toBeUndefined()

    const full = await gmail.listMessages({
      label: 'INBOX',
      max_results: 2,
      exhaustive: true,
    })
    expect(full.results).toHaveLength(4)
    expect(full.truncated).toBeUndefined()
    expect(full.next_page_tokens).toEqual({ 'acct-a': 'p1', 'acct-b': 'p1' })
  })

  test('THE SWEEP REFUSES a truncated page rather than completing over a partial inbox', async () => {
    await withStore(async (store) => {
      const { gmail } = fanOut([
        { id: 'acct-a', pages: [[{ id: 'a-1' }, { id: 'a-2' }]] },
        { id: 'acct-b', pages: [[{ id: 'b-1' }, { id: 'b-2' }]] },
      ])
      // A client that quietly ignores `exhaustive` — the failure mode the
      // guard exists for. It reports the cap, and the sweep must not complete.
      const capping: GmailClient = {
        ...gmail,
        listMessages: async (input) =>
          await gmail.listMessages({ ...input, exhaustive: false }),
      }
      const delivered: string[] = []
      await expect(tick(capping, store, delivered, { backlog_page_size: 2 })).rejects.toThrow(
        /TRUNCATED/,
      )
      expect(store.getCheckpoint(CHECKPOINT_BACKLOG_DONE)).not.toBe('1')
    })
  })
})
