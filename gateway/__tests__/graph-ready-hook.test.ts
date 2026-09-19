import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server, WebSocketHandler } from 'bun'

import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { LoopRegistry } from '@neutronai/loop'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { replToolBridgeRef } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { composeProductionGraph, type CompositionInput } from '../composition.ts'

const OWNER = 'graph-ready-hook-test'
const NOOP_WS = { open() {}, message() {}, close() {} } as WebSocketHandler<unknown>
const FAKE_SERVER = {} as Server<unknown>

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(): {
  input: CompositionInput
  loops: LoopRegistry
  state: { coresReady: boolean; connectWired: boolean; httpMapped: boolean }
  close: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-graph-ready-'))
  const coresRoot = join(dir, 'empty-cores')
  mkdirSync(coresRoot)
  const dbPath = join(dir, 'owner.db')
  seedMigratedDb(dbPath)
  const db = ProjectDb.open(dbPath)
  const loops = new LoopRegistry()
  const state = { coresReady: false, connectWired: false, httpMapped: false }
  const connect_api: NonNullable<CompositionInput['connect_api']> = {
    auth: { receiving_instance_slug: OWNER } as NonNullable<CompositionInput['connect_api']>['auth'],
    handlers: {},
    owner_db: db,
    build_on_inbound_message_handler: ({ router, db: connectedDb, receiving_instance_slug }) => {
      expect(router).toBeDefined()
      expect(connectedDb).toBe(db)
      expect(receiving_instance_slug).toBe(OWNER)
      state.connectWired = true
      return async () => ({ ack_id: 'graph-ready-test-ack' })
    },
  }
  const landing_server: NonNullable<CompositionInput['landing_server']> = {
    fetch: async () => new Response('composed landing'),
    websocket: NOOP_WS,
  }
  const input: CompositionInput = {
    db,
    project_slug: OWNER,
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
    loop_registry: loops,
    cores: { dataDir: dir, secretsStore: new SecretsStore({ data_dir: dir, db }), rootDirs: [coresRoot] },
    on_cores_ready: ({ registry }) => {
      expect(registry.list()).toEqual([])
      state.coresReady = true
    },
    connect_api,
  }
  Object.defineProperty(input, 'landing_server', {
    enumerable: true,
    get: () => {
      state.httpMapped = true
      return landing_server
    },
  })
  return { input, loops, state, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('graph-ready hook runs after graph/Cores/Connect/tool bridge/HTTP composition and is awaited', async () => {
  const h = fixture()
  const gate = deferred()
  const entered = deferred()
  let settled = false
  let graph: Awaited<ReturnType<typeof composeProductionGraph>> | undefined
  h.input.on_graph_ready = async () => {
    expect(h.state.coresReady).toBe(true)
    expect(h.state.connectWired).toBe(true)
    expect(h.state.httpMapped).toBe(true)
    expect(h.loops.get('reminders')?.isActive?.()).toBe(true)
    expect(replToolBridgeRef.current?.listToolSchemas()).toBeDefined()
    expect(h.input.connect_api?.handlers.on_inbound_message).toBeDefined()
    entered.resolve()
    await gate.promise
  }
  const composing = composeProductionGraph(h.input).then((result) => { settled = true; return result })
  try {
    await entered.promise
    expect(settled).toBe(false)
    gate.resolve()
    graph = await composing
    expect(settled).toBe(true)
    expect(graph.composition).toBe(h.input)
    expect(graph.names()).toContain('cores')
    expect(graph.names()).toContain('repl-tool-bridge')
    expect(graph.fetch).toBeDefined()
    const response = await graph.fetch!(new Request('http://localhost/chat'), FAKE_SERVER)
    expect(await response.text()).toBe('composed landing')
  } finally {
    gate.resolve()
    if (graph !== undefined) await graph.shutdown()
    h.close()
  }
})

test('a rejected graph-ready hook rejects composition after shutting down live graph resources', async () => {
  const h = fixture()
  const failure = new Error('graph-ready rejected')
  h.input.on_graph_ready = async () => {
    expect(h.state.coresReady).toBe(true)
    expect(h.state.connectWired).toBe(true)
    expect(h.state.httpMapped).toBe(true)
    expect(h.loops.get('reminders')?.isActive?.()).toBe(true)
    expect(replToolBridgeRef.current).toBeDefined()
    throw failure
  }
  try {
    await expect(composeProductionGraph(h.input)).rejects.toBe(failure)
    for (const name of ['cron', 'reminders', 'trident', 'trident-watch', 'watchdog']) {
      expect(h.loops.get(name), `${name} must have started`).toBeDefined()
      expect(h.loops.get(name)?.isActive?.(), `${name} must stop`).toBe(false)
    }
    expect(replToolBridgeRef.current).toBeUndefined()
  } finally {
    h.close()
  }
})

test('composition without a graph-ready hook still returns a live graph', async () => {
  const h = fixture()
  let graph: Awaited<ReturnType<typeof composeProductionGraph>> | undefined
  try {
    graph = await composeProductionGraph(h.input)
    expect(graph.composition).toBe(h.input)
    expect(graph.fetch).toBeDefined()
    expect(h.loops.get('reminders')?.isActive?.()).toBe(true)
    expect(replToolBridgeRef.current).toBeDefined()
  } finally {
    if (graph !== undefined) await graph.shutdown()
    h.close()
  }
})
