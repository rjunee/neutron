import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { createAppWsAuthResolver } from '../../channels/adapters/app-ws/auth.ts'
import { WorkBoardStore } from '../../work-board/store.ts'
import {
  createWorkBoardSurface,
  type TridentRunAccess,
  type WorkBoardSurface,
} from './work-board-surface.ts'
import type { TridentPhase, TridentRun } from '../../trident/store.ts'

/** A minimal fake trident run for the surface's progress + cancel deps. */
function fakeRun(over: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'run-1',
    slug: 'demo',
    project_slug: SLUG,
    phase: 'forge-init',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: 'trident/demo',
    pr: null,
    merge_mode: 'pr',
    subagent_run_id: 'wf-1',
    subagent_status: 'running',
    repo_path: '/repo',
    worktree: null,
    task: 'build',
    chat_id: null,
    thread_id: null,
    channel_kind: 'app_socket',
    failure_reason: null,
    workflow_run_id: 'wf-1',
    inner_checkpoint: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '2026-07-02T00:00:00Z',
    last_advanced_at: '2026-07-02T00:00:00Z',
    ...over,
  }
}

/** A fake `TridentRunAccess` recording every cancel (`update phase=stopped`). */
function fakeRunAccess(runs: Record<string, TridentRun>): {
  access: TridentRunAccess
  updates: Array<{ id: string; phase: TridentPhase }>
} {
  const updates: Array<{ id: string; phase: TridentPhase }> = []
  return {
    access: {
      get: (id) => runs[id] ?? null,
      update: async (id, patch) => {
        updates.push({ id, phase: patch.phase })
        const existing = runs[id]
        if (existing !== undefined) runs[id] = { ...existing, phase: patch.phase }
        return null
      },
    },
    updates,
  }
}

let tmp: string
let db: ProjectDb
let store: WorkBoardStore
let surface: WorkBoardSurface
const SLUG = 'owner'

