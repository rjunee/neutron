import { afterEach, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { createClaudeNativeDispatchReceipt, nativeDispatchReceiptPath, readClaudeNativeDispatchReceipt } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import { plannerRetirementDigest as hash } from '@neutronai/runtime/workers/planner-authority-retirement.ts'
import type { NeverAdmittedPlannerPreparation, NeverAdmittedPlannerRetirement, NativeConversationQuarantined } from '@neutronai/runtime/workers/never-admitted-planner-retirement.ts'
import type { NativeHostRecoveryAuthority, SignedHostEvidence } from '@neutronai/runtime/workers/native-host-termination.ts'
import { createAdminRespawnSurface } from '@neutronai/gateway/http/admin-respawn-surface.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { seedProject } from '@neutronai/gateway/wiring/__tests__/project-admission-fixture.ts'
import { prepareNeverAdmittedPlanner, retireNeverAdmittedPlanner } from '../never-admitted-planner-retirement.ts'
import { reconcileClaudeNativeDispatches } from '../claude-native-dispatch-reconcile.ts'

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function signer() {
  const pair = generateKeyPairSync('ed25519')
  return { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    signed: <T>(body: T): SignedHostEvidence<T> => ({ body, signature: sign(null, Buffer.from(JSON.stringify(body)), pair.privateKey).toString('base64') }) }
}
async function fixture(change: Partial<BoundedWorkRequest> = {}, phase: 'submission-started' | 'parent-bound' | 'child-bound' = 'submission-started') {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-quarantine-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'project.db'); seedMigratedDb(path)
  const db = ProjectDb.open(path); cleanup.push(() => db.close()); seedProject(db, 'project'); seedProject(db, 'other')
  const runs = new TridentRunStore(db), attempts = new TridentAttemptLedger(db)
  const run = await runs.create({ slug: 'stuck', project_slug: 'project', repo_path: join(dir, 'missing'), task: 'Specified task' })
  await runs.update(run.id, { phase: 'failed' })
  const stateRoot = join(dir, 'builds'), state = join(stateRoot, run.id); await mkdir(state, { recursive: true })
  const request: BoundedWorkRequest = { run_id: run.id, step_id: `${run.id}:plan:0`, role: 'plan', model_id: 'model', effort: null,
    cwd: join(dir, 'missing'), writable: true, network: false, tools: 'edit', brief: { path: join(state, 'brief'), integrity: 'original' },
    result: { path: join(state, 'result'), schema: 'project-plan-v2' }, thread: null, budget: { wall_ms: 100 }, needs_approval_decision: false, ...change }
  const key = { run_id: run.id, step_id: request.step_id, attempt_id: 'dispatch' }
  await attempts.admit({ ...key, phase: 'decomposition', task_id: 'task', head_sha: 'a'.repeat(40), role: request.role, review_seat: null,
    provider: 'anthropic', requested_model: 'model', resolved_model: 'model', placement: 'in-repl', queued_at: 1 })
  await attempts.lifecycle(key, { prepared_at: 2, started_at: 3, ended_at: 4, outcome: 'unknown' })
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'original-gateway' }), port = admission.forNativeChild('project')
  const admitted = await port.admit(run.id, request.step_id); if (admitted.status !== 'admitted') throw Error('fixture admission')
  const root = signer(), capacity = signer(), scopeToken = randomBytes(32).toString('base64url'), sessionId = randomUUID()
  const registration = capacity.signed({ version: 2 as const, kind: 'claude-native-registered' as const, hostId: 'host', instanceId: 'install', bootId: 'kernel',
    parentSessionId: sessionId, parentPid: process.pid, parentStartTicks: 1, challenge: 'original-challenge', scopeDigest: createHash('sha256').update(scopeToken).digest('hex') })
  const parent = { sessionId, childGeneration: 'generation', pid: process.pid, processIdentity: { boot_id: 'kernel', start_ticks: 1 },
    launch: { version: 1 as const, sessionId, childGeneration: 'generation', projectId: 'project', executable: { realPath: '/bin/native', sha256: 'a'.repeat(64), version: '1.0.0' },
      argv: ['/bin/native', '--resume', sessionId], tools: ['Agent'], relay: { scopeToken, registration } } }
  const writer = createClaudeNativeDispatchReceipt(state, request, port.dispatchAuthority!(admitted.lease, request, 100))
  writer.record({ kind: 'parent-bound', parent });
  if (phase !== 'parent-bound') writer.record({ kind: 'submission-started' });
  if (phase === 'child-bound') writer.record({ kind: 'child-bound', nativeAgentId: 'observed-child' });
  writer.close(); port.finishPreparing!(admitted.lease)
  const lease = admission.listLeases('liveChild')[0]!, operationId = randomUUID()
  const preparationBody: NeverAdmittedPlannerPreparation = { version: 1, kind: 'planner-conversation-quarantine-preparation', policy: 'never-admitted-conversation-v1',
    operationId, hostId: 'host', instanceId: 'install', bootId: 'kernel', evidenceDigest: 'a'.repeat(64), lease: { ...lease, reason: 'liveChild' },
    requestDigest: hash(request), dispatchDigest: hash(readClaudeNativeDispatchReceipt(state, request)), parent, nativeAgentId: null, conversationLeases: [],
    observation: { producer: 'operator', observedAt: Date.now(), consumedInputDigest: 'b'.repeat(64), relaySourceDigest: 'c'.repeat(64),
      originalExecutor: { pid: process.pid + 1000000, bootId: 'kernel', death: 'observed', evidenceDigest: 'd'.repeat(64) } } }
  const preparation = root.signed(preparationBody)
  const proof: NativeConversationQuarantined = { version: 1, kind: 'claude-native-conversation-quarantined', operationId, hostId: 'host', instanceId: 'install', bootId: 'kernel',
    parentSessionId: sessionId, originalScopeDigest: registration.body.scopeDigest, parentPid: parent.pid, parentStartTicks: 1, quarantinedAt: Date.now(),
    admissionCount: 0, historyComplete: true, relayDrained: true, historyDigest: 'e'.repeat(64), sourceDigest: 'c'.repeat(64), routingDigest: hash(registration) }
  const body: NeverAdmittedPlannerRetirement = { ...preparationBody, kind: 'planner-authority-retired', preparation,
    observation: { ...preparationBody.observation, observedAt: Date.now() }, quarantine: capacity.signed(proof) }
  let liveStatus = true, wrongChallenge = false, lifecycleAllowed = true, quarantines = 0
  const socketPath = join(dir, 'capacity.sock')
  const server = createServer(socket => socket.once('data', bytes => {
    const q = JSON.parse(bytes.toString()); socket.end(JSON.stringify(capacity.signed({ version: 1, kind: 'claude-native-conversation-quarantine-status',
      hostId: 'host', instanceId: 'install', challenge: wrongChallenge ? 'wrong' : q.challenge, operationId, parentSessionId: sessionId,
      originalScopeDigest: registration.body.scopeDigest, quarantineDigest: hash(proof), effective: liveStatus })) + '\n')
  }))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const authority: NativeHostRecoveryAuthority = { publicKey: root.publicKey, hostId: 'host', instanceId: 'install',
    async attestBoot(challenge) { return root.signed({ version: 1, kind: 'host-boot', hostId: 'host', instanceId: 'install', bootId: 'kernel', challenge }) } }
  const options = { authority, capacityPin: { version: 1 as const, publicKey: capacity.publicKey, hostId: 'host', instanceId: 'install', socketPath, claudeConfigDir: dir },
    stateRoot, admission, runs, attempts, projectIdForRun: (value: { project_slug: string }) => value.project_slug, listProjectIds: () => ['project', 'other'],
    kernelBootId: () => 'kernel', inspectConversation: () => lifecycleAllowed,
    quarantineConversation: () => { quarantines++; return lifecycleAllowed } }
  return { dir, db, runs, attempts, run, key, state, request, lease, root, capacity, preparation, body, options, admission,
    status(value: boolean) { liveStatus = value }, badChallenge() { wrongChallenge = true }, busy() { lifecycleAllowed = false }, quarantines: () => quarantines }
}

