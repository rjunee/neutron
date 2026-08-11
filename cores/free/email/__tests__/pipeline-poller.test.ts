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
import { CHECKPOINT_GO_LIVE_AFTER } from '../src/pipeline/poller.ts'
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

/** Seed the three canonical shapes: important, newsletter, pre-cutoff. */
function seedThree(h: Harness): void {
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
  seed({
    id: 'backlog-1',
    thread_id: 'thread-backlog-1',
    subject: 'Action required: payment failed',
    from: 'Vendor Billing <billing@vendor.example.com>',
    snippet: 'Old mail',
    body_text: 'This is older than the go-live cutoff.',
    internal_date: new Date(GO_LIVE - 86_400_000).toISOString(),
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
      // Stamp the cutoff so the seeded backlog message is genuinely pre-cutoff.
      h.store.setCheckpoint(CHECKPOINT_GO_LIVE_AFTER, String(GO_LIVE))
      seedThree(h)
      const r = await tick(h)

      expect(r.escalated).toBe(1)
      expect(r.archived).toBe(1)
      expect(r.precutoff).toBe(1)
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

  test('label mutations: processed on all three; INBOX kept ONLY on the escalation', async () => {
    const h = harness()
    try {
      h.store.setCheckpoint(CHECKPOINT_GO_LIVE_AFTER, String(GO_LIVE))
      seedThree(h)
      await tick(h)

      expect(h.ensured).toContain(PROCESSED_LABEL_NAME)
      // Ensured ONCE for the whole tick (cached per account).
      expect(h.ensured).toHaveLength(1)

      const processed = await h.gmail.ensureLabel({ name: PROCESSED_LABEL_NAME })
      for (const id of ['important-1', 'newsletter-1', 'backlog-1']) {
        expect(await labelsOf(h, id)).toContain(processed.label_id)
      }
      // The escalated message STAYS in the inbox — the owner still has to act
      // on it in their mail client.
      expect(await labelsOf(h, 'important-1')).toContain('INBOX')
      expect(await labelsOf(h, 'newsletter-1')).not.toContain('INBOX')
      expect(await labelsOf(h, 'backlog-1')).not.toContain('INBOX')

      const escalationModify = h.modified.find((m) => m.message_id === 'important-1')
      expect(escalationModify?.remove).toEqual([])
      const archiveModify = h.modified.find((m) => m.message_id === 'newsletter-1')
      expect(archiveModify?.remove).toEqual(['INBOX'])
    } finally {
      h.close()
    }
  })

  test('the go-live cutoff: pre-cutoff mail is archived, NEVER classified', async () => {
    const h = harness()
    try {
      h.store.setCheckpoint(CHECKPOINT_GO_LIVE_AFTER, String(GO_LIVE))
      seedThree(h)
      await tick(h)

      const row = h.store.getEmail('backlog-1')
      expect(row?.handling).toBe('archive')
      // NULL category is the record of "never classified".
      expect(row?.category).toBeNull()
      expect(row?.escalated_at).toBeNull()
      // Classification requires the body; the pre-cutoff message's body was
      // never fetched, so the classifier was never invoked for it.
      expect(h.bodiesRead).not.toContain('backlog-1')
      expect(h.bodiesRead).toContain('important-1')
      // ...and it produced no chat post, despite carrying a billing subject
      // that WOULD have escalated post-cutoff.
      expect(h.delivered.every((d) => !d.body.includes('Old mail'))).toBe(true)
      expect(h.delivered).toHaveLength(1)
    } finally {
      h.close()
    }
  })

  test('first tick stamps go_live_after, so the whole existing inbox is backlog', async () => {
    const h = harness()
    try {
      seedThree(h)
      const r = await tick(h)
      expect(h.store.getCheckpoint(CHECKPOINT_GO_LIVE_AFTER)).toBe(String(NOW))
      expect(r.precutoff).toBe(3)
      expect(r.escalated).toBe(0)
      expect(h.delivered).toHaveLength(0)
      expect(h.bodiesRead).toEqual([])
    } finally {
      h.close()
    }
  })

  test('the newsletter is archived and queued with NO chat post and NO push', async () => {
    const h = harness()
    try {
      h.store.setCheckpoint(CHECKPOINT_GO_LIVE_AFTER, String(GO_LIVE))
      seedThree(h)
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
      h.store.setCheckpoint(CHECKPOINT_GO_LIVE_AFTER, String(GO_LIVE))
      seedThree(h)
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
      h.store.setCheckpoint(CHECKPOINT_GO_LIVE_AFTER, String(GO_LIVE))
      seedThree(h)
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
      expect(r.archived).toBe(1)
      expect(r.precutoff).toBe(1)
    } finally {
      h.close()
    }
  })
})
