/**
 * HTTP surface test for `GET /api/app/focus/current` (P6.1).
 *
 * Asserts:
 *   - 200 + canonical payload (joined task + rationale) when a row exists.
 *   - 404 when no row exists for today.
 *   - 404 when the pick references a task that no longer exists.
 *   - 401 on missing / wrong auth.
 *   - 405 on non-GET.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { TaskStore } from '../../tasks/store.ts'
import {
  createAppFocusCurrentSurface,
  type FocusCurrentResponse,
} from '../http/app-focus-current-surface.ts'

const OWNER = 'demo'

interface Harness {
  db: ProjectDb
  tasks: TaskStore
  base: string
  close(): Promise<void>
}

async function startGateway(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-focus-current-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const tasks = new TaskStore(db)
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  // Fix the wall clock to 2026-05-23 18:00 UTC → LA day = 2026-05-23.
  const fixedNow = Date.UTC(2026, 4, 23, 18, 0, 0)
  const surface = createAppFocusCurrentSurface({
    db,
    auth,
    now: () => fixedNow,
    timezone: 'America/Los_Angeles',
  })
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const res = await surface.handler(req)
      return res ?? new Response('not found', { status: 404 })
    },
  })
  return {
    db,
    tasks,
    base: `http://127.0.0.1:${server.port}`,
    close: async () => {
      server.stop(true)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function seedPick(
  db: ProjectDb,
  owner: string,
  day: string,
  task_id: string,
  rationale = 'because reasons',
): Promise<void> {
  await db.run(
    `INSERT INTO current_focus_pick
      (project_slug, day, task_id, llm_rationale, top_3_task_ids, created_at, llm_model, llm_request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      owner,
      day,
      task_id,
      rationale,
      JSON.stringify([task_id]),
      `${day}T12:00:00.000Z`,
      'claude-haiku-4-5',
    ],
  )
}

describe('GET /api/app/focus/current', () => {
  let h: Harness

  beforeEach(async () => {
    h = await startGateway()
  })

  afterEach(async () => {
    await h.close()
  })

  it('returns 200 + payload when a pick exists for today', async () => {
    const t = await h.tasks.create({
      project_slug: OWNER,
      title: 'Do the thing',
      priority: 3,
    })
    await seedPick(h.db, OWNER, '2026-05-23', t.id, 'P3 leads')

    const res = await fetch(`${h.base}/api/app/focus/current`, {
      headers: { authorization: 'Bearer dev' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as FocusCurrentResponse
    expect(body.ok).toBe(true)
    expect(body.project_slug).toBe(OWNER)
    expect(body.pick.day).toBe('2026-05-23')
    expect(body.pick.task_id).toBe(t.id)
    expect(body.pick.task.title).toBe('Do the thing')
    expect(body.pick.llm_rationale).toBe('P3 leads')
    expect(body.pick.llm_model).toBe('claude-haiku-4-5')
  })

  it('returns 404 when no pick exists for today', async () => {
    await h.tasks.create({ project_slug: OWNER, title: 'No pick', priority: 2 })
    const res = await fetch(`${h.base}/api/app/focus/current`, {
      headers: { authorization: 'Bearer dev' },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('no_pick_today')
  })

  it('returns 404 when pick references a deleted task', async () => {
    const t = await h.tasks.create({
      project_slug: OWNER,
      title: 'will be deleted',
      priority: 3,
    })
    await seedPick(h.db, OWNER, '2026-05-23', t.id)
    await h.tasks.delete(t.id)

    const res = await fetch(`${h.base}/api/app/focus/current`, {
      headers: { authorization: 'Bearer dev' },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('pick_task_missing')
  })

  it('returns 401 when bearer header is missing', async () => {
    const res = await fetch(`${h.base}/api/app/focus/current`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('missing_bearer')
  })

  it('returns 405 on non-GET', async () => {
    const res = await fetch(`${h.base}/api/app/focus/current`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev' },
    })
    expect(res.status).toBe(405)
  })

  it('does not leak rows across owners', async () => {
    const t = await h.tasks.create({
      project_slug: OWNER,
      title: 'mine',
      priority: 3,
    })
    await seedPick(h.db, OWNER, '2026-05-23', t.id)
    // Seed a pick for a different project scope; the surface auth resolver
    // binds to the harness slug via bypass, so the response should still come
    // from our instance's row.
    await seedPick(h.db, 'other-project', '2026-05-23', 'unrelated-task-id', 'leak')

    const res = await fetch(`${h.base}/api/app/focus/current`, {
      headers: { authorization: 'Bearer dev' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as FocusCurrentResponse
    expect(body.pick.task_id).toBe(t.id)
    expect(body.pick.llm_rationale).toBe('because reasons')
  })
})
