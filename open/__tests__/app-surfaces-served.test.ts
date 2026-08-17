/**
 * APP SURFACES — reachable through the real router, not merely composed.
 *
 * `route-slot-coverage.test.ts` asks whether the composed graph CARRIES a
 * slot's `CompositionInput` field. That is a necessary condition and not a
 * sufficient one: a field can be populated while the ladder never dispatches to
 * it, because an earlier rung claims the path. So this file asks the other half
 * of the question and drives real HTTP through the composed `graph.fetch` — the
 * ONE path that maps `composition.app_xxx_surface` onto a route
 * (`gateway/composition.ts` `buildComposedHttpFromComposition`, the ISSUE #32
 * seam).
 *
 * The surfaces here were all declared, all had a shipped client calling them,
 * and none were ever handed to the graph:
 *
 *   - `/api/app/devices/{register,unregister}` — `app/lib/push.ts:143,177` calls
 *     these on every sign-in and sign-out. No device could register at all.
 *   - `/api/app/projects/<id>/reminders[…]`    — `app/lib/reminders-client.ts`
 *     behind `app/app/projects/[id]/reminders.tsx`.
 *   - `/api/app/admin/*`                       — the Admin screen Settings
 *     routes to (`app/app/settings.tsx:362`).
 *   - `/api/app/persona/*`                     — the Personality pane inside it.
 *   - `/api/app/projects/<id>/backups[…]`      — the Backups screen
 *     (`app/app/projects/[id]/backups.tsx`), added 2026-08-02, and the reason
 *     the last describe block in this file is about ROUTE OWNERSHIP rather than
 *     reachability. See its own docblock: mounting that surface was blocked on a
 *     path collision, because "the request reaches A handler" and "the request
 *     reaches the RIGHT handler" are, again, different claims.
 *
 * WHY THE CONTROLS MATTER. On this ladder an unmounted route and a mistyped one
 * are the same 404, so a bare "not 404" proves little on its own. Each surface
 * is therefore pinned from three sides: a real request SUCCEEDS, an
 * unauthenticated one is REJECTED BY THE SURFACE (401/403, which only a mounted
 * surface can produce), and an invented sibling path under the same prefix still
 * 404s — so a future change that swallows the whole prefix fails here.
 *
 * MUTATION TEST: delete any one of the `app_*_surface` assignments from
 * `open/composer.ts` and that surface's block here reds (as does
 * `route-slot-coverage.test.ts`). Verified for all five.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

import { buildOpenGraphComposer } from '../composer.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

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
  const db = openMigratedDbAt(process.env['NEUTRON_DB_PATH'] as string)
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
      // Neither `restore` nor a 40-hex sha, so the backups surface declines the
      // path entirely (returns null) and the ladder answers. Pins that mounting
      // it did not turn `/backups/*` into a black hole.
      '/api/app/projects/p1/backups/not-a-sha',
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

/**
 * TWO OPERATIONS THAT USED TO SHARE ONE PATH.
 *
 * `POST /api/app/projects/<id>/restore` meant two unrelated things:
 *
 *   A. UN-ARCHIVE a project, putting it back on the rail
 *      (`gateway/http/app-projects-surface.ts:560` `RESTORE_PATH_RE`). Served,
 *      with a live web client at `landing/chat-react/IntegrationsTab.tsx:217`.
 *   B. RESTORE A SNAPSHOT from the project's backup history
 *      (`gateway/http/app-backups-surface.ts`). Never served — `app-projects`
 *      is an earlier rung than `app-backups` in `route-slots.ts`, so A won
 *      every request.
 *
 * The consequence was not a 404. `app/lib/backups-client.ts` POSTed B's body to
 * that path, A ran, the project got UN-ARCHIVED, and `200 {restored:true}` came
 * back — a wrong operation reported as a success, which is strictly worse than
 * the honest failure an unmounted route would have given.
 *
 * Reordering the rungs so B won was the wrong fix: it just moves the silent
 * wrong answer onto A, which is the side that WORKS. So B moved to
 * `POST .../backups/restore`, nesting it under the prefix its four sibling read
 * routes already own. The two patterns are now disjoint by SHAPE, so no future
 * ladder reordering can bring the collision back — and this block pins that.
 *
 * WHY THESE PARTICULAR ASSERTIONS. Both handlers can answer 400 and both can
 * answer 404, so status alone cannot say which one ran. Each test therefore
 * keys on a marker only ONE surface can emit:
 *
 *   - `invalid_file_path` is emitted at `app-backups-surface.ts` and NOWHERE
 *     else in the repo, and it is emitted BEFORE the handler touches the store —
 *     so it identifies the backup handler on any host, with or without `git`.
 *   - `{restored: true, project_id, project_slug}` is the un-archive handler's
 *     own success envelope (`app-projects-surface.ts:942`), and the archived
 *     list going empty proves the mutation really happened rather than being
 *     echoed.
 *
 * MUTATION TESTS (both run, both red as described):
 *   1. Point the backup route back at the bare `/restore` (revert
 *      `BACKUPS_PATH_RE` and the client): the two `.../backups/restore` tests
 *      red — the path stops existing and the ladder 404s it.
 *   2. Delete `app_backups_surface` from `open/composer.ts`: same two tests red,
 *      as does `route-slot-coverage.test.ts`.
 * Neither mutation touches the un-archive tests, which is the point — they are
 * there to catch the OTHER repair, the one that would have broken a working
 * feature.
 */
