import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { createAppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { WorkBoardStore, workBoardScopeKey } from '@neutronai/work-board/store.ts'
import {
  createWorkBoardSurface,
  type TridentRunAccess,
  type WorkBoardSurface,
} from './work-board-surface.ts'
import type { TridentPhase, TridentRun } from '@neutronai/trident/store.ts'

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
// The routes below all use the `proj1` path segment; the per-project storage
// key for it is `workBoardScopeKey('owner', 'proj1') === 'proj1'`. Seed + assert
// under that key so the store fixtures line up with what the surface reads.
const SCOPE = workBoardScopeKey(SLUG, 'proj1')

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
    await store.create(SCOPE, { title: 'A' })
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
    expect(store.get(SCOPE, body.item.id)?.title).toBe('new item')
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
    const a = await store.create(SCOPE, { title: 'A' })
    const b = await store.create(SCOPE, { title: 'B' })
    // PATCH title
    const patch = await surface.handler(
      req('PATCH', `/api/app/projects/proj1/work-board/${a.id}`, { title: 'A-renamed' }),
    )
    expect(patch?.status).toBe(200)
    expect(store.get(SCOPE, a.id)?.title).toBe('A-renamed')
    // complete
    const done = await surface.handler(req('POST', `/api/app/projects/proj1/work-board/${a.id}/complete`))
    expect(done?.status).toBe(200)
    expect(store.get(SCOPE, a.id)?.status).toBe('done')
    // reorder B to end (no-op-ish) — returns 200 with items
    const reorder = await surface.handler(
      req('POST', `/api/app/projects/proj1/work-board/${b.id}/reorder`, {}),
    )
    expect(reorder?.status).toBe(200)
    // DELETE
    const del = await surface.handler(req('DELETE', `/api/app/projects/proj1/work-board/${b.id}`))
    expect(del?.status).toBe(200)
    expect(store.get(SCOPE, b.id)).toBeNull()
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
    const item = await store.create(SCOPE, { title: 'Building' })
    await store.bindRun(SCOPE, item.id, 'run-1')
    const { access } = fakeRunAccess({
      // A run bound to a proj1 item carries project_slug=proj1 (dispatch keys the
      // run on the same scope), so the run-progress cross-scope guard passes.
      'run-1': fakeRun({ id: 'run-1', project_slug: SCOPE, phase: 'forge-init', inner_checkpoint: 'forge-done', pr: 9 }),
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
    const item = await store.create(SCOPE, { title: 'Idle' })
    const { access } = fakeRunAccess({})
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })
    const res = await s.handler(req('GET', '/api/app/projects/proj1/work-board'))
    const body = (await res!.json()) as { items: Array<{ id: string; run_progress?: unknown }> }
    const row = body.items.find((i) => i.id === item.id)
    expect(row?.run_progress).toBeUndefined()
  })

  test('DELETE cancels a non-terminal linked run (phase→stopped) then deletes (item 3)', async () => {
    const item = await store.create(SCOPE, { title: 'Running build' })
    await store.bindRun(SCOPE, item.id, 'run-1')
    const { access, updates } = fakeRunAccess({ 'run-1': fakeRun({ id: 'run-1', phase: 'forge-init' }) })
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })

    const res = await s.handler(req('DELETE', `/api/app/projects/proj1/work-board/${item.id}`))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { cancelled_run?: string }
    expect(body.cancelled_run).toBe('run-1')
    // The run was stopped BEFORE the item was removed.
    expect(updates).toEqual([{ id: 'run-1', phase: 'stopped' }])
    expect(store.get(SCOPE, item.id)).toBeNull()
  })

  test('§F6a: DELETE routes the cancel through terminate() → the observer chain FIRES (the fix)', async () => {
    // The X-cancel fix: when a `terminate` chokepoint is wired, the delete path
    // cancels through it (not a bare `update`), so the terminal-observer chain
    // fires for an X-cancel exactly as it does for a loop-reaped run.
    const item = await store.create(SCOPE, { title: 'Running build' })
    await store.bindRun(SCOPE, item.id, 'run-1')
    const runs: Record<string, TridentRun> = { 'run-1': fakeRun({ id: 'run-1', phase: 'forge-init' }) }
    const observed: Array<{ id: string; phase: TridentPhase }> = []
    const terminated: Array<{ id: string; phase: TridentPhase }> = []
    const access: TridentRunAccess = {
      get: (id) => runs[id] ?? null,
      // The bare update MUST NOT be the path taken when terminate is wired.
      update: async () => {
        throw new Error('delete must route through terminate(), not update()')
      },
      terminate: async (id, phase) => {
        terminated.push({ id, phase })
        const existing = runs[id]
        if (existing !== undefined) runs[id] = { ...existing, phase }
        // The chokepoint runs the observer chain — recorded here as the spy.
        observed.push({ id, phase })
        return { won: true }
      },
    }
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })

    const res = await s.handler(req('DELETE', `/api/app/projects/proj1/work-board/${item.id}`))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { cancelled_run?: string }
    expect(body.cancelled_run).toBe('run-1')
    expect(terminated).toEqual([{ id: 'run-1', phase: 'stopped' }])
    // The observer-fired assertion. MUTATION-VERIFY: the pre-F6a bypass wrote
    // `phase` via a bare `update` and never fired observers — that path is the
    // `fakeRunAccess` (update-only) tests above, where `observed` would stay empty.
    // Routing through terminate() is what makes this red if bypassed.
    expect(observed).toEqual([{ id: 'run-1', phase: 'stopped' }])
    expect(store.get(SCOPE, item.id)).toBeNull()
  })

  test('§F6a mutation-verify: an update-only access (bypassing terminate) fires NO observer', async () => {
    // Same scenario, but the access has NO `terminate` — the surface falls back
    // to the bare `update` (board-less/observer-less boots + pre-F6a behaviour).
    // The observer spy stays empty: this is the exact regression terminate() fixes.
    const item = await store.create(SCOPE, { title: 'Running build' })
    await store.bindRun(SCOPE, item.id, 'run-1')
    const observed: Array<{ id: string; phase: TridentPhase }> = []
    const { access, updates } = fakeRunAccess({ 'run-1': fakeRun({ id: 'run-1', phase: 'forge-init' }) })
    // (no `terminate` on `access` → the surface uses `update`; no observer runs)
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })

    const res = await s.handler(req('DELETE', `/api/app/projects/proj1/work-board/${item.id}`))
    expect(res?.status).toBe(200)
    expect(updates).toEqual([{ id: 'run-1', phase: 'stopped' }])
    expect(observed).toEqual([]) // <- reds if the bypass ever fired observers
  })

  test('§F6a race: DELETE does NOT report cancelled_run when terminate() LOSES the race', async () => {
    // The pre-check sees a NON-terminal run (so the surface calls terminate), but
    // in the await gap the tick loop finishes the run first → the atomic transition
    // loses (`won:false`). The delete must NOT falsely claim it cancelled (Codex r3).
    const item = await store.create(SCOPE, { title: 'Racing build' })
    await store.bindRun(SCOPE, item.id, 'run-1')
    const terminated: Array<{ id: string; phase: TridentPhase }> = []
    const access: TridentRunAccess = {
      // Pre-check reads a live run → the surface proceeds to terminate().
      get: () => fakeRun({ id: 'run-1', phase: 'forge-init' }),
      update: async () => {
        throw new Error('must route through terminate()')
      },
      // The transition LOST — the run was already terminalized out-of-band.
      terminate: async (id, phase) => {
        terminated.push({ id, phase })
        return { won: false }
      },
    }
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })

    const res = await s.handler(req('DELETE', `/api/app/projects/proj1/work-board/${item.id}`))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { cancelled_run?: string }
    // terminate() WAS attempted (the pre-check passed)…
    expect(terminated).toEqual([{ id: 'run-1', phase: 'stopped' }])
    // …but it lost, so no phantom cancellation is reported.
    expect(body.cancelled_run).toBeUndefined()
    // The item is still deleted (best-effort cancel never blocks the delete).
    expect(store.get(SCOPE, item.id)).toBeNull()
  })

  test('DELETE does NOT cancel an already-terminal linked run', async () => {
    const item = await store.create(SCOPE, { title: 'Done build' })
    await store.bindRun(SCOPE, item.id, 'run-1')
    const { access, updates } = fakeRunAccess({ 'run-1': fakeRun({ id: 'run-1', phase: 'done' }) })
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })

    const res = await s.handler(req('DELETE', `/api/app/projects/proj1/work-board/${item.id}`))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { cancelled_run?: string }
    expect(body.cancelled_run).toBeUndefined()
    expect(updates).toEqual([])
    expect(store.get(SCOPE, item.id)).toBeNull()
  })

  test('DELETE on an unbound item just deletes (no cancel)', async () => {
    const item = await store.create(SCOPE, { title: 'Plain item' })
    const { access, updates } = fakeRunAccess({})
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })

    const res = await s.handler(req('DELETE', `/api/app/projects/proj1/work-board/${item.id}`))
    expect(res?.status).toBe(200)
    expect(updates).toEqual([])
    expect(store.get(SCOPE, item.id)).toBeNull()
  })
})

