/**
 * Tasks Core — `deep_link` top-level envelope guard (ISSUE #18).
 *
 * Pre-fix, `gateway/cores/tasks-chat-router.ts:243` nested `deep_link`
 * under the Core-private `tasks_core` metadata field. The Expo client
 * cannot reach it from a single uniform consumer that way — every Core
 * would need its own per-Core "look in this Core's nested metadata"
 * branch. The fix promotes `deep_link` to a top-level envelope field
 * so the `<ChatDeepLinkNavigator>` in the app handles every Core
 * uniformly.
 *
 * This integration test pins the wire shape: the `task:open:<id>`
 * postback emits an envelope where `env.deep_link === '/projects/<id>/
 * tasks/<task_id>'` at the TOP LEVEL (not under `env.tasks_core`).
 * The companion broader test (`tasks-core-chat-pick-next-composer.test.ts`)
 * checks the entire Tasks Core production composer reachability; this
 * file's narrower scope keeps the regression-watch focused on the
 * envelope shape so a future Core-private metadata refactor cannot
 * accidentally re-nest deep_link.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  AppWsAdapter,
  InMemoryAppWsSessionRegistry,
  createAppWsAuthResolver,
} from '@neutronai/channels/index.ts'
import { SecretAuditLog } from '@neutronai/cores-runtime'
import {
  buildPickNextService,
  buildStubPickNextLlmClient,
  buildSubstrateTaskStoreBackend,
  buildTools as buildTasksTools,
  loadManifest as loadTasksManifest,
} from '@neutronai/tasks-core'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TaskStore as CanonicalTaskStore } from '@neutronai/tasks/store.ts'
import { composeProductionGraph } from '../composition.ts'
import { createAppTasksSurface } from '../http/app-tasks-surface.ts'
import { createAppWsSurface } from '../http/app-ws-surface.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import {
  wrapWithTasksChatRouter,
  type TasksChatOwnerDeps,
} from '../cores/tasks-chat-router.ts'
import type { IncomingEvent } from '@neutronai/channels/types.ts'
import type { AppWsOutbound } from '@neutronai/channels/adapters/app-ws/envelope.ts'

const OWNER = 'tasks-deep-link-project'
const PROJECT = 'demo-project'

interface CapturedEnvelope {
  topic: string
  env: AppWsOutbound
}

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  canonical: CanonicalTaskStore
  toolSurface: ReturnType<typeof buildTasksTools>
  sentEnvelopes: CapturedEnvelope[]
  close(): Promise<void>
}

const noOpInputBase = {
  topic_handler: async (): Promise<void> => {},
  approval_notifier: { notify: async (): Promise<void> => undefined },
  watchdog_notifier: { notify: async (): Promise<void> => undefined },
  reminder_dispatcher: { dispatch: async (): Promise<void> => undefined },
  heartbeat_tracker: { lastHeartbeatAt: (): number => Date.now() },
  platform: STUB_PLATFORM,
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-tasks-deep-link-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  const canonical = new CanonicalTaskStore(db)
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const tasksSurface = createAppTasksSurface({ store: canonical, auth })

  const audit = new SecretAuditLog({ db })
  const manifest = loadTasksManifest()
  const adapterStore = buildSubstrateTaskStoreBackend({
    project_slug: OWNER,
    projectDb: db,
    store: canonical,
  })
  const pickNext = buildPickNextService({
    store: adapterStore,
    llm: buildStubPickNextLlmClient(),
  })
  const toolSurface = buildTasksTools({
    manifest,
    project_slug: OWNER,
    audit,
    store: adapterStore,
    pickNext,
  })
  const tasksDeps: TasksChatOwnerDeps = { store: adapterStore, pickNext }

  const innerReceiver = {
    receive: async (_event: IncomingEvent): Promise<void> => undefined,
  }
  const sentEnvelopes: CapturedEnvelope[] = []
  const registry = new InMemoryAppWsSessionRegistry()
  const wrappedReceiver = wrapWithTasksChatRouter({
    inner: innerReceiver,
    deps: {
      resolve: async (slug) => (slug === OWNER ? tasksDeps : null),
    },
    resolveOwner: () => OWNER,
    replyToTopic: (topic_id, env) => {
      sentEnvelopes.push({ topic: topic_id, env })
      return registry.send(topic_id, env)
    },
  })

  const adapter = new AppWsAdapter({
    registry,
    receiver: wrappedReceiver,
  })
  const wsSurface = createAppWsSurface({ adapter, registry, auth, project_slug: OWNER })

  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_tasks_surface: { handler: tasksSurface.handler },
    app_ws_surface: {
      handler: wsSurface.handler,
      websocket: wsSurface.websocket,
    },
  })

  const composed = composeHttpHandler({
    appTasks: { handler: tasksSurface.handler },
    appWs: { handler: wsSurface.handler, websocket: wsSurface.websocket },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })

  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })

  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    graph,
    db,
    canonical,
    toolSurface,
    sentEnvelopes,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  } satisfies Harness
}

async function authedSend(
  base: string,
  body: { body: string; project_id?: string; client_msg_id?: string },
): Promise<Response> {
  return fetch(`${base}/api/app/chat/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer dev:sam',
    },
    body: JSON.stringify(body),
  })
}

describe('Tasks Core — deep_link top-level envelope (ISSUE #18)', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startHarness()
  })
  afterEach(async () => {
    await harness.close()
  })

  test('task:open:<id> postback emits deep_link at the TOP LEVEL (not nested under tasks_core)', async () => {
    const created = await harness.toolSurface.tasks_create({
      title: 'open me',
      project_id: PROJECT,
    })

    const before = harness.sentEnvelopes.length
    const res = await authedSend(harness.base, {
      body: `task:open:${created.id}`,
      project_id: PROJECT,
      client_msg_id: 'c-open-deep-link-1',
    })
    expect(res.status).toBe(200)

    expect(harness.sentEnvelopes.length).toBe(before + 1)
    const env = harness.sentEnvelopes[before]!.env as unknown as Record<string, unknown>
    expect(env['type']).toBe('agent_message')

    // TOP-LEVEL deep_link — this is the contract.
    // Argus r2 BLOCKER B2 (PR #276) — query-string form
    // (`?task_id=<id>`) lands on the mounted flat-list route
    // (`app/app/projects/[id]/tasks.tsx`); the prior nested
    // `/tasks/<task_id>` was an unmatched route.
    expect(env['deep_link']).toBe(`/projects/${PROJECT}/tasks?task_id=${created.id}`)

    // The Core-private `tasks_core` field still carries `data` (task_id)
    // but MUST NOT carry deep_link any more. Re-nesting deep_link breaks
    // the single-consumer `<ChatDeepLinkNavigator>` invariant.
    const meta = env['tasks_core'] as
      | { deep_link?: string; data?: { task_id?: string }; error?: unknown }
      | undefined
    expect(meta?.deep_link).toBeUndefined()
    expect(meta?.data?.task_id).toBe(created.id)

    // No state change — open is a pure-navigate postback.
    expect(harness.canonical.get(created.id)?.status).toBe('open')
  })

  test('emitted deep_link resolves to a route mounted in app/app/ + tasks.tsx reads task_id (Argus r2 B2)', async () => {
    // Argus r2 BLOCKER B2 (PR #276) — the prior deep_link
    // `/projects/<id>/tasks/<task_id>` pointed at an UNMOUNTED Expo
    // Router segment (no `app/app/projects/[id]/tasks/[task_id].tsx`,
    // no `+not-found.tsx`), so tapping "Open" navigated to a dead
    // route. The fix emits `/projects/<id>/tasks?task_id=<task_id>`
    // which lands on the existing flat-list route + the route reads
    // the query param into `useLocalSearchParams().task_id`.
    //
    // This regression test enumerates the actual Expo Router segments
    // under `app/app/` and asserts the deep_link's path prefix matches
    // a mounted route. The companion source-text assertion pins that
    // tasks.tsx reads `task_id` (the React-side bun-test pattern —
    // RN components don't mount under bun-test in this repo, so the
    // unit test inspects source rather than rendering).
    const created = await harness.toolSurface.tasks_create({
      title: 'route resolves',
      project_id: PROJECT,
    })
    const before = harness.sentEnvelopes.length
    const res = await authedSend(harness.base, {
      body: `task:open:${created.id}`,
      project_id: PROJECT,
      client_msg_id: 'c-route-resolves-1',
    })
    expect(res.status).toBe(200)

    expect(harness.sentEnvelopes.length).toBe(before + 1)
    const env = harness.sentEnvelopes[before]!.env as unknown as Record<string, unknown>
    const deepLink = env['deep_link'] as string | undefined
    expect(typeof deepLink).toBe('string')

    // Split path + query.
    const [pathPart, queryPart] = (deepLink ?? '').split('?')
    expect(pathPart).toBe(`/projects/${PROJECT}/tasks`)

    // Query carries task_id.
    const queryParams = new URLSearchParams(queryPart ?? '')
    expect(queryParams.get('task_id')).toBe(created.id)

    // Enumerate mounted Expo Router segments under `app/app/` and
    // assert the path prefix matches a known route. Treat the
    // bracketed dynamic segments (`[id]`) as wildcards.
    const appRoot = resolve(import.meta.dir, '..', '..', 'app', 'app')
    const segmentRoutes = enumerateExpoRoutes(appRoot, '')

    const matched = segmentRoutes.find((route) => pathMatchesRoute(pathPart!, route))
    expect(matched).toBeDefined()
    expect(matched).toBe('/projects/[id]/tasks')

    // Source-text assertion: tasks.tsx reads `task_id` via
    // useLocalSearchParams + passes it to the list. This pins the
    // wiring without rendering RN in bun-test.
    const tasksSrc = readFileSync(
      join(appRoot, 'projects', '[id]', 'tasks.tsx'),
      'utf8',
    )
    expect(tasksSrc).toMatch(/useLocalSearchParams<\s*\{\s*id:\s*string\s*;\s*task_id\?:\s*string\s*\}\s*>/)
    // tasks.tsx must propagate task_id to the list as highlightTaskId.
    expect(tasksSrc).toMatch(/highlightTaskId\s*=\s*\{\s*highlightTaskId\s*\}/)
  })

  test('`/task done <id>` does NOT emit deep_link (state-change postback, no navigation)', async () => {
    // Sanity-pin the negative: only the open postback carries a deep_link.
    // A regression where every Tasks response picks up an unintended
    // deep_link would over-navigate the user.
    const created = await harness.toolSurface.tasks_create({
      title: 'done me',
      project_id: PROJECT,
    })
    const before = harness.sentEnvelopes.length
    const res = await authedSend(harness.base, {
      body: `/task done ${created.id}`,
      project_id: PROJECT,
      client_msg_id: 'c-done-no-deep-1',
    })
    expect(res.status).toBe(200)

    expect(harness.sentEnvelopes.length).toBe(before + 1)
    const env = harness.sentEnvelopes[before]!.env as unknown as Record<string, unknown>
    expect(env['deep_link']).toBeUndefined()
    const meta = env['tasks_core'] as { deep_link?: string } | undefined
    expect(meta?.deep_link).toBeUndefined()
  })
})

/**
 * Walk an Expo Router directory and emit one "/segments..." string per
 * mounted route. Bracketed segments (`[id]`) are preserved verbatim so
 * `pathMatchesRoute` can treat them as wildcards. `_layout.tsx` files
 * are NOT routes themselves — they don't change the matchable URL
 * surface, so we skip them. `index.tsx` collapses to the parent dir.
 */