describe('app_backups_surface — mounted, and the /restore collision is gone', () => {
  /** Syntactically valid but nonexistent — never reached, see below. */
  const SHA = 'a'.repeat(40)

  test('POST .../backups/restore reaches the BACKUP handler', async () => {
    // A body that carries `snapshot_sha` — the field that made this a snapshot
    // restore rather than an un-archive — plus a `file_path` of the wrong type.
    // The backups surface rejects that itself, before any store/git call, so the
    // assertion is deterministic on a host with or without `git` installed.
    const res = await call('/api/app/projects/p1/backups/restore', {
      method: 'POST',
      body: { snapshot_sha: SHA, file_path: 42 },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code?: string }
    // Only `gateway/http/app-backups-surface.ts` emits this code. Getting it
    // back is proof the ladder dispatched into the backups surface — not into
    // the projects surface, and not into the default 404.
    expect(body.code).toBe('invalid_file_path')
  })

  test('GET .../backups/restore is a 405 from the surface, not a 404 from the ladder', async () => {
    // The complement of the test above: the path EXISTS and the surface owns it
    // for POST only. A 404 here would mean unmounted; a 405 can only come from a
    // surface that matched the path.
    const res = await call('/api/app/projects/p1/backups/restore')
    expect(res.status).toBe(405)
    expect(((await res.json()) as { code?: string }).code).toBe('method_not_allowed')
  })

  test('unauthenticated is 401 from the surface, not 404 from the ladder', async () => {
    const res = await call('/api/app/projects/p1/backups/restore', {
      method: 'POST',
      auth: false,
    })
    expect(res.status).toBe(401)
  })

  test('the bare .../restore still UN-ARCHIVES, even when the body looks like a snapshot restore', async () => {
    // This is the behaviour the obvious fix (reorder the rungs so the backups
    // surface wins) would have destroyed. It is exercised end to end — create,
    // archive, un-archive — against the real SqliteProjectSettingsStore, so a
    // regression shows up as a project that will not come back to the rail.
    const created = await call('/api/app/projects', {
      method: 'POST',
      body: { name: 'collision probe' },
    })
    expect([200, 201]).toContain(created.status)
    const project_id = ((await created.json()) as { project: { id: string } }).project.id

    const archived = await call(`/api/app/projects/${project_id}/archive`, { method: 'POST' })
    expect(archived.status).toBe(200)
    const listBefore = (await (await call('/api/app/projects/archived')).json()) as {
      archived: Array<{ id: string }>
    }
    expect(listBefore.archived.map((p) => p.id)).toContain(project_id)

    // The SAME body shape the backups client sends. It must NOT divert the
    // request: this path belongs to un-archive and always did.
    const res = await call(`/api/app/projects/${project_id}/restore`, {
      method: 'POST',
      body: { snapshot_sha: SHA, file_path: 42 },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { restored?: boolean; code?: string }
    expect(body.restored).toBe(true)
    // And emphatically NOT the backup handler's rejection of that same body.
    expect(body.code).toBeUndefined()

    const listAfter = (await (await call('/api/app/projects/archived')).json()) as {
      archived: Array<{ id: string }>
    }
    expect(listAfter.archived.map((p) => p.id)).not.toContain(project_id)
  })

  test('the snapshot list reaches the real ProjectBackupStore', async () => {
    // The assertions above all stop at the surface's own input validation, which
    // proves routing but not that a working store was handed over. This one goes
    // all the way through to `ProjectBackupStore.listSnapshots`.
    //
    // Its answer is host-dependent by design and BOTH answers are correct — a
    // project with no `.project-backup/` repo yet lists empty, and a host with no
    // `git` binary degrades to 503 `restore_unavailable`. What is NOT acceptable
    // on either host is a 404, so that is what this pins, plus the right shape
    // for whichever branch the host takes.
    const res = await call('/api/app/projects/p1/backups')
    expect(res.status).not.toBe(404)
    if (res.status === 200) {
      const body = (await res.json()) as { snapshots: unknown[]; next_cursor: string | null }
      expect(body.snapshots).toEqual([])
      expect(body.next_cursor).toBeNull()
    } else {
      expect(res.status).toBe(503)
      expect(((await res.json()) as { code?: string }).code).toBe('restore_unavailable')
    }
  })
})
