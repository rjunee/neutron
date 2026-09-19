import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createReviewPermissionTransaction, prepareNativeReviewPermissions, type ReviewPermissionHost } from './project-review-permissions.ts'

type Rpc = Record<string, any>
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture(options: { alteredGrant?: boolean; mcp?: boolean; badRestore?: boolean; loseStart?: boolean; loseCleanup?: boolean } = {}) {
  const root = mkdtempSync('/tmp/review-permission-test-'), cwd = join(root, 'project'), codexHome = join(root, 'home')
  const stageDir = join(cwd, '.neutron', 'build-results', 'a'.repeat(64))
  mkdirSync(stageDir, { recursive: true }); mkdirSync(codexHome)
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const calls: { method: string; params: Rpc }[] = []
  const config: Rpc = { mcp_servers: options.mcp ? { writer: {} } : {}, permissions: {}, default_permissions: null }
  const before = { thread: { id: 'owner' }, cwd, sandbox: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false },
    activePermissionProfile: { id: ':workspace', extends: null }, approvalPolicy: 'on-request', approvalsReviewer: 'user', runtimeWorkspaceRoots: [cwd] }
  let finished = 0, fenced = 0, restored = false
  const host: ReviewPermissionHost = { cwd, codexHome, threadId: 'owner', assertCurrent() {}, finish() { finished++ }, fence() { fenced++ },
    async rpc(method, params) {
      calls.push({ method, params })
      if (method === 'thread/resume') return options.badRestore && restored ? { ...before, approvalPolicy: 'never' } : structuredClone(before)
      if (method === 'config/read') return { config: structuredClone(config) }
      if (method === 'config/batchWrite') {
        if (restored && options.loseCleanup) return {}
        for (const edit of params.edits as Rpc[]) {
          if (edit.keyPath === 'default_permissions') config.default_permissions = edit.value
          else if (edit.value === null) delete config.permissions[edit.keyPath.slice('permissions.'.length)]
          else config.permissions[edit.keyPath.slice('permissions.'.length)] = options.alteredGrant
            ? { ...edit.value, filesystem: { ':root': 'write' } } : structuredClone(edit.value)
        }
        return {}
      }
      if (method === 'turn/start') {
        if (options.loseStart) throw new Error('lost native receipt')
        return { turn: { id: 'parent-turn' } }
      }
      if (method === 'thread/settings/update') { restored = true; return {} }
      throw new Error('Unexpected fixture RPC')
    },
  }
  const transaction = createReviewPermissionTransaction(host, { stageDir, network: false })
  const event = (method: string, threadId: string, id: string): void => transaction.observe({ method, params: { threadId, turn: { id } } })
  function settle(): void {
    event('turn/started', 'child', 'child-turn')
    transaction.observe({ method: 'item/completed', params: { threadId: 'owner', turnId: 'parent-turn', item: { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child' } } })
    event('turn/completed', 'child', 'child-turn')
    event('turn/completed', 'owner', 'parent-turn')
  }
  return { host, root, cwd, codexHome, stageDir, transaction, calls, config, settle, finished: () => finished, fenced: () => fenced }
}

test('exact profile survives config readback, native child correlation, then restored policy and config release the lease', async () => {
  const f = fixture(), lease = await f.transaction.prepare()
  const started = await lease.start([{ type: 'text', text: 'review' }])
  expect(started.turnId).toBe('parent-turn')
  const params = f.calls.find(call => call.method === 'turn/start')!.params
  expect(params.approvalPolicy).toBe('never')
  expect(params).not.toHaveProperty('sandboxPolicy')
  expect(f.config.permissions[params.permissions]).toEqual({ filesystem: { ':root': 'read', [f.stageDir]: 'write' }, network: { enabled: false } })
  expect(f.finished()).toBe(0)
  f.settle()
  expect(await lease.waitSettled(10)).toBe(true)
  await lease.restore()
  expect(f.finished()).toBe(0)
  await lease.release()
  expect(f.finished()).toBe(1); expect(f.fenced()).toBe(0)
  expect(f.config.permissions).toEqual({}); expect(f.config.default_permissions).toBeNull()
  await expect(lease.start([])).rejects.toThrow('already used')
  await expect(lease.restore()).rejects.toThrow('already requested')
  lease.abandon()
  expect(f.fenced()).toBe(0)
})

test('a proxy without the native host capability returns capability-unsupported before touching configuration', async () => {
  const f = fixture()
  expect(await prepareNativeReviewPermissions({}, { stageDir: f.stageDir, network: false }, 0)).toEqual({ kind: 'refused', reason: 'capability-unsupported' })
  expect(f.calls).toHaveLength(0)
})

test('a native profile readback that grants extra writes fences before model execution', async () => {
  const f = fixture({ alteredGrant: true })
  await expect(f.transaction.prepare()).rejects.toThrow('profile verification')
  expect(f.calls.some(call => call.method === 'turn/start')).toBe(false)
  expect(f.fenced()).toBeGreaterThan(0); expect(f.finished()).toBe(0)
})

test('an enabled MCP server is refused because native filesystem policy cannot limit its writes', async () => {
  const f = fixture({ mcp: true })
  await expect(f.transaction.prepare()).rejects.toThrow('tool admission')
  expect(f.calls.some(call => call.method === 'config/batchWrite')).toBe(false)
})

test('parent completion and unrelated child completion cannot restore or release permissions', async () => {
  const f = fixture(), lease = await f.transaction.prepare()
  await lease.start([])
  for (const threadId of ['owner', 'foreign']) f.transaction.observe({ method: 'turn/completed', params: { threadId, turn: { id: 'parent-turn' } } })
  await expect(lease.restore()).rejects.toThrow('settlement')
  expect(f.calls.some(call => call.method === 'thread/settings/update')).toBe(false)
  expect(f.finished()).toBe(0)
})

test('restoration requires the transitive child tree: a live grandchild fences, a settled grandchild releases', async () => {
  for (const grandchildSettled of [false, true]) {
    const f = fixture(), lease = await f.transaction.prepare()
    await lease.start([]); f.settle()
    f.transaction.observe({ method: 'turn/started', params: { threadId: 'grandchild', turn: { id: 'grandchild-turn' } } })
    f.transaction.observe({ method: 'item/completed', params: { threadId: 'child', turnId: 'child-turn',
      item: { type: 'subAgentActivity', kind: 'started', agentThreadId: 'grandchild' } } })
    if (grandchildSettled) {
      f.transaction.observe({ method: 'turn/completed', params: { threadId: 'grandchild', turn: { id: 'grandchild-turn' } } })
      await lease.restore()
      expect(f.finished()).toBe(0)
      await lease.release()
      expect(f.finished()).toBe(1); expect(f.fenced()).toBe(0)
    } else {
      await expect(lease.restore()).rejects.toThrow('settlement')
      expect(f.finished()).toBe(0); expect(f.fenced()).toBeGreaterThan(0)
      expect(f.calls.some(call => call.method === 'thread/settings/update')).toBe(false)
    }
  }
})

test('an observed native thread without a correlated spawn edge cannot be assumed unrelated', async () => {
  const f = fixture(), lease = await f.transaction.prepare()
  await lease.start([]); f.settle()
  for (const method of ['turn/started', 'turn/completed']) f.transaction.observe({ method, params: { threadId: 'unclassified', turn: { id: 'unknown-turn' } } })
  await expect(lease.restore()).rejects.toThrow('settlement')
  expect(f.finished()).toBe(0)
})

test('bounded settlement waits for delayed correlated completion without restoring early', async () => {
  const f = fixture(), lease = await f.transaction.prepare()
  await lease.start([])
  const waiting = lease.waitSettled(1000)
  expect(f.calls.some(call => call.method === 'thread/settings/update')).toBe(false)
  expect(f.finished()).toBe(0)
  setTimeout(() => f.settle(), 5)
  expect(await waiting).toBe(true)
  expect(f.fenced()).toBe(0)
  await lease.restore(); await lease.release()
  expect(f.finished()).toBe(1)
})

test('missing or wrong child times out fenced; late correct completion cannot revive the lease', async () => {
  for (const wrongChild of [false, true]) {
    const f = fixture(), lease = await f.transaction.prepare()
    await lease.start([])
    const waiting = lease.waitSettled(10)
    if (wrongChild) {
      for (const method of ['turn/started', 'turn/completed']) f.transaction.observe({ method, params: { threadId: 'stale-child', turn: { id: 'other-turn' } } })
      f.transaction.observe({ method: 'turn/completed', params: { threadId: 'owner', turn: { id: 'parent-turn' } } })
    }
    expect(await waiting).toBe(false)
    expect(f.fenced()).toBeGreaterThan(0)
    f.settle()
    await expect(lease.restore()).rejects.toThrow('settlement')
    expect(f.calls.some(call => call.method === 'thread/settings/update')).toBe(false)
    expect(f.finished()).toBe(0)
  }
})

test('settlement wait enforces finite bounds and current host identity', async () => {
  const f = fixture(), lease = await f.transaction.prepare()
  await lease.start([]); f.settle()
  for (const timeout of [0, -1, 60_001, NaN, Infinity, 1.5]) await expect(lease.waitSettled(timeout)).rejects.toThrow('timeout')
  expect(f.fenced()).toBe(0)
  f.host.assertCurrent = () => { throw new Error('stale owner generation') }
  expect(await lease.waitSettled(10)).toBe(false)
  expect(f.fenced()).toBeGreaterThan(0); expect(f.finished()).toBe(0)
})

test('restored policy stays exclusive until acknowledgement; abandonment or late activity prevents release', async () => {
  for (const lateActivity of [false, true]) {
    const f = fixture(), lease = await f.transaction.prepare()
    await lease.start([]); f.settle(); await lease.restore()
    expect(f.finished()).toBe(0)
    if (lateActivity) f.transaction.observe({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'late-turn' } } })
    else lease.abandon()
    await expect(lease.release()).rejects.toThrow('release')
    expect(f.finished()).toBe(0); expect(f.fenced()).toBeGreaterThan(0)
  }
})

test('failed journal release remains fenced and cannot be retried into success', async () => {
  const f = fixture(), lease = await f.transaction.prepare()
  await lease.start([]); f.settle(); await lease.restore()
  f.host.finish = () => { throw new Error('broker closed or journal unavailable') }
  await expect(lease.release()).rejects.toThrow('release')
  f.host.finish = () => { throw new Error('must not reach host after uncertainty') }
  await expect(lease.release()).rejects.toThrow('release')
  expect(f.finished()).toBe(0); expect(f.fenced()).toBeGreaterThan(0)
})

test('restoration mismatch and lost start receipt fence instead of returning an idle owner', async () => {
  const mismatch = fixture({ badRestore: true }), lease = await mismatch.transaction.prepare()
  await lease.start([]); mismatch.settle()
  await expect(lease.restore()).rejects.toThrow('restoration')
  expect(mismatch.finished()).toBe(0); expect(mismatch.fenced()).toBeGreaterThan(0)
  const lost = fixture({ loseStart: true }), lostLease = await lost.transaction.prepare()
  await expect(lostLease.start([])).rejects.toThrow('dispatch')
  expect(lost.finished()).toBe(0); expect(lost.fenced()).toBeGreaterThan(0)
})

test('a cleanup acknowledgement without restored native configuration retains the fence', async () => {
  const f = fixture({ loseCleanup: true }), lease = await f.transaction.prepare()
  await lease.start([]); f.settle()
  await expect(lease.restore()).rejects.toThrow('restoration')
  expect(f.finished()).toBe(0); expect(f.fenced()).toBeGreaterThan(0)
})

test('only the canonical per-step staging directory can become a writable grant', () => {
  const f = fixture()
  for (const stageDir of [f.cwd, f.root, join(f.cwd, '.neutron', 'build-results'), `${f.stageDir}/../${'a'.repeat(64)}`]) {
    expect(() => createReviewPermissionTransaction(f.host, { stageDir, network: false })).toThrow()
  }
  const alias = join(f.cwd, '.neutron', 'build-results', 'b'.repeat(64))
  symlinkSync(f.stageDir, alias)
  expect(() => createReviewPermissionTransaction(f.host, { stageDir: alias, network: false })).toThrow()
})
