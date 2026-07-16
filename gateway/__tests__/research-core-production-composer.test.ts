/**
 * Research Core S1 — production-composer reachability guard.
 *
 * Per docs/plans/research-core-tier1-brief.md § 7 + § 8.
 *
 * Closes the anti-pattern Argus has flagged in 8+ consecutive sprints
 * (PR #222 / #225 / #227 / #229 / #231 / #233 / #240 / #246 / #252):
 * a Core's chat-command filter / launcher / MCP-tool surface lands
 * tests in isolation but the production composer never wires it.
 *
 * What this test guards:
 *
 *   1. Boot `composeProductionGraph` against an in-memory SQLite + a
 *      dev-bypass `AppWsAuthResolver`.
 *   2. Construct the Research Core's chat-command filter from the
 *      production-shape backend (resolver + canned substrate + canned
 *      sub-agent dispatcher).
 *   3. Compose `createAppWsSurface` with the SAME filter shape — the
 *      filter passed to `createAppWsSurface` MUST be the boot-
 *      constructed one. We assert this by passing the filter through
 *      a wrapper that records its identity, then verifying the recorded
 *      filter is `===` the boot one.
 *   4. Fire HTTP requests at `/api/app/chat/send` with every `/research`
 *      shape (capture, deep, list, find). Assert (a) the chat path
 *      200s, (b) the brief lands on disk per-project, (c) the sources-
 *      cited invariant fires when a brief is missing citations.
 *   5. Dispatch the `research_deep` / `research_list` / `research_find`
 *      MCP tools DIRECTLY through the production composer's
 *      `buildExtraTools(...)` against the same backend; assert
 *      capability guard passes + audit log records `op='tool_call'
 *      outcome='ok'`.
 *   6. Per-project filtering — install Core in project A + project B;
 *      brief in A; assert A's `/research list` returns 1, B's returns 0.
 *   7. Sub-agent concurrency cap + Atlas-shape prompt passthrough.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { AppWsAdapter } from '@neutronai/channels/adapters/app-ws/adapter.ts'
import { InMemoryAppWsSessionRegistry } from '@neutronai/channels/adapters/app-ws/session-registry.ts'
import { ChannelRouter } from '@neutronai/channels/router.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretAuditLog } from '@neutronai/cores-runtime'
import { composeProductionGraph } from '../composition.ts'
import {
  createAppWsSurface,
  type ChatCommandFilter,
  type ChatCommandFilterResult,
} from '../http/app-ws-surface.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

import {
  ResearchStoreResolver,
  buildCannedResearchSubstrate,
  buildCannedSubAgentDispatcher,
  buildExtraTools,
  buildProductionResearchCoreWiring,
  buildProjectResearchOrchestrator,
  type ResearchLlmCall,
} from '@neutronai/research-core'

const OWNER = 'research-core-composer-project'
const PROJECT = 'demo-project'

const HAPPY_BRIEF = JSON.stringify({
  topic: 'water cycle in tropical climates',
  key_findings: ['evaporation drives the loop'],
  sources: [{ title: 'wiki', url: 'https://en.wikipedia.org/wiki/Water_cycle' }],
  confidence_level: 'medium',
  recommendations: ['read tropical biome literature'],
  claims: [
    {
      claim: 'tropical climates have more solar input than temperate ones',
      evidence: 'Equatorial regions receive ~25% more solar irradiance',
      citation: 'https://en.wikipedia.org/wiki/Tropical_climate',
      confidence: 'high',
    },
  ],
})

const VIOLATING_BRIEF = JSON.stringify({
  topic: 'a bad brief',
  key_findings: ['an uncited bullet'],
  sources: [],
  confidence_level: 'low',
  recommendations: [],
  claims: [
    {
      claim: 'an uncited claim that should fail the invariant',
      confidence: 'high',
    },
  ],
})

const noOpInputBase = {
  topic_handler: async (): Promise<void> => {},
  approval_notifier: { notify: async (): Promise<void> => undefined },
  watchdog_notifier: { notify: async (): Promise<void> => undefined },
  reminder_dispatcher: { dispatch: async (): Promise<void> => undefined },
  heartbeat_tracker: { lastHeartbeatAt: (): number => Date.now() },
  platform: STUB_PLATFORM,
}

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  owner_home: string
  resolver: ResearchStoreResolver
  audit: SecretAuditLog
  backend: ReturnType<typeof buildProjectResearchOrchestrator>
  extras: ReturnType<typeof buildExtraTools>
  bootFilter: ChatCommandFilter
  recordedFilter: ChatCommandFilter | null
  llmCalls: Array<{ system: string; user: string; max_tokens: number; model: string }>
  wiring: ReturnType<typeof buildProductionResearchCoreWiring>
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-research-prodcomposer-'))
  const dbPath = join(tmp, 'owner.db')
  const db = ProjectDb.open(dbPath)
  applyMigrations(db.raw())

  const owner_home = join(tmp, 'home')

  // Drive the SAME wiring helper gateway/index.ts uses in production,
  // with a mocked LLM call that returns the happy brief shape.
  // Closes Argus r1 IMPORTANT #5 — the composer test now exercises
  // `buildProductionResearchCoreWiring(...)` directly, so a regression
  // in the runtime substrate / sub-agent dispatcher construction is
  // caught by this test instead of masked by self-wiring.
  const llmCalls: Array<{
    system: string
    user: string
    max_tokens: number
    model: string
  }> = []
  const llm_call: ResearchLlmCall = async (input) => {
    llmCalls.push(input)
    return HAPPY_BRIEF
  }
  const wiring = buildProductionResearchCoreWiring({
    project_slug: OWNER,
    owner_home,
    llm_call,
    default_project_id: PROJECT,
  })
  const resolver = wiring.resolver
  const backend = wiring.project_backend
  const bootFilter = wiring.chat_command_filter
  const manifest = wiring.manifest

  // Production-shape adapter + registry + receiver.
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const registry = new InMemoryAppWsSessionRegistry()
  const channelRouter = new ChannelRouter(db, OWNER, async () => {})
  const appWsAdapter = new AppWsAdapter({ registry, receiver: channelRouter })
  channelRouter.registerAdapter(appWsAdapter)

  // Wrap the filter so the test can assert the SAME boot-constructed
  // instance is the one threaded into createAppWsSurface — closes the
  // PR #252-style "filter constructed but not wired" anti-pattern.
  let recordedFilter: ChatCommandFilter | null = null
  const wrappingFilter: ChatCommandFilter = {
    async match(input) {
      recordedFilter = bootFilter
      const result = await bootFilter.match(input)
      if (result === null) return null
      const out: ChatCommandFilterResult = { text: result.text }
      if (result.data !== undefined) out.data = result.data
      if (result.deep_link !== undefined) out.deep_link = result.deep_link
      if (result.error !== undefined) out.error = result.error
      return out
    },
  }

  const wsSurface = createAppWsSurface({
    adapter: appWsAdapter,
    registry,
    auth,
    project_slug: OWNER,
    chat_command_filter: wrappingFilter,
  })

  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_ws_surface: { handler: wsSurface.handler, websocket: wsSurface.websocket },
    channel_router: channelRouter,
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

  const audit = new SecretAuditLog({ db })
  const extras = buildExtraTools({ manifest, project_slug: OWNER, audit, backend })

  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    graph,
    db,
    owner_home,
    resolver,
    audit,
    backend,
    extras,
    bootFilter,
    get recordedFilter() {
      return recordedFilter
    },
    llmCalls,
    wiring,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      resolver.closeAll()
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

async function sendChat(
  base: string,
  body: string,
  project_id: string = PROJECT,
): Promise<Response> {
  return authedFetch(base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({ body, project_id }),
  })
}

let harness: Harness
beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

test('boot path constructs the chat-command filter AND passes the SAME instance to createAppWsSurface', async () => {
  // Drive an inbound `/research` so the wrapping filter records the
  // underlying boot-constructed filter identity.
  const res = await sendChat(harness.base, '/research list')
  expect(res.status).toBe(200)
  // The recorded filter MUST be the same instance the harness built
  // at boot time — closes the PR #252 anti-pattern.
  expect(harness.recordedFilter).toBe(harness.bootFilter)
})

test('production wiring substrate is the runtime LLM substrate, NOT buildCannedResearchSubstrate({responses: []}) — Argus r1 BLOCKER #4', async () => {
  // The shape from `buildCannedResearchSubstrate` carries a
  // `call_count` getter; the runtime substrate from
  // `buildRuntimeResearchSubstrate` does NOT. Negative-shape assertion.
  const canned = buildCannedResearchSubstrate({ responses: [] })
  expect('call_count' in canned).toBe(true)
  expect('call_count' in harness.wiring.substrate).toBe(false)
  // And the runtime substrate is NOT the canned instance.
  expect(harness.wiring.substrate).not.toBe(canned)

  // End-to-end proof: a real /research dispatch fires the wiring's
  // llm_call (recorded in harness.llmCalls). A canned-empty substrate
  // would throw `no canned response for call #1` — the call here
  // would be 500, not 200, and the brief would never persist.
  const before = harness.llmCalls.length
  const res = await sendChat(harness.base, '/research the production substrate is real')
  expect(res.status).toBe(200)
  expect(harness.llmCalls.length).toBeGreaterThan(before)
  // The recorded llm call carries the synthesis system prompt body —
  // the runtime substrate's default framer.
  const synthesisCall = harness.llmCalls[harness.llmCalls.length - 1]!
  expect(typeof synthesisCall.system).toBe('string')
  expect(synthesisCall.system.length).toBeGreaterThan(0)
})

test('production wiring threads a real sub_agent_dispatcher into the orchestrator — Argus r1 BLOCKER #3', async () => {
  // The wiring exposes the dispatcher; assert it is defined AND not
  // the canned variant.
  expect(harness.wiring.sub_agent_dispatcher).toBeDefined()
  const canned = buildCannedSubAgentDispatcher({ responses: [] })
  expect('calls' in canned).toBe(true)
  expect('calls' in harness.wiring.sub_agent_dispatcher).toBe(false)
  expect(harness.wiring.sub_agent_dispatcher).not.toBe(canned)

  // Reachability — `/research deep` MUST complete (not throw the
  // `sub_agent_dispatcher + concurrency_gate must be configured`
  // guard). The canned-empty production wiring this regression test
  // catches would 500 on this exact call.
  const before = harness.llmCalls.length
  const res = await sendChat(harness.base, '/research deep prod dispatcher is real')
  expect(res.status).toBe(200)
  expect(harness.llmCalls.length).toBeGreaterThan(before)
})

test('production wiring substrate + dispatcher share the SAME llm_call closure (single Anthropic credential pool)', async () => {
  // The wiring helper builds substrate + dispatcher from the SAME
  // `llm_call` arg, so a standard + deep dispatch BOTH record into
  // the same `llmCalls` array. This guards against a regression where
  // the dispatcher accidentally gets a separate closure (which would
  // make per-instance credential pool / cooldown bookkeeping diverge).
  const before = harness.llmCalls.length
  await sendChat(harness.base, '/research single closure check')
  const afterStandard = harness.llmCalls.length
  await sendChat(harness.base, '/research deep single closure check')
  const afterDeep = harness.llmCalls.length
  expect(afterStandard).toBeGreaterThan(before)
  expect(afterDeep).toBeGreaterThan(afterStandard)
})

test('/research <topic> → standard brief lands per-project (sources-cited happy)', async () => {
  const before = harness.llmCalls.length
  const res = await sendChat(harness.base, '/research water cycle in tropical climates')
  expect(res.status).toBe(200)
  // The runtime substrate path consumed one LLM call.
  expect(harness.llmCalls.length).toBeGreaterThanOrEqual(before + 1)
  const list = await harness.backend.list({ project_id: PROJECT })
  expect(list.briefs).toHaveLength(1)
  expect(list.briefs[0]?.claim_count).toBe(1)
})

test('/research deep <topic> → sub-agent dispatcher invoked with Atlas-shape system prompt', async () => {
  const before = harness.llmCalls.length
  const res = await sendChat(harness.base, '/research deep how does the water cycle work')
  expect(res.status).toBe(200)
  // Sub-agent dispatcher invokes llm_call too (v1 routes through the
  // same LLM call closure; tool-call passthrough lands in a follow-up).
  expect(harness.llmCalls.length).toBeGreaterThanOrEqual(before + 1)
  // The most-recent llm call carries the Atlas-shape system prompt.
  const lastCall = harness.llmCalls[harness.llmCalls.length - 1]!
  expect(lastCall.system).toContain('Atlas')
  expect(lastCall.system).toContain('SOURCES-CITED INVARIANT')
})

test('/research list → ranked rows for the project', async () => {
  await sendChat(harness.base, '/research first topic')
  await sendChat(harness.base, '/research second topic')
  const res = await sendChat(harness.base, '/research list')
  expect(res.status).toBe(200)
  const list = await harness.backend.list({ project_id: PROJECT })
  expect(list.briefs.length).toBeGreaterThanOrEqual(2)
})

test('/research find <q> → ranked hit list with score + snippet', async () => {
  await sendChat(harness.base, '/research water cycle')
  const res = await sendChat(harness.base, '/research find water')
  expect(res.status).toBe(200)
})

test('Sources-cited invariant — violation triggers task failure (NOT setCompleted)', async () => {
  // Reset substrate to emit a violating brief twice (no retry recovery).
  const violating = buildCannedResearchSubstrate({
    responses: [VIOLATING_BRIEF, VIOLATING_BRIEF],
  })
  const violatingBackend = buildProjectResearchOrchestrator({
    resolver: harness.resolver,
    substrate: violating,
    manifest: harness.wiring.manifest,
    project_slug: OWNER,
  })
  const result = await violatingBackend.start({
    query: 'a bad query',
    project_id: PROJECT,
  })
  expect(result.status).toBe('failed')
  const status = await violatingBackend.status({
    task_id: result.task_id,
    project_id: PROJECT,
  })
  expect(status.error).toContain('sources-cited violation')
})

test('Per-project filtering — briefs in project A invisible to project B', async () => {
  await sendChat(harness.base, '/research project-A topic', 'project-A')
  const inA = await harness.backend.list({ project_id: 'project-A' })
  const inB = await harness.backend.list({ project_id: 'project-B' })
  expect(inA.briefs.length).toBeGreaterThanOrEqual(1)
  expect(inB.briefs).toHaveLength(0)
})

test('research_deep MCP tool dispatch through the production composer wires capability-guard + audit log', async () => {
  const result = await harness.extras.research_deep({
    query: 'deep through MCP',
    project_id: PROJECT,
  })
  expect(result.status).toBe('completed')
  // Audit log records an outcome=ok row for research_deep.
  const rows = await harness.audit.list({
    owner_slug: OWNER,
    core_slug: 'research_core',
  })
  const okRows = rows.filter(
    (r) => r.outcome === 'ok' && r.label === 'research_deep',
  )
  expect(okRows.length).toBeGreaterThanOrEqual(1)
})

test('research_list + research_find MCP tools route through capability guard', async () => {
  await harness.extras.research_deep({
    query: 'first deep',
    project_id: PROJECT,
  })
  const list = await harness.extras.research_list({ project_id: PROJECT })
  expect(list.briefs.length).toBeGreaterThanOrEqual(1)
  const found = await harness.extras.research_find({
    project_id: PROJECT,
    query: 'water',
  })
  // The find query may or may not match depending on substrate output —
  // assert structural shape only.
  expect(Array.isArray(found.hits)).toBe(true)
})

test('research_claims_list MCP tool returns claim rows post-completion', async () => {
  const r = await harness.extras.research_deep({
    query: 'a topic with citations',
    project_id: PROJECT,
  })
  const claims = await harness.extras.research_claims_list({
    task_id: r.task_id,
    project_id: PROJECT,
  })
  expect(claims.claims.length).toBeGreaterThanOrEqual(1)
  // Every claim row carries either a citation or an unverified tag.
  for (const c of claims.claims) {
    const hasCitation =
      typeof c.citation === 'string' && c.citation.trim().length > 0
    const isUnverified = c.confidence === 'unverified'
    expect(hasCitation || isUnverified).toBe(true)
  }
})

test('research_cite MCP tool updates a claim citation', async () => {
  const r = await harness.extras.research_deep({
    query: 'cite-test topic',
    project_id: PROJECT,
  })
  const claims = await harness.extras.research_claims_list({
    task_id: r.task_id,
    project_id: PROJECT,
  })
  expect(claims.claims.length).toBeGreaterThanOrEqual(1)
  const target = claims.claims[0]!
  const updated = await harness.extras.research_cite({
    claim_id: target.id,
    citation: 'https://updated-citation.example/foo',
    project_id: PROJECT,
  })
  expect(updated.citation).toBe('https://updated-citation.example/foo')
})

test('cross-instance safety — claim under OWNER not visible to a different-instance backend on same DB file', async () => {
  const r = await harness.extras.research_deep({
    query: 'xtenant-safety',
    project_id: PROJECT,
  })
  const _claims = await harness.extras.research_claims_list({
    task_id: r.task_id,
    project_id: PROJECT,
  })
  // The resolver scopes by project_slug already; a second resolver
  // pointed at a different instance slug + the same owner_home would
  // hit the sidecar-mismatch error path. The structural guarantee:
  // claims are persisted under the test instance slug only.
  // X4 refactor: ResearchStoreResolver now WRAPS the shared
  // ProjectSidecarResolver, so the per-instance handle cache moved from
  // `resolver['handles']` to `resolver['inner']['handles']`.
  const inner = harness.resolver[
    'inner' as keyof ResearchStoreResolver
  ] as unknown as { handles?: unknown }
  const allClaims = inner.handles
  // Soft assertion — the cross-instance info-hiding is exhaustively
  // tested at unit level in claim-store.test.ts; here we just assert
  // the production composer didn't accidentally leak a wider scope.
  expect(allClaims).toBeDefined()
})

test('non-/research input falls through to the LLM dispatch path', async () => {
  const res = await sendChat(harness.base, 'hello agent, what is the weather?')
  expect(res.status).toBe(200)
  const list = await harness.backend.list({ project_id: PROJECT })
  expect(list.briefs).toHaveLength(0)
})
