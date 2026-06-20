/**
 * Trident-port PR-1 (2026-06-19) — production-boot REAL-runner guard.
 *
 * The Trident-port diagnostic flagged that the production `/code` boot
 * path can silently fall to `buildSkeletonCodegenRunner()` (every task
 * fails with `CodegenNotConfiguredError`) when the composer forgets to
 * thread a real `CodegenOrchestrator` — even on a credentialed instance
 * where the real Forge → Argus → merge loop COULD run.
 *
 * PR-1 closes the drift by consolidating the three-step wiring chain
 * (credential factory → `buildCodegenWiring` → chat filter) into ONE
 * gateway-side entrypoint, `buildProductionCodegenCoreWiring(...)`, that
 * the composer threads in a single call (mirrors the Research Core's
 * `buildProductionResearchCoreWiring`).
 *
 * This test boots `composeProductionGraph` through THAT entrypoint and
 * proves `/code <task>` dispatches through the REAL runtime runner: it
 * runs the autonomous loop, Argus APPROVEs, and `gh pr merge` fires
 * exactly once with a durable sidecar task row + audit row. The matching
 * SKELETON control proves the assertions actually discriminate — wiring
 * the pre-fix skeleton orchestrator the SAME way produces ZERO merges and
 * ZERO sidecar rows, so this test FAILS against the skeleton path.
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { AppWsAdapter } from '../../channels/adapters/app-ws/adapter.ts'
import { InMemoryAppWsSessionRegistry } from '../../channels/adapters/app-ws/session-registry.ts'
import { ChannelRouter } from '../../channels/router.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../composition.ts'
import {
  createAppWsSurface,
  type ChatCommandFilter,
  type ChatCommandFilterResult,
} from '../http/app-ws-surface.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

import {
  CodegenOrchestrator,
  CodegenSidecarResolver,
  buildSkeletonCodegenRunner,
  buildStubHostRunners,
  parseAndExecuteCodeCommand,
  type CodeCommandContext,
  type CodegenChatNotifier,
} from '../../cores/free/code-gen/index.ts'
import {
  buildProductionCodegenCoreWiring,
  type ProductionCodegenCoreWiring,
} from '../cores/build-production-codegen-wiring.ts'
import type {
  CodegenAnthropicClient,
  CodegenAnthropicFactory,
} from '../cores/code-gen-factory.ts'

const OWNER = 'codegen-prod-wiring-project'
const PROJECT = 'demo-project'

const noOpInputBase = {
  topic_handler: async () => {},
  approval_notifier: { notify: async () => undefined },
  watchdog_notifier: { notify: async () => undefined },
  reminder_dispatcher: { dispatch: async () => undefined },
  heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
  platform: STUB_PLATFORM,
}

const noOpNotifier: CodegenChatNotifier = {
  async notifyTaskComplete() {
    /* terminal notification is a no-op for this guard */
  },
}

/**
 * Scripted Forge → Argus turn pair. Forge first: emits the PR triple
 * (`PR_NUMBER=` / `BRANCH=` / `WORKTREE=`) with `stop_reason:'end_turn'`
 * and no tool calls so the substrate adapter terminates the loop
 * immediately. Argus next: `APPROVE`. The runtime runner then auto-merges
 * via the gh stub.
 */
function recordingAnthropicFactory(): {
  factory: CodegenAnthropicFactory
  callCount: () => number
} {
  let n = 0
  const factory: CodegenAnthropicFactory = () => {
    const client: CodegenAnthropicClient = {
      messages: {
        async create() {
          n += 1
          if (n === 1) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    'shipped the change\n' +
                    'PR_NUMBER=42\n' +
                    'BRANCH=feat/prod-wiring-real-runner\n' +
                    'WORKTREE=/tmp/ws',
                },
              ],
              stop_reason: 'end_turn',
              model: 'claude-sonnet-4-6',
            }
          }
          return {
            content: [{ type: 'text', text: 'APPROVE' }],
            stop_reason: 'end_turn',
            model: 'claude-sonnet-4-6',
          }
        },
      },
    }
    return client
  }
  return { factory, callCount: () => n }
}

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  tmp: string
  runners: ReturnType<typeof buildStubHostRunners>
  /** Sidecar resolver used by the wired `/code` path — for row assertions. */
  sidecarResolver: CodegenSidecarResolver
  /** Set on the real-wiring harness; undefined on the skeleton control. */
  wiring?: ProductionCodegenCoreWiring
  factoryCallCount: () => number
  close(): Promise<void>
}

function buildStubRunners(): ReturnType<typeof buildStubHostRunners> {
  return buildStubHostRunners({
    gitIsRepo: async () => true,
    gitExec: async (input) => {
      if (input.args[0] === 'remote') {
        return { ok: true, stdout: 'git@github.com:me/x.git', stderr: '', exit_code: 0 }
      }
      return { ok: true, stdout: '', stderr: '', exit_code: 0 }
    },
  })
}

