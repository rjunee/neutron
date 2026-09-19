import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectControlBroker } from './project-control-broker.ts'
import type { ProjectControlTransport } from './project-control-broker-transport.ts'
import { Database } from 'bun:sqlite'
import { createServer } from 'node:net'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'broker-recovery-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const binding = { socketPath: join(dir, 'control.sock'), cwd: dir, codexHome: dir, threadId: 'recovery-thread' }
  const open = async (acknowledge = true, override: Partial<typeof binding> = {}) => {
    const sent: Record<string, any>[] = []
    let receive: (value: unknown) => void = () => {}
    const upstream: ProjectControlTransport = {
      listen(listener) { receive = listener }, close() {},
      send(message) {
        sent.push(message)
        if (message.method === 'initialize' || acknowledge) queueMicrotask(() => receive({ id: message.id, result: {} }))
      },
    }
    const broker = await createProjectControlBroker({ ...binding, ...override, upstream, requestTimeoutMs: 20 })
    cleanup.push(() => broker.close())
    return { broker, sent }
  }
  return { binding, open }
}

test('restart invalidates even an unused prior epoch and permits a fresh writer', async () => {
  const f = fixture()
  const first = await f.open()
  const stale = first.broker.state().epoch
  first.broker.close()
  const next = await f.open()
  const writer = next.broker.gateway('writer')
  await expect(writer.request('thread/settings/update', { threadId: f.binding.threadId, model: 'next' }, stale)).rejects.toThrow('Stale')
  expect(next.sent.some(message => message.method === 'thread/settings/update')).toBe(false)
  await writer.request('thread/settings/update', { threadId: f.binding.threadId, model: 'next' }, next.broker.state().epoch)
  expect(next.sent.filter(message => message.method === 'thread/settings/update')).toHaveLength(1)
})

test('lost acknowledgement survives restart as an unresolved fence, with reads available and no replay', async () => {
  const f = fixture()
  const first = await f.open(false)
  await expect(first.broker.gateway('first').request('thread/settings/update', { threadId: f.binding.threadId, model: 'uncertain' }, first.broker.state().epoch)).rejects.toThrow('unknown')
  const next = await f.open()
  const writer = next.broker.gateway('next')
  await expect(writer.request('thread/settings/update', { threadId: f.binding.threadId, model: 'next' }, next.broker.state().epoch)).rejects.toThrow('unresolved')
  expect(next.sent.some(message => message.method === 'thread/settings/update')).toBe(false)
  await writer.request('thread/read', { threadId: f.binding.threadId })
  expect(next.sent.some(message => message.method === 'thread/read')).toBe(true)
  expect(next.broker.state().phase).toBe('recovery')
  expect(next.broker.state().unresolved).toBe('thread/settings/update')
})

test('acknowledged settled settings remain writable after restart', async () => {
  const f = fixture()
  const first = await f.open()
  await first.broker.gateway('first').request('thread/settings/update', { threadId: f.binding.threadId, model: 'first' }, first.broker.state().epoch)
  await new Promise(resolve => setTimeout(resolve, 0))
  first.broker.close()
  const next = await f.open()
  await next.broker.gateway('next').request('thread/settings/update', { threadId: f.binding.threadId, model: 'next' }, next.broker.state().epoch)
  expect(next.sent.filter(message => message.method === 'thread/settings/update')).toHaveLength(1)
})

