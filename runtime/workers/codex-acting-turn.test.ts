import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdoptableHost, PtyChild, PtySpawnOpts } from '../adapters/claude-code/persistent/pty-host.ts'
import { CodexApprovalRefusedError, CodexProjectSession, CodexProjectSessionHost } from '../adapters/codex-cli/persistent/project-session.ts'
import { PROVIDERS } from '../provider.ts'
import { createCodexActingTurn, type CodexActingSession } from './codex-acting-turn.ts'
import type { ProjectActingTurn } from './project-runners.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-acting-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const commands: string[] = []
  let live = true
  const input: Parameters<ProjectActingTurn>[0] = {
    conversation: { project_id: 'project', topic_id: 'topic', provider: 'openai-codex', spec: { tools: [], model_preference: ['planner'] } },
    request: { run_id: 'run', step_id: 'step', role: 'build', model_id: 'worker', effort: 'high', cwd: dir,
      writable: true, network: true, tools: 'edit-and-run', brief: { path: join(dir, 'brief'), integrity: 'digest' },
      result: { path: join(dir, 'result'), schema: 'v1' }, thread: { id: 'codex-thread' }, budget: { wall_ms: 120 }, needs_approval_decision: false },
    spec: { prompt: 'Invoke collaboration.spawn_agent exactly once', tools: [], model_preference: ['worker'] },
    timeout_ms: 120, signal: new AbortController().signal,
  }
  const session: NonNullable<CodexActingSession['session']> = {
    projectId: 'project', isLive: () => live,
    screenPrompt: () => undefined, answerApproval: async () => { throw new Error('unexpected approval') },
    submitLine: async text => { commands.push(text); await writeFile(input.request.result.path, '{}') },
  }
  const binding: CodexActingSession = {
    project_id: 'project', topic_id: 'topic', thread_id: 'codex-thread', cwd: dir, session,
    grants: { roots: [], tools: 'edit-and-run', writable: true, network: true },
  }
  return { dir, input, binding, commands, setLive: (value: boolean) => { live = value }, run: () => createCodexActingTurn(binding)(input) }
}

test('Codex positive control forwards spec and effort into one acknowledged line then observes the trailer', async () => {
  const f = await fixture()
  expect(await f.run()).toEqual({ kind: 'turn-ended' })
  expect(f.commands).toHaveLength(1)
  expect(f.commands[0]).not.toMatch(/[\r\n]/)
  expect(JSON.parse(f.commands[0]!.slice(f.commands[0]!.indexOf('{')))).toEqual({ ...f.input.spec, effort: 'high' })
})

for (const provider of PROVIDERS.filter(p => p !== 'openai-codex')) {
  test(`refuses provider ${provider} by name`, async () => {
    const f = await fixture()
    f.input.conversation = { ...f.input.conversation, provider }
    expect(await f.run()).toEqual({ kind: 'refused', reason: 'capability-unsupported', detail: expect.stringContaining(provider) })
    expect(f.commands).toHaveLength(0)
  })
}

for (const field of ['project_id', 'topic_id', 'thread', 'cwd', 'tools', 'writable', 'network', 'session', 'session-project', 'live'] as const) {
  test(`refuses unavailable ${field} before actuation`, async () => {
    const f = await fixture()
    if (field === 'project_id' || field === 'topic_id') f.binding[field] = 'wrong'
    else if (field === 'thread') f.binding.thread_id = 'wrong'
    else if (field === 'cwd') f.binding.cwd = join(f.dir, 'wrong')
    else if (field === 'tools') f.binding.grants.tools = 'read-only'
    else if (field === 'writable' || field === 'network') f.binding.grants[field] = false
    else if (field === 'session') f.binding.session = undefined
    else if (field === 'session-project') f.binding.session = { ...f.binding.session!, projectId: 'wrong' }
    else f.setLive(false)
    const detail = {
      project_id: 'Project conversation does not match the bound Codex session.',
      topic_id: 'Project conversation does not match the bound Codex session.',
      thread: 'Requested thread does not match the bound Codex session.',
      cwd: 'Requested cwd unavailable outside the granted roots of the project Codex session.',
      tools: 'Requested tools edit-and-run unavailable in Codex session.',
      writable: 'Requested writable access unavailable in Codex session.',
      network: 'Requested network access unavailable in Codex session.',
      session: 'Codex project session is unavailable.',
      'session-project': 'Codex project session does not match the bound project.',
      live: 'Codex project session is not live.',
    }[field]
    expect(await f.run()).toEqual({ kind: 'refused', reason: 'capability-unsupported', detail })
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
  f.binding.session!.submitLine = async text => { f.commands.push(text) }
  f.input.timeout_ms = 45
  // NO WALL-CLOCK ASSERTION. "It took at least 40ms" is a proxy for the property and a
  // flaky one — a loaded runner can make any margin fail, and a fast one can satisfy it
  // without the turn ever having waited. The property is that an ACKNOWLEDGED submission
  // is not treated as a completed turn: the line went out exactly once, and the outcome
  // is still `unknown` because no trailer was ever observed.
  expect(await f.run()).toEqual({ kind: 'unknown', detail: expect.stringContaining('trailer') })
  expect(f.commands).toHaveLength(1)
})

test('trailer appearing after acknowledgement establishes observation', async () => {
  const f = await fixture()
  let write: Promise<void> | undefined
  f.binding.session!.submitLine = async () => { write = Bun.sleep(35).then(() => writeFile(f.input.request.result.path, '{}')) }
  expect(await f.run()).toEqual({ kind: 'turn-ended' })
  await write
})

test('a valid trailer for another step does not end the acting turn', async () => {
  const f = await fixture()
  let replaced = false
  f.binding.session!.submitLine = async () => {
    await writeFile(f.input.request.result.path, JSON.stringify({ run_id: 'run', step_id: 'older-step' }))
    void Bun.sleep(35).then(async () => { await writeFile(f.input.request.result.path, '{}'); replaced = true })
  }
  expect(await f.run()).toEqual({ kind: 'turn-ended' })
  expect(replaced).toBe(true)
})

test('two concurrent acting turns serialize their acknowledged submissions', async () => {
  const f = await fixture()
  let active = 0
  let maxActive = 0
  let firstRelease!: () => void
  const firstHeld = new Promise<void>(resolve => { firstRelease = resolve })
  let calls = 0
  const child: PtyChild = {
    pid: 123, paneHandle: 'pane', write() {}, kill() {}, exited: new Promise(() => {}), hasExited: () => false,
    submitLine: async text => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const call = calls++
      if (call === 0) await firstHeld
      await writeFile(call === 0 ? f.input.request.result.path : join(f.dir, 'result-two'), '{}')
      active -= 1
      f.commands.push(text)
    },
  }
  f.binding.session = new CodexProjectSession('project', 'pane', 'started', child)
  const second = { ...f.input, request: { ...f.input.request, step_id: 'step-two', result: { ...f.input.request.result, path: join(f.dir, 'result-two') } } }
  const turn = createCodexActingTurn(f.binding)
  const first = turn(f.input)
  await Bun.sleep(0)
  const queued = turn(second)
  await Bun.sleep(0)
  expect(maxActive).toBe(1)
  expect(calls).toBe(1)
  firstRelease()
  expect(await Promise.all([first, queued])).toEqual([{ kind: 'turn-ended' }, { kind: 'turn-ended' }])
  expect(maxActive).toBe(1)
  expect(calls).toBe(2)
})

