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
import { admitNativeChildWorkspace, bindNativeChildWorkspace, completeNativeChildWorkspace, independentNativeChildContinuation } from './native-child-workspace.ts'
import { reserveTrailerSlot } from './trailer-slot.ts'
import { CLAUDE_CONTINUATION_PROFILE, continueClaudeNativeChild, type ClaudeContinuationOptions } from './claude-native-continuation.ts'
import { decodeProjectTrailer } from './project-runners.ts'
import { capacityFixture } from './claude-capacity-client.test-support.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

async function fixture(profile: 'valid' | 'missing' | 'unavailable' | 'foreign' | 'wrong-digest' | 'wrong-version' | 'adopted' | 'adopted-unavailable' = 'valid',
  witness?: 'legacy' | 'reboot' | 'changed-start' | 'missing-budget' | 'expired-budget') {
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
  const pending = [{ runId: 'run', stepId: 'build:0', generation: 0 }]
  const admit = (session: ReplSession) => admitNativeChildWorkspace({ session, request, runId: 'run', worktree: cwd, branch: 'work', generation: 0,
    pending: () => pending,
    git: async args => args[0] === 'symbolic-ref' ? 'refs/heads/work' : args.includes('--show-toplevel') ? cwd : args.includes('--absolute-git-dir') ? gitDir : common })
  const workspace = await admit(session)
  cleanup.push(async () => completeNativeChildWorkspace(workspace))
  const signer = createNativeDispatchSigner()
  const lease: NativeDispatchLease = { scope: { ownerHandle: 'owner', projectId: 'project' }, generation: 0, token: 'lease',
    reason: 'liveChild', producer: `native-child:boot:${signer.keyDigest}`, workRef: JSON.stringify(['run', 'build:0']) }
  const authority = signer.begin(lease, request, witness === 'missing-budget' ? undefined
    : witness === 'expired-budget' ? Date.now() - 1 : Date.now() + request.budget.wall_ms)
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
  const claims = new Map<string, string>()
  const options: ClaudeContinuationOptions = { request, receipt, stateDir, session, workspace, projectsDir,
    capacity: { acquire: capacity.acquire, control: capacity.control },
    authority: { lease, current: () => true, read: () => saved, claim: async (episode, value) => { if (claims.has(episode)) return false; claims.set(episode, value); saved = value; return true } },
    signal: new AbortController().signal, deadline: Date.now() + 5000,
    decodeTrailer: (bytes, req) => decodeProjectTrailer(bytes, req, { schemas: new Map([['fixture', result => result === 'done']]), metadata: () => undefined }) }
  const invoke = (input = options) => continueClaudeNativeChild(input)
  const recordInvocation = async (to = 'child', decorations: Record<string, unknown> = {}, toolUseId = 'exact-tool') => {
    const prepared = JSON.parse(saved!)
    await appendFile(transcript, JSON.stringify({ sessionId: 'parent', type: 'assistant', message: { role: 'assistant',
      content: [{ type: 'tool_use', name: 'SendMessage', id: toolUseId, input: { ...prepared.args, to, ...decorations } }] } }) + '\n')
    const result = { success: true, resumedAgentId: to }
    await appendFile(transcript, JSON.stringify({ sessionId: 'parent', type: 'user', toolUseResult: result, message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: JSON.stringify(result) }] }] } }) + '\n')
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
  const addPeer = async (input = options, conflict = false) => {
    const peerCwd = conflict ? cwd : join(dir, 'peer'), peerGit = conflict ? gitDir : join(common, 'peer')
    await Promise.all([peerCwd, peerGit].map(path => mkdir(path, { recursive: true })))
    const peerRequest = { ...request, run_id: 'peer', step_id: 'build:peer', cwd: peerCwd,
      result: { ...request.result, path: join(stateDir, 'peer.result') } }
    pending.push({ runId: 'peer', stepId: 'build:peer', generation: 0 })
    const workspace = await admitNativeChildWorkspace({ session: input.session, request: peerRequest,
      runId: 'peer', worktree: peerCwd, branch: conflict ? 'work' : 'peer', generation: 0, pending: () => pending,
      git: async args => args[0] === 'symbolic-ref' ? `refs/heads/${conflict ? 'work' : 'peer'}`
        : args.includes('--show-toplevel') ? peerCwd : args.includes('--absolute-git-dir') ? peerGit : common })
    let yieldDispatch!: () => void
    await input.session.acquireTurn(yieldSlot => { yieldDispatch = yieldSlot }, workspace)
    bindNativeChildWorkspace(workspace)
    yieldDispatch()
    const complete = () => { pending.splice(pending.findIndex(row => row.runId === 'peer'), 1); completeNativeChildWorkspace(workspace) }
    cleanup.push(async () => { completeNativeChildWorkspace(workspace) })
    return { workspace, complete }
  }
  return { options, session, request, inputs, invoke, restore, addPeer, childPath, transcript, recordInvocation, capacity, claims, saved: () => saved }
}