test('real authenticated surface prepares then consumes exact authority with fresh capacity proof; preserves history and other scope', async () => {
  const f = await fixture(), before = f.runs.get(f.run.id), attempt = f.attempts.get(f.key)
  const journal = await readFile(nativeDispatchReceiptPath(f.state, f.request), 'utf8')
  await f.admission.forNativeChild('other').admit('other-run', 'plan')
  const sibling = f.admission.listLeases().find(row => row.scope.projectId === 'other')!
  const surface = createAdminRespawnSurface({ gatewayToken: 'owner-test', respawn: () => { throw Error('No process action permitted') },
    preparePlannerConversationQuarantine: raw => prepareNeverAdmittedPlanner(f.options, raw),
    retirePlannerAuthority: raw => retireNeverAdmittedPlanner(f.options, raw), rateLimit: { windowMs: 60000, maxRequests: 20 } })
  const call = (path: string, value: unknown, authenticated = true) => surface.handler(new Request(`http://fixture/admin/${path}`, {
    method: 'POST', headers: authenticated ? { 'X-Gateway-Token': 'owner-test' } : {}, body: JSON.stringify(value) }))
  expect((await call('prepare-planner-conversation-quarantine', f.preparation, false))!.status).toBe(403)
  expect(await retireNeverAdmittedPlanner(f.options, f.root.signed(f.body))).toEqual({ status: 'refused' })
  expect(await (await call('prepare-planner-conversation-quarantine', f.preparation))!.json()).toEqual({ status: 'prepared' })
  expect(f.admission.maintenance.isConversationQuarantined(f.body.parent.sessionId)).toBe(true)
  expect((await f.admission.forDispatch('project', 'work-board').admit('new-run')).status).toBe('fenced')
  expect(f.admission.listLeases()).toContainEqual(f.lease)
  expect(await (await call('retire-planner-authority', f.root.signed(f.body)))!.json()).toEqual({ status: 'released' })
  expect(f.admission.listLeases()).toEqual([sibling]); expect(f.runs.get(f.run.id)).toEqual(before); expect(f.attempts.get(f.key)).toEqual(attempt)
  expect(await readFile(nativeDispatchReceiptPath(f.state, f.request), 'utf8')).toBe(journal)
  expect(f.admission.maintenance.inspect(f.lease.scope)?.phase).toBe('open')
  expect(f.quarantines()).toBe(1)
  expect(await retireNeverAdmittedPlanner(f.options, f.root.signed(f.body))).toEqual({ status: 'already-retired' })
  const restarted = new ProjectAdmission({ db: f.db, ownerHandle: 'owner', bootId: 'new-gateway' })
  expect(restarted.maintenance.isConversationQuarantined(f.body.parent.sessionId)).toBe(true)
  expect((await restarted.forNativeChild('project').admit(f.run.id, f.request.step_id)).status).toBe('fenced')
  expect((await restarted.forDispatch('project', 'work-board').admit('fresh-run')).status).toBe('admitted')
})

