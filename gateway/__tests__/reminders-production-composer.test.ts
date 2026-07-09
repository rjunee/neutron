/**
 * P5.5 — production-composer reachability guard for the reminders
 * surface (the CRITICAL anti-pattern gate from
 * docs/plans/P5.5-reminders-tab-sprint-brief.md § 5.5 + § 8).
 *
 * What this test guards (the anti-pattern Argus has caught four
 * sprints in a row: chat-send HTTP fallback unreachable from
 * `composeProductionGraph` (PR #222); projects-client method
 * unexercised end-to-end (PR #225); launcher routes in P5.3 (PR
 * #227); tasks routes in P5.4 (PR #229)). The reminders tab lands
 * its production-composer-reachability guard up-front so Argus
 * doesn't have to flag it a fifth time.
 *
 *   1. Boot `composeProductionGraph` against an in-memory SQLite +
 *      a dev-bypass `AppWsAuthResolver`.
 *   2. Construct the reminders surface (`createAppRemindersSurface`)
 *      with the production `convertReminderToTask` adapter wired
 *      from the Reminders Core's canonical backend (which has the
 *      shared `TaskStore` from the production composer).
 *   3. Compose the HTTP chain via the SAME `composeHttpHandler`
 *      factory the production gateway uses (NOT a hand-rolled
 *      router — the point is to assert the production composition
 *      mounts every reminders route INCLUDING the new
 *      convert-to-task route + the adapter wiring).
 *   4. Fire HTTP requests at all FIVE reminders routes (GET list /
 *      POST create / POST snooze / POST cancel / POST
 *      convert-to-task [NEW]) AND the bearer-missing + unknown-verb
 *      branches. Assert 200s on the happy paths + the convert-to-
 *      task path actually creates a task in the shared TaskStore
 *      (P6 § 4.9 contract — the reverse-direction reminder → task
 *      link).
 *
 * Mirrors `gateway/__tests__/tasks-production-composer.test.ts`
 * (P5.4) verbatim.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ReminderStore } from '@neutronai/reminders/store.ts'
import { TaskStore } from '@neutronai/tasks/store.ts'
import { composeProductionGraph } from '../composition.ts'
import {
  appProjectTopicId,
  createAppRemindersSurface,
} from '../http/app-reminders-surface.ts'
import { composeHttpHandler } from '../http/compose.ts' // retained for the 501 "no adapter wired" sanity test below
import { buildReminderStoreBackend } from '@neutronai/reminders-core/backend'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const OWNER = 'reminders-composer-project'
const PROJECT = 'demo-project'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  store: ReminderStore
  taskStore: TaskStore
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
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-reminders-composer-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  // Build the surface pieces FIRST so we can hand them to
  // `composeProductionGraph` via `app_reminders_surface`. Mirrors
  // the boot shell at gateway/index.ts (the P5.5 extension).
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const store = new ReminderStore(db)
  const taskStore = new TaskStore(db)
  // P5.5 — production-style adapter construction: the Reminders
  // Core's canonical backend is bound to the shared TaskStore so the
  // convert-to-task path lands a row in the canonical tasks table.
  const reminderBackend = buildReminderStoreBackend({
    project_slug: OWNER,
    projectDb: db,
    taskStore,
  })
  const remindersSurface = createAppRemindersSurface({
    store,
    auth,
    convertReminderToTask: async (input) => {
      const convert = reminderBackend.convertToTask
      if (convert === undefined) {
        throw new Error('reminders backend missing convertToTask')
      }
      return convert({
        id: input.reminder_id,
        project_id: input.project_id,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
      })
    },
  })

  // Boot the production graph with the reminders surface threaded
  // through. If a future CompositionInput field rename / removal
  // drops `app_reminders_surface` from the typed shape, this
  // construction breaks at compile time BEFORE the runtime test
  // runs.
  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_reminders_surface: { handler: remindersSurface.handler },
  })

  // ISSUE #32 — serve `graph.fetch` directly. The composed handler is
  // built by `composeProductionGraph` itself from
  // `composition.app_reminders_surface`, so the boot-wiring mapping IS
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
    taskStore,
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

async function seedReminder(
  store: ReminderStore,
  message: string,
  fire_at_offset_seconds: number = 3600,
): Promise<{ id: string }> {
  const created = await store.create({
    project_slug: OWNER,
    topic_id: appProjectTopicId(PROJECT),
    fire_at: Math.floor(Date.now() / 1000) + fire_at_offset_seconds,
    message,
  })
  return { id: created.id }
}

let harness: Harness
beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

test('production composer mounts GET /api/app/projects/<id>/reminders', async () => {
  await seedReminder(harness.store, 'first')
  await seedReminder(harness.store, 'second', 7200)

  const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT}/reminders`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    reminders: Array<{ id: string; message: string }>
    project_id: string
    project_slug: string
  }
  expect(body.ok).toBe(true)
  expect(body.project_id).toBe(PROJECT)
  expect(body.project_slug).toBe(OWNER)
  expect(Array.isArray(body.reminders)).toBe(true)
  expect(body.reminders).toHaveLength(2)
  expect(body.reminders.map((r) => r.message)).toEqual(['first', 'second'])
})

test('production composer mounts POST /api/app/projects/<id>/reminders (create)', async () => {
  const fire_at = Math.floor(Date.now() / 1000) + 3600
  const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT}/reminders`, {
    method: 'POST',
    body: JSON.stringify({ message: 'call casey', fire_at }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    reminders: Array<{ message: string }>
  }
  expect(body.ok).toBe(true)
  expect(body.reminders).toHaveLength(1)
  expect(body.reminders[0]?.message).toBe('call casey')
})

test('production composer mounts POST /api/app/projects/<id>/reminders/<id>/snooze', async () => {
  const { id } = await seedReminder(harness.store, 'soon')
  const new_fire_at = Math.floor(Date.now() / 1000) + 7200
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/reminders/${id}/snooze`,
    {
      method: 'POST',
      body: JSON.stringify({ new_fire_at }),
    },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    reminders: Array<{ fire_at: number }>
  }
  expect(body.ok).toBe(true)
  expect(body.reminders).toHaveLength(1)
  expect(body.reminders[0]?.fire_at).toBe(new_fire_at)
})

test('production composer mounts POST /api/app/projects/<id>/reminders/<id>/cancel', async () => {
  const { id } = await seedReminder(harness.store, 'to-cancel')
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/reminders/${id}/cancel`,
    { method: 'POST' },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; reminders: unknown[] }
  expect(body.ok).toBe(true)
  expect(body.reminders).toHaveLength(0)
})

test('production composer mounts POST /api/app/projects/<id>/reminders/<id>/convert-to-task (P5.5)', async () => {
  const fire_at_seconds = Math.floor(Date.now() / 1000) + 3600
  const { id } = await seedReminder(harness.store, 'remember to send the email', 3600)
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/reminders/${id}/convert-to-task`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    task_id: string
    linked_reminder_id: string | null
    cancelled_reminder_id: string
    reminders: Array<{ id: string; source: string | null }>
  }
  expect(body.ok).toBe(true)
  expect(body.cancelled_reminder_id).toBe(id)
  expect(body.task_id.length).toBeGreaterThan(0)
  // P6 § 4.9 contract: the canonical adapter cancels the original
  // reminder + creates a new task in the shared TaskStore + the
  // task's auto-create spawns a fresh reminder linked via the
  // `task_reminder_links` join (migration 0037 in P6).
  const task = harness.taskStore.get(body.task_id)
  expect(task).not.toBeNull()
  expect(task?.project_slug).toBe(OWNER)
  expect(task?.project_id).toBe(PROJECT)
  expect(task?.title).toBe('remember to send the email')
  // The original reminder is gone from pending; the task's auto-link
  // reminder takes its place (or null if migration 0037 isn't
  // applied — at the production-composer test level applyMigrations
  // runs the full chain so the link is present).
  expect(body.reminders.find((r) => r.id === id)).toBeUndefined()
  // The new task's due_date is the original fire_at as ISO.
  const dueAt = task?.due_date
  expect(dueAt).not.toBeNull()
  if (dueAt !== null && dueAt !== undefined) {
    expect(Math.floor(new Date(dueAt).getTime() / 1000)).toBe(fire_at_seconds)
  }
})

test('production composer mounts convert-to-task with title + priority overrides', async () => {
  const { id } = await seedReminder(harness.store, 'remind to file taxes')
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/reminders/${id}/convert-to-task`,
    {
      method: 'POST',
      body: JSON.stringify({ title: 'File taxes', priority: 0 }),
    },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { task_id: string }
  const task = harness.taskStore.get(body.task_id)
  expect(task?.title).toBe('File taxes')
  expect(task?.priority).toBe(0)
})

test('every reminders route requires a Bearer token (401 missing_bearer)', async () => {
  const { id } = await seedReminder(harness.store, 'auth-check')
  const paths: ReadonlyArray<[string, string, object | null]> = [
    [`/api/app/projects/${PROJECT}/reminders`, 'GET', null],
    [`/api/app/projects/${PROJECT}/reminders`, 'POST', { message: 'x', fire_at: 1 }],
    [`/api/app/projects/${PROJECT}/reminders/${id}/snooze`, 'POST', { new_fire_at: 1 }],
    [`/api/app/projects/${PROJECT}/reminders/${id}/cancel`, 'POST', null],
    [`/api/app/projects/${PROJECT}/reminders/${id}/convert-to-task`, 'POST', {}],
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

test('unknown reminders verb under /reminders/<id>/<bogus> returns 405 method_not_allowed', async () => {
  const { id } = await seedReminder(harness.store, 'verb-check')
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/reminders/${id}/bogus`,
    { method: 'POST', body: JSON.stringify({}) },
  )
  expect(res.status).toBe(405)
  const json = (await res.json()) as { ok: boolean; code: string }
  expect(json.code).toBe('method_not_allowed')
})

test('convert-to-task returns 501 not_implemented when adapter is unwired (sanity)', async () => {
  // This test exercises the "no adapter wired" path by bypassing the
  // production composer's adapter and constructing a minimal surface
  // without the convertReminderToTask option. Demonstrates that the
  // route returns 501 cleanly (the same 501 the production composer
  // test in `app-reminders-surface-convert.test.ts` exercises).
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-reminders-noadapter-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  try {
    applyMigrations(db.raw())
    const store = new ReminderStore(db)
    const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
    const surface = createAppRemindersSurface({ store, auth }) // no convertReminderToTask
    const composed = composeHttpHandler({
      appReminders: { handler: surface.handler },
      defaultHandler: () => new Response('not found', { status: 404 }),
    })
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => composed.fetch(req, srv),
      websocket: composed.websocket,
    })
    try {
      const created = await store.create({
        project_slug: OWNER,
        topic_id: appProjectTopicId(PROJECT),
        fire_at: Math.floor(Date.now() / 1000) + 3600,
        message: 'noop',
      })
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/app/projects/${PROJECT}/reminders/${created.id}/convert-to-task`,
        {
          method: 'POST',
          headers: { authorization: 'Bearer dev:test-user' },
        },
      )
      expect(res.status).toBe(501)
      const json = (await res.json()) as { code: string }
      expect(json.code).toBe('not_implemented')
    } finally {
      await server.stop(true)
    }
  } finally {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  }
})
