import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  attachOvernightWorkCompletedHook,
  createOvernightReviewTask,
  overnightReviewTaskHash,
} from '../overnight-task-hook.ts'
import { TaskStore } from '../store.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-overnight-hook-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('overnight-task-hook', () => {
  test('emits a source=overnight review task', async () => {
    const store = new TaskStore(db)
    const task = await createOvernightReviewTask({
      store,
      event: {
        project_slug: 't1',
        project_id: 'proj-A',
        item_title: 'rotate API keys',
        description: 'see docs/decisions/2026-05-19-key-rotation.md',
        completed_at_ms: Date.parse('2026-05-20T06:30:00.000Z'),
      },
    })
    expect(task.source).toBe('overnight')
    expect(task.priority).toBe(1)
    expect(task.title).toBe('Review overnight work: rotate API keys')
    expect(task.description).toContain('docs/decisions')
    expect(task.project_id).toBe('proj-A')
  })

  test('idempotent — same event produces the same task row', async () => {
    const store = new TaskStore(db)
    const event = {
      project_slug: 't1',
      project_id: 'proj-A',
      item_title: 'one',
      completed_at_ms: Date.parse('2026-05-20T06:30:00.000Z'),
    }
    const a = await createOvernightReviewTask({ store, event })
    const b = await createOvernightReviewTask({ store, event })
    expect(a.id).toBe(b.id)
    expect(
      store.list({ project_slug: 't1', status: 'all', limit: 100 }),
    ).toHaveLength(1)
  })

  test('different projects produce distinct tasks', async () => {
    const store = new TaskStore(db)
    const completed = Date.parse('2026-05-20T06:30:00.000Z')
    await createOvernightReviewTask({
      store,
      event: {
        project_slug: 't1',
        project_id: 'proj-A',
        item_title: 'work-A',
        completed_at_ms: completed,
      },
    })
    await createOvernightReviewTask({
      store,
      event: {
        project_slug: 't1',
        project_id: 'proj-B',
        item_title: 'work-B',
        completed_at_ms: completed,
      },
    })
    const rows = store.list({ project_slug: 't1', status: 'all', limit: 100 })
    expect(rows).toHaveLength(2)
    const projects = rows.map((r) => r.project_id).sort()
    expect(projects).toEqual(['proj-A', 'proj-B'])
  })

  test('attachOvernightWorkCompletedHook returns a callable subscriber', async () => {
    const store = new TaskStore(db)
    const hook = attachOvernightWorkCompletedHook({ store })
    const task = await hook({
      project_slug: 't1',
      project_id: '',
      item_title: 'project-level work',
      completed_at_ms: Date.parse('2026-05-20T06:30:00.000Z'),
    })
    expect(task.source).toBe('overnight')
    expect(task.project_id).toBe('')
  })

  test('overnightReviewTaskHash is stable + bucketed to the minute', () => {
    const baseMs = Date.parse('2026-05-20T06:30:00.000Z')
    const a = overnightReviewTaskHash({
      project_slug: 't1',
      project_id: 'proj-A',
      item_title: 'one',
      completed_at_ms: baseMs,
    })
    const b = overnightReviewTaskHash({
      project_slug: 't1',
      project_id: 'proj-A',
      item_title: 'one',
      completed_at_ms: baseMs + 30_000, // jitter inside the minute
    })
    expect(a).toBe(b)
  })
})
