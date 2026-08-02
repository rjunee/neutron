/**
 * FOUR APP SURFACES — reachable through the real router, not merely composed.
 *
 * `route-slot-coverage.test.ts` asks whether the composed graph CARRIES a
 * slot's `CompositionInput` field. That is a necessary condition and not a
 * sufficient one: a field can be populated while the ladder never dispatches to
 * it, because an earlier rung claims the path (that is exactly the live
 * `app_backups_surface` defect — `/restore` is claimed by the served
 * `appProjects` rung, so the restore button silently un-archives the project).
 * So this file asks the other half of the question and drives real HTTP through
 * the composed `graph.fetch` — the ONE path that maps
 * `composition.app_xxx_surface` onto a route (`gateway/composition.ts`
 * `buildComposedHttpFromComposition`, the ISSUE #32 seam).
 *
 * The four surfaces here were all declared, all had a shipped client calling
 * them, and none were ever handed to the graph:
 *
 *   - `/api/app/devices/{register,unregister}` — `app/lib/push.ts:143,177` calls
 *     these on every sign-in and sign-out. No device could register at all.
 *   - `/api/app/projects/<id>/reminders[…]`    — `app/lib/reminders-client.ts`
 *     behind `app/app/projects/[id]/reminders.tsx`.
 *   - `/api/app/admin/*`                       — the Admin screen Settings
 *     routes to (`app/app/settings.tsx:362`).
 *   - `/api/app/persona/*`                     — the Personality pane inside it.
 *
 * WHY THE CONTROLS MATTER. On this ladder an unmounted route and a mistyped one
 * are the same 404, so a bare "not 404" proves little on its own. Each surface
 * is therefore pinned from three sides: a real request SUCCEEDS, an
 * unauthenticated one is REJECTED BY THE SURFACE (401/403, which only a mounted
 * surface can produce), and an invented sibling path under the same prefix still
 * 404s — so a future change that swallows the whole prefix fails here.
 *
 * MUTATION TEST: delete any one of the four `app_*_surface` assignments from
 * `open/composer.ts` and that surface's block here reds (as does
 * `route-slot-coverage.test.ts`). Verified for all four.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
] as const

/** The instance slug the composer boots with; also the dev-path bearer. */
const OWNER_SLUG = 'owner'

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let harness: Harness

interface Harness {
  base: string
  close(): Promise<void>
}

/** A substrate that answers immediately and starts no `claude` process. */
function mockSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock',
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH'] as string)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => mockSubstrate()) as any,
  })
  const composition = await composer({ db, project_slug: OWNER_SLUG })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('Open composition did not expose graph.fetch/websocket')
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })
  return {
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
      db.close()
    },
  }
}

/**
 * Issue a request the way the mobile client does: bearer-authed, JSON `Accept`
 * (so the Open owner gate falls through to the bearer chain rather than treating
 * it as a browser navigation — `landing/auth-gate.ts:isBrowserNavigation`).
 */
