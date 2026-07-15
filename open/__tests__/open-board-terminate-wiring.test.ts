/**
 * Open board terminate() wiring — the §F6a COMPOSITION-BOUNDARY gate.
 *
 * The unit tests (terminate / store / tick / work-board-surface / code-command)
 * all inject fakes, so none of them exercise the REAL production wiring: the
 * late-bound `boardTerminatorHolder.bind(...)` and the independently-reconstructed
 * `composeTerminalHook` observer chain in `open/composer.ts`. A mutation that
 * deleted the `bind(...)` would leave the facade falling back to a bare
 * `boardRunStore.update` (phase flips, but NO observers fire) while every unit
 * test stayed green (Codex r5).
 *
 * This boots the REAL Open composition over a live `Bun.serve`, seeds a Trident
 * run bound to a Work-Board card and routed to the owner's app socket, then
 * DELETEs the card through the REAL HTTP surface and asserts the observer chain
 * actually ran — the run is persisted `stopped`, its terminal DELIVERY reaches the
 * socket EXACTLY once, AND the live transition fans a fresh `projects_changed`.
 * Delivery + the rail fan are the OBSERVABLE effects that distinguish the wired
 * chokepoint from the unbound fallback (which runs no observers → zero delivery
 * frames + no post-delete rail fan → this test reds). The board-reconcile observer
 * also runs (the run's `project_slug` matches the card scope), but its effect is
 * masked here by the card delete that follows — it is asserted directly in the
 * `board-reconcile` / `code-command` unit suites.
 *
 * The substrate is MOCKED; a synthetic credential makes the live-agent /
 * work-board path compose (so the terminator actually binds).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { WorkBoardStore, workBoardScopeKey } from '@neutronai/work-board/store.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const OWNER_TOPIC = 'app:owner'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function recordingSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: 'ok' }
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'mock' }
      }
      return {
        events: gen(),
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
let harness: Harness | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-board-terminate-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-board-terminate'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(async () => {
  if (harness !== null) { await harness.close(); harness = null }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => recordingSubstrate()) as any,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) throw new Error('no fetch/ws')
  const server = Bun.serve({ port: 0, fetch: (req, srv) => graph.fetch!(req, srv), websocket: graph.websocket })
  return {
    base: `http://127.0.0.1:${server.port}`,
    db,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) { try { cleanup() } catch { /* */ } }
      await graph.shutdown()
      db.close()
    },
  }
}

interface OpenSocket {
  ws: WebSocket
  frames: Array<Record<string, unknown>>
  close(): void
}

async function openSocket(base: string): Promise<OpenSocket> {
  const wsUrl = base.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web&device_id=devA`)
  const frames: Array<Record<string, unknown>> = []
  ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data)) as Record<string, unknown>) } catch { /* */ } }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
  })
  return { ws, frames, close: () => ws.close() }
}

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

/** The `🛑 … build stopped.` terminal-delivery frames on the socket. */
const stoppedDeliveries = (frames: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
  frames.filter((f) => f['type'] === 'agent_message' && typeof f['body'] === 'string' && (f['body'] as string).includes('build stopped'))

/** Seed a project row (so the /api/app/projects/<id>/… routes resolve). */
async function seedProject(db: ProjectDb, id: string): Promise<void> {
  await db.run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, ?, 'private', 'personal', ?, ?)`,
    [id, id.toUpperCase(), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
  )
}

