/**
 * Code-Gen Core S2 — composer-level credential-resolution guard.
 *
 * Phase 6 of the locked plan
 * (`docs/plans/2026-05-22-002-feat-code-gen-core-s2-autonomous-plan.md`).
 *
 * Boots `composeProductionGraph` against an in-memory SQLite + dev-bypass
 * auth + the SAME `buildCodeGenLlmCall` + `buildCodegenWiring` +
 * `buildCodegenChatCommandFilter` chain `gateway/index.ts` uses at boot,
 * with an injected `anthropic_factory` stub that captures the auth
 * header on the FIRST `messages.create(...)` invocation per credential
 * configuration. Three configurations, three assertions:
 *
 *   1. Max OAuth subscription resolves → first SDK call carries
 *      `Authorization: Bearer <access_token>`.
 *   2. BYO `NEUTRON_ANTHROPIC_API_KEY` resolves → first SDK call carries
 *      `x-api-key: <key>`.
 *   3. Neither resolves → `/code <task>` short-circuits with the friendly
 *      install hint, `error.code === 'no_credential'`, and the SDK
 *      factory is never invoked.
 *
 * Distinct from `gateway/__tests__/cores/code-gen-factory.test.ts`
 * (unit-level — exercises the factory in isolation against a hand-rolled
 * `CodegenLlmCall` consumer) and from
 * `gateway/__tests__/code-gen-core-production-composer.test.ts`
 * (composer-level but bypasses the factory — scripts
 * `dispatch_subagent` directly). This file is the ONLY end-to-end
 * proof that the factory → wiring → chat-filter → orchestrator → SDK
 * chain plumbs the resolved auth header all the way through.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
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
  buildCodegenWiring,
  buildStubHostRunners,
  parseAndExecuteCodeCommand,
  type CodeCommandContext,
  type CodegenChatNotifier,
} from '../../cores/free/code-gen/index.ts'
import {
  buildCodeGenLlmCall,
  type CodegenAnthropicClient,
  type CodegenAnthropicFactory,
  type CodegenAuthHeader,
} from '../cores/code-gen-factory.ts'
import type { OAuthCredentialSource } from '../realmode-composer/resolve-llm-credentials.ts'

const OWNER = 'codegen-cred-project'
const PROJECT = 'demo-project'

const noOpInputBase = {
  topic_handler: async () => {},
  approval_notifier: { notify: async () => undefined },
  watchdog_notifier: { notify: async () => undefined },
  reminder_dispatcher: { dispatch: async () => undefined },
  heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
  platform: STUB_PLATFORM,
}

/* ============== anthropic_factory stub ============== */

/**
 * Build a recording `CodegenAnthropicFactory` that captures every
 * `auth_header` plumbed in and returns a scripted Forge → Argus turn
 * pair. Forge first: emits the PR triple (`PR_NUMBER=` / `BRANCH=` /
 * `WORKTREE=`) with `stop_reason: 'end_turn'` and no tool calls so the
 * substrate-runtime adapter terminates the loop immediately. Argus next:
 * emits `APPROVE` end_turn. The runner then auto-merges via the gh stub.
 */
