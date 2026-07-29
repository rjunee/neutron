/**
 * Admin-personality surface — production-composer reachability guard
 * (2026-05-22).
 *
 * Mirrors `reminders-production-composer.test.ts`. The point of this
 * test is the anti-pattern Argus has caught five sprints in a row: a
 * surface is built + unit-tested, but the production composer doesn't
 * mount it, so every prod request 404s. This guard boots
 * `composeProductionGraph` against an in-memory project DB, threads
 * `app_persona_surface` through the CompositionInput, composes the HTTP
 * chain via the SAME `composeHttpHandler` the prod gateway uses, and
 * fires HTTP requests at every /api/app/persona/* route.
 *
 * If a future CompositionInput rename / removal drops
 * `app_persona_surface` from the typed shape, this construction breaks
 * at compile time BEFORE the runtime test runs.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '../composition.ts'
import { createAdminPersonalitySurface } from '../http/admin-personality-surface.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const OWNER = 'admin-persona-composer-project'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  owner_home: string
  reloadCalls: string[]
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
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-admin-persona-composer-'))
  const owner_home = join(tmp, 'owner_home')
  mkdirSync(join(owner_home, 'persona'), { recursive: true })
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const reloadCalls: string[] = []
  const personaSurface = createAdminPersonalitySurface({
    auth,
    owner_home,
    project_slug: OWNER,
    onReload: (name): void => {
      reloadCalls.push(name)
    },
  })

  // Thread through the production composer — if a future
  // CompositionInput rename drops `app_persona_surface`, this construction
  // breaks at compile time BEFORE the runtime test runs.
  //
  // ISSUE #32 — we now serve `graph.fetch` directly. The composed
  // handler is built by `composeProductionGraph` itself from the
  // `app_xxx_surface` fields, so deleting a mapping line in
  // `gateway/composition.ts:buildComposedHttpFromComposition` provably
  // breaks every reachability test (the closing condition).
  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_persona_surface: { handler: personaSurface.handler },
  })
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
    owner_home,
    reloadCalls,
    close: async (): Promise<void> => {
      await server.stop(true)
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function authedFetch(base: string, path: string, init: RequestInit = {}): Promise<Response> {
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

test('production composer mounts GET /api/app/persona/files', async () => {
  const res = await authedFetch(h.base, '/api/app/persona/files')
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    files: Array<{ filename: string; exists: boolean }>
  }
  expect(body.ok).toBe(true)
  expect(body.files).toHaveLength(3)
  expect(body.files.map((f) => f.filename).sort()).toEqual(
    ['SOUL.md', 'USER.md', 'priority-map.md'].sort(),
  )
})

test('production composer mounts GET /api/app/persona/file', async () => {
  writeFileSync(join(h.owner_home, 'persona', 'SOUL.md'), '# hello\n', 'utf8')
  const res = await authedFetch(h.base, '/api/app/persona/file?name=SOUL.md')
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('# hello\n')
  expect(Number(res.headers.get('x-mtime'))).toBeGreaterThan(0)
})

test('production composer mounts PATCH /api/app/persona/file', async () => {
  const res = await authedFetch(h.base, '/api/app/persona/file?name=USER.md', {
    method: 'PATCH',
    body: JSON.stringify({ content: 'name: sam\n', expected_mtime: 0 }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; mtime: number }
  expect(body.ok).toBe(true)
  expect(body.mtime).toBeGreaterThan(0)
  expect(readFileSync(join(h.owner_home, 'persona', 'USER.md'), 'utf8')).toBe('name: sam\n')
  expect(h.reloadCalls).toContain('USER.md')
})

test('production composer mounts POST /api/app/persona/restart-from-scratch', async () => {
  writeFileSync(join(h.owner_home, 'persona', 'SOUL.md'), 'x', 'utf8')
  writeFileSync(join(h.owner_home, 'persona', 'USER.md'), 'y', 'utf8')
  const res = await authedFetch(h.base, '/api/app/persona/restart-from-scratch', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    files_deleted: string[]
    onboarding_reset: boolean
  }
  expect(body.ok).toBe(true)
  expect(body.files_deleted.sort()).toEqual(['SOUL.md', 'USER.md'].sort())
  expect(body.onboarding_reset).toBe(false)
  expect(existsSync(join(h.owner_home, 'persona', 'SOUL.md'))).toBe(false)
})

test('every persona route requires a Bearer token (401 missing_bearer)', async () => {
  const paths: ReadonlyArray<[string, string, object | null]> = [
    ['/api/app/persona/files', 'GET', null],
    ['/api/app/persona/file?name=SOUL.md', 'GET', null],
    [
      '/api/app/persona/file?name=SOUL.md',
      'PATCH',
      { content: 'x', expected_mtime: 0 },
    ],
    ['/api/app/persona/restart-from-scratch', 'POST', { confirm: true }],
  ]
  for (const [path, method, body] of paths) {
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json' },
    }
    if (body !== null) init.body = JSON.stringify(body)
    const res = await fetch(`${h.base}${path}`, init)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  }
})
