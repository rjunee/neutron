import { afterEach, expect, test } from 'bun:test'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { readProcessIdentity, type ProcessIdentity } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import { RelicWorkspaceServer } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/workspace-relic-fixture.ts'
import { createWorkerTerminalHost, createConversationTerminal, projectWorkspaceJournalPath } from '../project-build-terminal.ts'
import { createProjectScopeLifecycle } from '../project-scope-lifecycle.ts'
import { herdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { saveRegistry } from '@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts'
import { ReplSession } from '@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts'
import { createClaudeNativeDispatchReceipt, nativeDispatchReceiptPath, readClaudeNativeDispatchReceipt, verifyNativeDispatchChildBound, type SignedNativeDispatchRecord } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import type { NativeHostRecoveryAuthority, SignedHostEvidence } from '@neutronai/runtime/workers/native-host-termination.ts'
import { nativeParentTerminationDigest, verifyNativeParentTerminationCompletion, verifyNativeParentTerminationPreparation,
  type NativeParentTerminationCompletion, type NativeParentTerminationPreparation } from '@neutronai/runtime/workers/native-parent-termination.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { seedProject } from '@neutronai/gateway/wiring/__tests__/project-admission-fixture.ts'
import { completedNativeParentTermination, consumeNativeParentTermination, prepareNativeParentTermination,
  type NativeParentTerminationOptions } from '../native-parent-termination.ts'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(change?: (request: BoundedWorkRequest) => BoundedWorkRequest, deadline = 100, processIdentity?: { pid: number; processIdentity: ProcessIdentity }) {
  const boot = processIdentity?.processIdentity.boot_id ?? 'kernel'
  const dir = mkdtempSync(join(tmpdir(), 'review-parent-termination-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'project.db'); seedMigratedDb(path)
  const db = ProjectDb.open(path); cleanup.push(() => db.close())
  seedProject(db, 'project'); seedProject(db, 'other')
  const runs = new TridentRunStore(db), attempts = new TridentAttemptLedger(db)
  const run = await runs.create({ slug: 'review', project_slug: 'project', repo_path: dir, task: 'Review specified implementation' })
  await runs.update(run.id, { phase: 'failed' })
  const stateRoot = join(dir, 'builds'), state = join(stateRoot, encodeURIComponent(run.id)); mkdirSync(state, { recursive: true })
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'original-gateway' })
  const port = admission.forNativeChild('project')
  const parent = { sessionId: 'original-parent', childGeneration: 'original-generation', pid: processIdentity?.pid ?? process.pid,
    processIdentity: processIdentity?.processIdentity ?? { boot_id: boot, start_ticks: 1 },
    launch: { version: 1 as const, sessionId: 'original-parent', childGeneration: 'original-generation', projectId: 'project',
      executable: { realPath: '/bin/fixture-native', sha256: 'a'.repeat(64), version: '1.0.0' },
      argv: ['/bin/fixture-native', '--tools', 'Agent', '--session-id', 'original-parent', '--channels', 'server:neutron-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], tools: ['Agent'] } }
  const children: NativeParentTerminationPreparation['children'] = []
  for (const step of ['review-one', 'review-two']) {
    let request: BoundedWorkRequest = { run_id: run.id, step_id: step, role: 'review', model_id: 'model', effort: null,
      cwd: dir, writable: false, network: true, tools: 'read-only', brief: { path: join(state, `${step}.brief`), integrity: 'original' },
      result: { path: join(state, `${step}.result`), schema: step === 'review-one' ? 'project-review' : 'verdict' }, thread: null, budget: { wall_ms: 100 }, needs_approval_decision: false }
    request = change?.(request) ?? request
    const key = { run_id: run.id, step_id: step, attempt_id: 'dispatch' }
    await attempts.admit({ ...key, phase: 'review_rubric', task_id: 'task', head_sha: 'a'.repeat(40), role: request.role, review_seat: null,
      provider: 'anthropic', requested_model: 'model', resolved_model: 'model', placement: 'in-repl', queued_at: 1 })
    await attempts.lifecycle(key, { prepared_at: 2, started_at: 3, ended_at: 4, outcome: 'unknown' })
    const admitted = await port.admit(run.id, step)
    if (admitted.status !== 'admitted') throw Error('Fixture admission failed')
    const writer = createClaudeNativeDispatchReceipt(state, request, port.dispatchAuthority!(admitted.lease, request, deadline))
    writer.record({ kind: 'parent-bound', parent }); writer.record({ kind: 'submission-started' })
    writer.record({ kind: 'child-bound', nativeAgentId: step }); port.finishPreparing!(admitted.lease)
    const dispatch = readClaudeNativeDispatchReceipt(state, request) as SignedNativeDispatchRecord
    const lease = admission.listLeases('liveChild').find(row => row.token === admitted.lease.token)!
    if (!verifyNativeDispatchChildBound(dispatch, request, { ...lease, reason: 'liveChild' })) throw Error('Fixture signature failed')
    children.push({ lease: dispatch.body.lease, dispatch })
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signed = <T>(body: T): SignedHostEvidence<T> => ({ body, signature: sign(null, Buffer.from(JSON.stringify(body)), privateKey).toString('base64') })
  const authority: NativeHostRecoveryAuthority = { hostId: 'host', instanceId: 'instance', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    async attestBoot(challenge) { return signed({ version: 1, kind: 'host-boot', hostId: this.hostId, instanceId: this.instanceId, bootId: boot, challenge }) } }
  const body: NativeParentTerminationPreparation = { version: 1, kind: 'native-parent-termination-preparation', policy: 'expired-signed-reviews-v1',
    operationId: randomUUID(), hostId: 'host', instanceId: 'instance', bootId: boot, ownerAuthorizedReset: true,
    parent, children, evidenceDigest: 'b'.repeat(64) }
  const session = new ReplSession('key', parent.childGeneration, parent.sessionId, 'channel', dir)
  let alive = true, inspected = 0, detached = 0
  const options: NativeParentTerminationOptions = { authority, admission, stateRoot, runs, attempts,
    projectIdForRun: value => value.project_slug, listProjectIds: () => ['project', 'other'], kernelBootId: () => boot,
    resolve: async () => ({ live: [{ sessionKey: 'key', session, options: { substrate_instance_id: 'cc-agent-test', user_id: 'owner' } }], unresolved: 0 }),
    inspect: (_parent, _predicate, deps) => { inspected++; return alive && deps?.requests?.length === children.length },
    quarantine: (_parent, predicate, deps) => { detached++; return predicate(parent.sessionId) && deps?.requests?.length === children.length },
    processVerdict: () => alive ? 'ours-alive' : 'confirmed-gone' }
  const preparation = signed(body)
  const completion = (prep = preparation) => signed<NativeParentTerminationCompletion>({ version: 1, kind: 'native-parent-terminated',
    operationId: prep.body.operationId, hostId: 'host', instanceId: 'instance', bootId: boot, parent,
    preparationDigest: nativeParentTerminationDigest(prep), observation: { kind: 'retained-pidfd-exit', openedWhileAlive: true,
      preparedBeforeSignal: true, executionTreeTerminated: true, observedAt: Date.now(), evidenceDigest: 'c'.repeat(64) } })
  return { dir, db, state, run, runs, attempts, body, signed, preparation, completion, options,
    exit: () => { alive = false }, activity: () => ({ inspected, detached }) }
}

test('two-phase exact review recovery survives restart, preserves failed history and reopens only fresh work', async () => {
  const f = await fixture(), { options: o } = f
  const sibling = await o.admission.forNativeChild('other').admit('other-run', 'review')
  expect(sibling.status).toBe('admitted')
  const history = o.runs.get(f.run.id), attempts = f.attempts.list(f.run.id)
  const originals = f.body.children.map(c => readFileSync(nativeDispatchReceiptPath(f.state, c.dispatch.body.request), 'utf8'))
  const completion = f.completion()
  expect(await consumeNativeParentTermination(o, { preparation: f.preparation, completion })).toEqual({ status: 'refused' })
  expect(await prepareNativeParentTermination(o, f.preparation)).toEqual({ status: 'prepared' })
  expect(f.activity()).toMatchObject({ detached: 1 })
  expect(o.admission.listLeases()).toHaveLength(3)
  expect(completedNativeParentTermination(o, 'project', f.body.parent.sessionId)).toBeUndefined()
  expect(await consumeNativeParentTermination(o, { preparation: f.preparation, completion })).toEqual({ status: 'refused' })
  const restarted = { ...o, admission: new ProjectAdmission({ db: f.db, ownerHandle: 'owner', bootId: 'new-gateway' }) }
  f.exit()
  expect(await consumeNativeParentTermination(restarted, { preparation: f.preparation, completion })).toEqual({ status: 'released' })
  expect(await consumeNativeParentTermination(restarted, { preparation: f.preparation, completion })).toEqual({ status: 'already-retired' })
  expect(o.admission.listLeases()).toHaveLength(1)
  expect(completedNativeParentTermination(restarted, 'project', f.body.parent.sessionId)).toMatchObject({ nativeLoop: 'terminated' })
  expect(completedNativeParentTermination(restarted, 'other', f.body.parent.sessionId)).toBeUndefined()
  expect(o.runs.get(f.run.id)).toEqual(history); expect(f.attempts.list(f.run.id)).toEqual(attempts)
  expect(f.body.children.map(c => readFileSync(nativeDispatchReceiptPath(f.state, c.dispatch.body.request), 'utf8'))).toEqual(originals)
  expect((await o.admission.forNativeChild('project').admit(f.run.id, 'review-one')).status).not.toBe('admitted')
  expect((await o.admission.forNativeChild('project').admit('fresh-run', 'review')).status).toBe('admitted')
})

test.each(['signature', 'native-signature', 'parent', 'owner', 'boot', 'omitted-child', 'duplicate-child', 'writable', 'role', 'tools', 'scope'] as const)(
  'independent and original authority reject %s', async change => {
    const f = await fixture(), body = structuredClone(f.body)
    if (change === 'native-signature') body.children[0]!.dispatch.signature = 'forged'
    if (change === 'parent') body.parent.pid++
    if (change === 'owner') (body as { ownerAuthorizedReset: boolean }).ownerAuthorizedReset = false
    if (change === 'boot') body.bootId = 'different'
    if (change === 'omitted-child') body.children.pop()
    if (change === 'duplicate-child') body.children.push(body.children[0]!)
    if (change === 'writable') body.children[0]!.dispatch.body.request = { ...body.children[0]!.dispatch.body.request, writable: true }
    if (change === 'role') body.children[0]!.dispatch.body.request = { ...body.children[0]!.dispatch.body.request, role: 'build' }
    if (change === 'tools') body.children[0]!.dispatch.body.request = { ...body.children[0]!.dispatch.body.request, tools: 'edit-and-run' }
    if (change === 'scope') body.children[0]!.lease.scope.projectId = 'other'
    const signed = f.signed(body); if (change === 'signature') signed.signature = 'forged'
    expect(verifyNativeParentTerminationPreparation(f.preparation, f.options.authority!)).toBe(true)
    expect(await prepareNativeParentTermination(f.options, signed)).toEqual({ status: 'refused' })
    expect(f.options.admission.listLeases()).toHaveLength(2)
    expect(f.options.admission.maintenance.listPlannerRetirements()).toEqual([])
  })

test.each(['live-run', 'deadline', 'receipt', 'active-turn', 'unknown-parent', 'no-parent', 'conversation', 'completed-attempt'] as const)(
  'canonical eligibility refuses %s before changing ownership', async change => {
    const f = await fixture(undefined, change === 'deadline' ? Date.now() + 60_000 : 100), o = f.options
    if (change === 'live-run') await f.runs.update(f.run.id, { phase: 'forge-init' })
    if (change === 'receipt') writeFileSync(nativeDispatchReceiptPath(f.state, f.body.children[0]!.dispatch.body.request), 'corrupt')
    if (change === 'active-turn') o.inspect = () => false
    if (change === 'unknown-parent') o.resolve = async () => ({ live: [], unresolved: 1 })
    if (change === 'no-parent') o.resolve = async () => ({ live: [], unresolved: 0 })
    if (change === 'conversation') await o.admission.maintenance.admit(f.body.children[0]!.lease.scope, 'conversation', 'chat:owner', 'ordinary')
    if (change === 'completed-attempt') f.db.runSync("UPDATE code_trident_attempts SET outcome = 'completed' WHERE run_id = ?", [f.run.id])
    expect(await prepareNativeParentTermination(o, f.preparation)).toEqual({ status: 'refused' })
    expect(o.admission.maintenance.listPlannerRetirements()).toEqual([])
  })

test.each(['writable', 'role', 'tools'] as const)('even authentic %s dispatch is ineligible', async change => {
  const f = await fixture(request => ({ ...request, ...(change === 'writable' ? { writable: true }
    : change === 'role' ? { role: 'build' } : { tools: 'edit-and-run' }) }))
  expect(await prepareNativeParentTermination(f.options, f.preparation)).toEqual({ status: 'refused' })
})

test('incomplete detachment retains every lease and fence; exact preparation can retry', async () => {
  const f = await fixture(), quarantine = f.options.quarantine!
  f.options.quarantine = () => false
  expect(await prepareNativeParentTermination(f.options, f.preparation)).toEqual({ status: 'refused' })
  expect(f.options.admission.listLeases()).toHaveLength(2)
  expect(f.options.admission.maintenance.isConversationQuarantined(f.body.parent.sessionId)).toBe(true)
  f.options.quarantine = quarantine
  expect(await prepareNativeParentTermination(f.options, f.preparation)).toEqual({ status: 'prepared' })
})

test('completed physical termination crosses lifecycle and real workspace placement without resuming or deleting history', async () => {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' })
  cleanup.push(async () => { if (child.exitCode === null) child.kill(); await child.exited })
  const f = await fixture(undefined, 100, { pid: child.pid, processIdentity: readProcessIdentity(child.pid)! })
  delete f.options.processVerdict // Use the actual kernel at the consuming boundary.
  const server = new RelicWorkspaceServer(), originalCall = server.call.bind(server)
  let foreground: 'original' | 'foreign' | 'empty' = 'original'
  let oldPane = ''
  server.call = async (method, params) => {
    const response = await originalCall(method, params)
    if (method === 'pane.get') (response.pane as Record<string, unknown>).retirement_identity = server.births.get(String(params.pane_id))
    if (method === 'pane.process_info' && params.pane_id === oldPane && foreground !== 'original') {
      (response.process_info as Record<string, unknown>).foreground_processes = foreground === 'empty' ? []
        : [{ pid: process.pid, argv: ['unrelated-native'] }]
    }
    return response
  }
  const makeTerminal = () => createConversationTerminal({
    host: createWorkerTerminalHost(f.dir, { selected: herdrHost, connect: async () => server }), instanceId: 'owner', selected: herdrHost })!
  const terminal = makeTerminal()
  const placed = await terminal.host!.spawn([...f.body.parent.launch!.argv], {
    cwd: f.dir, env: {}, projectPlacement: terminal.placementFor('project'),
  })
  placed.detach?.(); oldPane = placed.paneHandle!
  server.panes.get(oldPane)!.shell_pid = child.pid
  const registryPath = join(f.dir, 'registry.json')
  saveRegistry(registryPath, { original: { sessionKey: 'original', sessionId: f.body.parent.sessionId,
    child_generation: f.body.parent.childGeneration, pid: child.pid, cwd: f.dir,
    channelName: 'neutron-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', conversationProjectId: 'project', has_session: true, pane_handle: oldPane } })
  const beforeRegistry = readFileSync(registryPath, 'utf8'), journal = projectWorkspaceJournalPath(f.dir)
  const beforeJournal = readFileSync(journal, 'utf8'), beforePane = structuredClone(server.panes.get(oldPane))
  const lifecycle = createProjectScopeLifecycle({ admission: f.options.admission, registryPath, conversationTerminal: terminal, idleMs: 0,
    isConversationQuarantined: id => f.options.admission.maintenance.isConversationQuarantined(id),
    completedConversationQuarantine: (scope, id) => completedNativeParentTermination(f.options, scope, id) })
  const handoff = () => lifecycle.handoffChat('project', { sessionKey: 'fresh-native-key', credentialId: 'fresh-native-route' })
  expect(await prepareNativeParentTermination(f.options, f.preparation)).toEqual({ status: 'prepared' })
  expect((await handoff()).status).toBe('refused')
  expect(readFileSync(journal, 'utf8')).toBe(beforeJournal)
  const completion = f.completion()
  expect(await consumeNativeParentTermination(f.options, { preparation: f.preparation, completion })).toEqual({ status: 'refused' })
  child.kill(); await child.exited; f.exit()
  expect(await consumeNativeParentTermination(f.options, { preparation: f.preparation, completion })).toEqual({ status: 'released' })
  foreground = 'foreign'
  expect((await handoff()).status).toBe('refused')
  foreground = 'empty'
  const birth = server.births.get(oldPane)!
  server.births.set(oldPane, { ...birth, runtime_generation: 'foreign-pane' })
  expect((await handoff()).status).toBe('refused')
  server.births.set(oldPane, birth)
  expect((await handoff()).status).toBe('ready')
  const fresh = await makeTerminal().host!.spawn(['/bin/fixture-native', '--session-id', 'fresh-session'], {
    cwd: f.dir, env: {}, projectPlacement: terminal.placementFor('project'),
  })
  fresh.detach?.()
  expect(fresh.paneHandle).not.toBe(oldPane)
  expect(server.panes.get(oldPane)).toEqual(beforePane)
  expect(server.closed).not.toContain(oldPane)
  expect(readFileSync(registryPath, 'utf8')).toBe(beforeRegistry)
  const row = Object.values(JSON.parse(readFileSync(journal, 'utf8')))[0] as {
    chat: { pane: string }; quarantinedChats: Array<{ pane: string; quarantine: { nativeLoop: string } }>
  }
  expect(row.chat.pane).toBe(fresh.paneHandle!)
  expect(row.quarantinedChats).toMatchObject([{ pane: oldPane, quarantine: { nativeLoop: 'terminated' } }])
  expect((await makeTerminal().inspectChat!('project')).status).toBe('live')
})

test.each(['signature', 'operation', 'preparation', 'parent', 'opened', 'prepared', 'execution-tree', 'future', 'kernel'] as const)(
  'prepared ownership remains held on invalid %s completion', async change => {
    const f = await fixture(), c = structuredClone(f.completion().body)
    expect(await prepareNativeParentTermination(f.options, f.preparation)).toEqual({ status: 'prepared' })
    f.exit()
    if (change === 'operation') c.operationId = randomUUID()
    if (change === 'preparation') c.preparationDigest = '0'.repeat(64)
    if (change === 'parent') c.parent.pid++
    if (change === 'opened') (c.observation as { openedWhileAlive: boolean }).openedWhileAlive = false
    if (change === 'prepared') (c.observation as { preparedBeforeSignal: boolean }).preparedBeforeSignal = false
    if (change === 'execution-tree') (c.observation as { executionTreeTerminated: boolean }).executionTreeTerminated = false
    if (change === 'future') c.observation.observedAt = Date.now() + 60_000
    const completion = f.signed(c); if (change === 'signature') completion.signature = 'forged'
    if (change === 'kernel') f.options.kernelBootId = () => 'changed'
    expect(verifyNativeParentTerminationCompletion(f.completion(), f.preparation, f.options.authority!)).toBe(true)
    expect(await consumeNativeParentTermination(f.options, { preparation: f.preparation, completion })).toEqual({ status: 'refused' })
    expect(f.options.admission.listLeases()).toHaveLength(2)
    expect(f.options.admission.maintenance.operatorMaintenanceFor(f.body.children[0]!.lease.scope, f.body.operationId)).not.toBeNull()
  })
