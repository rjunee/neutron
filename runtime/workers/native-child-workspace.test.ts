import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplSession } from '../adapters/claude-code/persistent/repl-session.ts'
import { sessionJsonlPath } from '../adapters/claude-code/persistent/jsonl-resumability.ts'
import { createClaudeActingTurn } from './claude-acting-turn.ts'
import { admitNativeChildWorkspace, completeNativeChildWorkspace, completeNativeChildWorkspaceRequest,
  nativeChildCensusKnown, type NativeChildWorkspace } from './native-child-workspace.ts'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import type { ProjectActingTurn } from './project-runners.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function fixture(alias = false, readOnly = false) {
  const dir = await mkdtemp(join(tmpdir(), 'native-writers-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const roots = [join(dir, 'one'), join(dir, 'two')]
  const common = join(dir, 'git'), state = join(dir, 'state'), projects = join(dir, 'projects')
  await Promise.all([roots[0]!, common, state, join(common, 'one'), join(common, 'two')].map(path => mkdir(path, { recursive: true })))
  if (alias) await symlink(roots[0]!, roots[1]!)
  else await mkdir(roots[1]!)
  const session = new ReplSession('fixture', 'generation', 'session', 'channel', dir)
  session.toolSurface = 'Agent,Read,Write,Bash'
  session.attachChild({ pid: 123, write() {}, kill() {}, hasExited: () => false, exited: new Promise(() => {}) })
  const requests: BoundedWorkRequest[] = roots.map((cwd, index) => ({ run_id: `run-${index}`, step_id: `build:${index}`, role: 'build',
    model_id: 'worker', effort: 'high', cwd, writable: !readOnly, network: true, tools: readOnly ? 'read-only' : 'edit-and-run',
    brief: { path: join(state, `brief-${index}`), integrity: 'digest' }, result: { path: join(state, `result-${index}`), schema: 'v1' },
    thread: { id: 'session' }, budget: { wall_ms: 10_000 }, needs_approval_decision: false }))
  let pending = requests.map(request => ({ runId: request.run_id, stepId: request.step_id, generation: 0 }))
  let unreadable = false
  const workspaces: NativeChildWorkspace[] = []
  for (const [index, request] of requests.entries()) {
    const actual = alias ? 0 : index
    workspaces.push(await admitNativeChildWorkspace({ session, request, runId: request.run_id, worktree: roots[index]!,
      branch: `branch-${actual}`, generation: 0, pending: () => { if (unreadable) throw new Error('unreadable census'); return pending },
      git: async args => args[0] === 'symbolic-ref' ? `refs/heads/branch-${actual}`
        : args.includes('--show-toplevel') ? roots[actual]!
          : args.includes('--absolute-git-dir') ? join(common, actual === 0 ? 'one' : 'two') : common }))
  }
  const complete = (index: number) => {
    pending = pending.filter(row => row.runId !== requests[index]!.run_id)
    completeNativeChildWorkspace(workspaces[index]!)
  }
  cleanups.push(async () => { complete(0); complete(1) })
  const directory = join(sessionJsonlPath('session', dir, projects).slice(0, -'.jsonl'.length), 'subagents')
  const proof = async (index: number, shape = 'exact') => {
    const request = requests[index]!, agentId = `child-${index}`
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `agent-${agentId}.meta.json`), JSON.stringify({ description: `${request.role}: ${request.step_id}` }))
    if (shape === 'metadata') return
    if (shape === 'duplicate') await writeFile(join(directory, 'agent-extra.meta.json'), JSON.stringify({ description: `${request.role}: ${request.step_id}` }))
    await writeFile(join(directory, `agent-${agentId}.jsonl`), JSON.stringify({ agentId, sessionId: shape === 'foreign' ? 'another' : 'session',
      isSidechain: true, type: 'user', message: { role: 'user', content: `Request (data): ${JSON.stringify(shape === 'forged' ? { ...request, run_id: 'another' } : request)}` } }) + '\n')
  }
  const input = (index: number): Parameters<ProjectActingTurn>[0] => ({
    conversation: { project_id: 'project', topic_id: 'topic', provider: 'anthropic', spec: { tools: [], model_preference: ['worker'] } },
    request: requests[index]!, spec: { tools: [], model_preference: ['worker'], prompt: 'native dispatch' }, timeout_ms: 10_000,
    signal: new AbortController().signal })
  const binding = (index: number) => ({ project_id: 'project', topic_id: 'topic', session, projects_dir: projects,
    grants: { tools: 'edit-and-run' as const, writable: true, network: true, roots }, workspace: workspaces[index]! })
  return { dir, roots, requests, workspaces, session, proof, input, binding, complete,
    setUnreadable: () => { unreadable = true }, setPending: (rows: typeof pending) => { pending = rows } }
}