describe('work-board HTTP surface — ▶ start + spec create (M1)', () => {
  const auth = createAppWsAuthResolver({ project_slug: SLUG, bypass: true })

  test('POST create with a substantial spec routes through create_card', async () => {
    const calls: Array<{ title: string; spec?: string }> = []
    const s = createWorkBoardSurface({
      store,
      auth,
      create_card: async (slug, input) => {
        calls.push({ title: input.title, ...(input.spec !== undefined ? { spec: input.spec } : {}) })
        return store.create(slug, { title: input.title, design_doc_ref: 'neutron-docs:plans/x.md' })
      },
    })
    const res = await s.handler(
      req('POST', '/api/app/projects/proj1/work-board', { title: 'big', spec: 'a\nb\nc' }),
    )
    expect(res?.status).toBe(201)
    expect(calls).toEqual([{ title: 'big', spec: 'a\nb\nc' }])
  })

  test('POST start → dispatches + returns run_id', async () => {
    const item = await store.create(SCOPE, { title: 'Ready item' })
    const s = createWorkBoardSurface({
      store,
      auth,
      start_build: async () => ({ ok: true, run_id: 'run-xyz' }),
    })
    const res = await s.handler(req('POST', `/api/app/projects/proj1/work-board/${item.id}/start`))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; run_id: string; started: string }
    expect(body.ok).toBe(true)
    expect(body.run_id).toBe('run-xyz')
    expect(body.started).toBe(item.id)
  })

  test('POST start on an unknown item → 404', async () => {
    const s = createWorkBoardSurface({ store, auth, start_build: async () => ({ ok: true, run_id: 'r' }) })
    const res = await s.handler(req('POST', '/api/app/projects/proj1/work-board/nope/start'))
    expect(res?.status).toBe(404)
  })

  test('POST start with no start_build wired → 501', async () => {
    const item = await store.create(SCOPE, { title: 'Ready item' })
    const s = createWorkBoardSurface({ store, auth })
    const res = await s.handler(req('POST', `/api/app/projects/proj1/work-board/${item.id}/start`))
    expect(res?.status).toBe(501)
  })

  test('POST start on an item with a LIVE bound run → 409 already_running', async () => {
    const item = await store.create(SCOPE, { title: 'Bound item' })
    await store.attachRun(SCOPE, item.id, 'run-live')
    const bound = store.get(SCOPE, item.id)!
    const { access } = fakeRunAccess({ 'run-live': fakeRun({ id: 'run-live', phase: 'forge-init' }) })
    const s = createWorkBoardSurface({
      store,
      auth,
      trident_runs: access,
      start_build: async () => ({ ok: true, run_id: 'should-not-be-called' }),
    })
    const res = await s.handler(req('POST', `/api/app/projects/proj1/work-board/${bound.id}/start`))
    expect(res?.status).toBe(409)
    const body = (await res!.json()) as { code: string }
    expect(body.code).toBe('already_running')
  })

  test('#337 — POST start on an underspecified item → 200 asked_in_chat (NO raw guard in the pane)', async () => {
    const item = await store.create(SCOPE, { title: 'thin' })
    const s = createWorkBoardSurface({
      store,
      auth,
      // The composer's start closure posts a clarifying question to chat and
      // returns the underspecified rejection; the surface must NOT paint it.
      start_build: async () => ({ ok: false, code: 'underspecified', message: 'internal guard reasoning' }),
    })
    const res = await s.handler(req('POST', `/api/app/projects/proj1/work-board/${item.id}/start`))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { asked_in_chat?: boolean; message?: string }
    expect(body.asked_in_chat).toBe(true)
    // The raw internal guard text is NEVER surfaced to the client (→ the pane).
    expect(JSON.stringify(body)).not.toContain('internal guard reasoning')
  })

  test('a genuine backend_error on start still surfaces as an error (500)', async () => {
    const item = await store.create(SCOPE, { title: 'thing' })
    const s = createWorkBoardSurface({
      store,
      auth,
      start_build: async () => ({ ok: false, code: 'backend_error', message: 'disk full' }),
    })
    const res = await s.handler(req('POST', `/api/app/projects/proj1/work-board/${item.id}/start`))
    expect(res?.status).toBe(500)
  })
})

