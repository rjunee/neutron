/**
 * P5.3 — production-composer reachability guard for the launcher
 * surface + the build-me chat-send route.
 *
 * What this test guards (the anti-pattern Argus has caught three
 * sprints in a row: chat-send HTTP fallback unreachable from
 * `composeProductionGraph` (PR #222); projects-client method
 * unexercised end-to-end (PR #225); pre-PR #222 chat-bridge wiring
 * gap). The launcher's "Build me…" path lands in P5.3 as the typed
 * `LauncherClient.sendBuildMePrompt` so that the SAME composer chain
 * the production gateway uses can be asserted end-to-end:
 *
 *   1. Boot `composeProductionGraph` against an in-memory SQLite +
 *      a dev-bypass `AppWsAuthResolver`.
 *   2. Construct the launcher surface (`createAppLauncherSurface`)
 *      + the app-ws surface (`createAppWsSurface`) the same way
 *      `gateway/index.ts` does at boot.
 *   3. Compose them via the production `composeHttpHandler` chain
 *      (NOT a hand-rolled router — the point is to assert the
 *      production composition + chain mounts every launcher route +
 *      the chat-send route).
 *   4. Fire HTTP requests at the four launcher routes AND at the
 *      chat-send route. Assert 200s with the canonical envelope
 *      shape on each.
 *
 * Mirrors the structure of
 * `gateway/__tests__/composition-onboarding-telemetry.test.ts` +
 * `gateway/__tests__/composition-tasks-projection-wiring.test.ts`.
 *
 * If a future refactor accidentally removes any launcher route from
 * `app-launcher-surface.ts` OR removes the chat-send POST from
 * `app-ws-surface.ts` OR drops one of those surfaces from
 * `composeHttpHandler`'s chain, this test fails. The brief calls
 * this out as a MANDATORY gate (§ 5.5 + § 6.3).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AppWsAdapter,
  InMemoryAppWsSessionRegistry,
  createAppWsAuthResolver,
} from '../../channels/index.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../composition.ts'
import { createAppLauncherSurface } from '../http/app-launcher-surface.ts'
import { createAppWsSurface } from '../http/app-ws-surface.ts'
import {
  DEFAULT_LAUNCHER_SEED,
  InMemoryProjectLauncherStore,
  type LauncherEntry,
} from '../http/project-launcher-store.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const OWNER = 'launcher-composer-project'
const PROJECT = 'demo-project'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  store: InMemoryProjectLauncherStore
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
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-launcher-composer-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  // Build the surface pieces FIRST so we can hand them to
  // `composeProductionGraph` via `app_launcher_surface` +
  // `app_ws_surface`. Mirrors gateway/index.ts:2669-2742.
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const store = new InMemoryProjectLauncherStore({ seed: DEFAULT_LAUNCHER_SEED })
  const launcherSurface = createAppLauncherSurface({ store, auth })
  const registry = new InMemoryAppWsSessionRegistry()
  // We DO NOT need a real receiver — the chat-send 200-success path
  // only requires `adapter.dispatchInbound` to not throw. A no-op
  // receiver suffices.
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async () => {} },
  })
  const wsSurface = createAppWsSurface({ adapter, registry, auth, project_slug: OWNER })

  // Boot the production graph with both surfaces threaded through —
  // this is the contract the boot shell honors. If a future
  // CompositionInput field rename / removal drops `app_launcher_surface`
  // or `app_ws_surface` from the typed shape, this construction
  // breaks at compile time (TS error) BEFORE the runtime test runs.
  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_launcher_surface: { handler: launcherSurface.handler },
    app_ws_surface: {
      handler: wsSurface.handler,
      websocket: wsSurface.websocket,
    },
  })

  // ISSUE #32 — serve `graph.fetch` directly so the production
  // composer's
  // `composition.app_xxx_surface → composeInput.appXxx` mapping is the
  // only path exercised. Deleting any mapping line in
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

let harness: Harness
beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

test('production composer mounts GET /api/app/projects/<id>/launcher', async () => {
  const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT}/launcher`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    entries: LauncherEntry[]
    project_id: string
  }
  expect(body.ok).toBe(true)
  expect(body.project_id).toBe(PROJECT)
  expect(Array.isArray(body.entries)).toBe(true)
  // The default seed (notes + tasks_core + reminders) lands on a
  // fresh (instance, project) pair.
  expect(body.entries.map((e) => e.slug)).toEqual([
    'notes',
    'tasks_core',
    'reminders',
  ])
})

test('production composer mounts POST /api/app/projects/<id>/launcher/reorder', async () => {
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/launcher/reorder`,
    {
      method: 'POST',
      body: JSON.stringify({ slug: 'notes', new_index: 2 }),
    },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; entries: LauncherEntry[] }
  expect(body.ok).toBe(true)
  // After reorder, `notes` should be at index 2; the other entries
  // compact to [0, 1].
  const notesEntry = body.entries.find((e) => e.slug === 'notes')
  expect(notesEntry?.reorder_index).toBe(2)
})

test('production composer mounts POST /api/app/projects/<id>/launcher/uninstall', async () => {
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/launcher/uninstall`,
    {
      method: 'POST',
      body: JSON.stringify({ slug: 'notes' }),
    },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; entries: LauncherEntry[] }
  expect(body.ok).toBe(true)
  expect(body.entries.find((e) => e.slug === 'notes')).toBeUndefined()
})

test('production composer mounts POST /api/app/projects/<id>/launcher/rename', async () => {
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/launcher/rename`,
    {
      method: 'POST',
      body: JSON.stringify({ slug: 'notes', display_name: 'My Notes' }),
    },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; entries: LauncherEntry[] }
  expect(body.ok).toBe(true)
  const notes = body.entries.find((e) => e.slug === 'notes')
  expect(notes?.display_name).toBe('My Notes')
})

test('production composer mounts POST /api/app/chat/send (build-me path)', async () => {
  // This is the regression closure for the brief's anti-pattern: the
  // build-me "Build me a Core that…" prompt must round-trip through
  // the SAME production composer chain. The LauncherClient method
  // `sendBuildMePrompt` POSTs exactly this shape; if the chat-send
  // route is ever dropped from the chain, this fails.
  const res = await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: 'Build me a Core that tracks my running mileage',
      project_id: PROJECT,
      client_msg_id: 'c-build-me-1',
    }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    message_id: string
    echo?: { body: string; client_msg_id?: string }
  }
  expect(body.ok).toBe(true)
  expect(typeof body.message_id).toBe('string')
})

test('every launcher route requires a Bearer token (401 missing_bearer)', async () => {
  const paths: ReadonlyArray<[string, string, object | null]> = [
    [`/api/app/projects/${PROJECT}/launcher`, 'GET', null],
    [`/api/app/projects/${PROJECT}/launcher/reorder`, 'POST', { slug: 'notes', new_index: 1 }],
    [`/api/app/projects/${PROJECT}/launcher/uninstall`, 'POST', { slug: 'notes' }],
    [`/api/app/projects/${PROJECT}/launcher/rename`, 'POST', { slug: 'notes', display_name: 'X' }],
  ]
  for (const [path, method, body] of paths) {
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json' },
    }
    if (body !== null) init.body = JSON.stringify(body)
    const res = await fetch(`${harness.base}${path}`, init)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  }
})

test('unknown launcher action returns 405 method_not_allowed', async () => {
  const res = await authedFetch(
    harness.base,
    `/api/app/projects/${PROJECT}/launcher/bogus`,
    { method: 'POST', body: JSON.stringify({}) },
  )
  expect(res.status).toBe(405)
  const json = (await res.json()) as { ok: boolean; code: string }
  expect(json.code).toBe('method_not_allowed')
})

/**
 * ISSUE #17 closure — long_press_menu propagates end-to-end through
 * the production composer chain.
 *
 * Tasks Core declares a 3-entry long_press_menu at
 * `cores/free/tasks/src/ui/launcher-icon.ts` (capture / browse /
 * pick_next). Reminders Core declares a 3-entry long_press_menu at
 * `cores/free/reminders/src/ui/launcher-icon.ts` (capture / browse /
 * smart_capture). Both Cores ALSO declare `primary_action:
 * 'open_app_tab'` + an `app_tab_path` pointing to their project tab.
 *
 * The pipeline this test guards:
 *   LAUNCHER_ICON module (Core source)
 *     → install-bundled.ts:resolveLauncherIconMeta (manifest read)
 *     → CoresModuleState.launcherIcons (in-process map)
 *     → deriveLauncherSeedFromBundledCores (seed shape)
 *     → InMemoryProjectLauncherStore (cloned through snapshot)
 *     → app-launcher-surface.ts JSON body (HTTP wire)
 *
 * If any layer strips the new fields, this fails. The test seeds the
 * store directly with the EXPECTED manifest payload (the production
 * composer's bundled-Cores discovery requires real per-project DB
 * setup that's out of scope here), then asserts the GET round-trips
 * the full long_press_menu list. The seed-side of the pipeline is
 * covered by `gateway/__tests__/project-launcher-seed.test.ts`
 * ('propagates long_press_menu + primary_action + app_tab_path').
 */
