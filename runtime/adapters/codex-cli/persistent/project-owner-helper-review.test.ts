import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexOwnerBindingFacts } from './project-control-bootstrap.ts'
import { createProjectControlBroker, ProjectControlAdmissionRefusal, ReviewPermissionBusy } from './project-control-broker.ts'
import { connectCodexOwnerHelper } from './project-owner-helper-client.ts'
import { helperIdentity, socketIdentity, type Rpc } from './project-owner-helper-protocol.ts'
import { OwnerHelperRegistry } from './project-owner-helper-registry.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

async function fixture(options: { drop?: string; badRestore?: boolean; nativeRefuseSettings?: boolean } = {}) {
  const root = mkdtempSync('/tmp/helper-review-test-'), cwd = join(root, 'project'), codexHome = join(root, 'home')
  const stageDir = join(cwd, '.neutron', 'build-results', 'a'.repeat(64))
  mkdirSync(stageDir, { recursive: true }); mkdirSync(codexHome, { mode: 0o700 })
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let receive: (message: unknown) => void = () => {}
  const sent: Rpc[] = [], wire: Rpc[] = []
  const profiles: Record<string, unknown> = {}
  let defaultPermissions: unknown = null, settingsRestored = false, bindingCurrent = true
  const before = { thread: { id: 'owner' }, cwd, sandbox: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true },
    activePermissionProfile: { id: ':workspace' }, approvalPolicy: 'on-request', approvalsReviewer: 'user', runtimeWorkspaceRoots: [cwd] }
  const broker = await createProjectControlBroker({ socketPath: join(root, 'broker.sock'), cwd, codexHome, threadId: 'owner', upstream: {
    close() {}, listen(fn) { receive = fn }, send(message) {
      sent.push(message)
      if (!message.method) return
      const params = message.params as Rpc
      let result: unknown = {}
      if (message.method === 'thread/resume') result = options.badRestore && settingsRestored ? { ...before, approvalPolicy: 'never' } : before
      if (message.method === 'thread/settings/update') settingsRestored = true
      if (message.method === 'config/read') result = { config: { mcp_servers: {}, permissions: structuredClone(profiles), default_permissions: defaultPermissions } }
      if (message.method === 'config/batchWrite') for (const edit of params.edits as Rpc[]) {
        const key = edit.keyPath as string
        if (key === 'default_permissions') defaultPermissions = edit.value
        else if (edit.value === null) delete profiles[key.slice('permissions.'.length)]
        else profiles[key.slice('permissions.'.length)] = structuredClone(edit.value)
      }
      if (message.method === 'turn/start') result = { turn: { id: settingsRestored ? 'next-owner-turn' : 'parent-turn' } }
      queueMicrotask(() => receive(options.nativeRefuseSettings && message.method === 'thread/settings/update'
        ? { id: message.id, error: { code: -32001, message: 'native refusal' } } : { id: message.id, result }))
    },
  } })
  cleanup.push(() => broker.close())
  const assertOwner = () => { if (!bindingCurrent || broker.state().phase === 'closed') throw new Error('Stale native owner binding') }
  const registry = new OwnerHelperRegistry(broker, assertOwner)
  cleanup.push(() => registry.destroy())
  const facts: CodexOwnerBindingFacts = { threadId: 'owner', sessionId: 'owner-session', cwd, codexHome,
    rolloutPath: join(codexHome, 'rollout.jsonl'), paneHandle: 'test-pane', bindingRevision: 'a'.repeat(64), generation: 1,
    brokerGeneration: broker.state().generation, credentialFingerprint: 'b'.repeat(64), modelProvider: 'fixture', controlSocketPath: join(root, 'broker.sock'),
    nativeMetadata: { sessionId: 'owner-session', source: 'cli', originator: 'fixture' },
    capabilities: { multiAgentV2: true, evidence: 'native-thread-feature-report' } }
  const helper = helperIdentity(), token = 'c'.repeat(64), socketPath = join(root, 'helper.sock'), descriptorPath = join(root, 'helper.json')
  let observation = 0
  const server = Bun.serve({ unix: socketPath, async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/owner' || request.headers.has('origin')
      || request.headers.get('authorization') !== `Bearer ${token}`) return new Response('Refused', { status: 403 })
    let operation: unknown
    try {
      assertOwner()
      const raw = await request.json() as Rpc
      operation = raw.operation
      wire.push(raw)
      const result = raw.operation === 'attach' ? { facts, helper, challenge: raw.challenge, ...registry.attach() }
        : await registry.handle(raw, request.signal)
      if (raw.operation === options.drop) return new Response('{"lost":')
      return Response.json({ ...result, state: broker.state(), observation: ++observation })
    } catch (error) {
      if (options.drop !== undefined && operation === options.drop) return new Response('{"lost":')
      return Response.json({ error: (error as Error).message }, { status: 409 })
    }
  } })
  cleanup.push(() => server.stop(true))
  chmodSync(socketPath, 0o600)
  writeFileSync(descriptorPath, JSON.stringify({ version: 1, facts, helper, socketPath, socketIdentity: socketIdentity(socketPath), token }), { mode: 0o600 })
  const connect = async (timeoutMs = 2000) => {
    const connection = await connectCodexOwnerHelper({ descriptorPath, expected: facts, timeoutMs })
    cleanup.push(() => connection.close())
    return connection
  }
  const event = (method: string, threadId: string, id: string) => receive({ method, params: { threadId, turn: { id } } })
  const identifyChild = () => receive({ method: 'item/completed', params: { threadId: 'owner', turnId: 'parent-turn',
    item: { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child' } } })
  const settle = () => { event('turn/started', 'child', 'child-turn'); identifyChild(); event('turn/completed', 'child', 'child-turn'); event('turn/completed', 'owner', 'parent-turn') }
  return { broker, registry, connect, stageDir, sent, wire, profiles, event, identifyChild, settle, receive,
    journalPath: join(root, 'broker.sock.sqlite'), invalidate() { bindingCurrent = false } }
}

test('private helper transport prepares exact permissions, restores native readback, and permits the next owner turn', async () => {
  const f = await fixture(), connection = await f.connect()
  const lease = await connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)
  expect(Object.values(f.profiles)).toEqual([{ filesystem: { ':root': 'read', [f.stageDir]: 'write' }, network: { enabled: false } }])
  expect(await lease.start([{ type: 'text', text: 'bounded review' }])).toEqual({ turnId: 'parent-turn' })
  await expect(lease.start([])).rejects.toThrow('unavailable')
  expect(f.sent.filter(message => message.method === 'turn/start')).toHaveLength(1)
  f.settle(); await lease.restore()
  const nativeTui = f.broker.gateway('native-before-release')
  await expect(nativeTui.request('turn/start', { threadId: 'owner', input: [] }, f.broker.state().epoch)).rejects.toThrow('review')
  await lease.release()
  expect(f.profiles).toEqual({})
  const writer = connection.broker.gateway('next-owner')
  expect(await writer.request('turn/start', { threadId: 'owner', input: [] }, connection.broker.state().epoch)).toEqual({ turn: { id: 'next-owner-turn' } })
  expect(f.wire.filter(message => String(message.operation).startsWith('review')).map(message => message.operation))
    .toEqual(['reviewPrepare', 'reviewStart', 'reviewRestore', 'reviewAcknowledge', 'reviewRelease'])
})

test('authenticated local admission refusal stays typed across the helper, but native refusal does not', async () => {
  const f = await fixture(), connection = await f.connect()
  const nativeOwner = f.broker.gateway('native-owner')
  await nativeOwner.request('turn/start', { threadId: 'owner', input: [] }, f.broker.state().epoch)
  const before = f.broker.state(), sentBefore = f.sent.length
  const switcher = connection.broker.gateway('model-switch')
  await expect(switcher.request('thread/settings/update', { threadId: 'owner', model: 'next' }, before.epoch))
    .rejects.toBeInstanceOf(ProjectControlAdmissionRefusal)
  expect(f.broker.state()).toEqual(before)
  expect(f.sent).toHaveLength(sentBefore)
  expect(connection.broker.state().phase).toBe('turn')
  f.event('turn/completed', 'owner', 'parent-turn')
  await expect(switcher.request('thread/settings/update', { threadId: 'owner', model: 'next' }, f.broker.state().epoch))
    .resolves.toEqual({})
  const nextOwner = connection.broker.gateway('next-owner')
  await expect(nextOwner.request('turn/start', { threadId: 'owner', input: [] }, f.broker.state().epoch))
    .resolves.toEqual({ turn: { id: 'next-owner-turn' } })

  const unknown = await fixture({ nativeRefuseSettings: true }), other = await unknown.connect()
  const pending = other.broker.gateway('uncertain-switch').request('thread/settings/update', { threadId: 'owner', model: 'next' }, unknown.broker.state().epoch)
  const error = await pending.catch(cause => cause)
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(ProjectControlAdmissionRefusal)
  expect(unknown.broker.state().epoch).toBe(1)
  expect(unknown.sent.some(message => message.method === 'thread/settings/update')).toBe(true)
})

test('a restored helper supports a second review without treating a previous acknowledgement as a new lease', async () => {
  const f = await fixture(), connection = await f.connect()
  const first = await connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)
  await first.start([]); f.settle(); await first.restore(); await first.release()
  const second = await connection.reviewPrepare({ stageDir: f.stageDir, network: true }, connection.broker.state().epoch)
  expect(Object.values(f.profiles)).toEqual([{ filesystem: { ':root': 'read', [f.stageDir]: 'write' }, network: { enabled: true } }])
  expect(await second.start([])).toEqual({ turnId: 'next-owner-turn' })
  second.abandon()
})

test('stale frontend grant, foreign lease, stale epoch and caller policy fields never dispatch', async () => {
  const f = await fixture(), signal = AbortSignal.abort()
  const oldGrant = f.registry.attach().grant, grant = f.registry.attach().grant
  const prepare = { operation: 'reviewPrepare', grant, stageDir: f.stageDir, network: false, epoch: f.broker.state().epoch }
  await expect(f.registry.handle({ ...prepare, grant: oldGrant }, signal)).rejects.toThrow('Stale')
  await expect(f.registry.handle({ ...prepare, epoch: -1 }, signal)).rejects.toThrow('preparation')
  for (const extra of [{ cwd: f.stageDir }, { permissions: ':danger-full-access' }, { approvalPolicy: 'never' }, { network: 'yes' }]) {
    await expect(f.registry.handle({ ...prepare, ...extra }, signal)).rejects.toThrow()
  }
  const ready = await f.registry.handle(prepare, signal)
  expect(ready.lease).toMatch(/^[a-f0-9]{64}$/)
  expect(() => f.registry.attach()).toThrow('reconciliation')
  await expect(f.registry.handle({ operation: 'reviewRelease', grant, lease: ready.lease }, signal)).rejects.toThrow('unavailable')
  await expect(f.registry.handle({ operation: 'reviewAcknowledge', grant, lease: ready.lease }, signal)).rejects.toThrow('unavailable')
  await expect(f.registry.handle({ operation: 'reviewStart', grant, lease: 'forged', input: [] }, signal)).rejects.toThrow('Foreign')
  await expect(f.registry.handle({ operation: 'reviewStart', grant, lease: ready.lease, input: [], sandboxPolicy: {} }, signal)).rejects.toThrow('field')
  expect(f.sent.some(message => message.method === 'turn/start')).toBe(false)
  expect(await f.registry.handle({ operation: 'reviewStart', grant, lease: ready.lease, input: [] }, signal)).toEqual({ turnId: 'parent-turn' })
  await expect(f.registry.handle({ operation: 'reviewStart', grant, lease: ready.lease, input: [] }, signal)).rejects.toThrow('unavailable')
  expect(f.sent.filter(message => message.method === 'turn/start')).toHaveLength(1)
})

test('owner RPC cannot forge private review methods, with an ordinary native read as positive control', async () => {
  const f = await fixture(), connection = await f.connect(), writer = connection.broker.gateway('owner-rpc')
  expect(await writer.request('thread/read', { threadId: 'owner' })).toEqual({})
  for (const method of ['reviewPrepare', 'reviewStart', 'reviewRestore', 'reviewAbandon', 'reviewAcknowledge', 'reviewRelease', 'reviewWaitSettled', 'review/prepare']) {
    await expect(writer.request(method, { threadId: 'owner', stageDir: f.stageDir, network: false, input: [] }, connection.broker.state().epoch)).rejects.toThrow('Unclassified')
  }
  expect(f.sent.some(message => message.method === 'thread/read')).toBe(true)
  expect(f.sent.some(message => String(message.method).startsWith('review'))).toBe(false)
})

for (const drop of ['reviewPrepare', 'reviewStart', 'reviewRestore', 'reviewAcknowledge']) test(`lost ${drop} response fences the proxy and retains helper exclusivity without replay`, async () => {
  const f = await fixture({ drop }), connection = await f.connect()
  const operation = async () => {
    const lease = await connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)
    await lease.start([]); f.settle(); await lease.restore(); await lease.release()
  }
  const outcome = operation()
  await expect(outcome).rejects.toThrow('outcome may be unknown')
  expect(await outcome.catch(error => error)).not.toBeInstanceOf(ReviewPermissionBusy)
  expect(connection.broker.state().phase).toBe('closed')
  expect(() => f.registry.attach()).toThrow('reconciliation')
  await expect(f.connect()).rejects.toThrow('reconciliation')
  const grant = f.wire.find(message => message.operation === 'reviewPrepare')!.grant
  await expect(f.registry.handle({ operation: 'request', grant, clientId: 'forged', method: 'turn/start', params: { threadId: 'owner', input: [] } }, AbortSignal.abort()))
    .rejects.toThrow('exclusive')
  const nativeTui = f.broker.gateway('direct-native-tui')
  await expect(nativeTui.request('turn/start', { threadId: 'owner', input: [] }, f.broker.state().epoch)).rejects.toThrow('review')
  expect(f.wire.filter(message => message.operation === drop)).toHaveLength(1)
})

