/**
 * Proactive cron-registration tests. Asserts the idle-nudge sweep registers on the
 * shared cron registries (reusing existing cron infra, not a new scheduler), with
 * the expected job name + interval schedule, and that the wrapped handler runs and
 * reports a structured status.
 *
 * The morning-brief half of this file went with `gateway/proactive/morning-brief.ts`
 * (ISSUES #504) — that was the SECOND morning brief, whose context providers no
 * production composer ever supplied.
 *
 * Spec: gap-audit P0-5 (WAVE 2 Track A).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import type { OutgoingMessage } from '../sink.ts'
import { ProactiveStateStore } from '../state-store.ts'
import { DEFAULT_SWEEP_INTERVAL_MS } from '../idle-nudge-sweep.ts'
import { openMigratedDbAt } from '../../../tests/support/migrated-db.ts'
import {
  IDLE_NUDGE_SWEEP_HANDLER_NAME,
  buildIdleNudgeSweepHandler,
  registerIdleNudgeSweepCron,
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
  const db = openMigratedDbAt(join(tmp, 'owner.db'))
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

const ctx = (job_name: string) => ({ job_name, owner_slug: 'demo', fired_at: NOON_LA_MS })

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
