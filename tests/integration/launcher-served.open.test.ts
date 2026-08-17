/**
 * THE APPS LAUNCHER — served by the REAL composer, and remembering across a restart.
 *
 * WHAT WAS BROKEN. `createAppLauncherSurface` (`gateway/http/app-launcher-surface.ts:49`)
 * had no non-test call site anywhere, so all four `/api/app/projects/<id>/launcher*`
 * routes 404'd in every install — while the Apps tab is a shipped builtin
 * (`tabs/registry.ts:109-114`), `app_tabs_surface` IS served, and the screen
 * behind it ships complete (a grid, a rename modal, drag-reorder, and a client
 * calling all four routes at `app/lib/launcher-client.ts:79,89,97,109`). Tapping
 * Apps reached a screen where everything failed. ISSUES #447.
 *
 * WHY THE EXISTING GUARD DID NOT CATCH IT — and this is the part worth keeping.
 * `gateway/__tests__/launcher-production-composer.test.ts` was written precisely
 * as the reachability guard for this surface. Its header states that if a future
 * refactor "drops one of those surfaces from `composeHttpHandler`'s chain, this
 * test fails". It never did, and it was green the entire time the feature 404'd,
 * because it CONSTRUCTS the surface itself and passes it in:
 *
 *     const launcherSurface = createAppLauncherSurface({ store, auth })
 *     await composeProductionGraph({ ..., app_launcher_surface: {...} })
 *
 * That proves the chain mounts the surface WHEN GIVEN ONE. It cannot notice that
 * nothing gives it one, because the test is the thing giving it one. It asserts
 * against a hand-built config literal rather than against what the product
 * actually composes — the exact pattern SPEC.md § Decisions Log 2026-08-01 bans,
 * and the seventh instance of this defect shape in this repo.
 *
 * So this suite boots `buildOpenGraphComposer` — the real Open composer, the one
 * a real install runs — and asks it what it produced. Nothing here supplies the
 * surface.
 *
 * THE PERSISTENCE HALF. Mounting alone was not enough to be worth shipping. The
 * only store implementation was in-memory, and mounting against it would have
 * traded a 404 for something worse: a rename or a drag-reorder that silently
 * forgets itself on the next gateway restart. A 404 is at least honest about
 * being broken. So the second half of this suite renames a tile, throws the
 * whole server and composition away, boots a SECOND composer over the same
 * database, and asserts the new name is still there. That is the assertion the
 * in-memory store cannot pass, which is what makes it evidence for the SQLite
 * store rather than decoration.
 *
 * MUTATION TESTS (each verified by making the change and re-running):
 *   - delete `app_launcher_surface` from the composition object in
 *     `open/composer.ts` → "the real composer supplies it" + all four route
 *     tests red.
 *   - swap `SqliteProjectLauncherStore` for `InMemoryProjectLauncherStore` in
 *     `open/composer.ts` → the restart test reds, everything else stays green.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { seedMigratedDb } from '../support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const PROJECT_ID = 'proj-launcher'
const OWNER_BEARER = 'owner'

type OpenComposition = Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>

let home: IsolatedHome

interface Harness {
  base: string
  /** What the REAL Open composer returned. */
  composition: OpenComposition
  close(): Promise<void>
}

function stubSubstrate(): Substrate {
  return {
    start(): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'launcher-served',
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

beforeEach(() => {
  home = createIsolatedHome({
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NOTIFY_SOCKET',
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-launcher-served',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
    },
  })
})

const openHarnesses: Harness[] = []
afterEach(async () => {
  while (openHarnesses.length > 0) {
    const h = openHarnesses.pop()!
    await h.close()
  }
  home.restore()
})

/** Boot the REAL Open composer against the isolated home's database. Called
 *  twice by the restart test, over the SAME file, to simulate a gateway
 *  restart. */
async function boot(): Promise<Harness> {
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: (() => stubSubstrate()) as never,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  // Narrow BOTH before Bun.serve: `exactOptionalPropertyTypes` makes passing an
  // explicit `undefined` to an optional prop an error, so `websocket` has to be a
  // value, not `X | undefined`.
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('composer produced no fetch/websocket')
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })
  const h: Harness = {
    base: `http://127.0.0.1:${server.port}`,
    composition,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      db.close()
    },
  }
  openHarnesses.push(h)
  return h
}

