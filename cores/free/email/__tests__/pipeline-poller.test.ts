/**
 * Email pipeline — the poll TICK, against the in-memory Gmail backend.
 *
 * These assert the OBSERVABLE OUTCOME, not bookkeeping:
 *   - the LABEL MUTATIONS actually issued (processed label ensured + added;
 *     INBOX removed for archived mail, KEPT for escalated mail),
 *   - and that the chat sink received an envelope whose text NAMES the sender,
 *     the subject and the importance reason. An escalation that fires but says
 *     nothing fails here.
 *
 * Every fixture address is `*.example.com`.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROCESSED_LABEL_NAME } from '../src/contract.ts'
import type {
  GmailClient,
  GmailGetInput,
  GmailMessageFull,
} from '../src/contract.ts'
import { buildSeededInMemoryGmailClient } from '../src/in-memory.ts'
import { runEmailPipelineTick } from '../src/pipeline/poller.ts'
import {
  CHECKPOINT_BACKLOG_DONE,
  CHECKPOINT_GO_LIVE_AFTER,
} from '../src/pipeline/poller.ts'
import { openEmailPipelineStore, type EmailPipelineStore } from '../src/pipeline/store.ts'

const GO_LIVE = Date.parse('2026-08-11T09:00:00.000Z')
const NOW = GO_LIVE + 60_000

interface Harness {
  store: EmailPipelineStore
  gmail: GmailClient
  /** Every `deliver` call: the topic and the envelope. */
  delivered: Array<{ topic_id: string; body: string; durability: string }>
  /** Every `pushAll` call. */
  pushed: Array<{ project_slug: string; title?: string; body: string }>
  /** Message ids the body was fetched for — i.e. the ones that were CLASSIFIED. */
  bodiesRead: string[]
  ensured: string[]
  modified: Array<{ message_id: string; add: string[]; remove: string[] }>
  close: () => void
}

