/**
 * Notes Core S1 — production-composer reachability guard.
 *
 * Per docs/plans/notes-core-tier1-brief.md § 7 ("production-composer-
 * reachability test"). Closes the anti-pattern Argus has caught in six
 * consecutive sprints (PR #222 / #225 / #227 / #229 / #231 / #233):
 * surfaces that ship + unit-test cleanly but never reach
 * `composeProductionGraph`, so the production gateway 404s on them.
 *
 * The test:
 *   1. Boots `composeProductionGraph` against in-memory SQLite +
 *      dev-bypass `AppWsAuthResolver` (NOT a hand-rolled router).
 *   2. Threads `notes_drawer_browser_surface` through CompositionInput
 *      and the app-ws surface's `chat_command_filter` through the
 *      same factory the production boot uses.
 *   3. Mounts both via `composeHttpHandler` — the SAME factory
 *      production wires.
 *   4. Fires HTTP requests against every drawer-browser route, the
 *      chat `/api/app/chat/send` path with `/note <body>` /
 *      `/note find <q>` / `/note tunnel <a> <b>`, the launcher tile,
 *      and asserts per-project isolation.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
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
} from '../http/project-launcher-store.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

import {
  NotesStoreResolver,
  createNotesChatCommandFilter,
  createNotesDrawerBrowserSurface,
} from '../../cores/free/notes/index.ts'

const OWNER = 'notes-composer-project'
const PROJECT = 'demo-notes-project'
const OTHER_PROJECT = 'other-notes-project'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  owner_home: string
  resolver: NotesStoreResolver
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
  const owner_home = mkdtempSync(join(tmpdir(), 'neutron-notes-composer-'))
  const db = ProjectDb.open(join(owner_home, 'owner.db'))
  applyMigrations(db.raw())

  const resolver = new NotesStoreResolver({ owner_home })
  const chatCommandFilter = createNotesChatCommandFilter({
    resolver,
    default_project_id: PROJECT,
  })

  // Build the surface pieces FIRST so we can hand them to
  // `composeProductionGraph` via the typed `CompositionInput`. This is
  // the EXACT contract the production boot honors at
  // `gateway/index.ts:boot`.
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const store = new InMemoryProjectLauncherStore({ seed: DEFAULT_LAUNCHER_SEED })
  const launcherSurface = createAppLauncherSurface({ store, auth })
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async () => {} },
  })
  const wsSurface = createAppWsSurface({
    adapter,
    registry,
    auth,
    project_slug: OWNER,
    chat_command_filter: chatCommandFilter,
  })
  const notesSurface = createNotesDrawerBrowserSurface({ resolver, auth })

  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_launcher_surface: { handler: launcherSurface.handler },
    app_ws_surface: {
      handler: wsSurface.handler,
      websocket: wsSurface.websocket,
    },
    notes_drawer_browser_surface: { handler: notesSurface.handler },
  })

  // ISSUE #32 — serve `graph.fetch` so the surface→composeInput
  // mapping is the only path exercised.
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
    resolver,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      resolver.closeAll()
      db.close()
      rmSync(owner_home, { recursive: true, force: true })
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

test('production composer mounts the Notes launcher tile alongside Tasks / Reminders', async () => {
  const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT}/launcher`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    entries: Array<{ slug: string }>
  }
  expect(body.ok).toBe(true)
  expect(body.entries.map((e) => e.slug)).toContain('notes')
})

test('chat `/note <body>` POST 200 + per-project notes.db row + LLM path SKIPPED', async () => {
  const res = await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: '/note hello world from chat',
      project_id: PROJECT,
      client_msg_id: 'c-note-1',
    }),
  })
  expect(res.status).toBe(200)
  const env = (await res.json()) as {
    ok: boolean
    chat_command_result?: {
      text: string
      data?: { note_id?: string; drawer_id?: string }
    }
  }
  expect(env.ok).toBe(true)
  expect(env.chat_command_result).toBeDefined()
  expect(env.chat_command_result?.text).toContain('captured')

  // The per-project sidecar must exist on disk.
  const dbPath = harness.resolver.pathFor(PROJECT)
  expect(dbPath).toContain(`Projects/${PROJECT}/notes/notes.db`)
  expect(existsSync(dbPath)).toBe(true)

  // The note body must round-trip through the per-project store.
  const store = await harness.resolver.resolve(PROJECT)
  const notes = store.listNotes()
  expect(notes).toHaveLength(1)
  // The chat-command parser strips the `/note ` prefix; the captured
  // body is the user's text minus the verb.
  expect(notes[0]?.content).toBe('hello world from chat')
})

test('chat `/note find <query>` returns ranked hits in the chat_command_result envelope', async () => {
  // Pre-seed two notes via the chat path so the test exercises the
  // exact composer chain.
  await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: '/note shopify analytics dashboard plan',
      project_id: PROJECT,
      client_msg_id: 'c-seed-1',
    }),
  })
  await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: '/note daily standup notes for engineering team',
      project_id: PROJECT,
      client_msg_id: 'c-seed-2',
    }),
  })

  const res = await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: '/note find shopify',
      project_id: PROJECT,
      client_msg_id: 'c-search-1',
    }),
  })
  expect(res.status).toBe(200)
  const env = (await res.json()) as {
    chat_command_result?: {
      text: string
      data?: { results?: Array<{ note_id: string; snippet: string }> }
    }
  }
  const results = env.chat_command_result?.data?.results
  expect(Array.isArray(results)).toBe(true)
  expect(results?.length).toBeGreaterThanOrEqual(1)
  expect(results?.[0]?.snippet).toContain('shopify')
})

test('chat `/note tunnel <a> <b>` creates a KG edge that `notes_traverse` resolves', async () => {
  const store = await harness.resolver.resolve(PROJECT)
  const a = store.write({ content: 'tunnel source note', source_kind: 'mcp_tool' })
  const b = store.write({ content: 'tunnel target note', source_kind: 'mcp_tool' })

  const res = await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: `/note tunnel ${a.id} ${b.id}`,
      project_id: PROJECT,
      client_msg_id: 'c-tunnel-1',
    }),
  })
  expect(res.status).toBe(200)
  const env = (await res.json()) as {
    chat_command_result?: { data?: { edge_id?: string } }
  }
  expect(env.chat_command_result?.data?.edge_id).toBeDefined()

  // The traverse surface should resolve b from a.
  const traverse = await authedFetch(
    harness.base,
    `/api/cores/notes/traverse?project_id=${PROJECT}&from=${a.id}&depth=1`,
  )
  expect(traverse.status).toBe(200)
  const traverseBody = (await traverse.json()) as {
    ok: boolean
    nodes: Array<{ id: string; note_id: string | null }>
    edges: Array<unknown>
  }
  expect(traverseBody.ok).toBe(true)
  expect(traverseBody.edges.length).toBeGreaterThanOrEqual(1)
  expect(traverseBody.nodes.some((n) => n.note_id === b.id)).toBe(true)
})

test('drawer-browser surface — POST create note + GET note + POST tunnel + GET drawer + GET search', async () => {
  // Create a drawer
  const createDrawer = await authedFetch(harness.base, '/api/cores/notes/drawers', {
    method: 'POST',
    body: JSON.stringify({ project_id: PROJECT, name: 'project-ideas' }),
  })
  expect(createDrawer.status).toBe(200)
  const drawer = (await createDrawer.json()) as { id: string }
  expect(typeof drawer.id).toBe('string')

  // Create two notes against that drawer
  const createA = await authedFetch(harness.base, '/api/cores/notes/notes', {
    method: 'POST',
    body: JSON.stringify({
      project_id: PROJECT,
      drawer_id: drawer.id,
      content: 'browser surface note A — Rails app stack',
      tags: ['rails', 'stack'],
    }),
  })
  expect(createA.status).toBe(200)
  const a = (await createA.json()) as { id: string }

  const createB = await authedFetch(harness.base, '/api/cores/notes/notes', {
    method: 'POST',
    body: JSON.stringify({
      project_id: PROJECT,
      drawer_id: drawer.id,
      content: 'browser surface note B — frontend rendering plan',
    }),
  })
  expect(createB.status).toBe(200)
  const b = (await createB.json()) as { id: string }

  // GET drawer list
  const listDrawers = await authedFetch(
    harness.base,
    `/api/cores/notes/drawers?project_id=${PROJECT}`,
  )
  expect(listDrawers.status).toBe(200)
  const drawers = (await listDrawers.json()) as {
    drawers: Array<{ name: string; note_count: number }>
  }
  expect(drawers.drawers.some((d) => d.name === 'project-ideas' && d.note_count === 2)).toBe(true)

  // GET single drawer + its notes
  const showDrawer = await authedFetch(
    harness.base,
    `/api/cores/notes/drawers/${drawer.id}?project_id=${PROJECT}`,
  )
  expect(showDrawer.status).toBe(200)
  const drawerBody = (await showDrawer.json()) as {
    drawer: { id: string }
    notes: Array<{ id: string }>
  }
  expect(drawerBody.drawer.id).toBe(drawer.id)
  expect(drawerBody.notes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort())

  // GET single note
  const showNote = await authedFetch(
    harness.base,
    `/api/cores/notes/notes/${a.id}?project_id=${PROJECT}`,
  )
  expect(showNote.status).toBe(200)
  const noteBody = (await showNote.json()) as {
    note: { id: string; snippet: string }
  }
  expect(noteBody.note.id).toBe(a.id)
  expect(noteBody.note.snippet).toContain('Rails')

  // POST tunnel
  const tunnel = await authedFetch(
    harness.base,
    `/api/cores/notes/notes/${a.id}/tunnel`,
    {
      method: 'POST',
      body: JSON.stringify({ project_id: PROJECT, target_id: b.id }),
    },
  )
  expect(tunnel.status).toBe(200)
  const edge = (await tunnel.json()) as { edge_id: string }
  expect(typeof edge.edge_id).toBe('string')

  // GET search
  const search = await authedFetch(
    harness.base,
    `/api/cores/notes/search?project_id=${PROJECT}&q=Rails&limit=5`,
  )
  expect(search.status).toBe(200)
  const searchBody = (await search.json()) as {
    results: Array<{ note_id: string }>
  }
  expect(searchBody.results.length).toBeGreaterThanOrEqual(1)
  expect(searchBody.results.some((r) => r.note_id === a.id)).toBe(true)
})

test('every drawer-browser route 401 without bearer; unknown action 405', async () => {
  const paths: ReadonlyArray<[string, string, object | null]> = [
    [`/api/cores/notes/drawers?project_id=${PROJECT}`, 'GET', null],
    [`/api/cores/notes/notes`, 'POST', { project_id: PROJECT, content: 'x' }],
    [`/api/cores/notes/search?project_id=${PROJECT}&q=x`, 'GET', null],
  ]
  for (const [path, method, body] of paths) {
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json' },
    }
    if (body !== null) init.body = JSON.stringify(body)
    const res = await fetch(`${harness.base}${path}`, init)
    expect(res.status).toBe(401)
  }
  const bogus = await authedFetch(
    harness.base,
    `/api/cores/notes/definitely-not-a-route?project_id=${PROJECT}`,
  )
  expect(bogus.status).toBe(405)
})

test('per-project isolation — a note written in PROJECT is invisible from OTHER_PROJECT', async () => {
  await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: '/note isolated content — should not leak',
      project_id: PROJECT,
      client_msg_id: 'c-iso-1',
    }),
  })

  // The OTHER_PROJECT drawer-browser sees an empty list.
  const otherDrawers = await authedFetch(
    harness.base,
    `/api/cores/notes/drawers?project_id=${OTHER_PROJECT}`,
  )
  expect(otherDrawers.status).toBe(200)
  const otherBody = (await otherDrawers.json()) as { drawers: Array<unknown> }
  expect(otherBody.drawers.length).toBe(0)

  const otherSearch = await authedFetch(
    harness.base,
    `/api/cores/notes/search?project_id=${OTHER_PROJECT}&q=isolated`,
  )
  expect(otherSearch.status).toBe(200)
  const otherSearchBody = (await otherSearch.json()) as { results: Array<unknown> }
  expect(otherSearchBody.results.length).toBe(0)

  // PROJECT, on the other hand, has the note.
  const projectSearch = await authedFetch(
    harness.base,
    `/api/cores/notes/search?project_id=${PROJECT}&q=isolated`,
  )
  expect(projectSearch.status).toBe(200)
  const projectSearchBody = (await projectSearch.json()) as { results: Array<unknown> }
  expect(projectSearchBody.results.length).toBeGreaterThanOrEqual(1)
})