test('Tasks Core + Reminders Core surface 3-entry long_press_menu lists end-to-end', async () => {
  // Seed the production-composed launcher store with the EXACT
  // manifest payload Tasks Core + Reminders Core declare at their
  // `LAUNCHER_ICON` modules. This is the post-derivation shape the
  // launcher tile would land with at production boot. The
  // `project_slug` key the auth resolver hands the store is the
  // dev-bypass slug constant (the bearer's `project_slug` field).
  harness.store.seedFor(OWNER, PROJECT, [
    {
      slug: 'tasks_core',
      display_name: 'Tasks',
      launcher_icon: { kind: 'emoji', value: '✅' },
      primary_action: 'open_app_tab',
      app_tab_path: '/projects/<project_id>/tasks',
      long_press_menu: [
        { id: 'capture', label: 'Capture a task', action: 'chat_send_prefix', prefix: '/task ' },
        { id: 'browse', label: 'Open task list', action: 'open_app_tab' },
        { id: 'pick_next', label: 'What should I focus on?', action: 'chat_send', text: '/task focus' },
      ],
    },
    {
      slug: 'reminders_core',
      display_name: 'Reminders',
      launcher_icon: { kind: 'emoji', value: '⏰' },
      primary_action: 'open_app_tab',
      app_tab_path: '/projects/<project_id>/reminders',
      long_press_menu: [
        { id: 'capture', label: 'Schedule a reminder', action: 'chat_send_prefix', prefix: '/remind ' },
        { id: 'browse', label: 'Open reminders list', action: 'open_app_tab' },
        { id: 'smart_capture', label: 'Smart reminder (with context)', action: 'chat_send_prefix', prefix: '/remind smart ' },
      ],
    },
  ])

  const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT}/launcher`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    entries: LauncherEntry[]
  }
  const tasks = body.entries.find((e) => e.slug === 'tasks_core')
  expect(tasks).toBeDefined()
  expect(tasks?.primary_action).toBe('open_app_tab')
  expect(tasks?.app_tab_path).toBe('/projects/<project_id>/tasks')
  expect(tasks?.long_press_menu).toHaveLength(3)
  expect(tasks?.long_press_menu?.map((m) => m.id)).toEqual([
    'capture',
    'browse',
    'pick_next',
  ])

  const reminders = body.entries.find((e) => e.slug === 'reminders_core')
  expect(reminders).toBeDefined()
  expect(reminders?.primary_action).toBe('open_app_tab')
  expect(reminders?.app_tab_path).toBe('/projects/<project_id>/reminders')
  expect(reminders?.long_press_menu).toHaveLength(3)
  expect(reminders?.long_press_menu?.map((m) => m.id)).toEqual([
    'capture',
    'browse',
    'smart_capture',
  ])
})
