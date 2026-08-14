/**
 * Production-composer reachability guard for the per-project credentials
 * surface (Settings-tab credential system, FOUNDATION).
 *
 * Same anti-pattern guard the projects / focus / reminders composer tests
 * enforce: a future refactor that drops `app_project_credentials_surface` from
 * `composeProductionGraph` / `composeHttpHandler` MUST fail this test. It boots
 * the REAL production graph with the surface threaded through and drives the
 * full HTTP chain → surface → ProjectCredentialStore → SQLite, asserting:
 *
 *   1. POST /api/app/projects/<id>/credentials       (set, project scope)
 *   2. GET  /api/app/projects/<id>/credentials       (list, metadata only)
 *   3. DELETE /api/app/projects/<id>/credentials/<s> (delete + 404)
 *   4. per-project scope isolation (project A's token absent from project B)
 *   5. 401 missing_bearer when unauthenticated
 *   6. the GLOBAL family — POST/GET/DELETE /api/app/credentials — is reachable
 *      through the SAME rung, and is the only route that reaches global state
 *      (ISSUES #486). A project route asking for global scope is a 400 here in
 *      the real chain, not just in the surface unit test.
 *
 * Mirrors `gateway/__tests__/projects-production-composer.test.ts`.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { composeProductionGraph } from '../composition.ts'
import { createProjectCredentialsSurface } from '../http/project-credentials-surface.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { ProjectAccountSelectionStore } from '@neutronai/project-credentials/account-selection-store.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const OWNER = 'creds-composer-owner'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  tmp: string
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
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-creds-composer-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const crypto = new SecretsStore({ data_dir: tmp, db })
  const store = new ProjectCredentialStore(db, { crypto })
  const surface = createProjectCredentialsSurface({
    store,
    auth,
    accountSelection: new ProjectAccountSelectionStore(db),
    credentialResolver: { accountSelectionView: async () => [] },
  })

  // Boot the production graph with the surface threaded through. A future
  // CompositionInput rename/removal that drops `app_project_credentials_surface`
  // breaks this construction at COMPILE time before the runtime test runs.
  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_project_credentials_surface: { handler: surface.handler },
  })

  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error(
      'composeProductionGraph did not expose graph.fetch — credentials reachability gap',
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
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function authedFetch(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', 'Bearer dev:test-user')
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

let h: Harness

beforeEach(async () => {
  h = await startHarness()
})

afterEach(async () => {
  await h.close()
})

test('POST + GET — a project-scoped credential persists and lists (metadata only)', async () => {
  const post = await authedFetch(h.base, '/api/app/projects/proj-a/credentials', {
    method: 'POST',
    body: JSON.stringify({ service: 'meta_ads', token: 'tok_A_credential_16', label: 'prod' }),
  })
  expect(post.status).toBe(201)
  const created = (await post.json()) as { ok: boolean; credential: { service: string; scope: string } }
  expect(created.ok).toBe(true)
  expect(created.credential.service).toBe('meta_ads')
  expect(created.credential.scope).toBe('project')
  // No token value ever leaves the store.
  expect(JSON.stringify(created)).not.toContain('tok_A')

  const get = await authedFetch(h.base, '/api/app/projects/proj-a/credentials')
  expect(get.status).toBe(200)
  const listed = (await get.json()) as {
    ok: boolean
    project: Array<{ service: string }>
    global: Array<{ service: string }>
  }
  expect(listed.project.map((r) => r.service)).toEqual(['meta_ads'])
  expect(listed.global).toEqual([])
  expect(JSON.stringify(listed)).not.toContain('tok_A')
})

test('a global credential written on the GLOBAL route is inherited by any project', async () => {
  const post = await authedFetch(h.base, '/api/app/credentials', {
    method: 'POST',
    body: JSON.stringify({ service: 'google_ads', token: 'tok_G_credential_16' }),
  })
  expect(post.status).toBe(201)
  const get = await authedFetch(h.base, '/api/app/projects/proj-b/credentials')
  const listed = (await get.json()) as {
    project: Array<{ service: string }>
    global: Array<{ service: string }>
  }
  expect(listed.project).toEqual([])
  expect(listed.global.map((r) => r.service)).toEqual(['google_ads'])
})

test('the GLOBAL route lists + deletes what it wrote, through the real chain', async () => {
  await authedFetch(h.base, '/api/app/credentials', {
    method: 'POST',
    body: JSON.stringify({ service: 'tavily', token: 'tok_T_credential_16', label: 'shared' }),
  })
  const list = await authedFetch(h.base, '/api/app/credentials')
  const body = (await list.json()) as { global: Array<{ service: string; scope: string }> }
  expect(body.global.map((r) => r.service)).toEqual(['tavily'])
  expect(body.global[0]!.scope).toBe('global')
  // Metadata only — the secret never comes back out.
  expect(JSON.stringify(body)).not.toContain('tok_T')

  const del = await authedFetch(h.base, '/api/app/credentials/tavily', { method: 'DELETE' })
  expect(del.status).toBe(200)
  const after = await authedFetch(h.base, '/api/app/credentials')
  expect(((await after.json()) as { global: unknown[] }).global).toEqual([])
})

test('a PROJECT route cannot write global state, and nothing lands when it tries', async () => {
  const res = await authedFetch(h.base, '/api/app/projects/proj-a/credentials', {
    method: 'POST',
    body: JSON.stringify({ service: 'stripe', token: 'tok_S_credential_16', scope: 'global' }),
  })
  expect(res.status).toBe(400)
  expect(((await res.json()) as { code: string }).code).toBe('scope_not_allowed')
  // Neither scope took the write — not the global default it asked for, and not
  // a project row silently substituted for it.
  const globals = await authedFetch(h.base, '/api/app/credentials')
  expect(((await globals.json()) as { global: Array<{ service: string }> }).global
    .map((r) => r.service)).not.toContain('stripe')
  const proj = await authedFetch(h.base, '/api/app/projects/proj-a/credentials')
  expect(((await proj.json()) as { project: Array<{ service: string }> }).project
    .map((r) => r.service)).not.toContain('stripe')
})

test('a PROJECT route cannot delete a global default with ?scope=global', async () => {
  await authedFetch(h.base, '/api/app/credentials', {
    method: 'POST',
    body: JSON.stringify({ service: 'shared_del', token: 'tok_X_credential_16' }),
  })
  const res = await authedFetch(
    h.base,
    '/api/app/projects/proj-a/credentials/shared_del?scope=global',
    { method: 'DELETE' },
  )
  expect(res.status).toBe(400)
  const still = await authedFetch(h.base, '/api/app/credentials')
  expect(((await still.json()) as { global: Array<{ service: string }> }).global
    .map((r) => r.service)).toContain('shared_del')
})

test('per-project scope isolation — project A token is absent from project B', async () => {
  await authedFetch(h.base, '/api/app/projects/proj-a/credentials', {
    method: 'POST',
    body: JSON.stringify({ service: 'meta_ads', token: 'A_credential_value_16' }),
  })
  const getB = await authedFetch(h.base, '/api/app/projects/proj-b/credentials')
  const listed = (await getB.json()) as { project: Array<{ service: string }> }
  expect(listed.project).toEqual([])
})

test('DELETE removes a credential and 404s on re-delete', async () => {
  await authedFetch(h.base, '/api/app/projects/proj-a/credentials', {
    method: 'POST',
    body: JSON.stringify({ service: 'apify', token: 'apify_credential_16' }),
  })
  const del = await authedFetch(h.base, '/api/app/projects/proj-a/credentials/apify', {
    method: 'DELETE',
  })
  expect(del.status).toBe(200)
  const del2 = await authedFetch(h.base, '/api/app/projects/proj-a/credentials/apify', {
    method: 'DELETE',
  })
  expect(del2.status).toBe(404)
})

test('validation error → 400 with an envelope', async () => {
  const res = await authedFetch(h.base, '/api/app/projects/proj-a/credentials', {
    method: 'POST',
    body: JSON.stringify({ service: '', token: 't' }),
  })
  expect(res.status).toBe(400)
  const body = (await res.json()) as { ok: boolean; code: string }
  expect(body.ok).toBe(false)
  expect(body.code).toBe('invalid_service')
})

test('unauthenticated → 401 missing_bearer', async () => {
  const res = await fetch(`${h.base}/api/app/projects/proj-a/credentials`)
  expect(res.status).toBe(401)
  const body = (await res.json()) as { code: string }
  expect(body.code).toBe('missing_bearer')
})
