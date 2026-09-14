/**
 * Terminal-build wake wiring at the Open composition boundary.
 *
 * The DELETE-card test boots the full composition and proves the board
 * terminator wakes the durable decision loop: the run is stopped, its raw
 * `agent_waked_at` completion is written, and exactly one discriminating wake reply
 * reaches the originating socket. The source-scoped assertions cover the
 * codegen bind, tick-loop pass, and single construction using the honest
 * coverage precedent established by `codegen-cancel-composition.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SupervisedLoop } from '@neutronai/loop'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { LIVE_AGENT_TOOL_NAMES } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { WorkBoardStore, workBoardScopeKey } from '@neutronai/work-board/store.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const SRC = readFileSync(join(HERE, '..', 'composer.ts'), 'utf8')
const OWNER_BEARER = 'nbt_terminal-build-wake-owner-bearer-0123456789'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
const wakeDispatches: Array<{
  instance_id: string
  project_id: string | undefined
  tool_bridge: boolean
  tool_names: string[]
}> = []

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function recordingSubstrate(opts: ClaudeCodeSubstrateOptions): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      if (opts.substrate_instance_id.includes('arbiter')) decisionOrder.push('arbiter')
      if (spec.prompt.includes('[TERMINAL BUILD WAKE]')) {
        decisionOrder.push('project')
        wakeDispatches.push({
          instance_id: opts.substrate_instance_id,
          project_id: opts.project_id,
          tool_bridge: opts.enableToolBridge === true,
          tool_names: spec.tools.map((tool) => tool.name),
        })
      }
      async function* events(): AsyncGenerator<Event> {
        if (spec.prompt.includes('[TERMINAL BUILD WAKE]')) {
          await wakeGate
          if (failWake) throw new Error('project temporarily unavailable')
        }
        yield { kind: 'token', text: spec.prompt.includes('[TERMINAL BUILD WAKE]') ? wakeReply : 'ok' }
        if (spec.prompt.includes('[TERMINAL BUILD WAKE]')) wakeFinished = true
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock',
        }
      }
      return {
        events: events(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

interface Harness {
  base: string
  db: ProjectDb
  close(): Promise<void>
}

interface OpenSocket {
  ws: WebSocket
  frames: Array<Record<string, unknown>>
  close(): void
}

let harness: Harness | null = null
let releaseWake: (() => void) | undefined
let wakeGate: Promise<void> | undefined
let wakeFinished = false
let failWake = false
let wakeReply = 'WAKE-ACT-1'
const decisionOrder: string[] = []

beforeEach(() => {
  wakeDispatches.length = 0
  decisionOrder.length = 0
  failWake = false
  wakeReply = 'WAKE-ACT-1'
  wakeGate = undefined
  releaseWake = undefined
  wakeFinished = false
  savedEnv = {}
  for (const key of SAVED_ENV_KEYS) savedEnv[key] = process.env[key]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-terminal-build-wake-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-terminal-build-wake'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(async () => {
  releaseWake?.()
  if (harness !== null) {
    await harness.close()
    harness = null
  }
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

async function startHarness(): Promise<Harness> {
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const composer = buildOpenGraphComposer({
    env: process.env,
    ownerBearer: OWNER_BEARER,
    substrateFactory: (opts: ClaudeCodeSubstrateOptions) => recordingSubstrate(opts),
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) throw new Error('no fetch/ws')
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, bunServer) => graph.fetch!(request, bunServer),
    websocket: graph.websocket,
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    db,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try { cleanup() } catch { /* best-effort test cleanup */ }
      }
      await graph.shutdown()
      db.close()
    },
  }
}

async function openSocket(base: string): Promise<OpenSocket> {
  const ws = new WebSocket(
    `${base.replace(/^http/, 'ws')}/ws/app/chat?token=${encodeURIComponent(OWNER_BEARER)}&platform=web&device_id=devA`,
  )
  const frames: Array<Record<string, unknown>> = []
  ws.onmessage = (event) => {
    try { frames.push(JSON.parse(String(event.data)) as Record<string, unknown>) } catch { /* */ }
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (event) => reject(new Error(`ws error: ${JSON.stringify(event)}`))
  })
  return { ws, frames, close: () => ws.close() }
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

