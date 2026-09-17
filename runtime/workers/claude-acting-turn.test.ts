import { LIVE_AGENT_TOOL_NAMES } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import { SUBAGENT_TOOL_NAME } from './claude-tool-contract.ts'
import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
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
    session: { sessionId: 'session', cwd: dir, toolSurface: LIVE_AGENT_TOOL_NAMES.join(','), acquireTurn: async () => { acquired++; return () => { released++ } },
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
      // THE COUNT IS THE POINT (#1100). The fixture plants two files matching
      // `agent-*.meta.json` — `agent-other` (valid, wrong step) and
      // `agent-partial` (malformed) — plus `other.json`, which must NOT be
      // counted. A counter that cannot reach 2 cannot tell "nothing was
      // created" from "other work is running here", and that single bit cost
      // two wrong root causes on this issue.
      expect(observation).toEqual({ kind: 'unknown', detail: expect.stringContaining('directory exists with 2 agent metadata file(s), none naming this step') })
      const seen = observation as { kind: 'unknown'; detail: string }
      expect(seen.detail).toContain('not evidence the REPL acted')
      // Without a readable transcript the terminal ack alone remains inconclusive.
      expect(seen.detail).toContain('No worker was observed')
      expect(seen.detail).not.toContain('did not accept')
      expect(seen.detail).toContain(directory)
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

// #1100. My own mutation table caught this branch untested: flipping the
// missing-directory arm to report `directoryExists: true` left every test green.
// "The transcript directory does not exist" and "it exists and holds other
// work" are the two facts an operator most needs separated here, so the absent
// case needs its own case.
test('dispatch evidence names an ABSENT subagent directory, distinctly from an empty one', async () => {
  const f = await fixture()
  f.binding.projects_dir = join(f.dir, 'projects')
  const transcript = sessionJsonlPath('session', f.dir, f.binding.projects_dir)
  const directory = join(transcript.slice(0, -'.jsonl'.length), 'subagents')
  // Deliberately NOT created: this is the case where no worker has ever spawned.
  let now = 0
  f.input.request = { ...f.input.request, budget: { wall_ms: 90_000 } }
  // The wall must exceed DISPATCH_TIMEOUT_MS or the outer deadline wins and this
  // asserts the trailer message instead of the dispatch one.
  f.input.timeout_ms = 90_000
  f.binding.session.child.submitLine = async text => { f.commands.push(text) }
  const actingTurn = createClaudeActingTurn(f.binding, { now: () => now, pause: async ms => { now += ms } })
  const observation = await actingTurn(f.input) as { kind: string; detail: string }
  expect(observation.kind).toBe('unknown')
  expect(observation.detail).toContain('directory does not exist')
  expect(observation.detail).toContain(directory)
  // NOT the phrasing used when the directory is present but holds other work.
  expect(observation.detail).not.toContain('directory exists with')
  expect(now).toBe(DISPATCH_TIMEOUT_MS)
})

// #1105 review. An earlier revision caught EVERY readdir failure and called it
// absence — so a regular file at the subagents path (ENOTDIR), a permissions
// error or an I/O fault all reported "directory does not exist", asserting a
// fact the host never established. That is the same collapse of "is false" with
// "could not find out" that this whole change exists to remove, one level down.
test('an UNREADABLE subagent path is not reported as an absent one', async () => {
  const f = await fixture()
  f.binding.projects_dir = join(f.dir, 'projects')
  const transcript = sessionJsonlPath('session', f.dir, f.binding.projects_dir)
  const directory = join(transcript.slice(0, -'.jsonl'.length), 'subagents')
  // A regular FILE where the directory should be: readdir raises ENOTDIR.
  await mkdir(join(directory, '..'), { recursive: true })
  await writeFile(directory, 'not a directory')
  let now = 0
  f.input.request = { ...f.input.request, budget: { wall_ms: 90_000 } }
  f.input.timeout_ms = 90_000
  f.binding.session.child.submitLine = async text => { f.commands.push(text) }
  const actingTurn = createClaudeActingTurn(f.binding, { now: () => now, pause: async ms => { now += ms } })
  const observation = await actingTurn(f.input) as { kind: string; detail: string }
  expect(observation.kind).toBe('unknown')
  expect(observation.detail).toContain('could not be read')
  expect(observation.detail).toContain('ENOTDIR')
  // NEITHER of the two claims the host cannot support here.
  expect(observation.detail).not.toContain('does not exist')
  expect(observation.detail).not.toContain('directory exists with')
})

for (const scenario of ['string', 'blocks', 'historical only', 'decoys', 'missing', 'read failure', 'bad boundary', 'stat failure', 'truncated', 'replaced', 'created after boundary'] as const) {
  test(`dispatch consumption: ${scenario}`, async () => {
    const f = await fixture()
    f.binding.projects_dir = join(f.dir, 'projects')
    const transcript = sessionJsonlPath('session', f.dir, f.binding.projects_dir)
    await mkdir(join(transcript, '..'), { recursive: true })
    const dispatch = 'Execute the prompt in this JSON dispatch specification: ' + JSON.stringify({ ...f.input.spec, effort: f.input.request.effort })
    const record = (content: unknown, type = 'user') => JSON.stringify({ type, message: { content } }) + '\n'
    // Pre-seed the exact production dispatch, including a multibyte record to
    // distinguish byte offsets from string indices. Every normal case has history.
    if (scenario !== 'missing' && scenario !== 'created after boundary') {
      await writeFile(transcript, record('earlier ☃') + record(dispatch))
    }
    if (scenario === 'bad boundary') {
      await rm(transcript)
      await mkdir(transcript)
    }
    let now = 0
    f.input.timeout_ms = 90_000
    f.input.request = { ...f.input.request, budget: { wall_ms: 90_000 } }
    f.binding.session.child.submitLine = async text => {
      expect(text).toBe(dispatch)
      f.commands.push(text)
      if (scenario === 'string' || scenario === 'created after boundary' || scenario === 'stat failure') await appendFile(transcript, record(text))
      if (scenario === 'blocks') await appendFile(transcript, record([{ type: 'text', text }]))
      if (scenario === 'decoys') await appendFile(transcript,
        record(text, 'assistant') + record('prefix ' + text) + record([{ type: 'tool_result', text }]) + '{partial')
      if (scenario === 'read failure') await rm(transcript)
      if (scenario === 'bad boundary') {
        await rm(transcript, { recursive: true })
        await writeFile(transcript, record(text))
      }
      if (scenario === 'truncated') await writeFile(transcript, record(text))
      if (scenario === 'replaced') {
        await rename(transcript, transcript + '.old')
        await writeFile(transcript, record('replacement padding'.repeat(50)) + record(text))
      }
    }
    const realStat = fs.stat
    const statProbe = spyOn(fs, 'stat').mockImplementation(((...args: Parameters<typeof fs.stat>) => {
      if (scenario === 'stat failure' && args[0] === transcript) return Promise.reject(Object.assign(new Error('read failed'), { code: 'EIO' }))
      return realStat(...args)
    }) as typeof fs.stat)
    const realOpen = fs.open
    const reads: number[] = []
    const opened = spyOn(fs, 'open').mockImplementation((...args: Parameters<typeof fs.open>) => {
      if (args[0] === transcript) reads.push(now)
      return realOpen(...args)
    })
    try {
      const result = await createClaudeActingTurn(f.binding, { now: () => now, pause: async ms => { now += ms } })(f.input)
      const expected = ['string', 'blocks', 'created after boundary'].includes(scenario)
        ? 'The REPL consumed the dispatch, but no worker was observed'
        : ['historical only', 'decoys'].includes(scenario)
          ? 'The dispatch line was never consumed by the REPL'
          : 'The session transcript could not be read across the dispatch boundary'
      expect(result).toEqual({ kind: 'unknown', detail: expect.stringContaining(expected) })
      expect(reads).toEqual(['bad boundary', 'stat failure'].includes(scenario) ? [] : [DISPATCH_TIMEOUT_MS])
      expect(now).toBe(DISPATCH_TIMEOUT_MS)
      expect(f.commands).toHaveLength(1)
      expect(f.released()).toBe(1)
    } finally { opened.mockRestore(); statProbe.mockRestore() }
  })
}

test('expiry during boundary capture prevents submission', async () => {
  const f = await fixture()
  f.binding.projects_dir = join(f.dir, 'projects')
  const transcript = sessionJsonlPath('session', f.dir, f.binding.projects_dir)
  let now = 0
  const realStat = fs.stat
  const probe = spyOn(fs, 'stat').mockImplementation(((...args: Parameters<typeof fs.stat>) => {
    if (args[0] === transcript) now = 1000
    return realStat(...args)
  }) as typeof fs.stat)
  try {
    const result = await createClaudeActingTurn(f.binding, { now: () => now, pause: async ms => { now += ms } })(f.input)
    expect(result.kind).toBe('unknown')
    expect(f.commands).toEqual([])
    expect(f.released()).toBe(1)
  } finally { probe.mockRestore() }
})

for (const phase of ['open', 'stat', 'read'] as const) {
  for (const stop of ['caller', 'deadline', 'already cancelled'] as const) {
    if (stop === 'already cancelled' && phase !== 'open') continue
    test(`stalled transcript ${phase} releases the slot on ${stop}`, async () => {
      const f = await fixture()
      f.binding.projects_dir = join(f.dir, 'projects')
      const transcript = sessionJsonlPath('session', f.dir, f.binding.projects_dir)
      await mkdir(join(transcript, '..'), { recursive: true })
      await writeFile(transcript, '')
      let queue = Promise.resolve()
      let releases = 0
      f.binding.session.acquireTurn = async () => {
        const prior = queue
        let release!: () => void
        queue = new Promise<void>(resolve => { release = resolve })
        await prior
        return () => { releases++; release() }
      }
      f.binding.session.child.submitLine = async text => {
        f.commands.push(text)
        await appendFile(transcript, JSON.stringify({ type: 'user', message: { content: text } }) + '\n')
        if (f.commands.length === 2) await writeFile(f.input.request.result.path, '{}')
      }
      let now = 0
      const controller = new AbortController()
      const budget = DISPATCH_TIMEOUT_MS + 60
      const firstInput = { ...f.input, signal: controller.signal, timeout_ms: budget,
        request: { ...f.input.request, budget: { wall_ms: budget } } }
      let entered!: () => void
      const opening = new Promise<void>(resolve => { entered = resolve })
      let unblock!: () => void
      const held = new Promise<void>(resolve => { unblock = resolve })
      const realOpen = fs.open
      let firstOpen = true
      let lateStats = 0
      let lateReads = 0
      let readAborted = false
      let closed!: () => void
      const fileClosed = new Promise<void>(resolve => { closed = resolve })
      const probe = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (args[0] !== transcript || !firstOpen) return realOpen(...args)
        firstOpen = false
        if (phase === 'open') { entered(); await held }
        const file = await realOpen(...args)
        const realStat = file.stat.bind(file)
        const realRead = file.readFile.bind(file)
        const realClose = file.close.bind(file)
        file.stat = (async () => {
          lateStats++
          if (phase === 'stat') { entered(); await held }
          return realStat()
        }) as typeof file.stat
        file.readFile = (async (options: Parameters<typeof file.readFile>[0]) => {
          lateReads++
          if (phase === 'read') { entered(); await held }
          try { return await realRead(options) } catch (error) {
            readAborted = (error as Error).name === 'AbortError'
            throw error
          }
        }) as typeof file.readFile
        file.close = async () => { try { await realClose() } finally { closed() } }
        return file
      })
      let expiryReads = 0
      const run = createClaudeActingTurn(f.binding, {
        now: () => {
          // Cancel when the remaining diagnostic budget is computed, after entry.
          if (stop === 'already cancelled' && now === DISPATCH_TIMEOUT_MS && ++expiryReads === 3) controller.abort()
          return now
        },
        pause: async ms => { now += ms },
      })
      const first = run(firstInput)
      let second: ReturnType<typeof run> | undefined
      try {
        await opening
        if (stop === 'caller') controller.abort()
        const result = await Promise.race([first, Bun.sleep(stop === 'deadline' ? 150 : 20).then(() => undefined)])
        second = run({ ...f.input, timeout_ms: 1000, request: { ...f.input.request, budget: { wall_ms: 1000 } } })
        await Promise.race([second, Bun.sleep(40)])
        expect(f.commands).toHaveLength(2)
        expect(releases).toBe(2)
        expect(result).toEqual({ kind: 'unknown', detail: expect.stringContaining('transcript could not be read') })
        expect(await second).toEqual({ kind: 'turn-ended' })
        unblock()
        await fileClosed
        expect(lateStats).toBe(phase === 'open' ? 0 : 1)
        expect(lateReads).toBe(phase === 'read' ? 1 : 0)
        expect(readAborted).toBe(phase === 'read')
      } finally {
        unblock()
        await first
        await second
        await fileClosed
        probe.mockRestore()
      }
    })
  }
}

