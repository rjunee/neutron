import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as transport from './project-control-broker-transport.ts'
import * as broker from './project-control-broker.ts'
import { bootstrapCodexOwner, readCodexOwnerBinding } from './project-control-bootstrap.ts'
import { helperIdentity } from './project-owner-helper-protocol.ts'
import { finishOwnerHelperLifetime } from './project-owner-helper-lifetime.ts'
import type { PtyHost } from '../../claude-code/persistent/pty-host.ts'

const restores: (() => void)[] = [], roots: string[] = []
afterEach(() => {
  for (const restore of restores.splice(0)) restore()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

for (const failedChild of ['native', 'terminal']) test(`actual bootstrap ${failedChild} failure drains helper after both children settle`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-bootstrap-stop-')); roots.push(root)
  const home = join(root, 'home'); mkdirSync(home, { mode: 0o700 })
  const identity = helperIdentity()
  const nativeExit = deferred(), terminalExit = deferred()
  let receive!: (message: unknown) => void, disconnect!: (error: Error) => void
  let listener!: { open(client: unknown): void; message(client: unknown, data: string): void }
  const terminal = { send() {}, close() {} }
  let nativeCloses = 0, terminalCloses = 0
  const methods: string[] = []
  const thread = { id: 'native-thread', sessionId: 'native-session', cwd: root, path: join(home, 'sessions', 'rollout.jsonl'),
    source: 'cli', originator: 'neutron-owner-bootstrap', modelProvider: 'fixture', ephemeral: false, turns: [], parentThreadId: null }
  const upstream = spyOn(transport, 'createProjectControlStdioTransport').mockReturnValue({
    processIdentity: identity, exited: nativeExit.promise.then(() => ({ ...identity, code: 1, signal: null })),
    listen(onMessage, onDisconnect) { receive = onMessage; disconnect = onDisconnect },
    send(message) {
      methods.push(String(message.method))
      if (message.method === 'initialized') return
      queueMicrotask(() => {
        if (message.method === 'thread/start') receive({ method: 'thread/started', params: { thread } })
        receive({ id: message.id, result: message.method === 'thread/start' ? { thread }
          : message.method === 'experimentalFeature/list' ? { data: [{ name: 'multi_agent_v2', enabled: true, stage: 'stable' }], nextCursor: null } : {} })
      })
    },
    close() { nativeCloses++ },
  }); restores.push(() => upstream.mockRestore())
  const nativeBroker = spyOn(broker, 'createProjectControlBroker').mockResolvedValue({
    state: () => ({ phase: 'idle', generation: 1, epoch: 0, activeTurnId: null, unresolved: null }),
    gateway: () => ({ subscribe: () => () => {}, close() {}, request: async () => ({}), reply() {} }),
    close() {},
  } as never); restores.push(() => nativeBroker.mockRestore())
  const serve = spyOn(Bun, 'serve').mockImplementation(((options: { websocket: typeof listener }) => {
    listener = options.websocket
    return { port: 12345, stop() {} }
  }) as never); restores.push(() => serve.mockRestore())
  const terminalHost = { async spawn() {
    queueMicrotask(() => {
      listener.open(terminal)
      listener.message(terminal, JSON.stringify({ id: 'initialize', method: 'initialize', params: {} }))
      listener.message(terminal, JSON.stringify({ id: 'start', method: 'thread/start', params: {
        cwd: root, ephemeral: false, threadSource: 'user', config: { features: { multi_agent_v2: true } },
      } }))
    })
    return { pid: process.pid, paneHandle: 'mock-native-pane', exited: terminalExit.promise.then(() => 1),
      hasExited: () => false, write() { throw new Error('Unexpected terminal input') }, kill() { terminalCloses++ }, detach() {} }
  } } as unknown as PtyHost
  const owner = await bootstrapCodexOwner({ binary: 'must-not-launch', cwd: root, codexHome: home,
    socketPath: join(home, 'owner.sock'), env: {}, terminalHost, timeoutMs: 1000 })
  expect(readCodexOwnerBinding(owner.binding).threadId).toBe('native-thread')
  expect(methods).not.toContain('turn/start')
  const events: string[] = []
  const finish = finishOwnerHelperLifetime({ nativeStopped: owner.nativeStopped!, retired: new Promise<void>(() => {}),
    async finishNativeStop() { events.push('listener-closed') }, async finishRetirement() { events.push('wrong-retirement') },
  }, code => events.push(`helper-exit-${code}`))
  if (failedChild === 'native') { nativeExit.resolve(); disconnect(new Error('native exited')) }
  else terminalExit.resolve()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  expect(events).toEqual([])
  expect(() => readCodexOwnerBinding(owner.binding)).toThrow('Stale')
  expect(nativeCloses).toBeGreaterThan(0)
  expect(terminalCloses).toBeGreaterThan(0)
  if (failedChild === 'native') terminalExit.resolve()
  else nativeExit.resolve()
  await Promise.race([finish, Bun.sleep(100).then(() => { throw new Error('Bootstrap did not release failed helper') })])
  expect(events).toEqual(['listener-closed', 'helper-exit-1'])
  expect(methods).not.toContain('turn/start')
})