test('verified reconstructed continuation reaches signed capacity and original input while its compatible peer stays live', async () => {
  const f = await fixture(), restored = await f.restore(), peer = await f.addPeer(restored)
  expect(independentNativeChildContinuation(restored.workspace, peer.workspace)).toBe(false)
  expect(await f.invoke({ ...restored, deadline: Date.now() + 1000 })).toMatchObject({ kind: 'submitted' })
  expect(independentNativeChildContinuation(restored.workspace, peer.workspace)).toBe(true)
  expect(f.inputs).toHaveLength(1)
  expect(f.claims.size).toBe(1)
  expect(restored.session.turnSlotHeld).toBe(1)
  await f.recordInvocation()
  expect(await f.invoke(restored)).toMatchObject({ kind: 'submitted', evidence: 'exact-tool-invocation' })
  expect(f.inputs).toHaveLength(1)
  expect(restored.session.turnSlotHeld).toBe(1)
  peer.complete()
  await Promise.resolve()
  expect(restored.session.turnSlotHeld).toBe(0)
})

test.each(['forged-receipt', 'stale-authority'] as const)('reconstructed %s cannot bind a continuation or bypass its peer', async mode => {
  const f = await fixture(), restored = await f.restore(), peer = await f.addPeer(restored)
  const options = mode === 'forged-receipt' ? { ...restored, receipt: { ...structuredClone(restored.receipt as object), signature: 'forged' } }
    : { ...restored, authority: { ...restored.authority, current: () => false } }
  expect(await f.invoke(options)).toEqual({ kind: 'unknown', reason: mode === 'forged-receipt' ? 'identity-unknown' : 'capacity-unavailable' })
  expect(independentNativeChildContinuation(restored.workspace, peer.workspace)).toBe(false)
  expect(f.inputs).toHaveLength(0)
  expect(f.saved()).toBeUndefined()
  expect(f.capacity.requests.filter(row => row.kind !== 'claude-native-register')).toHaveLength(0)
  expect(restored.session.turnSlotHeld).toBe(1)
})

test('cancellation while the signed consumer waits for a conflicting peer removes only its queued turn', async () => {
  const f = await fixture(), restored = await f.restore(), peer = await f.addPeer(restored, true), cancelled = new AbortController()
  const result = f.invoke({ ...restored, signal: cancelled.signal })
  const until = Date.now() + 1000
  while (restored.session.turnSlotHeld !== 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 1))
  expect(restored.session.turnSlotHeld).toBe(2)
  cancelled.abort()
  expect(await result).toEqual({ kind: 'unknown', reason: 'budget-expired' })
  expect(restored.session.turnSlotHeld).toBe(1)
  expect(f.saved()).toBeUndefined()
  expect(f.capacity.requests.filter(row => row.kind !== 'claude-native-register')).toHaveLength(0)
  peer.complete()
  await Promise.resolve()
  expect(restored.session.turnSlotHeld).toBe(0)
  expect(f.inputs).toHaveLength(0)
})

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
  expect(states).toEqual(['waiting'])
  await f.recordInvocation()
  expect(await f.invoke()).toMatchObject({ kind: 'submitted', evidence: 'exact-tool-invocation' })
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