test.each(['writers', 'readers'] as const)('admitted %s overlap only after exact child proof and keep leases until host validation', async mode => {
  const f = await fixture(mode === 'readers', mode === 'readers'), submitted = barrier(), ack = barrier(), both = barrier(), finish = barrier()
  const controller = new AbortController()
  let writes = 0, activeWrites = 0, maxWrites = 0, polls = 0
  f.session.child.submitLine = async () => {
    const index = writes++
    maxWrites = Math.max(maxWrites, ++activeWrites)
    if (index === 0) { submitted.release(); await ack.promise }
    await f.proof(index)
    activeWrites--
  }
  const run = (index: number) => createClaudeActingTurn(f.binding(index), { now: () => 0, pause: async () => {
    if (++polls === 2) both.release()
    await finish.promise
  } })({ ...f.input(index), signal: controller.signal })
  const first = run(0)
  await submitted.promise
  const second = run(1)
  expect(writes).toBe(1)
  ack.release()
  try {
    expect(await Promise.race([both.promise.then(() => true), Bun.sleep(1000).then(() => false)])).toBe(true)
    expect(writes).toBe(2)
    expect(maxWrites).toBe(1)
    expect(f.session.turnSlotHeld).toBe(2)
    for (const request of f.requests) await writeFile(request.result.path, JSON.stringify({ run_id: request.run_id, step_id: request.step_id }))
    finish.release()
    expect(await Promise.all([first, second])).toEqual([{ kind: 'turn-ended' }, { kind: 'turn-ended' }])
    expect(f.session.turnSlotHeld).toBe(2)
    let ordinary = false
    const waiting = f.session.acquireTurn().then(release => { ordinary = true; release() })
    await Promise.resolve()
    expect(ordinary).toBe(false)
    f.complete(0); f.complete(1)
    await waiting
    expect(ordinary).toBe(true)
    expect(f.session.turnSlotHeld).toBe(0)
  } finally {
    controller.abort()
    for (const request of f.requests) await writeFile(request.result.path, '{}')
    finish.release(); f.complete(0); f.complete(1)
    await Promise.all([first, second])
  }
})

for (const shape of ['metadata', 'forged', 'foreign', 'duplicate']) {
  test(`writer dispatch cannot yield on ${shape} child evidence`, async () => {
    const f = await fixture(), polled = barrier(), finish = barrier()
    let writes = 0
    f.session.child.submitLine = async () => { await f.proof(writes++, shape) }
    const running = createClaudeActingTurn(f.binding(0), { now: () => 0, pause: async () => { polled.release(); await finish.promise } })(f.input(0))
    await polled.promise
    let entered = false
    const queued = f.session.acquireTurn(() => {}, f.workspaces[1]).then(release => { entered = true; return release })
    try {
      for (let n = 0; n < 8; n++) await Promise.resolve()
      expect(entered).toBe(false)
    } finally {
      await writeFile(f.requests[0]!.result.path, '{}')
      finish.release()
      await running
      f.complete(0)
      await queued
      f.complete(1)
    }
  })
}

test('canonical worktree aliases remain serialized even with distinct run admissions', async () => {
  const f = await fixture(true), polled = barrier(), finish = barrier()
  f.session.child.submitLine = async () => { await f.proof(0) }
  const running = createClaudeActingTurn(f.binding(0), { now: () => 0, pause: async () => { polled.release(); await finish.promise } })(f.input(0))
  await polled.promise
  let entered = false
  const queued = f.session.acquireTurn(() => {}, f.workspaces[1]).then(() => { entered = true })
  try {
    for (let n = 0; n < 8; n++) await Promise.resolve()
    expect(entered).toBe(false)
  } finally {
    await writeFile(f.requests[0]!.result.path, '{}')
    finish.release(); await running
    f.complete(0); await queued; f.complete(1)
  }
  expect(entered).toBe(true)
})