function req(method: string, path: string, body?: unknown, withAuth = true): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (withAuth) headers['authorization'] = 'Bearer dev-token'
  return new Request(`http://x${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-work-board-http-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new WorkBoardStore(db)
  const auth = createAppWsAuthResolver({ project_slug: SLUG, bypass: true })
  surface = createWorkBoardSurface({ store, auth })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('work-board HTTP surface', () => {
  test('disclaims non-owned paths with null', async () => {
    const res = await surface.handler(req('GET', '/api/app/projects/proj1/tasks'))
    expect(res).toBeNull()
  })

  test('GET requires a bearer (401 without)', async () => {
    const res = await surface.handler(req('GET', '/api/app/projects/proj1/work-board', undefined, false))
    expect(res?.status).toBe(401)
  })

  test('GET returns the board for the bearer project_slug', async () => {
    await store.create(SLUG, { title: 'A' })
    const res = await surface.handler(req('GET', '/api/app/projects/proj1/work-board'))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; items: { title: string }[] }
    expect(body.ok).toBe(true)
    expect(body.items.map((i) => i.title)).toEqual(['A'])
  })

  test('POST create → 201 + persists', async () => {
    const res = await surface.handler(req('POST', '/api/app/projects/proj1/work-board', { title: 'new item' }))
    expect(res?.status).toBe(201)
    const body = (await res!.json()) as { ok: boolean; item: { id: string; title: string } }
    expect(body.item.title).toBe('new item')
    expect(store.get(SLUG, body.item.id)?.title).toBe('new item')
  })

  test('POST create rejects a javascript: design_doc_ref with 400', async () => {
    const res = await surface.handler(
      req('POST', '/api/app/projects/proj1/work-board', {
        title: 'x',
        design_doc_ref: 'javascript:alert(1)',
      }),
    )
    expect(res?.status).toBe(400)
    const body = (await res!.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('invalid_design_doc_ref')
  })

  test('POST create accepts an https design_doc_ref', async () => {
    const res = await surface.handler(
      req('POST', '/api/app/projects/proj1/work-board', {
        title: 'x',
        design_doc_ref: 'https://example.com/plan',
      }),
    )
    expect(res?.status).toBe(201)
  })

  test('PATCH updates; complete + DELETE work; reorder reorders', async () => {
    const a = await store.create(SLUG, { title: 'A' })
    const b = await store.create(SLUG, { title: 'B' })
    // PATCH title
    const patch = await surface.handler(
      req('PATCH', `/api/app/projects/proj1/work-board/${a.id}`, { title: 'A-renamed' }),
    )
    expect(patch?.status).toBe(200)
    expect(store.get(SLUG, a.id)?.title).toBe('A-renamed')
    // complete
    const done = await surface.handler(req('POST', `/api/app/projects/proj1/work-board/${a.id}/complete`))
    expect(done?.status).toBe(200)
    expect(store.get(SLUG, a.id)?.status).toBe('done')
    // reorder B to end (no-op-ish) — returns 200 with items
    const reorder = await surface.handler(
      req('POST', `/api/app/projects/proj1/work-board/${b.id}/reorder`, {}),
    )
    expect(reorder?.status).toBe(200)
    // DELETE
    const del = await surface.handler(req('DELETE', `/api/app/projects/proj1/work-board/${b.id}`))
    expect(del?.status).toBe(200)
    expect(store.get(SLUG, b.id)).toBeNull()
  })

  test('PATCH on an unknown item → 404', async () => {
    const res = await surface.handler(
      req('PATCH', '/api/app/projects/proj1/work-board/nope', { title: 'x' }),
    )
    expect(res?.status).toBe(404)
  })

  test('unsupported method on the collection → 405', async () => {
    const res = await surface.handler(req('PUT', '/api/app/projects/proj1/work-board', { title: 'x' }))
    expect(res?.status).toBe(405)
  })
})

describe('work-board HTTP surface — trident run integration (items 1 + 3)', () => {
  const auth = createAppWsAuthResolver({ project_slug: SLUG, bypass: true })

  test('GET enriches a bound item with its live run_progress (item 1)', async () => {
    const item = await store.create(SLUG, { title: 'Building' })
    await store.bindRun(SLUG, item.id, 'run-1')
    const { access } = fakeRunAccess({
      'run-1': fakeRun({ id: 'run-1', phase: 'forge-init', inner_checkpoint: 'forge-done', pr: 9 }),
    })
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })
    const res = await s.handler(req('GET', '/api/app/projects/proj1/work-board'))
    const body = (await res!.json()) as {
      items: Array<{ id: string; run_progress?: { phase_label: string; pr: number | null } }>
    }
    const row = body.items.find((i) => i.id === item.id)
    expect(row?.run_progress?.phase_label).toBe('reviewing')
    expect(row?.run_progress?.pr).toBe(9)
  })

  test('GET omits run_progress on an unbound item', async () => {
    const item = await store.create(SLUG, { title: 'Idle' })
    const { access } = fakeRunAccess({})
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })
    const res = await s.handler(req('GET', '/api/app/projects/proj1/work-board'))
    const body = (await res!.json()) as { items: Array<{ id: string; run_progress?: unknown }> }
    const row = body.items.find((i) => i.id === item.id)
    expect(row?.run_progress).toBeUndefined()
  })

  test('DELETE cancels a non-terminal linked run (phase→stopped) then deletes (item 3)', async () => {
    const item = await store.create(SLUG, { title: 'Running build' })
    await store.bindRun(SLUG, item.id, 'run-1')
    const { access, updates } = fakeRunAccess({ 'run-1': fakeRun({ id: 'run-1', phase: 'forge-init' }) })
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })

    const res = await s.handler(req('DELETE', `/api/app/projects/proj1/work-board/${item.id}`))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { cancelled_run?: string }
    expect(body.cancelled_run).toBe('run-1')
    // The run was stopped BEFORE the item was removed.
    expect(updates).toEqual([{ id: 'run-1', phase: 'stopped' }])
    expect(store.get(SLUG, item.id)).toBeNull()
  })

  test('DELETE does NOT cancel an already-terminal linked run', async () => {
    const item = await store.create(SLUG, { title: 'Done build' })
    await store.bindRun(SLUG, item.id, 'run-1')
    const { access, updates } = fakeRunAccess({ 'run-1': fakeRun({ id: 'run-1', phase: 'done' }) })
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })

    const res = await s.handler(req('DELETE', `/api/app/projects/proj1/work-board/${item.id}`))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { cancelled_run?: string }
    expect(body.cancelled_run).toBeUndefined()
    expect(updates).toEqual([])
    expect(store.get(SLUG, item.id)).toBeNull()
  })

  test('DELETE on an unbound item just deletes (no cancel)', async () => {
    const item = await store.create(SLUG, { title: 'Plain item' })
    const { access, updates } = fakeRunAccess({})
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })

    const res = await s.handler(req('DELETE', `/api/app/projects/proj1/work-board/${item.id}`))
    expect(res?.status).toBe(200)
    expect(updates).toEqual([])
    expect(store.get(SLUG, item.id)).toBeNull()
  })
})