test('two authenticated quota episodes retain one lease, two immutable claims and the original deadline', async () => {
  const f = await fixture()
  const states: string[] = []
  f.options.onQuotaState = async state => { states.push(state.kind); if (state.kind === 'waiting') f.capacity.setMode('available') }
  f.capacity.setRetryDelay(1)
  f.capacity.setMode('all-full')
  expect(await f.invoke()).toMatchObject({ kind: 'submitted', evidence: 'terminal-acknowledgement' })
  const original = f.saved()!, first = JSON.parse(original)
  expect(f.capacity.requests.find(row => row.kind === 'claude-native-prepare-continuation')).toMatchObject({
    episodeId: first.intent.episodeId, intentId: first.nonce, hostMessage: first.args.message })
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: 'submission-unknown' })
  await f.recordInvocation('child', {}, 'first-tool')
  f.capacity.advanceEpisode('first-tool', first.nonce)
  f.capacity.setMode('all-full')
  expect(await f.invoke({ ...f.options, deadline: Date.now() + 60_000 })).toMatchObject({ kind: 'submitted' })
  const second = JSON.parse(f.saved()!)
  expect(second.intent.deadlineMs).toBe(first.intent.deadlineMs)
  expect(second.intent.episodeId).not.toBe(first.intent.episodeId)
  expect(second.lease).toEqual(first.lease)
  expect(f.claims.get(first.intent.episodeId)).toBe(original)
  expect(f.claims.size).toBe(2)
  expect(states.filter(state => state === 'waiting')).toHaveLength(2)
  expect(states.at(-1)).toBe('waiting')
  await f.recordInvocation('child', {}, 'second-tool')
  expect(await f.invoke()).toMatchObject({ kind: 'submitted', evidence: 'exact-tool-invocation' })
  expect(states.at(-1)).toBe('resumed')
  expect(f.inputs).toHaveLength(2)
  await writeFile(f.request.result.path, JSON.stringify({ schema: 'fixture', run_id: 'run', step_id: 'build:0', kind: 'completed', result: 'done' }))
  expect(await f.invoke()).toMatchObject({ kind: 'result', outcome: { kind: 'completed' } })
})

test.each(['missing', 'wrong-link', 'failed', 'wrong-child', 'wrong-session'] as const)('native promotion requires linked successful tool result: %s', async mode => {
  const f = await fixture()
  await f.invoke()
  const saved = JSON.parse(f.saved()!)
  const result = { success: mode !== 'failed', resumedAgentId: mode === 'wrong-child' ? 'foreign' : 'child' }
  await appendFile(f.transcript, JSON.stringify({ sessionId: 'parent', type: 'assistant', message: { role: 'assistant',
    content: [{ type: 'tool_use', name: 'SendMessage', id: 'tool', input: saved.args }] } }) + '\n')
  if (mode !== 'missing') await appendFile(f.transcript, JSON.stringify({ sessionId: mode === 'wrong-session' ? 'foreign' : 'parent', type: 'user',
    toolUseResult: result, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: mode === 'wrong-link' ? 'foreign' : 'tool',
      content: [{ type: 'text', text: JSON.stringify(result) }] }] } }) + '\n')
  expect(await f.invoke()).toEqual({ kind: 'unknown', reason: 'submission-unknown' })
  expect(f.capacity.requests.filter(row => row.kind === 'claude-native-promote-continuation')).toHaveLength(0)
  expect(f.inputs).toHaveLength(1)
})

test('a restarted pending intent promotes only after exact reconciliation and never re-prepares or resends', async () => {
  const f = await fixture()
  f.session.child.submitLine = async line => { f.inputs.push(line); throw Error('lost acknowledgement') }
  await f.invoke()
  await f.recordInvocation()
  const restarted = await f.restore(false)
  expect(await f.invoke(restarted)).toMatchObject({ kind: 'submitted', evidence: 'exact-tool-invocation' })
  expect(f.capacity.requests.filter(row => row.kind === 'claude-native-prepare-continuation')).toHaveLength(1)
  expect(f.capacity.requests.filter(row => row.kind === 'claude-native-promote-continuation')).toHaveLength(1)
  expect(f.inputs).toHaveLength(1)
})

