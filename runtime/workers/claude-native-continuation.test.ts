import { afterEach, expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { ReplSession } from '../adapters/claude-code/persistent/repl-session.ts'
import { sessionJsonlPath } from '../adapters/claude-code/persistent/jsonl-resumability.ts'
import { readNativeParentLaunchEvidence, recordNativeParentLaunchEvidence, type NativeParentLaunchEvidence } from '../adapters/claude-code/persistent/native-parent-launch-evidence.ts'
import { prepareAdoptedNativeParentLaunch } from '../adapters/claude-code/persistent/adopted-native-parent-launch.ts'
import { readProcessIdentity } from '../adapters/claude-code/persistent/process-identity.ts'
import { createNativeDispatchSigner, type NativeDispatchLease } from './claude-native-dispatch-receipt.ts'
import { admitNativeChildWorkspace, bindNativeChildWorkspace, completeNativeChildWorkspace } from './native-child-workspace.ts'
import { reserveTrailerSlot } from './trailer-slot.ts'
import { CLAUDE_CONTINUATION_PROFILE, continueClaudeNativeChild, type ClaudeContinuationOptions } from './claude-native-continuation.ts'
import { decodeProjectTrailer } from './project-runners.ts'
import { capacityFixture } from './claude-capacity-client.test-support.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

async function fixture(profile: 'valid' | 'missing' | 'unavailable' | 'foreign' | 'wrong-digest' | 'wrong-version' | 'adopted' | 'adopted-unavailable' = 'valid') {
  const capacity = await capacityFixture()
  cleanup.push(() => capacity.close())
  const dir = await mkdtemp(join(tmpdir(), 'native-continuation-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const cwd = join(dir, 'work'), stateDir = join(dir, 'state'), common = join(dir, 'git'), gitDir = join(common, 'work')
  await Promise.all([cwd, stateDir, gitDir].map(path => mkdir(path, { recursive: true })))
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'build:0', role: 'build', model_id: 'claude-fable-5-1', effort: 'high',
    cwd, tools: 'edit-and-run', writable: true, network: true, thread: { id: 'parent' }, brief: { path: join(dir, 'brief'), integrity: 'digest' },
    result: { path: join(stateDir, 'build.result'), schema: 'fixture' }, budget: { wall_ms: 5000 }, needs_approval_decision: false }
  const key = createHash('sha256').update(JSON.stringify([request.run_id, request.step_id])).digest('hex')
  await reserveTrailerSlot(join(stateDir, `claude-step-${key}.json`), JSON.stringify(request), request.result.path)
  const session = new ReplSession('key', 'generation', 'parent', 'channel', cwd)
  session.toolSurface = 'Agent,SendMessage'
  const inputs: string[] = []
  session.attachChild({ pid: process.pid, write() {}, kill() {}, hasExited: () => false, exited: new Promise(() => {}),
    submitLine: async line => { inputs.push(line) } })
  if (profile === 'unavailable' || profile === 'adopted-unavailable') session.toolSurface = 'Agent'
  const launch: NativeParentLaunchEvidence = { version: 1, sessionId: profile === 'foreign' ? 'another' : 'parent', childGeneration: 'generation', projectId: 'project',
    executable: { realPath: '/opt/claude', ...CLAUDE_CONTINUATION_PROFILE,
      ...(profile === 'wrong-digest' ? { sha256: '0'.repeat(64) } : {}), ...(profile === 'wrong-version' ? { version: '0.0.0' } : {}) },
    argv: ['/opt/claude', '--session-id', 'parent', '--tools', session.toolSurface], tools: session.toolSurface.split(',') }
  if (profile === 'adopted' || profile === 'adopted-unavailable') {
    const argv = ['claude', '--session-id', 'parent', '--tools', session.toolSurface, '--dangerously-load-development-channels', 'server:channel']
    const observed = await prepareAdoptedNativeParentLaunch({ pid: process.pid, sessionId: 'parent', childGeneration: 'generation', projectId: 'project',
      channelName: 'channel', cwd, claudeBasename: 'claude', argv, inspect: async () => ({ kind: 'live', pid: process.pid, argv }) }, {
      readIdentity: () => readProcessIdentity(process.pid), readArgv: () => argv,
      observeExecutable: async () => ({ executable: launch.executable, isCurrent: () => true }),
    })
    observed?.record(session)
  } else if (profile !== 'missing') recordNativeParentLaunchEvidence(session, launch)
  const admit = (session: ReplSession) => admitNativeChildWorkspace({ session, request, runId: 'run', worktree: cwd, branch: 'work', generation: 0,
    pending: () => [{ runId: 'run', stepId: 'build:0', generation: 0 }],
    git: async args => args[0] === 'symbolic-ref' ? 'refs/heads/work' : args.includes('--show-toplevel') ? cwd : args.includes('--absolute-git-dir') ? gitDir : common })
  const workspace = await admit(session)
  cleanup.push(async () => completeNativeChildWorkspace(workspace))
  const signer = createNativeDispatchSigner()
  const lease: NativeDispatchLease = { scope: { ownerHandle: 'owner', projectId: 'project' }, generation: 0, token: 'lease',
    reason: 'liveChild', producer: `native-child:boot:${signer.keyDigest}`, workRef: JSON.stringify(['run', 'build:0']) }
  const authority = signer.begin(lease, request)
  authority.prepare()
  const originalLaunch = readNativeParentLaunchEvidence(session)
  authority.record({ kind: 'parent-bound', parent: { sessionId: 'parent', childGeneration: 'generation', pid: process.pid,
    processIdentity: readProcessIdentity(process.pid) ?? null, ...(originalLaunch ? { launch: originalLaunch } : {}) } })
  authority.record({ kind: 'submission-started' })
  const receipt = authority.record({ kind: 'child-bound', nativeAgentId: 'child' })
  const projectsDir = join(dir, 'projects'), transcript = sessionJsonlPath('parent', cwd, projectsDir)
  const children = join(transcript.slice(0, -'.jsonl'.length), 'subagents')
  await mkdir(children, { recursive: true })
  await writeFile(transcript, '')
  const childPath = join(children, 'agent-child.jsonl')
  const identity = { sessionId: 'parent', agentId: 'child', isSidechain: true }
  await writeFile(childPath, [
    { ...identity, type: 'user', message: { role: 'user', content: `Request (data): ${JSON.stringify(request)}` } },
    { ...identity, type: 'assistant', message: { role: 'assistant', model: '<synthetic>' }, isApiErrorMessage: true,
      error: 'rate_limit', apiErrorStatus: 429, requestId: 'quota-event' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  let saved: string | undefined
  const options: ClaudeContinuationOptions = { request, receipt, stateDir, session, workspace, projectsDir,
    capacity: { configDir: capacity.configDir, env: {}, acquire: capacity.acquire },
    authority: { lease, read: () => saved, claim: async value => { if (saved !== undefined) return false; saved = value; return true } },
    signal: new AbortController().signal, deadline: Date.now() + 5000,
    decodeTrailer: (bytes, req) => decodeProjectTrailer(bytes, req, { schemas: new Map([['fixture', result => result === 'done']]), metadata: () => undefined }) }
  const invoke = (input = options) => continueClaudeNativeChild(input)
  const recordInvocation = async (to = 'child') => {
    const prepared = JSON.parse(saved!)
    await appendFile(transcript, JSON.stringify({ sessionId: 'parent', type: 'assistant', message: { role: 'assistant',
      content: [{ type: 'tool_use', name: 'SendMessage', id: 'exact-tool', input: { ...prepared.args, to } }] } }) + '\n')
  }
  const restore = async (observe = true, generation = 'restored-generation') => {
    const restored = new ReplSession('key', 'restored-generation', 'parent', 'channel', cwd)
    restored.attachChild(session.child)
    restored.toolSurface = session.toolSurface
    if (observe) recordNativeParentLaunchEvidence(restored, { ...launch, childGeneration: generation })
    const workspace = await admit(restored)
    cleanup.push(async () => completeNativeChildWorkspace(workspace))
    return { ...options, session: restored, workspace }
  }
  return { options, session, request, inputs, invoke, restore, childPath, transcript, recordInvocation, capacity, saved: () => saved }
}

test('all-full retains the original claim opportunity until fresh signed capacity permits that same child', async () => {
  const f = await fixture()
  f.capacity.setMode('all-full')
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: 'capacity-waiting' })
  expect(f.saved()).toBeUndefined(); expect(f.inputs).toHaveLength(0)
  f.capacity.setMode('available')
  expect(await f.invoke()).toMatchObject({ kind: 'submitted' })
  expect(f.inputs).toHaveLength(1)
  expect(JSON.parse(f.saved()!).capacity.body).toMatchObject({ accountGeneration: 'a'.repeat(64), childId: 'child', modelId: f.request.model_id })
})

test('one same-ID continuation persists original receipt, quota and lease before send; a fresh observer never resends', async () => {
  const f = await fixture()
  f.session.child.submitLine = async line => { expect(f.saved()).toBeDefined(); f.inputs.push(line); throw new Error('lost acknowledgement') }
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: 'submission-unknown' })
  const prepared = JSON.parse(f.saved()!)
  expect(prepared).toMatchObject({ agentId: 'child', request: f.request, lease: f.options.authority.lease, quota: { requestId: 'quota-event' } })
  expect(await f.invoke({ ...f.options, authority: { ...f.options.authority } })).toEqual({ kind: 'unknown', reason: 'submission-unknown' })
  await f.recordInvocation('other')
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: 'submission-unknown' })
  await f.recordInvocation()
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: 'submission-unknown' })
  expect(f.inputs).toHaveLength(1)
  expect(f.inputs[0]).toContain('"to":"child"')
})

