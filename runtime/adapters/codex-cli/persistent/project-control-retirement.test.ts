import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createConnection, createServer, type Socket } from 'node:net'
import { Database } from 'bun:sqlite'
import { inspectNativeRetirement } from './project-control-retirement.ts'
import { createProjectControlBroker, ProjectControlAdmissionRefusal, ReviewPermissionBusy } from './project-control-broker.ts'
import type { NativeProcessExit } from './project-control-broker-transport.ts'

type Rpc = Record<string, any>
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function census() {
  const calls: Rpc[] = []
  const state = {
    loaded: ['owner'], threads: new Map<string, Rpc>([['owner', { id: 'owner', sessionId: 'session', parentThreadId: null, path: '/project/rollout.jsonl', status: { type: 'idle' } }]]),
    turns: new Map<string, Rpc[]>(), terminals: new Map<string, Rpc[]>(), queues: new Map<string, Rpc[]>(), goals: new Map<string, Rpc>(),
  }
  const rpc = async (method: string, params: Rpc): Promise<any> => {
    calls.push({ method, params })
    if (method === 'thread/loaded/list') return { data: state.loaded, nextCursor: null }
    if (method === 'thread/read') return { thread: state.threads.get(params.threadId) }
    if (method === 'thread/goal/get') return { goal: state.goals.get(params.threadId) ?? null }
    const collection = method === 'thread/turns/list' ? state.turns : method === 'thread/backgroundTerminals/list' ? state.terminals : state.queues
    return { data: collection.get(params.threadId) ?? [], nextCursor: null }
  }
  const child = () => {
    state.loaded.push('child')
    state.threads.set('child', { id: 'child', sessionId: 'session', parentThreadId: 'owner', path: '/project/child.jsonl', status: { type: 'idle' } })
    state.turns.set('owner', [{ id: 'turn', status: 'completed', itemsView: 'full', items: [
      { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: 'root/child' },
      { type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child', agentPath: 'root/child' },
    ] }])
  }
  return { state, rpc, calls, child, inspect: () => inspectNativeRetirement(rpc, 'owner') }
}

test('owner and paired completed child can retire; missing child completion cannot', async () => {
  const f = census()
  expect(await f.inspect()).toEqual({ status: 'idle', rolloutPath: '/project/rollout.jsonl' })
  f.child()
  expect((await f.inspect()).status).toBe('idle')
  expect(f.calls.some(call => call.method === 'thread/backgroundTerminals/list' && call.params.threadId === 'child')).toBe(true)
  f.state.turns.get('owner')![0]!.items.pop()
  expect((await f.inspect()).status).toBe('busy')
  // Parent completion and an unloaded child still cannot erase unresolved work.
  f.state.loaded = ['owner']
  expect((await f.inspect()).status).toBe('busy')
})

test('busy and unknown native evidence never become idle; clean sibling remains usable', async () => {
  for (const mutate of [
    (f: ReturnType<typeof census>) => f.state.terminals.set('owner', [{ processId: 'shell' }]),
    (f: ReturnType<typeof census>) => f.state.queues.set('owner', [{ id: 'queued' }]),
    (f: ReturnType<typeof census>) => f.state.goals.set('owner', { threadId: 'owner', status: 'blocked' }),
    (f: ReturnType<typeof census>) => { f.state.threads.get('owner')!.status = { type: 'active' } },
  ]) {
    const f = census(); mutate(f)
    expect((await f.inspect()).status).toBe('busy')
    expect((await census().inspect()).status).toBe('idle')
  }
  const unknown = census(); unknown.state.threads.get('owner')!.status = { type: 'systemError' }
  expect((await unknown.inspect()).status).toBe('unknown')
  const foreign = census(); foreign.child(); foreign.state.threads.get('child')!.sessionId = 'foreign'
  expect((await foreign.inspect()).status).toBe('unknown')
  const unpaired = census(); unpaired.child(); unpaired.state.turns.clear()
  expect((await unpaired.inspect()).status).toBe('unknown')
})

test('exhausts pagination and refuses repeated, missing, or malformed cursors', async () => {
  const f = census()
  const rpc = async (method: string, params: Rpc) => method === 'thread/backgroundTerminals/list'
    ? params.cursor === null ? { data: [], nextCursor: 'next' } : { data: [{ processId: 'late-shell' }], nextCursor: null }
    : f.rpc(method, params)
  expect((await inspectNativeRetirement(rpc, 'owner')).status).toBe('busy')
  for (const result of [{ data: [] }, { data: [], nextCursor: 'loop' }, { data: [], nextCursor: 42 }]) {
    expect((await inspectNativeRetirement(async () => result, 'owner')).status).toBe('unknown')
  }
})

async function brokerFixture() {
  const f = census(), dir = mkdtempSync(join(tmpdir(), 'native-retire-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let receive: (message: unknown) => void = () => {}, disconnect: (error: Error) => void = () => {}
  let finish!: (exit: NativeProcessExit) => void
  const exited = new Promise<NativeProcessExit>(resolve => { finish = resolve })
  let closeCount = 0
  const hooks: { before?: (message: Rpc) => Promise<void> } = {}
  const broker = await createProjectControlBroker({ socketPath: join(dir, 'broker.sock'), cwd: dir, codexHome: dir, threadId: 'owner', requestTimeoutMs: 100,
    upstream: {
      exited,
      listen(message, onDisconnect) { receive = message; disconnect = onDisconnect },
      send(message) {
        if (!message.id) return
        void (async () => {
          await hooks.before?.(message)
          const result = message.method === 'initialize' ? {} : await f.rpc(String(message.method), message.params as Rpc)
          receive({ id: message.id, result })
        })()
      },
      close() { closeCount++; disconnect(new Error('Native transport closed')) },
    },
  })
  cleanup.push(() => broker.close())
  return { ...f, dir, broker, hooks, receive: (message: Rpc) => receive(message), finish, closeCount: () => closeCount }
}
const exit = { pid: 123, boot: 'boot', start: '100', code: null, signal: 'SIGTERM' as const }

test('exclusive lease fences gateway reads/writes/reviews; abort re-admits; exact exit earns success', async () => {
  const f = await brokerFixture(), gateway = f.broker.gateway('gateway')
  const prepared = await f.broker.prepareRetirement(0)
  expect(prepared.status).toBe('prepared')
  if (prepared.status !== 'prepared') throw new Error('No lease')
  await expect(gateway.request('thread/read', { threadId: 'owner' })).rejects.toBeInstanceOf(ProjectControlAdmissionRefusal)
  await expect(gateway.request('turn/start', { threadId: 'owner' }, 0)).rejects.toBeInstanceOf(ProjectControlAdmissionRefusal)
  await expect(f.broker.reviewPermissions({ stageDir: '/stage', network: false }, 0)).rejects.toBeInstanceOf(ReviewPermissionBusy)
  prepared.lease.abort()
  expect(await gateway.request('thread/read', { threadId: 'owner' })).toHaveProperty('thread.id', 'owner')
  expect((await prepared.lease.retire()).status).toBe('unknown')
  const next = await f.broker.prepareRetirement(0)
  if (next.status !== 'prepared') throw new Error('No lease')
  let done = false
  const retiring = next.lease.retire().then(result => { done = true; return result })
  await tick()
  expect(f.closeCount()).toBe(1)
  expect(done).toBe(false)
  f.finish(exit)
  expect(await retiring).toEqual({ status: 'retired', generation: 1, epoch: 0, threadId: 'owner', rolloutPath: '/project/rollout.jsonl', exit })
  expect(f.broker.state().phase).toBe('closed')
  const db = new Database(join(f.dir, 'broker.sock.sqlite'), { readonly: true })
  try { expect(db.query('SELECT unresolved FROM broker').get()).toEqual({ unresolved: null }) }
  finally { db.close() }
})

test('pending reads and stale epochs refuse preparation without preventing a later clean lease', async () => {
  const f = await brokerFixture(), gateway = f.broker.gateway('reader')
  let release!: () => void
  f.hooks.before = () => new Promise<void>(resolve => { release = resolve })
  const read = gateway.request('thread/read', { threadId: 'owner' })
  expect((await f.broker.prepareRetirement(0)).status).toBe('busy')
  delete f.hooks.before; release(); await read
  expect((await f.broker.prepareRetirement(1)).status).toBe('unknown')
  expect((await f.broker.prepareRetirement(0)).status).toBe('prepared')
})

test('unknown census timeout leaves the original owner alive and re-admits it', async () => {
  const f = await brokerFixture()
  let release!: () => void
  f.hooks.before = () => new Promise<void>(resolve => { release = resolve })
  expect((await f.broker.prepareRetirement(0)).status).toBe('unknown')
  expect(f.closeCount()).toBe(0)
  expect(f.broker.state().phase).toBe('idle')
  delete f.hooks.before; release(); await tick()
  expect((await f.broker.prepareRetirement(0)).status).toBe('prepared')
})

test('socket TUI mutation cannot cross retirement lease and works after abort', async () => {
  const f = await brokerFixture(), connections = new Set<Socket>()
  const relay = createServer(down => {
    const up = createConnection(join(f.dir, 'broker.sock'))
    connections.add(down); connections.add(up); down.pipe(up).pipe(down)
  })
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve))
  const address = relay.address()
  if (!address || typeof address === 'string') throw new Error('No relay port')
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`)
  cleanup.push(() => { socket.close(); for (const connection of connections) connection.destroy(); relay.close() })
  await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve()); socket.addEventListener('error', reject) })
  const request = (id: string, method: string, params: Rpc = {}) => new Promise<Rpc>(resolve => {
    const listener = (event: MessageEvent) => {
      const value = JSON.parse(String(event.data)) as Rpc
      if (value.id === id) { socket.removeEventListener('message', listener); resolve(value) }
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method, params }))
  })
  await request('init', 'initialize')
  const lease = await f.broker.prepareRetirement(0)
  if (lease.status !== 'prepared') throw new Error('No lease')
  const before = f.calls.length
  expect((await request('blocked', 'thread/settings/update', { threadId: 'owner', model: 'next' })).error.message).toContain('retirement')
  expect(f.calls.length).toBe(before)
  lease.lease.abort()
  expect(await request('allowed', 'thread/settings/update', { threadId: 'owner', model: 'next' })).toHaveProperty('result')
  expect(f.calls.some(call => call.method === 'thread/settings/update')).toBe(true)
})

test('late shell and child activity invalidate retirement without killing owner', async () => {
  const f = await brokerFixture()
  const prepared = await f.broker.prepareRetirement(0)
  if (prepared.status !== 'prepared') throw new Error('No lease')
  f.state.terminals.set('owner', [{ processId: 'late' }])
  expect((await prepared.lease.retire()).status).toBe('busy')
  expect(f.closeCount()).toBe(0)
  f.state.terminals.clear()
  f.hooks.before = async message => {
    if (message.method === 'thread/goal/get') f.receive({ method: 'turn/started', params: { threadId: 'unseen-child', turn: { id: 'new' } } })
  }
  expect((await f.broker.prepareRetirement(0)).status).toBe('busy')
  expect(f.closeCount()).toBe(0)
  delete f.hooks.before
  expect((await f.broker.prepareRetirement(0)).status).toBe('unknown')
  expect(f.closeCount()).toBe(0)
})

test('signal without exit proof returns unknown and retains recovery marker', async () => {
  const f = await brokerFixture()
  const prepared = await f.broker.prepareRetirement(0)
  if (prepared.status !== 'prepared') throw new Error('No lease')
  expect((await prepared.lease.retire()).status).toBe('unknown')
  expect(f.closeCount()).toBe(1)
  expect(f.broker.state().phase).toBe('closed')
  const db = new Database(join(f.dir, 'broker.sock.sqlite'), { readonly: true })
  try { expect(db.query('SELECT unresolved FROM broker').get()).toEqual({ unresolved: 'native-retirement' }) }
  finally { db.close() }
})