/**
 * Boot `composeProductionGraph` with a `/code` chat filter sourced from
 * `buildProductionCodegenCoreWiring` — i.e. the SINGLE entrypoint the
 * production composer calls. BYO env credential so the loop runs end-to-end.
 */
async function buildRealHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-codegen-prodwire-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const registry = new InMemoryAppWsSessionRegistry()
  const channelRouter = new ChannelRouter(db, OWNER, async () => {})
  const appWsAdapter = new AppWsAdapter({ registry, receiver: channelRouter })
  channelRouter.registerAdapter(appWsAdapter)

  const runners = buildStubRunners()
  const rec = recordingAnthropicFactory()

  const wiring = await buildProductionCodegenCoreWiring({
    project_slug: OWNER,
    oauth_source: null,
    env: { NEUTRON_ANTHROPIC_API_KEY: 'sk-test-prod-wiring' },
    anthropic_factory: rec.factory,
    owner_home: tmp,
    instance_key: OWNER,
    gh_runner: runners.gh,
    git_runner: runners.git,
    bun_test_runner: runners.bun_test,
    chat_notifier: noOpNotifier,
    default_project_id: PROJECT,
    max_argus_rounds: 1,
    subagent_timeout_ms: 30_000,
  })

  const wsSurface = createAppWsSurface({
    adapter: appWsAdapter,
    registry,
    auth,
    project_slug: OWNER,
    chat_command_filter: wiring.chat_command_filter,
  })

  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_ws_surface: { handler: wsSurface.handler, websocket: wsSurface.websocket },
    channel_router: channelRouter,
  })
  assertServeable(graph)
  const composedFetch = graph.fetch!
  const composedWebsocket = graph.websocket!
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
    tmp,
    runners,
    sidecarResolver: wiring.sidecar_resolver,
    wiring,
    factoryCallCount: rec.callCount,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      wiring.sidecar_resolver.closeAll()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/**
 * Pre-fix CONTROL: boot the SAME graph but wire the `/code` filter to a
 * SKELETON-runner orchestrator (exactly what `buildCoresBackendFactories`
 * falls to when the composer omits `codegenOrchestrator`). Proves the
 * real-runner assertions discriminate: this path NEVER merges + writes no
 * sidecar rows because the skeleton runner throws.
 */
async function buildSkeletonHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-codegen-skel-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const registry = new InMemoryAppWsSessionRegistry()
  const channelRouter = new ChannelRouter(db, OWNER, async () => {})
  const appWsAdapter = new AppWsAdapter({ registry, receiver: channelRouter })
  channelRouter.registerAdapter(appWsAdapter)

  const runners = buildStubRunners()
  const sidecarResolver = new CodegenSidecarResolver({ owner_home: tmp })
  const orchestrator = new CodegenOrchestrator({ runner: buildSkeletonCodegenRunner() })

  const chat_command_filter: ChatCommandFilter = {
    async match(input) {
      const trimmed = input.body.trimStart()
      if (!trimmed.startsWith('/code')) return null
      const ctx: CodeCommandContext = {
        orchestrator,
        resolve_sidecar: (pid) => sidecarResolver.resolve(pid),
        project_id: input.project_id ?? PROJECT,
        user_id: input.user_id,
        now: new Date(),
      }
      const response = await parseAndExecuteCodeCommand(input.body, ctx)
      if (response === null) return null
      const out: ChatCommandFilterResult = { text: response.text }
      if (response.data !== undefined) out.data = response.data
      if (response.error !== undefined) out.error = response.error
      return out
    },
  }

  const wsSurface = createAppWsSurface({
    adapter: appWsAdapter,
    registry,
    auth,
    project_slug: OWNER,
    chat_command_filter,
  })

  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_ws_surface: { handler: wsSurface.handler, websocket: wsSurface.websocket },
    channel_router: channelRouter,
  })
  assertServeable(graph)
  const composedFetch = graph.fetch!
  const composedWebsocket = graph.websocket!
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
    tmp,
    runners,
    sidecarResolver,
    factoryCallCount: () => 0,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      sidecarResolver.closeAll()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function assertServeable(graph: Awaited<ReturnType<typeof composeProductionGraph>>): void {
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error(
      'composeProductionGraph did not expose graph.fetch — production-composer reachability gap (ISSUE #32)',
    )
  }
}