test('a unique exact native invocation reconciles the original spent opportunity', async () => {
  const f = await fixture()
  await writeFile(f.transcript, JSON.stringify({ type: 'system', message: 'original prefix' }) + '\n')
  expect(await f.invoke()).toEqual({ kind: 'submitted', evidence: 'terminal-acknowledgement' })
  await f.recordInvocation()
  expect(await f.invoke()).toEqual({ kind: 'submitted', evidence: 'exact-tool-invocation' })
  expect(f.inputs).toHaveLength(1)
})

test.each(['wrong-recipient', 'same-recipient', 'after-exact', 'unrelated'] as const)('nonce conflict reconciliation: %s', async mode => {
  const f = await fixture()
  expect(await f.invoke()).toMatchObject({ kind: 'submitted' })
  const saved = f.saved()!, prepared = JSON.parse(saved)
  if (mode === 'after-exact') await f.recordInvocation()
  await appendFile(f.transcript, JSON.stringify({ sessionId: 'parent', type: 'assistant', message: { role: 'assistant', content: [{
    type: 'tool_use', name: 'SendMessage', id: 'other-tool', input: { to: mode === 'same-recipient' ? 'child' : 'other',
      message: mode === 'unrelated' ? 'An independent message without this attempt receipt.' : `Altered instruction; ${prepared.nonce}` },
  }] } }) + '\n')
  if (mode !== 'after-exact') await f.recordInvocation()
  expect(await f.invoke()).toEqual(mode === 'unrelated'
    ? { kind: 'submitted', evidence: 'exact-tool-invocation' } : { kind: 'unknown', reason: 'submission-unknown' })
  expect(f.inputs).toHaveLength(1)
  expect(f.saved()).toBe(saved)
})

