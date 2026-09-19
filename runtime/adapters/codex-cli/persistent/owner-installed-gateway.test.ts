import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ApprovedMcpBroker, type ApprovedMcpContext } from './approved-mcp-broker.ts'
import { CodexOwnerInstalledGateway, OWNER_INSTALLED_GATEWAY_TOOL } from './owner-installed-gateway.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'owner-gateway-'))
  const log = join(dir, 'peer.log')
  const context: ApprovedMcpContext = { projectId: 'project', sessionId: 'binding', threadId: 'thread',
    generation: 'daemon', leaseId: 'owner', phase: 'active', idle: true }
  let owner = true
  let claimed = true
  let approved = true
  let secretValue = 'initial'
  const assertCurrent = () => { if (!claimed) throw new Error('Claim lost') }
  const assertOwner = () => { assertCurrent(); if (!owner) throw new Error('Not owner') }
  let gateway: CodexOwnerInstalledGateway
  const broker = new ApprovedMcpBroker({ currentContext: () => ({ ...context }),
    assertOwnerPreparation: assertOwner, assertOwnerConversation: assertOwner,
    resolveApproved: async () => approved ? [{ name: 'approved', command: process.execPath,
      args: [join(import.meta.dir, 'fixtures/approved-mcp-server.ts')], env_names: ['BROKER_TEST_LOG', 'BROKER_TEST_VALUE'],
      env: { BROKER_TEST_LOG: log, BROKER_TEST_VALUE: secretValue } }] : [],
    onRetired: () => gateway?.retireConsumers(),
    onNotification: (scope, server, notification, consumers) => gateway.notify(scope, server, notification, consumers),
  })
  gateway = new CodexOwnerInstalledGateway({ broker, context: () => ({ ...context }), assertCurrent })
  cleanups.push(async () => { await gateway.close(); rmSync(dir, { recursive: true, force: true }) })
  await broker.bind(context)
  context.idle = false
  let sequence = 0
  const call = async (args: Record<string, unknown>, signal = new AbortController().signal, patch: Record<string, unknown> = {}) => {
    const response = await gateway.handle({ id: ++sequence, method: 'item/tool/call', params: {
      threadId: context.threadId, turnId: 'turn', callId: `call-${sequence}`, tool: OWNER_INSTALLED_GATEWAY_TOOL.name,
      arguments: args, ...patch,
    } }, signal, assertOwner, context.leaseId) as { success: boolean; contentItems: Array<{ text: string }> }
    expect(response.success).toBe(true)
    return JSON.parse(response.contentItems[0]!.text)
  }
  const open = async () => (await call({ action: 'open', server: 'approved' })).handle as string
  const request = (handle: string, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) =>
    call({ action: 'request', handle, method, params }, signal)
  return { broker, gateway, context, call, open, request, assertOwner,
    lines: () => readFileSync(log, 'utf8').trim().split('\n'),
    restrict: () => { owner = false }, restoreOwner: () => { owner = true },
    revoke: () => { approved = false }, loseClaim: () => { claimed = false }, rotate: () => { secretValue = 'rotated' } }
}

test('fixed gateway preserves complete approved discovery and original MCP results; refuses unapproved and injected authority', async () => {
  const f = await fixture()
  const discovered = await f.call({ action: 'discover' })
  expect(discovered.servers[0].capabilities.resources.subscribe).toBe(true)
  expect(discovered.servers[0].catalog.map((page: { method: string }) => page.method)).toEqual([
    'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list',
  ])
  const handle = await f.open()
  expect(await f.request(handle, 'resources/read', { uri: 'fixture://one' })).toEqual({ contents: [{ uri: 'fixture://one', text: 'fixture text' }] })
  expect(await f.request(handle, 'prompts/get', { name: 'hello' })).toEqual({ messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }] })
  expect(await f.request(handle, 'completion/complete', { ref: { type: 'ref/prompt', name: 'hello' }, argument: { name: 'name', value: '' } })).toEqual({ completion: { values: ['one'], total: 1, hasMore: false } })
  await expect(f.call({ action: 'open', server: 'foreign' })).rejects.toThrow()
  await expect(f.request('foreign', 'tools/list')).rejects.toThrow()
  await expect(f.request(handle, 'initialize')).rejects.toThrow('Unsupported')
  for (const field of ['projectId', 'threadId', 'leaseId', 'generation', 'credentials', 'command']) {
    await expect(f.call({ action: 'discover', [field]: 'injected' })).rejects.toThrow('Invalid')
  }
  await expect(f.call({ action: 'discover' }, undefined, { threadId: 'child' })).rejects.toThrow('Invalid')
  f.restrict()
  await expect(f.request(handle, 'tools/list')).rejects.toThrow('Not owner')
  f.restoreOwner()
  expect((await f.request(handle, 'tools/list')).tools[0].name).toBe('inspect')
})

test('progress arrives concurrently while the original request remains pending and preserves the original token', async () => {
  const f = await fixture()
  const handle = await f.open()
  let finished = false
  const pending = f.request(handle, 'tools/call', { name: 'inspect', arguments: { progress: true }, _meta: { progressToken: 'original-token' } })
    .then(value => { finished = true; return value })
  const received = await f.call({ action: 'receive', handle })
  expect(received.notifications).toEqual([{ method: 'notifications/progress', params: {
    progressToken: 'original-token', progress: 1, total: 2, message: 'fixture progress',
  } }])
  expect(finished).toBe(false)
  expect((await pending).content[0].type).toBe('text')
})