async function childBroker(binding: ReturnType<typeof fixture>['binding'], turn: boolean) {
  const modulePath = new URL('./project-control-broker.ts', import.meta.url).pathname
  const script = `import { createProjectControlBroker } from ${JSON.stringify(modulePath)};
    let receive;
    const broker = await createProjectControlBroker({ ...JSON.parse(process.argv[1]), upstream: {
      listen(fn) { receive = fn }, close() {}, send(message) {
        if (message.id) queueMicrotask(() => receive({ id: message.id, result: message.method === 'turn/start' ? { turn: { id: 'interrupted-turn' } } : {} }));
      }
    }});
    if (process.argv[2] === 'turn') await broker.gateway('child').request('turn/start', { threadId: JSON.parse(process.argv[1]).threadId }, broker.state().epoch);
    console.log(JSON.stringify(broker.state()));
    setInterval(() => {}, 1000);`
  const child = Bun.spawn([process.execPath, '-e', script, JSON.stringify(binding), turn ? 'turn' : 'idle'], { stdout: 'pipe', stderr: 'pipe' })
  cleanup.push(() => child.kill())
  const reader = child.stdout.getReader()
  const first = await reader.read()
  if (first.done) throw new Error('Child broker did not start')
  const state = JSON.parse(new TextDecoder().decode(first.value)) as { epoch: number; generation: number }
  reader.releaseLock()
  return { child, state }
}

test('SIGKILL idle broker recovers its stale socket; live ownership cannot be stolen', async () => {
  const f = fixture()
  const { child, state } = await childBroker(f.binding, false)
  await expect(f.open()).rejects.toThrow('live')
  child.kill('SIGKILL'); await child.exited
  const next = await f.open()
  expect(next.broker.state().generation).toBe(state.generation + 1)
  const writer = next.broker.gateway('recovered')
  await expect(writer.request('thread/settings/update', { threadId: f.binding.threadId, model: 'next' }, state.epoch)).rejects.toThrow('Stale')
  await writer.request('thread/settings/update', { threadId: f.binding.threadId, model: 'next' }, next.broker.state().epoch)
  expect(next.sent.filter(message => message.method === 'thread/settings/update')).toHaveLength(1)
})

test('SIGKILL active broker recovers into inspection-only state without replaying its turn', async () => {
  const f = fixture()
  const { child } = await childBroker(f.binding, true)
  child.kill('SIGKILL'); await child.exited
  const next = await f.open()
  expect(next.broker.state().phase).toBe('recovery')
  expect(next.broker.state().unresolved).toBe('turn/start')
  const writer = next.broker.gateway('recovered')
  await expect(writer.request('turn/start', { threadId: f.binding.threadId }, next.broker.state().epoch)).rejects.toThrow('unresolved')
  await writer.request('thread/read', { threadId: f.binding.threadId })
  expect(next.sent.filter(message => message.method === 'turn/start')).toHaveLength(0)
})

test('a replaced durable generation fences an existing broker before it can send', async () => {
  const f = fixture()
  const first = await f.open()
  const db = new Database(`${f.binding.socketPath}.sqlite`)
  db.exec('UPDATE broker SET generation=generation+1')
  db.close()
  await expect(first.broker.gateway('stale').request('thread/settings/update', { threadId: f.binding.threadId, model: 'stale' }, first.broker.state().epoch)).rejects.toThrow('Stale')
  expect(first.sent.some(message => message.method === 'thread/settings/update')).toBe(false)
})

test('a durable journal cannot be rebound to another project thread', async () => {
  const f = fixture()
  const first = await f.open()
  first.broker.close()
  await expect(f.open(true, { threadId: 'foreign-thread' })).rejects.toThrow('binding')
  const next = await f.open()
  expect(next.broker.state().phase).toBe('idle')
  expect(statSync(`${f.binding.socketPath}.sqlite`).mode & 0o777).toBe(0o600)
})

test('recovery preserves a foreign replacement socket even after the recorded owner dies', async () => {
  const f = fixture()
  const { child } = await childBroker(f.binding, false)
  child.kill('SIGKILL'); await child.exited
  renameSync(f.binding.socketPath, `${f.binding.socketPath}.stale`)
  const foreign = createServer()
  await new Promise<void>(resolve => foreign.listen(f.binding.socketPath, resolve))
  cleanup.push(() => foreign.close())
  const inode = statSync(f.binding.socketPath).ino
  await expect(f.open()).rejects.toThrow('socket identity')
  expect(statSync(f.binding.socketPath).ino).toBe(inode)
})