test.each(['adopted', 'adopted-unavailable'] as const)('a new child after %s parent observation has bounded continuation authority', async profile => {
  const f = await fixture(profile)
  const available = profile === 'adopted'
  expect(readNativeParentLaunchEvidence(f.session) !== undefined).toBe(available)
  expect(await f.invoke()).toEqual(available ? { kind: 'submitted', evidence: 'terminal-acknowledgement' } : { kind: 'unknown', reason: 'tool-unavailable' })
  await f.invoke()
  expect(f.inputs).toHaveLength(available ? 1 : 0)
})

test('authorized same-session restoration requires the current generation launch before input', async () => {
  const f = await fixture()
  const restored = await f.restore(true, 'stale-generation')
  expect(await f.invoke(restored)).toEqual({ kind: 'unknown', reason: 'launch-unknown' })
  expect(f.inputs).toHaveLength(0)
  const current = await f.restore()
  expect(await f.invoke(current)).toEqual({ kind: 'submitted', evidence: 'terminal-acknowledgement' })
  expect(JSON.parse(f.saved()!).childGeneration).toBe('restored-generation')
  expect(f.inputs).toHaveLength(1)
})

test('restoration observes an already spent attempt from its original transcript boundary without new input', async () => {
  const f = await fixture()
  expect(await f.invoke()).toMatchObject({ kind: 'submitted' })
  const restored = await f.restore(false)
  expect(await f.invoke(restored)).toEqual({ kind: 'unknown', reason: 'submission-unknown' })
  await f.recordInvocation()
  expect(await f.invoke(restored)).toEqual({ kind: 'submitted', evidence: 'exact-tool-invocation' })
  expect(JSON.parse(f.saved()!).childGeneration).toBe('generation')
  expect(f.inputs).toHaveLength(1)
})

