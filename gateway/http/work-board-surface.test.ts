import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { createAppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { WorkBoardStore, workBoardScopeKey } from '@neutronai/work-board/store.ts'
import { WorkBoardRemovalService } from '@neutronai/work-board/removal.ts'
import { makeTridentRun } from '@neutronai/trident/testing/make-trident-run.ts'
import {
  createWorkBoardSurface,
  type TridentRunAccess,
  type WorkBoardSurface,
} from './work-board-surface.ts'
import type { TridentPhase, TridentRun } from '@neutronai/trident/store.ts'
import {
  INLINE_EVIDENCE_WINDOW_MS,
  withDerivedInlineActive,
  type InlineEvidenceReader,
} from '@neutronai/work-board/inline-activity.ts'
import { inspectorScopeKey } from '@neutronai/open/activity-inspector.ts'

/** A minimal fake trident run for the surface's progress + cancel deps. */
function fakeRun(over: Partial<TridentRun> = {}): TridentRun {
  return makeTridentRun({
    id: 'run-1',
    slug: 'demo',
    project_slug: SLUG,
    branch: 'trident/demo',
    merge_mode: 'pr',
    subagent_run_id: 'wf-1',
    repo_path: '/repo',
    task: 'build',
    channel_kind: 'app_socket',
    workflow_run_id: 'wf-1',
    started_at: '2026-07-02T00:00:00Z',
    last_advanced_at: '2026-07-02T00:00:00Z',
    ...over,
  })
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
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
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

  test('GET composes run_progress.pr_url from the shared repo-web-url peek', async () => {
    const item = await store.create(SCOPE, { title: 'Building' })
    await store.bindRun(SCOPE, item.id, 'run-pr')
    const { access } = fakeRunAccess({
      'run-pr': fakeRun({ id: 'run-pr', project_slug: SCOPE, pr: 265, repo_path: '/repos/x' }),
    })
    const peeked: string[] = []
    const s = createWorkBoardSurface({
      store,
      auth,
      trident_runs: access,
      repo_web_urls: {
        peek: (repo_path: string) => {
          peeked.push(repo_path)
          return 'https://github.com/acme/widget'
        },
      },
    })
    const res = await s.handler(req('GET', '/api/app/projects/proj1/work-board'))
    const body = (await res!.json()) as {
      items: Array<{ id: string; run_progress?: { pr: number | null; pr_url: string | null } }>
    }
    const row = body.items.find((i) => i.id === item.id)
    // The url comes off the RUN'S OWN repo_path, never a hardcoded repo.
    expect(peeked).toContain('/repos/x')
    expect(row?.run_progress?.pr).toBe(265)
    expect(row?.run_progress?.pr_url).toBe('https://github.com/acme/widget/pull/265')
  })

  test('GET without a repo-web-url cache still emits pr_url — null, not absent', async () => {
    const item = await store.create(SCOPE, { title: 'Building' })
    await store.bindRun(SCOPE, item.id, 'run-nourl')
    const { access } = fakeRunAccess({
      'run-nourl': fakeRun({ id: 'run-nourl', project_slug: SCOPE, pr: 265, repo_path: '/repos/x' }),
    })
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })
    const res = await s.handler(req('GET', '/api/app/projects/proj1/work-board'))
    const body = (await res!.json()) as {
      items: Array<{ id: string; run_progress?: Record<string, unknown> }>
    }
    const row = body.items.find((i) => i.id === item.id)
    expect(row?.run_progress).toBeDefined()
    // The field must EXIST on the wire (null → plain text), not be missing.
    expect(Object.hasOwn(row?.run_progress ?? {}, 'pr_url')).toBe(true)
    expect(row?.run_progress?.['pr_url']).toBeNull()
  })

  test('GET carries the DURABLE pr/pr_url of a completed (detached) card', async () => {
    // The completed card has NO run binding — `run_progress` is impossible here,
    // so the number can only come off the item's own columns (migration 0122).
    const item = await store.create(SCOPE, { title: 'Merged one' })
    await store.attachRun(SCOPE, item.id, 'run-1')
    await store.detachRun(SCOPE, 'run-1', 'done', {
      pr: 265,
      pr_url: 'https://github.com/acme/widget/pull/265',
    })
    const { access } = fakeRunAccess({})
    const s = createWorkBoardSurface({ store, auth, trident_runs: access })
    const res = await s.handler(req('GET', '/api/app/projects/proj1/work-board'))
    const body = (await res!.json()) as {
      items: Array<{
        id: string
        pr?: number | null
        pr_url?: string | null
        run_progress?: unknown
      }>
    }
    const row = body.items.find((i) => i.id === item.id)
    expect(row?.run_progress).toBeUndefined()
    expect(row?.pr).toBe(265)
    expect(row?.pr_url).toBe('https://github.com/acme/widget/pull/265')
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

describe('work-board HTTP surface — DELETE reason + plan-doc disposition', () => {
  const auth = createAppWsAuthResolver({ project_slug: SLUG, bypass: true })

  /** A `RemovalDocStore` spy + the removal chokepoint the composer wires. */
  function withDocs(): {
    removal: WorkBoardRemovalService
    moves: Array<{ project_id: string; from: string; to: string }>
    deletes: Array<{ project_id: string; path: string }>
  } {
    const moves: Array<{ project_id: string; from: string; to: string }> = []
    const deletes: Array<{ project_id: string; path: string }> = []
    const removal = new WorkBoardRemovalService({
      store,
      docs: {
        moveDoc: async (project_id, from, to) => {
          moves.push({ project_id, from, to })
          return null
        },
        deleteDoc: async (project_id, path) => {
          deletes.push({ project_id, path })
          return null
        },
      },
    })
    return { removal, moves, deletes }
  }

  test('no ?reason → the X default (cancelled): the plan doc lands in plans/cancelled/', async () => {
    const item = await store.create(SCOPE, {
      title: 'Dropped',
      design_doc_ref: 'neutron-docs:plans/dropped-abc123.md',
    })
    const { removal, moves, deletes } = withDocs()
    const s = createWorkBoardSurface({ store, auth, removal })

    const res = await s.handler(req('DELETE', `/api/app/projects/proj1/work-board/${item.id}`))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as {
      deleted: string
      plan_doc?: { path: string; disposition: string; to?: string }
    }
    expect(body.deleted).toBe(item.id)
    expect(body.plan_doc).toEqual({
      path: 'plans/dropped-abc123.md',
      disposition: 'moved',
      to: 'plans/cancelled/dropped-abc123.md',
    })
    // The DOCS project id is the URL segment, not the board scope key.
    expect(moves).toEqual([
      { project_id: 'proj1', from: 'plans/dropped-abc123.md', to: 'plans/cancelled/dropped-abc123.md' },
    ])
    expect(deletes).toEqual([])
    expect(store.get(SCOPE, item.id)).toBeNull()
  })

  test('?reason=shipped files the plan doc under plans/shipped/', async () => {
    const item = await store.create(SCOPE, {
      title: 'Shipped',
      design_doc_ref: 'neutron-docs:plans/shipped-abc123.md',
    })
    const { removal, moves, deletes } = withDocs()
    const s = createWorkBoardSurface({ store, auth, removal })

    const res = await s.handler(
      req('DELETE', `/api/app/projects/proj1/work-board/${item.id}?reason=shipped`),
    )
    expect(res?.status).toBe(200)
    expect(moves).toEqual([
      { project_id: 'proj1', from: 'plans/shipped-abc123.md', to: 'plans/shipped/shipped-abc123.md' },
    ])
    expect(deletes).toEqual([])
  })

  test('?reason=bogus → 400 invalid_reason, and nothing is removed', async () => {
    const item = await store.create(SCOPE, { title: 'Safe' })
    const { removal } = withDocs()
    const s = createWorkBoardSurface({ store, auth, removal })

    const res = await s.handler(
      req('DELETE', `/api/app/projects/proj1/work-board/${item.id}?reason=bogus`),
    )
    expect(res?.status).toBe(400)
    const body = (await res!.json()) as { code: string }
    expect(body.code).toBe('invalid_reason')
    expect(store.get(SCOPE, item.id)).not.toBeNull()
  })

  test('?plan_doc=delete is the ONLY way the doc is destroyed', async () => {
    const item = await store.create(SCOPE, {
      title: 'Scrap it',
      design_doc_ref: 'neutron-docs:plans/scrap-abc123.md',
    })
    const { removal, moves, deletes } = withDocs()
    const s = createWorkBoardSurface({ store, auth, removal })

    const res = await s.handler(
      req('DELETE', `/api/app/projects/proj1/work-board/${item.id}?plan_doc=delete`),
    )
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { plan_doc?: { disposition: string } }
    expect(body.plan_doc?.disposition).toBe('deleted')
    expect(deletes).toEqual([{ project_id: 'proj1', path: 'plans/scrap-abc123.md' }])
    expect(moves).toEqual([])
  })

  test('?plan_doc=anything-else → 400 invalid_plan_doc (a destroy must be spelled out)', async () => {
    const item = await store.create(SCOPE, { title: 'Safe' })
    const { removal, deletes } = withDocs()
    const s = createWorkBoardSurface({ store, auth, removal })

    const res = await s.handler(
      req('DELETE', `/api/app/projects/proj1/work-board/${item.id}?plan_doc=yes`),
    )
    expect(res?.status).toBe(400)
    const body = (await res!.json()) as { code: string }
    expect(body.code).toBe('invalid_plan_doc')
    expect(deletes).toEqual([])
    expect(store.get(SCOPE, item.id)).not.toBeNull()
  })
})

describe('work-board HTTP surface — ▶ start + spec create (M1)', () => {
  const auth = createAppWsAuthResolver({ project_slug: SLUG, bypass: true })

  test('POST create with a substantial spec routes through create_card', async () => {
    const calls: Array<{ title: string; docsProjectId: string; spec?: string }> = []
    const s = createWorkBoardSurface({
      store,
      auth,
      create_card: async (scope, docsProjectId, input) => {
        calls.push({ title: input.title, docsProjectId, ...(input.spec !== undefined ? { spec: input.spec } : {}) })
        return store.create(scope, { title: input.title, design_doc_ref: 'neutron-docs:plans/x.md' })
      },
    })
    const res = await s.handler(
      req('POST', '/api/app/projects/proj1/work-board', { title: 'big', spec: 'a\nb\nc' }),
    )
    expect(res?.status).toBe(201)
    // The docs project id must be the URL's project id, NOT the board scope key:
    // handing the scope to writeDoc is what put General's plans in a phantom
    // project directory named after the instance.
    expect(calls).toEqual([{ title: 'big', docsProjectId: 'proj1', spec: 'a\nb\nc' }])
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

  // ── #379 — the ▶ routes BY TASK TYPE (research → Atlas, build → Trident) ──

  test('#379 create persists task_type (default build; explicit research)', async () => {
    const b = await surface.handler(
      req('POST', '/api/app/projects/proj1/work-board', { title: 'a build' }),
    )
    const bItem = ((await b!.json()) as { item: { id: string; task_type: string } }).item
    expect(bItem.task_type).toBe('build') // default
    expect(store.get(SCOPE, bItem.id)?.task_type).toBe('build')

    const r = await surface.handler(
      req('POST', '/api/app/projects/proj1/work-board', {
        title: 'a research task',
        task_type: 'research',
      }),
    )
    const rItem = ((await r!.json()) as { item: { id: string; task_type: string } }).item
    expect(rItem.task_type).toBe('research')
    expect(store.get(SCOPE, rItem.id)?.task_type).toBe('research')
  })

  test('#379 create rejects an unknown task_type with 400', async () => {
    const res = await surface.handler(
      req('POST', '/api/app/projects/proj1/work-board', { title: 'x', task_type: 'wat' }),
    )
    expect(res?.status).toBe(400)
    expect(((await res!.json()) as { code: string }).code).toBe('invalid_task_type')
  })

  test('#379 ▶ a RESEARCH card routes to start_research (NOT start_build)', async () => {
    const item = await store.create(SCOPE, { title: 'research this', task_type: 'research' })
    let buildCalled = false
    let researchCalled = false
    const s = createWorkBoardSurface({
      store,
      auth,
      start_build: async () => {
        buildCalled = true
        return { ok: true, run_id: 'build-run' }
      },
      start_research: async () => {
        researchCalled = true
        return { ok: true, run_id: 'atlas-run' }
      },
    })
    const res = await s.handler(req('POST', `/api/app/projects/proj1/work-board/${item.id}/start`))
    expect(res?.status).toBe(200)
    expect(((await res!.json()) as { run_id: string }).run_id).toBe('atlas-run')
    expect(researchCalled).toBe(true)
    expect(buildCalled).toBe(false) // the play button did NOT stamp a Trident build
  })

  test('#379 ▶ a BUILD card routes to start_build (NOT start_research)', async () => {
    const item = await store.create(SCOPE, { title: 'build this' }) // default build
    let buildCalled = false
    let researchCalled = false
    const s = createWorkBoardSurface({
      store,
      auth,
      start_build: async () => {
        buildCalled = true
        return { ok: true, run_id: 'build-run' }
      },
      start_research: async () => {
        researchCalled = true
        return { ok: true, run_id: 'atlas-run' }
      },
    })
    const res = await s.handler(req('POST', `/api/app/projects/proj1/work-board/${item.id}/start`))
    expect(res?.status).toBe(200)
    expect(((await res!.json()) as { run_id: string }).run_id).toBe('build-run')
    expect(buildCalled).toBe(true)
    expect(researchCalled).toBe(false)
  })

  test('#379 ▶ a research card with no start_research wired → 501', async () => {
    const item = await store.create(SCOPE, { title: 'research', task_type: 'research' })
    // Only a build dispatcher is wired; a research ▶ must not silently build.
    const s = createWorkBoardSurface({ store, auth, start_build: async () => ({ ok: true, run_id: 'r' }) })
    const res = await s.handler(req('POST', `/api/app/projects/proj1/work-board/${item.id}/start`))
    expect(res?.status).toBe(501)
  })

  test('#379 ▶ a research card with a live bound run → 409 already_running (double-▶ guard)', async () => {
    const item = await store.create(SCOPE, { title: 'research', task_type: 'research' })
    await store.attachRun(SCOPE, item.id, 'atlas-live') // a live agent-dispatch run
    let researchCalled = false
    const s = createWorkBoardSurface({
      store,
      auth,
      start_research: async () => {
        researchCalled = true
        return { ok: true, run_id: 'twin' }
      },
    })
    const res = await s.handler(req('POST', `/api/app/projects/proj1/work-board/${item.id}/start`))
    expect(res?.status).toBe(409)
    expect(researchCalled).toBe(false)
  })

  test('#379 deleting a research card cancels its dispatch run', async () => {
    const item = await store.create(SCOPE, { title: 'research', task_type: 'research' })
    await store.attachRun(SCOPE, item.id, 'atlas-run')
    const cancelled: string[] = []
    const s = createWorkBoardSurface({
      store,
      auth,
      cancel_dispatch: async (run_id) => {
        cancelled.push(run_id)
      },
    })
    const res = await s.handler(req('DELETE', `/api/app/projects/proj1/work-board/${item.id}`))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { deleted: string; cancelled_run?: string }
    expect(body.deleted).toBe(item.id)
    expect(body.cancelled_run).toBe('atlas-run')
    expect(cancelled).toEqual(['atlas-run'])
    expect(store.get(SCOPE, item.id)).toBeNull()
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

describe('work-board HTTP surface — #429 task 3 auto-classify task_type', () => {
  const auth = createAppWsAuthResolver({ project_slug: SLUG, bypass: true })

  test('create WITHOUT task_type classifies the title (store.create path)', async () => {
    const captured: string[] = []
    const s = createWorkBoardSurface({
      store,
      auth,
      classify_task_type: async (t) => {
        captured.push(t)
        return 'research'
      },
    })
    const res = await s.handler(
      req('POST', '/api/app/projects/proj1/work-board', { title: 'dig into the outage' }),
    )
    expect(res?.status).toBe(201)
    const item = ((await res!.json()) as { item: { id: string; task_type: string } }).item
    expect(item.task_type).toBe('research')
    expect(store.get(SCOPE, item.id)?.task_type).toBe('research')
    expect(captured).toEqual(['dig into the outage'])
  })

  test('explicit task_type WINS — the classifier is never called', async () => {
    const s = createWorkBoardSurface({
      store,
      auth,
      classify_task_type: async () => {
        throw new Error('classifier must not be called when task_type is explicit')
      },
    })
    const res = await s.handler(
      req('POST', '/api/app/projects/proj1/work-board', { title: 'anything', task_type: 'build' }),
    )
    expect(res?.status).toBe(201)
    const item = ((await res!.json()) as { item: { task_type: string } }).item
    expect(item.task_type).toBe('build')
  })

  test('a REJECTING classifier → 201 with the store default (build)', async () => {
    const s = createWorkBoardSurface({
      store,
      auth,
      classify_task_type: async () => {
        throw new Error('boom')
      },
    })
    const res = await s.handler(
      req('POST', '/api/app/projects/proj1/work-board', { title: 'some card' }),
    )
    expect(res?.status).toBe(201)
    const item = ((await res!.json()) as { item: { task_type: string } }).item
    expect(item.task_type).toBe('build')
  })

  test('create_card path receives the classified task_type', async () => {
    const captured: Array<{ title: string; task_type?: string }> = []
    const s = createWorkBoardSurface({
      store,
      auth,
      create_card: async (slug, _docsProjectId, input) => {
        captured.push({
          title: input.title,
          ...(input.task_type !== undefined ? { task_type: input.task_type } : {}),
        })
        return store.create(slug, {
          title: input.title,
          ...(input.task_type !== undefined ? { task_type: input.task_type } : {}),
        })
      },
      classify_task_type: async () => 'research',
    })
    const res = await s.handler(
      req('POST', '/api/app/projects/proj1/work-board', { title: 'look into the metrics' }),
    )
    expect(res?.status).toBe(201)
    expect(captured).toEqual([{ title: 'look into the metrics', task_type: 'research' }])
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

/**
 * T3 — derived inline activity at the HTTP boundary. Every item-bearing response
 * must carry the EVIDENCE-derived `inline_active`, never the stored hint. Each
 * test below names the rule/mapping whose deletion turns it red; the dep is
 * wired through the REAL `withDerivedInlineActive` + `inspectorScopeKey`, only
 * the evidence clock is faked.
 */
describe('derived inline activity on the HTTP surface', () => {
  const NOW = 1_000_000
  /** ms epoch of the last WRITE-CLASS tap; 0 = none ever. */
  let evidenceAt = 0
  let readerCalls = 0
  let wired: WorkBoardSurface

  beforeEach(() => {
    evidenceAt = 0
    readerCalls = 0
    const reader: InlineEvidenceReader = {
      lastWriteActivityAt: () => {
        readerCalls++
        return evidenceAt
      },
    }
    const auth = createAppWsAuthResolver({ project_slug: SLUG, bypass: true })
    wired = createWorkBoardSurface({
      store,
      auth,
      derive_inline_active: (items, pid) =>
        withDerivedInlineActive(items, reader, inspectorScopeKey(pid), NOW),
    })
  })

  test('(a) fresh evidence activates a runless in_progress card, and writes nothing', async () => {
    const a = await store.create(SCOPE, { title: 'A', status: 'in_progress' })
    expect(a.inline_active).toBe(false) // the stored hint says "idle"
    evidenceAt = NOW - 1_000 // a real tool call one second ago
    const before = store.get(SCOPE, a.id)

    const res = await wired.handler(req('GET', '/api/app/projects/proj1/work-board'))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { items: { id: string; inline_active: boolean }[] }
    // Deleting the GET `derive(...)` mapping turns this red.
    expect(body.items[0]?.inline_active).toBe(true)

    // Read-only: no work_board_update anywhere in the path — the stored row,
    // including its hint and updated_at, is byte-identical to before the GET.
    expect(store.get(SCOPE, a.id)).toEqual(before)
    expect(store.get(SCOPE, a.id)!.inline_active).toBe(false)
  })

  test('(b) a crashed session stale flag reads false on GET and on the update echo', async () => {
    const a = await store.create(SCOPE, { title: 'A', status: 'in_progress' })
    await store.update(SCOPE, a.id, { inline_active: true }) // session died flag-on
    evidenceAt = 0 // the inspector buffer died with the process

    const res = await wired.handler(req('GET', '/api/app/projects/proj1/work-board'))
    const body = (await res!.json()) as { items: { inline_active: boolean }[] }
    expect(body.items[0]?.inline_active).toBe(false) // evidence wins over the flag

    // Deleting the update-echo `deriveOne` turns this red.
    const patch = await wired.handler(
      req('PATCH', `/api/app/projects/proj1/work-board/${a.id}`, { title: 'A2' }),
    )
    expect(patch?.status).toBe(200)
    const patched = (await patch!.json()) as { item: { title: string; inline_active: boolean } }
    expect(patched.item.title).toBe('A2')
    expect(patched.item.inline_active).toBe(false)
    // The hint is still set in storage — only the WIRE value was healed.
    expect(store.get(SCOPE, a.id)!.inline_active).toBe(true)
  })

  test('(c) evidence exactly at the window boundary is stale — the derivation cannot latch', async () => {
    const a = await store.create(SCOPE, { title: 'A', status: 'in_progress' })
    await store.update(SCOPE, a.id, { inline_active: true })
    evidenceAt = NOW - INLINE_EVIDENCE_WINDOW_MS // stale by `>=`, not fresh

    const res = await wired.handler(req('GET', '/api/app/projects/proj1/work-board'))
    const body = (await res!.json()) as { items: { inline_active: boolean }[] }
    // A `return true` mutant of the dep (or a `>` boundary) fails here.
    expect(body.items[0]?.inline_active).toBe(false)
  })

  test('(e) one evidence read per response, not one per row', async () => {
    for (const t of ['a', 'b', 'c', 'd', 'e']) {
      await store.create(SCOPE, { title: t, status: 'in_progress' })
    }
    evidenceAt = NOW - 1_000
    readerCalls = 0

    const res = await wired.handler(req('GET', '/api/app/projects/proj1/work-board'))
    const body = (await res!.json()) as { items: { inline_active: boolean }[] }
    expect(body.items).toHaveLength(5)
    // …and ONE project write does not claim five cards: status-only derivation is
    // rationed to a single candidate row, so ▶ stays available on the rest of the
    // board. Deleting that rationing makes this five.
    expect(body.items.filter((i) => i.inline_active)).toHaveLength(1)
    // Deleting the BATCH shape (calling the reader per item) turns this red.
    expect(readerCalls).toBe(1)
  })

  test('the reorder response carries derived values too', async () => {
    const live = await store.create(SCOPE, { title: 'live', status: 'in_progress' })
    await store.create(SCOPE, { title: 'idle' })
    evidenceAt = NOW - 1_000

    const res = await wired.handler(
      req('POST', `/api/app/projects/proj1/work-board/${live.id}/reorder`, {}),
    )
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { items: { title: string; inline_active: boolean }[] }
    // Deleting the reorder `derive(...)` turns this red.
    expect(body.items.find((i) => i.title === 'live')?.inline_active).toBe(true)
    expect(body.items.find((i) => i.title === 'idle')?.inline_active).toBe(false)
  })

  test('a dep-less surface still passes the RAW stored flag through (degraded, not broken)', async () => {
    const a = await store.create(SCOPE, { title: 'A', status: 'in_progress' })
    await store.update(SCOPE, a.id, { inline_active: true })
    evidenceAt = 0

    const res = await surface.handler(req('GET', '/api/app/projects/proj1/work-board'))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { items: { inline_active: boolean }[] }
    expect(body.items[0]?.inline_active).toBe(true)
    expect(readerCalls).toBe(0)
  })

  test('(d) nothing is gated: the wired surface returns the same statuses as the dep-less one', async () => {
    evidenceAt = NOW - 1_000 // maximally "active" — still gates nothing

    const run = async (s: WorkBoardSurface, project: string): Promise<number[]> => {
      const created = await s.handler(
        req('POST', `/api/app/projects/${project}/work-board`, { title: 'x' }),
      )
      const createdText = await created!.text()
      const id = (JSON.parse(createdText) as { item: { id: string } }).item.id
      const patched = await s.handler(
        req('PATCH', `/api/app/projects/${project}/work-board/${id}`, { status: 'in_progress' }),
      )
      const reordered = await s.handler(
        req('POST', `/api/app/projects/${project}/work-board/${id}/reorder`, {}),
      )
      const completed = await s.handler(
        req('POST', `/api/app/projects/${project}/work-board/${id}/complete`, {}),
      )
      const completedText = await completed!.text()
      // Every mutation ACTUALLY LANDED — the load-bearing form of "nothing is
      // gated". A substring hunt for 'denied' over an `{item:{…}}` body proves
      // nothing; a write that the derivation suppressed would show up here as a
      // missing item or an unchanged status.
      const patchedBody = JSON.parse(await patched!.text()) as { item: { status: string } }
      expect(patchedBody.item.status).toBe('in_progress')
      const reorderedBody = JSON.parse(await reordered!.text()) as { items: { id: string }[] }
      expect(reorderedBody.items.map((i) => i.id)).toContain(id)
      // `complete` flips status to 'done', so its echo derives false via R1.
      const completedBody = JSON.parse(completedText) as { item: { inline_active: boolean } }
      expect(completedBody.item.inline_active).toBe(false)
      return [created!.status, patched!.status, reordered!.status, completed!.status]
    }

    const wiredStatuses = await run(wired, 'projW')
    const plainStatuses = await run(surface, 'projP')
    expect(wiredStatuses).toEqual([201, 200, 200, 200])
    expect(wiredStatuses).toEqual(plainStatuses)
  })
})

/**
 * The SHELVED lane over HTTP (migration 0130). 'archived' is client-writable —
 * it is the deprioritise lever — while 'failed' stays run-driven-only.
 */
describe('work-board HTTP surface — the SHELVED lane (status=archived)', () => {
  const auth = createAppWsAuthResolver({ project_slug: SLUG, bypass: true })

  test("PATCH status:'archived' → 200, off the active lane, completed_at null", async () => {
    const a = await store.create(SCOPE, { title: 'deprioritised card' })
    const res = await surface.handler(
      req('PATCH', `/api/app/projects/proj1/work-board/${a.id}`, { status: 'archived' }),
    )
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; item: { status: string; completed_at: string | null } }
    expect(body.item.status).toBe('archived')
    expect(body.item.completed_at).toBeNull()
    expect(store.listActive(SCOPE)).toHaveLength(0)
    expect(store.listCompleted(SCOPE)).toHaveLength(0)
    expect(store.listArchived(SCOPE).map((i) => i.id)).toEqual([a.id])
  })

  test("PATCH status:'failed' is still 400 invalid_status (run-driven only)", async () => {
    const a = await store.create(SCOPE, { title: 'not yours to write' })
    const res = await surface.handler(
      req('PATCH', `/api/app/projects/proj1/work-board/${a.id}`, { status: 'failed' }),
    )
    expect(res?.status).toBe(400)
    const body = (await res!.json()) as { ok: boolean; code: string }
    expect(body.code).toBe('invalid_status')
  })

  test('PATCH archived on a LIVE-run card → 409 run_still_live (not a 500)', async () => {
    const liveStore = new WorkBoardStore(db, { isRunLive: () => true })
    const liveSurface = createWorkBoardSurface({ store: liveStore, auth })
    const a = await liveStore.create(SCOPE, { title: 'building right now' })
    await liveStore.attachRun(SCOPE, a.id, 'run-live')

    const res = await liveSurface.handler(
      req('PATCH', `/api/app/projects/proj1/work-board/${a.id}`, { status: 'archived' }),
    )
    expect(res?.status).toBe(409)
    const body = (await res!.json()) as { ok: boolean; code: string; message: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('run_still_live')
    expect(body.message).toContain('run-live')
    // Nothing was written.
    expect(liveStore.get(SCOPE, a.id)?.status).toBe('in_progress')
  })
})
