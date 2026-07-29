import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { computeFocusScore } from '../focus-score.ts'
import {
  buildFocusScoreRecomputeHandler,
  buildFocusScoreRecomputeJob,
  FOCUS_SCORE_HANDLER_NAME,
  recomputeFocusScoresForProject,
  registerFocusScoreRecomputeCron,
} from '../focus-score-cron.ts'
import { TaskStore } from '../store.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-focus-cron-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('registerFocusScoreRecomputeCron', () => {
  test('registers the job + handler exactly once', () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const handler = buildFocusScoreRecomputeHandler({ db })
    const { job_name } = registerFocusScoreRecomputeCron({
      project_slug: 't1',
      jobs,
      handlers,
      handler,
    })
    expect(job_name).toBe('tasks-focus-score-t1')
    expect(jobs.get(job_name)?.handler).toBe(FOCUS_SCORE_HANDLER_NAME)
    expect(handlers.get(FOCUS_SCORE_HANDLER_NAME)).toBeDefined()
  })

  test('second-project register reuses the shared handler name', () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const handler = buildFocusScoreRecomputeHandler({ db })
    registerFocusScoreRecomputeCron({
      project_slug: 't1',
      jobs,
      handlers,
      handler,
    })
    // Same handler instance is fine — registry rejects a re-register,
    // but the helper guards on `handlers.get(...) === undefined`.
    registerFocusScoreRecomputeCron({
      project_slug: 't2',
      jobs,
      handlers,
      handler,
    })
    expect(jobs.list().map((j) => j.name).sort()).toEqual([
      'tasks-focus-score-t1',
      'tasks-focus-score-t2',
    ])
  })

  test('buildFocusScoreRecomputeJob respects override interval', () => {
    const job = buildFocusScoreRecomputeJob({
      project_slug: 't1',
      interval_ms: 30_000,
    })
    expect(job.schedule).toEqual({ kind: 'interval_ms', interval_ms: 30_000 })
  })
})

describe('recomputeFocusScoresForProject', () => {
  test('updates focus_score on every open task', async () => {
    const store = new TaskStore(db)
    const a = await store.create({
      project_slug: 't1',
      title: 'a',
      priority: 3,
      due_date: '2026-01-01T00:00:00.000Z', // overdue against now
    })
    const b = await store.create({ project_slug: 't1', title: 'b', priority: 0 })
    // Verify the synchronous-stamped scores were set on create.
    expect(a.focus_score).not.toBeNull()
    expect(b.focus_score).not.toBeNull()

    const nowMs = Date.parse('2026-05-20T12:00:00.000Z')
    const result = await recomputeFocusScoresForProject({
      db,
      project_slug: 't1',
      now: () => nowMs,
    })
    expect(result.scanned).toBe(2)
    expect(result.updated).toBe(2)
    const updatedA = store.get(a.id)
    const updatedB = store.get(b.id)
    expect(updatedA?.focus_score_updated_at).toBe(new Date(nowMs).toISOString())
    expect(updatedB?.focus_score_updated_at).toBe(new Date(nowMs).toISOString())
    // Sanity: the post-cron value should match the pure-function output.
    const expectedA = computeFocusScore({
      priority: 3,
      due_date: '2026-01-01T00:00:00.000Z',
      updated_at: a.updated_at,
      now: new Date(nowMs),
    })
    expect(updatedA?.focus_score).toBe(expectedA)
  })

  test('handler.ok / handler.skipped reflect open-task presence', async () => {
    const store = new TaskStore(db)
    const handler = buildFocusScoreRecomputeHandler({ db })
    const r1 = await handler({
      job_name: 'tasks-focus-score-t1',
      owner_slug: 't1',
      fired_at: Date.now(),
    })
    expect(r1.status).toBe('skipped')
    await store.create({ project_slug: 't1', title: 'one' })
    const r2 = await handler({
      job_name: 'tasks-focus-score-t1',
      owner_slug: 't1',
      fired_at: Date.now(),
    })
    expect(r2.status).toBe('ok')
    expect(r2.detail).toContain('scanned=1')
  })
})
