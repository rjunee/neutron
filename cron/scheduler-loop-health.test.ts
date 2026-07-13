/**
 * §F2 defect #4 — the cron scheduler must stamp its LoopRegistry health only
 * AFTER the fire TAIL (`state.record`) settles: a handler/record error must show
 * in `describe().health().lastError`, a healthy fire must CLEAR it, and a
 * `record()` rejection must NOT be reported healthy (the pre-fix bug stamped
 * health BEFORE awaiting `record()`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { CronJobRegistry } from './jobs.ts'
import { CronHandlerRegistry } from './handlers.ts'
import { CronScheduler } from './scheduler.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-cron-health-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})
afterEach(() => {
  try {
    db.close()
  } catch {
    /* already closed by a test */
  }
  rmSync(tmp, { recursive: true, force: true })
})

function scheduler(handler: () => Promise<{ status: 'ok' | 'error'; detail?: string }>): CronScheduler {
  const jobs = new CronJobRegistry()
  jobs.register({
    name: 'job',
    description: '',
    schedule: { kind: 'interval_ms', interval_ms: 1000 },
    handler: 'h',
  })
  const handlers = new CronHandlerRegistry()
  handlers.register('h', handler)
  return new CronScheduler({ jobs, handlers, db, project_slug: 't1' })
}

describe('CronScheduler — loop-inventory health (defect #4)', () => {
  test('a handler error surfaces in health; a later healthy fire CLEARS it', async () => {
    let fail = true
    const sched = scheduler(async () =>
      fail ? { status: 'error', detail: 'bad job' } : { status: 'ok' },
    )
    await sched.fireOnce('job')
    let health = sched.describe().health()
    expect(health.lastError).toBe('bad job')
    expect(health.lastTickAt).toBeGreaterThan(0)

    // Recovery — a healthy fire nulls the error.
    fail = false
    await sched.fireOnce('job')
    health = sched.describe().health()
    expect(health.lastError).toBeNull()
    expect(health.lastTickAt).toBeGreaterThan(0)
  })

  test('a healthy fire reports null error', async () => {
    const sched = scheduler(async () => ({ status: 'ok' }))
    await sched.fireOnce('job')
    expect(sched.describe().health().lastError).toBeNull()
  })

  test('a record() TAIL failure is reported as an error, not healthy', async () => {
    // A dedicated db we close BEFORE firing so `state.record()` rejects in the
    // fire tail. The handler still runs healthy; the tail failure must set
    // `lastError` (the pre-fix bug stamped healthy BEFORE awaiting record()).
    const localTmp = mkdtempSync(join(tmpdir(), 'neutron-cron-tail-'))
    const localDb = ProjectDb.open(join(localTmp, 'project.db'))
    applyMigrations(localDb.raw())
    const jobs = new CronJobRegistry()
    jobs.register({
      name: 'job',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 1000 },
      handler: 'h',
    })
    const handlers = new CronHandlerRegistry()
    handlers.register('h', async () => ({ status: 'ok' as const }))
    const sched = new CronScheduler({ jobs, handlers, db: localDb, project_slug: 't1' })
    localDb.close() // make the record() tail throw

    let threw = false
    try {
      await sched.fireOnce('job')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    const health = sched.describe().health()
    expect(health.lastError).not.toBeNull()
    expect(health.lastTickAt).toBeGreaterThan(0)
    rmSync(localTmp, { recursive: true, force: true })
  })
})