test.each(['root-signature', 'capacity-signature', 'admission', 'history', 'relay-drain', 'scope', 'parent', 'registration', 'source', 'request', 'lease', 'preparation'] as const)(
  'refuses changed or missing %s authority with exact lease held', async change => {
    const f = await fixture(); expect(await prepareNeverAdmittedPlanner(f.options, f.preparation)).toEqual({ status: 'prepared' })
    const body = structuredClone(f.body)
    if (change === 'admission') (body.quarantine.body as { admissionCount: number }).admissionCount = 1
    if (change === 'history') (body.quarantine.body as { historyComplete: boolean }).historyComplete = false
    if (change === 'relay-drain') (body.quarantine.body as { relayDrained: boolean }).relayDrained = false
    if (change === 'scope') body.quarantine.body.originalScopeDigest = '0'.repeat(64)
    if (change === 'parent') body.parent.pid++
    if (change === 'registration') body.parent.launch!.relay!.registration.signature = 'invalid'
    if (change === 'source') body.quarantine.body.sourceDigest = '0'.repeat(64)
    if (change === 'request') body.requestDigest = '0'.repeat(64)
    if (change === 'lease') body.lease.token = 'other'
    if (change === 'preparation') body.preparation.body.operationId = randomUUID()
    body.quarantine = f.capacity.signed(body.quarantine.body)
    if (change === 'capacity-signature') body.quarantine.signature = 'invalid'
    const envelope = f.root.signed(body); if (change === 'root-signature') envelope.signature = 'invalid'
    expect(await retireNeverAdmittedPlanner(f.options, envelope)).toEqual({ status: 'refused' })
    expect(f.admission.listLeases()).toEqual([f.lease]); expect(f.quarantines()).toBe(0)
  })

test.each(['unrelated-lease', 'busy-parent', 'live-workflow', 'current-executor', 'host-preparation'] as const)('preparation refuses %s before fencing', async change => {
  const f = await fixture(), body = structuredClone(f.preparation.body)
  if (change === 'unrelated-lease') await f.admission.forNativeChild('project').admit('other-run', 'plan')
  if (change === 'busy-parent') f.busy()
  if (change === 'live-workflow') await f.runs.update(f.run.id, { phase: 'task-plan' })
  if (change === 'current-executor') body.observation.originalExecutor.pid = process.pid
  if (change === 'host-preparation') expect(await f.admission.maintenance.prepareHostTermination('host-operation', f.lease, 'original', () => true)).toBe(true)
  expect(await prepareNeverAdmittedPlanner(f.options, f.root.signed(body))).toEqual({ status: 'refused' })
  expect(f.admission.maintenance.isConversationQuarantined(body.parent.sessionId)).toBe(false)
  expect(f.admission.listLeases()).toContainEqual(f.lease)
})

test.each(['unavailable', 'challenge'] as const)('fresh capacity status %s refuses consumption', async change => {
  const f = await fixture(); expect(await prepareNeverAdmittedPlanner(f.options, f.preparation)).toEqual({ status: 'prepared' })
  if (change === 'unavailable') f.status(false); else f.badChallenge()
  expect(await retireNeverAdmittedPlanner(f.options, f.root.signed(f.body))).toEqual({ status: 'refused' })
  expect(f.admission.listLeases()).toEqual([f.lease]); expect(f.quarantines()).toBe(0)
})

test('delayed accepted operation keeps exact lease and durable fences until drain; automatic unknown reconciliation cannot release', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), draining = new Promise<void>(resolve => { entered = resolve })
  const preparing = prepareNeverAdmittedPlanner({ ...f.options, drain: async () => { entered(); await held } }, f.preparation)
  await draining
  expect(f.admission.maintenance.isConversationQuarantined(f.body.parent.sessionId)).toBe(true)
  expect(f.admission.listLeases()).toEqual([f.lease])
  expect((await f.admission.forNativeChild('project').admit(f.run.id, f.request.step_id)).status).toBe('fenced')
  expect(await reconcileClaudeNativeDispatches(f.options)).toMatchObject({ released: 0 })
  release(); expect(await preparing).toEqual({ status: 'prepared' })
  expect(await retireNeverAdmittedPlanner(f.options, f.root.signed(f.body))).toEqual({ status: 'released' })
})