test('adoption without fresh launch memory requires the exact signed original process identity', async () => {
  const f = await fixture()
  const adopted = await f.restore(false)
  adopted.session.attachChild({ ...f.session.child, pid: process.pid + 1 })
  expect(await f.invoke(adopted)).toEqual({ kind: 'unknown', reason: 'launch-unknown' })
  expect(f.inputs).toHaveLength(0)
  adopted.session.attachChild(f.session.child)
  expect(await f.invoke(adopted)).toEqual({ kind: 'submitted', evidence: 'terminal-acknowledgement' })
  expect(f.inputs).toHaveLength(1)
})

test('a reconstructed workspace continues the same yielded native child in its live session', async () => {
  const f = await fixture()
  let yieldOriginal!: () => void
  const releaseOriginal = await f.session.acquireTurn(yieldSlot => { yieldOriginal = yieldSlot }, f.options.workspace)
  bindNativeChildWorkspace(f.options.workspace)
  yieldOriginal(); releaseOriginal()
  const prior = f.options.workspace
  const cwd = f.request.cwd, common = join(cwd, '..', 'git'), gitDir = join(common, 'work')
  const reconstructed = await admitNativeChildWorkspace({ session: f.session, request: f.request, runId: 'run', worktree: cwd, branch: 'work', generation: 0,
    pending: () => [{ runId: 'run', stepId: 'build:0', generation: 0 }],
    git: async args => args[0] === 'symbolic-ref' ? 'refs/heads/work' : args.includes('--show-toplevel') ? cwd : args.includes('--absolute-git-dir') ? gitDir : common })
  cleanup.push(async () => completeNativeChildWorkspace(reconstructed))
  expect(reconstructed).not.toBe(prior)
  expect(await f.invoke({ ...f.options, workspace: reconstructed, deadline: Date.now() + 100 })).toEqual({ kind: 'submitted', evidence: 'terminal-acknowledgement' })
  expect(f.inputs).toHaveLength(1)
  expect(f.session.turnSlotHeld).toBe(1)
})

test('concurrent continuation callers spend one opportunity', async () => {
  const f = await fixture()
  await Promise.all([f.invoke(), f.invoke()])
  expect(f.inputs).toHaveLength(1)
})

test('continuation overtakes ordinary input queued before the original child yielded, without overlapping parent input', async () => {
  const f = await fixture()
  let yieldOriginal!: () => void, ordinaryAcquired = false
  const releaseOriginal = await f.session.acquireTurn(yieldSlot => { yieldOriginal = yieldSlot }, f.options.workspace)
  const ordinary = f.session.acquireTurn().then(release => { ordinaryAcquired = true; return release })
  const continuing = f.invoke({ ...f.options, deadline: Date.now() + 500 })
  await Bun.sleep(20)
  expect(f.inputs).toHaveLength(0)
  bindNativeChildWorkspace(f.options.workspace)
  yieldOriginal(); releaseOriginal()
  expect(await continuing).toEqual({ kind: 'submitted', evidence: 'terminal-acknowledgement' })
  expect(ordinaryAcquired).toBe(false)
  expect(f.session.turnSlotHeld).toBe(2)
  completeNativeChildWorkspace(f.options.workspace)
  const releaseOrdinary = await ordinary
  expect(ordinaryAcquired).toBe(true)
  releaseOrdinary()
  expect(f.session.turnSlotHeld).toBe(0)
})