function recordingAnthropicFactory(): {
  factory: CodegenAnthropicFactory
  headers: CodegenAuthHeader[]
  callCount: () => number
} {
  const headers: CodegenAuthHeader[] = []
  let n = 0
  const factory: CodegenAnthropicFactory = ({ auth_header }) => {
    headers.push(auth_header)
    const client: CodegenAnthropicClient = {
      messages: {
        async create() {
          n += 1
          // First sub-agent dispatch is Forge; emit the PR triple.
          // Second is Argus; emit APPROVE. Any subsequent calls (fix
          // rounds) repeat the same APPROVE shape — but the canned
          // single-round case never reaches them.
          const isForge = n === 1
          if (isForge) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    'shipped the change\n' +
                    'PR_NUMBER=42\n' +
                    'BRANCH=feat/cred-resolution-test\n' +
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
  return { factory, headers, callCount: () => n }
}

/* ============== harness ============== */

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  tmp: string
  runners: ReturnType<typeof buildStubHostRunners>
  headers: CodegenAuthHeader[]
  factoryCallCount: () => number
  close(): Promise<void>
}

interface BuildHarnessOptions {
  /** OAuth source — null disables the Max OAuth resolution step. */
  oauth_source: OAuthCredentialSource | null
  /** Env bag plumbed into `buildCodeGenLlmCall`. */
  env: Readonly<Record<string, string | undefined>>
}

async function buildHarness(opts: BuildHarnessOptions): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-codegen-cred-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const registry = new InMemoryAppWsSessionRegistry()
  const channelRouter = new ChannelRouter(db, OWNER, async () => {})
  const appWsAdapter = new AppWsAdapter({ registry, receiver: channelRouter })
  channelRouter.registerAdapter(appWsAdapter)

  const runners = buildStubHostRunners({
    gitIsRepo: async () => true,
    gitExec: async (input) => {
      if (input.args[0] === 'remote') {
        return { ok: true, stdout: 'git@github.com:me/x.git', stderr: '', exit_code: 0 }
      }
      return { ok: true, stdout: '', stderr: '', exit_code: 0 }
    },
  })

  // Build the credential-resolved llm_call via the SAME factory the
  // production composer uses. The injected `anthropic_factory` captures
  // every auth_header and returns scripted Forge/Argus responses.
  const rec = recordingAnthropicFactory()
  const llmResult = await buildCodeGenLlmCall({
    project_slug: OWNER,
    oauth_source: opts.oauth_source,
    env: opts.env,
    anthropic_factory: rec.factory,
  })

  const chat_notifier: CodegenChatNotifier = {
    async notifyTaskComplete() {
      /* no-op for these tests; coverage in production-composer test */
    },
  }

  // Same wiring helper the gateway boot uses.
  const wiringOpts: Parameters<typeof buildCodegenWiring>[0] = {
    llm_call: llmResult.llm_call,
    owner_home: tmp,
    instance_key: OWNER,
    gh_runner: runners.gh,
    git_runner: runners.git,
    bun_test_runner: runners.bun_test,
    chat_notifier,
    default_project_id: PROJECT,
    // Keep the loop snappy — single Argus round is enough for these
    // tests; the canned response is always APPROVE on round 1.
    max_argus_rounds: 1,
    // Wall-clock budget — tests should never come anywhere near this.
    subagent_timeout_ms: 30_000,
  }
  if (llmResult.unavailable_message !== undefined) {
    wiringOpts.unavailable_message = llmResult.unavailable_message
  }
  const wiring = buildCodegenWiring(wiringOpts)

  // Build the chat-command filter via the SAME shape `gateway/index.ts`'s
  // `buildCodegenChatCommandFilter` produces (kept in-line here to avoid
  // exporting that helper publicly just for tests).
  const chat_command_filter: ChatCommandFilter = {
    async match(input) {
      const trimmed = input.body.trimStart()
      if (!trimmed.startsWith('/code')) return null
      const ctx: CodeCommandContext = wiring.build_chat_command_context({
        project_id: input.project_id ?? PROJECT,
        user_id: input.user_id,
      })
      const response = await parseAndExecuteCodeCommand(input.body, ctx)
      if (response === null) return null
      const out: ChatCommandFilterResult = { text: response.text }
      if (response.data !== undefined) out.data = response.data
      if (response.deep_link !== undefined) out.deep_link = response.deep_link
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
    tmp,
    runners,
    headers: rec.headers,
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

async function sendChat(base: string, body: string): Promise<Response> {
  return authedFetch(base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({ body, project_id: PROJECT }),
  })
}

/** Settle the orchestrator's `setImmediate`-scheduled kickoff + the
 *  Forge → Argus → merge fan-out. Matches the cadence used by the
 *  production-composer test. */
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

/* ============== tests ============== */

test('Max OAuth subscription path → first anthropic call carries `Authorization: Bearer <access_token>`', async () => {
  const oauth_source: OAuthCredentialSource = {
    async loadAccessToken() {
      return {
        access_token: 'at-max-oauth-fixture-789',
        expires_at: Date.now() + 60 * 60_000,
      }
    },
  }
  harness = await buildHarness({ oauth_source, env: {} })

  const res = await sendChat(harness.base, '/code add a /healthz endpoint')
  expect(res.status).toBe(200)
  await settle()

  // The factory built the closure against Max OAuth; the FIRST sub-agent
  // dispatch (Forge) is also the first anthropic_factory invocation —
  // the captured header MUST be Bearer with the seeded access token.
  expect(harness.factoryCallCount()).toBeGreaterThanOrEqual(1)
  expect(harness.headers.length).toBeGreaterThanOrEqual(1)
  expect(harness.headers[0]).toEqual({
    name: 'Authorization',
    value: 'Bearer at-max-oauth-fixture-789',
  })

  // The autonomous round-trip completed — Forge emitted the PR triple,
  // Argus APPROVE'd, gh pr merge fired exactly once for PR #42.
  expect(harness.runners.calls.pr_merge).toHaveLength(1)
  expect(harness.runners.calls.pr_merge[0]?.pr_number).toBe(42)
})

test('BYO env path → first anthropic call carries `x-api-key: <key>`', async () => {
  harness = await buildHarness({
    oauth_source: null,
    env: { NEUTRON_ANTHROPIC_API_KEY: 'sk-test-byo-456' },
  })

  const res = await sendChat(harness.base, '/code add a /readyz endpoint')
  expect(res.status).toBe(200)
  await settle()

  expect(harness.factoryCallCount()).toBeGreaterThanOrEqual(1)
  expect(harness.headers.length).toBeGreaterThanOrEqual(1)
  expect(harness.headers[0]).toEqual({
    name: 'x-api-key',
    value: 'sk-test-byo-456',
  })
  // Autonomous round-trip still completed end-to-end.
  expect(harness.runners.calls.pr_merge).toHaveLength(1)
  expect(harness.runners.calls.pr_merge[0]?.pr_number).toBe(42)
})

test('No-credential path → `/code <task>` returns the friendly install hint + the SDK factory is NEVER invoked', async () => {
  // Max OAuth source disabled; env var unset. The factory builds the
  // no-credential sentinel.
  harness = await buildHarness({ oauth_source: null, env: {} })

  const res = await sendChat(harness.base, '/code add a /metrics endpoint')
  expect(res.status).toBe(200)

  const body = (await res.json()) as {
    chat_command_result?: { text: string; error?: { code: string } }
  }
  const cmd = body.chat_command_result
  expect(cmd).toBeDefined()
  expect(cmd?.error?.code).toBe('no_credential')
  expect(cmd?.text ?? '').toMatch(/Claude Max|NEUTRON_ANTHROPIC_API_KEY/)

  // Critical: the anthropic_factory was NEVER invoked — the unavailable
  // sentinel short-circuits at `executeDispatch` BEFORE the orchestrator
  // touches `llm_call`. No `gh pr merge` either.
  await settle()
  expect(harness.factoryCallCount()).toBe(0)
  expect(harness.headers).toHaveLength(0)
  expect(harness.runners.calls.pr_merge).toHaveLength(0)
})

test('No-credential + empty env value → still no-credential (empty string is NOT a valid BYO key)', async () => {
  harness = await buildHarness({
    oauth_source: null,
    env: { NEUTRON_ANTHROPIC_API_KEY: '' },
  })

  const res = await sendChat(harness.base, '/code add a /version endpoint')
  expect(res.status).toBe(200)

  const body = (await res.json()) as {
    chat_command_result?: { text: string; error?: { code: string } }
  }
  expect(body.chat_command_result?.error?.code).toBe('no_credential')
  await settle()
  expect(harness.factoryCallCount()).toBe(0)
  expect(harness.runners.calls.pr_merge).toHaveLength(0)
})

test('OAuth source present but returns null → falls through to env (env wins when set)', async () => {
  const oauth_source: OAuthCredentialSource = {
    async loadAccessToken() {
      return null
    },
  }
  harness = await buildHarness({
    oauth_source,
    env: { NEUTRON_ANTHROPIC_API_KEY: 'sk-fallback-1' },
  })

  const res = await sendChat(harness.base, '/code add a /foo')
  expect(res.status).toBe(200)
  await settle()

  expect(harness.factoryCallCount()).toBeGreaterThanOrEqual(1)
  expect(harness.headers[0]).toEqual({
    name: 'x-api-key',
    value: 'sk-fallback-1',
  })
})