test.each(['nonplanner', 'network', 'parent-bound', 'child-bound'] as const)('new policy refuses %s original signed dispatch', async change => {
  const f = await fixture(change === 'nonplanner' ? { role: 'build' } : change === 'network' ? { network: true } : {},
    change === 'parent-bound' || change === 'child-bound' ? change : 'submission-started')
  expect(await prepareNeverAdmittedPlanner(f.options, f.preparation)).toEqual({ status: 'refused' })
  expect(f.admission.listLeases()).toEqual([f.lease])
  expect(f.admission.maintenance.isConversationQuarantined(f.body.parent.sessionId)).toBe(false)
})

test('concurrent unrelated admission wins before preparation and prevents conversation fencing', async () => {
  const f = await fixture(); let unblock!: () => void, observing!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve }), reached = new Promise<void>(resolve => { observing = resolve })
  const pending = prepareNeverAdmittedPlanner({ ...f.options, authority: { ...f.options.authority,
    async attestBoot(challenge) { observing(); await gate; return f.options.authority.attestBoot(challenge, new AbortController().signal) } } }, f.preparation)
  await reached
  const other = await f.admission.forDispatch('project', 'work-board').admit('unrelated-new-run')
  expect(other.status).toBe('admitted'); unblock()
  expect(await pending).toEqual({ status: 'refused' })
  expect(f.admission.maintenance.isConversationQuarantined(f.body.parent.sessionId)).toBe(false)
})

