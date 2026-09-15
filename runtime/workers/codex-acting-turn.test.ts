import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PtyChild } from '../adapters/claude-code/persistent/pty-host.ts'
import { CodexProjectSession } from '../adapters/codex-cli/persistent/project-session.ts'
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
  const start = Date.now()
  expect(await f.run()).toEqual({ kind: 'unknown', detail: expect.stringContaining('trailer') })
  expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  expect(f.commands).toHaveLength(1)
})

test('trailer appearing after acknowledgement establishes observation', async () => {
  const f = await fixture()
  let write: Promise<void> | undefined
  f.binding.session!.submitLine = async () => { write = Bun.sleep(35).then(() => writeFile(f.input.request.result.path, '{}')) }
  expect(await f.run()).toEqual({ kind: 'turn-ended' })
  await write
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