test('same-inode transcript truncation and regrowth cannot reconcile a spent continuation', async () => {
  const f = await fixture()
  await writeFile(f.transcript, JSON.stringify({ type: 'system', message: 'original prefix' }) + '\n')
  expect(await f.invoke()).toMatchObject({ kind: 'submitted' })
  await writeFile(f.transcript, JSON.stringify({ type: 'system', message: 'replaced prefix' }) + '\n')
  await f.recordInvocation()
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: 'submission-unknown' })
  expect(f.inputs).toHaveLength(1)
})

test('continuation crosses its own unresolved session slot without releasing native ownership', async () => {
  const f = await fixture()
  const releaseOriginal = await f.session.acquireTurn(undefined, f.options.workspace)
  releaseOriginal()
  expect(f.session.turnSlotHeld).toBe(1)
  expect(await f.invoke()).toEqual({ kind: 'submitted', evidence: 'terminal-acknowledgement' })
  expect(f.session.turnSlotHeld).toBe(1)
  expect(f.inputs).toHaveLength(1)
})

test.each(['missing', 'unavailable', 'foreign', 'wrong-digest', 'wrong-version'] as const)('native launch %s cannot submit; an argv assertion alone is insufficient', async mode => {
  const f = await fixture(mode)
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: mode === 'unavailable' ? 'tool-unavailable' : 'launch-unknown' })
  expect(f.inputs).toHaveLength(0)
  expect(f.saved()).toBeUndefined()
})

test('completed and invalid results both precede quota continuation', async () => {
  const f = await fixture()
  for (const result of ['done', 'invalid']) {
    await writeFile(f.request.result.path, JSON.stringify({ schema: 'fixture', run_id: 'run', step_id: 'build:0', kind: 'completed', result }))
    expect(await f.invoke()).toMatchObject({ kind: 'result', outcome: { kind: result === 'done' ? 'completed' : 'unknown' } })
  }
  expect(f.inputs).toHaveLength(0)
})

test('a signed launch cannot override a current parent that did not grant SendMessage', async () => {
  const f = await fixture()
  f.session.toolSurface = 'Agent'
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: 'tool-unavailable' })
  expect(f.inputs).toHaveLength(0)
})

test('ordinary errors and a foreign signed request cannot authorize continuation', async () => {
  const f = await fixture()
  await writeFile(f.childPath, (await readFile(f.childPath, 'utf8')).replace('"apiErrorStatus":429', '"apiErrorStatus":500'))
  expect(await f.invoke()).toEqual({ kind: 'not-eligible' })
  const receipt = structuredClone(f.options.receipt) as { signature: string }
  receipt.signature = 'forged'
  expect(await f.invoke({ ...f.options, receipt })).toEqual({ kind: 'unknown', reason: 'identity-unknown' })
  expect(f.inputs).toHaveLength(0)
})

test('an expired original budget cannot actuate', async () => {
  const f = await fixture()
  expect(await f.invoke({ ...f.options, deadline: Date.now() - 1 })).toMatchObject({ kind: 'unknown' })
  expect(f.inputs).toHaveLength(0)
  expect(f.saved()).toBeUndefined()
})

test('a queued continuation expires and releases when the earlier parent turn drains', async () => {
  const f = await fixture()
  const releaseEarlier = await f.session.acquireTurn()
  expect(await f.invoke({ ...f.options, deadline: Date.now() + 20 })).toEqual({ kind: 'unknown', reason: 'budget-expired' })
  releaseEarlier()
  await Bun.sleep(10)
  expect(f.session.turnSlotHeld).toBe(0)
  expect(f.inputs).toHaveLength(0)
  expect(f.saved()).toBeUndefined()
})
