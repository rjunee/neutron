/**
 * Terminal-build wake wiring at the Open composition boundary.
 *
 * The DELETE-card test boots the full composition and proves the board
 * terminator invokes the claim-first observer: the run is stopped, its raw
 * `agent_waked_at` claim is written, and exactly one discriminating wake reply
 * reaches the originating socket. The source-scoped assertions cover the
 * codegen bind, tick-loop pass, and single construction using the honest
 * coverage precedent established by `codegen-cancel-composition.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { WorkBoardStore, workBoardScopeKey } from '@neutronai/work-board/store.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function recordingSubstrate(): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      async function* events(): AsyncGenerator<Event> {
        yield { kind: 'token', text: spec.prompt.includes('[TERMINAL BUILD WAKE]') ? 'WAKE-ACT-1' : 'ok' }
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

beforeEach(() => {
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
  const db = openMigratedDbAt(process.env['NEUTRON_DB_PATH']!)
  const composer = buildOpenGraphComposer({
    env: process.env,
    ownerBearer: OWNER_BEARER,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => recordingSubstrate()) as any,
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

    sock.close()
    await sleep(50)
  }, 30_000)

  test('the observer is constructed once and registered at every composition site', () => {
    expect((SRC.match(/terminalBuildWake/g) ?? []).length).toBe(4)
    expect(SRC.includes('buildTerminalBuildWakeObserver(')).toBe(true)
    expect(SRC.split('buildTerminalBuildWakeObserver(').length).toBe(2)
    expect(SRC.includes('on_terminal_wake: terminalBuildWake')).toBe(true)
  })
})