function enumerateExpoRoutes(root: string, prefix: string): string[] {
  const routes: string[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return routes
  }
  for (const entry of entries) {
    const full = join(root, entry)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      routes.push(...enumerateExpoRoutes(full, `${prefix}/${entry}`))
      continue
    }
    if (!st.isFile()) continue
    if (!entry.endsWith('.tsx') && !entry.endsWith('.ts')) continue
    const base = entry.replace(/\.(tsx|ts)$/, '')
    if (base === '_layout') continue
    if (base === 'index') {
      routes.push(prefix.length === 0 ? '/' : prefix)
    } else {
      routes.push(`${prefix}/${base}`)
    }
  }
  return routes
}

/**
 * Match a concrete request path (e.g. `/projects/demo/tasks`) against
 * an Expo Router segment route (e.g. `/projects/[id]/tasks`). The
 * dynamic segments must match exactly one non-empty path component.
 */
function pathMatchesRoute(reqPath: string, routePath: string): boolean {
  const reqParts = reqPath.split('/').filter((p) => p.length > 0)
  const routeParts = routePath.split('/').filter((p) => p.length > 0)
  if (reqParts.length !== routeParts.length) return false
  for (let i = 0; i < routeParts.length; i += 1) {
    const route = routeParts[i]!
    const req = reqParts[i]!
    if (route.startsWith('[') && route.endsWith(']')) {
      if (req.length === 0) return false
      continue
    }
    if (route !== req) return false
  }
  return true
}