async function sendChat(base: string, body: string): Promise<Response> {
  const headers = new Headers({
    authorization: 'Bearer dev:test-user',
    'content-type': 'application/json',
  })
  return fetch(`${base}/api/app/chat/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body, project_id: PROJECT }),
  })
}

/** Settle the orchestrator's `setImmediate` kickoff + the Forge → Argus →
 *  merge fan-out. Matches the cadence the sibling composer tests use. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200))
}

let harness: Harness | undefined
afterEach(async () => {
  if (harness !== undefined) {
    await harness.close()
    harness = undefined
  }
})

test('PRODUCTION path via buildProductionCodegenCoreWiring → `/code <task>` dispatches through the REAL runtime runner + auto-merges (NOT the skeleton)', async () => {
  harness = await buildRealHarness()

  // The single entrypoint resolved the BYO env credential and returned a
  // REAL orchestrator — never the skeleton.
  expect(harness.wiring?.credential_source).toBe('byo_env_api_key')

  const res = await sendChat(harness.base, '/code add a /healthz endpoint')
  expect(res.status).toBe(200)
  await settle()

  // The real loop ran end-to-end: Forge emitted the PR triple, Argus
  // APPROVE'd, and `gh pr merge` fired exactly once for PR #42. A skeleton
  // runner would have thrown `CodegenNotConfiguredError` before any merge.
  expect(harness.factoryCallCount()).toBeGreaterThanOrEqual(1)
  expect(harness.runners.calls.pr_merge).toHaveLength(1)
  expect(harness.runners.calls.pr_merge[0]?.pr_number).toBe(42)

  // Durable proof the RUNTIME runner (not the skeleton) executed: a
  // sidecar task row tied to PR #42 + the autonomous-merge audit row.
  const sidecar = await harness.sidecarResolver.resolve(PROJECT)
  const rows = sidecar.tasks.list({ limit: 10 })
  expect(rows).toHaveLength(1)
  expect(rows[0]?.pr_number).toBe(42)
  expect(sidecar.audit.countForPr(42)).toBe(1)
})

test('SKELETON CONTROL → the SAME graph wired to a skeleton orchestrator NEVER merges + writes ZERO sidecar rows (proves the guard discriminates)', async () => {
  harness = await buildSkeletonHarness()

  const res = await sendChat(harness.base, '/code add a /healthz endpoint')
  // The dispatch is accepted (fire-and-forget) — the failure surfaces
  // when the skeleton runner throws inside the scheduled kickoff.
  expect(res.status).toBe(200)
  await settle()

  // No anthropic call, no merge, and NO durable sidecar task row — the
  // skeleton runner threw `CodegenNotConfiguredError` before touching git
  // or the sidecar. These are exactly the assertions the real-path test
  // above relies on, so that test cannot pass against this skeleton path.
  expect(harness.runners.calls.pr_merge).toHaveLength(0)
  const sidecar = await harness.sidecarResolver.resolve(PROJECT)
  expect(sidecar.tasks.list({ limit: 10 })).toHaveLength(0)
})

test('NO-CREDENTIAL path → entrypoint still returns a REAL orchestrator (sentinel), `/code` short-circuits with the install hint, NOT a skeleton Tier-2 wall', async () => {
  harness = await buildRealHarnessNoCredential()

  expect(harness.wiring?.credential_source).toBe('none')

  const res = await sendChat(harness.base, '/code add a /metrics endpoint')
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    chat_command_result?: { text: string; error?: { code: string } }
  }
  const cmd = body.chat_command_result
  expect(cmd).toBeDefined()
  // `no_credential` (soft, actionable) — NOT `codegen_not_configured`
  // (the skeleton's Tier-2 wall). The SDK factory is never invoked.
  expect(cmd?.error?.code).toBe('no_credential')
  expect(cmd?.text ?? '').toMatch(/Claude Max|NEUTRON_ANTHROPIC_API_KEY/)
  await settle()
  expect(harness.factoryCallCount()).toBe(0)
  expect(harness.runners.calls.pr_merge).toHaveLength(0)
})

/** No-credential variant of the real harness (Max OAuth off + env unset). */
async function buildRealHarnessNoCredential(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-codegen-nocred-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const registry = new InMemoryAppWsSessionRegistry()
  const channelRouter = new ChannelRouter(db, OWNER, async () => {})
  const appWsAdapter = new AppWsAdapter({ registry, receiver: channelRouter })
  channelRouter.registerAdapter(appWsAdapter)

  const runners = buildStubRunners()
  const rec = recordingAnthropicFactory()

  const wiring = await buildProductionCodegenCoreWiring({
    project_slug: OWNER,
    oauth_source: null,
    env: {},
    anthropic_factory: rec.factory,
    owner_home: tmp,
    instance_key: OWNER,
    gh_runner: runners.gh,
    git_runner: runners.git,
    bun_test_runner: runners.bun_test,
    chat_notifier: noOpNotifier,
    default_project_id: PROJECT,
  })

  const wsSurface = createAppWsSurface({
    adapter: appWsAdapter,
    registry,
    auth,
    project_slug: OWNER,
    chat_command_filter: wiring.chat_command_filter,
  })

  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_ws_surface: { handler: wsSurface.handler, websocket: wsSurface.websocket },
    channel_router: channelRouter,
  })
  assertServeable(graph)
  const composedFetch = graph.fetch!
  const composedWebsocket = graph.websocket!
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
    tmp,
    runners,
    sidecarResolver: wiring.sidecar_resolver,
    wiring,
    factoryCallCount: rec.callCount,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      wiring.sidecar_resolver.closeAll()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}
