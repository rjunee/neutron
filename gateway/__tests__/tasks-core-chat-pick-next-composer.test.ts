/**
 * Tasks Core S1 — production-composer reachability guard for the
 * chat-command + pick-next surfaces.
 *
 * Mirrors `gateway/__tests__/tasks-production-composer.test.ts` byte-
 * for-byte in structure. Closes the anti-pattern Argus has flagged in
 * seven consecutive sprints (PR #222 / #225 / #227 / #229 / #231 /
 * #233 / #240): a hand-rolled fixture would mount the chat-router or
 * pick-next factory in a way the production composer doesn't, leaving
 * the test green while the live gateway 404s.
 *
 * What the test guards:
 *
 *   1. `composeProductionGraph` accepts the threaded `app_tasks_surface` +
 *      `app_ws_surface` fields the Tasks Core S1 boot relies on.
 *   2. The `wrapWithTasksChatRouter` wrap reaches the AppWsAdapter
 *      receiver chain — an inbound `/api/app/chat/send` with `text=
 *      '/task <body>'` dispatches through the Tasks Core's
 *      `executeTaskCommand`, NOT the LLM path (which would land in the
 *      inner receiver and call into a `topic_handler` stub).
 *   3. The Tasks Core's `buildSubstrateTaskStoreBackend` writes its row
 *      to the same canonical TaskStore the P5.4 HTTP surface reads.
 *   4. `tasks_pick_next` dispatches end-to-end through the Core's
 *      capability-guarded tool wiring + emits the focus_score-ranked
 *      candidate.
 *   5. Cross-instance safety — a task created under instance A is NOT
 *      visible to a `tasks_pick_next` call in instance B's slug.
 *
 * If a future refactor accidentally drops the chat-router wrap, drops
 * the pick-next factory from the Cores wireup, or changes the
 * `composeHttpHandler` chain order, this test fails.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const OWNER = 'tasks-chat-composer-project'
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
  innerReceiverCalls: number
  sentEnvelopes: CapturedEnvelope[]
  registry: InMemoryAppWsSessionRegistry
  tasksDeps: TasksChatOwnerDeps
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
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-tasks-chat-composer-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  // Single canonical store, shared between the Tasks Core's adapter
  // AND the P5.4 HTTP surface. The brief's production-composer guard:
  // both surfaces dispatch through the SAME TaskStore instance.
  const canonical = new CanonicalTaskStore(db)
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const tasksSurface = createAppTasksSurface({ store: canonical, auth })

  // Tasks Core deps — substrate-backed adapter wraps the canonical
  // store; pick-next uses a deterministic stub LLM.
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

  // Wrap the inner receiver — counts inbound events that fall through
  // to the LLM path so the test can assert the `/task` short-circuit
  // worked.
  let innerReceiverCalls = 0
  const innerReceiver = {
    receive: async (_event: IncomingEvent): Promise<void> => {
      innerReceiverCalls += 1
    },
  }
  const sentEnvelopes: CapturedEnvelope[] = []
  const wrappedReceiver = wrapWithTasksChatRouter({
    inner: innerReceiver,
    deps: {
      resolve: async (slug) => (slug === OWNER ? tasksDeps : null),
    },
    resolveOwner: () => OWNER,
    replyToTopic: (topic_id, env) => {
      // Capture for assertion side; registry.send returns false when
      // no live WS is registered (the test harness has none), so the
      // capture is the only readable surface for envelope content.
      sentEnvelopes.push({ topic: topic_id, env })
      return registry.send(topic_id, env)
    },
  })

  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({
    registry,
    receiver: wrappedReceiver,
  })
  const wsSurface = createAppWsSurface({ adapter, registry, auth, project_slug: OWNER })

  // Boot the production graph with both surfaces threaded through —
  // compile-time TS error if `app_tasks_surface` or `app_ws_surface`
  // is dropped from `CompositionInput`.
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
    get innerReceiverCalls() {
      return innerReceiverCalls
    },
    sentEnvelopes,
    registry,
    tasksDeps,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  } as Harness
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

describe('Tasks Core S1 — chat-command + pick-next production composer guard', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startHarness()
  })
  afterEach(async () => {
    await harness.close()
  })

  test('boot graph: composer accepts both app_tasks_surface + app_ws_surface', () => {
    // Compile-time + runtime contract — if the test reached here,
    // `composeProductionGraph` accepted the typed fields. Argus has
    // caught this regression in 7 consecutive sprints; if the fields
    // disappear, the harness fails to compile.
    expect(harness.graph).toBeDefined()
  })

  test('POST /api/app/chat/send with `/task <body>` dispatches through Tasks Core (not LLM)', async () => {
    const callsBefore = harness.innerReceiverCalls
    const res = await authedSend(harness.base, {
      body: '/task ship the cm-engine PR',
      project_id: PROJECT,
      client_msg_id: 'c-task-1',
    })
    expect(res.status).toBe(200)
    // The chat-bridge dispatched the `/task` command — the inner
    // receiver (the LLM path) was NOT called.
    expect(harness.innerReceiverCalls).toBe(callsBefore)
    // The canonical tasks table got the row with the source tag.
    const all = harness.canonical.list({
      project_slug: OWNER,
      project_id: PROJECT,
      status: 'open',
    })
    const matching = all.find((t) => t.title === 'ship the cm-engine PR')
    expect(matching).toBeDefined()
    expect(matching?.source).toBe('@neutronai/tasks-core')

    // Cross-check: the Core's `tasks_list` tool sees it.
    const list = await harness.toolSurface.tasks_list({ project_id: PROJECT })
    expect(list.results.find((t) => t.id === matching?.id)).toBeDefined()
  })

  test('POST /api/app/chat/send with `/task list` returns the focus-ordered preview', async () => {
    // Pre-seed three open tasks at varying priority.
    const low = await harness.toolSurface.tasks_create({ title: 'low', priority: 0, project_id: PROJECT })
    const medium = await harness.toolSurface.tasks_create({ title: 'medium', priority: 2, project_id: PROJECT })
    const high = await harness.toolSurface.tasks_create({ title: 'high', priority: 3, project_id: PROJECT })

    const before = harness.sentEnvelopes.length
    const res = await authedSend(harness.base, {
      body: '/task list',
      project_id: PROJECT,
      client_msg_id: 'c-list-1',
    })
    expect(res.status).toBe(200)
    // List goes through the dispatcher; inner receiver NOT called.
    expect(harness.innerReceiverCalls).toBe(0)

    // Brief § 6 case #4: assert the response carries a ranked-results
    // envelope with all 3 ids in focus_score order (priority 3 → 2 → 0).
    expect(harness.sentEnvelopes.length).toBe(before + 1)
    const env = harness.sentEnvelopes[before]!.env as unknown as Record<string, unknown>
    expect(env['type']).toBe('agent_message')
    const meta = env['tasks_core'] as { data?: { results?: Array<{ id: string; title: string }> } }
    const results = meta?.data?.results ?? []
    expect(results.map((r) => r.id)).toEqual([high.id, medium.id, low.id])
    expect(results.map((r) => r.title)).toEqual(['high', 'medium', 'low'])
    expect(typeof env['body']).toBe('string')
    expect(env['body'] as string).toContain('open task')
  })

  test('POST /api/app/chat/send with `/task done <id>` marks the row done', async () => {
    const created = await harness.toolSurface.tasks_create({
      title: 'flush queue',
      project_id: PROJECT,
    })
    const res = await authedSend(harness.base, {
      body: `/task done ${created.id}`,
      project_id: PROJECT,
      client_msg_id: 'c-done-1',
    })
    expect(res.status).toBe(200)
    const row = harness.canonical.get(created.id)
    expect(row?.status).toBe('done')
    expect(row?.completed_at).not.toBeNull()
  })

  test('POST /api/app/chat/send with `/task focus` exercises pick-next LLM stub end-to-end', async () => {
    const top = await harness.toolSurface.tasks_create({ title: 'top focus', priority: 3, project_id: PROJECT })
    const second = await harness.toolSurface.tasks_create({ title: 'second focus', priority: 1, project_id: PROJECT })

    const before = harness.sentEnvelopes.length
    const res = await authedSend(harness.base, {
      body: '/task focus',
      project_id: PROJECT,
      client_msg_id: 'c-focus-1',
    })
    expect(res.status).toBe(200)
    expect(harness.innerReceiverCalls).toBe(0)

    // Brief § 6 case #6: assert the envelope carries the candidate +
    // rationale + alternatives.
    expect(harness.sentEnvelopes.length).toBe(before + 1)
    const env = harness.sentEnvelopes[before]!.env as unknown as Record<string, unknown>
    expect(env['type']).toBe('agent_message')
    const meta = env['tasks_core'] as {
      data?: {
        candidate?: { id: string; title: string } | null
        rationale?: string
        alternatives?: Array<{ id: string; title: string }>
      }
    }
    const data = meta?.data
    expect(data?.candidate?.id).toBe(top.id)
    expect(data?.candidate?.title).toBe('top focus')
    expect(typeof data?.rationale).toBe('string')
    expect((data?.rationale ?? '').length).toBeGreaterThan(0)
    expect(data?.alternatives?.map((a) => a.id)).toEqual([second.id])
    // The "Mark done" tap-to-complete button is wired with the postback
    // value scheme — Argus r1 fix.
    const options = env['options'] as Array<{ label: string; value: string }> | undefined
    expect(options?.find((o) => o.value === `task:done:${top.id}`)).toBeDefined()
  })

  test('POST /api/app/chat/send with `task:done:<id>` postback completes the task', async () => {
    // Tap-to-complete: simulate the Expo button-primitive submitting
    // the `option.value` (`task:done:<id>`) as the next user_message
    // body. The router decodes this as a button postback and routes
    // through executeTaskCommand({kind:'done', target:id}) — closes
    // Argus r1 BLOCKER (buttons were dead UI prior to this sprint).
    const created = await harness.toolSurface.tasks_create({
      title: 'tap me done',
      project_id: PROJECT,
    })
    expect(created.task.status).toBe('open')

    const before = harness.sentEnvelopes.length
    const res = await authedSend(harness.base, {
      body: `task:done:${created.id}`,
      project_id: PROJECT,
      client_msg_id: 'c-postback-done-1',
    })
    expect(res.status).toBe(200)
    // The postback path short-circuits the LLM exactly like /task done.
    expect(harness.innerReceiverCalls).toBe(0)

    // The canonical store flipped the row to done.
    const row = harness.canonical.get(created.id)
    expect(row?.status).toBe('done')
    expect(row?.completed_at).not.toBeNull()

    // The router emitted a confirmation envelope.
    expect(harness.sentEnvelopes.length).toBe(before + 1)
    const env = harness.sentEnvelopes[before]!.env as unknown as Record<string, unknown>
    expect(env['type']).toBe('agent_message')
    expect(env['body'] as string).toContain('Done')
    expect(env['body'] as string).toContain('tap me done')
  })

  test('POST /api/app/chat/send with `task:open:<id>` postback emits deep-link (no state change)', async () => {
    const created = await harness.toolSurface.tasks_create({
      title: 'tap me open',
      project_id: PROJECT,
    })
    const before = harness.sentEnvelopes.length
    const res = await authedSend(harness.base, {
      body: `task:open:${created.id}`,
      project_id: PROJECT,
      client_msg_id: 'c-postback-open-1',
    })
    expect(res.status).toBe(200)
    expect(harness.innerReceiverCalls).toBe(0)
    // Status unchanged — this is a pure-navigate postback.
    expect(harness.canonical.get(created.id)?.status).toBe('open')

    expect(harness.sentEnvelopes.length).toBe(before + 1)
    const env = harness.sentEnvelopes[before]!.env as unknown as Record<string, unknown>
    // ISSUE #18 — deep_link MUST be at the top level of the envelope (not
    // nested under `tasks_core`). A single client-side
    // `<ChatDeepLinkNavigator>` consumer drives navigation for every Core.
    // Argus r2 BLOCKER B2 (PR #276) — query-string form (`?task_id=<id>`)
    // resolves to the mounted flat-list route, not the unmounted nested
    // detail route.
    expect(env['deep_link']).toBe(`/projects/${PROJECT}/tasks?task_id=${created.id}`)
    // tasks_core metadata still carries `data` (task_id) but NOT deep_link.
    const meta = env['tasks_core'] as { deep_link?: string; data?: { task_id?: string } } | undefined
    expect(meta?.deep_link).toBeUndefined()
    expect(meta?.data?.task_id).toBe(created.id)
  })

  test('tasks_pick_next MCP tool dispatches end-to-end through capability-guarded wiring', async () => {
    await harness.toolSurface.tasks_create({ title: 'top priority', priority: 3, project_id: PROJECT })
    await harness.toolSurface.tasks_create({ title: 'lower priority', priority: 1, project_id: PROJECT })

    expect(harness.toolSurface.tasks_pick_next).toBeDefined()
    const out = await harness.toolSurface.tasks_pick_next!({})
    expect(out.candidate?.title).toBe('top priority')
    expect(out.audit.candidates_considered).toBe(2)
    expect(out.audit.focus_score_used).toBe(true)
    expect(out.audit.llm_model).toBe('stub-pick-next')
  })

  test('tasks_pick_next returns null candidate WITHOUT calling LLM when empty', async () => {
    let llmCalls = 0
    const adapterStore = harness.tasksDeps.store
    const pickNext = buildPickNextService({
      store: adapterStore,
      llm: {
        async rank() {
          llmCalls += 1
          return { chosen_index: 0, rationale: '', model_id: 'never' }
        },
      },
    })
    const audit = new SecretAuditLog({ db: harness.db })
    const tools = buildTasksTools({
      manifest: loadTasksManifest(),
      project_slug: OWNER,
      audit,
      store: adapterStore,
      pickNext,
    })
    const out = await tools.tasks_pick_next!({})
    expect(out.candidate).toBeNull()
    expect(llmCalls).toBe(0)
  })

  test('capability gate: stripped read capability rejects tasks_pick_next', async () => {
    const m0 = loadTasksManifest()
    const downgraded = {
      ...m0,
      capabilities: m0.capabilities.filter((c) => c !== 'read:tasks_core.db'),
    }
    const audit = new SecretAuditLog({ db: harness.db })
    const tools = buildTasksTools({
      manifest: downgraded,
      project_slug: OWNER,
      audit,
      store: harness.tasksDeps.store,
      pickNext: harness.tasksDeps.pickNext,
    })
    await expect(tools.tasks_pick_next!({})).rejects.toThrow()
  })

  test('cross-instance safety: instance B does not see instance A tasks via pick_next', async () => {
    // Seed under the primary test slug (A) via the Core's adapter.
    await harness.toolSurface.tasks_create({
      title: 'A-only',
      priority: 3,
      project_id: PROJECT,
    })

    // Build a SECOND instance adapter bound to the same DB but a
    // different project_slug; assert it sees zero rows from A.
    const OWNER_B = 'other-project'
    const adapterStoreB = buildSubstrateTaskStoreBackend({
      project_slug: OWNER_B,
      projectDb: harness.db,
      store: harness.canonical,
    })
    const pickNextB = buildPickNextService({
      store: adapterStoreB,
      llm: buildStubPickNextLlmClient(),
    })
    const audit = new SecretAuditLog({ db: harness.db })
    const toolsB = buildTasksTools({
      manifest: loadTasksManifest(),
      project_slug: OWNER_B,
      audit,
      store: adapterStoreB,
      pickNext: pickNextB,
    })
    const out = await toolsB.tasks_pick_next!({})
    expect(out.candidate).toBeNull()
    expect(out.audit.candidates_considered).toBe(0)
  })

  test('non-`/task` chat bodies fall through to the inner receiver', async () => {
    const callsBefore = harness.innerReceiverCalls
    const res = await authedSend(harness.base, {
      body: 'just a regular chat message',
      project_id: PROJECT,
      client_msg_id: 'c-normal-1',
    })
    expect(res.status).toBe(200)
    // The inner receiver (LLM path) WAS called for this body.
    expect(harness.innerReceiverCalls).toBe(callsBefore + 1)
  })
})
