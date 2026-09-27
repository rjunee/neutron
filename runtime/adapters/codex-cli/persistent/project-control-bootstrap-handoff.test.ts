import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as transport from './project-control-broker-transport.ts'
import * as broker from './project-control-broker.ts'
import * as census from './project-owner-crash-recovery.ts'
import { bootstrapCodexOwner, readCodexOwnerBinding, type CodexOwnerBindingFacts } from './project-control-bootstrap.ts'
import { completeAccountHandoff, prepareAccountHandoff, stageAccountHandoff, readAccountHandoff } from './project-owner-account-handoff.ts'
import { helperIdentity } from './project-owner-helper-protocol.ts'
import type { PtyHost } from '../../claude-code/persistent/pty-host.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }

for (const fault of ['none', 'foreign-account', 'missing-permission', 'foreign-thread', 'foreign-readback', 'caller-path']) {
  test(`actual bootstrap consumes reserved transcript and native account proof: ${fault}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'bootstrap-handoff-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const sourceHome = join(root, 'first'), targetHome = join(root, 'second')
    for (const home of [sourceHome, targetHome]) mkdirSync(home, { mode: 0o700 })
    mkdirSync(join(sourceHome, 'sessions'), { mode: 0o700 })
    const path = join(sourceHome, 'sessions', 'rollout.jsonl'); writeFileSync(path, 'previous history\n', { mode: 0o600 })
    const identity = helperIdentity(), exited = { pid: 1, boot: 'previous-fixture-boot', start: '1' }
    const credential = createHash('sha256').update(JSON.stringify(['chatgpt-account', 'target'])).digest('hex')
    const source = { projectId: null as null, cwd: root, codexHome: sourceHome, credential: 'a'.repeat(64) }
    const target = { ...source, codexHome: targetHome, credential }
    const facts: CodexOwnerBindingFacts = { threadId: 'original-thread', sessionId: 'original-session', cwd: root, codexHome: sourceHome,
      rolloutPath: path, bindingRevision: 'b'.repeat(64), paneHandle: 'old-pane', generation: 1, brokerGeneration: 1,
      credentialFingerprint: 'old', modelProvider: 'fixture', controlSocketPath: join(sourceHome, 'owner.sock'),
      nativeMetadata: { sessionId: 'original-session', originator: 'neutron-owner-bootstrap', source: 'cli' },
      capabilities: { multiAgentV2: true, evidence: 'native-thread-feature-report' } }
    const authority = join(root, 'general.json'); write(authority, source)
    write(join(sourceHome, '.neutron-owner-launch.json'), { scope: source })
    write(join(sourceHome, '.neutron-owner-authority.json'), { facts, helper: exited })
    write(join(sourceHome, '.neutron-owner-retired.json'), { version: 1, facts, helper: exited, terminal: exited,
      native: { identity: exited, code: 0, signal: null } })
    const locator = prepareAccountHandoff(authority, source, target, sourceHome, facts)
    completeAccountHandoff(locator)
    const resume = stageAccountHandoff(locator)
    const handoff = readAccountHandoff(locator)
    const noOtherOwner = spyOn(census, 'assertNoOtherCodexOwner').mockImplementation(() => {})
    cleanup.push(() => noOtherOwner.mockRestore())
    const nativeExit = deferred(), terminalExit = deferred()
    let receive!: (message: unknown) => void
    let listener!: { open(client: unknown): void; message(client: unknown, value: string): void }
    const terminal = { send() {}, close() {} }, methods: string[] = [], resumes: Record<string, unknown>[] = []
    const thread = { id: 'original-thread', sessionId: 'original-session', cwd: root, path: handoff.rolloutPath,
      ephemeral: false, originator: 'neutron-owner-bootstrap', source: 'cli', modelProvider: 'fixture', turns: [] }
    const native = spyOn(transport, 'createProjectControlStdioTransport').mockReturnValue({ processIdentity: identity,
      exited: nativeExit.promise.then(() => ({ ...identity, code: 0, signal: null })),
      listen(onMessage) { receive = onMessage }, close() { nativeExit.resolve() }, send(message) {
        methods.push(String(message.method))
        if (message.method === 'initialized') return
        if (message.method === 'thread/resume') resumes.push(message.params as Record<string, unknown>)
        queueMicrotask(() => receive({ id: message.id, result:
          message.method === 'account/read' ? { account: { type: 'chatgpt' } }
          : message.method === 'account/rateLimits/read' ? { accountId: fault === 'foreign-account' ? 'other' : 'target', ordinaryUsageAllowed: fault === 'missing-permission' ? null : true }
          : message.method === 'thread/resume' ? { thread: { ...thread, id: fault === 'foreign-thread' ? 'foreign' : thread.id } }
          : message.method === 'thread/read' ? { thread: { ...thread, sessionId: fault === 'foreign-readback' ? 'foreign' : thread.sessionId } }
          : message.method === 'experimentalFeature/list' ? { data: [{ name: 'multi_agent_v2', enabled: true, stage: 'stable' }], nextCursor: null } : {} }))
      },
    }); cleanup.push(() => native.mockRestore())
    const nativeBroker = spyOn(broker, 'createProjectControlBroker').mockResolvedValue({
      state: () => ({ phase: 'idle', generation: 1, epoch: 0, activeTurnId: null, unresolved: null }),
      gateway: () => ({ subscribe: () => () => {}, close() {}, request: async () => ({}), reply() {} }), close() {},
    } as never); cleanup.push(() => nativeBroker.mockRestore())
    const server = spyOn(Bun, 'serve').mockImplementation(((options: { websocket: typeof listener }) => {
      listener = options.websocket; return { port: 12345, stop() {} }
    }) as never); cleanup.push(() => server.mockRestore())
    const terminalHost = { async spawn(argv: string[]) {
      expect(argv.slice(1, 3)).toEqual(['resume', 'original-thread'])
      queueMicrotask(() => {
        listener.open(terminal)
        listener.message(terminal, JSON.stringify({ id: 1, method: 'initialize', params: {} }))
        listener.message(terminal, JSON.stringify({ id: 2, method: 'thread/resume', params: { threadId: 'original-thread', cwd: root,
          ...(fault === 'caller-path' ? { path: handoff.rolloutPath } : {}), config: { features: { multi_agent_v2: true } } } }))
      })
      return { pid: process.pid, paneHandle: 'fixture-terminal', hasExited: () => false, exited: terminalExit.promise.then(() => 0),
        write() { throw new Error('Unexpected terminal input') }, kill() { terminalExit.resolve() }, detach() {} }
    } } as unknown as PtyHost
    const operation = bootstrapCodexOwner({ binary: 'must-not-launch', cwd: root, codexHome: targetHome,
      socketPath: join(targetHome, 'owner.sock'), env: {}, resume, ownerStateDirectory: handoff.stateDirectory, terminalHost, timeoutMs: 1000 })
    if (fault === 'none') {
      const owner = await operation, bound = readCodexOwnerBinding(owner.binding)
      expect(bound.threadId).toBe(facts.threadId); expect(bound.sessionId).toBe(facts.sessionId)
      expect(bound.rolloutPath).toBe(handoff.rolloutPath); expect(bound.credentialIdentity).toBe(credential)
      expect(resumes).toHaveLength(1); expect(resumes[0]!.path).toBe(handoff.rolloutPath)
      expect(methods.indexOf('account/rateLimits/read')).toBeLessThan(methods.indexOf('thread/resume'))
      expect(methods).toContain('thread/read'); await owner.close()
    } else await expect(operation).rejects.toThrow()
    if (fault === 'foreign-account' || fault === 'missing-permission' || fault === 'caller-path') expect(resumes).toHaveLength(0)
    expect(methods).not.toContain('thread/start'); expect(methods).not.toContain('turn/start')
    nativeExit.resolve(); terminalExit.resolve()
  })
}
