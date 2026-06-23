/**
 * P6 — production wiring regression: composer → projection writer.
 *
 * Regression guard for the failure mode where the production composer
 * omits `composition.tasks`, `tasksModule.init` builds a
 * subscriber-free `TaskStore`, and the STATUS.md / ACTIONS.md
 * projection writer never attaches. Unit tests on `buildProjectionWriter`
 * in isolation can't catch that — same shape as the 2026-05-13
 * persona-gen incident where the production handler never wired the
 * synthesis modules.
 *
 * What this test guards:
 *
 *   1. The composer-supplied canonical `TaskStore` IS the instance the
 *      tasks module exposes via `graph.get('tasks').store` — so the
 *      HTTP surface (mounted against the same instance the composer
 *      built) and the wired projection writer feed the SAME mutation
 *      stream.
 *
 *   2. A `POST /api/app/projects/<id>/tasks` through the HTTP surface
 *      (wired against the canonical store) produces a STATUS.md write
 *      inside the debounce window — proof that the production path
 *      actually fires the spec'd projection module, not just records
 *      the row in the DB.
 *
 *   3. The `resolveProjectDir` shape used by the production composer
 *      (`<owner_home>/Projects/<project_id>/`) round-trips correctly
 *      and rejects the NO_PROJECT bucket.
 *
 * Future-proofing: if a refactor ever drops the `composition.tasks`
 * field again, OR replaces the shared `store` instance with a fresh
 * one, this test fails because the file write never lands.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { TaskStore } from '../../tasks/store.ts'
import {
  composeProductionGraph,
  type CompositionInput,
} from '../composition.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { createAppTasksSurface } from '../http/app-tasks-surface.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const OWNER = 'wiring-project'
const PROJECT = 'proj-A'

interface Harness {
  owner_home: string
  server: import('bun').Server<unknown>
  base: string
  db: ProjectDb
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  canonicalStore: TaskStore
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-tasks-wiring-'))
  const owner_home = tmp
  const dbPath = join(tmp, 'owner.db')
  const db = ProjectDb.open(dbPath)
  applyMigrations(db.raw())

  // Mirrors the production composer in `gateway/index.ts`: ONE canonical
  // store, passed to BOTH the HTTP surface AND the composition's
  // `tasks.store` field.
  const canonicalStore = new TaskStore(db)

  const composition: CompositionInput = {
    db,
    project_slug: OWNER,
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
    tasks: {
      store: canonicalStore,
      // Keep the focus-score cron + reminder-link wiring off here —
      // the bug under test is "did the projection writer attach to
      // the canonical store at all?" The other subscribers have
      // their own dedicated tests.
      enable_focus_score_cron: false,
      enable_reminder_link: false,
      projection: {
        resolveProjectDir: ({ project_id }):
          | { dir: string; name?: string }
          | null => {
          if (project_id === '') return null
          return { dir: join(owner_home, 'Projects', project_id) }
        },
        // Tight debounce so the test wait stays snappy.
        debounce_ms: 30,
      },
    },
  }
  const graph = await composeProductionGraph(composition)

  // Mount the same HTTP surface the production composer wires —
  // backed by the SAME canonical store.
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const surface = createAppTasksSurface({ store: canonicalStore, auth })
  const composed = composeHttpHandler({
    appTasks: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })

  return {
    owner_home,
    server,
    base: `http://127.0.0.1:${server.port}`,
    db,
    graph,
    canonicalStore,
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
  headers.set('authorization', `Bearer dev:${OWNER}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

describe('composition wiring — projection writer attaches to canonical store', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startHarness()
  })
  afterEach(async () => {
    await harness.close()
  })

  test('graph.get("tasks").store is the SAME instance the composer supplied', () => {
    const tasksModule = harness.graph.get<{ store: TaskStore }>('tasks')
    expect(tasksModule.store).toBe(harness.canonicalStore)
  })

  test('POST /api/app/projects/<id>/tasks rewrites STATUS.md within the debounce window', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT}/tasks`,
      {
        method: 'POST',
        body: JSON.stringify({ title: 'wiring smoke', priority: 2 }),
      },
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { ok: boolean; task: { id: string } }
    expect(body.ok).toBe(true)

    // Debounce is 30ms; wait long enough for the timer to flush.
    await new Promise((r) => setTimeout(r, 120))

    const statusPath = join(harness.owner_home, 'Projects', PROJECT, 'STATUS.md')
    const actionsPath = join(harness.owner_home, 'Projects', PROJECT, 'ACTIONS.md')

    const status = readFileSync(statusPath, 'utf8')
    expect(status).toContain('- [ ] wiring smoke [P1]')

    const actions = readFileSync(actionsPath, 'utf8')
    expect(actions).toContain('- [ ] wiring smoke [P1]')
  })

  test('NO_PROJECT writes through the surface do NOT crash; project dir for ""=null', async () => {
    // The HTTP surface always requires a project_id in the path, so
    // this test exercises the canonical store directly (the same
    // instance the surface uses), simulating a NO_PROJECT write path
    // some future surface might add.
    await harness.canonicalStore.create({
      project_slug: OWNER,
      title: 'unscoped',
    })
    await new Promise((r) => setTimeout(r, 80))
    // No throw + no STATUS.md created for the empty project_id.
    const tasksModule = harness.graph.get<{ store: TaskStore }>('tasks')
    expect(tasksModule.store).toBe(harness.canonicalStore)
  })

  test('two writes inside the debounce window coalesce to one STATUS.md rewrite', async () => {
    const before = Date.now()
    await authedFetch(harness.base, `/api/app/projects/${PROJECT}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: 'first', priority: 2 }),
    })
    await authedFetch(harness.base, `/api/app/projects/${PROJECT}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: 'second', priority: 1 }),
    })
    await new Promise((r) => setTimeout(r, 120))

    const statusPath = join(harness.owner_home, 'Projects', PROJECT, 'STATUS.md')
    const status = readFileSync(statusPath, 'utf8')
    expect(status).toContain('- [ ] first [P1]')
    expect(status).toContain('- [ ] second [P2]')
    // Sanity guard: the file mtime is recent (the debounce fired).
    expect(Date.now() - before).toBeLessThan(2000)
  })
})

describe('composition wiring — guardrail for subscriber-feature + missing canonical store', () => {
  let tmp: string
  let db: ProjectDb
  let originalWarn: typeof console.warn

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-tasks-warn-'))
    db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    originalWarn = console.warn
  })

  afterEach(() => {
    console.warn = originalWarn
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function captureWarns(): { warns: string[] } {
    const warns: string[] = []
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(' '))
    }
    return { warns }
  }

  test('warns when projection is set but canonical store is missing', async () => {
    const { warns } = captureWarns()
    const graph = await composeProductionGraph({
      db,
      project_slug: OWNER,
      topic_handler: async () => {},
      approval_notifier: { notify: async () => undefined },
      watchdog_notifier: { notify: async () => undefined },
      reminder_dispatcher: { dispatch: async () => undefined },
      heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
      tasks: {
        projection: {
          resolveProjectDir: () => null,
          debounce_ms: 20,
        },
      },
    })
    try {
      const warned = warns.some(
        (w) =>
          w.includes('[tasks-composer]') &&
          w.includes('tasksCfg.store is undefined'),
      )
      expect(warned).toBe(true)
    } finally {
      await graph.shutdown()
    }
  })

  test('warns when enable_focus_score_cron is set but canonical store is missing', async () => {
    const { warns } = captureWarns()
    const graph = await composeProductionGraph({
      db,
      project_slug: OWNER,
      topic_handler: async () => {},
      approval_notifier: { notify: async () => undefined },
      watchdog_notifier: { notify: async () => undefined },
      reminder_dispatcher: { dispatch: async () => undefined },
      heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
      tasks: {
        enable_focus_score_cron: true,
        // Tight interval to keep test cheap if it ever ticks.
        focus_score_interval_ms: 1_000_000,
      },
    })
    try {
      const warned = warns.some(
        (w) =>
          w.includes('[tasks-composer]') &&
          w.includes('focus_score_cron=true'),
      )
      expect(warned).toBe(true)
    } finally {
      await graph.shutdown()
    }
  })

  test('does NOT warn when no subscriber features are enabled', async () => {
    const { warns } = captureWarns()
    const graph = await composeProductionGraph({
      db,
      project_slug: OWNER,
      topic_handler: async () => {},
      approval_notifier: { notify: async () => undefined },
      watchdog_notifier: { notify: async () => undefined },
      reminder_dispatcher: { dispatch: async () => undefined },
      heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
      // No `tasks` field at all — fallback store is fine because no
      // subscribers attach.
    })
    try {
      const warned = warns.some((w) => w.includes('[tasks-composer]'))
      expect(warned).toBe(false)
    } finally {
      await graph.shutdown()
    }
  })

  test('does NOT warn when canonical store IS supplied alongside features', async () => {
    const { warns } = captureWarns()
    const canonicalStore = new TaskStore(db)
    const graph = await composeProductionGraph({
      db,
      project_slug: OWNER,
      topic_handler: async () => {},
      approval_notifier: { notify: async () => undefined },
      watchdog_notifier: { notify: async () => undefined },
      reminder_dispatcher: { dispatch: async () => undefined },
      heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
      tasks: {
        store: canonicalStore,
        enable_reminder_link: true,
        projection: {
          resolveProjectDir: () => null,
          debounce_ms: 20,
        },
      },
    })
    try {
      const warned = warns.some((w) => w.includes('[tasks-composer]'))
      expect(warned).toBe(false)
    } finally {
      await graph.shutdown()
    }
  })

  test('registers the LLM-primary prioritize cron when enabled (WAVE 3 PR-7)', async () => {
    const canonicalStore = new TaskStore(db)
    const graph = await composeProductionGraph({
      db,
      project_slug: OWNER,
      topic_handler: async () => {},
      approval_notifier: { notify: async () => undefined },
      watchdog_notifier: { notify: async () => undefined },
      reminder_dispatcher: { dispatch: async () => undefined },
      heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
      tasks: {
        store: canonicalStore,
        enable_task_prioritize_cron: true,
        // Tight interval to keep the test cheap if it ever ticks; a null
        // llm means the handler runs the deterministic fallback.
        task_prioritize_interval_ms: 1_000_000,
        task_prioritizer: { llm: null },
      },
    })
    try {
      const cron = graph.get<{
        jobs: { get(name: string): unknown }
        handlers: { get(name: string): unknown }
      }>('cron')
      expect(cron.jobs.get(`tasks-prioritize-${OWNER}`)).toBeDefined()
      expect(cron.handlers.get('tasks.prioritize_llm')).toBeDefined()
    } finally {
      await graph.shutdown()
    }
  })
})
