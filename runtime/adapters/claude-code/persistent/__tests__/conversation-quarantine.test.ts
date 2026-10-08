import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { inspectConversationQuarantine, quarantinePersistentConversation } from '../conversation-quarantine.ts'
import { createPersistentReplSubstrate, poolKeyFor, replayPendingInbound, shutdownAllPersistentRepls } from '../pool.ts'
import { childByKey, committedDispatches, pendingSpawns, pool, supervisedBySessionKey } from '../pool-state.ts'
import { beginBootAdoption, reconcileOwnRepl, resetBootAdoptionForTests } from '../boot-adoption.ts'
import { getOrSpawnSession, injectMessage, resolveResumeDirective } from '../spawn.ts'
import { getRecord, upsertRecord, type ReplRegistryRecord } from '../repl-registry.ts'
import { registerSupervisedSubstrate, respawnReplSession, runReplWatchdogTick } from '../supervision.ts'
import { readStartupRepl, recoverStartupRepl } from '../startup-recovery.ts'
import { drainPendingRespawns } from '../pending-respawn.ts'
import { enqueuePendingRespawn } from '../pending-respawns-queue.ts'
import { liveProjectSessions, readAsleepConversations, resolveLiveProjectSessions } from '../live-project-sessions.ts'
import { lifecycleReplHost } from './lifecycle-repl-host.ts'
import { FakeAdoptableHost } from './boot-adoption-host.ts'
import { findLatestResumableSession } from '../session-disk-recovery.ts'
import { dashifyCwd } from '../session-validation.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'
import type { NativeDispatchParent } from '../../../../workers/claude-native-dispatch-receipt.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { BoundedWorkRequest } from '../../../../bounded-work.ts'
import { ReplSession } from '../repl-session.ts'
import { admitNativeChildWorkspace, retireNativeChildWorkspaceRequest } from '../../../../workers/native-child-workspace.ts'

