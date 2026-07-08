/**
 * P5.4 — production-composer reachability guard for the tasks
 * surface.
 *
 * What this test guards (the anti-pattern Argus has caught three
 * sprints in a row: chat-send HTTP fallback unreachable from
 * `composeProductionGraph` (PR #222); projects-client method
 * unexercised end-to-end (PR #225); the same pattern landed for
 * launcher in P5.3 (PR #227)). Per the P5.4 brief § 5.5 + § 6.3,
 * the tasks tab gets its own version up-front so Argus doesn't have
 * to flag it a fourth time:
 *
 *   1. Boot `composeProductionGraph` against an in-memory SQLite +
 *      a dev-bypass `AppWsAuthResolver`.
 *   2. Construct the tasks surface (`createAppTasksSurface`) the
 *      same way `gateway/index.ts` does at boot.
 *   3. Compose the HTTP chain via the SAME `composeHttpHandler`
 *      factory the production gateway uses (NOT a hand-rolled
 *      router). The point is to assert the production composition
 *      mounts every tasks route.
 *   4. Fire HTTP requests at all SIX tasks routes (GET list / POST
 *      create / PATCH update / POST complete / POST cancel /
 *      DELETE) AND the `?order=focus_score` opt-in path AND the
 *      bearer-missing + unknown-verb branches. Assert 200s on the
 *      happy paths with the canonical envelope shape.
 *
 * If a future refactor accidentally drops any tasks route from
 * `app-tasks-surface.ts` OR drops the surface from
 * `composeHttpHandler`'s chain, this test fails. The brief calls
 * this out as the MANDATORY anti-pattern gate (CRITICAL gate § 8).
 *
 * Mirrors `gateway/__tests__/launcher-production-composer.test.ts`
 * (P5.3) verbatim.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TaskStore, type Task } from '@neutronai/tasks/store.ts'
import { composeProductionGraph } from '../composition.ts'
import { createAppTasksSurface } from '../http/app-tasks-surface.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const OWNER = 'tasks-composer-project'
const PROJECT = 'demo-project'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  store: TaskStore
  close(): Promise<void>
}

const noOpInputBase = {
  topic_handler: async () => {},
  approval_notifier: { notify: async () => undefined },
  watchdog_notifier: { notify: async () => undefined },
  reminder_dispatcher: { dispatch: async () => undefined },
  heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-tasks-composer-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  // Build the surface pieces FIRST so we can hand them to
  // `composeProductionGraph` via `app_tasks_surface`. Mirrors the
  // boot shell at gateway/index.ts.
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const store = new TaskStore(db)
  const tasksSurface = createAppTasksSurface({ store, auth })

  // Boot the production graph with the tasks surface threaded
  // through. If a future CompositionInput field rename / removal
  // drops `app_tasks_surface` from the typed shape, this
  // construction breaks at compile time BEFORE the runtime test
  // runs.
  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_tasks_surface: { handler: tasksSurface.handler },
  })

  // ISSUE #32 — serve `graph.fetch` directly. The composed handler is
  // built by `composeProductionGraph` itself from
  // `composition.app_tasks_surface`, so the boot-wiring mapping IS
  // the only path exercised. Deletion of the mapping line in
  // `gateway/composition.ts:buildComposedHttpFromComposition` provably
  // breaks this test (the closing condition).
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error(
      'composeProductionGraph did not expose graph.fetch — production-composer reachability gap (ISSUE #32)',
    )
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket

  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })

  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    graph,
    db,
    store,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
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
  headers.set('authorization', 'Bearer dev:test-user')
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

async function seedTask(
  store: TaskStore,
  title: string,
  extra: { status?: 'open' | 'done' | 'cancelled'; priority?: number | null } = {},
): Promise<Task> {
  const created = await store.create({
    project_slug: OWNER,
    project_id: PROJECT,
    title,
    description: null,
    priority: extra.priority ?? null,
    due_date: null,
    owner_persona: null,
    source: 'seed',
  })
  if (extra.status === 'done') return store.complete(created.id)
  if (extra.status === 'cancelled') return store.cancel(created.id)
  return created
}

let harness: Harness
beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

test('production composer mounts GET /api/app/projects/<id>/tasks', async () => {
  await seedTask(harness.store, 'first')
  await seedTask(harness.store, 'second', { priority: 0 })

  const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT}/tasks`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    tasks: Task[]
    project_id: string
    status: string
    order: string
  }
  expect(body.ok).toBe(true)
  expect(body.project_id).toBe(PROJECT)
  expect(Array.isArray(body.tasks)).toBe(true)
  expect(body.tasks).toHaveLength(2)
  // Default status filter is 'open'.
  expect(body.status).toBe('open')
})

test('production composer mounts GET /api/app/projects/<id>/tasks?order=focus_score', async () => {
  await seedTask(harness.store, 'with-focus')
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/tasks?order=focus_score`,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    tasks: Task[]
    order: string
  }
  expect(body.ok).toBe(true)
  expect(body.order).toBe('focus_score')
})

test('production composer mounts POST /api/app/projects/<id>/tasks (create)', async () => {
  const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title: 'newly created via composer' }),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { ok: boolean; task: Task }
  expect(body.ok).toBe(true)
  expect(body.task.title).toBe('newly created via composer')
  expect(body.task.status).toBe('open')
  expect(body.task.project_id).toBe(PROJECT)
})

test('production composer mounts PATCH /api/app/projects/<id>/tasks/<id> (update)', async () => {
  const seeded = await seedTask(harness.store, 'original title')
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/tasks/${seeded.id}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ title: 'patched title' }),
    },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; task: Task }
  expect(body.ok).toBe(true)
  expect(body.task.title).toBe('patched title')
})

test('production composer mounts POST /api/app/projects/<id>/tasks/<id>/complete', async () => {
  const seeded = await seedTask(harness.store, 'to be completed')
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/tasks/${seeded.id}/complete`,
    { method: 'POST' },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; task: Task }
  expect(body.ok).toBe(true)
  expect(body.task.status).toBe('done')
})

test('production composer mounts POST /api/app/projects/<id>/tasks/<id>/cancel', async () => {
  const seeded = await seedTask(harness.store, 'to be cancelled')
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/tasks/${seeded.id}/cancel`,
    { method: 'POST' },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; task: Task }
  expect(body.ok).toBe(true)
  expect(body.task.status).toBe('cancelled')
})

test('production composer mounts DELETE /api/app/projects/<id>/tasks/<id>', async () => {
  const seeded = await seedTask(harness.store, 'to be deleted')
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/tasks/${seeded.id}`,
    { method: 'DELETE' },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; deleted_task_id: string }
  expect(body.ok).toBe(true)
  expect(body.deleted_task_id).toBe(seeded.id)
  // Confirm the row really is gone end-to-end (not just an envelope echo).
  expect(harness.store.get(seeded.id)).toBeNull()
})

test('every tasks route requires a Bearer token (401 missing_bearer)', async () => {
  const seeded = await seedTask(harness.store, 'auth-check')
  const paths: ReadonlyArray<[string, string, object | null]> = [
    [`/api/app/projects/${PROJECT}/tasks`, 'GET', null],
    [`/api/app/projects/${PROJECT}/tasks`, 'POST', { title: 'x' }],
    [`/api/app/projects/${PROJECT}/tasks/${seeded.id}`, 'PATCH', { title: 'y' }],
    [`/api/app/projects/${PROJECT}/tasks/${seeded.id}/complete`, 'POST', null],
    [`/api/app/projects/${PROJECT}/tasks/${seeded.id}/cancel`, 'POST', null],
    [`/api/app/projects/${PROJECT}/tasks/${seeded.id}`, 'DELETE', null],
  ]
  for (const [path, method, body] of paths) {
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json' },
    }
    if (body !== null) init.body = JSON.stringify(body)
    const res = await fetch(`${harness.base}${path}`, init)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  }
})

test('unknown tasks verb under /tasks/<id>/<bogus> returns 405 method_not_allowed', async () => {
  const seeded = await seedTask(harness.store, 'verb-check')
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/tasks/${seeded.id}/bogus`,
    { method: 'POST', body: JSON.stringify({}) },
  )
  expect(res.status).toBe(405)
  const json = (await res.json()) as { ok: boolean; code: string }
  expect(json.code).toBe('method_not_allowed')
})
