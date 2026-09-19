import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { OwnerMcpServerStore } from '@neutronai/gateway/mcp-servers/store.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { ApprovalManager } from '@neutronai/tools/approval.ts'
import type { ResolvedOwnerMcpServer } from '../../../mcp-servers.js'
import { ApprovedMcpBroker, type ApprovedMcpContext } from './approved-mcp-broker.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function fixture(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'approved-broker-'))
  const log = join(dir, 'operations.log')
  let context: ApprovedMcpContext = { projectId: 'project-one', sessionId: 'session-one',
    threadId: 'thread-one', generation: 'claim-one', leaseId: 'lease-one', phase: 'active', idle: true }
  let servers: ResolvedOwnerMcpServer[] = [{ name: 'fixture', command: process.execPath,
    args: [join(import.meta.dir, 'fixtures', 'approved-mcp-server.ts'), 'one two', ';literal'],
    env_names: ['BROKER_TEST_LOG', 'BROKER_TEST_SECRET', ...Object.keys(extraEnv)],
    env: { BROKER_TEST_LOG: log, BROKER_TEST_SECRET: 'test-secret', ...extraEnv } }]
  let reads = 0
  let ownerConversation = true
  let ownerPreparation = true
  let onRead: (() => void) | undefined
  let resolve: (() => Promise<readonly ResolvedOwnerMcpServer[]>) | undefined
  const notifications: string[] = []
  const recipients: Array<readonly string[] | undefined> = []
  const broker = new ApprovedMcpBroker({ currentContext: () => context,
    assertOwnerPreparation: () => { if (!ownerPreparation) throw new Error('Not an owner preparation') },
    assertOwnerConversation: () => { if (!ownerConversation) throw new Error('Not an owner conversation') },
    resolveApproved: async () => { reads++; onRead?.(); return resolve ? resolve() : servers },
    onNotification: async (_context, name, notification, consumerIds) => {
      notifications.push(`${name}:${notification.method}`)
      recipients.push(consumerIds)
    },
    connectTimeoutMs: 2_000, requestTimeoutMs: 2_000 })
  cleanups.push(async () => { await broker.close(); rmSync(dir, { recursive: true, force: true }) })
  return { broker, get context() { return { ...context } }, setContext: (patch: Partial<ApprovedMcpContext>) => { context = { ...context, ...patch } },
    get servers() { return servers }, setServers: (value: ResolvedOwnerMcpServer[]) => { servers = value },
    onRead: (callback: () => void) => { onRead = callback }, get reads() { return reads }, notifications, recipients,
    setOwnerConversation: (value: boolean) => { ownerConversation = value },
    setOwnerPreparation: (value: boolean) => { ownerPreparation = value },
    setResolver: (callback: () => Promise<readonly ResolvedOwnerMcpServer[]>) => { resolve = callback },
    peerAlive: () => {
      const pid = Number(readFileSync(`${log}.pid`, 'utf8').trim().split('\n').at(-1))
      try { process.kill(pid, 0); return true } catch { return false }
    },
    operations: () => { try { return readFileSync(log, 'utf8').trim().split('\n') } catch { return [] } } }
}

async function eventually(check: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error('Fixture event did not arrive')
}