const dirs: string[] = []
const cleanup: Array<() => void> = []
afterEach(async () => {
  await shutdownAllPersistentRepls()
  for (const close of cleanup.splice(0)) close()
  pool.clear(); childByKey.clear(); supervisedBySessionKey.clear(); pendingSpawns.clear(); committedDispatches.clear()
  resetBootAdoptionForTests()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-quarantine-'))
  dirs.push(dir)
  const denied = new Set<string>()
  const options: PersistentReplSubstrateOptions = {
    substrate_instance_id: `cc-agent-${randomUUID()}`, user_id: 'quarantine-fixture-owner', project_id: 'project',
    conversationProjectId: 'project', credential_identity: 'credential', cwd: dir,
    replRegistryPath: join(dir, 'registry.json'), pendingRespawnsPath: join(dir, 'pending.json'),
    isConversationQuarantined: id => denied.has(id),
    ptyHost: { async spawn() { throw new Error('unexpected synthetic fixture spawn') } },
  }
  const key = poolKeyFor(options)
  const row: ReplRegistryRecord = { sessionKey: key, sessionId: randomUUID(), cwd: dir,
    conversationProjectId: 'project', channelName: `neutron-${'a'.repeat(32)}`, has_session: true,
    pid: 987654, child_generation: 'original-generation' }
  const parent: NativeDispatchParent = { sessionId: row.sessionId, childGeneration: row.child_generation!,
    pid: row.pid!, processIdentity: { boot_id: 'test-boot', start_ticks: 45 } }
  const identity = { identity: () => parent.processIdentity! }
  return { dir, denied, options, key, row, parent, identity }
}

async function drain(handle: SessionHandle) {
  for await (const event of handle.events) if (event.kind === 'error') throw new Error(event.message)
}

for (const hostKind of ['detachable-pane', 'in-process-pty'] as const) {
  test(`quarantine preserves live ${hostKind}, keeps history and routes only fresh input into a fresh conversation`, async () => {
    const f = fixture()
    const transport = lifecycleReplHost()
    const argvs: string[][] = []
    let detaches = 0
    f.options.ptyHost = { async spawn(argv, opts) {
      argvs.push([...argv])
      const child = await transport.host.spawn(argv, opts)
      if (hostKind === 'detachable-pane') {
        child.detach = () => { detaches++ }
        Object.defineProperty(child, 'paneHandle', { value: `pane-${argvs.length}` })
      }
      return child
    } }
    f.options.skipTrustSeed = true
    f.options.idleQuietMs = 0
    f.options.jsonlExistsProbe = () => true
    f.options.captureConfig = { maxAttempts: 1, attemptDelayMs: 1 }
    cleanup.push(() => { for (const c of transport.children) c.child.kill() })
    // Production registers supervision separately; same-key registration can
    // clone options while retaining attested scope, so object identity is not authority.
    registerSupervisedSubstrate({ ...f.options })
    const substrate = createPersistentReplSubstrate(f.options)
    const spec = { prompt: 'original input stays in the original conversation', tools: [], model_preference: ['claude-opus'] }
    await drain(substrate.start(spec))
    const old = await pool.get(f.key)!
    for (let n = 0; n < 100 && (old.activeTurn !== undefined || old.turnSlotHeld || committedDispatches.has(f.key)); n++) await Bun.sleep(5)
    const parent = { ...f.parent, sessionId: old.sessionId, childGeneration: old.childGeneration, pid: old.child.pid }
    const before = getRecord(f.options.replRegistryPath!, f.key)!
    expect(inspectConversationQuarantine(parent, f.options.isConversationQuarantined!, f.identity)).toBe(true)
    old.turnSlotHeld++
    expect(inspectConversationQuarantine(parent, f.options.isConversationQuarantined!, f.identity)).toBe(false)
    old.turnSlotHeld--
    committedDispatches.set(f.key, 1)
    expect(inspectConversationQuarantine(parent, f.options.isConversationQuarantined!, f.identity)).toBe(false)
    committedDispatches.delete(f.key)
    pendingSpawns.set(f.key, pool.get(f.key)!)
    expect(inspectConversationQuarantine(parent, f.options.isConversationQuarantined!, f.identity)).toBe(false)
    pendingSpawns.delete(f.key)
    expect(quarantinePersistentConversation(parent, f.options.isConversationQuarantined!, f.identity)).toBe(false)
    let entered!: () => void
    let release!: () => void
    const measuring = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    // A changed MCP profile would normally evict the original parent. Quarantine
    // must be re-read after configuration I/O, before that destructive branch.
    const warm = getOrSpawnSession(f.key, { ...f.options, enableToolBridge: true,
      resolveExtraMcpServers: async () => { entered(); await held; return [] } }, spec)
    await measuring
    f.denied.add(old.sessionId)
    release()
    await expect(warm).rejects.toThrow('quarantined')
    expect(old.child.hasExited()).toBe(false)
    expect((await resolveLiveProjectSessions(['project'])).live).toEqual([])
    expect((await resolveLiveProjectSessions(['project'], { includeQuarantinedSessionId: old.sessionId })).live.map(row => row.session.sessionId))
      .toEqual([old.sessionId])
    await expect(injectMessage(old, 'forbidden new input', 'never-submitted')).rejects.toThrow('quarantined')
    expect(() => substrate.start({ ...spec, session: { id: old.sessionId, last_active_at: Date.now() } })).toThrow('quarantined')
    expect(quarantinePersistentConversation(parent, f.options.isConversationQuarantined!, f.identity)).toBe(true)
    expect(old.child.hasExited()).toBe(false)
    expect(old.fenced).toBe(true)
    expect(detaches).toBe(hostKind === 'detachable-pane' ? 1 : 0)
    expect(getRecord(f.options.replRegistryPath!, f.key)).toEqual(before)
    expect(quarantinePersistentConversation(parent, f.options.isConversationQuarantined!, f.identity)).toBe(true)
    const freshKey = poolKeyFor(f.options)
    expect(freshKey).not.toBe(f.key)
    expect(poolKeyFor({ ...f.options })).toBe(freshKey)
    await drain(substrate.start({ ...spec, prompt: 'new independent input' }))
    const fresh = await pool.get(freshKey)!
    expect(fresh.sessionId).not.toBe(old.sessionId)
    expect(supervisedBySessionKey.get(freshKey)).toBe(supervisedBySessionKey.get(f.key))
    expect(argvs[1]).not.toContain('--resume')
    expect(argvs[1]![argvs[1]!.indexOf('--session-id') + 1]).toBe(fresh.sessionId)
    expect(transport.children[0]!.prompts).toEqual([spec.prompt])
    expect(transport.children[1]!.prompts).toEqual(['new independent input'])
    expect(transport.children[0]!.child.hasExited()).toBe(false)
    expect(getRecord(f.options.replRegistryPath!, f.key)).toEqual(before)
    expect(liveProjectSessions('project').map(([key]) => key)).toEqual([freshKey])
    const census = await resolveLiveProjectSessions(['project'])
    expect(census.live.map(s => s.session.sessionId)).toEqual([fresh.sessionId])
    expect(census.unresolved).toBe(0)
  }, 15_000)
}

test('restart refuses original adoption, explicit resume and queued replay while preserving row and pending input', async () => {
  const f = fixture()
  upsertRecord(f.options.replRegistryPath!, f.row)
  supervisedBySessionKey.set(f.key, f.options)
  const entry = { sessionKey: f.key, sessionId: f.row.sessionId, cwd: f.dir,
    substrate_instance_id: f.options.substrate_instance_id, droppedInbound: 'must not be replayed' }
  enqueuePendingRespawn(f.options.pendingRespawnsPath!, entry)
  const rowBytes = readFileSync(f.options.replRegistryPath!)
  const queueBytes = readFileSync(f.options.pendingRespawnsPath!)
  expect(resolveResumeDirective(f.key, f.options)?.sessionId).toBe(f.row.sessionId)
  f.denied.add(f.row.sessionId)
  resetBootAdoptionForTests()
  expect(await beginBootAdoption(f.options, f.key)).toMatchObject({ kind: 'undecided', reason: 'conversation permanently quarantined' })
  expect(await reconcileOwnRepl(f.options, f.key)).toMatchObject({ kind: 'undecided', reason: 'conversation permanently quarantined' })
  expect(() => resolveResumeDirective(f.key, f.options)).toThrow('quarantined')
  expect(() => readStartupRepl(f.options, f.key)).toThrow('quarantined')
  expect(await recoverStartupRepl(f.options, f.key, [])).toMatchObject({ status: 'refused' })
  await expect(getOrSpawnSession('other-key', f.options, { tools: [], model_preference: ['model'] }, { sessionId: f.row.sessionId })).rejects.toThrow('quarantined')
  await expect(replayPendingInbound(f.options, entry)).rejects.toThrow('quarantined')
  expect(await drainPendingRespawns(f.options)).toEqual([{ sessionKey: f.key, replayed: false, skipped: 'conversation-quarantined' }])
  expect(respawnReplSession(f.options, f.key, 'admin-endpoint', 'manual', true).ok).toBe(false)
  expect(await runReplWatchdogTick(f.options, { healthProbe: async () => { throw new Error('must not probe old parent') } }))
    .toEqual([{ sessionKey: f.key, action: 'conversation-quarantined', respawned: false }])
  expect(readFileSync(f.options.replRegistryPath!)).toEqual(rowBytes)
  expect(readFileSync(f.options.pendingRespawnsPath!)).toEqual(queueBytes)
  expect(quarantinePersistentConversation(f.parent, f.options.isConversationQuarantined!, f.identity)).toBe(true)
  expect(quarantinePersistentConversation(f.parent, f.options.isConversationQuarantined!, {
    identity: () => ({ boot_id: 'test-boot', start_ticks: 46 }),
  })).toBe(false)
})

test('quarantine committed during asynchronous pane inspection prevents the previously legitimate close', async () => {
  for (const quarantineDuringInspection of [false, true]) {
    const f = fixture()
    const host = new FakeAdoptableHost()
    f.options.ptyHost = host
    f.row.pane_handle = 'test-pane'
    // A native process on the same transcript without our dev-channel normally
    // reaches close-foreign-owner. The positive control proves that exact path.
    host.panes.set('test-pane', { argv: ['claude', '--resume', f.row.sessionId], screens: [], pid: f.row.pid! })
    upsertRecord(f.options.replRegistryPath!, f.row)
    const hold = host.holdInspect()
    const pending = reconcileOwnRepl(f.options, f.key)
    await hold.entered
    if (quarantineDuringInspection) f.denied.add(f.row.sessionId)
    hold.release()
    const result = await pending
    expect(host.closed).toEqual(quarantineDuringInspection ? [] : ['test-pane'])
    expect(result.kind).toBe(quarantineDuringInspection ? 'undecided' : 'closed-foreign-owner')
    if (quarantineDuringInspection) expect(getRecord(f.options.replRegistryPath!, f.key)).toEqual(f.row)
  }
})

test('latest-transcript fallback cannot select quarantined history and still selects unrelated history', () => {
  const f = fixture()
  const projects = join(f.dir, 'transcripts')
  const directory = join(projects, dashifyCwd(f.dir))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `${f.row.sessionId}.jsonl`), '{"synthetic":true}\n')
  expect(findLatestResumableSession(f.dir, projects)).toBe(f.row.sessionId)
  f.denied.add(f.row.sessionId)
  expect(findLatestResumableSession(f.dir, projects, { isConversationQuarantined: f.options.isConversationQuarantined })).toBeNull()
  const other = randomUUID()
  writeFileSync(join(directory, `${other}.jsonl`), '{"synthetic":true}\n')
  expect(findLatestResumableSession(f.dir, projects, { isConversationQuarantined: f.options.isConversationQuarantined })).toBe(other)
  expect(() => findLatestResumableSession(f.dir, projects, {
    isConversationQuarantined: () => { throw new Error('authority unavailable') },
  })).toThrow('authority unavailable')
})