for (const wrongChild of [false, true]) test(`${wrongChild ? 'wrong child' : 'parent-only'} completion cannot release the private helper lease`, async () => {
  const f = await fixture(), connection = await f.connect()
  const lease = await connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)
  await lease.start([])
  f.event('turn/completed', 'owner', 'parent-turn')
  if (wrongChild) { f.identifyChild(); f.event('turn/started', 'child', 'child-turn'); f.event('turn/completed', 'foreign', 'child-turn') }
  await expect(lease.restore()).rejects.toThrow('reconciliation')
  expect(f.sent.some(message => message.method === 'thread/settings/update')).toBe(false)
  expect(connection.broker.state().phase).toBe('closed')
})

test('lost final release response fences the old proxy after the helper has proven acknowledgement delivery', async () => {
  const f = await fixture({ drop: 'reviewRelease' }), connection = await f.connect()
  const lease = await connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)
  await lease.start([]); f.settle(); await lease.restore()
  await expect(lease.release()).rejects.toThrow('outcome may be unknown')
  expect(connection.broker.state().phase).toBe('closed')
  expect(() => connection.broker.gateway('stale-after-receipt')).toThrow('outcome may be unknown')
  const replacement = await f.connect(), writer = replacement.broker.gateway('replacement-after-receipt')
  expect(await writer.request('turn/start', { threadId: 'owner', input: [] }, replacement.broker.state().epoch)).toEqual({ turn: { id: 'next-owner-turn' } })
})

