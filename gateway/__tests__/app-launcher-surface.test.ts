/**
 * P5.3 — gateway app-launcher surface tests.
 *
 * Verifies the four launcher routes
 * (`GET /api/app/projects/<id>/launcher` + the three POST mutations)
 * round-trip through `composeHttpHandler` with the dev-bypass auth
 * resolver and the in-memory store. Mirrors the structure of
 * `gateway/__tests__/app-ws-surface.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'
import { createAppLauncherSurface } from '../http/app-launcher-surface.ts'
import {
  InMemoryProjectLauncherStore,
  type LauncherEntry,
} from '../http/project-launcher-store.ts'

// --- in-process handler shim (no socket) -------------------------------------
// These surface tests used to bind a real `Bun.serve({ port: 0 })` and round-
// trip via the global `fetch`, holding a live listener + socket buffers in the
// chunk's RSS until teardown. Instead each harness registers its composed
// handler under a unique in-process base, and `fetch` is shadowed at module
// scope so requests to a registered base dispatch straight to
// `composed.fetch(new Request(...))` — identical assertions, no socket.
// Unrelated URLs fall through to the real fetch.
const __composedHandlers = new Map<string, ComposedHttpHandler>()
let __gatewaySeq = 0
const __realFetch = globalThis.fetch.bind(globalThis)
const fetch = ((input: Request | string | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
  const composed = __composedHandlers.get(new URL(req.url).host)
  if (composed !== undefined) return Promise.resolve(composed.fetch(req, undefined as never))
  return __realFetch(input as Parameters<typeof __realFetch>[0], init)
}) as typeof globalThis.fetch

interface Harness {
  base: string
  store: InMemoryProjectLauncherStore
  close(): Promise<void>
}

const PROJECT_ID = 'demo-project'
const FIXTURE: ReadonlyArray<{
  slug: string
  display_name: string
  launcher_icon: { kind: 'emoji'; value: string }
}> = [
  { slug: 'calendar_core', display_name: 'Calendar', launcher_icon: { kind: 'emoji', value: '📅' } },
  { slug: 'tasks_core', display_name: 'Tasks', launcher_icon: { kind: 'emoji', value: '✅' } },
  { slug: 'reminders', display_name: 'Reminders', launcher_icon: { kind: 'emoji', value: '⏰' } },
]

async function startGateway(): Promise<Harness> {
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const store = new InMemoryProjectLauncherStore({ seed: FIXTURE })
  const surface = createAppLauncherSurface({ store, auth })
  const composed = composeHttpHandler({
    appLauncher: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const host = `gw-${++__gatewaySeq}.test`
  __composedHandlers.set(host, composed)
  return {
    base: `http://${host}`,
    store,
    close: async () => {
      __composedHandlers.delete(host)
    },
  }
}

async function authedFetch(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', 'Bearer dev:sam')
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

describe('app-launcher surface — GET list', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('rejects requests without a Bearer token', async () => {
    const res = await fetch(`${harness.base}/api/app/projects/${PROJECT_ID}/launcher`)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('returns the fixture seed for a fresh project', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/launcher`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; entries: LauncherEntry[]; project_id: string }
    expect(json.ok).toBe(true)
    expect(json.project_id).toBe(PROJECT_ID)
    expect(json.entries).toHaveLength(3)
    expect(json.entries.map((e) => e.slug)).toEqual(['calendar_core', 'tasks_core', 'reminders'])
    expect(json.entries.map((e) => e.reorder_index)).toEqual([0, 1, 2])
    expect(json.entries[0]?.launcher_icon).toEqual({ kind: 'emoji', value: '📅' })
  })

  it('rejects a malformed project_id', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/has%20space/launcher`)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_project_id')
  })

  it('returns 405 for a POST to the bare list path', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/launcher`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(405)
  })
})

describe('app-launcher surface — POST reorder', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('moves an entry to a new index and recomputes indices', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/launcher/reorder`,
      { method: 'POST', body: JSON.stringify({ slug: 'reminders', new_index: 0 }) },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { entries: LauncherEntry[] }
    expect(json.entries.map((e) => e.slug)).toEqual(['reminders', 'calendar_core', 'tasks_core'])
    expect(json.entries.map((e) => e.reorder_index)).toEqual([0, 1, 2])
  })

  it('forward reorder lands the dragged tile at the drop-target index', async () => {
    // Argus r1 + Codex GPT-5 flagged a potential off-by-one for forward
    // moves (fromIdx < new_index). The contract: `new_index` is the
    // **final position** of the moved tile in the result array. Drop
    // calendar_core onto tasks_core at idx 1 → calendar_core lands at idx 1; tasks_core
    // shifts left to idx 0. This regression test pins that semantic.
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/launcher/reorder`,
      { method: 'POST', body: JSON.stringify({ slug: 'calendar_core', new_index: 1 }) },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { entries: LauncherEntry[] }
    expect(json.entries.map((e) => e.slug)).toEqual(['tasks_core', 'calendar_core', 'reminders'])
    expect(json.entries.map((e) => e.reorder_index)).toEqual([0, 1, 2])
  })

  it('persists the reorder across subsequent GETs (server is authoritative)', async () => {
    await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/launcher/reorder`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'reminders', new_index: 0 }),
    })
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/launcher`)
    const json = (await res.json()) as { entries: LauncherEntry[] }
    expect(json.entries.map((e) => e.slug)).toEqual(['reminders', 'calendar_core', 'tasks_core'])
  })

  it('clamps out-of-range new_index', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/launcher/reorder`,
      { method: 'POST', body: JSON.stringify({ slug: 'calendar_core', new_index: 999 }) },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { entries: LauncherEntry[] }
    expect(json.entries[json.entries.length - 1]?.slug).toBe('calendar_core')
  })

  it('rejects malformed payloads', async () => {
    const bad: Array<{ body: string; expectedCode: string }> = [
      { body: 'not-json', expectedCode: 'malformed_json' },
      { body: JSON.stringify({ slug: 'calendar_core' }), expectedCode: 'missing_new_index' },
      { body: JSON.stringify({ new_index: 1 }), expectedCode: 'missing_slug' },
      {
        body: JSON.stringify({ slug: 'has spaces', new_index: 1 }),
        expectedCode: 'missing_slug',
      },
      {
        body: JSON.stringify({ slug: 'calendar_core', new_index: 'first' }),
        expectedCode: 'missing_new_index',
      },
    ]
    for (const { body, expectedCode } of bad) {
      const res = await authedFetch(
        harness.base,
        `/api/app/projects/${PROJECT_ID}/launcher/reorder`,
        { method: 'POST', body },
      )
      expect(res.status).toBe(400)
      const json = (await res.json()) as { code: string }
      expect(json.code).toBe(expectedCode)
    }
  })

  it('is a no-op on an unknown slug', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/launcher/reorder`,
      { method: 'POST', body: JSON.stringify({ slug: 'ghost', new_index: 0 }) },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { entries: LauncherEntry[] }
    expect(json.entries.map((e) => e.slug)).toEqual(['calendar_core', 'tasks_core', 'reminders'])
  })
})

describe('app-launcher surface — POST uninstall', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('removes the entry from the project list and compacts indices', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/launcher/uninstall`,
      { method: 'POST', body: JSON.stringify({ slug: 'tasks_core' }) },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { entries: LauncherEntry[] }
    expect(json.entries.map((e) => e.slug)).toEqual(['calendar_core', 'reminders'])
    expect(json.entries.map((e) => e.reorder_index)).toEqual([0, 1])
  })

  it('does not affect other (project, project_id) pairs', async () => {
    await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/launcher/uninstall`,
      { method: 'POST', body: JSON.stringify({ slug: 'tasks_core' }) },
    )
    const otherRes = await authedFetch(
      harness.base,
      `/api/app/projects/other-project/launcher`,
    )
    const json = (await otherRes.json()) as { entries: LauncherEntry[] }
    expect(json.entries.map((e) => e.slug)).toEqual(['calendar_core', 'tasks_core', 'reminders'])
  })
})

describe('app-launcher surface — POST rename', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('renames the entry and persists across GETs', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/launcher/rename`,
      {
        method: 'POST',
        body: JSON.stringify({ slug: 'tasks_core', display_name: 'My Tasks' }),
      },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { entries: LauncherEntry[] }
    const entry = json.entries.find((e) => e.slug === 'tasks_core')
    expect(entry?.display_name).toBe('My Tasks')

    const getRes = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/launcher`)
    const getJson = (await getRes.json()) as { entries: LauncherEntry[] }
    const getEntry = getJson.entries.find((e) => e.slug === 'tasks_core')
    expect(getEntry?.display_name).toBe('My Tasks')
  })

  it('rejects empty display_name', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/launcher/rename`,
      {
        method: 'POST',
        body: JSON.stringify({ slug: 'tasks_core', display_name: '   ' }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_display_name')
  })

  it('rejects oversize display_name', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/launcher/rename`,
      {
        method: 'POST',
        body: JSON.stringify({ slug: 'tasks_core', display_name: 'x'.repeat(81) }),
      },
    )
    expect(res.status).toBe(413)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('display_name_too_long')
  })
})

describe('app-launcher surface — long_press_menu serialisation (ISSUE #17)', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('GET /api/app/projects/<id>/launcher serialises long_press_menu + primary_action + app_tab_path', async () => {
    // Override the seed for this test fixture so the LauncherEntries
    // carry the richer P5.3 fields (the default FIXTURE only has the
    // legacy shape). The HTTP body MUST round-trip them verbatim.
    harness.store.seedFor('demo', PROJECT_ID, [
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
        // Legacy-shape entry (no long_press_menu) must coexist.
        slug: 'calendar_core',
        display_name: 'Calendar',
        launcher_icon: { kind: 'emoji', value: '📅' },
      },
    ])
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/launcher`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; entries: LauncherEntry[] }
    const tasks = json.entries.find((e) => e.slug === 'tasks_core')
    expect(tasks).toBeDefined()
    expect(tasks?.primary_action).toBe('open_app_tab')
    expect(tasks?.app_tab_path).toBe('/projects/<project_id>/tasks')
    expect(tasks?.long_press_menu).toHaveLength(3)
    expect(tasks?.long_press_menu?.[0]).toEqual({
      id: 'capture',
      label: 'Capture a task',
      action: 'chat_send_prefix',
      prefix: '/task ',
    })
    expect(tasks?.long_press_menu?.[2]).toEqual({
      id: 'pick_next',
      label: 'What should I focus on?',
      action: 'chat_send',
      text: '/task focus',
    })
    // Legacy-shape coexistence: calendar entry has none of the new fields.
    const calendar = json.entries.find((e) => e.slug === 'calendar_core')
    expect(calendar).toBeDefined()
    expect(calendar?.primary_action).toBeUndefined()
    expect(calendar?.app_tab_path).toBeUndefined()
    expect(calendar?.long_press_menu).toBeUndefined()
  })
})

describe('app-launcher surface — fall-through behaviour', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('does not claim unrelated /api paths', async () => {
    const res = await fetch(`${harness.base}/api/something/else`)
    // defaultHandler returns 404
    expect(res.status).toBe(404)
  })

  it('does not claim /api/app/projects without a /launcher segment', async () => {
    const res = await fetch(`${harness.base}/api/app/projects/${PROJECT_ID}`)
    expect(res.status).toBe(404)
  })
})
