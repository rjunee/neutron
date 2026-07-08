/**
 * Proactive cron-registration tests. Asserts the morning-brief + idle-nudge
 * sweep register on the shared cron registries (reusing existing cron infra,
 * not a new scheduler), with the expected job names + interval schedules, and
 * that the wrapped handlers run and report a structured status.
 *
 * Spec: gap-audit P0-5 (WAVE 2 Track A).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import type { OutgoingMessage } from '../sink.ts'
import { ProactiveStateStore } from '../state-store.ts'
import { DEFAULT_BRIEF_INTERVAL_MS } from '../morning-brief.ts'
import { DEFAULT_SWEEP_INTERVAL_MS } from '../idle-nudge-sweep.ts'
import {
  IDLE_NUDGE_SWEEP_HANDLER_NAME,
  MORNING_BRIEF_HANDLER_NAME,
  buildIdleNudgeSweepHandler,
  buildMorningBriefHandler,
  registerIdleNudgeSweepCron,
  registerMorningBriefCron,
} from '../cron.ts'

const TZ = 'America/Los_Angeles'
const NOON_LA_MS = Date.UTC(2026, 5, 20, 16, 0, 0)

interface Harness {
  db: ProjectDb
  store: ProactiveStateStore
  sent: OutgoingMessage[]
  sink: { send(m: OutgoingMessage): Promise<string> }
  close(): void
}

function open(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-proactive-cron-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const sent: OutgoingMessage[] = []
  return {
    db,
    store: new ProactiveStateStore(db),
    sent,
    sink: {
      async send(m: OutgoingMessage): Promise<string> {
        sent.push(m)
        return 'id'
      },
    },
    close: () => {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

let h: Harness
beforeEach(() => {
  h = open()
})
afterEach(() => {
  h.close()
})

const ctx = (job_name: string) => ({ job_name, project_slug: 'demo', fired_at: NOON_LA_MS })

describe('registerMorningBriefCron', () => {
  it('registers the job + handler and the handler posts on tick', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const handler = buildMorningBriefHandler({
      store: h.store,
      sources: { focusQueue: async () => [{ title: 'Do the thing' }] },
      sink: h.sink,
      general_topic_id: '-100:7',
      tz: TZ,
      now: () => NOON_LA_MS,
    })
    const { job_name } = registerMorningBriefCron({ project_slug: 'demo', jobs, handlers, handler })
    expect(job_name).toBe('proactive-brief-demo')
    const job = jobs.get(job_name)!
    expect(job.handler).toBe(MORNING_BRIEF_HANDLER_NAME)
    expect(job.schedule).toEqual({ kind: 'interval_ms', interval_ms: DEFAULT_BRIEF_INTERVAL_MS })
    expect(handlers.get(MORNING_BRIEF_HANDLER_NAME)).toBeDefined()

    const result = await handlers.get(MORNING_BRIEF_HANDLER_NAME)!(ctx(job_name))
    expect(result.status).toBe('ok')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('Do the thing')
  })

  // #320 — a delivery outage must surface as an ERROR in cron telemetry, not
  // be folded into the benign `skipped` bucket where outages go unnoticed.
  it('#320 maps a delivery failure to error (not skipped)', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const handler = buildMorningBriefHandler({
      store: h.store,
      sources: { focusQueue: async () => [{ title: 'Do the thing' }] },
      sink: {
        async send(): Promise<string> {
          throw new Error('telegram 500')
        },
      },
      general_topic_id: '-100:7',
      tz: TZ,
      now: () => NOON_LA_MS,
    })
    const { job_name } = registerMorningBriefCron({ project_slug: 'demo', jobs, handlers, handler })
    const result = await handlers.get(MORNING_BRIEF_HANDLER_NAME)!(ctx(job_name))
    expect(result.status).toBe('error')
    expect(result.detail).toContain('deliver_failed')
    // The day was NOT recorded, so the next tick retries.
    expect(h.store.hasBriefForDay('2026-06-20')).toBe(false)
  })

  it('honors an interval override and is idempotent on the handler registration', () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const handler = buildMorningBriefHandler({
      store: h.store,
      sources: {},
      sink: h.sink,
      general_topic_id: '-100:7',
      tz: TZ,
      now: () => NOON_LA_MS,
    })
    registerMorningBriefCron({ project_slug: 'a', jobs, handlers, handler, interval_ms: 90_000 })
    // A second instance registers its own job but piggy-backs the shared handler.
    registerMorningBriefCron({ project_slug: 'b', jobs, handlers, handler })
    expect(jobs.get('proactive-brief-a')!.schedule).toEqual({ kind: 'interval_ms', interval_ms: 90_000 })
    expect(jobs.get('proactive-brief-b')).toBeDefined()
    expect(handlers.list().filter((n) => n === MORNING_BRIEF_HANDLER_NAME)).toHaveLength(1)
  })
})

describe('registerIdleNudgeSweepCron', () => {
  it('registers the job + handler and the handler runs on tick', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const handler = buildIdleNudgeSweepHandler({
      db: h.db,
      store: h.store,
      sink: h.sink,
      listTopics: () => [],
      tz: TZ,
      now: () => NOON_LA_MS,
    })
    const { job_name } = registerIdleNudgeSweepCron({ project_slug: 'demo', jobs, handlers, handler })
    expect(job_name).toBe('proactive-nudge-sweep-demo')
    const job = jobs.get(job_name)!
    expect(job.handler).toBe(IDLE_NUDGE_SWEEP_HANDLER_NAME)
    expect(job.schedule).toEqual({ kind: 'interval_ms', interval_ms: DEFAULT_SWEEP_INTERVAL_MS })

    // No topics → handler runs cleanly and reports skipped (nothing posted).
    const result = await handlers.get(IDLE_NUDGE_SWEEP_HANDLER_NAME)!(ctx(job_name))
    expect(result.status).toBe('skipped')
    expect(result.detail).toContain('posted=0')
  })
})
