/**
 * Email pipeline — the BACKLOG SWEEP's completion boundaries.
 *
 * The sweep is the only thing standing between "switch the pipeline on" and
 * "escalate a decade of old mail into the owner's chat". It ends by declaring
 * `backlog_marked='1'`, after which everything not already recorded is treated
 * as new and is eligible to escalate. So EVERY way the sweep can wrongly
 * believe it is finished is an escalation-of-old-mail bug, and that is what
 * these arms pin.
 *
 * Two of them are regressions of a real defect: the sweep read a missing
 * `next_page_token` as "no more mail", but the multi-account fan-out omits that
 * cursor whenever more than one account is connected, so a two-mailbox install
 * marked one page and let the entire remaining history through.
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
  GmailMessageMeta,
} from '../src/contract.ts'
import {
  CHECKPOINT_BACKLOG_DONE,
  runEmailPipelineTick,
} from '../src/pipeline/poller.ts'
import { openEmailPipelineStore, type EmailPipelineStore } from '../src/pipeline/store.ts'

const NOW = Date.parse('2026-08-12T09:00:00.000Z')

function msg(id: string, account_id?: string): GmailMessageMeta {
  return {
    id,
    thread_id: `thread-${id}`,
    subject: 'Action required: payment failed',
    from: 'Vendor Billing <billing@vendor.example.com>',
    snippet: 'old',
    internal_date: new Date(NOW - 86_400_000).toISOString(),
    label_ids: ['INBOX'],
    ...(account_id !== undefined ? { account_id } : {}),
  } as GmailMessageMeta
}

/** A page script: each call returns the next entry. */
function scriptedClient(pages: GmailListResult[]): GmailClient & { calls: GmailListInput[] } {
  const calls: GmailListInput[] = []
  let i = 0
  const die = (): never => {
    throw new Error('the backlog sweep must not touch anything but listMessages')
  }
  return {
    calls,
    async listMessages(input: GmailListInput): Promise<GmailListResult> {
      calls.push(input)
      return pages[Math.min(i++, pages.length - 1)] as GmailListResult
    },
    getMessage: die,
    getThread: die,
    search: die,
    createDraft: die,
    sendMessage: die,
    ensureProjectLabel: die,
    ensureLabel: die,
    modifyThread: die,
    modifyMessage: die,
  } as unknown as GmailClient & { calls: GmailListInput[] }
}

function withStore(run: (store: EmailPipelineStore) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'email-sweep-'))
  const store = openEmailPipelineStore({ owner_home: home, now: () => NOW })
  return run(store).finally(() => {
    store.close()
    rmSync(home, { recursive: true, force: true })
  })
}

function tick(gmail: GmailClient, store: EmailPipelineStore): ReturnType<typeof runEmailPipelineTick> {
  return runEmailPipelineTick({
    gmail,
    store,
    classify: { cache_lookup: () => null, cache_store: () => undefined, llm: null },
    escalate: {
      deliver: async (): Promise<unknown> => {
        throw new Error('the sweep must never escalate')
      },
      topic_id: 'app:owner',
      push: null,
      project_slug: 'instance',
    },
    now: () => NOW,
  })
}

