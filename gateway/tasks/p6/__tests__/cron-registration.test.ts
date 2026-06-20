/**
 * Cron-registration tests for the P6.1 nudge engine. Mirrors the
 * focus-score-cron registration test shape — same job + handler
 * registry semantics, just for `tasks.nudge_engine`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CronHandlerRegistry } from '../../../../cron/handlers.ts'
import { CronJobRegistry } from '../../../../cron/jobs.ts'
import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'
import {
  buildNudgeEngineHandler,
  buildNudgeEngineJob,
  DEFAULT_NUDGE_INTERVAL_MS,
  NUDGE_ENGINE_HANDLER_NAME,
  registerNudgeEngineCron,
} from '../nudge-engine.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-nudge-cron-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('registerNudgeEngineCron', () => {
  test('registers the job + handler exactly once', () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const handler = buildNudgeEngineHandler({ db, llm: null })
    const { job_name } = registerNudgeEngineCron({
      project_slug: 't1',
      jobs,
      handlers,
      handler,
    })
    expect(job_name).toBe('tasks-nudge-t1')
    expect(jobs.get(job_name)?.handler).toBe(NUDGE_ENGINE_HANDLER_NAME)
    expect(handlers.get(NUDGE_ENGINE_HANDLER_NAME)).toBeDefined()
  })

  test('second-project register reuses the shared handler name', () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const handler = buildNudgeEngineHandler({ db, llm: null })
    registerNudgeEngineCron({ project_slug: 't1', jobs, handlers, handler })
    registerNudgeEngineCron({ project_slug: 't2', jobs, handlers, handler })
    expect(jobs.list().map((j) => j.name).sort()).toEqual([
      'tasks-nudge-t1',
      'tasks-nudge-t2',
    ])
  })

  test('buildNudgeEngineJob respects override interval', () => {
    const job = buildNudgeEngineJob({ project_slug: 't1', interval_ms: 30_000 })
    expect(job.schedule).toEqual({ kind: 'interval_ms', interval_ms: 30_000 })
  })

  test('buildNudgeEngineJob defaults interval to 24h', () => {
    const job = buildNudgeEngineJob({ project_slug: 't1' })
    expect(job.schedule).toEqual({
      kind: 'interval_ms',
      interval_ms: DEFAULT_NUDGE_INTERVAL_MS,
    })
  })

  test('long slug falls back to a hashed job name', () => {
    const slug = 'x'.repeat(80)
    const job = buildNudgeEngineJob({ project_slug: slug })
    expect(job.name.length).toBeLessThanOrEqual(64)
    expect(job.name.startsWith('tasks-nudge-')).toBe(true)
  })
})