async function call(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init.auth !== false) headers['authorization'] = `Bearer ${OWNER_SLUG}`
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return await fetch(`${harness.base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
}

beforeAll(async () => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-app-surfaces-served-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = OWNER_SLUG
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'app-surfaces-served-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-app-surfaces-served'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
  harness = await startHarness()
}, 120_000)

afterAll(async () => {
  await harness.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('the controls — 404 on this ladder means UNMOUNTED, not "bad request"', () => {
  test('an invented path under /api/app/ is a 404', async () => {
    // Without this the assertions below could pass against a catch-all that
    // answers everything, which is the opposite failure.
    const res = await call('/api/app/definitely-not-a-real-surface')
    expect(res.status).toBe(404)
  })

  test('an invented sibling of each mounted prefix is still a 404', async () => {
    // Each surface claims a PREFIX. Mounting one must not turn its whole prefix
    // into a black hole for paths it does not own — `/api/app/admin/*` is the
    // live example, since the admin surface answers `unknown_admin_route` for
    // anything under it and the diagnostics rung sits in front of it.
    for (const path of [
      '/api/app/devices/not-a-verb',
      '/api/app/projects/p1/reminders/extra/segments/here',
      '/api/app/persona/not-a-file-route',
    ]) {
      const res = await call(path)
      expect({ path, status: res.status }).toEqual({ path, status: 404 })
    }
  })
})

describe('app_devices_surface — reachable through graph.fetch', () => {
  test('POST /api/app/devices/register records the device and unregister removes it', async () => {
    const register = await call('/api/app/devices/register', {
      method: 'POST',
      body: { device_token: 'ExponentPushToken[served-test]', platform: 'ios' },
    })
    expect(register.status).toBe(200)
    const body = (await register.json()) as {
      ok: boolean
      device: { project_slug: string; platform: string }
    }
    expect(body.ok).toBe(true)
    // The row came back from the real DevicePushTokenStore write, so the
    // register path went all the way to storage rather than short-circuiting.
    expect(body.device.project_slug).toBe(OWNER_SLUG)
    expect(body.device.platform).toBe('ios')

    const unregister = await call('/api/app/devices/unregister', {
      method: 'POST',
      body: { device_token: 'ExponentPushToken[served-test]' },
    })
    expect(unregister.status).toBe(200)
  })

  test('unauthenticated is 401 from the surface, not 404 from the ladder', async () => {
    const res = await call('/api/app/devices/register', { method: 'POST', auth: false })
    expect(res.status).toBe(401)
  })
})

describe('app_reminders_surface — reachable through graph.fetch', () => {
  test('create then list round-trips through the real ReminderStore', async () => {
    const empty = await call('/api/app/projects/p1/reminders?status=pending')
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { reminders: unknown[] }).reminders).toEqual([])

    const fire_at = Math.floor(Date.now() / 1000) + 3600
    const created = await call('/api/app/projects/p1/reminders', {
      method: 'POST',
      body: { message: 'served-test reminder', fire_at },
    })
    expect(created.status).toBe(200)
    const after = (await created.json()) as { reminders: Array<{ message: string; id: string }> }
    expect(after.reminders.map((r) => r.message)).toEqual(['served-test reminder'])

    // A second, independent GET proves the row was persisted by the surface the
    // ladder dispatched to — not just echoed back out of the create handler.
    const listed = await call('/api/app/projects/p1/reminders?status=pending')
    const listedBody = (await listed.json()) as { reminders: Array<{ id: string }> }
    expect(listedBody.reminders.map((r) => r.id)).toEqual(after.reminders.map((r) => r.id))

    const cancelled = await call(
      `/api/app/projects/p1/reminders/${after.reminders[0]!.id}/cancel`,
      { method: 'POST' },
    )
    expect(cancelled.status).toBe(200)
    expect(((await cancelled.json()) as { reminders: unknown[] }).reminders).toEqual([])
  })

  test('unauthenticated is 401 from the surface, not 404 from the ladder', async () => {
    const res = await call('/api/app/projects/p1/reminders', { auth: false })
    expect(res.status).toBe(401)
  })
})

describe('app_admin_surface — reachable through graph.fetch', () => {
  test('GET /api/app/admin/connectors answers from the installed-Cores store', async () => {
    const res = await call('/api/app/admin/connectors')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { configured?: boolean; connectors?: unknown[] }
    // `coresStore` IS wired by the composer, so this must not be the
    // unconfigured envelope the surface falls back to when the dep is absent.
    expect(body.configured).toBe(true)
    expect(Array.isArray(body.connectors)).toBe(true)
  })

  // NOT asserted here: `GET /api/app/admin/memory`. It is mounted and it IS
  // reached (the composer wires `gbrainMemory.memoryStore`), but answering it
  // drives a real `gbrain` MCP query, which on a host without the binary blocks
  // until the connection gives up — a multi-second, host-dependent wait that
  // would make this file flaky for no extra information. `/connectors` above
  // already proves the ladder dispatches into this surface, and it does so
  // against a wired dependency rather than a stub.

  test('the diagnostics rung still wins the /diagnostics path', async () => {
    // `appDiagnostics` is declared BEFORE `appAdmin` (route-slots.ts) precisely
    // so mounting the admin surface cannot swallow this path with its
    // `unknown_admin_route` 404. That ordering is now load-bearing, so pin it.
    const res = await call('/api/app/admin/diagnostics')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).not.toBe('unknown_admin_route')
  })

  test('unauthenticated is 401 from the surface, not 404 from the ladder', async () => {
    const res = await call('/api/app/admin/connectors', { auth: false })
    expect(res.status).toBe(401)
  })
})

describe('app_persona_surface — reachable through graph.fetch', () => {
  test('GET /api/app/persona/files lists the three persona files', async () => {
    const res = await call('/api/app/persona/files')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { files: Array<{ filename: string }> }
    expect(body.files.map((f) => f.filename).sort()).toEqual([
      'SOUL.md',
      'USER.md',
      'priority-map.md',
    ])
  })

  test('PATCH then GET round-trips a persona file to disk', async () => {
    const patched = await call('/api/app/persona/file?name=SOUL.md', {
      method: 'PATCH',
      body: { content: '# served-test soul\n', expected_mtime: -1 },
    })
    expect(patched.status).toBe(200)
    const read = await call('/api/app/persona/file?name=SOUL.md')
    expect(read.status).toBe(200)
    expect(await read.text()).toBe('# served-test soul\n')
  })

  test('unauthenticated is 401 from the surface, not 404 from the ladder', async () => {
    const res = await call('/api/app/persona/files', { auth: false })
    expect(res.status).toBe(401)
  })
})