test('unknown authority and unrelated unresolved parent never become an empty census', async () => {
  const f = fixture()
  upsertRecord(f.options.replRegistryPath!, f.row)
  supervisedBySessionKey.set(f.key, f.options)
  expect((await resolveLiveProjectSessions(['project'])).unresolved).toBe(1)
  f.denied.add(f.row.sessionId)
  expect((await resolveLiveProjectSessions(['project'])).unresolved).toBe(0)
  supervisedBySessionKey.set('unrelated-unresolved', f.options)
  expect((await resolveLiveProjectSessions(['project'])).unresolved).toBe(1)
  f.options.isConversationQuarantined = () => { throw new Error('authority unavailable') }
  expect(() => poolKeyFor(f.options)).toThrow('authority unavailable')
  await expect(resolveLiveProjectSessions(['project'])).rejects.toThrow('authority unavailable')
  expect(quarantinePersistentConversation(f.parent, f.options.isConversationQuarantined, f.identity)).toBe(false)
  writeFileSync(f.options.replRegistryPath!, '{invalid')
  expect(() => poolKeyFor(f.options)).toThrow('registry unavailable')
})

test('asleep history is readable but excluded from automatic wake only after durable quarantine', () => {
  const f = fixture()
  const { pid: _pid, ...asleep } = f.row
  upsertRecord(f.options.replRegistryPath!, { ...asleep, asleep_at: 123 })
  expect(readAsleepConversations(f.options.replRegistryPath!, 'project', f.options.isConversationQuarantined))
    .toMatchObject({ rows: [{ sessionId: f.row.sessionId }] })
  f.denied.add(f.row.sessionId)
  expect(readAsleepConversations(f.options.replRegistryPath!, 'project', f.options.isConversationQuarantined))
    .toEqual({ kind: 'answered', rows: [] })
  expect(getRecord(f.options.replRegistryPath!, f.key)?.sessionId).toBe(f.row.sessionId)
})

