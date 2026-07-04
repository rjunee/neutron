/**
 * P6 — `?order=focus_score` opt-in tests for the project-scoped tasks
 * HTTP surface. The default order is unchanged (covered by
 * `app-tasks-surface.test.ts`); these tests assert the opt-in switches
 * the response to focus-score-DESC + adds the new `focus_score` /
 * `focus_score_updated_at` fields to every row.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { TaskStore, type Task } from '../../tasks/store.ts'
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

const PROJECT_ID = 'demo-project'
const PROJECT_SLUG = 'demo'

interface Harness {
  base: string
  store: TaskStore
  close(): Promise<void>
}

async function startGateway(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-app-tasks-focus-'))
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
    close: async () => {
      __composedHandlers.delete(host)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function authedFetch(base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: { authorization: 'Bearer dev:sam' },
  })
}

let harness: Harness

beforeEach(async () => {
  harness = await startGateway()
})

afterEach(async () => {
  await harness.close()
})

describe('?order=focus_score', () => {
  it('returns focus_score + focus_score_updated_at on every row', async () => {
    await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'one',
      priority: 2,
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks?order=focus_score`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      order: string
      tasks: Task[]
    }
    expect(json.ok).toBe(true)
    expect(json.order).toBe('focus_score')
    expect(json.tasks).toHaveLength(1)
    expect(json.tasks[0]!.focus_score).not.toBeNull()
    expect(json.tasks[0]!.focus_score_updated_at).not.toBeNull()
  })

  it('orders by focus_score DESC; high-priority overdue first', async () => {
    const overdueIso = '2026-01-01T00:00:00.000Z' // overdue versus any 2026-05-20-ish clock
    const farIso = '2026-12-31T00:00:00.000Z'
    await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'low priority, no due',
      priority: 0,
    })
    await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'P0 overdue',
      priority: 3,
      due_date: overdueIso,
    })
    await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'P0 future',
      priority: 3,
      due_date: farIso,
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks?order=focus_score`,
    )
    const json = (await res.json()) as { tasks: Task[] }
    expect(json.tasks).toHaveLength(3)
    expect(json.tasks[0]!.title).toBe('P0 overdue')
    expect(json.tasks[2]!.title).toBe('low priority, no due')
  })

  it('rejects ?order=foo with 400', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks?order=foo`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_order')
  })

  it('default order is unchanged when ?order is omitted', async () => {
    const old = '2026-01-01T00:00:00.000Z'
    await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'with due',
      priority: 0,
      due_date: old,
    })
    await harness.store.create({
      project_slug: PROJECT_SLUG,
      project_id: PROJECT_ID,
      title: 'no due',
      priority: 3,
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/tasks`,
    )
    const json = (await res.json()) as { order: string; tasks: Task[] }
    // Default (P6.0) order: dated → dateless, even if dateless has higher priority.
    expect(json.order).toBe('default')
    expect(json.tasks[0]!.title).toBe('with due')
  })
})
