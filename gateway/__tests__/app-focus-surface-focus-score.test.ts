/**
 * P6 — `?order=focus_score` opt-in tests for the cross-project Focus
 * aggregator. The default order is unchanged (covered by the existing
 * `app-focus-surface.test.ts`); these tests assert that:
 *   - `?order=focus_score` returns tasks sorted by focus_score DESC.
 *   - Each FocusItem carries the `focus_score` field (null for reminders).
 *   - An invalid `?order=foo` returns 400.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { ReminderStore } from '../../reminders/store.ts'
import { TaskStore } from '../../tasks/store.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'
import { createAppFocusSurface } from '../http/app-focus-surface.ts'

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
const fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input, init)
  const composed = __composedHandlers.get(new URL(req.url).host)
  if (composed !== undefined) return Promise.resolve(composed.fetch(req, undefined as never))
  return __realFetch(input as Parameters<typeof __realFetch>[0], init)
}) as typeof globalThis.fetch

const PROJECT_SLUG = 'demo'

interface Harness {
  base: string
  tasks: TaskStore
  reminders: ReminderStore
  close(): Promise<void>
}

async function startGateway(now: () => number = () => Date.now()): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-app-focus-score-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const tasks = new TaskStore(db)
  const reminders = new ReminderStore(db)
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
  const surface = createAppFocusSurface({ tasks, reminders, auth, now })
  const composed = composeHttpHandler({
    appFocus: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const host = `gw-${++__gatewaySeq}.test`
  __composedHandlers.set(host, composed)
  return {
    base: `http://${host}`,
    tasks,
    reminders,
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

describe('focus surface — ?order=focus_score', () => {
  it('rejects ?order=foo with 400', async () => {
    const res = await authedFetch(harness.base, '/api/app/focus?order=foo')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_order')
  })

  it('returns focus_score on every task item', async () => {
    await harness.tasks.create({
      project_slug: PROJECT_SLUG,
      project_id: 'proj-A',
      title: 'overdue P0',
      priority: 3,
      due_date: '2026-01-01T00:00:00.000Z',
    })
    const res = await authedFetch(
      harness.base,
      '/api/app/focus?order=focus_score',
    )
    const json = (await res.json()) as {
      ok: boolean
      today: Array<{ kind: string; focus_score: number | null }>
    }
    expect(json.ok).toBe(true)
    expect(json.today).toHaveLength(1)
    expect(json.today[0]!.kind).toBe('task')
    expect(json.today[0]!.focus_score).not.toBeNull()
  })

  it('sorts tasks by focus_score DESC under ?order=focus_score (both inside the today/high-pri gate)', async () => {
    // Argus r1 MINOR #4: `?order=focus_score` re-orders within the
    // today/high-pri gate; it doesn't widen the gate. Both rows here
    // pass the gate (one overdue, one high-priority) so they both
    // surface — and the sort key picks the higher focus_score first.
    const overdueIso = '2026-01-01T00:00:00.000Z'
    const lowOverdue = await harness.tasks.create({
      project_slug: PROJECT_SLUG,
      project_id: 'proj-A',
      title: 'low',
      priority: 1,
      due_date: '2026-04-01T00:00:00.000Z',
    })
    const highOverdue = await harness.tasks.create({
      project_slug: PROJECT_SLUG,
      project_id: 'proj-A',
      title: 'high',
      priority: 3,
      due_date: overdueIso,
    })
    const res = await authedFetch(
      harness.base,
      '/api/app/focus?order=focus_score',
    )
    const json = (await res.json()) as {
      today: Array<{ id: string; title: string }>
    }
    const titles = json.today.map((t) => t.title)
    expect(titles[0]).toBe('high')
    expect(titles).toContain('low')
    void lowOverdue
    void highOverdue
  })

  it('?order=focus_score does NOT widen the gate — dateless low-pri stays excluded', async () => {
    // Regression guard for Argus r1 MINOR #4 — the old `hasFocusBoost`
    // branch admitted every scored row, so a P3 dateless task could
    // crowd out a high-pri reminder. Now the gate is identical for
    // both orders; only the sort key changes.
    await harness.tasks.create({
      project_slug: PROJECT_SLUG,
      project_id: 'proj-A',
      title: 'dateless low pri',
      priority: 1,
    })
    const res = await authedFetch(
      harness.base,
      '/api/app/focus?order=focus_score',
    )
    const json = (await res.json()) as {
      today: Array<{ title: string }>
    }
    const titles = json.today.map((t) => t.title)
    expect(titles).not.toContain('dateless low pri')
  })
})