for (const cwd of ['/a/b', '/a/b/worktree', '/a/b/../b/worktree']) {
  test(`granted root accepts ${cwd}`, async () => {
    const f = await fixture()
    f.binding.grants.roots = ['/a/b']
    f.input.request = { ...f.input.request, cwd }
    expect(await f.run()).toEqual({ kind: 'turn-ended' })
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

for (const when of ['before dispatch', 'after dispatch'] as const) {
  for (const kind of ['approval', 'trust'] as const) {
    test(`worker handles rendered ${kind} ${when}`, async () => {
      const f = await fixture()
      const screen = kind === 'approval'
        ? 'Would you like to run the following command?\n1. Yes, proceed\n3. No, stop'
        : 'Do you trust the contents of this directory?\n1. Yes, continue'
      let onScreen: PtySpawnOpts['onScreen']
      const child: PtyChild = {
        pid: 123, paneHandle: 'pane', write() {}, kill() {}, exited: new Promise(() => {}), hasExited: () => false,
        submitLine: async text => {
          f.commands.push(text)
          onScreen?.(screen)
        },
      }
      const host: AdoptableHost = {
        spawn: async (_argv, options) => { onScreen = options.onScreen; return child },
        attach: async (_handle, options) => { onScreen = options.onScreen; return child },
        inspectHandle: async () => ({ kind: 'gone' }), closeHandle: async () => {},
      }
      const sessions = new CodexProjectSessionHost({ host, bin: process.execPath, registryPath: join(f.dir, 'sessions.json') })
      f.binding.session = await sessions.open({ projectId: 'project', cwd: f.dir, env: {} })
      if (when === 'before dispatch') onScreen?.(screen)
      expect(await f.run()).toEqual({
        kind: 'refused', reason: 'capability-unsupported',
        detail: kind === 'approval'
          ? 'Codex requested approval outside the bounded worker grants; denied.'
          : 'Codex directory trust requires setup outside the bounded worker.',
      })
      const answers = when === 'after dispatch' ? f.commands.slice(1) : f.commands
      expect(answers).toEqual(kind === 'approval' ? ['3'] : [])
      expect(f.commands).toHaveLength((when === 'after dispatch' ? 1 : 0) + (kind === 'approval' ? 1 : 0))
    })
  }
}

test('worker preserves a queued approval refusal as a refusal outcome', async () => {
  const f = await fixture()
  f.binding.session!.screenPrompt = () => ({ kind: 'approval', allowKey: '1', denyKey: '3' })
  f.binding.session!.answerApproval = async () => { throw new CodexApprovalRefusedError('approval prompt changed while queued') }
  expect(await f.run()).toEqual({ kind: 'refused', reason: 'capability-unsupported', detail: 'approval prompt changed while queued' })
  expect(f.commands).toEqual([])
})

test('cancellation during the initial screen observation prevents dispatch', async () => {
  const f = await fixture()
  const controller = new AbortController()
  f.input.signal = controller.signal
  f.binding.session!.screenPrompt = () => { controller.abort(); return undefined }
  expect(await f.run()).toMatchObject({ kind: 'unknown' })
  expect(f.commands).toEqual([])
})