test('restore readback mismatch and replaced native binding cannot return writable helper authority', async () => {
  const f = await fixture({ badRestore: true }), connection = await f.connect()
  const lease = await connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)
  await lease.start([]); f.settle()
  await expect(lease.restore()).rejects.toThrow('reconciliation')
  expect(connection.broker.state().phase).toBe('closed')
  const replaced = await fixture(), next = await replaced.connect()
  const nextLease = await next.reviewPrepare({ stageDir: replaced.stageDir, network: false }, next.broker.state().epoch)
  replaced.invalidate()
  await expect(nextLease.start([])).rejects.toThrow('Stale native')
  expect(replaced.sent.some(message => message.method === 'turn/start')).toBe(false)
})

test('abandon synchronously fences the proxy even when its helper response is lost', async () => {
  const f = await fixture({ drop: 'reviewAbandon' }), connection = await f.connect()
  const lease = await connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)
  lease.abandon()
  expect(connection.broker.state().phase).toBe('closed')
  expect(() => connection.broker.gateway('after-abandon')).toThrow('abandoned')
  await expect(lease.start([])).rejects.toThrow('abandoned')
  expect(() => f.registry.attach()).toThrow('reconciliation')
  expect(f.sent.some(message => message.method === 'turn/start')).toBe(false)
  for (let attempt = 0; attempt < 20 && !f.wire.some(message => message.operation === 'reviewAbandon'); attempt++) await Bun.sleep(5)
  expect(f.wire.filter(message => message.operation === 'reviewAbandon')).toHaveLength(1)
  expect(f.broker.state().phase).toBe('closed')
})

