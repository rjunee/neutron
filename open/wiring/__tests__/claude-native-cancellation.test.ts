import { afterEach, expect, spyOn, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { seedProject } from '@neutronai/gateway/wiring/__tests__/project-admission-fixture.ts'
import { routeCodegenCancel } from '@neutronai/gateway/codegen-cancel-router.ts'
import { CodegenTaskNotFoundError } from '@neutronai/codegen-core'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import { buildTridentTerminator } from '@neutronai/trident/terminate.ts'
import { createProjectLauncher } from '@neutronai/trident/project-launcher.ts'
import * as host from '@neutronai/trident/project-build-host.ts'
import * as runners from '@neutronai/runtime/workers/project-runners.ts'
import * as codex from '@neutronai/runtime/workers/codex-headless.ts'
import * as capacity from '@neutronai/runtime/workers/claude-capacity-client.ts'
import { fakeRunner, type BoundedWorkOutcome } from '@neutronai/runtime/bounded-work.ts'
import { ReplSession } from '@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts'
import { recordNativeParentLaunchEvidence } from '@neutronai/runtime/adapters/claude-code/persistent/native-parent-launch-evidence.ts'
import { readProcessIdentity } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import { sessionJsonlPath } from '@neutronai/runtime/adapters/claude-code/persistent/jsonl-resumability.ts'
import { pool, childByKey, supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { createClaudeNativeDispatchReceipt } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import { CLAUDE_CONTINUATION_PROFILE } from '@neutronai/runtime/workers/claude-native-continuation.ts'
import { reserveTrailerSlot } from '@neutronai/runtime/workers/trailer-slot.ts'
import { admitNativeChildWorkspace, bindNativeChildWorkspace, completeNativeChildWorkspace } from '@neutronai/runtime/workers/native-child-workspace.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { prepareProjectBuild } from '../project-build.ts'
import { cancelOriginalClaudeChild } from '../claude-native-cancellation.ts'
import { reconcileClaudeNativeDispatches } from '../claude-native-dispatch-reconcile.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })

async function fixture(deadline = Date.now() + 60_000) {
  const root = await mkdtemp(join(tmpdir(), 'cancel-consuming-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'), work = join(root, 'work')
  const git = (args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
    if (result.exitCode !== 0) throw Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git(['init', '-q', repo]); git(['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '--allow-empty', '-m', 'Fixture'])
  git(['-C', repo, 'worktree', 'add', '-q', '-b', 'work', work])
  const dbPath = join(root, 'db'); seedMigratedDb(dbPath)
  const db = ProjectDb.open(dbPath); cleanup.push(() => db.close())
  seedProject(db, 'project'); seedProject(db, 'sibling')
  const store = new TridentRunStore(db), attempts = new TridentAttemptLedger(db)
  const run = await store.create({ slug: 'cancel', project_slug: 'project', repo_path: repo, task: 'A bounded build' })
  await store.update(run.id, { worktree: work, branch: 'work', base_sha: git(['-C', repo, 'rev-parse', 'HEAD']) })
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'original' })
  const port = admission.forNativeChild('project')
  const sibling = await admission.forNativeChild('sibling').admit('sibling-run', 'build:0')
  if (sibling.status !== 'admitted') throw Error('Expected sibling lease')
  let worker = async (signal: AbortSignal): Promise<BoundedWorkOutcome> => {
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
    return { kind: 'unknown', detail: 'Observation interrupted' }
  }
  const runnerSpy = spyOn(runners, 'createProjectRunners').mockImplementation(async options => ({ provider: options.conversation.provider,
    inRepl: { ...fakeRunner('anthropic'), run: async (_request, _placement, signal) => worker(signal),
      recover: async () => ({ kind: 'unknown', detail: 'Retained worker has no result' }) }, headless: options.headless }))
  const codexSpy = spyOn(codex, 'createCodexHeadlessRunner').mockReturnValue(fakeRunner('openai-codex'))
  const pinSpy = spyOn(capacity, 'loadClaudeCapacityPin').mockReturnValue(undefined)
  const routeSpy = spyOn(capacity, 'nativeRelayRouteFingerprint').mockReturnValue(undefined)
  cleanup.push(() => { runnerSpy.mockRestore(); codexSpy.mockRestore(); pinSpy.mockRestore(); routeSpy.mockRestore() })
  const input = { run: store.get(run.id)!, base_branch: 'main', db_path: dbPath, max_rounds: 3 }
  const context = { store, attempts, projectDir: root, projectId: 'project', stateRoot: join(root, 'state'), provider: 'anthropic' as const,
    providerSource: 'application' as const, env: {}, nativeChildAdmission: port, spawnProjectSession: async () => { throw Error('Cancellation must reuse the original parent') },
    runHost: async (argv: string[]) => ({ ok: true, exit_code: 0, stdout: argv[0] === 'git' ? git(argv.slice(1)) : '', stderr: '' }) }
  const prepared = await prepareProjectBuild(input, context, new AbortController().signal)
  const request = { ...prepared.workers.build.request, run_id: run.id, step_id: 'build:0', role: 'build' as const, needs_approval_decision: false as const }
  const state = join(context.stateRoot, run.id), key = createHash('sha256').update(JSON.stringify([run.id, request.step_id])).digest('hex')
  await mkdir(state, { recursive: true })
  await reserveTrailerSlot(join(state, `claude-step-${key}.json`), JSON.stringify(request), request.result.path)
  const child = await port.admit(run.id, request.step_id)
  if (child.status !== 'admitted') throw Error('Expected child lease')
  const session = new ReplSession('key', 'generation', 'parent', 'channel', work)
  session.toolSurface = 'Agent,SendMessage,TaskStop'
  const transcript = sessionJsonlPath('parent', work, root)
  await mkdir(dirname(transcript), { recursive: true }); await writeFile(transcript, '{"retained":true}\n')
  const inputs: string[] = []
  let acknowledgeOnSubmit = true, lostAck = false
  async function acknowledge() {
    const result = { message: 'Successfully stopped task: child-a (fixture)', task_id: 'child-a', task_type: 'local_agent', command: 'fixture' }
    await appendFile(transcript, [
      { sessionId: 'parent', isSidechain: false, type: 'assistant', uuid: 'assistant', message: { role: 'assistant',
        content: [{ type: 'tool_use', name: 'TaskStop', id: 'stop-tool', input: { task_id: 'child-a' } }] } },
      { sessionId: 'parent', isSidechain: false, type: 'user', sourceToolAssistantUUID: 'assistant', toolUseResult: result,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'stop-tool', content: JSON.stringify(result) }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
  }
  session.attachChild({ pid: process.pid, write() {}, kill() { throw Error('Cannot kill parent') }, hasExited: () => false,
    exited: new Promise(() => {}), submitLine: async line => { inputs.push(line); if (acknowledgeOnSubmit) await acknowledge(); if (lostAck) throw Error('Lost input acknowledgement') } })
  const launch = { version: 1 as const, sessionId: 'parent', childGeneration: 'generation', projectId: 'project',
    executable: { realPath: '/opt/claude', ...CLAUDE_CONTINUATION_PROFILE },
    argv: ['/opt/claude', '--session-id', 'parent', '--tools', session.toolSurface], tools: session.toolSurface.split(',') }
  recordNativeParentLaunchEvidence(session, launch)
  const receipt = createClaudeNativeDispatchReceipt(state, request, port.dispatchAuthority!(child.lease, request, deadline))
  receipt.record({ kind: 'parent-bound', parent: { sessionId: 'parent', childGeneration: 'generation', pid: process.pid,
    processIdentity: readProcessIdentity(process.pid)!, launch } })
  receipt.record({ kind: 'submission-started' }); receipt.record({ kind: 'child-bound', nativeAgentId: 'child-a' }); receipt.close()
  port.finishPreparing!(child.lease)
  const originalWorkspace = await admitNativeChildWorkspace({ session, request, runId: run.id, worktree: work,
    branch: 'work', generation: child.lease.generation, pending: () => port.pending!(), git: async args => git(['-C', work, ...args]) })
  bindNativeChildWorkspace(originalWorkspace)
  let yieldParent!: () => void
  await session.acquireTurn(yieldDispatch => { yieldParent = yieldDispatch }, originalWorkspace)
  yieldParent()
  cleanup.push(() => completeNativeChildWorkspace(originalWorkspace))
  const poolKey = `cancel-${run.id}`
  supervisedBySessionKey.set(poolKey, { project_id: 'project', substrate_instance_id: 'cc-agent-fixture', skip_permissions: true, projectsDir: root } as never)
  pool.set(poolKey, Promise.resolve(session)); childByKey.set(poolKey, session.child)
  const removeParent = () => { pool.delete(poolKey); childByKey.delete(poolKey); supervisedBySessionKey.delete(poolKey) }
  cleanup.push(removeParent)
  const cancellation = () => cancelOriginalClaudeChild({ request, projectId: 'project', stateDir: state,
    admission: new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'restarted' }).forNativeChild('project'), run: () => store.get(run.id) })
  return { db, store, run, attempts, admission, sibling, session, input, prepared, request, state, inputs, acknowledge, cancellation, removeParent,
    setSubmission: (ack: boolean, lost: boolean) => { acknowledgeOnSubmit = ack; lostAck = lost },
    finishWorker: () => { worker = async () => ({ kind: 'unknown', detail: 'Deadline expired' }) } }
}

test('codegen_cancel reaches the original native child through the launcher and production runner wrapper', async () => {
  const f = await fixture()
  let done!: () => void, outcome: BoundedWorkOutcome | undefined
  const settled = new Promise<void>(resolve => { done = resolve })
  const construct = spyOn(host, 'createProjectBuildHost').mockImplementation(async options => ({ runners: {}, workers: {} as never, deps: {} as never,
    run: async (_input, signal) => {
      outcome = await options.substrate.inRepl!.run(f.request, 'in-repl', signal!)
      done()
      return { kind: 'unknown', phase: 'build', step_id: f.request.step_id, detail: 'Stopped worker', cleanup: { kind: 'preserved', detail: 'Stopped' } }
    } }))
  cleanup.push(() => construct.mockRestore())
  const errors: unknown[] = []
  expect((await createProjectLauncher({ store: f.store, prepare: async () => f.prepared, onError: e => { errors.push(e) } })(f.input)).status).toBe('fired')
  const legacy = { cancel: async () => { throw new CodegenTaskNotFoundError(f.run.id) } }
  const api = routeCodegenCancel(legacy as never, f.store, 'owner', buildTridentTerminator({ store: f.store }))
  expect(await api.cancel({ task_id: f.run.id })).toMatchObject({ cancelled: true, dispatch_path: 'trident', phase: 'stopped' })
  await Promise.race([settled, Bun.sleep(2000).then(() => { throw Error('Native cancellation did not settle') })])
  expect(outcome).toMatchObject({ kind: 'failed', class: 'killed' })
  expect(f.inputs).toHaveLength(1)
  expect(f.session.turnSlotHeld).toBe(0)
  expect(f.admission.listLeases('liveChild').map(lease => lease.token)).toEqual([f.sibling.lease.token])
  expect(await Bun.file(f.request.result.path).exists()).toBe(false)
  await Bun.sleep(10)
  expect(errors).toEqual([])
  expect(await api.cancel({ task_id: f.run.id })).toMatchObject({ cancelled: false, already_terminal: true })
  expect(f.inputs).toHaveLength(1)
})

test('original deadline cancels through the production wrapper without an owner stop', async () => {
  const f = await fixture(Date.now() - 1)
  f.finishWorker()
  expect(await f.prepared.substrate.inRepl!.run(f.request, 'in-repl', new AbortController().signal)).toMatchObject({ kind: 'failed', class: 'killed' })
  expect(f.inputs).toHaveLength(1)
})

test('stopped recovery harvests only the original reserved result without spending a stop turn', async () => {
  const f = await fixture()
  await f.store.update(f.run.id, { phase: 'stopped' })
  const bytes = JSON.stringify({ schema: f.request.result.schema, run_id: f.run.id,
    step_id: f.request.step_id, kind: 'blocked', on: 'Original worker returned its result' })
  await writeFile(f.request.result.path, bytes)
  const alternate = join(f.state, 'alternate.result'); await writeFile(alternate, bytes)
  for (const changed of [{ ...f.request, cwd: f.request.cwd + '/changed' },
    { ...f.request, result: { ...f.request.result, path: alternate } }]) {
    expect((await f.prepared.substrate.inRepl!.recover!(changed, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
    expect(f.admission.listLeases('liveChild')).toHaveLength(2)
    expect(f.inputs).toHaveLength(0)
  }
  expect((await f.prepared.substrate.inRepl!.recover!(f.request, 'in-repl', new AbortController().signal)).kind).toBe('blocked')
  expect(f.admission.listLeases('liveChild').map(lease => lease.token)).toEqual([f.sibling.lease.token])
  expect(f.inputs).toHaveLength(0)
})

test('restart consumes a late native stop acknowledgement without a live parent or another input', async () => {
  const f = await fixture()
  expect((await f.cancellation()).kind).toBe('unknown')
  expect(f.inputs).toHaveLength(0)
  await f.store.update(f.run.id, { phase: 'stopped' })
  f.setSubmission(false, true)
  expect((await f.cancellation()).kind).toBe('unknown')
  expect(f.inputs).toHaveLength(1)
  expect(f.session.turnSlotHeld).toBe(1)
  expect((await f.cancellation()).kind).toBe('unknown')
  expect(f.inputs).toHaveLength(1)
  await f.acknowledge(); f.removeParent()
  expect(await f.cancellation()).toEqual({ kind: 'stopped' })
  expect(f.inputs).toHaveLength(1)
  expect(f.admission.listLeases('liveChild').map(lease => lease.token)).toEqual([f.sibling.lease.token])
})

test('the terminal dispatch reconciler cancels a stopped signed child without resuming its build', async () => {
  const f = await fixture()
  const key = { run_id: f.run.id, step_id: f.request.step_id, attempt_id: 'dispatch' }
  await f.attempts.admit({ ...key, phase: 'build', task_id: 'task', head_sha: f.input.run.base_sha!, role: 'build', review_seat: null,
    provider: 'anthropic', requested_model: f.request.model_id, resolved_model: f.request.model_id, placement: 'in-repl', queued_at: 1 })
  await f.attempts.lifecycle(key, { prepared_at: 2, started_at: 3, ended_at: 4, outcome: 'unknown' })
  await f.store.update(f.run.id, { phase: 'stopped' })
  const options = { stateRoot: dirname(f.state), admission: f.admission, runs: f.store, attempts: f.attempts,
    projectIdForRun: () => 'project', listProjectIds: () => ['project', 'sibling'] }
  expect(await reconcileClaudeNativeDispatches(options)).toEqual({ status: 'observed', released: 1, kept: 1 })
  expect(f.inputs).toHaveLength(1)
  expect(f.attempts.get(key)?.outcome).toBe('unknown')
  expect(f.store.get(f.run.id)?.phase).toBe('stopped')
  expect(await reconcileClaudeNativeDispatches(options)).toEqual({ status: 'observed', released: 0, kept: 1 })
  expect(f.inputs).toHaveLength(1)
})
