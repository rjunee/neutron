/**
 * The email pipeline's cron registration + handler wrapper.
 *
 * The handler is the boundary between the gateway's cron loop and the Core's
 * tick body: a thrown tick must come back as `status:'error'`, never as an
 * exception into the loop.
 *
 * Every fixture address is `*.example.com`.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import type { GmailClient } from '@neutronai/email-managed-core/backend'
import { buildSeededInMemoryGmailClient } from '@neutronai/email-managed-core'
import {
  backlogDoneKey,
  CHECKPOINT_BACKLOG_DONE,
} from '@neutronai/email-managed-core/pipeline/poller'
import { openEmailPipelineStore } from '@neutronai/email-managed-core/pipeline/store'

import {
  EMAIL_PIPELINE_POLL_HANDLER_NAME,
  EMAIL_PIPELINE_POLL_INTERVAL_MS,
  EMAIL_PIPELINE_POLL_JOB_NAME,
  buildEmailPipelinePollHandler,
  registerEmailPipelineCron,
  type EmailPipelineCompositionConfig,
} from '../email-pipeline-wiring.ts'

const CTX = { job_name: EMAIL_PIPELINE_POLL_JOB_NAME, owner_slug: 'owner', fired_at: 0 }

function config(over: Partial<EmailPipelineCompositionConfig> = {}): {
  cfg: EmailPipelineCompositionConfig
  cleanup: () => void
} {
  const home = mkdtempSync(join(tmpdir(), 'email-pipeline-wiring-'))
  const gmail = buildSeededInMemoryGmailClient()
  const cfg: EmailPipelineCompositionConfig = {
    gmail: gmail as GmailClient,
    owner_home: home,
    project_slug: 'owner',
    deliver: async () => ({ prompt_id: null, persisted: true, delivered_live: false }),
    escalation_topic_id: 'app:owner',
    push: null,
    llm: null,
    ...over,
  }
  return { cfg, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

describe('registerEmailPipelineCron', () => {
  test('registers the 5-minute, skip-if-running job and the handler', () => {
    const { cfg, cleanup } = config()
    try {
      const jobs = new CronJobRegistry()
      const handlers = new CronHandlerRegistry()
      const { job_name } = registerEmailPipelineCron({
        jobs,
        handlers,
        handler: buildEmailPipelinePollHandler(cfg),
      })
      expect(job_name).toBe(EMAIL_PIPELINE_POLL_JOB_NAME)
      const job = jobs.get(EMAIL_PIPELINE_POLL_JOB_NAME)
      expect(job?.schedule).toEqual({ kind: 'interval_ms', interval_ms: 300_000 })
      expect(EMAIL_PIPELINE_POLL_INTERVAL_MS).toBe(300_000)
      // Overlapping ticks would double-read the same mail before either wrote
      // its rows.
      expect(job?.skip_if_running).toBe(true)
      expect(job?.handler).toBe(EMAIL_PIPELINE_POLL_HANDLER_NAME)
      expect(handlers.get(EMAIL_PIPELINE_POLL_HANDLER_NAME)).toBeDefined()
    } finally {
      cleanup()
    }
  })

  test('an explicit interval overrides the default', () => {
    const { cfg, cleanup } = config()
    try {
      const jobs = new CronJobRegistry()
      const handlers = new CronHandlerRegistry()
      registerEmailPipelineCron({
        jobs,
        handlers,
        handler: buildEmailPipelinePollHandler(cfg),
        interval_ms: 60_000,
      })
      expect(jobs.get(EMAIL_PIPELINE_POLL_JOB_NAME)?.schedule).toEqual({
        kind: 'interval_ms',
        interval_ms: 60_000,
      })
    } finally {
      cleanup()
    }
  })

  test('a second registration adds NOTHING — one job, one handler, one poller', () => {
    const { cfg, cleanup } = config()
    try {
      // The registries are the SAME ones both times, which is the only way this
      // says anything: a fresh `CronJobRegistry` per call cannot observe a
      // double registration, and `not.toThrow()` alone would pass while the
      // mailbox got polled twice per interval.
      const jobs = new CronJobRegistry()
      const handlers = new CronHandlerRegistry()
      const handler = buildEmailPipelinePollHandler(cfg)
      registerEmailPipelineCron({ jobs, handlers, handler })
      expect(jobs.size()).toBe(1)
      expect(handlers.list()).toHaveLength(1)

      expect(() => registerEmailPipelineCron({ jobs, handlers, handler })).not.toThrow()
      expect(jobs.size()).toBe(1)
      expect(jobs.list().filter((j) => j.name === EMAIL_PIPELINE_POLL_JOB_NAME)).toHaveLength(1)
      expect(handlers.list()).toEqual([EMAIL_PIPELINE_POLL_HANDLER_NAME])
      expect(handlers.get(EMAIL_PIPELINE_POLL_HANDLER_NAME)).toBe(handler)
    } finally {
      cleanup()
    }
  })
})

describe('buildEmailPipelinePollHandler', () => {
  test('an empty inbox is a skipped tick, and the detail carries the tally', async () => {
    const { cfg, cleanup } = config()
    try {
      const result = await buildEmailPipelinePollHandler(cfg)(CTX)
      expect(result.status).toBe('skipped')
      expect(result.detail).toContain('scanned=0')
      expect(result.detail).toContain('escalated=0')
    } finally {
      cleanup()
    }
  })

  test('a thrown tick comes back as status error, NOT as an exception', async () => {
    const { cfg, cleanup } = config({
      gmail: {
        async listMessages(): Promise<never> {
          throw new Error('gmail 503')
        },
      } as unknown as GmailClient,
    })
    try {
      const result = await buildEmailPipelinePollHandler(cfg)(CTX)
      expect(result.status).toBe('error')
      expect(result.detail).toContain('gmail 503')
    } finally {
      cleanup()
    }
  })

  test('the store opens lazily on the first fire and registers its close', async () => {
    const cleanups: Array<() => void> = []
    const { cfg, cleanup } = config({
      register_cleanup: (fn) => cleanups.push(fn),
    })
    try {
      const handler = buildEmailPipelinePollHandler(cfg)
      expect(cleanups).toHaveLength(0)
      await handler(CTX)
      expect(cleanups).toHaveLength(1)
      // Second fire reuses the same handle — one close, not two.
      await handler(CTX)
      expect(cleanups).toHaveLength(1)
      for (const fn of cleanups) fn()
    } finally {
      cleanup()
    }
  })

  test('a message that classifies as important escalates through the wired deliver', async () => {
    const posts: Array<{ topic_id: string; body: string; durability: string }> = []
    const pushes: string[] = []
    const gmail = buildSeededInMemoryGmailClient()
    const { cfg, cleanup } = config({
      gmail: gmail as GmailClient,
      deliver: async (topic_id, envelope) => {
        posts.push({ topic_id, body: envelope.body, durability: envelope.durability })
        return { prompt_id: 'p', persisted: true, delivered_live: true }
      },
      push: {
        async pushAll(_slug: string, m: { body: string }): Promise<unknown> {
          pushes.push(m.body)
          return { sent: 0 }
        },
      } as unknown as EmailPipelineCompositionConfig['push'],
    })
    try {
      const handler = buildEmailPipelinePollHandler(cfg)
      // First fire stamps the go-live cutoff; mail seeded AFTER it is live.
      await handler(CTX)
      gmail.seed({
        id: 'live-1',
        subject: 'Action required: payment failed',
        from: 'Vendor Billing <billing@vendor.example.com>',
        body_text: 'Your card was declined.',
        internal_date: new Date(Date.now() + 5_000).toISOString(),
        label_ids: ['INBOX'],
      })
      const result = await handler(CTX)
      expect(result.status).toBe('ok')
      expect(posts).toHaveLength(1)
      expect(posts[0]?.topic_id).toBe('app:owner')
      expect(posts[0]?.durability).toBe('reply')
      expect(posts[0]?.body).toContain('billing@vendor.example.com')
      expect(posts[0]?.body).toContain('Action required: payment failed')
      expect(pushes).toHaveLength(1)
    } finally {
      cleanup()
    }
  })
})

describe('the tick reports every kind of work it does', () => {
  test('a mutation-only recovery tick is ok, not skipped', async () => {
    // A tick that finished an OWED Gmail write changed the mailbox. Reporting
    // it as `skipped` is how a cron log quietly under-reports itself, and that
    // log is exactly what you later read to conclude — wrongly — that nothing
    // was happening.
    const seeded = buildSeededInMemoryGmailClient()
    seeded.seed({
      id: 'owed-1',
      thread_id: 't-owed',
      subject: 'This week at the shop',
      from: 'The Shop <news@list.example.com>',
      snippet: 's',
      body_text: 'Lots of news. Unsubscribe any time.',
      internal_date: new Date(1).toISOString(),
      label_ids: ['INBOX'],
    })
    const { cfg, cleanup } = config({ gmail: seeded as GmailClient })
    try {
      const store = openEmailPipelineStore({ owner_home: cfg.owner_home })
      // Past the sweep, with one row whose label/archive write is still owed.
      store.setCheckpoint(CHECKPOINT_BACKLOG_DONE, '1')
      store.setCheckpoint(backlogDoneKey(null), '1')
      store.insertEmail({
        id: 'owed-1',
        thread_id: 't-owed',
        account_id: null,
        sender: 'Vendor Billing <billing@vendor.example.com>',
        subject: 'This week at the shop',
        snippet: 's',
        body_text: 'b',
        received_at: 1,
        processed_at: 1,
        category: 'newsletter',
        handling: 'archive',
      })
      store.markEscalated('owed-1', 1, null)
      store.close()

      const result = await buildEmailPipelinePollHandler(cfg)(CTX)
      expect(result.detail).toContain('remutated=1')
      expect(result.status).toBe('ok')
    } finally {
      cleanup()
    }
  })

  test("the tick's diagnostics REACH a log — the production caller passed none", async () => {
    // `log` is optional on the tick, and this — the only production caller —
    // omitted it. All ten of the tick's diagnostics went nowhere: a paged-out
    // poll, a re-opened sweep, a failed message and a failed resume were all
    // silent, while the cron line said `skipped`.
    const lines: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const { cfg, cleanup } = config({
      log: (message, meta) => lines.push({ message, ...(meta !== undefined ? { meta } : {}) }),
    })
    try {
      await buildEmailPipelinePollHandler(cfg)(CTX)
      // The first fire stamps the go-live checkpoint, which is a logged fact.
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.some((l) => l.message.includes('go-live'))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test('a tick whose every message FAILED is not reported as skipped', async () => {
    // `skipped` has to mean "found nothing to do". A tick that scanned mail and
    // failed on all of it did the opposite, and reporting it as skipped is the
    // under-reporting above wearing its other hat.
    const seeded = buildSeededInMemoryGmailClient()
    const gmail = {
      ...seeded,
      listMessages: seeded.listMessages.bind(seeded),
      async getMessage(): Promise<never> {
        throw new Error('gmail 500 on body fetch')
      },
    } as unknown as GmailClient
    const { cfg, cleanup } = config({ gmail })
    try {
      const store = openEmailPipelineStore({ owner_home: cfg.owner_home })
      store.setCheckpoint(CHECKPOINT_BACKLOG_DONE, '1')
      store.setCheckpoint(backlogDoneKey(null), '1')
      store.close()
      seeded.seed({
        id: 'unreadable-1',
        thread_id: 't-unreadable',
        subject: 'Action required: payment failed',
        from: 'Vendor Billing <billing@vendor.example.com>',
        snippet: 's',
        body_text: 'Your card was declined.',
        internal_date: new Date(Date.now() + 5_000).toISOString(),
        label_ids: ['INBOX'],
      })

      const result = await buildEmailPipelinePollHandler(cfg)(CTX)
      expect(result.detail).toContain('errors=1')
      expect(result.status).toBe('error')
    } finally {
      cleanup()
    }
  })

  test('the detail line carries EVERY counter the result has', async () => {
    // The one counter left out was `backlog_sweeping`, and it is the one that
    // explains why a tick did nothing else. A reader of this line should never
    // have to go and read the tick body to find a field it dropped.
    const { cfg, cleanup } = config()
    try {
      const result = await buildEmailPipelinePollHandler(cfg)(CTX)
      for (const key of [
        'scanned',
        'escalated',
        'archived',
        'precutoff',
        'resumed',
        'remutated',
        'arrived_during_sweep',
        'abandoned',
        'backlog_sweeping',
        'errors',
      ]) {
        expect(result.detail).toContain(`${key}=`)
      }
    } finally {
      cleanup()
    }
  })
})