describe('backlog sweep completion', () => {
  test('MULTI-ACCOUNT: an absent next_page_token does NOT mean finished', async () => {
    await withStore(async (store) => {
      // Exactly what the fan-out returns for 2+ accounts: no merged cursor,
      // but per-account cursors saying both mailboxes have more.
      const gmail = scriptedClient([
        {
          results: [msg('a-1', 'acct-a'), msg('b-1', 'acct-b')],
          next_page_tokens: { 'acct-a': 'cursor-a2', 'acct-b': 'cursor-b2' },
          accounts: [
            { account_id: 'acct-a', account_email: 'a@example.com', ok: true },
            { account_id: 'acct-b', account_email: 'b@example.com', ok: true },
          ],
        },
        {
          results: [msg('a-2', 'acct-a')],
          next_page_tokens: {},
          accounts: [
            { account_id: 'acct-a', account_email: 'a@example.com', ok: true },
            { account_id: 'acct-b', account_email: 'b@example.com', ok: true },
          ],
        },
      ])

      const first = await tick(gmail, store)
      expect(first.backlog_sweeping).toBe(true)
      // THE REGRESSION: this used to be '1' here, and the rest of the owner's
      // history would have gone on to be classified and escalated.
      expect(store.getCheckpoint(CHECKPOINT_BACKLOG_DONE)).not.toBe('1')

      const second = await tick(gmail, store)
      expect(second.backlog_sweeping).toBe(true)
      expect(store.getCheckpoint(CHECKPOINT_BACKLOG_DONE)).toBe('1')

      // The second page resumed each account from ITS OWN cursor.
      expect(gmail.calls[1]?.page_tokens).toEqual({ 'acct-a': 'cursor-a2', 'acct-b': 'cursor-b2' })
    })
  })

  test('PARTIAL FAILURE: one account down does not let the sweep declare completion', async () => {
    await withStore(async (store) => {
      const gmail = scriptedClient([
        {
          results: [msg('a-1', 'acct-a')],
          next_page_tokens: {},
          accounts: [
            { account_id: 'acct-a', account_email: 'a@example.com', ok: true },
            // Never answered — its mailbox is entirely unexamined.
            { account_id: 'acct-b', account_email: 'b@example.com', ok: false, error: 'token expired' },
          ],
        },
      ])
      await tick(gmail, store)
      expect(store.getCheckpoint(CHECKPOINT_BACKLOG_DONE)).not.toBe('1')
    })
  })

  test('SINGLE ACCOUNT: exhausted cursors DO complete the sweep', async () => {
    await withStore(async (store) => {
      const gmail = scriptedClient([{ results: [msg('solo-1')], next_page_tokens: {} }])
      const r = await tick(gmail, store)
      expect(r.precutoff).toBe(1)
      expect(store.getCheckpoint(CHECKPOINT_BACKLOG_DONE)).toBe('1')
    })
  })

  test('ACCOUNT-LOCAL IDS: the same message id in two mailboxes is two messages', async () => {
    await withStore(async (store) => {
      // Gmail ids are per-account; a collision must not make the second one
      // look already-handled.
      const gmail = scriptedClient([
        {
          results: [msg('shared-id', 'acct-a'), msg('shared-id', 'acct-b')],
          next_page_tokens: {},
          accounts: [
            { account_id: 'acct-a', account_email: 'a@example.com', ok: true },
            { account_id: 'acct-b', account_email: 'b@example.com', ok: true },
          ],
        },
      ])
      const r = await tick(gmail, store)
      expect(r.precutoff).toBe(2)
      expect(store.getEmail('shared-id', 'acct-a')).not.toBeNull()
      expect(store.getEmail('shared-id', 'acct-b')).not.toBeNull()
    })
  })
})

describe('a mailbox connected AFTER the sweep gets its own sweep', () => {
  test('acct-b joining later does not have its history escalated', async () => {
    await withStore(async (store) => {
      // Sweep completes with only acct-a connected.
      const withA = scriptedClient([
        {
          results: [msg('a-1', 'acct-a')],
          next_page_tokens: {},
          accounts: [{ account_id: 'acct-a', account_email: 'a@example.com', ok: true }],
        },
      ])
      await tick(withA, store)
      expect(store.getCheckpoint(CHECKPOINT_BACKLOG_DONE)).toBe('1')

      // Now acct-b is connected, carrying old mail shaped exactly like the
      // escalation. The connected set is re-resolved per request, so the global
      // "backlog done" flag was a claim about a topology that no longer exists.
      const withBoth = scriptedClient([
        {
          results: [msg('a-1', 'acct-a'), msg('b-old', 'acct-b')],
          next_page_tokens: {},
          accounts: [
            { account_id: 'acct-a', account_email: 'a@example.com', ok: true },
            { account_id: 'acct-b', account_email: 'b@example.com', ok: true },
          ],
        },
      ])
      const second = await tick(withBoth, store)

      // THE REGRESSION: this used to skip the sweep entirely and treat b-old as
      // new mail — classified, labelled and escalated into the owner's chat.
      expect(second.backlog_sweeping).toBe(true)
      expect(store.getEmail('b-old', 'acct-b')?.handling).toBe('preexisting')
      expect(second.escalated).toBe(0)
    })
  })
})

