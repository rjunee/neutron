import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeActingTurn, DISPATCH_TIMEOUT_MS, type ClaudeActingSession } from './claude-acting-turn.ts'
import { createProjectRunners, type ProjectActingTurn } from './project-runners.ts'
import { sessionJsonlPath } from '../adapters/claude-code/persistent/jsonl-resumability.ts'
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

// THE OTHER THREE GUARDS, ARMED. A review lane measured that the branch added four
// cancellation checks and proved only one: the post-acknowledgement guard (the case above).
// Deleting the enqueued-work guard or the bun host's own check outright left every test green — guards
// nothing could ever see fire. A fourth, ahead of the enqueue, proved redundant with
// the enqueued-work guard (removing either alone stayed green; removing both went red) and was removed. Each case below holds a DIFFERENT
// earlier actuation so the caller's abandonment lands at a different guard, and
// each was shown red with its guard removed before being kept.

test('abandonment while a PRIOR actuation holds the herdr queue stops before send_text', async () => {
  const f = await fixture()
  const server = new FakeHerdrServer()
  let releasePrior!: () => void
  const priorHeld = new Promise<void>(resolve => { releasePrior = resolve })
  const calls: string[] = []
  const host = new HerdrHost({ connect: async () => ({ call: async (method, params) => {
    // The FIRST send_keys is a prior actuation that never acknowledges; the dispatch
    // enqueues behind it, so its work runs only after the caller has given up.
    if (method === 'pane.send_keys' && calls.length === 0) { calls.push('prior'); await priorHeld }
    const result = await server.call(method, params)
    if (method === 'pane.send_text' || method === 'pane.send_keys') calls.push(method)
    return result
  } }), pollIntervalMs: 10 })
  const child = await host.attach(server.paneId, { cwd: f.dir, env: {} })
  cleanups.push(async () => { child.detach?.() })
  child.writeKey?.('enter')
  f.binding.session = { ...f.binding.session, child }
  f.input.timeout_ms = 20

  expect(await f.run()).toEqual({ kind: 'unknown', detail: expect.stringContaining('trailer') })
  releasePrior()
  await Bun.sleep(30)
  // The dispatch's own text was never sent: the queued work saw the abandonment first.
  expect(calls.filter(c => c === 'pane.send_text')).toEqual([])
})

test('an already-abandoned herdr submitLine is refused before any RPC is sent', async () => {
  const f = await fixture()
  const server = new FakeHerdrServer()
  const calls: string[] = []
  const host = new HerdrHost({ connect: async () => ({ call: async (method, params) => {
    const result = await server.call(method, params)
    if (method === 'pane.send_text' || method === 'pane.send_keys') calls.push(method)
    return result
  } }), pollIntervalMs: 10 })
  const child = await host.attach(server.paneId, { cwd: f.dir, env: {} })
  cleanups.push(async () => { child.detach?.() })
  // An already-aborted signal: the caller gave up before ever reaching the host.
  const aborted = new AbortController(); aborted.abort()
  await expect(child.submitLine!('never', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(calls).toEqual([])
})

test('the bun host refuses an already-abandoned submitLine before writing', async () => {
  const { bunTerminalHost } = await import('@neutronai/runtime/adapters/claude-code/persistent/bun-terminal-host.ts')
  const child = await bunTerminalHost.spawn(['/bin/cat'], { cwd: '/tmp', env: {}, onExit: () => {} })
  cleanups.push(async () => { child.kill() })
  const aborted = new AbortController(); aborted.abort()
  await expect(child.submitLine!('never', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
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

// Logical clock assertions read the observation boundary, never elapsed wall time.
for (const scenario of ['late trailer', 'no subagent', 'no trailer', 'throw', 'trailer without metadata'] as const) {
  test(`dispatch evidence: ${scenario}`, async () => {
    const f = await fixture()
    f.binding.projects_dir = join(f.dir, 'projects')
    const transcript = sessionJsonlPath('session', f.dir, f.binding.projects_dir)
    const directory = join(transcript.slice(0, -'.jsonl'.length), 'subagents')
    await mkdir(directory, { recursive: true })
    // Decoys must not buy a full wall: wrong step, wrong filename, wrong session,
    // malformed metadata. The valid row appears only after submission.
    await writeFile(join(directory, 'agent-other.meta.json'), JSON.stringify({ description: 'build: other' }))
    await writeFile(join(directory, 'other.json'), JSON.stringify({ description: 'build: step' }))
    await writeFile(join(directory, 'agent-partial.meta.json'), '{')
    const otherSession = join(directory, '../../other-session/subagents')
    await mkdir(otherSession, { recursive: true })
    await writeFile(join(otherSession, 'agent-valid.meta.json'), JSON.stringify({ description: 'build: step' }))
    let now = 0
    const wall = 90_000
    f.input.request = { ...f.input.request, budget: { wall_ms: wall } }
    f.binding.session.child.submitLine = async text => {
      f.commands.push(text)
      if (scenario === 'throw') throw new Error('lost observation')
    }
    const actingTurn = createClaudeActingTurn(f.binding, {
      now: () => now,
      pause: async ms => {
        now += ms
        if (now === 25 && (scenario === 'late trailer' || scenario === 'no trailer')) {
          await writeFile(join(directory, 'agent-created.meta.json'), JSON.stringify({ description: 'build: step' }))
        }
        if (now === 50) await rm(join(directory, 'agent-created.meta.json'), { force: true })
        if ((scenario === 'late trailer' && now === 50_000) || (scenario === 'trailer without metadata' && now === 25)) {
          await writeFile(f.input.request.result.path, JSON.stringify({ run_id: 'run', step_id: 'step', schema: 'v1', kind: 'blocked', on: 'review' }))
        }
      },
    })
    let offered = 0
    let observation: Awaited<ReturnType<ProjectActingTurn>> | undefined
    const runners = await createProjectRunners({ conversation: f.input.conversation, run_id: 'run', state_dir: f.dir,
      actingTurn: async input => { offered = input.timeout_ms; observation = await actingTurn(input); return observation }, headless: {},
      trailer: { schemas: new Map([['v1', () => true]]), metadata: () => undefined } })
    const outcome = await runners.inRepl!.run(f.input.request, 'in-repl', f.input.signal)
    expect(offered).toBeGreaterThan(50_000)
    expect(f.commands).toHaveLength(1)
    expect(f.released()).toBe(1)
    if (scenario === 'late trailer' || scenario === 'trailer without metadata') {
      expect(outcome).toEqual({ kind: 'blocked', on: 'review' })
      expect(now).toBe(scenario === 'late trailer' ? 50_000 : 25)
    } else if (scenario === 'no subagent') {
      expect(observation?.kind).toBe('unknown')
      expect(outcome).toEqual({ kind: 'unknown', detail: 'Dispatch turn completion unknown: The REPL did not accept the dispatch within its budget; subagent completion is unknown.' })
      expect(now).toBe(DISPATCH_TIMEOUT_MS)
      expect(DISPATCH_TIMEOUT_MS).toBe(35_000)
    } else if (scenario === 'no trailer') {
      expect(outcome).toEqual({ kind: 'unknown', detail: 'Dispatch turn completion unknown: Claude trailer not observed before cancellation or host budget expiry.' })
      expect(now).toBeGreaterThanOrEqual(offered)
      expect(now).toBeLessThanOrEqual(wall)
    } else {
      expect(outcome).toEqual({ kind: 'unknown', detail: 'Dispatch or observation interrupted; subagent completion is unknown.' })
    }
  })
}