describe('work-board HTTP surface — per-project scoping (Bug 3)', () => {
  test('two projects keep DISTINCT boards; an item created in A is absent from B', async () => {
    // Create in project A THROUGH the surface (the real write path).
    const created = await surface.handler(
      req('POST', '/api/app/projects/projA/work-board', { title: 'A-only' }),
    )
    expect(created?.status).toBe(201)

    // GET project A sees it; GET project B is empty (isolated).
    const aList = await surface.handler(req('GET', '/api/app/projects/projA/work-board'))
    const aBody = (await aList!.json()) as { items: { title: string }[]; project_id: string }
    expect(aBody.items.map((i) => i.title)).toEqual(['A-only'])
    expect(aBody.project_id).toBe('projA')

    const bList = await surface.handler(req('GET', '/api/app/projects/projB/work-board'))
    const bBody = (await bList!.json()) as { items: unknown[] }
    expect(bBody.items).toEqual([])

    // The row is keyed on project A's scope, NOT the bare owner slug.
    expect(store.list('projA').map((i) => i.title)).toEqual(['A-only'])
    expect(store.list(SLUG)).toEqual([])
  })

  test("an item id from project A is 404 through project B's path (no cross-scope probe)", async () => {
    const a = await store.create('projA', { title: 'secret' })
    const patchB = await surface.handler(
      req('PATCH', `/api/app/projects/projB/work-board/${a.id}`, { title: 'x' }),
    )
    expect(patchB?.status).toBe(404)
    const delB = await surface.handler(req('DELETE', `/api/app/projects/projB/work-board/${a.id}`))
    expect(delB?.status).toBe(404)
    // A's item is untouched.
    expect(store.get('projA', a.id)?.title).toBe('secret')
  })

  test('the General board maps to the owner slug (pre-scoping legacy rows preserved)', async () => {
    // A row written under the bare owner slug (how ALL rows were keyed before
    // per-project scoping) surfaces on the General board — not stranded.
    await store.create(SLUG, { title: 'legacy' })
    const gen = await surface.handler(req('GET', '/api/app/projects/general/work-board'))
    const genBody = (await gen!.json()) as { items: { title: string }[]; project_id: string }
    expect(genBody.items.map((i) => i.title)).toEqual(['legacy'])
    expect(genBody.project_id).toBe('general')

    // A real project does NOT see the legacy General rows.
    const proj = await surface.handler(req('GET', '/api/app/projects/projA/work-board'))
    const projBody = (await proj!.json()) as { items: unknown[] }
    expect(projBody.items).toEqual([])
  })
})