describe('a re-opened sweep does not bury live mail in an already-swept mailbox', () => {
  test("acct-a's NEW message survives acct-b's sweep", async () => {
    await withStore(async (store) => {
      const withA = scriptedClient([
        {
          results: [msg('a-1', 'acct-a')],
          next_page_tokens: {},
          accounts: [{ account_id: 'acct-a', account_email: 'a@example.com', ok: true }],
        },
      ])
      await tick(withA, store)

      // acct-b is connected, AND a genuinely new billing message has just
      // arrived in acct-a. The re-opened sweep sees both.
      const withBoth = scriptedClient([
        {
          results: [msg('a-new', 'acct-a'), msg('b-old', 'acct-b')],
          next_page_tokens: {},
          accounts: [
            { account_id: 'acct-a', account_email: 'a@example.com', ok: true },
            { account_id: 'acct-b', account_email: 'b@example.com', ok: true },
          ],
        },
      ])
      await tick(withBoth, store)

      // acct-b's history is marked...
      expect(store.getEmail('b-old', 'acct-b')?.handling).toBe('preexisting')
      // ...but acct-a's new message must NOT be. Marking it would bury a
      // message the owner should have been told about, permanently and
      // indistinguishably from history.
      expect(store.getEmail('a-new', 'acct-a')).toBeNull()
    })
  })
})

describe('a new mailbox whose probe FAILS still gets its sweep', () => {
  test('a transient probe failure does not let acct-b bypass the backlog', async () => {
    await withStore(async (store) => {
      const withA = scriptedClient([
        {
          results: [msg('a-1', 'acct-a')],
          next_page_tokens: {},
          accounts: [{ account_id: 'acct-a', account_email: 'a@example.com', ok: true }],
        },
      ])
      await tick(withA, store)

      // The probe sees acct-b, but acct-b's request FAILED. It is connected all
      // the same — reading "not ok" as "not present" left it unswept, and the
      // same tick then read its history as new mail once it recovered.
      const probeFailsForB = scriptedClient([
        {
          results: [msg('a-1', 'acct-a')],
          next_page_tokens: {},
          accounts: [
            { account_id: 'acct-a', account_email: 'a@example.com', ok: true },
            { account_id: 'acct-b', account_email: 'b@example.com', ok: false, error: 'token expired' },
          ],
        },
      ])
      const r = await tick(probeFailsForB, store)
      expect(r.backlog_sweeping).toBe(true)
      // acct-b is still unmarked, so the sweep stays open for it.
      expect(store.getCheckpoint(`backlog_marked:acct-b`)).not.toBe('1')
    })
  })
})

describe('mailboxes of UNEQUAL depth converge', () => {
  test('A with 2 pages and B with 3 does not oscillate forever', async () => {
    await withStore(async (store) => {
      // The oscillation: the fan-out reports a cursor only for accounts that
      // still have a page, and an account ABSENT from the map restarts at its
      // newest page. So {B:p2} restarted A, whose {A:p1} restarted B, forever —
      // the sweep never completed and the backlog never got marked.
      const pages: GmailListResult[] = [
        {
          results: [msg('a-1', 'acct-a'), msg('b-1', 'acct-b')],
          next_page_tokens: { 'acct-a': 'a-p2', 'acct-b': 'b-p2' },
          accounts: [
            { account_id: 'acct-a', account_email: 'a@example.com', ok: true },
            { account_id: 'acct-b', account_email: 'b@example.com', ok: true },
          ],
        },
        {
          // A is finished here; B still has one more.
          results: [msg('a-2', 'acct-a'), msg('b-2', 'acct-b')],
          next_page_tokens: { 'acct-b': 'b-p3' },
          accounts: [
            { account_id: 'acct-a', account_email: 'a@example.com', ok: true },
            { account_id: 'acct-b', account_email: 'b@example.com', ok: true },
          ],
        },
        {
          results: [msg('b-3', 'acct-b')],
          next_page_tokens: {},
          accounts: [
            { account_id: 'acct-a', account_email: 'a@example.com', ok: true },
            { account_id: 'acct-b', account_email: 'b@example.com', ok: true },
          ],
        },
      ]
      const gmail = scriptedClient(pages)

      // Three sweep ticks must CONVERGE, not alternate.
      await tick(gmail, store)
      await tick(gmail, store)
      const third = await tick(gmail, store)

      expect(store.getCheckpoint(CHECKPOINT_BACKLOG_DONE)).toBe('1')
      expect(third.backlog_sweeping).toBe(true)
      // A is carried forward as EXHAUSTED once it runs out, rather than being
      // dropped from the map and restarted.
      expect(gmail.calls[2]?.page_tokens?.['acct-a']).toBe('__neutron_exhausted__')
      expect(gmail.calls[2]?.page_tokens?.['acct-b']).toBe('b-p3')
    })
  })
})