test('private settlement wait survives the ordinary transport deadline and waits for delayed exact child completion', async () => {
  const f = await fixture(), connection = await f.connect(250)
  const lease = await connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)
  await lease.start([])
  f.event('turn/started', 'child', 'child-turn'); f.identifyChild(); f.event('turn/completed', 'owner', 'parent-turn')
  const timer = setTimeout(() => f.event('turn/completed', 'child', 'child-turn'), 350)
  try { expect(await lease.waitSettled(1500)).toBe(true) } finally { clearTimeout(timer) }
  await expect(lease.waitSettled(1500)).rejects.toThrow('wait')
  expect(f.wire.filter(message => message.operation === 'reviewWaitSettled')).toHaveLength(1)
  await lease.restore(); await lease.release()
  const writer = connection.broker.gateway('after-delayed-child')
  expect(await writer.request('turn/start', { threadId: 'owner', input: [] }, connection.broker.state().epoch)).toEqual({ turn: { id: 'next-owner-turn' } })
})

for (const wrongChild of [false, true]) test(`private settlement wait fences on ${wrongChild ? 'wrong' : 'absent'} child completion timeout`, async () => {
  const f = await fixture(), connection = await f.connect()
  const lease = await connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)
  await lease.start([]); f.event('turn/completed', 'owner', 'parent-turn')
  if (wrongChild) { f.event('turn/started', 'child', 'child-turn'); f.identifyChild(); f.event('turn/completed', 'foreign', 'child-turn') }
  await expect(lease.waitSettled(20)).rejects.toThrow()
  expect(connection.broker.state().phase).toBe('closed')
  expect(f.broker.state().phase).toBe('closed')
  await expect(lease.restore()).rejects.toThrow()
  expect(f.sent.some(message => message.method === 'thread/settings/update')).toBe(false)
})