test('preparation drains the actual planner operation queue, not only a substituted drain callback', async () => {
  const f = await fixture()
  await mkdir(f.request.cwd)
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', f.request.cwd, ...args])
    if (result.exitCode !== 0) throw Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git('init', '-b', 'main'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture')
  const { bindPlannerWork, dispatchPlannerWork } = await import('@neutronai/runtime/workers/planner-work.ts')
  const session = {}, base = git('rev-parse', 'HEAD'); let holdCurrent = false, release!: () => void, entered!: () => void
  const pending = new Promise<void>(resolve => { release = resolve }), enteredPromise = new Promise<void>(resolve => { entered = resolve })
  const capability = await bindPlannerWork({ session, request: f.request, deadline: Date.now() + 60000, signal: new AbortController().signal,
    base, pr: null, brief: '', context: {}, validate: () => true, current: async () => {
      if (holdCurrent) { entered(); await pending }
      return true
    } })
  holdCurrent = true
  const operation = dispatchPlannerWork(session, { run_id: f.request.run_id, step_id: f.request.step_id, capability,
    operation: 'write', path: 'late.ts', content: 'late write must not occur' }).then(() => 'wrote', () => 'refused')
  await enteredPromise
  const preparing = prepareNeverAdmittedPlanner(f.options, f.preparation)
  for (let count = 0; !f.admission.maintenance.isConversationQuarantined(f.body.parent.sessionId) && count < 100; count++) await Bun.sleep(1)
  expect(f.admission.maintenance.isConversationQuarantined(f.body.parent.sessionId)).toBe(true)
  expect(Bun.peek.status(preparing)).toBe('pending'); expect(f.admission.listLeases()).toEqual([f.lease])
  release(); expect(await operation).toBe('refused'); expect(await preparing).toEqual({ status: 'prepared' })
  expect(await Bun.file(join(f.request.cwd, 'late.ts')).exists()).toBe(false)
  await expect(dispatchPlannerWork(session, { run_id: f.request.run_id, step_id: f.request.step_id, capability, operation: 'brief' })).rejects.toThrow('no current')
  expect(await retireNeverAdmittedPlanner(f.options, f.root.signed(f.body))).toEqual({ status: 'released' })
})


test('actual consumer drains the retained parent workspace and detaches without terminating or replaying', async () => {
  const f = await fixture()
  const { ReplSession } = await import('@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts')
  const { pool, childByKey, supervisedBySessionKey } = await import('@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts')
  const { upsertRecord, getRecord } = await import('@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts')
  const { inspectConversationQuarantine, quarantinePersistentConversation } = await import('@neutronai/runtime/adapters/claude-code/persistent/conversation-quarantine.ts')
  const { admitNativeChildWorkspace } = await import('@neutronai/runtime/workers/native-child-workspace.ts')
  const parent = f.body.parent, key = `cc-agent-fixture-${randomUUID()}`, registry = join(f.dir, 'registry.json')
  const predicate = (id: string) => f.admission.maintenance.isConversationQuarantined(id)
  const session = new ReplSession(key, parent.childGeneration, parent.sessionId, `neutron-${'a'.repeat(32)}`, f.dir)
  session.isConversationQuarantined = predicate
  let kills = 0, writes = 0, detaches = 0
  const child = { pid: parent.pid, hasExited: () => false, write() { writes++ }, kill() { kills++ }, detach() { detaches++ },
    exited: new Promise<null>(() => {}) }
  session.attachChild(child); session.pooledAs = Promise.resolve(session)
  pool.set(key, session.pooledAs); childByKey.set(key, child)
  supervisedBySessionKey.set(key, { substrate_instance_id: key, user_id: 'owner', project_id: 'project', cwd: f.dir,
    replRegistryPath: registry, isConversationQuarantined: predicate })
  cleanup.push(() => { pool.delete(key); childByKey.delete(key); supervisedBySessionKey.delete(key) })
  upsertRecord(registry, { sessionKey: key, sessionId: parent.sessionId, cwd: f.dir, conversationProjectId: 'project',
    channelName: `neutron-${'a'.repeat(32)}`, has_session: true, pid: parent.pid, child_generation: parent.childGeneration })
  const originalRow = getRecord(registry, key)
  const common = join(f.dir, 'git-common'), directory = join(common, 'linked')
  await mkdir(directory, { recursive: true }); await mkdir(f.request.cwd)
  const workspace = await admitNativeChildWorkspace({ session, request: f.request, runId: f.run.id, worktree: f.request.cwd,
    branch: 'work', generation: 0, pending: () => [{ runId: f.run.id, stepId: f.request.step_id, generation: 0 }],
    git: async args => args[0] === 'symbolic-ref' ? 'refs/heads/work' : args.includes('--show-toplevel') ? f.request.cwd
      : args.includes('--absolute-git-dir') ? directory : common })
  const release = await session.acquireTurn(undefined, workspace); release()
  expect(session.turnSlotHeld).toBe(1)
  const identity = () => parent.processIdentity!
  const options = { ...f.options,
    inspectConversation: (p: Parameters<typeof inspectConversationQuarantine>[0], q: (id: string) => boolean,
      deps?: Parameters<typeof inspectConversationQuarantine>[2]) => inspectConversationQuarantine(p, q, { ...deps, identity }),
    quarantineConversation: (p: Parameters<typeof quarantinePersistentConversation>[0], q: (id: string) => boolean) =>
      quarantinePersistentConversation(p, q, { identity }) }
  expect(getRecord(registry, key)).toBeDefined()
  expect(session.hasOnlyQuarantineRequest(f.request)).toBe(true)
  expect(inspectConversationQuarantine(parent, predicate, { request: f.request, identity })).toBe(true)
  expect(await prepareNeverAdmittedPlanner(options, f.preparation)).toEqual({ status: 'prepared' })
  expect(session.turnSlotHeld).toBe(1); expect(f.admission.listLeases()).toEqual([f.lease])
  expect(await retireNeverAdmittedPlanner(options, f.root.signed(f.body))).toEqual({ status: 'released' })
  expect(session.turnSlotHeld).toBe(0); expect(session.fenced).toBe(true)
  expect(kills).toBe(0); expect(writes).toBe(0); expect(detaches).toBe(1)
  expect(getRecord(registry, key)).toEqual(originalRow)
  expect(await retireNeverAdmittedPlanner(options, f.root.signed(f.body))).toEqual({ status: 'already-retired' })
})

test('semantic mutations oppose authentication, dispatch identity, current quarantine, drain and disabled recovery', async () => {
  const source = (await readFile(new URL('../never-admitted-planner-retirement.ts', import.meta.url), 'utf8'))
    .replace(/'(@neutronai\/[^']+)'/g, (_match, specifier: string) => JSON.stringify(import.meta.resolve(specifier)))
    .replace("'../owner-identity.ts'", JSON.stringify(new URL('../../owner-identity.ts', import.meta.url).href))
  const directory = await mkdtemp(join(tmpdir(), 'never-admitted-mutants-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const mutations = [
    { name: 'signature', from: '!verifyNeverAdmittedPlannerRetirement(raw, authority, capacity)', to: 'false' },
    { name: 'dispatch', from: '|| plannerRetirementDigest(dispatch) !== body.dispatchDigest', to: '' },
    { name: 'current', from: 'if (!await current(body)) return refused', to: '' },
    { name: 'drain', from: '(options.drain ?? retirePlannerWork)(request)', to: 'Promise.resolve()' },
    { name: 'disabled', from: 'const request = original(options, body)', to: 'const request = undefined' },
  ]
  for (const mutation of mutations) {
    expect(source.includes(mutation.from)).toBe(true)
    const file = join(directory, mutation.name + '.ts')
    await writeFile(file, source.replaceAll(mutation.from, mutation.to))
    const mutated = await import(file) as { prepareNeverAdmittedPlanner: typeof prepareNeverAdmittedPlanner,
      retireNeverAdmittedPlanner: typeof retireNeverAdmittedPlanner }
    const f = await fixture()
    if (mutation.name === 'dispatch') {
      f.preparation.body.dispatchDigest = '0'.repeat(64)
      f.preparation = f.root.signed(f.preparation.body)
      f.body.preparation = f.preparation; f.body.dispatchDigest = f.preparation.body.dispatchDigest
      expect(await prepareNeverAdmittedPlanner(f.options, f.preparation)).toEqual({ status: 'refused' })
      expect(await mutated.prepareNeverAdmittedPlanner(f.options, f.preparation)).toEqual({ status: 'prepared' })
    } else expect(await prepareNeverAdmittedPlanner(f.options, f.preparation)).toEqual({ status: 'prepared' })
    const receipt = f.root.signed(f.body)
    if (mutation.name === 'signature') receipt.signature = Buffer.alloc(64).toString('base64')
    if (mutation.name === 'current') f.status(false)
    const options = mutation.name === 'drain' ? { ...f.options, drain: async () => { throw Error('unknown drain') } } : f.options
    const baseline = await retireNeverAdmittedPlanner(options, receipt)
    expect(baseline.status).toBe(mutation.name === 'disabled' ? 'released' : 'refused')
    // A completed retry is also subject to the eligibility checks above it.
    const changed = await mutated.retireNeverAdmittedPlanner(options, receipt)
    expect(changed.status).toBe(mutation.name === 'disabled' ? 'refused' : 'released')
  }
})

test('unresolved other parent refuses before any conversation fence', async () => {
  const f = await fixture()
  const { supervisedBySessionKey } = await import('@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts')
  const key = `cc-agent-unknown-${randomUUID()}`
  supervisedBySessionKey.set(key, { substrate_instance_id: key, user_id: 'owner', project_id: 'project', cwd: f.dir })
  cleanup.push(() => supervisedBySessionKey.delete(key))
  expect(await prepareNeverAdmittedPlanner(f.options, f.preparation)).toEqual({ status: 'refused' })
  expect(f.admission.maintenance.isConversationQuarantined(f.body.parent.sessionId)).toBe(false)
  expect(f.admission.listLeases()).toEqual([f.lease])
})


async function logicalConversationFixture() {
  const f = await fixture()
  const previous = new ProjectAdmission({ db: f.db, ownerHandle: 'owner', bootId: 'closed-epoch' })
  const admitted = await previous.forNativeChild('project').admit('old-run', 'old-plan')
  if (admitted.status !== 'admitted') throw Error('old fixture admission')
  const oldLease = previous.listLeases().find(row => row.token === admitted.lease.token)!
  const operationId = randomUUID()
  const old = f.root.signed({ version: 1, kind: 'planner-authority-retired', policy: 'expired-closed-planner-v1',
    operationId, hostId: 'host', instanceId: 'install', bootId: 'kernel', evidenceDigest: 'a'.repeat(64),
    lease: oldLease, requestDigest: 'b'.repeat(64), dispatchDigest: 'c'.repeat(64), parent: f.body.parent, nativeAgentId: 'old-child',
    observation: { producer: 'operator', observedAt: Date.now(), profile: 'neutron-planner-v1', soleTool: 'mcp__neutron__planner_work',
      invocationDigest: 'a'.repeat(64), nativeEnforcementDigest: 'b'.repeat(64), noPostDispatchToolCalls: true,
      originalExecutor: f.body.observation.originalExecutor } })
  const completion = JSON.stringify({ version: 1, kind: 'planner-authority-retirement-consumed', operationId,
    authorizationDigest: hash(old), nativeLoop: 'unknown', outcome: 'unknown' })
  expect(await previous.maintenance.preparePlannerRetirement(operationId, oldLease, JSON.stringify(old), () => true)).toBe(true)
  expect(await previous.maintenance.consumePlannerRetirement(operationId, oldLease, JSON.stringify(old), completion, () => true)).toBe('released')
  const topicKey = 'owner:app:owner:project'
  await previous.admit('project', 'conversation', 'chat', `${topicKey}:1234567`)
  await previous.admit('project', 'conversation', 'acting-turn', `${topicKey}:${randomUUID()}`)
  const rows = previous.listLeases('conversation')
  f.preparation.body.conversationLeases = rows.map(lease => ({ lease: { ...lease, reason: 'conversation' as const }, retirementOperationId: operationId }))
  f.preparation.body.conversationReset = { topicKey, ownerAuthorized: true, censusDigest: 'f'.repeat(64) }
  const seal = () => {
    f.preparation = f.root.signed(f.preparation.body)
    f.body = { ...f.body, conversationLeases: f.preparation.body.conversationLeases,
      conversationReset: f.preparation.body.conversationReset!, preparation: f.preparation }
  }
  seal()
  return { ...f, previous, rows, old, completion, operationId, seal,
    preparation: () => f.preparation, receipt: () => f.root.signed(f.body) }
}

test('owner reset retires only enumerated dead-producer logical admissions and permanently denies their replay', async () => {
  const f = await logicalConversationFixture()
  const before = f.admission.maintenance.listPlannerRetirements().find(row => row.operationId === f.operationId)
  const run = f.runs.get(f.run.id), attempt = f.attempts.get(f.key)
  await f.admission.admit('other', 'conversation', 'chat', 'other-topic:123')
  const sibling = f.admission.listLeases().find(row => row.scope.projectId === 'other')!
  expect(await prepareNeverAdmittedPlanner(f.options, f.preparation())).toEqual({ status: 'prepared' })
  for (const row of f.rows) {
    expect(f.admission.maintenance.isConversationRetired(row.scope, row.workRef)).toBe(true)
    expect(await f.admission.maintenance.release(row)).toBe(false)
    expect(await f.admission.maintenance.releaseWork(row.scope, 'conversation', row.workRef)).toBe(0)
    expect(await f.admission.maintenance.admitChild(row.scope, { reason: 'conversation', workRef: row.workRef },
      'liveChild', 'native-child:new', 'late-child')).toEqual({ status: 'fenced' })
  }
  expect(await retireNeverAdmittedPlanner(f.options, f.receipt())).toEqual({ status: 'released' })
  expect(f.admission.listLeases()).toEqual([sibling])
  expect(f.admission.maintenance.listPlannerRetirements().find(row => row.operationId === f.operationId)).toEqual(before)
  expect(f.runs.get(f.run.id)).toEqual(run); expect(f.attempts.get(f.key)).toEqual(attempt)
  const restarted = new ProjectAdmission({ db: f.db, ownerHandle: 'owner', bootId: 'fresh-epoch' })
  for (const row of f.rows) expect((await restarted.admit('project', 'conversation', 'chat', row.workRef)).status).toBe('fenced')
  expect(await retireNeverAdmittedPlanner({ ...f.options, admission: restarted }, f.receipt())).toEqual({ status: 'already-retired' })
  expect((await restarted.admit('project', 'conversation', 'chat', 'owner:app:owner:project:7654321')).status).toBe('admitted')
})

for (const defect of ['duplicate', 'omitted', 'changed-token', 'current-epoch', 'wrong-producer', 'wrong-topic', 'wrong-suffix',
  'missing-reset', 'unsigned-closure', 'pending-closure', 'changed-completion', 'cross-scope-closure', 'cross-session-closure', 'alive-executor'] as const) {
  test(`logical reset refuses ${defect} without clearing or fencing ownership`, async () => {
    const f = await logicalConversationFixture(), body = f.preparation().body
    const entry = body.conversationLeases[0]!
    if (defect === 'duplicate') body.conversationLeases.push(entry)
    if (defect === 'omitted') body.conversationLeases.pop()
    if (defect === 'changed-token') entry.lease.token = randomUUID()
    if (defect === 'current-epoch') entry.lease.producer = 'chat:original-gateway'
    if (defect === 'wrong-producer') entry.lease.producer = 'build:closed-epoch'
    if (defect === 'wrong-topic') entry.lease.workRef = 'owner:app:owner:other:1234567'
    if (defect === 'wrong-suffix') entry.lease.workRef = 'owner:app:owner:project:not-a-time'
    if (defect === 'missing-reset') delete body.conversationReset
    if (defect === 'unsigned-closure') f.db.runSync('UPDATE planner_authority_retirements SET authorization = ? WHERE operation_id = ?',
      [JSON.stringify({ ...f.old, signature: 'forged' }), f.operationId])
    if (defect === 'pending-closure') f.db.runSync('UPDATE planner_authority_retirements SET completion = NULL WHERE operation_id = ?', [f.operationId])
    if (defect === 'changed-completion') f.db.runSync('UPDATE planner_authority_retirements SET completion = ? WHERE operation_id = ?', ['{}', f.operationId])
    if (defect === 'cross-scope-closure' || defect === 'cross-session-closure' || defect === 'alive-executor') {
      const oldBody = structuredClone(f.old.body)
      if (defect === 'cross-scope-closure') oldBody.lease.scope.projectId = 'other'
      if (defect === 'cross-session-closure') oldBody.parent.sessionId = randomUUID()
      if (defect === 'alive-executor') oldBody.observation.originalExecutor.pid = process.pid
      const auth = f.root.signed(oldBody)
      const completion = JSON.stringify({ ...JSON.parse(f.completion), authorizationDigest: hash(auth) })
      f.db.runSync('UPDATE planner_authority_retirements SET authorization = ?, completion = ? WHERE operation_id = ?',
        [JSON.stringify(auth), completion, f.operationId])
    }
    f.seal()
    const before = f.admission.listLeases()
    expect(await prepareNeverAdmittedPlanner(f.options, f.preparation())).toEqual({ status: 'refused' })
    expect(f.admission.listLeases()).toEqual(before)
    expect(f.admission.maintenance.isConversationQuarantined(f.body.parent.sessionId)).toBe(false)
  })
}

test('logical reset holds all exact leases during failed drain and refuses intervening unlisted admission', async () => {
  const f = await logicalConversationFixture()
  expect(await prepareNeverAdmittedPlanner({ ...f.options, drain: async () => { throw Error('unknown operation drain') } }, f.preparation()))
    .toEqual({ status: 'refused' })
  expect(f.admission.listLeases()).toHaveLength(3)
  expect(f.admission.maintenance.isConversationQuarantined(f.body.parent.sessionId)).toBe(true)
  expect(await prepareNeverAdmittedPlanner(f.options, f.preparation())).toEqual({ status: 'prepared' })
  expect(await retireNeverAdmittedPlanner(f.options, f.receipt())).toEqual({ status: 'released' })
  const race = await logicalConversationFixture(), attestBoot = race.options.authority.attestBoot
  let admitted = false
  race.options.authority.attestBoot = async (...args) => {
    if (!admitted) { admitted = true; await race.admission.admit('project', 'conversation', 'chat', 'owner:app:owner:project:99999') }
    return attestBoot(...args)
  }
  expect(await prepareNeverAdmittedPlanner(race.options, race.preparation())).toEqual({ status: 'refused' })
  expect(race.admission.listLeases()).toHaveLength(4)
})

test('logical reset refuses another positively identified live conversation', async () => {
  const f = await logicalConversationFixture()
  const { ReplSession } = await import('@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts')
  const { pool, childByKey, supervisedBySessionKey } = await import('@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts')
  const key = `cc-agent-other-${randomUUID()}`
  const session = new ReplSession(key, 'other-generation', randomUUID(), `neutron-${'b'.repeat(32)}`, f.dir)
  const child = { pid: process.pid, hasExited: () => false, write() { throw Error('No parent input') }, kill() { throw Error('No termination') },
    exited: new Promise<null>(() => {}) }
  session.attachChild(child); session.pooledAs = Promise.resolve(session)
  pool.set(key, session.pooledAs); childByKey.set(key, child)
  supervisedBySessionKey.set(key, { substrate_instance_id: key, user_id: 'owner', project_id: 'project', cwd: f.dir })
  cleanup.push(() => { pool.delete(key); childByKey.delete(key); supervisedBySessionKey.delete(key) })
  expect(session.hasOnlyQuarantineRequest(f.request)).toBe(true)
  const before = f.admission.listLeases()
  expect(await prepareNeverAdmittedPlanner(f.options, f.preparation())).toEqual({ status: 'refused' })
  expect(f.admission.listLeases()).toEqual(before)
  expect(f.admission.maintenance.isConversationQuarantined(f.body.parent.sessionId)).toBe(false)
  pool.delete(key); childByKey.delete(key); supervisedBySessionKey.delete(key)
  expect(await prepareNeverAdmittedPlanner(f.options, f.preparation())).toEqual({ status: 'prepared' })
  pool.set(key, session.pooledAs); childByKey.set(key, child)
  supervisedBySessionKey.set(key, { substrate_instance_id: key, user_id: 'owner', project_id: 'project', cwd: f.dir })
  expect(await retireNeverAdmittedPlanner(f.options, f.receipt())).toEqual({ status: 'refused' })
  expect(f.admission.listLeases()).toEqual(before)
})

test('logical reset mutations expose forged closure and retired-work replay through real consumers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-retirement-mutants-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const source = (await readFile(new URL('../never-admitted-planner-retirement.ts', import.meta.url), 'utf8'))
    .replace(/'(@neutronai\/[^']+)'/g, (_match, specifier: string) => JSON.stringify(import.meta.resolve(specifier)))
    .replace("'../owner-identity.ts'", JSON.stringify(new URL('../../owner-identity.ts', import.meta.url).href))
  const guard = '!verifyPlannerAuthorityRetirement(authorization, options.authority)'
  expect(source.includes(guard)).toBe(true)
  const closureFile = join(directory, 'closure.ts'); await writeFile(closureFile, source.replace(guard, 'false'))
  const closure = await import(closureFile) as { prepareNeverAdmittedPlanner: typeof prepareNeverAdmittedPlanner }
  const forged = await logicalConversationFixture()
  const bad = { ...forged.old, signature: Buffer.alloc(64).toString('base64') }
  forged.db.runSync('UPDATE planner_authority_retirements SET authorization = ?, completion = ? WHERE operation_id = ?',
    [JSON.stringify(bad), JSON.stringify({ ...JSON.parse(forged.completion), authorizationDigest: hash(bad) }), forged.operationId])
  expect(await prepareNeverAdmittedPlanner(forged.options, forged.preparation())).toEqual({ status: 'refused' })
  expect(await closure.prepareNeverAdmittedPlanner(forged.options, forged.preparation())).toEqual({ status: 'prepared' })

  const valid = await logicalConversationFixture()
  expect(await prepareNeverAdmittedPlanner(valid.options, valid.preparation())).toEqual({ status: 'prepared' })
  expect(await retireNeverAdmittedPlanner(valid.options, valid.receipt())).toEqual({ status: 'released' })
  const storeSource = await readFile(new URL('../../../gateway/project-admission-store.ts', import.meta.url), 'utf8')
  const replayGuard = "|| (reason === 'conversation' && this.isConversationRetired(scope, workRef))"
  expect(storeSource.includes(replayGuard)).toBe(true)
  const replayFile = join(directory, 'replay.ts'); await writeFile(replayFile, storeSource.replaceAll(replayGuard, ''))
  const replay = await import(replayFile) as { ProjectAdmissionStore: typeof import('@neutronai/gateway/project-admission-store.ts').ProjectAdmissionStore }
  const mutantStore = new replay.ProjectAdmissionStore(valid.db), row = valid.rows[0]!
  expect((await valid.admission.maintenance.admit(row.scope, 'conversation', 'chat:new-epoch', row.workRef)).status).toBe('fenced')
  expect((await mutantStore.admit(row.scope, 'conversation', 'chat:new-epoch', row.workRef)).status).toBe('admitted')
})
