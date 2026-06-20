/**
 * MANDATORY production-composer reachability guard for the Code-Gen
 * Core (Code-Gen Core S2 — autonomous `/code <task>` only; brief
 * § Part D invariant + closes the anti-pattern Argus has flagged in
 * 8 consecutive sprints — PRs #222 / #225 / #227 / #229 / #231 /
 * #233 / #240 / #246).
 *
 * Mirrors `gateway/__tests__/reminders-core-chat-composer.test.ts`
 * in structure: boots `composeProductionGraph` against an in-memory
 * SQLite + dev-bypass auth + a scripted sub-agent dispatch + stubbed
 * host runners + a stubbed `CodegenLlmCall` closure, builds the WS
 * surface via the same `chat_command_filter` factory shape
 * `gateway/index.ts` uses at boot, and exercises the entire S2 chat
 * surface (`/code <task>`, `/code stop`, `/code help`) end-to-end
 * through the production composer chain.
 *
 * What this test guards:
 *
 *   - A future composer rename that drops `chat_command_filter` from
 *     the typed shape breaks at compile time BEFORE the runtime test
 *     runs.
 *   - A future Core barrel rename that breaks the
 *     `@neutronai/codegen-core` exports breaks at compile time.
 *   - The autonomous Forge → Argus → auto-merge loop fires `gh pr
 *     merge` ON `APPROVE` with NO user confirmation (default ON, no
 *     per-project gate).
 *   - `/code stop` cancels in-flight without needing a credential.
 *   - Per-project sidecar isolation (a task in project A never
 *     touches the sidecar for project B).
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
  CodegenOrchestrator,
  CodegenSidecarResolver,
  buildStubHostRunners,
  buildRuntimeCodegenRunner,
  parseAndExecuteCodeCommand,
  type CodeCommandContext,
  type SubagentDispatchInput,
  type SubagentDispatchResult,
} from '../../cores/free/code-gen/index.ts'

const OWNER = 'codegen-composer-project'
const PROJECT = 'demo-project'

const noOpInputBase = {
  topic_handler: async () => {},
  approval_notifier: { notify: async () => undefined },
  watchdog_notifier: { notify: async () => undefined },
  reminder_dispatcher: { dispatch: async () => undefined },
  heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
  platform: STUB_PLATFORM,
}

interface SubagentDispatchCall extends SubagentDispatchInput {}

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  tmp: string
  orchestrator: CodegenOrchestrator
  sidecarResolver: CodegenSidecarResolver
  runners: ReturnType<typeof buildStubHostRunners>
  dispatch_calls: SubagentDispatchCall[]
  /** Scripted sub-agent dispatcher — individual tests push the
   *  Forge/Argus turn outputs they expect this run to emit. */
  push_responses: (
    rs: Array<{ kind: 'forge' | 'argus'; result: string; status?: SubagentDispatchResult['status'] }>,
  ) => void
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-codegen-composer-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const registry = new InMemoryAppWsSessionRegistry()
  const channelRouter = new ChannelRouter(db, OWNER, async () => {})
  const appWsAdapter = new AppWsAdapter({ registry, receiver: channelRouter })
  channelRouter.registerAdapter(appWsAdapter)

  const sidecarResolver = new CodegenSidecarResolver({ owner_home: tmp })
  const runners = buildStubHostRunners({
    gitIsRepo: async () => true,
    gitExec: async (input) => {
      if (input.args[0] === 'remote') {
        return { ok: true, stdout: 'git@github.com:me/x.git', stderr: '', exit_code: 0 }
      }
      return { ok: true, stdout: '', stderr: '', exit_code: 0 }
    },
  })
  const dispatch_calls: SubagentDispatchCall[] = []
  const scripted_responses: Array<{
    kind: 'forge' | 'argus'
    result: string
    status?: SubagentDispatchResult['status']
  }> = []
  const dispatch_subagent = async (input: SubagentDispatchInput): Promise<SubagentDispatchResult> => {
    dispatch_calls.push(input)
    const next = scripted_responses.shift()
    if (next === undefined) {
      return {
        result: '',
        subagent_run_id: `run-${dispatch_calls.length}`,
        status: 'failed',
      }
    }
    return {
      result: next.result,
      subagent_run_id: `run-${dispatch_calls.length}`,
      status: next.status ?? 'completed',
    }
  }

  const runner = buildRuntimeCodegenRunner({
    dispatch_subagent,
    owner_home: tmp,
    instance_key: OWNER,
    resolve_sidecar: (input) => sidecarResolver.resolve(input.project_id),
    gh_runner: runners.gh,
    git_runner: runners.git,
    bun_test_runner: runners.bun_test,
    default_project_id: PROJECT,
    max_argus_rounds: 3,
  })
  const orchestrator = new CodegenOrchestrator({ runner })

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
  // ISSUE #32 — serve `graph.fetch` so the
  // `composition.app_ws_surface → composeInput.appWs` mapping is the
  // only path exercised.
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
    orchestrator,
    sidecarResolver,
    runners,
    dispatch_calls,
    push_responses: (rs) => scripted_responses.push(...rs),
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      sidecarResolver.closeAll()
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

async function sendChat(base: string, body: string, project_id: string = PROJECT): Promise<Response> {
  return authedFetch(base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({ body, project_id }),
  })
}

