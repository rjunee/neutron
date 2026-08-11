/**
 * Email pipeline — escalation DEDUP and RESUME.
 *
 * The escalated message deliberately stays in INBOX, so the label set cannot
 * say "handled": `emails.id` (the row's existence) and `emails.escalated_at`
 * are the only things stopping a second tick from telling the owner about the
 * same email again — every five minutes, forever.
 *
 * Every fixture address is `*.example.com`.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GmailClient } from '../src/contract.ts'
import { buildSeededInMemoryGmailClient } from '../src/in-memory.ts'
import { CHECKPOINT_GO_LIVE_AFTER, runEmailPipelineTick } from '../src/pipeline/poller.ts'
import { openEmailPipelineStore, type EmailPipelineStore } from '../src/pipeline/store.ts'

const GO_LIVE = Date.parse('2026-08-11T09:00:00.000Z')
const NOW = GO_LIVE + 60_000

interface Fixture {
  store: EmailPipelineStore
  gmail: GmailClient
  delivered: string[]
  close: () => void
}

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'email-pipeline-dedup-'))
  const store = openEmailPipelineStore({ owner_home: home, now: () => NOW })
  store.setCheckpoint(CHECKPOINT_GO_LIVE_AFTER, String(GO_LIVE))
  const gmail = buildSeededInMemoryGmailClient({ now: () => NOW })
  gmail.seed({
    id: 'important-1',
    thread_id: 'thread-important-1',
    subject: 'Action required: payment failed',
    from: 'Vendor Billing <billing@vendor.example.com>',
    snippet: 'Card declined',
    body_text: 'Your card was declined.',
    internal_date: new Date(GO_LIVE + 30_000).toISOString(),
    label_ids: ['INBOX'],
  })
  return {
    store,
    gmail,
    delivered: [],
    close: () => {
      store.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

function tick(
  f: Fixture,
  deliver: (topic_id: string, envelope: { body: string; durability: 'reply' }) => Promise<unknown>,
): ReturnType<typeof runEmailPipelineTick> {
  return runEmailPipelineTick({
    gmail: f.gmail,
    store: f.store,
    classify: { cache_lookup: () => null, cache_store: () => undefined, llm: null },
    escalate: { deliver, topic_id: 'app:owner', push: null, project_slug: 'instance' },
    now: () => NOW,
    max_escalation_attempts: 3,
  })
}

describe('escalation dedup', () => {
  test('a SECOND tick over the same mailbox posts nothing', async () => {
    const f = fixture()
    try {
      const ok = async (_t: string, e: { body: string }): Promise<unknown> => {
        f.delivered.push(e.body)
        return null
      }
      const first = await tick(f, ok)
      expect(first.escalated).toBe(1)
      expect(f.delivered).toHaveLength(1)

      // The message is STILL in the inbox (that is the point) — so the second
      // tick sees it again and must recognise it.
      expect((await f.gmail.getMessage({ message_id: 'important-1' })).label_ids).toContain(
        'INBOX',
      )
      const second = await tick(f, ok)
      expect(second.escalated).toBe(0)
      expect(second.scanned).toBe(0)
      expect(f.delivered).toHaveLength(1)
    } finally {
      f.close()
    }
  })
})

describe('escalation resume', () => {
  test('a FAILED deliver leaves escalated_at NULL with attempts=1 + last_error', async () => {
    const f = fixture()
    try {
      const boom = async (): Promise<unknown> => {
        throw new Error('socket closed')
      }
      const first = await tick(f, boom)
      expect(first.escalated).toBe(0)
      const row = f.store.getEmail('important-1')
      expect(row?.escalated_at).toBeNull()
      expect(row?.escalation_attempts).toBe(1)
      expect(row?.last_error).toBe('socket closed')
    } finally {
      f.close()
    }
  })

  test('the next tick resumes and delivers EXACTLY ONCE', async () => {
    const f = fixture()
    try {
      await tick(f, async (): Promise<unknown> => {
        throw new Error('socket closed')
      })
      const ok = async (_t: string, e: { body: string }): Promise<unknown> => {
        f.delivered.push(e.body)
        return null
      }
      const second = await tick(f, ok)
      expect(second.resumed).toBe(1)
      expect(f.delivered).toHaveLength(1)
      expect(f.delivered[0]).toContain('billing@vendor.example.com')
      expect(f.store.getEmail('important-1')?.escalated_at).toBe(NOW)

      // ...and a third tick says nothing more.
      const third = await tick(f, ok)
      expect(third.resumed).toBe(0)
      expect(f.delivered).toHaveLength(1)
    } finally {
      f.close()
    }
  })

  test('the attempt cap is honoured — a permanently broken sink stops retrying', async () => {
    const f = fixture()
    try {
      let attempts = 0
      const boom = async (): Promise<unknown> => {
        attempts++
        throw new Error('socket closed')
      }
      // max_escalation_attempts: 3 → the poll attempt plus two resumes.
      await tick(f, boom)
      await tick(f, boom)
      await tick(f, boom)
      await tick(f, boom)
      expect(attempts).toBe(3)
      expect(f.store.getEmail('important-1')?.escalation_attempts).toBe(3)
      expect(f.store.listPendingEscalations(3)).toHaveLength(0)
    } finally {
      f.close()
    }
  })
})