// #1112 acceptance 2. A session that CANNOT create a subagent is a refusal the
// host can make before acting — not an uncertainty to discover by waiting. Three
// card-dispatched runs each spent 35s polling a tool-less child for a worker that
// could never exist, and reported `{kind:'unknown'}`: the weakest possible answer
// to a question the host could have answered immediately.
test('a session whose surface lacks the subagent tool is REFUSED before any submission', async () => {
  const f = await fixture()
  f.binding.session.toolSurface = 'Read,Bash'
  const outcome = await createClaudeActingTurn(f.binding)(f.input) as { kind: string; reason?: string; detail: string }
  expect(outcome.kind).toBe('refused')
  expect(outcome.reason).toBe('capability-unsupported')
  // The detail names the surface AND the missing tool, so an operator is not
  // left inferring which of the two facts is wrong.
  expect(outcome.detail).toContain('Read,Bash')
  expect(outcome.detail).toContain(SUBAGENT_TOOL_NAME)
  // NOTHING was submitted: this is a pre-actuation refusal, not a late verdict.
  expect(f.commands).toHaveLength(0)
  // And it is NOT the unknown this replaces — a refusal is a decision.
  expect(outcome.kind).not.toBe('unknown')
})

test('an empty tool surface is refused, and says it was empty', async () => {
  const f = await fixture()
  f.binding.session.toolSurface = ''
  const outcome = await createClaudeActingTurn(f.binding)(f.input) as { kind: string; detail: string }
  expect(outcome.kind).toBe('refused')
  // `--tools ""` is the exact shape #1112 produced; an operator reading this must
  // not see a blank where the surface should be.
  expect(outcome.detail).toContain('<empty>')
  expect(f.commands).toHaveLength(0)
})

// Review finding on #1114: the known-incapability arm was pinned, this one was
// not. "Lacks the tool" and "cannot read the surface" are different facts — the
// first is something the host establishes, the second is something it admits it
// cannot. Adding a branch without a test for it is how the first draft's crash
// survived until the wiring mocks happened to hit it.
test('an UNREADABLE tool surface refuses with its own detail, distinct from lacking the tool', async () => {
  const f = await fixture()
  // Not a string: the shape a stale or partially-constructed session presents.
  ;(f.binding.session as { toolSurface?: unknown }).toolSurface = undefined
  const outcome = await createClaudeActingTurn(f.binding)(f.input) as { kind: string; detail: string }
  expect(outcome.kind).toBe('refused')
  expect(outcome.detail).toContain('unreadable')
  // It must NOT claim the session lacks the tool — that is a fact it cannot establish.
  expect(outcome.detail).not.toContain('does not carry')
  // And nothing is submitted on this path either.
  expect(f.commands).toHaveLength(0)
})