describe('Open board terminate() wiring (§F6a composition boundary)', () => {
  test('DELETE of a card bound to a live run cancels it AND fires terminal delivery ONCE through the real chain', async () => {
    harness = await startHarness()
    await seedProject(harness.db, 'acme')
    const scope = workBoardScopeKey('owner', 'acme')

    // A live Trident run, routed to the owner's app socket so its terminal
    // delivery is observable, bound to a Work-Board card. `project_slug` IS the
    // board scope key (as `dispatchBoardBoundBuild` sets it), so the reconcile
    // observer's `detachRun(run.project_slug, …)` targets THIS card's scope.
    const runStore = new TridentRunStore(harness.db)
    const run = await runStore.create({
      slug: 'cancel-me',
      project_slug: scope,
      repo_path: '/tmp/repo',
      task: 'wire the export button',
      chat_id: OWNER_TOPIC,
      channel_kind: 'app_socket',
    })
    const boardStore = new WorkBoardStore(harness.db)
    const item = await boardStore.create(scope, { title: 'Export button build' })
    await boardStore.bindRun(scope, item.id, run.id)

    // The owner's live socket (registers `app:owner`) — the delivery target.
    const sock = await openSocket(harness.base)
    await waitFor(() => sock.frames.some((f) => f['type'] === 'session_ready'))
    await sleep(100) // let the connect-seed projects_changed settle into the baseline
    const projectsChangedBefore = sock.frames.filter((f) => f['type'] === 'projects_changed').length

    // DELETE the card through the REAL HTTP surface → routes the cancel through
    // the bound terminate() chokepoint → the real observer chain (delivery + board
    // reconcile + skill-forge).
    const res = await fetch(`${harness.base}/api/app/projects/acme/work-board/${item.id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer dev:owner' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cancelled_run?: string; deleted?: string }
    // The atomic transition WON → the surface reports the cancellation.
    expect(body.cancelled_run).toBe(run.id)

    // The run is persisted terminal `stopped` (either writer would set this).
    await waitFor(() => runStore.get(run.id)?.phase === 'stopped')

    // THE MUTATION-KILL: the terminal DELIVERY reached the socket EXACTLY once.
    // The unbound fallback (`boardRunStore.update`) runs NO observers → zero
    // delivery frames → this assertion reds if `boardTerminatorHolder.bind` is
    // ever dropped.
    await waitFor(() => stoppedDeliveries(sock.frames).length >= 1)

    // DETERMINISTIC exactly-once (Codex r9 — no timing sleep): round-trip a user
    // message. Its agent reply arrives strictly AFTER every synchronous
    // delete-triggered frame has flushed, so a duplicate delivery (if any) is
    // already present by the time the reply lands. Then the count must still be 1.
    const agentMsgBefore = sock.frames.filter((f) => f['type'] === 'agent_message').length
    sock.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'ping', client_msg_id: 'barrier-1' }))
    await waitFor(() => sock.frames.filter((f) => f['type'] === 'agent_message').length > agentMsgBefore)
    expect(stoppedDeliveries(sock.frames).length).toBe(1)

    // Codex r7 — the out-of-band cancel ALSO fans the live transition, so the
    // rail drops the run from live_runs immediately. Assert a NEW `projects_changed`
    // frame arrived AFTER the delete (the terminator's onTransition fan), beyond the
    // connect-seed baseline.
    await waitFor(
      () => sock.frames.filter((f) => f['type'] === 'projects_changed').length > projectsChangedBefore,
    )

    sock.close()
    await sleep(50)
  }, 30_000)

  test('DELETE of a card whose run already finished reports NO cancellation and fires NO delivery', async () => {
    harness = await startHarness()
    await seedProject(harness.db, 'acme')
    const scope = workBoardScopeKey('owner', 'acme')

    const runStore = new TridentRunStore(harness.db)
    const run = await runStore.create({
      slug: 'already-done',
      project_slug: scope,
      repo_path: '/tmp/repo',
      task: 'finished build',
      chat_id: OWNER_TOPIC,
      channel_kind: 'app_socket',
    })
    // The tick loop already delivered a real terminal result.
    await runStore.save({ ...run, phase: 'done' })

    const boardStore = new WorkBoardStore(harness.db)
    const item = await boardStore.create(scope, { title: 'Finished build' })
    await boardStore.bindRun(scope, item.id, run.id)

    const sock = await openSocket(harness.base)
    await waitFor(() => sock.frames.some((f) => f['type'] === 'session_ready'))

    const res = await fetch(`${harness.base}/api/app/projects/acme/work-board/${item.id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer dev:owner' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cancelled_run?: string }
    // A finished run cancels nothing — no phantom cancellation, no re-delivery.
    expect(body.cancelled_run).toBeUndefined()
    expect(runStore.get(run.id)?.phase).toBe('done') // untouched

    // Give any (erroneous) delivery a chance to arrive, then assert none did.
    await sleep(250)
    expect(stoppedDeliveries(sock.frames).length).toBe(0)

    sock.close()
    await sleep(50)
  }, 30_000)
})