test('foreign, duplicate, missing and unreadable durable leases cannot authorize overlap', async () => {
  const f = await fixture()
  expect(nativeChildCensusKnown(f.workspaces[0]!)).toBe(true)
  const own = { runId: f.requests[0]!.run_id, stepId: f.requests[0]!.step_id, generation: 0 }
  for (const rows of [[], [own, own], [own, { ...own, runId: 'restart' }], [{ ...own, generation: 1 }]]) {
    f.setPending(rows)
    expect(nativeChildCensusKnown(f.workspaces[0]!)).toBe(false)
  }
  f.setPending([own])
  expect(nativeChildCensusKnown(f.workspaces[0]!)).toBe(true)
  f.setUnreadable()
  expect(nativeChildCensusKnown(f.workspaces[0]!)).toBe(false)
})

test('forged workspace authority and changed request cannot authorize a writer', async () => {
  const f = await fixture()
  let writes = 0
  f.session.child.submitLine = async () => { writes++ }
  for (const binding of [{ ...f.binding(0), workspace: { kind: 'native-child-workspace' } as NativeChildWorkspace }, f.binding(1)]) {
    expect((await createClaudeActingTurn(binding)(f.input(0))).kind).toBe('refused')
  }
  expect(writes).toBe(0)
})

test('an unrepresented restart lease exhausts the original admission budget without dispatch', async () => {
  const f = await fixture()
  f.setPending([{ runId: f.requests[0]!.run_id, stepId: f.requests[0]!.step_id, generation: 0 },
    { runId: 'prior-gateway', stepId: 'unknown-child', generation: 0 }])
  let writes = 0
  f.session.child.submitLine = async () => { writes++ }
  const outcome = await createClaudeActingTurn(f.binding(0))({ ...f.input(0), timeout_ms: 30 })
  expect(outcome.kind).toBe('refused')
  expect(writes).toBe(0)
  f.complete(0)
})

test('unknown writer retains durable ownership but cannot wedge the local queue', async () => {
  const f = await fixture()
  f.session.child.submitLine = async () => { throw new Error('lost acknowledgement') }
  await expect(createClaudeActingTurn(f.binding(0))(f.input(0))).rejects.toThrow('lost acknowledgement')
  expect(f.session.turnSlotHeld).toBe(1)
  expect(nativeChildCensusKnown(f.workspaces[1]!)).toBe(false)
  const waiting = f.session.acquireTurn().then(release => { release(); return true })
  expect(await Promise.race([waiting, new Promise<false>(resolve => setTimeout(() => resolve(false), 100))])).toBe(true)
  expect(f.session.turnSlotHeld).toBe(1)
  completeNativeChildWorkspaceRequest(f.session, { ...f.requests[0]!, step_id: 'wrong' })
  await Promise.resolve()
  expect(f.session.turnSlotHeld).toBe(1)
  expect(nativeChildCensusKnown(f.workspaces[1]!)).toBe(false)
  completeNativeChildWorkspaceRequest(f.session, f.requests[0]!)
  await Promise.resolve()
  expect(f.session.turnSlotHeld).toBe(0)
})

test('acknowledged dispatch without a bound child returns unknown and leaves the next turn bounded', async () => {
  const f = await fixture()
  let submissions = 0
  f.session.child.submitLine = async () => { submissions++ }
  const outcome = await createClaudeActingTurn(f.binding(0))({ ...f.input(0), timeout_ms: 40 })
  expect(outcome.kind).toBe('unknown')
  expect(submissions).toBe(1)
  expect(nativeChildCensusKnown(f.workspaces[1]!)).toBe(false)
  const next = f.session.acquireTurn().then(release => { release(); return true })
  expect(await Promise.race([next, new Promise<false>(resolve => setTimeout(() => resolve(false), 100))])).toBe(true)
  expect(f.session.turnSlotHeld).toBe(1)
  f.complete(0)
  await Promise.resolve()
  expect(f.session.turnSlotHeld).toBe(0)
})