function harness(opts: { deliverThrows?: () => boolean; pushThrows?: boolean } = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'email-pipeline-poll-'))
  const store = openEmailPipelineStore({ owner_home: home, now: () => NOW })
  const seeded = buildSeededInMemoryGmailClient({ now: () => NOW })
  const bodiesRead: string[] = []
  const ensured: string[] = []
  const modified: Array<{ message_id: string; add: string[]; remove: string[] }> = []

  const gmail: GmailClient & { seed: typeof seeded.seed } = {
    ...seeded,
    seed: seeded.seed.bind(seeded),
    async getMessage(input: GmailGetInput): Promise<GmailMessageFull> {
      bodiesRead.push(input.message_id)
      return seeded.getMessage(input)
    },
    async ensureLabel(input) {
      ensured.push(input.name)
      return seeded.ensureLabel(input)
    },
    async modifyMessage(input) {
      modified.push({
        message_id: input.message_id,
        add: [...input.add_label_ids],
        remove: [...(input.remove_label_ids ?? [])],
      })
      return seeded.modifyMessage(input)
    },
  }

  const delivered: Array<{ topic_id: string; body: string; durability: string }> = []
  const pushed: Array<{ project_slug: string; title?: string; body: string }> = []

  return {
    store,
    gmail,
    delivered,
    pushed,
    bodiesRead,
    ensured,
    modified,
    close: () => {
      store.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

function tick(
  h: Harness,
  over: {
    deliver?: (topic_id: string, envelope: { body: string; durability: 'reply' }) => Promise<unknown>
    push?: { pushAll(slug: string, m: { title?: string; body: string }): Promise<unknown> } | null
    llm?: ((prompt: string) => Promise<string>) | null
  } = {},
): ReturnType<typeof runEmailPipelineTick> {
  return runEmailPipelineTick({
    gmail: h.gmail,
    store: h.store,
    classify: {
      cache_lookup: (sender) => h.store.getSenderCache(sender),
      cache_store: (sender, category) => h.store.upsertSenderCache(sender, category),
      llm: over.llm ?? null,
    },
    escalate: {
      deliver:
        over.deliver ??
        (async (topic_id, envelope): Promise<unknown> => {
          h.delivered.push({ topic_id, body: envelope.body, durability: envelope.durability })
          return { prompt_id: 'p1', persisted: true, delivered_live: true }
        }),
      topic_id: 'app:owner',
      push:
        over.push === undefined
          ? {
              async pushAll(slug, m): Promise<unknown> {
                h.pushed.push({ project_slug: slug, body: m.body, ...(m.title !== undefined ? { title: m.title } : {}) })
                return { sent: 0 }
              },
            }
          : over.push,
      project_slug: 'instance',
    },
    now: () => NOW,
  })
}

/** The mail already sitting in the owner's inbox when the pipeline is switched on. */
function seedBacklog(h: Harness): void {
  const seed = (h.gmail as unknown as { seed: (i: Record<string, unknown>) => string }).seed
  seed({
    id: 'backlog-1',
    thread_id: 'thread-backlog-1',
    // Deliberately the SAME shape the classifier would escalate. If the sweep
    // ever let it through, this is the message that would wake the owner at
    // 3am about a payment that failed last year.
    subject: 'Action required: payment failed',
    from: 'Vendor Billing <billing@vendor.example.com>',
    snippet: 'Old mail',
    body_text: 'This predates the pipeline going live.',
    internal_date: new Date(GO_LIVE - 86_400_000).toISOString(),
    label_ids: ['INBOX'],
  })
}

/**
 * Take the pipeline live over an inbox that ALREADY holds `backlog-1`: run the
 * one-time sweep to completion. It must record the backlog as handled while
 * leaving the mailbox untouched. Returns the sweep's tick result.
 *
 * This mirrors a real install — existing mail is marked once, and only mail
 * arriving afterwards is ever processed.
 */
async function goLiveOverBacklog(h: Harness): Promise<void> {
  seedBacklog(h)
  const sweep = await tick(h)
  expect(sweep.backlog_sweeping).toBe(true)
  expect(sweep.precutoff).toBe(1)
  expect(h.store.getCheckpoint(CHECKPOINT_BACKLOG_DONE)).toBe('1')
}

/** Seed the two canonical LIVE shapes: important + newsletter. */
function seedNewMail(h: Harness): void {
  const seed = (h.gmail as unknown as { seed: (i: Record<string, unknown>) => string }).seed
  seed({
    id: 'important-1',
    thread_id: 'thread-important-1',
    subject: 'Action required: payment failed',
    from: 'Vendor Billing <billing@vendor.example.com>',
    snippet: 'Your card was declined',
    body_text: 'Your card was declined. Update it to keep the service running.',
    internal_date: new Date(GO_LIVE + 30_000).toISOString(),
    label_ids: ['INBOX'],
  })
  seed({
    id: 'newsletter-1',
    thread_id: 'thread-newsletter-1',
    subject: 'This week at the shop',
    from: 'The Shop <news@list.example.com>',
    snippet: 'News',
    body_text: 'Lots of news this week. Unsubscribe at any time.',
    internal_date: new Date(GO_LIVE + 40_000).toISOString(),
    label_ids: ['INBOX'],
  })
}

function labelsOf(h: Harness, id: string): Promise<string[]> {
  return h.gmail.getMessage({ message_id: id }).then((m) => m.label_ids)
}

describe('runEmailPipelineTick', () => {
  test('escalates the important message: chat text names sender, subject and reason', async () => {
    const h = harness()
    try {
      await goLiveOverBacklog(h)
      seedNewMail(h)
      const r = await tick(h)

      expect(r.escalated).toBe(1)
      expect(r.archived).toBe(1)
      // The sweep already accounted for the backlog; a live tick never re-sees it.
      expect(r.precutoff).toBe(0)
      expect(r.errors).toBe(0)

      // EXACTLY ONE chat post — the newsletter and the backlog say nothing.
      expect(h.delivered).toHaveLength(1)
      const post = h.delivered[0]
      expect(post?.topic_id).toBe('app:owner')
      expect(post?.durability).toBe('reply')
      expect(post?.body).toContain('billing@vendor.example.com')
      expect(post?.body).toContain('Action required: payment failed')
      expect(post?.body).toContain('billing action')

      // Push fired ALONGSIDE — same text, never a substitute.
      expect(h.pushed).toHaveLength(1)
      expect(h.pushed[0]?.project_slug).toBe('instance')
      expect(h.pushed[0]?.body).toBe(post?.body)
    } finally {
      h.close()
    }
  })

  test('label mutations: processed on the NEW mail only; INBOX kept on the escalation', async () => {
    const h = harness()
    try {
      await goLiveOverBacklog(h)
      seedNewMail(h)
      await tick(h)

      expect(h.ensured).toContain(PROCESSED_LABEL_NAME)
      // Ensured ONCE for the whole tick (cached per account).
      expect(h.ensured).toHaveLength(1)

      const processed = await h.gmail.ensureLabel({ name: PROCESSED_LABEL_NAME })
      for (const id of ['important-1', 'newsletter-1']) {
        expect(await labelsOf(h, id)).toContain(processed.label_id)
      }
      // The escalated message STAYS in the inbox — the owner still has to act
      // on it in their mail client.
      expect(await labelsOf(h, 'important-1')).toContain('INBOX')
      expect(await labelsOf(h, 'newsletter-1')).not.toContain('INBOX')
      // The backlog carries NEITHER label change: it was never touched.
      expect(await labelsOf(h, 'backlog-1')).toEqual(['INBOX'])
      expect(h.modified.some((m) => m.message_id === 'backlog-1')).toBe(false)

      const escalationModify = h.modified.find((m) => m.message_id === 'important-1')
      expect(escalationModify?.remove).toEqual([])
      const archiveModify = h.modified.find((m) => m.message_id === 'newsletter-1')
      expect(archiveModify?.remove).toEqual(['INBOX'])
    } finally {
      h.close()
    }
  })

  test('backlog is marked pre-existing, NEVER classified, and left in the inbox', async () => {
    const h = harness()
    try {
      await goLiveOverBacklog(h)
      seedNewMail(h)
      await tick(h)

      const row = h.store.getEmail('backlog-1')
      expect(row?.handling).toBe('preexisting')
      // NULL category is the record of "never classified".
      expect(row?.category).toBeNull()
      expect(row?.escalated_at).toBeNull()
      // Classification requires the body; the backlog message's body was never
      // fetched, so the classifier was never invoked for it. (Asserted BEFORE
      // any `labelsOf` call below — that helper reads the message too.)
      expect(h.bodiesRead).not.toContain('backlog-1')
      expect(h.bodiesRead).toContain('important-1')
      // It stays where the owner left it — the live tick archived the
      // newsletter, but the backlog keeps its INBOX label untouched.
      expect(await labelsOf(h, 'backlog-1')).toEqual(['INBOX'])
      // ...and it produced no chat post, despite carrying a billing subject
      // that WOULD have escalated post-cutoff.
      expect(h.delivered.every((d) => !d.body.includes('Old mail'))).toBe(true)
      expect(h.delivered).toHaveLength(1)
    } finally {
      h.close()
    }
  })

  test('the backlog sweep marks the existing inbox handled and MUTATES NOTHING', async () => {
    const h = harness()
    try {
      seedBacklog(h)
      seedNewMail(h)
      const r = await tick(h)

      expect(h.store.getCheckpoint(CHECKPOINT_GO_LIVE_AFTER)).toBe(String(NOW))
      expect(r.backlog_sweeping).toBe(true)
      expect(r.precutoff).toBe(3)

      // NOTHING was classified, escalated, or said.
      expect(r.escalated).toBe(0)
      expect(h.delivered).toHaveLength(0)
      expect(h.pushed).toHaveLength(0)
      expect(h.bodiesRead).toEqual([])

      // AND THE MAILBOX IS UNTOUCHED. This is the owner's constraint: mail
      // already in the inbox was triaged by hand and stays exactly where it
      // is. No label added, no message archived, no `ensureLabel` call.
      expect(h.modified).toEqual([])
      expect(h.ensured).toEqual([])
      expect(await labelsOf(h, 'backlog-1')).toEqual(['INBOX'])

      // Every message is recorded as pre-existing — the row IS the "handled"
      // state, so no future tick has to re-decide it from a date.
      expect(h.store.getEmail('backlog-1')?.handling).toBe('preexisting')
      expect(h.store.getEmail('backlog-1')?.category).toBeNull()
    } finally {
      h.close()
    }
  })

  test('after the sweep, backlog is never reconsidered — and never escalates', async () => {
    const h = harness()
    try {
      await goLiveOverBacklog(h)
      // Three further ticks over the same inbox: the backlog is still sitting
      // there in INBOX, still matching the importance rule that would fire.
      const a = await tick(h)
      const b = await tick(h)
      const c = await tick(h)
      for (const r of [a, b, c]) {
        expect(r.backlog_sweeping).toBe(false)
        expect(r.scanned).toBe(0)
        expect(r.escalated).toBe(0)
      }
      expect(h.delivered).toHaveLength(0)
      expect(h.bodiesRead).toEqual([])
      expect(h.modified).toEqual([])
    } finally {
      h.close()
    }
  })

  test('the newsletter is archived and queued with NO chat post and NO push', async () => {
    const h = harness()
    try {
      await goLiveOverBacklog(h)
      seedNewMail(h)
      await tick(h)
      const row = h.store.getEmail('newsletter-1')
      expect(row?.handling).toBe('archive')
      expect(row?.category).toBe('newsletter')
      expect(h.delivered.some((d) => d.body.includes('This week at the shop'))).toBe(false)
      expect(h.pushed.some((p) => p.body.includes('This week at the shop'))).toBe(false)
    } finally {
      h.close()
    }
  })

  test('a throwing push does NOT prevent the escalation being marked delivered', async () => {
    const h = harness()
    try {
      await goLiveOverBacklog(h)
      seedNewMail(h)
      const r = await tick(h, {
        push: {
          async pushAll(): Promise<unknown> {
            throw new Error('expo unreachable')
          },
        },
      })
      expect(r.escalated).toBe(1)
      expect(h.delivered).toHaveLength(1)
      expect(h.store.getEmail('important-1')?.escalated_at).toBe(NOW)
    } finally {
      h.close()
    }
  })

  test('one bad message never kills the tick', async () => {
    const h = harness()
    try {
      await goLiveOverBacklog(h)
      seedNewMail(h)
      const broken: typeof h.gmail = {
        ...h.gmail,
        async getMessage(input): Promise<GmailMessageFull> {
          if (input.message_id === 'important-1') throw new Error('gmail 500')
          return h.gmail.getMessage(input)
        },
      }
      const r = await runEmailPipelineTick({
        gmail: broken,
        store: h.store,
        classify: { cache_lookup: () => null, cache_store: () => undefined, llm: null },
        escalate: {
          deliver: async (topic_id, envelope): Promise<unknown> => {
            h.delivered.push({ topic_id, body: envelope.body, durability: envelope.durability })
            return null
          },
          topic_id: 'app:owner',
          push: null,
          project_slug: 'instance',
        },
        now: () => NOW,
      })
      expect(r.errors).toBe(1)
      // The newsletter still went through: one message's failure is contained.
      expect(r.archived).toBe(1)
      expect(r.precutoff).toBe(0)
    } finally {
      h.close()
    }
  })
})