describe('approved installed MCP broker', () => {
  test.each([
    ['remove', 'request'], ['rotate', 'request'], ['remove', 'notification'], ['rotate', 'notification'],
  ] as const)('real store %s gap retires B without cancelling unchanged A before the callback: %s', async (change, trigger) => {
    const dir = mkdtempSync(join(tmpdir(), 'broker-store-gap-'))
    const db = ProjectDb.open(join(dir, 'project.db'))
    applyMigrations(db.raw())
    const credentials = new ProjectCredentialStore(db, { crypto: new SecretsStore({ data_dir: dir, db }) })
    const approvals = new ApprovalManager(db, { notify: async () => {} })
    const a = fixture(), b = fixture()
    let callbacks = 0
    const store = new OwnerMcpServerStore({ db, project_slug: 'owner', owner_slug: asOwnerHandle('owner'),
      credentials, approvals: () => approvals, onRevoked: async () => { callbacks++; await a.broker.retireRevoked() } })
    let release = () => {}, entered = () => {}, restore = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { entered = resolve })
    let mutation: Promise<unknown> | undefined
    const servers = [{ ...a.servers[0]!, name: 'a' }, { ...b.servers[0]!, name: 'b' }]
    try {
      for (const server of servers) {
        expect((await store.install({ name: server.name, command: server.command, args: server.args, env: server.env })).ok).toBe(true)
        const hash = (await store.list()).find(row => row.name === server.name)!.grant_hash
        expect((await store.decide(server.name, 'approve', hash)).ok).toBe(true)
      }
      a.setResolver(() => store.resolveApproved())
      await a.broker.bind(a.context)
      expect(a.peerAlive()).toBe(true)
      expect(b.peerAlive()).toBe(true)
      if (trigger === 'notification') await a.broker.request(a.context, 'a', {
        method: 'tools/call', params: { name: 'inspect', arguments: { notifyAfter: 150 } },
      })
      if (change === 'remove') {
        const original = credentials.deleteReserved.bind(credentials)
        const spy = spyOn(credentials, 'deleteReserved').mockImplementation(async (...args) => {
          entered(); await held; return original(...args)
        })
        restore = () => spy.mockRestore()
        mutation = store.remove('b')
      } else {
        const original = credentials.setReserved.bind(credentials)
        const spy = spyOn(credentials, 'setReserved').mockImplementation(async (...args) => {
          const result = await original(...args)
          entered(); await held; return result
        })
        restore = () => spy.mockRestore()
        const server = servers[1]!
        mutation = store.install({ name: server.name, command: server.command, args: server.args,
          env: { ...server.env, BROKER_TEST_SECRET: 'rotated' } })
      }
      await reached
      expect(callbacks).toBe(0)
      if (trigger === 'notification') {
        expect(a.notifications).toEqual([])
        await eventually(() => a.notifications.length > 0)
      }
      expect((await a.broker.request(a.context, 'a', { method: 'tools/list' })).tools).toHaveLength(1)
      await expect(a.broker.request(a.context, 'b', { method: 'tools/call', params: { name: 'inspect' } })).rejects.toThrow()
      expect(a.peerAlive()).toBe(true)
      expect(b.peerAlive()).toBe(false)
      expect(b.operations()).toEqual(['spawn'])
      expect(callbacks).toBe(0)
      release()
      await mutation
      expect(callbacks).toBe(1)
      expect((await a.broker.request(a.context, 'a', { method: 'tools/list' })).tools).toHaveLength(1)
      expect(a.operations().filter(operation => operation === 'spawn')).toHaveLength(1)
    } finally {
      release(); await mutation?.catch(() => {}); restore()
      await a.broker.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    ['cold', 'remove'], ['cold', 'rotate'], ['established', 'remove'], ['established', 'rotate'],
  ] as const)('revoking a handshaking candidate preserves the unchanged %s peer: %s', async (state, change) => {
    const a = fixture()
    const b = fixture({ BROKER_TEST_CONNECT_DELAY: '1000' })
    a.setServers([{ ...a.servers[0]!, name: 'a' }])
    if (state === 'established') {
      await a.broker.bind(a.context)
      expect((await a.broker.request(a.context, 'a', { method: 'tools/list' })).tools).toHaveLength(1)
    }
    a.setServers([...a.servers, { ...b.servers[0]!, name: 'b' }])
    await a.broker.retireRevoked()
    const binding = a.broker.bind(a.context).then(value => ({ value }), error => ({ error }))
    await eventually(() => b.operations().includes('spawn'))
    expect(a.peerAlive()).toBe(true)
    a.setServers(change === 'remove' ? a.servers.filter(server => server.name === 'a')
      : a.servers.map(server => server.name === 'a' ? server : { ...server, env: { ...server.env, BROKER_TEST_SECRET: 'rotated' } }))
    await a.broker.retireRevoked()
    expect(b.peerAlive()).toBe(false)
    expect(await binding).toMatchObject({ value: [{ name: 'a' }] })
    expect(a.peerAlive()).toBe(true)
    expect(a.operations()).toEqual(['spawn'])
    expect((await a.broker.request(a.context, 'a', { method: 'tools/list' })).tools).toHaveLength(1)
    await expect(a.broker.request(a.context, 'b', { method: 'tools/list' })).rejects.toThrow()
  })

  test('unexpected candidate handshake timeout still disposes the whole binding', async () => {
    const a = fixture()
    const b = fixture({ BROKER_TEST_CONNECT_DELAY: '3000' })
    a.setServers([{ ...a.servers[0]!, name: 'a' }, { ...b.servers[0]!, name: 'b' }])
    await expect(a.broker.bind(a.context)).rejects.toThrow()
    expect(a.peerAlive()).toBe(false)
    await eventually(() => !b.peerAlive(), 600)
    expect(b.peerAlive()).toBe(false)
    await expect(a.broker.request(a.context, 'a', { method: 'tools/list' })).rejects.toThrow()
  })

  test.each(['remove', 'rotate'] as const)('revocation during cold admission cannot spawn a stale candidate or cancel its unchanged peer: %s', async change => {
    const a = fixture({ BROKER_TEST_CONNECT_DELAY: '500' })
    const b = fixture()
    a.setServers([{ ...a.servers[0]!, name: 'a' }, { ...b.servers[0]!, name: 'b' }])
    const binding = a.broker.bind(a.context)
    await eventually(() => a.operations().includes('spawn'))
    a.setServers(change === 'remove' ? a.servers.filter(server => server.name === 'a')
      : a.servers.map(server => server.name === 'a' ? server : { ...server, env: { ...server.env, BROKER_TEST_SECRET: 'rotated' } }))
    await a.broker.retireRevoked()
    expect(a.peerAlive()).toBe(true)
    expect((await binding).map(server => server.name)).toEqual(['a'])
    expect(b.operations()).toEqual([])
    expect((await a.broker.request(a.context, 'a', { method: 'tools/list' })).tools).toHaveLength(1)
    await expect(a.broker.request(a.context, 'b', { method: 'tools/list' })).rejects.toThrow()
    expect(a.operations()).toEqual(['spawn'])
    expect(a.peerAlive()).toBe(true)
  })

  test('cancelled unsubscribe after peer result cannot lend an uncertain subscription to a successor', async () => {
    const f = fixture()
    await f.broker.bind(f.context)
    await f.broker.request(f.context, 'fixture', { method: 'resources/subscribe', params: { uri: 'fixture://one' } }, undefined, { consumerId: 'first' })
    const controller = new AbortController()
    f.onRead(() => {
      if (f.operations().includes('unsubscribe:fixture://one')) controller.abort()
    })
    await expect(f.broker.request(f.context, 'fixture', { method: 'resources/unsubscribe', params: { uri: 'fixture://one' } }, controller.signal, { consumerId: 'first' })).rejects.toThrow()
    expect(f.operations().filter((operation) => operation.startsWith('unsubscribe:'))).toHaveLength(1)
    await expect(f.broker.request(f.context, 'fixture', { method: 'resources/subscribe', params: { uri: 'fixture://one' } }, undefined, { consumerId: 'second' })).rejects.toThrow()
    expect(f.operations().filter((operation) => operation.startsWith('subscribe:'))).toHaveLength(1)
    expect(f.peerAlive()).toBe(true)
    await f.broker.bind(f.context)
    await f.broker.request(f.context, 'fixture', { method: 'resources/subscribe', params: { uri: 'fixture://one' } }, undefined, { consumerId: 'second' })
    expect(f.operations().filter((operation) => operation.startsWith('subscribe:'))).toHaveLength(2)
    expect(f.operations().filter((operation) => operation.startsWith('unsubscribe:'))).toHaveLength(2)
    expect(f.operations().filter((operation) => operation === 'spawn')).toHaveLength(1)
  })

  test('upstream EOF retires cached metadata and recovers only at explicit idle preparation', async () => {
    const f = fixture()
    const other = fixture()
    await f.broker.bind(f.context)
    await other.broker.bind(other.context)
    await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect', arguments: { exitAfter: 100 } } })
    await eventually(() => !f.peerAlive())
    await expect(f.broker.activeMetadata(f.context)).rejects.toThrow()
    await expect(f.broker.preparedMetadata(f.context)).rejects.toThrow()
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/list' })).rejects.toThrow()
    expect(f.operations()).toEqual(['spawn', 'call:inspect'])
    expect(other.peerAlive()).toBe(true)
    expect((await other.broker.request(other.context, 'fixture', { method: 'tools/list' })).tools).toHaveLength(1)
    f.setContext({ idle: false })
    await expect(f.broker.bind(f.context)).rejects.toThrow()
    expect(f.operations()).toEqual(['spawn', 'call:inspect'])
    f.setContext({ idle: true })
    expect((await f.broker.bind(f.context))[0]?.name).toBe('fixture')
    expect((await f.broker.request(f.context, 'fixture', { method: 'tools/list' })).tools).toHaveLength(1)
    expect(f.operations()).toEqual(['spawn', 'call:inspect', 'spawn'])
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect', arguments: { exitAfter: 30, delay: 100 } } })).rejects.toThrow()
    await expect(f.broker.activeMetadata(f.context)).rejects.toThrow()
    expect(other.peerAlive()).toBe(true)
  })

  test('resource consumers share one subscription and deleting one cannot unsubscribe another', async () => {
    const f = fixture()
    await f.broker.bind(f.context)
    const resource = (method: string, consumerId: string) => f.broker.request(f.context, 'fixture',
      { method, params: { uri: 'fixture://one' } }, undefined, { consumerId })
    await resource('resources/subscribe', 'consumer-a')
    await resource('resources/subscribe', 'consumer-b')
    expect(f.operations().filter((operation) => operation.startsWith('subscribe:'))).toHaveLength(1)
    await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect', arguments: { notifyUri: 'fixture://one' } } })
    await eventually(() => f.recipients.some((ids) => ids?.length === 2))
    await resource('resources/unsubscribe', 'consumer-a')
    expect(f.operations().some((operation) => operation.startsWith('unsubscribe:'))).toBe(false)
    await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect', arguments: { notifyUri: 'fixture://one' } } })
    await eventually(() => f.recipients.at(-1)?.join() === 'consumer-b')
    await resource('resources/subscribe', 'consumer-a')
    await f.broker.releaseConsumer(f.context, 'consumer-a')
    await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect', arguments: { notifyUri: 'fixture://one' } } })
    await eventually(() => f.recipients.at(-1)?.join() === 'consumer-b')
    expect(f.operations().some((operation) => operation.startsWith('unsubscribe:'))).toBe(false)
    f.setOwnerConversation(false)
    await f.broker.releaseConsumer(f.context, 'consumer-b')
    await f.broker.releaseConsumer(f.context, 'consumer-b')
    expect(f.operations().some((operation) => operation.startsWith('unsubscribe:'))).toBe(false)
    await f.broker.bind(f.context)
    expect(f.operations().filter((operation) => operation.startsWith('unsubscribe:'))).toEqual(['unsubscribe:fixture://one'])
    expect(f.operations().filter((operation) => operation === 'spawn')).toHaveLength(1)
  })

  test('cancelled subscription cannot silently authorize a queued consumer before idle reconciliation', async () => {
    const f = fixture({ BROKER_TEST_SUBSCRIBE_DELAY: '100' })
    await f.broker.bind(f.context)
    const controller = new AbortController()
    const first = f.broker.request(f.context, 'fixture', { method: 'resources/subscribe', params: { uri: 'fixture://one' } }, controller.signal, { consumerId: 'first' })
      .then(() => 'resolved', () => 'refused')
    const second = f.broker.request(f.context, 'fixture', { method: 'resources/subscribe', params: { uri: 'fixture://one' } }, undefined, { consumerId: 'second' })
      .then(() => 'resolved', () => 'refused')
    await eventually(() => f.operations().includes('subscribe:fixture://one'))
    controller.abort()
    expect(await first).toBe('refused')
    expect(await second).toBe('refused')
    await f.broker.bind(f.context)
    expect(f.operations().filter((operation) => operation.startsWith('unsubscribe:'))).toEqual(['unsubscribe:fixture://one'])
    await f.broker.request(f.context, 'fixture', { method: 'resources/subscribe', params: { uri: 'fixture://one' } }, undefined, { consumerId: 'second' })
    expect(f.operations().filter((operation) => operation.startsWith('subscribe:'))).toHaveLength(2)
  })

  test('late predecessor cleanup cannot remove a successor consumer and revocation closes all', async () => {
    const f = fixture()
    await f.broker.bind(f.context)
    const previous = f.context
    f.setContext({ leaseId: 'successor-lease' })
    await f.broker.bind(f.context)
    await f.broker.request(f.context, 'fixture', { method: 'resources/subscribe', params: { uri: 'fixture://one' } }, undefined, { consumerId: 'successor' })
    await expect(f.broker.releaseConsumer(previous, 'successor')).rejects.toThrow()
    await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect', arguments: { notifyUri: 'fixture://one' } } })
    await eventually(() => f.recipients.at(-1)?.join() === 'successor')
    f.setServers([])
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/list' })).rejects.toThrow()
    expect(f.peerAlive()).toBe(false)
  })

  test('per-request SDK progress is relayed and consumer cancellation fences late progress/result', async () => {
    const f = fixture()
    await f.broker.bind(f.context)
    const progress: number[] = []
    const hooks = { consumerId: 'progress-consumer', onProgress: async (value: { progress: number }) => { progress.push(value.progress) } }
    await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect', arguments: { progress: true } } }, undefined, hooks)
    await eventually(() => progress.length === 1)
    expect(progress).toEqual([1])
    const pending = f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect', arguments: { progress: true, delay: 150 } } }, undefined, hooks)
      .then(() => 'resolved', () => 'refused')
    await eventually(() => f.operations().filter((operation) => operation === 'call:inspect').length === 2)
    f.setOwnerConversation(false)
    await f.broker.releaseConsumer(f.context, hooks.consumerId)
    expect(await pending).toBe('refused')
    await Bun.sleep(180)
    expect(progress).toEqual([1])
    expect(f.peerAlive()).toBe(true)
  })

  for (const revoked of [false, true]) {
    test(`idle upstream notification ${revoked ? 'retires a revoked peer' : 'does not destroy an approved warm peer'}`, async () => {
      const f = fixture()
      await f.broker.bind(f.context)
      await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect', arguments: { notifyAfter: 100 } } })
      f.setOwnerConversation(false)
      if (revoked) f.setServers([])
      await eventually(() => f.operations().includes('notified'))
      await Bun.sleep(30)
      expect(f.notifications).toEqual([])
      expect(f.peerAlive()).toBe(!revoked)
      if (!revoked) {
        f.setContext({ leaseId: 'next-owner-lease' })
        await f.broker.bind(f.context)
        expect(f.operations().filter((operation) => operation === 'spawn')).toHaveLength(1)
      }
    })
  }

  test('real encrypted approval store controls first execution and later denial of a real SDK peer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'broker-approval-store-'))
    const db = ProjectDb.open(join(dir, 'project.db'))
    applyMigrations(db.raw())
    const credentials = new ProjectCredentialStore(db, { crypto: new SecretsStore({ data_dir: dir, db }) })
    const approvals = new ApprovalManager(db, { notify: async () => {} })
    const store = new OwnerMcpServerStore({ db, project_slug: 'owner', owner_slug: asOwnerHandle('owner'),
      credentials, approvals: () => approvals })
    const f = fixture()
    try {
      const server = f.servers[0]!
      expect((await store.install({ name: server.name, command: server.command, args: server.args, env: server.env })).ok).toBe(true)
      f.setResolver(() => store.resolveApproved())
      expect(await f.broker.bind(f.context)).toEqual([])
      expect(f.operations()).toEqual([])
      const hash = (await store.list())[0]!.grant_hash
      expect((await store.decide(server.name, 'approve', hash)).ok).toBe(true)
      expect((await f.broker.bind(f.context))[0]?.name).toBe('fixture')
      await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })
      expect(f.operations()).toEqual(['spawn', 'call:inspect'])
      expect((await store.decide(server.name, 'deny', hash)).ok).toBe(true)
      await expect(f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })).rejects.toThrow()
      expect(f.operations()).toEqual(['spawn', 'call:inspect'])
    } finally {
      await f.broker.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('explicitly declared default environment survives while undeclared defaults are absent', async () => {
    const f = fixture({ HOME: '/fixture-home', PATH: '/fixture-path' })
    await f.broker.bind(f.context)
    const result = await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })
    const content = result.content as Array<{ text: string }>
    const child = JSON.parse(content[0]!.text) as { env: Record<string, string> }
    expect(child.env.HOME).toBe('/fixture-home')
    expect(child.env.PATH).toBe('/fixture-path')
    expect(child.env.USER).toBeUndefined()
    expect(child.env.SHELL).toBeUndefined()
  })

  test('restricted or absent owner lease cannot bind or use installed discovery, resources, prompts or tools', async () => {
    const f = fixture()
    f.setOwnerConversation(false)
    f.setOwnerPreparation(false)
    await expect(f.broker.bind(f.context)).rejects.toThrow()
    expect(f.reads).toBe(0)
    expect(f.operations()).toEqual([])
    f.setOwnerConversation(true)
    f.setOwnerPreparation(true)
    await f.broker.bind(f.context)
    f.setOwnerConversation(false)
    for (const method of ['tools/list', 'resources/list', 'prompts/list', 'tools/call']) {
      await expect(f.broker.request(f.context, 'fixture', { method, params: { name: 'inspect' } })).rejects.toThrow()
    }
    expect(f.operations()).toEqual(['spawn'])
    f.setOwnerConversation(true)
    expect((await f.broker.request(f.context, 'fixture', { method: 'tools/list' })).tools).toHaveLength(1)
    f.onRead(() => f.setOwnerConversation(false))
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })).rejects.toThrow()
    expect(f.operations()).toEqual(['spawn'])
  })

  test('reserved owner preparation publishes local catalog but no installed operations before native start', async () => {
    const f = fixture()
    f.setOwnerConversation(false)
    const metadata = await f.broker.bind(f.context)
    expect(metadata[0]?.catalog.find((page) => page.method === 'tools/list')?.result.tools).toHaveLength(1)
    expect(await f.broker.preparedMetadata(f.context)).toEqual(metadata)
    await expect(f.broker.activeMetadata(f.context)).rejects.toThrow()
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/list' })).rejects.toThrow()
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })).rejects.toThrow()
    expect(f.operations()).toEqual(['spawn'])
    f.setOwnerConversation(true)
    f.setContext({ idle: false })
    expect(await f.broker.activeMetadata(f.context)).toEqual(metadata)
    await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })
    expect(f.operations()).toEqual(['spawn', 'call:inspect'])
  })

  test('prepared catalog rechecks removal and is unavailable outside idle owner preparation', async () => {
    const f = fixture()
    await f.broker.bind(f.context)
    f.setContext({ idle: false })
    await expect(f.broker.preparedMetadata(f.context)).rejects.toThrow()
    f.setContext({ idle: true })
    expect((await f.broker.preparedMetadata(f.context))[0]?.name).toBe('fixture')
    f.setServers([])
    await expect(f.broker.preparedMetadata(f.context)).rejects.toThrow()
    expect(f.operations()).toEqual(['spawn'])
  })

  test('cancelled connect and overlapping admission never publish a binding', async () => {
    const f = fixture({ BROKER_TEST_CONNECT_DELAY: '150' })
    const controller = new AbortController()
    const binding = f.broker.bind(f.context, controller.signal).then(() => 'resolved', () => 'refused')
    await expect(f.broker.bind(f.context)).rejects.toThrow()
    await eventually(() => f.operations().includes('spawn'))
    controller.abort()
    expect(await binding).toBe('refused')
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/list' })).rejects.toThrow()
    expect(f.operations()).toEqual(['spawn'])
  })

  test('cancelled in-flight request refuses late output, without replacing the connected peer', async () => {
    const f = fixture()
    await f.broker.bind(f.context)
    const controller = new AbortController()
    const result = f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect', arguments: { delay: 150 } } }, controller.signal)
      .then(() => 'resolved', () => 'refused')
    await eventually(() => f.operations().includes('call:inspect'))
    controller.abort()
    expect(await result).toBe('refused')
    expect((await f.broker.request(f.context, 'fixture', { method: 'tools/list' })).tools).toHaveLength(1)
    expect(f.operations()).toEqual(['spawn', 'call:inspect'])
  })

  test('real SDK peer preserves tools, resources, templates, prompts, completion and subscriptions', async () => {
    const f = fixture()
    const metadata = await f.broker.bind(f.context)
    expect(metadata[0]?.serverInfo.name).toBe('broker-fixture')
    expect(metadata[0]?.capabilities.resources?.subscribe).toBe(true)
    expect(metadata[0]?.catalog.map((page) => page.method)).toEqual(['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'])
    f.setContext({ idle: false })
    const request = (method: string, params?: Record<string, unknown>) => f.broker.request(f.context, 'fixture', { method, ...(params ? { params } : {}) }, undefined, { consumerId: 'native-session' })
    expect((await request('tools/list')).tools).toEqual([expect.objectContaining({ name: 'inspect' })])
    const tool = await request('tools/call', { name: 'inspect', arguments: {} })
    const content = tool.content as Array<{ text: string }>
    const child = JSON.parse(content[0]!.text) as { argv: string[]; env: Record<string, string> }
    expect(child.argv).toEqual(['one two', ';literal'])
    expect(child.env.BROKER_TEST_SECRET).toBe('test-secret')
    expect(child.env.HOME).toBeUndefined()
    expect(child.env.PATH).toBeUndefined()
    expect(child.env.OPENAI_API_KEY).toBeUndefined()
    expect((await request('resources/list')).resources).toEqual([{ uri: 'fixture://one', name: 'one' }])
    expect((await request('resources/templates/list')).resourceTemplates).toEqual([{ uriTemplate: 'fixture://{name}', name: 'fixture' }])
    expect((await request('resources/read', { uri: 'fixture://one' })).contents).toEqual([{ uri: 'fixture://one', text: 'fixture text' }])
    expect((await request('prompts/list')).prompts).toEqual([{ name: 'hello' }])
    expect((await request('prompts/get', { name: 'hello' })).messages).toEqual([expect.objectContaining({ role: 'user' })])
    expect((await request('completion/complete', { ref: { type: 'ref/prompt', name: 'hello' }, argument: { name: 'name', value: 'o' } })).completion)
      .toEqual({ values: ['one'], total: 1, hasMore: false })
    await request('resources/subscribe', { uri: 'fixture://one' })
    await eventually(() => f.notifications.length === 1)
    expect(f.notifications).toEqual(['fixture:notifications/resources/updated'])
    await request('resources/unsubscribe', { uri: 'fixture://one' })
    expect(f.operations()).toEqual(['spawn', 'call:inspect', 'subscribe:fixture://one', 'unsubscribe:fixture://one'])
  })

  test('prepared and busy admission never spawn or read installed authority; prepared requests refuse', async () => {
    const f = fixture()
    f.setContext({ phase: 'prepared' })
    await expect(f.broker.bind(f.context)).rejects.toThrow()
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/list' })).rejects.toThrow()
    expect(f.reads).toBe(0)
    expect(f.operations()).toEqual([])
    f.setContext({ phase: 'active', idle: false })
    await expect(f.broker.bind(f.context)).rejects.toThrow()
    expect(f.operations()).toEqual([])
    f.setContext({ idle: true })
    await f.broker.bind(f.context)
    expect(f.operations()).toEqual(['spawn'])
  })

  for (const field of ['projectId', 'sessionId', 'threadId', 'generation', 'leaseId'] as const) {
    test(`foreign ${field} never reaches an installed peer`, async () => {
      const f = fixture()
      await f.broker.bind(f.context)
      await expect(f.broker.request({ ...f.context, [field]: 'foreign' }, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })).rejects.toThrow()
      expect(f.operations()).toEqual(['spawn'])
      await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })
      expect(f.operations()).toEqual(['spawn', 'call:inspect'])
    })
  }

  test('explicit idle owner preparation replaces a changed approved set without a failed owner turn', async () => {
    const f = fixture()
    await f.broker.bind(f.context)
    f.servers[0]!.env = { ...f.servers[0]!.env, BROKER_TEST_SECRET: 'new-approved-secret' }
    const metadata = await f.broker.bind(f.context)
    expect(metadata[0]?.name).toBe('fixture')
    expect(f.operations()).toEqual(['spawn', 'spawn'])
    const result = await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })
    expect(JSON.stringify(result)).toContain('new-approved-secret')
    f.setServers([])
    expect(await f.broker.bind(f.context)).toEqual([])
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/list' })).rejects.toThrow()
    expect(f.operations()).toEqual(['spawn', 'spawn', 'call:inspect'])
  })

  test('successor owner lease cannot authorize predecessor async work but can reuse an unchanged warm peer', async () => {
    const f = fixture()
    await f.broker.bind(f.context)
    f.setContext({ leaseId: 'lease-two' })
    await f.broker.bind(f.context)
    expect(f.operations()).toEqual(['spawn'])
    f.onRead(() => f.setContext({ leaseId: 'lease-three' }))
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })).rejects.toThrow()
    expect(f.operations()).toEqual(['spawn'])
  })

  for (const change of ['remove', 'command', 'args', 'env_names', 'env_value'] as const) {
    test(`changed ${change} closes binding and refuses before forwarding, with idle-only fresh admission`, async () => {
      const f = fixture()
      await f.broker.bind(f.context)
      const original = structuredClone(f.servers)
      if (change === 'remove') f.setServers([])
      else {
        const server = f.servers[0]!
        if (change === 'command') server.command = `${server.command}-changed`
        if (change === 'args') server.args = [...server.args].reverse()
        if (change === 'env_names') server.env_names = [...server.env_names, 'NEW_NAME']
        if (change === 'env_value') server.env = { ...server.env, BROKER_TEST_SECRET: 'rotated-test-secret' }
      }
      await expect(f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })).rejects.toThrow()
      expect(f.operations()).toEqual(['spawn'])
      expect(f.peerAlive()).toBe(false)
      f.setServers(original)
      await expect(f.broker.request(f.context, 'fixture', { method: 'tools/list' })).rejects.toThrow()
      f.setContext({ idle: false })
      await expect(f.broker.bind(f.context)).rejects.toThrow()
      expect(f.operations()).toEqual(['spawn'])
      f.setContext({ idle: true })
      await f.broker.bind(f.context)
      await f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })
      expect(f.operations()).toEqual(['spawn', 'spawn', 'call:inspect'])
    })
  }

  test('full approval snapshot is rechecked after asynchronous connect', async () => {
    const f = fixture({ BROKER_TEST_CONNECT_DELAY: '150' })
    const binding = f.broker.bind(f.context).then(() => 'resolved', () => 'refused')
    await eventually(() => f.operations().includes('spawn'))
    f.setServers([])
    expect(await binding).toBe('refused')
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/list' })).rejects.toThrow()
    expect(f.operations()).toEqual(['spawn'])
  })

  test('authority may change during async pre-forward read; request is not sent', async () => {
    const f = fixture()
    await f.broker.bind(f.context)
    f.onRead(() => f.setContext({ generation: 'new-claim' }))
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect' } })).rejects.toThrow()
    expect(f.operations()).toEqual(['spawn'])
  })

  test('revocation during an already sent request refuses its late result without respawning', async () => {
    const f = fixture()
    await f.broker.bind(f.context)
    const result = f.broker.request(f.context, 'fixture', { method: 'tools/call', params: { name: 'inspect', arguments: { delay: 150 } } })
      .then(() => 'resolved', () => 'refused')
    await eventually(() => f.operations().includes('call:inspect'))
    f.setServers([])
    expect(await result).toBe('refused')
    expect(f.operations()).toEqual(['spawn', 'call:inspect'])
  })

  test('unsupported requests and unbound servers refuse; disconnect closes only broker-owned peer', async () => {
    const f = fixture()
    const other = fixture()
    await f.broker.bind(f.context)
    await other.broker.bind(other.context)
    await expect(f.broker.request(f.context, 'fixture', { method: 'initialize' })).rejects.toThrow('Unsupported')
    await expect(f.broker.request(f.context, 'unknown', { method: 'tools/list' })).rejects.toThrow()
    await f.broker.close()
    expect(f.peerAlive()).toBe(false)
    expect(other.peerAlive()).toBe(true)
    await expect(f.broker.request(f.context, 'fixture', { method: 'tools/list' })).rejects.toThrow()
    expect((await other.broker.request(other.context, 'fixture', { method: 'tools/list' })).tools).toHaveLength(1)
  })
})
