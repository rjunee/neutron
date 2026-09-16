import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeActingTurn, type ClaudeActingSession } from './claude-acting-turn.ts'
import { createProjectRunners, type ProjectActingTurn } from './project-runners.ts'
import { PROVIDERS } from '../provider.ts'
import { HerdrHost } from '../adapters/claude-code/persistent/herdr-host.ts'
import { FakeHerdrServer } from '../adapters/claude-code/persistent/__tests__/herdr-fake-server.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'claude-acting-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const commands: string[] = []
  let released = 0
  let acquired = 0
  const input: Parameters<ProjectActingTurn>[0] = {
    conversation: { project_id: 'project', topic_id: 'topic', provider: 'anthropic', spec: { tools: [], model_preference: ['planner'] } },
    request: { run_id: 'run', step_id: 'step', role: 'build', model_id: 'worker', effort: 'high', cwd: dir,
      writable: true, network: true, tools: 'edit-and-run', brief: { path: join(dir, 'brief'), integrity: 'digest' },
      result: { path: join(dir, 'result'), schema: 'v1' }, thread: { id: 'session' }, budget: { wall_ms: 120 }, needs_approval_decision: false },
    spec: { prompt: 'Invoke Agent\nwith the request', tools: [], model_preference: ['worker'] },
    timeout_ms: 120, signal: new AbortController().signal,
  }
  const binding: ClaudeActingSession = {
    project_id: 'project', topic_id: 'topic', grants: { roots: [], tools: 'edit-and-run', writable: true, network: true },
    session: { sessionId: 'session', cwd: dir, acquireTurn: async () => { acquired++; return () => { released++ } },
      child: { pid: 123, write() {}, kill() {}, hasExited: () => false, exited: new Promise(() => {}),
        submitLine: async text => { commands.push(text); await writeFile(input.request.result.path, '{}') } } },
  }
  return { dir, input, binding, commands, released: () => released, acquired: () => acquired, run: () => createClaudeActingTurn(binding)(input) }
}

test('Claude positive control forwards spec and effort into one acknowledged line', async () => {
  const f = await fixture()
  expect(await f.run()).toEqual({ kind: 'turn-ended' })
  expect(f.commands).toHaveLength(1)
  expect(f.commands[0]).not.toMatch(/[\r\n]/)
  expect(JSON.parse(f.commands[0]!.slice(f.commands[0]!.indexOf('{')))).toEqual({ ...f.input.spec, effort: 'high' })
  expect(f.released()).toBe(1)
})

for (const provider of PROVIDERS.filter(p => p !== 'anthropic')) {
  test(`refuses provider ${provider} by name`, async () => {
    const f = await fixture()
    f.input.conversation = { ...f.input.conversation, provider }
    expect(await f.run()).toEqual({ kind: 'refused', reason: 'capability-unsupported', detail: expect.stringContaining(provider) })
    expect(f.commands).toHaveLength(0)
  })
}

for (const field of ['project_id', 'topic_id', 'thread', 'cwd', 'tools', 'writable', 'network', 'submitLine'] as const) {
  test(`refuses unavailable ${field} before actuation`, async () => {
    const f = await fixture()
    if (field === 'project_id' || field === 'topic_id') f.binding[field] = 'wrong'
    else if (field === 'thread') f.binding.session = { ...f.binding.session, sessionId: 'wrong' }
    else if (field === 'cwd') f.binding.session = { ...f.binding.session, cwd: join(f.dir, 'wrong') }
    else if (field === 'submitLine') delete f.binding.session.child.submitLine
    else if (field === 'tools') f.binding.grants.tools = 'read-only'
    else f.binding.grants[field] = false
    expect(await f.run()).toEqual({ kind: 'refused', reason: 'capability-unsupported', detail: expect.stringMatching(/unavailable|match|submitLine/) })
    expect(f.commands).toHaveLength(0)
  })
}

test('lesser grants and null thread are accepted', async () => {
  const f = await fixture()
  f.input.request = { ...f.input.request, tools: 'none', writable: false, network: false, thread: null }
  expect(await f.run()).toEqual({ kind: 'turn-ended' })
})

