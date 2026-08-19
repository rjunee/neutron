/**
 * TASKS TAB — the DONE-MEANS-SERVED test.
 *
 * Tasks was storable, agent-readable, and UNREACHABLE. `open/composer.ts` built
 * the tab resolver with neither `cores` nor `installations`, so Core tab
 * resolution short-circuited to `[]` and no client ever saw a Tasks tab.
 *
 * Two things make a narrower test worthless here:
 *
 *  1. Passing `cores` alone changes nothing — the resolver ALSO filtered on
 *     `surface === 'project_tab'` while every bundled UI Core declares
 *     `app_tab`. A test asserting "the composer passes cores" passes while the
 *     payload stays empty.
 *  2. The registry does not exist when the surface is constructed. It arrives
 *     via `on_cores_ready`, which only fires inside `composeProductionGraph`.
 *     A test that stops at `buildOpenGraphComposer(...)` never reaches the hook
 *     at all and reports a green, entirely fictional pass.
 *
 * So this boots the WHOLE stack — real composer, real production graph, real
 * HTTP server — and reads the payload a client actually fetches over the wire.
 * The only fake is the substrate (the model itself).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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

/** The descriptor wire shape, declared locally — this suite asserts on the JSON
 *  a client receives, so it deliberately does not import the engine's type. */
interface TabDescriptor {
  key: string
  label: string
  scope: string
  source: string
  core_slug?: string
  order: number
  mount: { kind: string; target: string }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const PROJECT_ID = 'proj-1'

let home: IsolatedHome

interface Harness {
  base: string
  close(): Promise<void>
}

function stubSubstrate(): Substrate {
  return {
    start(): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'tasks-tab-served',
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
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-tasks-tab-served',
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

async function boot(): Promise<Harness> {
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: (() => stubSubstrate()) as never,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('no fetch/ws')
  }
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => graph.fetch!(req, srv),
    websocket: graph.websocket,
  })
  const h: Harness = {
    base: `http://127.0.0.1:${server.port}`,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
      }
      await graph.shutdown()
      try {
        db.close()
      } catch {
        /* already closed */
      }
    },
  }
  openHarnesses.push(h)
  return h
}

interface TabsBody {
  ok: boolean
  scope: string
  project_id?: string
  tabs: TabDescriptor[]
}

async function tabs(base: string, path: string): Promise<TabsBody> {
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: 'Bearer owner' },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as TabsBody
}

describe('Tasks tab — served end-to-end through a real Open boot', () => {
  test('the Apps launcher survives the engine-resolved set', async () => {
    const h = await boot()
    const body = await tabs(h.base, `/api/app/projects/${PROJECT_ID}/tabs`)
    expect(body.ok).toBe(true)
    const keys = body.tabs.map((t) => t.key)
    expect(keys).toContain('chat')
    // The launcher is the only route to several Core screens on mobile, and the
    // engine-resolved set used to drop it — it survived only as a pre-fetch
    // placeholder that vanished the moment `/tabs` resolved.
    expect(keys).toContain('launcher')
  })

  /**
   * The load-bearing assertion. A `source: 'core'` descriptor can only appear
   * if BOTH halves of the fix are live in the real composition: the late-bound
   * registry arrived through `on_cores_ready` (otherwise Core resolution is
   * skipped entirely) AND the resolver read an `app_tab` manifest.
   */
  test('an installed app_tab Core contributes a real, navigable Tasks tab', async () => {
    const h = await boot()
    const body = await tabs(h.base, `/api/app/projects/${PROJECT_ID}/tabs`)

    const tasksTab = body.tabs.find((t) => t.core_slug === 'tasks_core')
    expect(tasksTab).toBeDefined()
    expect(tasksTab!.source).toBe('core')
    expect(tasksTab!.label).toBe('Tasks')
    // A CLIENT ROUTE, `<project_id>` substituted — never the manifest's
    // `entry_point`, which is a TypeScript source file inside the Core package.
    expect(tasksTab!.mount).toEqual({
      kind: 'app_route',
      target: `/projects/${PROJECT_ID}/tasks`,
    })
  })

  test('every Core-contributed app_route target is a client path, not a source file', async () => {
    const h = await boot()
    const body = await tabs(h.base, `/api/app/projects/${PROJECT_ID}/tabs`)
    const appRoutes = body.tabs.filter((t) => t.mount.kind === 'app_route')
    expect(appRoutes.length).toBeGreaterThan(0)
    for (const tab of appRoutes) {
      expect(tab.core_slug).toBeDefined()
      expect(tab.mount.target.startsWith(`/projects/${PROJECT_ID}/`)).toBe(true)
      expect(tab.mount.target).not.toContain('<project_id>')
      expect(tab.mount.target).not.toContain('./src/')
      expect(tab.mount.target.endsWith('.ts')).toBe(false)
    }
  })

  test('the Tasks tab target resolves to a live tasks backend, not a 404', async () => {
    const h = await boot()
    const body = await tabs(h.base, `/api/app/projects/${PROJECT_ID}/tabs`)
    const tasksTab = body.tabs.find((t) => t.core_slug === 'tasks_core')
    expect(tasksTab).toBeDefined()

    // The tab is only worth seating if the data behind it answers. Hit the same
    // surface both clients call when the tab opens.
    const res = await fetch(
      `${h.base}/api/app/projects/${PROJECT_ID}/tasks?status=open&order=focus_score`,
      { headers: { authorization: 'Bearer owner' } },
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { ok: boolean; tasks: unknown[] }
    expect(payload.ok).toBe(true)
    expect(Array.isArray(payload.tasks)).toBe(true)
  })

  test('per-project Core tabs never leak into the global scope', async () => {
    const h = await boot()
    const body = await tabs(h.base, '/api/app/tabs')
    expect(body.scope).toBe('global')
    expect(body.tabs.every((t) => t.scope === 'global')).toBe(true)
  })
})
