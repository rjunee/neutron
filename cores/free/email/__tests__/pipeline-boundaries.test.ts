/**
 * Email pipeline — the failure BOUNDARIES between steps.
 *
 * Every arm here is a regression of a defect found by cross-model review, and
 * they share a shape: a step succeeded, the step after it failed, and the
 * system then drew the wrong conclusion about what had happened.
 *
 *   - a poll page full of already-handled mail concluded "no new mail"
 *   - a durable chat post whose local acknowledgement failed concluded
 *     "not delivered", and said it again
 *   - a write aimed at a disconnected account concluded "try another mailbox"
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
import { buildMultiAccountGmailClient } from '../src/multi-account.ts'
import { escalateEmail } from '../src/pipeline/escalate.ts'
import {
  backlogDoneKey,
  CHECKPOINT_BACKLOG_DONE,
  runEmailPipelineTick,
} from '../src/pipeline/poller.ts'
import { openEmailPipelineStore, type EmailPipelineStore } from '../src/pipeline/store.ts'

const NOW = Date.parse('2026-08-12T09:00:00.000Z')

function meta(id: string, subject = 'Action required: payment failed'): GmailMessageMeta {
  return {
    id,
    thread_id: `thread-${id}`,
    subject,
    from: 'Vendor Billing <billing@vendor.example.com>',
    snippet: 'please look',
    internal_date: new Date(NOW).toISOString(),
    label_ids: ['INBOX'],
  } as GmailMessageMeta
}

function withStore(run: (store: EmailPipelineStore) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'email-boundary-'))
  const store = openEmailPipelineStore({ owner_home: home, now: () => NOW })
  // These exercise the STEADY state, past the one-time backlog sweep.
  store.setCheckpoint(CHECKPOINT_BACKLOG_DONE, '1')
  store.setCheckpoint(backlogDoneKey(null), '1')
  return run(store).finally(() => {
    store.close()
    rmSync(home, { recursive: true, force: true })
  })
}

describe('steady-state polling does not starve behind handled mail', () => {
  test('an entire first page of already-handled mail does NOT end the poll', async () => {
    await withStore(async (store) => {
      // An escalated message KEEPS INBOX by design, so the top of the inbox
      // fills with mail this pipeline has already dealt with. Here a full page
      // of them sits in front of one unhandled message.
      const handled = Array.from({ length: 3 }, (_, i) => meta(`handled-${i}`))
      for (const m of handled) {
        store.insertEmail({
          id: m.id,
          thread_id: m.thread_id,
          account_id: null,
          sender: m.from,
          subject: m.subject,
          snippet: m.snippet,
          body_text: 'x',
          received_at: NOW,
          processed_at: NOW,
          category: 'billing action',
          handling: 'escalate',
        })
        store.markEscalated(m.id, NOW, null)
      }

      const pages: GmailListResult[] = [
        { results: handled, next_page_token: 'page-2' },
        { results: [meta('brand-new')], next_page_tokens: {} },
      ]
      let call = 0
      const asked: GmailListInput[] = []
      const delivered: string[] = []
      const gmail = {
        async listMessages(input: GmailListInput): Promise<GmailListResult> {
          asked.push(input)
          return pages[Math.min(call++, pages.length - 1)] as GmailListResult
        },
        async getMessage(): Promise<unknown> {
          return { body_text: 'Your card was declined.', label_ids: ['INBOX'] }
        },
        async ensureLabel(): Promise<unknown> {
          return { label_id: 'Label_p', label_name: 'Neutron/processed', created: false }
        },
        async modifyMessage(): Promise<unknown> {
          return { message_id: 'x', label_ids: [] }
        },
      } as unknown as GmailClient

      const r = await runEmailPipelineTick({
        gmail,
        store,
        classify: { cache_lookup: () => null, cache_store: () => undefined, llm: null },
        escalate: {
          deliver: async (_t, e): Promise<unknown> => {
            delivered.push(e.body)
            return { prompt_id: 'p1', persisted: true, delivered_live: true }
          },
          topic_id: 'app:owner',
          push: null,
          project_slug: 'instance',
        },
        now: () => NOW,
        max_results: 3,
      })

      // THE REGRESSION: one page, all handled, used to end the tick reporting
      // nothing to do — and the message behind it was never reached, on this
      // tick or any future one.
      expect(asked.length).toBeGreaterThanOrEqual(2)
      expect(r.scanned).toBe(1)
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toContain('billing@vendor.example.com')
    })
  })
})

describe('a delivered escalation is never re-posted', () => {
  test('deliver SUCCEEDS but the acknowledgement write throws — no second post', async () => {
    await withStore(async (store) => {
      store.insertEmail({
        id: 'msg-1',
        thread_id: 't-1',
        account_id: null,
        sender: 'Vendor Billing <billing@vendor.example.com>',
        subject: 'Action required: payment failed',
        snippet: 's',
        body_text: 'b',
        received_at: NOW,
        processed_at: NOW,
        category: 'billing action',
        handling: 'escalate',
      })

      const posts: Array<{ body: string; idempotency_key?: string }> = []
      const broken = {
        ...store,
        markEscalated: (): void => {
          throw new Error('disk full')
        },
      } as unknown as EmailPipelineStore

      const out = await escalateEmail(
        {
          id: 'msg-1',
          sender: 'Vendor Billing <billing@vendor.example.com>',
          subject: 'Action required: payment failed',
          reason: 'billing action',
        },
        {
          deliver: async (_t, e): Promise<unknown> => {
            posts.push({ body: e.body, ...(e.idempotency_key !== undefined ? { idempotency_key: e.idempotency_key } : {}) })
            return { prompt_id: 'p1', persisted: true, delivered_live: true }
          },
          topic_id: 'app:owner',
          push: null,
          project_slug: 'instance',
          store: broken,
          now: () => NOW,
        },
      )

      // The owner WAS told. The local write failing must not be reported as a
      // delivery failure — that is what left the row eligible and posted twice.
      expect(out.delivered).toBe(true)
      expect(posts).toHaveLength(1)
      // And the post carries a deterministic key, so a retry collapses at the
      // seam instead of writing a second durable chat row.
      expect(posts[0]?.idempotency_key).toBe('email-escalation::msg-1')

      // The failure was NOT counted against the delivery attempt cap.
      expect(store.getEmail('msg-1')?.escalation_attempts).toBe(0)
    })
  })
})

describe('a resolved deliver call is not automatically a delivered escalation', () => {
  test('persisted:false is a FAILURE — not marked escalated, and retried', async () => {
    await withStore(async (store) => {
      store.insertEmail({
        id: 'msg-2',
        thread_id: 't-2',
        account_id: null,
        sender: 'Vendor Billing <billing@vendor.example.com>',
        subject: 'Action required: payment failed',
        snippet: 's',
        body_text: 'b',
        received_at: NOW,
        processed_at: NOW,
        category: 'billing action',
        handling: 'escalate',
      })

      // The real seam does NOT throw when the durable write fails: it resolves
      // with persisted:false. Trusting the absence of an exception marked the
      // owner told when nothing was written anywhere, and suppressed the retry
      // forever.
      const out = await escalateEmail(
        {
          id: 'msg-2',
          sender: 'Vendor Billing <billing@vendor.example.com>',
          subject: 'Action required: payment failed',
          reason: 'billing action',
        },
        {
          deliver: async (): Promise<unknown> => ({ persisted: false, delivered_live: false }),
          topic_id: 'app:owner',
          push: null,
          project_slug: 'instance',
          store,
          now: () => NOW,
        },
      )

      expect(out.delivered).toBe(false)
      const row = store.getEmail('msg-2')
      expect(row?.escalated_at).toBeNull()
      // Counted as an attempt, so the resume pass picks it up next tick.
      expect(row?.escalation_attempts).toBe(1)
      expect(store.listPendingEscalations(5).map((r) => r.id)).toContain('msg-2')
    })
  })
})

describe('a write for a disconnected account fails closed', () => {
  /** Only `acct-b` is still connected; `acct-a` was disconnected. */
  function twoAccountsOneGone(): {
    client: GmailClient
    touchedB: Array<{ message_id: string; remove: string[] }>
  } {
    const touchedB: Array<{ message_id: string; remove: string[] }> = []
    const clientB = {
      async getMessage(input: { message_id: string }): Promise<unknown> {
        // acct-b HAPPENS to hold the same id — Gmail ids are account-local.
        if (input.message_id === 'shared-id') {
          return {
            id: 'shared-id',
            thread_id: 't-b',
            subject: "acct-b's unrelated message",
            from: 'Someone <someone@other.example.com>',
            snippet: '',
            internal_date: new Date(NOW).toISOString(),
            label_ids: ['INBOX'],
            body_text: 'this belongs to the OTHER mailbox',
          }
        }
        throw new Error('not found')
      },
      async modifyMessage(input: { message_id: string; remove_label_ids?: string[] }): Promise<unknown> {
        touchedB.push({ message_id: input.message_id, remove: [...(input.remove_label_ids ?? [])] })
        return { message_id: input.message_id, label_ids: [] }
      },
      async ensureLabel(): Promise<unknown> {
        return { label_id: 'Label_b', label_name: 'Neutron/processed', created: false }
      },
      async listMessages(): Promise<GmailListResult> {
        return { results: [] }
      },
    } as unknown as GmailClient

    const client = buildMultiAccountGmailClient({
      accounts: async () => [
        { account_id: 'acct-b', account_email: 'b@example.com', accessToken: async () => 'tok' },
      ],
      buildClient: () => clientB,
    })
    return { client, touchedB }
  }

  test('modifyMessage for a gone account NEVER archives another mailbox', async () => {
    const { client, touchedB } = twoAccountsOneGone()
    // A mutation persisted for (acct-a, shared-id) is retried after acct-a is
    // disconnected. Probing would strip INBOX from acct-b's unrelated message
    // and then mark acct-a's row complete.
    await expect(
      client.modifyMessage({
        message_id: 'shared-id',
        account_id: 'acct-a',
        add_label_ids: ['Label_p'],
        remove_label_ids: ['INBOX'],
      }),
    ).rejects.toThrow()
    expect(touchedB).toEqual([])
  })

  test('getMessage for a gone account NEVER returns another mailbox’s body', async () => {
    const { client } = twoAccountsOneGone()
    await expect(
      client.getMessage({ message_id: 'shared-id', account_id: 'acct-a' }),
    ).rejects.toThrow()
  })

  test('ensureLabel for a gone account does not mint the label in the primary', async () => {
    const { client } = twoAccountsOneGone()
    await expect(
      client.ensureLabel({ name: 'Neutron/processed', account_id: 'acct-a' }),
    ).rejects.toThrow()
  })
})