async function seedProject(db: ProjectDb, id: string): Promise<void> {
  await db.run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, ?, 'private', 'personal', ?, ?)`,
    [id, id.toUpperCase(), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
  )
}

const wakeFrames = (frames: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
  frames.filter(
    (frame) => frame['type'] === 'agent_message'
      && typeof frame['body'] === 'string'
      && frame['body'].includes('WAKE-ACT-1'),
  )

describe('Open terminal-build wake observer wiring', () => {
  test('board termination claims and posts exactly one wake turn to the originating chat', async () => {
    harness = await startHarness()
    await seedProject(harness.db, 'acme')
    const scope = workBoardScopeKey('owner', 'acme')
    const runStore = new TridentRunStore(harness.db)
    const run = await runStore.create({
      slug: 'wake-cancelled-build',
      project_slug: scope,
      repo_path: '/tmp/repo',
      task: 'wake after cancellation',
      chat_id: 'app:owner',
      channel_kind: 'app_socket',
    })
    const boardStore = new WorkBoardStore(harness.db)
    const item = await boardStore.create(scope, { title: 'Wake cancelled build' })
    await boardStore.bindRun(scope, item.id, run.id)

    const sock = await openSocket(harness.base)
    await waitFor(() => sock.frames.some((frame) => frame['type'] === 'session_ready'))

    const response = await fetch(`${harness.base}/api/app/projects/acme/work-board/${item.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${OWNER_BEARER}` },
    })
    expect(response.status).toBe(200)
    await waitFor(() => runStore.get(run.id)?.phase === 'stopped')

    const readWakeClaim = (): number | null => {
      const row = harness!.db.raw().prepare(
        'SELECT agent_waked_at AS w FROM code_trident_runs WHERE id = ?',
      ).get(run.id) as { w: number | null } | null
      return row?.w ?? null
    }
    await waitFor(() => readWakeClaim() !== null)
    const firstClaim = readWakeClaim()
    await waitFor(() => wakeFrames(sock.frames).length === 1)

    const agentMessagesBefore = sock.frames.filter((frame) => frame['type'] === 'agent_message').length
    sock.ws.send(JSON.stringify({
      v: 1,
      type: 'user_message',
      body: 'barrier',
      client_msg_id: 'terminal-wake-barrier-1',
    }))
    await waitFor(
      () => sock.frames.filter((frame) => frame['type'] === 'agent_message').length > agentMessagesBefore,
    )
    expect(wakeFrames(sock.frames)).toHaveLength(1)
    expect(readWakeClaim()).toBe(firstClaim)
    expect(wakeDispatches).toHaveLength(1)
    expect(wakeDispatches[0]!.instance_id.startsWith('cc-agent-')).toBe(true)
    expect(wakeDispatches[0]!.tool_bridge).toBe(true)
    expect(wakeDispatches[0]!.tool_names).toEqual([...LIVE_AGENT_TOOL_NAMES])

    sock.close()
    await sleep(50)
  }, 30_000)

  test('terminal wake uses the project conversation in the production graph without a socket', async () => {
    seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
    const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
    const composition = await buildOpenGraphComposer({
      env: process.env, ownerBearer: OWNER_BEARER,
      substrateFactory: recordingSubstrate,
    })({ db, project_slug: 'owner' })
    try {
      await seedProject(db, 'acme')
      const runs = new TridentRunStore(db)
      const run = await runs.create({ slug: 'project-wake', project_slug: workBoardScopeKey('owner', 'acme'),
        repo_path: '/tmp/repo', task: 'terminal decision', chat_id: 'app:owner', channel_kind: 'app_socket' })
      await runs.update(run.id, { phase: 'failed' })
      wakeGate = new Promise<void>((resolve) => { releaseWake = resolve })
      const observe = composition.trident?.on_terminal_wake
      expect(observe).toBeDefined()
      await observe!({ ...run, phase: 'failed' })
      await observe!({ ...run, phase: 'failed' })
      await waitFor(() => wakeDispatches.length === 1)
      expect(wakeFinished).toBe(false)
      expect(runs.agentWakeCompleted(run.id)).toBe(false)
      expect(runs.listPendingAgentWakes().map(r => r.id)).toContain(run.id)
      const decisionLoop = composition.loop_registry!.list().find(loop => loop.name === 'terminal-build-decisions')
      expect(decisionLoop?.isActive?.()).toBe(true)
      expect(decisionLoop?.cadenceMs).toBe(60_000)
      releaseWake!()
      await waitFor(() => wakeFinished)
      const replies = () => db.all<{ topic_id: string }>(
        'SELECT topic_id FROM button_prompts WHERE body = ?', ['WAKE-ACT-1'],
      )
      await waitFor(() => replies().length === 1)
      expect(replies()).toEqual([{ topic_id: 'app:owner' }])
      expect(wakeDispatches).toHaveLength(1)
      expect(wakeDispatches[0]!.instance_id).toBe('cc-agent-owner')
      expect(wakeDispatches[0]!.project_id).toBe('acme')
      expect(wakeDispatches[0]!.tool_bridge).toBe(true)
      expect(wakeDispatches[0]!.tool_names).toEqual([...LIVE_AGENT_TOOL_NAMES])
    } finally {
      releaseWake?.()
      for (const cleanup of composition.realmode_cleanups ?? []) await cleanup()
      db.close()
    }
  }, 30_000)

  test('the armed gateway sweep re-admits persisted questions without another terminal event', async () => {
    seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
    const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
    await seedProject(db, 'acme')
    const runs = new TridentRunStore(db)
    const run = await runs.create({ slug: 'restart-question', project_slug: workBoardScopeKey('owner', 'acme'),
      repo_path: '/tmp/repo', task: 'Which behavior?', chat_id: 'app:owner', channel_kind: 'app_socket' })
    await runs.update(run.id, { phase: 'failed', failure_reason: 'Worker asks: Which behavior?' })
    let sweep: SupervisedLoop | undefined
    const start = SupervisedLoop.prototype.start
    const capture = spyOn(SupervisedLoop.prototype, 'start').mockImplementation(function(this: SupervisedLoop) {
      if (this.describe().name === 'terminal-build-decisions') sweep = this
      return start.call(this)
    })
    const composition = await buildOpenGraphComposer({ env: process.env, ownerBearer: OWNER_BEARER,
      substrateFactory: recordingSubstrate })({ db, project_slug: 'owner' })
    capture.mockRestore()
    try {
      expect(sweep?.describe().isActive?.()).toBe(true)
      failWake = true
      await sweep!.runOnce()
      expect(runs.listPendingAgentWakes().map(r => r.id)).toEqual([run.id])
      failWake = false
      wakeReply = 'Project asks: Which behavior should remain?'
      await sweep!.runOnce()
      expect(runs.agentWakeCompleted(run.id)).toBe(true)
      expect(decisionOrder).toEqual(['arbiter', 'project', 'arbiter', 'project'])
      expect(db.all<{ topic_id: string }>('SELECT topic_id FROM button_prompts WHERE body = ?', [wakeReply]))
        .toEqual([{ topic_id: 'app:owner' }])
    } finally {
      for (const cleanup of composition.realmode_cleanups ?? []) await cleanup()
      db.close()
    }
  }, 30_000)

  test('the observer is constructed once and registered at every composition site', () => {
    expect((SRC.match(/terminalBuildWake/g) ?? []).length).toBe(4)
    expect(SRC.includes('buildTerminalBuildWakeObserver(')).toBe(true)
    expect(SRC.split('buildTerminalBuildWakeObserver(').length).toBe(2)
    expect(SRC.includes('on_terminal_wake: terminalBuildWake')).toBe(true)
  })
})