test('private settlement wait rejects unsafe bounds and foreign lease, grant or epoch before observing completion', async () => {
  const f = await fixture(), signal = AbortSignal.abort(), grant = f.registry.attach().grant
  const ready = await f.registry.handle({ operation: 'reviewPrepare', grant, stageDir: f.stageDir, network: false, epoch: f.broker.state().epoch }, signal)
  await f.registry.handle({ operation: 'reviewStart', grant, lease: ready.lease, input: [] }, signal)
  const wait = { operation: 'reviewWaitSettled', grant, lease: ready.lease, timeoutMs: 20 }
  for (const timeoutMs of [0, -1, 60_001, 1.5, Infinity, NaN, '20']) await expect(f.registry.handle({ ...wait, timeoutMs }, signal)).rejects.toThrow('wait')
  await expect(f.registry.handle({ ...wait, grant: 'foreign' }, signal)).rejects.toThrow('grant')
  await expect(f.registry.handle({ ...wait, lease: 'foreign' }, signal)).rejects.toThrow('lease')
  const state = f.broker.state
  f.broker.state = () => ({ ...state(), epoch: state().epoch + 1 })
  await expect(f.registry.handle(wait, signal)).rejects.toThrow('epoch')
  f.broker.state = state
  f.settle()
  expect(await f.registry.handle(wait, signal)).toEqual({ settled: true })
})

test('lost settlement wait response fences the proxy, retains the native writer lock, and is never replayed', async () => {
  const f = await fixture({ drop: 'reviewWaitSettled' }), connection = await f.connect()
  const lease = await connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)
  await lease.start([]); f.settle()
  await expect(lease.waitSettled(20)).rejects.toThrow('outcome may be unknown')
  expect(connection.broker.state().phase).toBe('closed')
  expect(() => f.registry.attach()).toThrow('reconciliation')
  await expect(lease.waitSettled(20)).rejects.toThrow('outcome may be unknown')
  const nativeTui = f.broker.gateway('native-after-lost-wait')
  await expect(nativeTui.request('turn/start', { threadId: 'owner', input: [] }, f.broker.state().epoch)).rejects.toThrow('review')
  expect(f.wire.filter(message => message.operation === 'reviewWaitSettled')).toHaveLength(1)
})

