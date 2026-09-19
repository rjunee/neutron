import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Socket } from 'node:net'
import { createProjectControlBroker, classifyProjectControlMethod } from './project-control-broker.ts'
import type { ProjectControlTransport } from './project-control-broker-transport.ts'

type Rpc = Record<string, any>
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

async function fixture(timeout = 500) {
  const dir = mkdtempSync(join(tmpdir(), 'project-broker-test-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const sent: Rpc[] = []
  let closeCount = 0
  let receive: (message: unknown) => void = () => {}
  const upstream: ProjectControlTransport = {
    listen(onMessage) { receive = onMessage },
    send(message) {
      sent.push(message)
      if (message.method === 'initialize') queueMicrotask(() => receive({ id: message.id, result: { userAgent: 'test', platformFamily: 'unix', platformOs: 'linux' } }))
    }, close() { closeCount++ },
  }
  const socketPath = join(dir, 'control.sock')
  const options = { socketPath, threadId: 'project-thread', cwd: dir, codexHome: dir, upstream, requestTimeoutMs: timeout }
  const broker = await createProjectControlBroker(options)
  cleanup.push(() => broker.close())
  const response = (method: string, result: unknown = {}): void => {
    const message = sent.findLast(message => message.method === method)
    if (!message) throw new Error(`Missing ${method}`)
    receive({ id: message.id, result })
  }
  return { broker, dir, socketPath, sent, receive: (message: Rpc) => receive(message), response, options, closeCount: () => closeCount }
}

// A disposable TCP-to-Unix relay only supplies the test client's missing Unix
// option. Production exposes solely the Unix endpoint tested by this relay.
async function terminal(socketPath: string) {
  const connections = new Set<Socket>()
  const relay = createServer(down => {
    const up = createConnection(socketPath)
    connections.add(down); connections.add(up)
    down.pipe(up).pipe(down)
  })
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve))
  const address = relay.address()
  if (!address || typeof address === 'string') throw new Error('No relay port')
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`)
  cleanup.push(() => { ws.close(); for (const socket of connections) socket.destroy(); relay.close() })
  const received: Rpc[] = []
  ws.addEventListener('message', event => received.push(JSON.parse(String(event.data)) as Rpc))
  await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', reject) })
  const wait = async (predicate: (message: Rpc) => boolean): Promise<Rpc> => {
    for (let tries = 0; tries < 200; tries++) {
      const found = received.find(predicate)
      if (found) return found
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    throw new Error('Missing terminal response')
  }
  const send = (message: Rpc): void => ws.send(JSON.stringify(message))
  send({ id: 'initialize', method: 'initialize', params: {} })
  await wait(message => message.id === 'initialize')
  return { send, wait, received, ws }
}

describe('project control broker', () => {
  test('host review lease excludes socket and gateway writers; abandonment persists the recovery fence', async () => {
    const f = await fixture()
    const stageDir = join(f.dir, '.neutron', 'build-results', 'a'.repeat(64))
    mkdirSync(stageDir, { recursive: true })
    const gateway = f.broker.gateway('normal-owner')
    const tui = await terminal(f.socketPath)
    const preparing = f.broker.reviewPermissions({ stageDir, network: false }, 0)
    const rejected = preparing.catch(error => error as Error)
    expect(f.broker.state().phase).toBe('mutation')
    await expect(gateway.request('turn/start', { threadId: 'project-thread', input: [] }, f.broker.state().epoch)).rejects.toThrow('busy')
    tui.send({ id: 'review-bypass', method: 'thread/settings/update', params: { threadId: 'project-thread', sandboxPolicy: { type: 'dangerFullAccess' } } })
    expect((await tui.wait(message => message.id === 'review-bypass')).error.message).toContain('busy')
    f.receive({ id: 'review-approval', method: 'item/fileChange/requestApproval', params: { threadId: 'project-thread', turnId: 'review-turn' } })
    expect(f.sent.find(message => message.id === 'review-approval')?.error.message).toContain('forbids approvals')
    f.response('thread/resume', {})
    expect(await rejected).toBeInstanceOf(Error)
    expect(f.broker.state().phase).toBe('closed')
    expect(f.sent.filter(message => message.method === 'turn/start')).toHaveLength(0)
    const upstream: ProjectControlTransport = { listen(onMessage) { this.send = message => { if (message.method === 'initialize') queueMicrotask(() => onMessage({ id: message.id, result: {} })) } }, send() {}, close() {} }
    const recovered = await createProjectControlBroker({ ...f.options, upstream })
    cleanup.push(() => recovered.close())
    expect(recovered.state().phase).toBe('recovery')
    expect(recovered.state().unresolved).toBe('review-permissions')
  })

  test('review profile provisioning remains unavailable to arbitrary RPC clients', async () => {
    const f = await fixture(), gateway = f.broker.gateway('normal-owner')
    await expect(gateway.request('config/batchWrite', { edits: [{ keyPath: 'permissions.neutron_review_fake', value: { filesystem: { ':root': 'write' } }, mergeStrategy: 'replace' }] }, 0)).rejects.toThrow('Unclassified')
    await expect(gateway.request('reviewPermissions', { stageDir: f.dir }, 0)).rejects.toThrow('Unclassified')
    expect(f.sent.filter(message => message.method === 'config/batchWrite')).toHaveLength(0)
  })

  test('explicit mutation classification includes native model persistence and refuses new methods', () => {
    for (const method of ['turn/start', 'thread/settings/update', 'config/batchWrite', 'turn/interrupt', 'thread/resume']) expect(classifyProjectControlMethod(method)).toBe('mutation')
    expect(classifyProjectControlMethod('thread/read')).toBe('read')
    for (const method of ['thread/fork', 'config/value/write', 'turn/steer', 'future/read']) expect(classifyProjectControlMethod(method)).toBe('refuse')
  })

  test('requires capability boolean; socket is private and cannot be replaced by another broker', async () => {
    const f = await fixture()
    expect(f.sent[0]?.params.capabilities).toEqual({ experimentalApi: true, requestAttestation: false })
    expect(statSync(f.socketPath).mode & 0o777).toBe(0o600)
    await expect(createProjectControlBroker({ ...f.options, upstream: {
      listen() {}, send() {}, close() {},
    }, requestTimeoutMs: 10 })).rejects.toThrow()
    const response = await fetch('http://localhost/rpc', { unix: f.socketPath, headers: { origin: 'https://example.invalid' } })
    expect(response.status).toBe(403)
  })

  test('idle terminal stays attached while gateway owns a turn; second writer and stale epochs never reach upstream', async () => {
    const f = await fixture()
    const tui = await terminal(f.socketPath)
    const gateway = f.broker.gateway('gateway')
    const start = gateway.request('turn/start', { threadId: 'project-thread', input: [] }, 0)
    tui.send({ id: 1, method: 'turn/start', params: { threadId: 'project-thread', input: [] } })
    expect((await tui.wait(message => message.id === 1)).error.message).toContain('busy')
    f.receive({ method: 'turn/started', params: { threadId: 'project-thread', turn: { id: 'turn-a' } } })
    f.response('turn/start', { turn: { id: 'turn-a' } })
    await start; await tick()
    f.receive({ method: 'turn/completed', params: { threadId: 'project-thread', turn: { id: 'other-turn' } } })
    expect(f.broker.state().phase).toBe('turn')
    f.receive({ method: 'turn/completed', params: { threadId: 'project-thread', turn: { id: 'turn-a' } } })
    expect(f.broker.state().phase).toBe('idle')
    await expect(gateway.request('thread/settings/update', { threadId: 'project-thread', model: 'next' }, 0)).rejects.toThrow('Stale')
    tui.send({ id: 2, method: 'thread/settings/update', params: { threadId: 'project-thread', model: 'next' } })
    await tick(); await tick()
    f.response('thread/settings/update')
    expect((await tui.wait(message => message.id === 2)).result).toEqual({})
    expect(f.sent.filter(message => message.method === 'turn/start')).toHaveLength(1)
  })

  test('same-client settings burst is ordered; separate /model RPCs are not an atomic transaction', async () => {
    const f = await fixture()
    const a = f.broker.gateway('a')
    const b = f.broker.gateway('b')
    const first = a.request('thread/settings/update', { threadId: 'project-thread', model: 'first' }, 0)
    const second = a.request('thread/settings/update', { threadId: 'project-thread', effort: 'medium' }, 1)
    expect(f.sent.filter(message => message.method === 'thread/settings/update')).toHaveLength(1)
    await expect(b.request('turn/start', { threadId: 'project-thread' }, 2)).rejects.toThrow('busy')
    f.response('thread/settings/update'); await first; await tick()
    expect(f.sent.filter(message => message.method === 'thread/settings/update')).toHaveLength(2)
    f.response('thread/settings/update'); await second; await tick()
    // Scope limit: after replies, another owner can win before the TUI sends its
    // separate config write. This skeleton does not claim /model atomicity.
    const third = b.request('thread/settings/update', { threadId: 'project-thread', model: 'second' }, 2)
    await expect(a.request('config/batchWrite', { edits: [{ keyPath: 'model', value: 'first', mergeStrategy: 'replace' }] }, 3)).rejects.toThrow('busy')
    f.response('thread/settings/update'); await third
  })

  test('approval replies and interrupts require the exact active owner and terminal evidence releases disconnect fence', async () => {
    const f = await fixture()
    const a = f.broker.gateway('a')
    const b = f.broker.gateway('b')
    const events: Rpc[] = []
    a.subscribe(event => events.push(event))
    const start = a.request('turn/start', { threadId: 'project-thread' }, 0)
    f.response('turn/start', { turn: { id: 'turn-a' } }); await start; await tick()
    f.receive({ id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'project-thread', turnId: 'turn-a' } })
    expect(events.some(event => event.id === 9)).toBe(true)
    f.receive({ id: 10, method: 'item/commandExecution/requestApproval', params: { threadId: 'project-thread' } })
    expect(f.sent.find(message => message.id === 10)?.error.message).toContain('matching')
    expect(events.some(event => event.id === 10)).toBe(false)
    expect(() => b.reply(9, { decision: 'accept' }, 1)).toThrow('foreign')
    a.reply(9, { decision: 'decline' }, 1)
    expect(() => a.reply(9, { decision: 'accept' }, 1)).toThrow('foreign')
    await expect(b.request('turn/interrupt', { threadId: 'project-thread', turnId: 'turn-a' }, 1)).rejects.toThrow('owner')
    await expect(a.request('turn/interrupt', { threadId: 'project-thread', turnId: 'wrong' }, 1)).rejects.toThrow('owner')
    const interrupt = a.request('turn/interrupt', { threadId: 'project-thread', turnId: 'turn-a' }, 1)
    f.response('turn/interrupt'); await interrupt
    expect(f.broker.state().phase).toBe('turn')
    a.close()
    await expect(b.request('turn/start', { threadId: 'project-thread' }, 1)).rejects.toThrow('busy')
    f.receive({ method: 'turn/completed', params: { threadId: 'project-thread', turn: { id: 'turn-a' } } })
    expect(f.broker.state().phase).toBe('idle')
  })

  test('foreign identities, alternate history, unknown mutation and config paths fail closed; lists are filtered', async () => {
    const f = await fixture()
    const gateway = f.broker.gateway('gateway')
    for (const [method, params] of [
      ['thread/read', { threadId: 'foreign' }], ['thread/resume', { threadId: 'project-thread', path: '/foreign' }],
      ['thread/resume', { threadId: 'project-thread', config: { mcp_servers: {} } }],
      ['turn/start', { threadId: 'project-thread', cwd: '/foreign' }], ['thread/fork', { threadId: 'project-thread' }],
      ['config/batchWrite', { filePath: '/foreign', edits: [] }],
      ['config/batchWrite', { edits: [{ keyPath: 'mcp_servers', value: 'x', mergeStrategy: 'replace' }] }],
    ] as [string, Rpc][]) await expect(gateway.request(method, params, 0)).rejects.toThrow()
    expect(f.sent.filter(message => message.id).length).toBe(1)
    const list = gateway.request('thread/list', {})
    f.response('thread/list', { data: [{ id: 'project-thread' }, { id: 'foreign' }], nextCursor: 'foreign-cursor' })
    expect(await list).toEqual({ data: [{ id: 'project-thread' }], nextCursor: null })
    const events: Rpc[] = []
    gateway.subscribe(message => events.push(message))
    f.receive({ method: 'turn/completed', params: { threadId: 'foreign', turn: { id: 'x' } } })
    f.receive({ method: 'turn/completed', params: { threadId: 'project-thread', turn: { id: 'x' } } })
    expect(events).toHaveLength(1)
  })

  test('lost acknowledgement closes the broker instead of permitting another writer', async () => {
    const f = await fixture(15)
    const gateway = f.broker.gateway('gateway')
    await expect(gateway.request('turn/start', { threadId: 'project-thread' }, 0)).rejects.toThrow('unknown')
    expect(f.broker.state().phase).toBe('closed')
    await expect(gateway.request('turn/start', { threadId: 'project-thread' }, 1)).rejects.toThrow()
  })

  test('queued params are copied at admission and queued work resumes after exact turn completion', async () => {
    const f = await fixture()
    const gateway = f.broker.gateway('gateway')
    const first = gateway.request('thread/settings/update', { threadId: 'project-thread', model: 'first' }, 0)
    const turn = gateway.request('turn/start', { threadId: 'project-thread' }, 1)
    const params = { threadId: 'project-thread', model: 'last' }
    const last = gateway.request('thread/settings/update', params, 2)
    params.threadId = 'foreign'
    f.response('thread/settings/update'); await first; await tick()
    f.response('turn/start', { turn: { id: 'turn-a' } }); await turn; await tick()
    expect(f.sent.filter(message => message.method === 'thread/settings/update')).toHaveLength(1)
    f.receive({ method: 'turn/completed', params: { threadId: 'project-thread', turn: { id: 'turn-a' } } })
    await tick()
    expect(f.sent.findLast(message => message.method === 'thread/settings/update')?.params.threadId).toBe('project-thread')
    f.response('thread/settings/update'); await last
  })

  test('two simultaneous gateway claims share no mutation epoch', async () => {
    const f = await fixture()
    const a = f.broker.gateway('a')
    const b = f.broker.gateway('b')
    const first = a.request('thread/settings/update', { threadId: 'project-thread', model: 'first' }, 0)
    await expect(b.request('thread/settings/update', { threadId: 'project-thread', model: 'second' }, 0)).rejects.toThrow('Stale')
    expect(f.sent.filter(message => message.method === 'thread/settings/update')).toHaveLength(1)
    f.response('thread/settings/update'); await first
  })

  test('nested environment and sandbox scope overrides cannot bypass project admission', async () => {
    const f = await fixture()
    const gateway = f.broker.gateway('gateway')
    for (const environments of [
      [{ environmentId: 'local', cwd: '/foreign', runtimeWorkspaceRoots: ['/foreign'] }],
      [{ environmentId: 'local', cwd: f.dir, runtimeWorkspaceRoots: ['/foreign'] }],
      [{ environmentId: 'local', cwd: f.dir }, { environmentId: 'remote', cwd: '/foreign' }],
      [{ environmentId: 'remote', cwd: f.dir }], [{ environmentId: 'local' }],
      [{ environmentId: 'local', cwd: f.dir, futureScope: '/foreign' }],
      { environmentId: 'local', cwd: f.dir }, [null],
    ]) await expect(gateway.request('turn/start', { threadId: 'project-thread', environments }, 0)).rejects.toThrow('scope')
    for (const method of ['turn/start', 'thread/settings/update']) {
      await expect(gateway.request(method, { threadId: 'project-thread', sandboxPolicy: {
        type: 'workspaceWrite', writableRoots: ['/foreign'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
      } }, 0)).rejects.toThrow('scope')
    }
    await expect(gateway.request('turn/start', { threadId: 'project-thread', futureEnvironment: { cwd: '/foreign' } }, 0)).rejects.toThrow('scope')
    expect(f.sent.filter(message => message.id)).toHaveLength(1)
    expect(f.broker.state().epoch).toBe(0)
  })

  test('schema traversal permits valid project environments and opaque user data with scope-like keys', async () => {
    const f = await fixture()
    const gateway = f.broker.gateway('gateway')
    const params = {
      threadId: 'project-thread', environments: [{ environmentId: 'local', cwd: f.dir, runtimeWorkspaceRoots: [f.dir] }],
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [f.dir], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      input: [{ type: 'text', text: '{"cwd":"/foreign"}' }],
      outputSchema: { type: 'object', properties: { cwd: { const: '/foreign' }, environments: { type: 'array' } } },
      additionalContext: { cwd: { kind: 'text', value: '/foreign' } }, responsesapiClientMetadata: { cwd: '/foreign' },
    }
    const start = gateway.request('turn/start', params, 0)
    expect(f.sent.findLast(message => message.method === 'turn/start')?.params).toEqual(params)
    f.response('turn/start', { turn: { id: 'turn-a' } }); await start
  })

  test('constructor failure closes its supplied upstream exactly once, as successful shutdown does', async () => {
    const f = await fixture()
    for (const override of [{ socketPath: f.socketPath }, { socketPath: 'relative' }, { requestTimeoutMs: -1 }, { socketPath: join(f.dir, 'missing', 'control.sock') }]) {
      let closed = 0
      const upstream: ProjectControlTransport = { send() {}, listen() {}, close() { closed++ } }
      await expect(createProjectControlBroker({ ...f.options, ...override, upstream })).rejects.toThrow()
      expect(closed).toBe(1)
    }
    f.broker.close(); f.broker.close()
    expect(f.closeCount()).toBe(1)
  })

  test('listen and initialization failures also close the supplied transport once', async () => {
    const f = await fixture()
    for (const failAt of ['listen', 'initialize']) {
      let closed = 0
      let receive: (message: unknown) => void = () => {}
      const upstream: ProjectControlTransport = {
        listen(onMessage) { if (failAt === 'listen') throw new Error('Listen failure'); receive = onMessage },
        send(message) { receive({ id: message.id, error: { code: -32000, message: 'Initialize failure' } }) },
        close() { closed++ },
      }
      await expect(createProjectControlBroker({ ...f.options, socketPath: join(f.dir, `${failAt}.sock`), upstream })).rejects.toThrow()
      expect(closed).toBe(1)
    }
  })
})