function authed(path: string, init: RequestInit = {}): RequestInit & { path: string } {
  return {
    ...init,
    path,
    headers: { authorization: `Bearer ${OWNER_BEARER}`, 'content-type': 'application/json' },
  }
}

async function call(h: Harness, path: string, init: RequestInit = {}): Promise<Response> {
  const { path: p, ...rest } = authed(path, init)
  return fetch(`${h.base}${p}`, rest)
}

/** One tile as the surface returns it. Declared locally — this suite asserts on
 *  the JSON a client receives, so it deliberately does not import the engine type. */
interface WireEntry {
  slug: string
  display_name: string
}

/** The surface returns the ordered list; tolerate either an `{entries}` envelope
 *  or a bare array so the assertion is about persistence, not payload shape. */
async function readEntries(h: Harness, path: string): Promise<WireEntry[]> {
  const body = (await (await call(h, path)).json()) as WireEntry[] | { entries: WireEntry[] }
  return Array.isArray(body) ? body : body.entries
}

test('the REAL Open composer supplies app_launcher_surface', async () => {
  const h = await boot()
  // The whole defect in one assertion: the field was declared
  // (`gateway/composition/input/app-surfaces-input.ts:88`) and consumed, and no
  // composer ever set it.
  expect(h.composition.app_launcher_surface).toBeDefined()
}, 30_000)

test('all four launcher routes answer — none 404', async () => {
  const h = await boot()
  const base = `/api/app/projects/${PROJECT_ID}/launcher`

  const list = await call(h, base)
  expect(list.status).toBe(200)

  const reorder = await call(h, `${base}/reorder`, {
    method: 'POST',
    body: JSON.stringify({ slug: 'tasks_core', new_index: 1 }),
  })
  expect(reorder.status).toBe(200)

  const rename = await call(h, `${base}/rename`, {
    method: 'POST',
    body: JSON.stringify({ slug: 'tasks_core', display_name: 'To-Do' }),
  })
  expect(rename.status).toBe(200)

  const uninstall = await call(h, `${base}/uninstall`, {
    method: 'POST',
    body: JSON.stringify({ slug: 'reminders' }),
  })
  expect(uninstall.status).toBe(200)

  // A path this surface does not own must still fall through to the chain's
  // 404 — the control that makes the four 200s above mean something rather
  // than proving a catch-all answers everything.
  const invented = await call(h, `/api/app/projects/${PROJECT_ID}/launcher-not-a-route`)
  expect(invented.status).toBe(404)
}, 30_000)

test('a rename survives a restart — the store is durable, not process-local', async () => {
  const first = await boot()
  const base = `/api/app/projects/${PROJECT_ID}/launcher`

  const before = await readEntries(first, base)
  const target = before[0]
  // A real guard, not `expect(...).toBeDefined()`: that asserts but does not
  // NARROW, and an empty grid should fail with a sentence rather than a
  // downstream `undefined.slug`.
  if (target === undefined) throw new Error('launcher returned no tiles to rename')

  const renamed = await call(first, `${base}/rename`, {
    method: 'POST',
    body: JSON.stringify({ slug: target.slug, display_name: 'Renamed By Owner' }),
  })
  expect(renamed.status).toBe(200)

  // Throw the entire server + composition away. Anything held only in process
  // memory is gone at this point.
  const dead = openHarnesses.pop()!
  await dead.close()

  const second = await boot()
  const after = await readEntries(second, base)
  const found = after.find((e) => e.slug === target.slug)
  expect(found?.display_name).toBe('Renamed By Owner')
  // Two full composer boots in one test.
}, 60_000)