test('known busy preparation preserves the active helper owner, its approval reply, and subsequent owner chat', async () => {
  const f = await fixture(), connection = await f.connect(), writer = connection.broker.gateway('active-owner')
  const approvals: Rpc[] = []
  writer.subscribe(message => { if (message.id === 'approval-during-busy') approvals.push(message) })
  await writer.request('turn/start', { threadId: 'owner', input: [] }, connection.broker.state().epoch)
  const refused = connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)
  await expect(refused).rejects.toBeInstanceOf(ReviewPermissionBusy)
  await expect(refused).rejects.toThrow('busy')
  expect(connection.broker.state().phase).toBe('turn')
  f.receive({ id: 'approval-during-busy', method: 'item/commandExecution/requestApproval', params: { threadId: 'owner', turnId: 'parent-turn' } })
  for (let attempt = 0; attempt < 100 && !approvals.length; attempt++) await Bun.sleep(5)
  expect(approvals).toHaveLength(1)
  await connection.replyApproval('active-owner', 'approval-during-busy', { decision: 'accept' }, connection.broker.state().epoch)
  expect(f.sent).toContainEqual({ id: 'approval-during-busy', result: { decision: 'accept' } })
  f.event('turn/completed', 'owner', 'parent-turn'); await connection.refreshState()
  expect(await writer.request('turn/start', { threadId: 'owner', input: [] }, connection.broker.state().epoch)).toEqual({ turn: { id: 'parent-turn' } })
  expect(f.sent.some(message => message.method === 'config/batchWrite')).toBe(false)
})

test('a native owner claims idle after helper preflight without leaving a phantom review reservation', async () => {
  const f = await fixture(), connection = await f.connect(), nativeOwner = f.broker.gateway('racing-native-owner')
  const prepare = f.broker.reviewPermissions.bind(f.broker)
  f.broker.reviewPermissions = async (request, epoch) => {
    await nativeOwner.request('turn/start', { threadId: 'owner', input: [] }, epoch)
    return prepare(request, epoch)
  }
  await expect(connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)).rejects.toThrow('busy')
  expect(connection.broker.state().phase).toBe('turn')
  expect(f.sent.some(message => message.method === 'config/batchWrite')).toBe(false)
  f.event('turn/completed', 'owner', 'parent-turn'); await connection.refreshState()
  const next = await f.connect(), writer = next.broker.gateway('after-native-race')
  expect(await writer.request('turn/start', { threadId: 'owner', input: [] }, next.broker.state().epoch)).toEqual({ turn: { id: 'parent-turn' } })
})

test('generic preparation failure after native reservation retains its unknown lease and native writer fence', async () => {
  const f = await fixture(), connection = await f.connect(), prepare = f.broker.reviewPermissions.bind(f.broker)
  f.broker.reviewPermissions = async (request, epoch) => {
    await prepare(request, epoch)
    throw new Error('Unknown native preparation receipt')
  }
  const failed = connection.reviewPrepare({ stageDir: f.stageDir, network: false }, connection.broker.state().epoch)
  await expect(failed).rejects.toThrow('Unknown native')
  expect(await failed.catch(error => error)).not.toBeInstanceOf(ReviewPermissionBusy)
  expect(f.sent.some(message => message.method === 'config/batchWrite')).toBe(true)
  const journal = new Database(f.journalPath, { readonly: true })
  try { expect(journal.query('SELECT unresolved FROM broker WHERE id=1').get()).toEqual({ unresolved: 'review-permissions' }) }
  finally { journal.close() }
  expect(connection.broker.state().phase).toBe('closed')
  expect(() => f.registry.attach()).toThrow('reconciliation')
  const nativeTui = f.broker.gateway('after-unknown-prepare')
  await expect(nativeTui.request('turn/start', { threadId: 'owner', input: [] }, f.broker.state().epoch)).rejects.toThrow('review')
})
