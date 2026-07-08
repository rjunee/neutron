/**
 * ISSUES #9 — production-composer reachability guard for the projects
 * surface (list endpoint + settings drawer + SQLite-backed store).
 *
 * Same anti-pattern guard PR #229/#231/#233 enforce: a future
 * refactor that drops the surface from `composeProductionGraph` or
 * `composeHttpHandler` MUST fail this test. The point is to assert
 * the production composition mounts:
 *
 *   1. `GET   /api/app/projects`              (list endpoint, ISSUES #9)
 *   2. `POST  /api/app/projects`              (create endpoint — rail Create Project)
 *   3. `GET   /api/app/projects/<id>/settings` (drawer read)
 *   4. `PATCH /api/app/projects/<id>/settings` (drawer flip)
 *
 * Against a real `ProjectDb` + the migrated `projects` +
 * `project_members` tables (migration 0038) + the
 * `SqliteProjectSettingsStore`. End-to-end: HTTP request →
 * `composeHttpHandler` chain → surface → store → SQLite. PATCH
 * mutations are read back through a NEW store instance over the
 * SAME DB to prove persistence survives store re-init (the
 * regression the in-memory implementation hit, per the ISSUES.md #9
 * description).
 *
 * Mirrors `gateway/__tests__/focus-production-composer.test.ts`
 * + `gateway/__tests__/reminders-production-composer.test.ts`
 * verbatim.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '../composition.ts'
import {
  createAppProjectsSurface,
  buildDefaultSettings,
  type ProjectSettings,
} from '../http/app-projects-surface.ts'
import { createProjectRow } from '../realmode-composer/project-create.ts'
import { SqliteProjectSettingsStore } from '../projects/sqlite-store.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const OWNER = 'projects-composer-project'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  tmp: string
  store: SqliteProjectSettingsStore
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
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-projects-composer-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  // Build the surface pieces the same way gateway/index.ts does at
  // boot. `SqliteProjectSettingsStore` over the per-project ProjectDb
  // — the SAME shape production uses post-ISSUES #9.
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const store = new SqliteProjectSettingsStore(db)
  await store.seedDefaults([
    buildDefaultSettings('neutron'),
    buildDefaultSettings('acme'),
    buildDefaultSettings('northwind'),
  ])
  // Wire the create-project binding the same way the composer does: the
  // owner-scoped shared `createProjectRow` over the SAME ProjectDb (the
  // row-only half — no on-disk materialization in the reachability test).
  const surface = createAppProjectsSurface({
    store,
    auth,
    createProject: async ({ name }) => {
      const row = await createProjectRow({ owner_home: tmp, project_slug: OWNER, db }, { name })
      return { project_id: row.project_id, name: row.name, outcome: row.outcome }
    },
  })

  // Boot the production graph with the surface threaded through.
  // If a future CompositionInput field rename / removal drops
  // `app_projects_surface` from the typed shape, this construction
  // breaks at compile time BEFORE the runtime test runs.
  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_projects_surface: { handler: surface.handler },
  })

  // ISSUE #32 — serve `graph.fetch` directly. The composed handler is
  // built by `composeProductionGraph` itself from
  // `composition.app_projects_surface`, so the boot-wiring mapping IS
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
    tmp,
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

interface ListResponse {
  ok: boolean
  projects: ProjectSettings[]
  project_slug: string
}

interface SettingsResponse {
  ok: boolean
  project: ProjectSettings
  project_id: string
  project_slug: string
}

let harness: Harness
beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

test('production composer mounts GET /api/app/projects (list endpoint)', async () => {
  const res = await authedFetch(harness.base, '/api/app/projects')
  expect(res.status).toBe(200)
  const body = (await res.json()) as ListResponse
  expect(body.ok).toBe(true)
  expect(body.project_slug).toBe(OWNER)
  expect(Array.isArray(body.projects)).toBe(true)
  // seedDefaults populated the three default project shells.
  const ids = body.projects.map((p) => p.id).sort()
  expect(ids).toEqual(['acme', 'neutron', 'northwind'])
  // Generic default shells carry no members (R6 removed the demo seed).
  const neutron = body.projects.find((p) => p.id === 'neutron')
  expect(neutron).toBeDefined()
  expect(neutron!.members).toEqual([])
})

test('production composer mounts GET /api/app/projects/<id>/settings', async () => {
  const res = await authedFetch(harness.base, '/api/app/projects/neutron/settings')
  expect(res.status).toBe(200)
  const body = (await res.json()) as SettingsResponse
  expect(body.ok).toBe(true)
  expect(body.project.id).toBe('neutron')
  expect(body.project.privacy_mode).toBe('private')
})

test('production composer mounts PATCH /api/app/projects/<id>/settings + write survives store re-init', async () => {
  // PATCH through the HTTP chain — exercises the full
  // composition + surface + SQLite store.
  const patchRes = await authedFetch(
    harness.base,
    '/api/app/projects/neutron/settings',
    {
      method: 'PATCH',
      body: JSON.stringify({ privacy_mode: 'public' }),
    },
  )
  expect(patchRes.status).toBe(200)
  const patchBody = (await patchRes.json()) as SettingsResponse
  expect(patchBody.project.privacy_mode).toBe('public')

  // Re-init the store against the SAME DB and confirm the PATCH
  // landed in the on-disk row. This is the regression the in-memory
  // implementation hit (per ISSUES.md #9): the mutation evaporated on
  // store re-init / gateway restart. With the SQLite-backed store
  // this read MUST return 'public'.
  const freshStore = new SqliteProjectSettingsStore(harness.db)
  const reread = await freshStore.get(OWNER, 'neutron')
  expect(reread).not.toBeNull()
  expect(reread!.privacy_mode).toBe('public')
})

test('production composer mounts POST /api/app/projects (create) + new project survives store re-init', async () => {
  // POST through the full composition + surface + shared create path + SQLite.
  const res = await authedFetch(harness.base, '/api/app/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Test Project' }),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as {
    ok: boolean
    project: { id: string; label: string }
    created: boolean
  }
  expect(body.ok).toBe(true)
  expect(body.created).toBe(true)
  expect(body.project.id).toBe('test-project') // slugified name
  expect(body.project.label).toBe('Test Project')

  // Re-init the store against the SAME DB and confirm the new project row
  // persisted (mirrors the PATCH-survives-re-init guard). The create wrote a
  // real on-disk `projects` row, so a fresh store reads it back.
  const freshStore = new SqliteProjectSettingsStore(harness.db)
  const reread = await freshStore.get(OWNER, 'test-project')
  expect(reread).not.toBeNull()
  expect(reread!.name).toBe('Test Project')

  // …and it's visible in the list endpoint alongside the seeded shells.
  const listRes = await authedFetch(harness.base, '/api/app/projects')
  const listBody = (await listRes.json()) as ListResponse
  expect(listBody.projects.map((p) => p.id).sort()).toEqual([
    'acme',
    'neutron',
    'northwind',
    'test-project',
  ])
})

test('POST /api/app/projects requires a Bearer token (401 missing_bearer)', async () => {
  const res = await fetch(`${harness.base}/api/app/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Nope' }),
  })
  expect(res.status).toBe(401)
  const body = (await res.json()) as { ok: boolean; code: string }
  expect(body.ok).toBe(false)
  expect(body.code).toBe('missing_bearer')
})

test('list endpoint requires a Bearer token (401 missing_bearer)', async () => {
  const res = await fetch(`${harness.base}/api/app/projects`)
  expect(res.status).toBe(401)
  const body = (await res.json()) as { ok: boolean; code: string }
  expect(body.ok).toBe(false)
  expect(body.code).toBe('missing_bearer')
})

test('per-project settings route still 401s without a Bearer token', async () => {
  const res = await fetch(`${harness.base}/api/app/projects/neutron/settings`)
  expect(res.status).toBe(401)
  const body = (await res.json()) as { ok: boolean; code: string }
  expect(body.ok).toBe(false)
  expect(body.code).toBe('missing_bearer')
})