test('acknowledgement alone waits for the trailer until the host budget', async () => {
  const f = await fixture()
  f.binding.session.child.submitLine = async text => { f.commands.push(text) }
  f.input.timeout_ms = 45
  const start = Date.now()
  expect(await f.run()).toEqual({ kind: 'unknown', detail: expect.stringContaining('trailer') })
  // WALL-CLOCK-BOUND-OK: the contract is that acknowledgement does NOT end the turn —
  // the wait must actually be spent. The deterministic assertions above cover the
  // outcome (`unknown` naming the trailer) and the dispatch (one submitLine), but
  // neither can distinguish 'waited the budget' from 'returned immediately with the
  // same answer', which is the exact shortcut this test exists to catch. It is a
  // LOWER bound on elapsed time against a 45ms budget, margin 5ms: a loaded runner
  // makes the run slower, never faster, so load cannot flake it — only an
  // implementation that stopped waiting can.
  expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  expect(f.commands).toHaveLength(1)
})

test('trailer appearing after acknowledgement establishes observation', async () => {
  const f = await fixture()
  let write: Promise<void> | undefined
  f.binding.session.child.submitLine = async () => { write = Bun.sleep(35).then(() => writeFile(f.input.request.result.path, '{}')) }
  expect(await f.run()).toEqual({ kind: 'turn-ended' })
  await write
})

test('unreadable trailer and dispatch uncertainty throw without retry', async () => {
  const f = await fixture()
  f.input.request = { ...f.input.request, result: { ...f.input.request.result, path: f.dir } }
  f.binding.session.child.submitLine = async text => { f.commands.push(text) }
  await expect(f.run()).rejects.toThrow('not a file')
  f.binding.session.child.submitLine = async text => { f.commands.push(text); throw new Error('lost acknowledgement') }
  await expect(f.run()).rejects.toThrow('lost acknowledgement')
  expect(f.commands).toHaveLength(2)
  expect(f.released()).toBe(2)
})

test('cancelled and expired requests do not dispatch', async () => {
  const f = await fixture()
  f.input.signal = AbortSignal.abort()
  expect((await f.run()).kind).toBe('unknown')
  f.input.signal = new AbortController().signal
  f.input.request = { ...f.input.request, budget: { wall_ms: 0 } }
  expect((await f.run()).kind).toBe('unknown')
  expect(f.commands).toHaveLength(0)
  expect(f.acquired()).toBe(0)
})

test('late mutex acquisition releases without dispatch after budget', async () => {
  const f = await fixture()
  let unlock!: (release: () => void) => void
  let released = false
  f.binding.session.acquireTurn = () => new Promise(resolve => { unlock = resolve })
  f.input.timeout_ms = 20
  expect((await f.run()).kind).toBe('unknown')
  unlock(() => { released = true })
  await Bun.sleep(10)
  expect(f.commands).toHaveLength(0)
  expect(released).toBe(true)
})

test('cancellation fences a queued turn before the wall deadline', async () => {
  const f = await fixture()
  const controller = new AbortController()
  f.input.signal = controller.signal
  f.input.timeout_ms = 1000
  f.input.request = { ...f.input.request, budget: { wall_ms: 1000 } }
  let unlock!: (release: () => void) => void
  f.binding.session.acquireTurn = () => new Promise(resolve => { unlock = resolve })
  const pending = f.run()
  controller.abort()
  expect((await pending).kind).toBe('unknown')
  unlock(() => {})
  await Bun.sleep(10)
  expect(f.commands).toHaveLength(0)
})

test('project runner preserves refusal and reservation after uncertain dispatch', async () => {
  const f = await fixture()
  const build = () => createProjectRunners({ conversation: f.input.conversation, run_id: 'run', state_dir: f.dir,
    actingTurn: createClaudeActingTurn(f.binding), headless: {}, trailer: { schemas: new Map(), metadata: () => undefined } })
  f.binding.grants.network = false
  expect(await (await build()).inRepl!.run(f.input.request, 'in-repl', f.input.signal)).toEqual({ kind: 'refused', reason: 'capability-unsupported' })
  f.binding.grants.network = true
  expect((await (await build()).inRepl!.run(f.input.request, 'in-repl', f.input.signal)).kind).toBe('unknown')
  expect(f.commands).toHaveLength(0)
  f.input.request = { ...f.input.request, step_id: 'uncertain' }
  f.binding.session.child.submitLine = async text => { f.commands.push(text); throw new Error('lost acknowledgement') }
  expect((await (await build()).inRepl!.run(f.input.request, 'in-repl', f.input.signal)).kind).toBe('unknown')
  expect((await (await build()).inRepl!.run(f.input.request, 'in-repl', f.input.signal)).kind).toBe('unknown')
  expect(f.commands).toHaveLength(1)
})