test('promotion rechecks current original authorization and the persisted original deadline', async () => {
  const f = await fixture()
  await f.invoke(); await f.recordInvocation()
  const before = f.capacity.requests.length
  expect(await f.invoke({ ...f.options, authority: { ...f.options.authority, current: () => false } })).toMatchObject({ kind: 'unknown' })
  expect(await f.invoke({ ...f.options, deadline: Date.now() - 1 })).toMatchObject({ kind: 'unknown' })
  expect(f.capacity.requests).toHaveLength(before)
  expect(f.inputs).toHaveLength(1)
})

test.each(['foreign-predecessor', 'foreign-intent', 'late-old-episode'] as const)('new signed quota cannot overwrite verified episode lineage: %s', async mode => {
  const f = await fixture()
  await f.invoke(); await f.recordInvocation('child', {}, 'first-tool')
  const first = JSON.parse(f.saved()!)
  f.capacity.advanceEpisode(mode === 'foreign-predecessor' ? 'foreign-tool' : 'first-tool', mode === 'foreign-intent' ? 'foreign-intent' : first.nonce)
  if (mode === 'late-old-episode') {
    await f.invoke(); await f.recordInvocation('child', {}, 'second-tool')
    // An authenticated but delayed predecessor observation is not the newest
    // logical child turn and cannot spend another continuation opportunity.
    f.capacity.advanceEpisode(null, null)
  }
  const saved = f.saved(), count = f.inputs.length
  expect(await f.invoke()).toMatchObject({ kind: 'unknown', reason: 'identity-unknown' })
  expect(f.saved()).toBe(saved)
  expect(f.inputs).toHaveLength(count)
})

test('a retry with changed body metadata in the same authenticated episode never spends a successor', async () => {
  const f = await fixture()
  await f.invoke(); await f.recordInvocation()
  const original = f.saved()
  f.capacity.setBodyDigest('d'.repeat(64))
  expect(await f.invoke()).toMatchObject({ kind: 'submitted', evidence: 'exact-tool-invocation' })
  expect(f.saved()).toBe(original)
  expect(f.claims.size).toBe(1)
  expect(f.inputs).toHaveLength(1)
})

test.each(['missing-budget', 'expired-budget'] as const)('restart before its first claim cannot extend an original %s, but can harvest its result', async budget => {
  const f = await fixture('valid', budget)
  const restarted = await f.restore(false)
  expect(await f.invoke({ ...restarted, deadline: Date.now() + 60_000 })).toEqual({ kind: 'unknown', reason: 'budget-expired' })
  expect(f.saved()).toBeUndefined()
  expect(f.capacity.requests.filter(row => row.kind !== 'claude-native-register')).toHaveLength(0)
  expect(f.inputs).toHaveLength(0)
  await writeFile(f.request.result.path, JSON.stringify({ schema: 'fixture', run_id: 'run', step_id: 'build:0', kind: 'completed', result: 'done' }))
  expect(await f.invoke(restarted)).toMatchObject({ kind: 'result', outcome: { kind: 'completed' } })
})

test.each(['active', 'restart'] as const)('work cancellation after acknowledgement tombstones the newest intent without refunding its claim: %s', async mode => {
  const f = await fixture(), cancelled = new AbortController()
  if (mode === 'active') f.options.signal = cancelled.signal
  expect(await f.invoke()).toMatchObject({ kind: 'submitted', evidence: 'terminal-acknowledgement' })
  const saved = f.saved()!, preparation = JSON.parse(saved)
  cancelled.abort()
  if (mode === 'restart') await f.invoke({ ...await f.restore(false), signal: cancelled.signal })
  const until = Date.now() + 1000
  while (!f.capacity.requests.some(row => row.kind === 'claude-native-cancel-continuation') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
  expect(f.capacity.requests.find(row => row.kind === 'claude-native-cancel-continuation')).toMatchObject(preparation.intent)
  expect(f.saved()).toBe(saved)
  expect(f.claims.size).toBe(1)
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
