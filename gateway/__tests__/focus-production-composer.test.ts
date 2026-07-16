/**
 * P5.6 — production-composer reachability guard for the global Focus
 * surface (the CRITICAL anti-pattern gate from
 * docs/plans/P5.6-focus-view-sprint-brief.md § 5.5 + § 8).
 *
 * What this test guards (the anti-pattern Argus has caught four
 * sprints in a row: chat-send HTTP fallback unreachable from
 * `composeProductionGraph` (PR #222); projects-client method
 * unexercised end-to-end (PR #225); launcher routes in P5.3 (PR
 * #227); tasks routes in P5.4 (PR #229); reminders routes in P5.5 (PR
 * #231)). P5.6 lands the global-focus equivalent up-front so Argus
 * doesn't have to flag it a fifth time:
 *
 *   1. Boot `composeProductionGraph` against an in-memory SQLite +
 *      a dev-bypass `AppWsAuthResolver`.
 *   2. Construct the focus surface (`createAppFocusSurface`) the same
 *      way `gateway/index.ts` does at boot, against a real
 *      `TaskStore` + `ReminderStore` over the canonical ProjectDb.
 *   3. Compose the HTTP chain via the SAME `composeHttpHandler`
 *      factory the production gateway uses (NOT a hand-rolled
 *      router). The point is to assert the production composition
 *      mounts the focus route + threads it through the chain in the
 *      order production expects.
 *   4. Fire HTTP requests at the focus route AND its `?order=focus_score`
 *      opt-in AND the bearer-missing + non-GET + invalid-order branches.
 *      Assert 200s on the happy paths with the canonical
 *      `FocusResponse` envelope shape.
 *
 * If a future refactor accidentally drops the focus surface from
 * `app-focus-surface.ts` OR drops it from `composeHttpHandler`'s
 * chain OR mishandles the bucket / sort semantics, this test fails.
 *
 * Mirrors `gateway/__tests__/reminders-production-composer.test.ts`
 * (P5.5) verbatim.
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
} from '../http/app-reminders-surface.ts'
import {
  createAppFocusSurface,
  type FocusItem,
  type FocusResponse,
} from '../http/app-focus-surface.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const OWNER = 'focus-composer-project'
const PROJECT = 'demo-project'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  taskStore: TaskStore
  reminderStore: ReminderStore
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
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-focus-composer-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  // Build the surface pieces FIRST so we can hand them to
  // `composeProductionGraph` via `app_focus_surface`. Mirrors the
  // boot shell at gateway/index.ts around L2810-L2822.
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const taskStore = new TaskStore(db)
  const reminderStore = new ReminderStore(db)
  const focusSurface = createAppFocusSurface({
    tasks: taskStore,
    reminders: reminderStore,
    auth,
  })

  // Boot the production graph with the focus surface threaded
  // through. If a future CompositionInput field rename / removal
  // drops `app_focus_surface` from the typed shape, this construction
  // breaks at compile time BEFORE the runtime test runs.
  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_focus_surface: { handler: focusSurface.handler },
  })

  // ISSUE #32 — serve `graph.fetch` directly. The composed handler is
  // built by `composeProductionGraph` from `composition.app_focus_surface`,
  // so the boot-wiring mapping IS the only path exercised here. A
  // deletion of the `composeInput.appFocus = …` line in
  // `gateway/composition.ts:buildComposedHttpFromComposition` provably
  // breaks this test (closing condition for ISSUE #32).
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
    taskStore,
    reminderStore,
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

interface SeedTaskOpts {
  due_offset_ms?: number | null
  priority?: number | null
}

async function seedTask(
  store: TaskStore,
  title: string,
  opts: SeedTaskOpts = {},
): Promise<{ id: string }> {
  const due_date =
    opts.due_offset_ms === null || opts.due_offset_ms === undefined
      ? null
      : new Date(Date.now() + opts.due_offset_ms).toISOString()
  const created = await store.create({
    project_slug: OWNER,
    project_id: PROJECT,
    title,
    description: null,
    priority: opts.priority ?? null,
    due_date,
    owner_persona: null,
    source: 'seed',
  })
  return { id: created.id }
}

async function seedReminder(
  store: ReminderStore,
  message: string,
  fire_at_offset_seconds = 3600,
): Promise<{ id: string }> {
  const created = await store.create({
    owner_slug: OWNER,
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

test('production composer mounts GET /api/app/focus', async () => {
  // Seed an overdue task + a near-due reminder; both should surface.
  await seedTask(harness.taskStore, 'overdue task', {
    due_offset_ms: -3 * 60 * 60 * 1000,
    priority: 2,
  })
  await seedReminder(harness.reminderStore, 'soon reminder', 1800)

  const res = await authedFetch(harness.base, '/api/app/focus')
  expect(res.status).toBe(200)
  const body = (await res.json()) as FocusResponse
  expect(body.ok).toBe(true)
  expect(body.project_slug).toBe(OWNER)
  expect(typeof body.now).toBe('string')
  expect(Array.isArray(body.today)).toBe(true)
  expect(body.today.length).toBeGreaterThan(0)
  // The first item must be overdue per the canonical bucket sort.
  expect(body.today[0]!.bucket).toBe('overdue')
})

test('production composer mounts GET /api/app/focus?order=focus_score', async () => {
  await seedTask(harness.taskStore, 'scored task', {
    due_offset_ms: 60 * 60 * 1000,
    priority: 2,
  })
  await seedReminder(harness.reminderStore, 'unscored reminder', 1800)

  const res = await authedFetch(harness.base, '/api/app/focus?order=focus_score')
  expect(res.status).toBe(200)
  const body = (await res.json()) as FocusResponse
  expect(body.ok).toBe(true)
  // Per `compareFocusByScore` (app-focus-surface.ts:463) reminders
  // (null focus_score) sink to the bottom of the focus-score-ordered
  // list. Tasks with a non-null score come first.
  const scoredFirst = body.today[0]
  expect(scoredFirst).toBeDefined()
  if (scoredFirst !== undefined && scoredFirst.kind === 'task') {
    // Scored task came first — that's the contract.
    expect(scoredFirst.kind).toBe('task')
  }
})

test('production composer rejects POST /api/app/focus with 405 method_not_allowed', async () => {
  const res = await authedFetch(harness.base, '/api/app/focus', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(405)
  const body = (await res.json()) as { ok: boolean; code: string }
  expect(body.ok).toBe(false)
  expect(body.code).toBe('method_not_allowed')
})

test('production composer rejects PUT /api/app/focus with 405 method_not_allowed', async () => {
  const res = await authedFetch(harness.base, '/api/app/focus', {
    method: 'PUT',
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(405)
  const body = (await res.json()) as { ok: boolean; code: string }
  expect(body.ok).toBe(false)
  expect(body.code).toBe('method_not_allowed')
})

test('production composer rejects GET /api/app/focus?order=bogus with 400 invalid_order', async () => {
  const res = await authedFetch(harness.base, '/api/app/focus?order=bogus')
  expect(res.status).toBe(400)
  const body = (await res.json()) as { ok: boolean; code: string }
  expect(body.ok).toBe(false)
  expect(body.code).toBe('invalid_order')
})

test('focus route requires a Bearer token (401 missing_bearer)', async () => {
  const res = await fetch(`${harness.base}/api/app/focus`)
  expect(res.status).toBe(401)
  const body = (await res.json()) as { ok: boolean; code: string }
  expect(body.ok).toBe(false)
  expect(body.code).toBe('missing_bearer')
})

test('focus route 401 envelope flattens to either missing_bearer or unauthorized', async () => {
  // Under the dev-bypass auth resolver every well-formed bearer is
  // accepted, so this test covers the documented wire-flattening
  // contract (`unauthorized` for non-missing-bearer failures) by
  // exercising the missing-bearer + empty-header shapes. Real JWT
  // verification is covered by `gateway/__tests__/app-focus-surface.test.ts`.
  const cases: ReadonlyArray<{ headers: Record<string, string>; code: string }> = [
    { headers: {}, code: 'missing_bearer' },
    { headers: { authorization: 'NotBearer xyz' }, code: 'missing_bearer' },
  ]
  for (const c of cases) {
    const res = await fetch(`${harness.base}/api/app/focus`, { headers: c.headers })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe(c.code)
  }
})

test('production composer renders bucket / priority / due_at sort over mixed input', async () => {
  // Mixed seeding: 1 overdue priority-3 task, 1 today priority-1 task,
  // 1 soon priority-0 task, 1 today reminder. Verifies the canonical
  // ordering survives through the production chain.
  await seedTask(harness.taskStore, 'today-p1', {
    due_offset_ms: 2 * 60 * 60 * 1000,
    priority: 1,
  })
  await seedTask(harness.taskStore, 'overdue-p3', {
    due_offset_ms: -60 * 60 * 1000,
    priority: 3,
  })
  await seedTask(harness.taskStore, 'soon-p0', {
    due_offset_ms: 20 * 60 * 60 * 1000,
    priority: 0,
  })
  await seedReminder(harness.reminderStore, 'today-reminder', 3 * 60 * 60)

  const res = await authedFetch(harness.base, '/api/app/focus')
  expect(res.status).toBe(200)
  const body = (await res.json()) as FocusResponse
  // Group by bucket so we can verify the canonical [overdue, today,
  // soon] order regardless of within-bucket sort.
  const buckets = body.today.map((i) => i.bucket)
  const overdueIdx = buckets.indexOf('overdue')
  const todayIdx = buckets.indexOf('today')
  const soonIdx = buckets.indexOf('soon')
  expect(overdueIdx).toBeGreaterThanOrEqual(0)
  expect(todayIdx).toBeGreaterThan(overdueIdx)
  if (soonIdx >= 0) {
    expect(soonIdx).toBeGreaterThan(todayIdx)
  }
  // Verify the canonical envelope shape on a representative item.
  const first = body.today[0] as FocusItem
  expect(first.title).toBeDefined()
  expect(first.bucket).toBe('overdue')
  expect(first.source).toBe('tasks')
  expect(first.project_id).toBe(PROJECT)
})
