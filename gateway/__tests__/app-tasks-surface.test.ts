/**
 * P5.4 — gateway app-tasks surface tests.
 *
 * Round-trips the six tasks routes (list, create, update, complete,
 * cancel, delete) through `composeHttpHandler` with the dev-bypass
 * auth resolver and a real `TaskStore` over a fresh per-test SQLite
 * file (so the canonical migration runs end-to-end). Mirrors the
 * structure of `gateway/__tests__/app-launcher-surface.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TaskStore, type Task } from '@neutronai/tasks/store.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'
import { createAppTasksSurface } from '../http/app-tasks-surface.ts'

// --- in-process handler shim (no socket) -------------------------------------
// These surface tests used to bind a real `Bun.serve({ port: 0 })` and round-
// trip via the global `fetch`, holding a live listener + socket buffers in the
// chunk's RSS until teardown. Instead each harness registers its composed
// handler under a unique in-process base, and `fetch` is shadowed at module
// scope so requests to a registered base dispatch straight to
// `composed.fetch(new Request(...))` — identical assertions, no socket.
// Unrelated URLs fall through to the real fetch.
const __composedHandlers = new Map<string, ComposedHttpHandler>()
let __gatewaySeq = 0
const __realFetch = globalThis.fetch.bind(globalThis)
const fetch = ((input: Request | string | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
  const composed = __composedHandlers.get(new URL(req.url).host)
  if (composed !== undefined) return Promise.resolve(composed.fetch(req, undefined as never))
  return __realFetch(input as Parameters<typeof __realFetch>[0], init)
}) as typeof globalThis.fetch

interface Harness {
  base: string
  store: TaskStore
  db: ProjectDb
  tmp: string
  close(): Promise<void>
}

const PROJECT_ID = 'demo-project'
const OTHER_PROJECT_ID = 'other-project'
const PROJECT_SLUG = 'demo'

async function startGateway(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-app-tasks-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const store = new TaskStore(db)

  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
  const surface = createAppTasksSurface({ store, auth })
  const composed = composeHttpHandler({
    appTasks: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const host = `gw-${++__gatewaySeq}.test`
  __composedHandlers.set(host, composed)
  return {
    base: `http://${host}`,
    store,
    db,
    tmp,
    close: async () => {
      __composedHandlers.delete(host)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function authedFetch(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', 'Bearer dev:sam')
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

describe('app-tasks surface — GET list', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('rejects requests without a Bearer token', async () => {
    const res = await fetch(`${harness.base}/api/app/projects/${PROJECT_ID}/tasks`)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('returns an empty list for a fresh project', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; tasks: Task[]; project_id: string; status: string }
    expect(json.ok).toBe(true)
    expect(json.project_id).toBe(PROJECT_ID)
    expect(json.status).toBe('open')
    expect(json.tasks).toEqual([])
  })

  it('returns only open tasks by default', async () => {
    await harness.store.create({ project_slug: PROJECT_SLUG, project_id: PROJECT_ID, title: 'still open' })
    const done = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'will complete',
    })
    await harness.store.complete(done.id)

    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks`)
    const json = (await res.json()) as { tasks: Task[] }
    expect(json.tasks.map((t) => t.title)).toEqual(['still open'])
  })

  it('honours ?status=done|all|cancelled', async () => {
    await harness.store.create({ project_slug: PROJECT_SLUG, project_id: PROJECT_ID, title: 'open task' })
    const done = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'done task',
    })
    await harness.store.complete(done.id)
    const cancelled = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'cancel me',
    })
    await harness.store.cancel(cancelled.id)

    const doneRes = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks?status=done`)
    const doneJson = (await doneRes.json()) as { tasks: Task[] }
    expect(doneJson.tasks.map((t) => t.title)).toEqual(['done task'])

    const cancelledRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks?status=cancelled`,
    )
    const cancelledJson = (await cancelledRes.json()) as { tasks: Task[] }
    expect(cancelledJson.tasks.map((t) => t.title)).toEqual(['cancel me'])

    const allRes = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks?status=all`)
    const allJson = (await allRes.json()) as { tasks: Task[] }
    const titles = new Set(allJson.tasks.map((t) => t.title))
    expect(titles.has('open task')).toBe(true)
    expect(titles.has('done task')).toBe(true)
    expect(titles.has('cancel me')).toBe(true)
  })

  it('rejects an invalid status filter', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks?status=garbage`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_status_filter')
  })

  it('rejects an invalid limit', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks?limit=0`)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_limit')
  })

  it('respects the server-authoritative sort: dated open → dateless open → done → cancelled', async () => {
    // Build a fixed mix and check the order matches `TaskStore.list`.
    const dated = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'dated',
      due_date: '2026-05-20T09:00:00.000Z',
    })
    void dated
    await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'dateless',
    })
    const done = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'done',
    })
    await harness.store.complete(done.id)
    const cancelled = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'cancelled',
    })
    await harness.store.cancel(cancelled.id)

    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks?status=all`)
    const json = (await res.json()) as { tasks: Task[] }
    expect(json.tasks.map((t) => t.title)).toEqual(['dated', 'dateless', 'done', 'cancelled'])
  })

  it('rejects a malformed project_id', async () => {
    const res = await authedFetch(harness.base, '/api/app/projects/has%20space/tasks')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_project_id')
  })

  it('isolates tasks per project', async () => {
    await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'A',
    })
    await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: OTHER_PROJECT_ID,
      title: 'B',
    })

    const aRes = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks`)
    const aJson = (await aRes.json()) as { tasks: Task[] }
    expect(aJson.tasks.map((t) => t.title)).toEqual(['A'])

    const bRes = await authedFetch(harness.base, `/api/app/projects/${OTHER_PROJECT_ID}/tasks`)
    const bJson = (await bRes.json()) as { tasks: Task[] }
    expect(bJson.tasks.map((t) => t.title)).toEqual(['B'])
  })
})

describe('app-tasks surface — POST create', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('creates a task and round-trips on GET', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'wire P5.4 surface',
        description: 'land the tasks tab',
        priority: 2,
        due_date: '2026-05-21T09:00:00.000Z',
      }),
    })
    expect(res.status).toBe(201)
    const json = (await res.json()) as { ok: boolean; task: Task }
    expect(json.ok).toBe(true)
    expect(json.task.title).toBe('wire P5.4 surface')
    expect(json.task.priority).toBe(2)
    expect(json.task.due_date).toBe('2026-05-21T09:00:00.000Z')
    expect(json.task.project_id).toBe(PROJECT_ID)
    expect(json.task.project_slug).toBe(PROJECT_SLUG)
    expect(json.task.source).toBe('app')

    const listRes = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks`)
    const listJson = (await listRes.json()) as { tasks: Task[] }
    expect(listJson.tasks).toHaveLength(1)
    expect(listJson.tasks[0]?.id).toBe(json.task.id)
  })

  it('trims whitespace and rejects empty title', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: '   ' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_title')
  })

  it('rejects non-string title', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: 42 }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_title')
  })

  it('rejects malformed due_date (non-ISO)', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: 'ok', due_date: 'tomorrow' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_due_date')
  })

  it('rejects out-of-range priority', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: 'ok', priority: 9 }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_priority')
  })

  it('rejects non-integer priority', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: 'ok', priority: 1.5 }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_priority')
  })

  it('rejects malformed JSON', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks`, {
      method: 'POST',
      body: 'not-json',
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('malformed_json')
  })
})

describe('app-tasks surface — PATCH update', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('patches fields in place', async () => {
    const created = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'before',
    })

    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks/${created.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ title: 'after', priority: 3 }),
      },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { task: Task }
    expect(json.task.title).toBe('after')
    expect(json.task.priority).toBe(3)
  })

  it('refuses to patch a task from another project (returns 404)', async () => {
    const created = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: OTHER_PROJECT_ID,
      title: 'in other project',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks/${created.id}`,
      { method: 'PATCH', body: JSON.stringify({ title: 'malicious' }) },
    )
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('task_not_found')

    // Sanity: the row is untouched.
    const refetched = harness.store.get(created.id)
    expect(refetched?.title).toBe('in other project')
  })

  it('returns 404 for an unknown task_id', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks/does-not-exist`,
      { method: 'PATCH', body: JSON.stringify({ title: 'never' }) },
    )
    expect(res.status).toBe(404)
  })

  it('rejects malformed task_id charset', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks/has%20space`,
      { method: 'PATCH', body: JSON.stringify({ title: 'x' }) },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_task_id')
  })

  it('rejects invalid status transitions at the API boundary', async () => {
    const created = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'x',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks/${created.id}`,
      { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_status')
  })
})

describe('app-tasks surface — POST complete + cancel + DELETE', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('marks a task done and stamps completed_at', async () => {
    const created = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'finish me',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks/${created.id}/complete`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { task: Task }
    expect(json.task.status).toBe('done')
    expect(json.task.completed_at).not.toBeNull()
  })

  it('marks a task cancelled', async () => {
    const created = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'cancel me',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks/${created.id}/cancel`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { task: Task }
    expect(json.task.status).toBe('cancelled')
  })

  it('refuses to complete a task from another project', async () => {
    const created = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: OTHER_PROJECT_ID,
      title: 'in other project',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks/${created.id}/complete`,
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
    // Untouched.
    expect(harness.store.get(created.id)?.status).toBe('open')
  })

  it('deletes a task', async () => {
    const created = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'goodbye',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks/${created.id}`,
      { method: 'DELETE' },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; deleted_task_id: string }
    expect(json.ok).toBe(true)
    expect(json.deleted_task_id).toBe(created.id)
    expect(harness.store.get(created.id)).toBeNull()
  })

  it('returns 404 deleting an unknown task', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks/missing-id`,
      { method: 'DELETE' },
    )
    expect(res.status).toBe(404)
  })

  it('refuses to delete a task from another project', async () => {
    const created = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: OTHER_PROJECT_ID,
      title: 'in other project',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks/${created.id}`,
      { method: 'DELETE' },
    )
    expect(res.status).toBe(404)
    expect(harness.store.get(created.id)).not.toBeNull()
  })

  it('returns 405 for an unsupported method on /tasks', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tasks`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(405)
  })

  it('returns 405 for an unknown verb under /tasks/<id>', async () => {
    const created = await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'verb-router',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks/${created.id}/explode`,
      { method: 'POST' },
    )
    expect(res.status).toBe(405)
  })
})

describe('app-tasks surface — fall-through behaviour', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('does not claim unrelated /api paths', async () => {
    const res = await fetch(`${harness.base}/api/something/else`)
    expect(res.status).toBe(404)
  })

  it('does not claim /api/app/projects/<id> without a /tasks segment', async () => {
    const res = await fetch(`${harness.base}/api/app/projects/${PROJECT_ID}`)
    expect(res.status).toBe(404)
  })
})