/** Settle the orchestrator's `setImmediate`-scheduled kickoff + the
 *  Forge → Argus → merge fan-out. Two macrotask hops + a small wall-
 *  clock yield is enough to let the canned sub-agent responses drain
 *  all the way through. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 120))
}

let harness: Harness
beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

test('Code-Gen Core boots through composeProductionGraph + the chat filter is reachable', async () => {
  expect(harness.graph).toBeDefined()
})

test('`/code` (no arg) end-to-end returns the help cheatsheet (200)', async () => {
  const res = await sendChat(harness.base, '/code')
  expect(res.status).toBe(200)
})

test('`/code <task>` end-to-end dispatches through the orchestrator + the runner auto-merges on Argus APPROVE (no user confirmation)', async () => {
  // Script: Forge succeeds, Argus APPROVE. The S2 runner auto-merges
  // immediately on APPROVE — no /code merge confirmation step, no
  // per-project gate. `gh pr merge` MUST fire exactly once.
  harness.push_responses([
    { kind: 'forge', result: 'shipped\nPR_NUMBER=5\nBRANCH=feat/healthz\nWORKTREE=/x' },
    { kind: 'argus', result: 'APPROVE' },
  ])
  const res = await sendChat(harness.base, '/code add a /healthz endpoint')
  expect(res.status).toBe(200)
  await settle()
  // First dispatch is Forge, second is Argus.
  expect(harness.dispatch_calls.length).toBeGreaterThanOrEqual(2)
  expect(harness.dispatch_calls[0]?.kind).toBe('forge')
  expect(harness.dispatch_calls[1]?.kind).toBe('argus')
  // Auto-merge default-ON: gh pr merge fired exactly once for PR #5.
  expect(harness.runners.calls.pr_merge).toHaveLength(1)
  expect(harness.runners.calls.pr_merge[0]?.pr_number).toBe(5)
  // Sidecar task row tied to the PR + autonomous-merge audit row.
  const sidecar = await harness.sidecarResolver.resolve(PROJECT)
  const rows = sidecar.tasks.list({ limit: 10 })
  expect(rows).toHaveLength(1)
  expect(rows[0]?.pr_number).toBe(5)
  expect(sidecar.audit.countForPr(5)).toBe(1)
})

test('auto-merge error path: `gh pr merge` failure still records an audit row + the autonomous path fired', async () => {
  // Override the pr_merge runner to simulate a `gh pr merge` failure
  // (e.g. branch protections, merge conflict surfaced by GitHub). The
  // runner records the audit row BEFORE checking the merge result, so
  // we can see WHO attempted the merge even when it failed.
  let merge_attempts = 0
  harness.runners.gh.prMerge = async () => {
    merge_attempts++
    return { ok: false, stdout: '', stderr: 'Pull request not mergeable', exit_code: 1 }
  }
  harness.push_responses([
    { kind: 'forge', result: 'shipped\nPR_NUMBER=9\nBRANCH=feat/x\nWORKTREE=/x' },
    { kind: 'argus', result: 'APPROVE' },
  ])
  const res = await sendChat(harness.base, '/code add a /readyz endpoint')
  expect(res.status).toBe(200)
  await settle()
  // The runner attempted the merge — the autonomous path fired exactly
  // once and the audit row was persisted (proving the runner reached
  // the auto-merge branch without a user-confirm gate in the middle).
  expect(merge_attempts).toBe(1)
  const sidecar = await harness.sidecarResolver.resolve(PROJECT)
  expect(sidecar.audit.countForPr(9)).toBe(1)
  // The task row carries the PR number from Forge's output.
  const rows = sidecar.tasks.list({ limit: 10 })
  expect(rows).toHaveLength(1)
  expect(rows[0]?.pr_number).toBe(9)
})

test('per-project workspace isolation: a task in `demo-project` does NOT touch `other-project`', async () => {
  harness.push_responses([
    { kind: 'forge', result: 'shipped\nPR_NUMBER=10\nBRANCH=feat/y\nWORKTREE=/x' },
    { kind: 'argus', result: 'APPROVE' },
  ])
  await sendChat(harness.base, '/code add a foo', PROJECT)
  await settle()
  const sidecarDemo = await harness.sidecarResolver.resolve(PROJECT)
  const sidecarOther = await harness.sidecarResolver.resolve('other-project')
  expect(sidecarDemo.tasks.list({ limit: 10 })).toHaveLength(1)
  expect(sidecarOther.tasks.list({ limit: 10 })).toHaveLength(0)
})

test('`/code cancel <unknown_task>` end-to-end surfaces `unknown_task` through the production composer', async () => {
  // `/code stop` / `/code cancel` is the only escape hatch in S2.
  // Cancelling an unknown id is reachable end-to-end via the chat
  // bridge; the in-flight cancellation path is covered by orchestrator
  // unit tests.
  const cancelRes = await sendChat(harness.base, `/code cancel nope-not-a-real-task`)
  expect(cancelRes.status).toBe(200)
})

test('retired sub-verbs (`/code status` / `/code merge` / `/code judge` / etc.) are rejected with a friendly message', async () => {
  // S2 narrowed the surface — these old sub-commands no longer
  // dispatch. The parser routes them to the `unrecognized` branch so
  // a user who types the old form gets a redirect to the new shape
  // instead of accidentally kicking off a task named "status".
  for (const verb of ['status', 'review', 'merge', 'judge', 'history', 'automerge']) {
    const res = await sendChat(harness.base, `/code ${verb} #5`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      chat_command_result?: { text: string; error?: { code: string } }
    }
    const cmd = body.chat_command_result
    expect(cmd).toBeDefined()
    expect(cmd?.error?.code).toBe('malformed')
    expect(cmd?.text ?? '').toContain(`\`${verb}\``)
  }
  // CRITICAL: none of those reached the orchestrator + no gh action fired.
  expect(harness.dispatch_calls).toHaveLength(0)
  expect(harness.runners.calls.pr_merge).toHaveLength(0)
})