test('distinct consumers share subscriptions, filter recipients and reconcile final closed consumer on next idle admission', async () => {
  const f = await fixture()
  const first = await f.open()
  const second = await f.open()
  const outsider = await f.open()
  await f.request(first, 'resources/subscribe', { uri: 'fixture://one' })
  await f.request(second, 'resources/subscribe', { uri: 'fixture://one' })
  expect(f.lines().filter(line => line === 'subscribe:fixture://one')).toHaveLength(1)
  await f.request(first, 'tools/call', { name: 'inspect', arguments: { notifyUri: 'fixture://one' } })
  expect((await f.call({ action: 'receive', handle: first })).notifications.some((n: { method: string }) => n.method === 'notifications/resources/updated')).toBe(true)
  expect((await f.call({ action: 'receive', handle: second })).notifications.some((n: { method: string }) => n.method === 'notifications/resources/updated')).toBe(true)
  // A global envelope is an ordering barrier: the outsider must see it alone.
  await f.gateway.notify({ ...f.context }, 'approved', { method: 'notifications/tools/list_changed' })
  expect((await f.call({ action: 'receive', handle: outsider })).notifications).toEqual([{ method: 'notifications/tools/list_changed' }])
  await f.call({ action: 'close', handle: first })
  expect(f.lines().filter(line => line.startsWith('unsubscribe:'))).toHaveLength(0)
  await f.call({ action: 'close', handle: second })
  f.context.idle = true
  f.context.leaseId = 'successor'
  await f.broker.bind(f.context)
  f.context.idle = false
  expect(f.lines().filter(line => line === 'unsubscribe:fixture://one')).toHaveLength(1)
  expect(f.lines().filter(line => line === 'spawn')).toHaveLength(1)
  await expect(f.request(first, 'tools/list')).rejects.toThrow('retired')
  expect((await f.request(outsider, 'tools/list')).tools[0].name).toBe('inspect')
})

test('successor owner retains handles but never receives predecessor envelopes', async () => {
  const f = await fixture()
  const handle = await f.open()
  await f.gateway.notify({ ...f.context }, 'approved', { method: 'notifications/message', params: { level: 'info', data: 'old' } })
  f.context.leaseId = 'successor'
  f.context.idle = true
  await f.broker.bind(f.context)
  f.context.idle = false
  await f.gateway.notify({ ...f.context }, 'approved', { method: 'notifications/message', params: { level: 'info', data: 'new' } })
  expect((await f.call({ action: 'receive', handle })).notifications).toEqual([{ method: 'notifications/message', params: { level: 'info', data: 'new' } }])
})

test('receive and pending upstream request cancel, close retires outstanding work, revocation prevents delivery', async () => {
  const f = await fixture()
  const handle = await f.open()
  const abort = new AbortController()
  const receive = f.call({ action: 'receive', handle }, abort.signal)
  abort.abort()
  await expect(receive).rejects.toThrow()
  const requestAbort = new AbortController()
  const pending = f.request(handle, 'tools/call', { name: 'inspect', arguments: { delay: 1000 } }, requestAbort.signal)
  requestAbort.abort()
  await expect(pending).rejects.toThrow()
  const receiving = f.call({ action: 'receive', handle })
  await f.call({ action: 'close', handle })
  await expect(receiving).rejects.toThrow()
  const current = await f.open()
  await f.gateway.notify({ ...f.context }, 'approved', { method: 'notifications/tools/list_changed' })
  f.revoke()
  await expect(f.call({ action: 'receive', handle: current })).rejects.toThrow()
})

test('notification overflow retires the affected consumer instead of silently truncating', async () => {
  const f = await fixture()
  const handle = await f.open()
  const small = await f.open()
  await f.call({ action: 'close', handle: small })
  await expect(f.gateway.notify({ ...f.context }, 'approved', { method: 'notifications/message', params: {
    level: 'info', data: 'x'.repeat(1024 * 1024),
  } })).rejects.toThrow('overflow')
  await expect(f.call({ action: 'receive', handle })).rejects.toThrow('retired')
  expect(await f.open()).toBeTruthy()
})

test('one full consumer does not suppress the same notification for another consumer', async () => {
  const f = await fixture()
  const full = await f.open()
  for (let i = 0; i < 256; i++) await f.gateway.notify({ ...f.context }, 'approved', { method: 'notifications/tools/list_changed' })
  const fresh = await f.open()
  await expect(f.gateway.notify({ ...f.context }, 'approved', { method: 'notifications/tools/list_changed' })).rejects.toThrow('overflow')
  await expect(f.call({ action: 'receive', handle: full })).rejects.toThrow('retired')
  expect((await f.call({ action: 'receive', handle: fresh })).notifications).toEqual([{ method: 'notifications/tools/list_changed' }])
})

test('claim loss and authority revocation while receiving cannot return previously queued metadata', async () => {
  const f = await fixture()
  const handle = await f.open()
  const receiving = f.call({ action: 'receive', handle })
  f.loseClaim()
  await expect(receiving).rejects.toThrow()
  await expect(f.call({ action: 'discover' })).rejects.toThrow('Claim lost')
})

test('changed approved snapshot retires previous handles while fresh owner admission opens the replacement', async () => {
  const f = await fixture()
  const old = await f.open()
  f.rotate()
  f.context.idle = true
  f.context.leaseId = 'new-owner'
  await f.broker.bind(f.context)
  f.context.idle = false
  await expect(f.request(old, 'tools/list')).rejects.toThrow('retired')
  expect((await f.request(await f.open(), 'tools/list')).tools[0].name).toBe('inspect')
  expect(f.lines().filter(line => line === 'spawn')).toHaveLength(2)
})
