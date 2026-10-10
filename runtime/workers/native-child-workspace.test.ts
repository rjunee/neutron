import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplSession } from '../adapters/claude-code/persistent/repl-session.ts'
import { sessionJsonlPath } from '../adapters/claude-code/persistent/jsonl-resumability.ts'
import { createClaudeActingTurn } from './claude-acting-turn.ts'
import { admitNativeChildWorkspace, bindNativeChildWorkspace, completeNativeChildWorkspace, completeNativeChildWorkspaceRequest,
  nativeChildCensusKnown, type NativeChildWorkspace } from './native-child-workspace.ts'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import type { ProjectActingTurn } from './project-runners.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function fixture(alias = false, readOnly: boolean | readonly [boolean, boolean] = false, conflict: 'none' | 'result' | 'branch' = 'none') {
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
  const reader = (index: number) => typeof readOnly === 'boolean' ? readOnly : readOnly[index]!
  const requests: BoundedWorkRequest[] = roots.map((cwd, index) => ({ run_id: `run-${index}`, step_id: `${reader(index) ? 'review' : 'build'}:${index}`, role: reader(index) ? 'review' : 'build',
    model_id: 'worker', effort: 'high', cwd, writable: !reader(index), network: true, tools: reader(index) ? 'read-only' : 'edit-and-run',
    brief: { path: join(state, `brief-${index}`), integrity: 'digest' }, result: { path: join(conflict === 'result' && index === 1 ? roots[0]! : state, `result-${index}`), schema: 'v1' },
    thread: { id: 'session' }, budget: { wall_ms: 10_000 }, needs_approval_decision: false }))
  let pending = requests.map(request => ({ runId: request.run_id, stepId: request.step_id, generation: 0 }))
  let unreadable = false
  const workspaces: NativeChildWorkspace[] = []
  for (const [index, request] of requests.entries()) {
    const actual = alias ? 0 : index
    const branch = conflict === 'branch' ? 0 : actual
    workspaces.push(await admitNativeChildWorkspace({ session, request, runId: request.run_id, worktree: roots[index]!,
      branch: `branch-${branch}`, generation: 0, pending: () => { if (unreadable) throw new Error('unreadable census'); return pending },
      git: async args => args[0] === 'symbolic-ref' ? `refs/heads/branch-${branch}`
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

test.each(['writers', 'readers', 'writer then reader', 'reader then writer'] as const)('admitted %s overlap only after exact child proof and keep leases until host validation', async mode => {
  const readOnly = mode === 'writer then reader' ? [false, true] as const
    : mode === 'reader then writer' ? [true, false] as const : mode === 'readers'
  const f = await fixture(mode === 'readers', readOnly), submitted = barrier(), ack = barrier(), both = barrier(), finish = barrier()
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

test.each([
  ['writer aliases', true, false, 'none'],
  ['writer then reader aliases', true, [false, true], 'none'],
  ['reader then writer aliases', true, [true, false], 'none'],
  ['writer then reader result overlap', false, [false, true], 'result'],
  ['reader then writer result overlap', false, [true, false], 'result'],
  ['writer then reader shared branch', false, [false, true], 'branch'],
  ['reader then writer shared branch', false, [true, false], 'branch'],
] as const)('%s remain serialized even with distinct run admissions', async (_label, alias, readOnly, conflict) => {
  const f = await fixture(alias, readOnly, conflict), polled = barrier(), finish = barrier()
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

test('a continuation cannot bypass a different bound background child', async () => {
  const f = await fixture()
  let yieldOriginal!: () => void, acquired = false
  const releaseOriginal = await f.session.acquireTurn(yieldSlot => { yieldOriginal = yieldSlot }, f.workspaces[0])
  bindNativeChildWorkspace(f.workspaces[0]!)
  yieldOriginal(); releaseOriginal()
  const waiting = f.session.acquireContinuationTurn(f.workspaces[1]!).then(release => { acquired = true; return release })
  await Bun.sleep(20)
  expect(acquired).toBe(false)
  f.complete(0)
  const release = await waiting
  expect(acquired).toBe(true)
  release()
})

test.each(['readers', 'writers', 'writer then reader', 'reader then writer'] as const)('compatible bound %s continue without waiting for peer completion', async mode => {
  const readOnly = mode === 'writer then reader' ? [false, true] as const
    : mode === 'reader then writer' ? [true, false] as const : mode === 'readers'
  const f = await fixture(mode === 'readers', readOnly)
  for (const workspace of f.workspaces) {
    let yieldOriginal!: () => void
    const release = await f.session.acquireTurn(yieldSlot => { yieldOriginal = yieldSlot }, workspace)
    bindNativeChildWorkspace(workspace)
    yieldOriginal(); release()
  }
  expect(f.session.turnSlotHeld).toBe(2)
  let ordinaryEntered = false, active = 0, maximumActive = 0
  const ordinary = f.session.acquireTurn().then(release => { ordinaryEntered = true; release() })
  const entered = [barrier(), barrier()], finish = [barrier(), barrier()], order: number[] = []
  const continuations = f.workspaces.map(async (workspace, index) => {
    const release = await f.session.acquireContinuationTurn(workspace)
    maximumActive = Math.max(maximumActive, ++active)
    order.push(index); entered[index]!.release()
    try { await finish[index]!.promise } finally { active--; release() }
  })
  try {
    // The ceiling catches a deadlock; admission is proven before either native
    // child's completion, with barriers keeping parent submissions distinct.
    expect(await Promise.race([entered[0]!.promise.then(() => true), Bun.sleep(1000).then(() => false)])).toBe(true)
    expect(order).toEqual([0])
    expect(ordinaryEntered).toBe(false)
    finish[0]!.release()
    expect(await Promise.race([entered[1]!.promise.then(() => true), Bun.sleep(1000).then(() => false)])).toBe(true)
    expect(order).toEqual([0, 1])
    expect(maximumActive).toBe(1)
    expect(ordinaryEntered).toBe(false)
    finish[1]!.release()
    await Promise.all(continuations)
    expect(f.session.turnSlotHeld).toBe(3) // Two children and the queued ordinary turn.
  } finally {
    for (const gate of finish) gate.release()
    f.complete(0); f.complete(1)
    await Promise.all([...continuations, ordinary])
  }
  expect(ordinaryEntered).toBe(true)
  expect(f.session.turnSlotHeld).toBe(0)
})

test.each(['none', 'result', 'branch'] as const)('bound continuation retains the conflicting peer fence: %s', async conflict => {
  const f = await fixture(conflict === 'none', false, conflict)
  let yieldOriginal!: () => void, entered = false
  const releaseOriginal = await f.session.acquireTurn(yieldSlot => { yieldOriginal = yieldSlot }, f.workspaces[0])
  bindNativeChildWorkspace(f.workspaces[0]!)
  bindNativeChildWorkspace(f.workspaces[1]!)
  yieldOriginal(); releaseOriginal()
  const waiting = f.session.acquireContinuationTurn(f.workspaces[1]!).then(release => { entered = true; release() })
  try {
    for (let count = 0; count < 8; count++) await Promise.resolve()
    expect(entered).toBe(false)
  } finally { f.complete(0); f.complete(1); await waiting }
  expect(entered).toBe(true)
  expect(f.session.turnSlotHeld).toBe(0)
})

test('cancelled continuation leaves no queued turn and retains the live child fence', async () => {
  const f = await fixture(true), controller = new AbortController()
  let yieldOriginal!: () => void, entered = false
  const releaseOriginal = await f.session.acquireTurn(yieldSlot => { yieldOriginal = yieldSlot }, f.workspaces[0])
  bindNativeChildWorkspace(f.workspaces[0]!)
  bindNativeChildWorkspace(f.workspaces[1]!)
  yieldOriginal(); releaseOriginal()
  const waiting = f.session.acquireContinuationTurn(f.workspaces[1]!, controller.signal).then(release => {
    entered = true; release(); return 'entered'
  }, () => 'cancelled')
  controller.abort()
  try {
    expect(await Promise.race([waiting, Bun.sleep(1000).then(() => 'still queued')])).toBe('cancelled')
    expect(entered).toBe(false)
    expect(f.session.turnSlotHeld).toBe(1)
    expect(nativeChildCensusKnown(f.workspaces[0]!)).toBe(true)
  } finally { f.complete(0); f.complete(1); await waiting }
  expect(entered).toBe(false)
  expect(f.session.turnSlotHeld).toBe(0)
})

test.each(['before-grant', 'after-grant'] as const)('continuation cancellation %s preserves parent slot serialization', async mode => {
  const f = await fixture(), cancelled = new AbortController()
  const releaseActive = await f.session.acquireTurn()
  let entered = false
  const waiting = f.session.acquireContinuationTurn(f.workspaces[0]!, cancelled.signal).then(release => {
    entered = true; release(); return 'entered'
  }, () => 'cancelled')
  if (mode === 'after-grant') releaseActive()
  cancelled.abort()
  expect(await waiting).toBe('cancelled')
  expect(entered).toBe(false)
  expect(f.session.turnSlotHeld).toBe(mode === 'before-grant' ? 1 : 0)
  let nextEntered = false
  const next = f.session.acquireTurn().then(release => { nextEntered = true; release() })
  if (mode === 'before-grant') {
    for (let count = 0; count < 8; count++) await Promise.resolve()
    expect(nextEntered).toBe(false)
    releaseActive()
  }
  await next
  expect(nextEntered).toBe(true)
  expect(f.session.turnSlotHeld).toBe(0)
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
  let preparationEnds = 0
  f.session.child.submitLine = async () => { writes++ }
  const outcome = await createClaudeActingTurn({ ...f.binding(0), onDispatchSubmitted: () => { preparationEnds++ } })({ ...f.input(0), timeout_ms: 30 })
  expect(outcome.kind).toBe('refused')
  expect(writes).toBe(0)
  expect(preparationEnds).toBe(0)
  f.complete(0)
})

test('unknown writer retains durable ownership but cannot wedge the local queue', async () => {
  const f = await fixture()
  let preparing = true
  f.session.child.submitLine = async () => { expect(preparing).toBe(false); throw new Error('lost acknowledgement') }
  await expect(createClaudeActingTurn({ ...f.binding(0), onDispatchSubmitted: () => { preparing = false } })(f.input(0))).rejects.toThrow('lost acknowledgement')
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
  let preparing = true
  f.session.child.submitLine = async () => { expect(preparing).toBe(false); submissions++ }
  const outcome = await createClaudeActingTurn({ ...f.binding(0), onDispatchSubmitted: () => { preparing = false } })({ ...f.input(0), timeout_ms: 40 })
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