test('real HerdrHost child submits text then Enter in the existing pane', async () => {
  const f = await fixture()
  const server = new FakeHerdrServer()
  const calls: string[] = []
  const host = new HerdrHost({ connect: async () => ({ call: async (method, params) => {
    const result = await server.call(method, params)
    if (method === 'pane.send_text' || method === 'pane.send_keys') {
      calls.push(method)
      expect(params?.pane_id).toBe(server.paneId)
      if (method === 'pane.send_keys') await writeFile(f.input.request.result.path, '{}')
    }
    return result
  } }), pollIntervalMs: 10 })
  const child = await host.attach(server.paneId, { cwd: f.dir, env: {} })
  cleanups.push(async () => { child.detach?.() })
  f.binding.session = { ...f.binding.session, child }
  expect(await f.run()).toEqual({ kind: 'turn-ended' })
  expect(calls).toEqual(['pane.send_text', 'pane.send_keys'])
})

test('host budget abandonment prevents a late herdr text acknowledgement from submitting Enter', async () => {
  const f = await fixture()
  const server = new FakeHerdrServer()
  let releaseText!: () => void
  const textHeld = new Promise<void>(resolve => { releaseText = resolve })
  const calls: string[] = []
  const host = new HerdrHost({ connect: async () => ({ call: async (method, params) => {
    if (method === 'pane.send_text') await textHeld
    const result = await server.call(method, params)
    if (method === 'pane.send_text' || method === 'pane.send_keys') calls.push(method)
    return result
  } }), pollIntervalMs: 10 })
  const child = await host.attach(server.paneId, { cwd: f.dir, env: {} })
  cleanups.push(async () => { child.detach?.() })
  f.binding.session = { ...f.binding.session, child }
  f.input.timeout_ms = 20

  expect(await f.run()).toEqual({ kind: 'unknown', detail: expect.stringContaining('trailer') })
  releaseText()
  await Bun.sleep(20)
  expect(calls).toEqual(['pane.send_text'])
})

for (const cwd of ['/a/b', '/a/b/worktree', '/a/b/../b/worktree']) {
  test(`granted root accepts ${cwd}`, async () => {
    const f = await fixture()
    f.binding.grants.roots = ['/a/b']
    f.input.request = { ...f.input.request, cwd }
    expect(await f.run()).toEqual({ kind: 'turn-ended' })
    expect(f.commands).toHaveLength(1)
  })
}
for (const cwd of ['/a/bc', '/a/b/../outside', '/a']) {
  test(`granted root refuses segment escape ${cwd}`, async () => {
    const f = await fixture()
    f.binding.grants.roots = ['/a/b']
    f.input.request = { ...f.input.request, cwd }
    expect(await f.run()).toMatchObject({ kind: 'refused', detail: expect.stringContaining('granted roots') })
    expect(f.commands).toHaveLength(0)
  })
}
test('session cwd includes descendants and binding snapshots root grants', async () => {
  const f = await fixture()
  f.input.request = { ...f.input.request, cwd: join(f.dir, 'child') }
  expect(await f.run()).toEqual({ kind: 'turn-ended' })
  const roots: string[] = []
  f.binding.grants.roots = roots
  const run = createClaudeActingTurn(f.binding)
  roots.push('/a/b')
  f.input.request = { ...f.input.request, cwd: '/a/b' }
  expect((await run(f.input)).kind).toBe('refused')
})
for (const effort of ['xhigh', 'max'] as const) {
  test(`acting turn forwards effort ${effort}`, async () => {
    const f = await fixture()
    f.input.request = { ...f.input.request, effort }
    expect(await f.run()).toEqual({ kind: 'turn-ended' })
    expect(JSON.parse(f.commands[0]!.slice(f.commands[0]!.indexOf('{'))).effort).toBe(effort)
  })
}
