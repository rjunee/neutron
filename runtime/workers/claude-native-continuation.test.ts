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

async function fixture(profile: 'valid' | 'missing' | 'unavailable' | 'foreign' | 'wrong-digest' | 'wrong-version' | 'adopted' | 'adopted-unavailable' = 'valid',
  witness?: 'legacy' | 'reboot' | 'changed-start') {
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
  const relay = await capacity.register()
  const launch: NativeParentLaunchEvidence = { version: 1, sessionId: profile === 'foreign' ? 'another' : 'parent', childGeneration: 'generation', projectId: 'project',
    relay,
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
  const originalLaunch = structuredClone(readNativeParentLaunchEvidence(session))
  const originalIdentity = readProcessIdentity(process.pid)!
  if (witness === 'legacy' && originalLaunch) delete (originalLaunch as { relay?: unknown }).relay
  if (witness === 'reboot') originalIdentity.boot_id = 'previous-boot'
  if (witness === 'changed-start') originalIdentity.start_ticks++
  authority.record({ kind: 'parent-bound', parent: { sessionId: 'parent', childGeneration: 'generation', pid: process.pid,
    processIdentity: originalIdentity, ...(originalLaunch ? { launch: originalLaunch } : {}) } })
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
    capacity: { acquire: capacity.acquire },
    authority: { lease, current: () => true, read: () => saved, claim: async value => { if (saved !== undefined) return false; saved = value; return true } },
    signal: new AbortController().signal, deadline: Date.now() + 5000,
    decodeTrailer: (bytes, req) => decodeProjectTrailer(bytes, req, { schemas: new Map([['fixture', result => result === 'done']]), metadata: () => undefined }) }
  const invoke = (input = options) => continueClaudeNativeChild(input)
  const recordInvocation = async (to = 'child', decorations: Record<string, unknown> = {}) => {
    const prepared = JSON.parse(saved!)
    await appendFile(transcript, JSON.stringify({ sessionId: 'parent', type: 'assistant', message: { role: 'assistant',
      content: [{ type: 'tool_use', name: 'SendMessage', id: 'exact-tool', input: { ...prepared.args, to, ...decorations } }] } }) + '\n')
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
  f.capacity.setRetryDelay(10)
  const states: string[] = []
  f.options.onQuotaState = async state => {
    states.push(state.kind)
    if (state.kind === 'waiting') {
      expect(f.saved()).toBeUndefined(); expect(f.inputs).toHaveLength(0)
      expect(f.session.turnSlotHeld).toBe(0)
      f.capacity.setMode('available')
    }
  }
  expect(await f.invoke()).toMatchObject({ kind: 'submitted' })
  expect(states).toEqual(['waiting', 'resumed'])
  expect(f.inputs).toHaveLength(1)
  expect(JSON.parse(f.saved()!).capacity.body).toMatchObject({ childId: 'child', capacity: { accountGeneration: 'a'.repeat(64), modelId: f.request.model_id } })
})

test('original result arriving during quota waiting is harvested without another request or input', async () => {
  const f = await fixture(); f.capacity.setMode('all-full')
  f.options.onQuotaState = async state => {
    if (state.kind === 'waiting') await writeFile(f.request.result.path, JSON.stringify({ schema: 'fixture',
      run_id: 'run', step_id: 'build:0', kind: 'completed', result: 'done' }))
  }
  expect(await f.invoke()).toMatchObject({ kind: 'result', outcome: { kind: 'completed' } })
  expect(f.saved()).toBeUndefined(); expect(f.inputs).toHaveLength(0)
  expect(f.capacity.requests.filter(row => row.kind === 'claude-native-observe')).toHaveLength(1)
})

test.each(['deadline', 'cancelled'] as const)('quota waiting is bounded by the original %s and never spends the claim', async mode => {
  const f = await fixture(); f.capacity.setMode('all-full')
  const controller = new AbortController(), states: string[] = []
  f.options.signal = controller.signal; f.options.deadline = Date.now() + 100
  f.options.onQuotaState = async state => { states.push(state.kind); if (mode === 'cancelled' && state.kind === 'waiting') controller.abort() }
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: 'budget-expired' })
  expect(states).toEqual(['waiting', 'ended'])
  expect(f.saved()).toBeUndefined(); expect(f.inputs).toHaveLength(0)
  expect(f.capacity.requests.filter(row => row.kind === 'claude-native-observe')).toHaveLength(1)
})

test('one same-ID continuation persists original receipt, quota and lease before send; a fresh observer never resends', async () => {
  const f = await fixture()
  f.session.child.submitLine = async line => { expect(f.saved()).toBeDefined(); f.inputs.push(line); throw new Error('lost acknowledgement') }
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: 'submission-unknown' })
  const prepared = JSON.parse(f.saved()!)
  expect(prepared).toMatchObject({ agentId: 'child', request: f.request, lease: f.options.authority.lease, quota: { requestId: 'b'.repeat(64) } })
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