test('preparation accounts for only its exact retained workspace; detach waits for authority drain', async () => {
  const f = fixture()
  upsertRecord(f.options.replRegistryPath!, f.row)
  const session = new ReplSession(f.key, f.parent.childGeneration, f.parent.sessionId, f.row.channelName, f.dir)
  session.isConversationQuarantined = f.options.isConversationQuarantined
  let kills = 0
  let dead = false
  let finish!: (code: null) => void
  const child = { pid: f.parent.pid, hasExited: () => dead, write() {}, kill() { kills++; dead = true; finish(null) },
    exited: new Promise<null>(resolve => { finish = resolve }) }
  session.attachChild(child)
  session.pooledAs = Promise.resolve(session)
  pool.set(f.key, session.pooledAs); childByKey.set(f.key, child); supervisedBySessionKey.set(f.key, f.options)
  const request: BoundedWorkRequest = { run_id: 'original-run', step_id: 'plan', role: 'plan', model_id: 'model', effort: 'high',
    cwd: f.dir, writable: true, network: false, tools: 'edit',
    brief: { path: join(f.dir, 'brief'), integrity: 'digest' }, result: { path: join(f.dir, 'result'), schema: 'fixture-result' },
    thread: null, budget: { wall_ms: 1000 }, needs_approval_decision: false }
  const other = { ...request, run_id: 'other-run' }
  const common = join(f.dir, 'git-common'), directory = join(common, 'linked')
  mkdirSync(directory, { recursive: true })
  const workspace = async (request: BoundedWorkRequest) => admitNativeChildWorkspace({ session, request,
    runId: request.run_id, worktree: request.cwd, branch: 'work', generation: 0,
    pending: () => [request, other].map(r => ({ runId: r.run_id, stepId: r.step_id, generation: 0 })),
    git: async args => args[0] === 'symbolic-ref' ? 'refs/heads/work' : args.includes('--show-toplevel') ? f.dir
      : args.includes('--absolute-git-dir') ? directory : common })
  const own = await workspace(request)
  const releaseOwn = await session.acquireTurn(undefined, own)
  releaseOwn() // Original dispatch ended ambiguously; its busy slot remains held.
  expect(session.turnSlotHeld).toBe(1)
  expect(inspectConversationQuarantine(f.parent, f.options.isConversationQuarantined!, f.identity)).toBe(false)
  expect(inspectConversationQuarantine(f.parent, f.options.isConversationQuarantined!, { ...f.identity, request })).toBe(true)
  expect(inspectConversationQuarantine(f.parent, f.options.isConversationQuarantined!, { ...f.identity, request: other })).toBe(false)
  const ordinaryRelease = await session.acquireTurn()
  expect(inspectConversationQuarantine(f.parent, f.options.isConversationQuarantined!, { ...f.identity, request })).toBe(false)
  ordinaryRelease()
  f.denied.add(f.parent.sessionId)
  await expect(session.acquireTurn()).rejects.toThrow('quarantined')
  await expect(session.acquireContinuationTurn(own)).rejects.toThrow('quarantined')
  expect(quarantinePersistentConversation(f.parent, f.options.isConversationQuarantined!, f.identity)).toBe(false)
  expect(kills).toBe(0)
  retireNativeChildWorkspaceRequest(session, request)
  await Promise.resolve()
  expect(session.turnSlotHeld).toBe(0)
  expect(quarantinePersistentConversation(f.parent, f.options.isConversationQuarantined!, f.identity)).toBe(true)
  expect(kills).toBe(0)
})
