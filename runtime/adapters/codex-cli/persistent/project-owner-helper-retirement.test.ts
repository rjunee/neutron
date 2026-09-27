import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as transport from './project-control-broker-transport.ts'
import * as protocol from './project-owner-helper-protocol.ts'
import { startCodexOwnerHelper } from './project-owner-helper.ts'
import { abortAccountHandoff, prepareAccountHandoff, readGeneralOwnerAuthority } from './project-owner-account-handoff.ts'
import type { PtyHost } from '../../claude-code/persistent/pty-host.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 })

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'helper-retirement-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'source'), targetHome = join(root, 'target')
  for (const dir of [home, targetHome, join(home, 'sessions')]) mkdirSync(dir, { mode: 0o700 })
  const marker = join(home, '.neutron-owner-retiring.json')
  const identity = protocol.helperIdentity()
  let nativeDone!: () => void, terminalDone!: () => void
  const nativeExit = new Promise<void>(resolve => { nativeDone = resolve })
  const terminalExit = new Promise<void>(resolve => { terminalDone = resolve })
  let receive!: (message: unknown) => void
  let listener!: { open(client: unknown): void; message(client: unknown, data: string): void }
  const terminal = { send() {}, close() {} }
  let closes = 0, census = 0, lateBusy = false, terminalStopped = false
  const markersAtCensus: boolean[] = [], markersAtClose: boolean[] = []
  const thread = { id: 'native-thread', sessionId: 'native-session', cwd: root, path: join(home, 'sessions', 'rollout.jsonl'),
    source: 'cli', originator: 'neutron-owner-bootstrap', modelProvider: 'fixture', ephemeral: false, turns: [],
    parentThreadId: null, status: { type: 'idle' } }
  writeFileSync(thread.path, 'retained conversation\n', { mode: 0o600 })
  const upstream = spyOn(transport, 'createProjectControlStdioTransport').mockReturnValue({
    processIdentity: identity, exited: nativeExit.then(() => ({ ...identity, code: 0, signal: null })),
    listen(onMessage) { receive = onMessage },
    send(message) {
      if (message.id === undefined) return
      queueMicrotask(() => {
        const method = message.method
        if (method === 'thread/start') receive({ method: 'thread/started', params: { thread } })
        if (method === 'thread/loaded/list') { census++; markersAtCensus.push(existsSync(marker)) }
        const result = method === 'thread/start' || method === 'thread/read' ? { thread }
          : method === 'experimentalFeature/list' ? { data: [{ name: 'multi_agent_v2', enabled: true, stage: 'stable' }], nextCursor: null }
          : method === 'thread/loaded/list' ? { data: [thread.id], nextCursor: null }
          : method === 'thread/goal/get' ? { goal: null }
          : method === 'thread/backgroundTerminals/list' ? { data: lateBusy && census % 2 === 0 ? [{ processId: 'late-shell' }] : [], nextCursor: null }
          : method === 'thread/turns/list' || method === 'thread/queue/list' ? { data: [], nextCursor: null } : {}
        receive({ id: message.id, result })
      })
    },
    close() { closes++; markersAtClose.push(existsSync(marker)); nativeDone() },
  }); cleanup.push(() => upstream.mockRestore())
  // Only the external host-cgroup boundary is substituted; helper, bootstrap,
  // broker, both native censuses and durable handoff ledger are actual code.
  const hostProof = spyOn(protocol, 'requireIndependentOwnerHost').mockImplementation(() => {})
  cleanup.push(() => hostProof.mockRestore())
  const originalServe = Bun.serve
  const serve = spyOn(Bun, 'serve').mockImplementation(((options: any) => {
    if (options.unix) return originalServe(options)
    listener = options.websocket
    return { port: 12345, stop() {} }
  }) as never); cleanup.push(() => serve.mockRestore())
  const terminalHost = { async spawn() {
    queueMicrotask(() => {
      listener.open(terminal)
      listener.message(terminal, JSON.stringify({ id: 'initialize', method: 'initialize', params: {} }))
      listener.message(terminal, JSON.stringify({ id: 'start', method: 'thread/start', params: {
        cwd: root, ephemeral: false, threadSource: 'user', config: { features: { multi_agent_v2: true } },
      } }))
    })
    return { pid: process.pid, paneHandle: 'fixture-pane', exited: terminalExit.then(() => 0),
      hasExited: () => terminalStopped, write() { throw new Error('Unexpected terminal input') },
      kill() { terminalStopped = true; terminalDone() }, detach() {} }
  } } as unknown as PtyHost
  const helper = await startCodexOwnerHelper({ binary: 'must-not-launch', cwd: root, codexHome: home,
    socketPath: join(home, 'broker.sock'), env: {}, terminalHost, timeoutMs: 1000,
    projectId: null, gatewayIdentity: identity })
  cleanup.push(() => helper.destroy())
  const descriptor = JSON.parse(readFileSync(helper.descriptorPath, 'utf8')) as protocol.OwnerHelperDescriptor
  const call = async (body: unknown): Promise<any> => {
    const response = await fetch('http://localhost/owner', { unix: descriptor.socketPath, method: 'POST',
      headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    return response.json()
  }
  const attached = await call({ operation: 'attach', expected: helper.facts, challenge: 'a'.repeat(64) })
  const source = { projectId: null, cwd: root, codexHome: home, credential: 'a'.repeat(64) } as const
  const target = { ...source, codexHome: targetHome, credential: 'b'.repeat(64) }
  const authorityPath = join(root, 'general.json')
  write(authorityPath, source)
  write(join(home, '.neutron-owner-launch.json'), { scope: source })
  write(join(home, '.neutron-owner-authority.json'), descriptor)
  const prepare = () => prepareAccountHandoff(authorityPath, source, target, home, helper.facts)
  return { home, marker, helper, authorityPath, markersAtCensus, markersAtClose, prepare,
    closes: () => closes, lateBusy: (value: boolean) => { lateBusy = value },
    retire: () => call({ operation: 'retire', grant: attached.grant, epoch: 0 }) }
}

test('actual helper late-busy census leaves no marker and permits explicit General abort then retirement retry', async () => {
  const f = await fixture(), prepared = f.prepare()
  f.lateBusy(true)
  expect((await f.retire()).status).toBe('busy')
  expect(f.markersAtCensus).toEqual([false, false])
  expect(f.closes()).toBe(0)
  expect(existsSync(f.marker)).toBe(false)
  abortAccountHandoff(prepared, f.helper.facts)
  expect(readGeneralOwnerAuthority(f.authorityPath)?.preparing).toBeUndefined()
  expect(existsSync(`${f.authorityPath}.handoff-0.json.abort`)).toBe(true)
  f.lateBusy(false); f.prepare()
  expect((await f.retire()).status).toBe('retired')
  expect(f.markersAtCensus).toEqual([false, false, false, false])
  expect(f.markersAtClose.length).toBeGreaterThan(0)
  expect(f.markersAtClose.every(Boolean)).toBe(true)
  expect(existsSync(join(f.home, '.neutron-owner-retired.json'))).toBe(true)
})

test('actual helper marker callback failure stays unknown without closing native or aborting General preparation', async () => {
  const f = await fixture(), prepared = f.prepare()
  write(f.marker, { foreign: 'must not overwrite' })
  const bytes = readFileSync(f.marker, 'utf8')
  expect((await f.retire()).status).toBe('unknown')
  expect(f.closes()).toBe(0)
  expect(readFileSync(f.marker, 'utf8')).toBe(bytes)
  expect(() => abortAccountHandoff(prepared, f.helper.facts)).toThrow('uncertain')
  expect(readGeneralOwnerAuthority(f.authorityPath)?.preparing?.locator).toEqual(prepared)
  expect(existsSync(join(f.home, '.neutron-owner-retired.json'))).toBe(false)
})