test.each(['native', 'wrong-type', 'wrong-recipient', 'wrong-preview', 'wrong-preview-length', 'unknown-field', 'partial'] as const)('pinned native SendMessage decorations reconcile only exact full arguments: %s', async mode => {
  const f = await fixture()
  expect(await f.invoke()).toMatchObject({ kind: 'submitted' })
  const prepared = JSON.parse(f.saved()!)
  const decorations: Record<string, unknown> = { type: 'message', recipient: 'child', content: prepared.args.message.slice(0, 49) + '…' }
  if (mode === 'wrong-type') decorations.type = 'broadcast'
  if (mode === 'wrong-recipient') decorations.recipient = 'another-child'
  if (mode === 'wrong-preview') decorations.content = 'A conflicting message…'
  if (mode === 'wrong-preview-length') decorations.content = prepared.args.message.slice(0, 45) + '…'
  if (mode === 'unknown-field') decorations.unrecognized = true
  if (mode === 'partial') delete decorations.recipient
  await f.recordInvocation('child', decorations)
  expect(await f.invoke()).toEqual(mode === 'native' ? { kind: 'submitted', evidence: 'exact-tool-invocation' }
    : { kind: 'unknown', reason: 'submission-unknown' })
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
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: available ? 'capacity-unavailable' : 'tool-unavailable' })
  await f.invoke()
  expect(f.inputs).toHaveLength(0)
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

test('gateway survivor rechecks registered host scope and current authorization before capacity', async () => {
  const f = await fixture()
  const restored = await f.restore(false)
  restored.authority = { ...restored.authority, current: () => false }
  expect(await f.invoke(restored)).toEqual({ kind: 'unknown', reason: 'capacity-unavailable' })
  restored.authority = f.options.authority
  f.capacity.setMode('unknown')
  expect(await f.invoke(restored)).toEqual({ kind: 'unknown', reason: 'capacity-unavailable' })
  expect(f.inputs).toHaveLength(0)
  expect(f.saved()).toBeUndefined()
})

test.each(['legacy', 'reboot', 'changed-start'] as const)('gateway survivor refuses authenticated but unusable %s witness', async witness => {
  const f = await fixture('valid', witness)
  expect(await f.invoke(await f.restore(false))).toMatchObject({ kind: 'unknown' })
  expect(f.saved()).toBeUndefined(); expect(f.inputs).toHaveLength(0)
})

test.each(['missing', 'tampered'] as const)('gateway survivor requires the original authenticated receipt: %s', async mode => {
  const f = await fixture(), restored = await f.restore(false)
  if (mode === 'missing') restored.receipt = undefined
  else {
    const receipt = JSON.parse(JSON.stringify(restored.receipt))
    receipt.body.parent.launch.relay.scopeToken = 'x'.repeat(43)
    restored.receipt = receipt
  }
  expect(await f.invoke(restored)).toEqual({ kind: 'unknown', reason: 'identity-unknown' })
  expect(f.saved()).toBeUndefined(); expect(f.inputs).toHaveLength(0)
})

test('gateway survivor rechecks authorization after capacity and never refunds a postclaim attempt', async () => {
  const f = await fixture(), restored = await f.restore(false)
  let current = true
  restored.authority = { ...restored.authority, current: () => current }
  restored.capacity = { ...restored.capacity!, acquire: async request => {
    const result = await f.capacity.acquire(request); current = false; return result
  } }
  expect(await f.invoke(restored)).toEqual({ kind: 'unknown', reason: 'capacity-unavailable' })
  expect(f.saved()).toBeUndefined(); expect(f.inputs).toHaveLength(0)
  current = true; restored.capacity = f.options.capacity!
  restored.session.child.submitLine = async line => { f.inputs.push(line); throw Error('lost acknowledgement') }
  expect(await f.invoke(restored)).toEqual({ kind: 'unknown', reason: 'submission-unknown' })
  const again = await f.restore(false)
  expect(await f.invoke(again)).toEqual({ kind: 'unknown', reason: 'submission-unknown' })
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
  f.capacity.setNativeStatus('unknown')
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: 'capacity-unavailable' })
  const receipt = structuredClone(f.options.receipt) as { signature: string }
  receipt.signature = 'forged'
  expect(await f.invoke({ ...f.options, receipt })).toEqual({ kind: 'unknown', reason: 'identity-unknown' })
  expect(f.inputs).toHaveLength(0)
})

test('worker transcript text neither supplies nor overrides authenticated native quota authority', async () => {
  const f = await fixture()
  f.capacity.setNativeStatus('unknown')
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: 'capacity-unavailable' })
  expect(f.saved()).toBeUndefined()
  await writeFile(f.childPath, 'Untrusted worker prose without a request or quota envelope.\n')
  f.capacity.setNativeStatus('all-full')
  expect(await f.invoke()).toEqual({ kind: 'submitted', evidence: 'terminal-acknowledgement' })
  expect(f.inputs).toHaveLength(1)
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
