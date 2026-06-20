/**
 * Regression — Tasks Core MCP tools + app HTTP surface share state.
 *
 * Closes Argus R2 BLOCKING #1, 2026-05-18: the prior production
 * factory at `gateway/index.ts:962-965` constructed the Tasks Core
 * with `buildInMemoryTaskStore()` — a process-local store invisible
 * to the app's `/api/app/projects/<id>/tasks` and `/api/app/focus`
 * surfaces (which compose their `TaskStore` against the per-project
 * `tasks` table). Two surfaces with the same conceptual task list
 * diverged at runtime AND on every gateway restart.
 *
 * This test asserts the round-trip in both directions:
 *
 *   - `tasks_create` via the Core's tool surface → row visible in
 *     `GET /api/app/projects/<id>/tasks`.
 *   - `POST /api/app/projects/<id>/tasks` via the HTTP surface → row
 *     visible in `tasks_list` via the Core's tool surface.
 *
 * Both surfaces share the same `ProjectDb`, so a single canonical
 * `tasks` table is the source of truth.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecretAuditLog } from '@neutronai/cores-runtime'
import {
  buildSubstrateTaskStoreBackend,
  buildTools as buildTasksTools,
  loadManifest as loadTasksManifest,
} from '@neutronai/tasks-core'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { TaskStore as CanonicalTaskStore } from '../../tasks/store.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { createAppTasksSurface } from '../http/app-tasks-surface.ts'

const OWNER = 'cross-surface-project'
const PROJECT = 'p-demo'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  toolSurface: ReturnType<typeof buildTasksTools>
  db: ProjectDb
  tmp: string
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-tasks-cross-surface-'))
  const dbPath = join(tmp, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)

  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  // HTTP surface composes a CanonicalTaskStore over the project DB —
  // this is exactly how `gateway/index.ts` wires the app's tasks tab.
  const canonical = new CanonicalTaskStore(db)
  const surface = createAppTasksSurface({ store: canonical, auth })
  const composed = composeHttpHandler({
    appTasks: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })
  // The Core's tools dispatch through the SAME project DB via the
  // substrate-backed adapter — this is the fix under test.
  const audit = new SecretAuditLog({ db })
  const manifest = loadTasksManifest()
  const toolStore = buildSubstrateTaskStoreBackend({
    project_slug: OWNER,
    projectDb: db,
  })
  const toolSurface = buildTasksTools({
    manifest,
    project_slug: OWNER,
    audit,
    store: toolStore,
  })
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    toolSurface,
    db,
    tmp,
    close: async () => {
      await server.stop(true)
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

describe('tasks_core — Core tool ↔ HTTP surface round-trip', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startHarness()
  })
  afterEach(async () => {
    await harness.close()
  })

  test('tool_create → HTTP list sees the row', async () => {
    const created = await harness.toolSurface.tasks_create({
      title: 'tool-side task',
      project_id: PROJECT,
      priority: 1,
      due_date: '2026-12-31',
    })
    expect(created.id.length).toBeGreaterThan(0)

    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT}/tasks?status=open`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      tasks: Array<{ id: string; title: string; project_id: string; project_slug: string }>
    }
    expect(body.ok).toBe(true)
    const matching = body.tasks.find((t) => t.id === created.id)
    expect(matching).toBeDefined()
    expect(matching?.title).toBe('tool-side task')
    expect(matching?.project_id).toBe(PROJECT)
    expect(matching?.project_slug).toBe(OWNER)
  })

  test('HTTP create → tasks_list sees the row', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT}/tasks`,
      {
        method: 'POST',
        body: JSON.stringify({ title: 'http-side task', priority: 2 }),
      },
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { ok: boolean; task: { id: string } }
    expect(body.ok).toBe(true)
    const httpId = body.task.id

    const list = await harness.toolSurface.tasks_list({ project_id: PROJECT })
    const matching = list.results.find((t) => t.id === httpId)
    expect(matching).toBeDefined()
    expect(matching?.title).toBe('http-side task')
    expect(matching?.priority).toBe(2)
    expect(matching?.project_id).toBe(PROJECT)
  })

  test('tool_complete on a HTTP-created row marks it done on both surfaces', async () => {
    // Create via HTTP.
    const created = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT}/tasks`,
      {
        method: 'POST',
        body: JSON.stringify({ title: 'cross-mutation' }),
      },
    )
    const cBody = (await created.json()) as { task: { id: string } }
    const taskId = cBody.task.id

    // Complete via the Core's tool surface.
    const completed = await harness.toolSurface.tasks_complete({ task_id: taskId })
    expect(completed.task.status).toBe('done')

    // HTTP list with status=done sees it.
    const doneList = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT}/tasks?status=done`,
    )
    const doneBody = (await doneList.json()) as {
      tasks: Array<{ id: string; status: string }>
    }
    expect(doneBody.tasks.some((t) => t.id === taskId)).toBe(true)
  })

  test('instance isolation: a task from another instance is not visible to the Core', async () => {
    // Write a task directly through the canonical store as a
    // different project_slug. The Core's adapter binds to the test slug
    // and must NOT surface foreign rows.
    const foreign = new CanonicalTaskStore(harness.db)
    const foreignTask = await foreign.create({
      project_slug: 'another-project',
      project_id: PROJECT,
      title: 'foreign-row',
    })

    const list = await harness.toolSurface.tasks_list({ project_id: PROJECT })
    expect(list.results.find((t) => t.id === foreignTask.id)).toBeUndefined()
  })

  test('Core tool writes a source tag the canonical store can attribute', async () => {
    // The adapter stamps `source = '@neutronai/tasks-core'` on every
    // create so an operator can grep the canonical table to
    // attribute rows to the Core's tool surface.
    const created = await harness.toolSurface.tasks_create({
      title: 'source-tag-check',
      project_id: PROJECT,
    })
    const canonical = new CanonicalTaskStore(harness.db)
    const row = canonical.get(created.id)
    expect(row?.source).toBe('@neutronai/tasks-core')
  })
})
