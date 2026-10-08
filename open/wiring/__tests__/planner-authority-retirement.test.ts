import { afterEach, expect, test } from 'bun:test'
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { createClaudeNativeDispatchReceipt, readClaudeNativeDispatchReceipt, nativeDispatchReceiptPath } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import { PLANNER_PROFILE } from '@neutronai/runtime/workers/planner-work.ts'
import { plannerRetirementDigest, type PlannerAuthorityRetirement } from '@neutronai/runtime/workers/planner-authority-retirement.ts'
import type { NativeHostRecoveryAuthority, SignedHostEvidence } from '@neutronai/runtime/workers/native-host-termination.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { seedProject } from '@neutronai/gateway/wiring/__tests__/project-admission-fixture.ts'
import { retirePlannerAuthority, type PlannerAuthorityRetirementOptions } from '../planner-authority-retirement.ts'
import { reconcileClaudeNativeDispatches } from '../claude-native-dispatch-reconcile.ts'
import { buildOpenGraphComposer } from '../../composer.ts'
import { currentBootId } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(change?: (request: BoundedWorkRequest) => void, boot = 'kernel', profile = PLANNER_PROFILE) {
  const dir = await mkdtemp(join(tmpdir(), 'planner-retirement-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'project.db'); seedMigratedDb(path)
  const db = ProjectDb.open(path); cleanup.push(() => db.close())
  seedProject(db, 'project'); seedProject(db, 'other')
  const runs = new TridentRunStore(db)
  const run = await runs.create({ slug: 'stuck', project_slug: 'project', repo_path: join(dir, 'missing-worktree'), task: 'Specified planner task' })
  await runs.update(run.id, { phase: 'failed' })
  const stateRoot = join(dir, '.trident', 'project-builds'), state = join(stateRoot, encodeURIComponent(run.id))
  await mkdir(state, { recursive: true })
  const request: BoundedWorkRequest = { run_id: run.id, step_id: `${run.id}:plan:0`, role: 'plan', model_id: 'model', effort: null,
    cwd: join(dir, 'missing-worktree'), writable: true, network: false, tools: 'edit', brief: { path: join(state, 'brief'), integrity: 'original' },
    result: { path: join(state, 'plan.result'), schema: 'project-plan-v2' }, thread: null, budget: { wall_ms: 100 }, needs_approval_decision: false }
  change?.(request)
  const attempts = new TridentAttemptLedger(db), key = { run_id: run.id, step_id: request.step_id, attempt_id: 'dispatch' }
  await attempts.admit({ ...key, phase: 'decomposition', task_id: 'task', head_sha: 'a'.repeat(40), role: request.role, review_seat: null,
    provider: 'anthropic', requested_model: 'model', resolved_model: 'model', placement: 'in-repl', queued_at: 1 })
  await attempts.lifecycle(key, { prepared_at: 2, started_at: 3, ended_at: 4, outcome: 'unknown' })
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'original-gateway' }), port = admission.forNativeChild('project')
  const admitted = await port.admit(run.id, request.step_id)
  if (admitted.status !== 'admitted') throw Error('fixture admission failed')
  const writer = createClaudeNativeDispatchReceipt(state, request, port.dispatchAuthority!(admitted.lease, request, 100))
  const parent = { sessionId: 'parent', childGeneration: 'generation', pid: process.pid, processIdentity: { boot_id: boot, start_ticks: 1 },
    launch: { version: 1 as const, sessionId: 'parent', childGeneration: 'generation', projectId: 'project',
      executable: { realPath: '/bin/fixture-native', sha256: 'a'.repeat(64), version: '1.0.0' },
      argv: ['/bin/fixture-native', '--agents', profile], tools: ['Agent', 'SendMessage'] } }
  writer.record({ kind: 'parent-bound', parent }); writer.record({ kind: 'submission-started' }); writer.record({ kind: 'child-bound', nativeAgentId: 'native-child' })
  port.finishPreparing!(admitted.lease)
  const dispatch = readClaudeNativeDispatchReceipt(state, request), lease = admission.listLeases('liveChild')[0]!
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signed = <T>(body: T): SignedHostEvidence<T> => ({ body, signature: sign(null, Buffer.from(JSON.stringify(body)), privateKey).toString('base64') })
  const authority: NativeHostRecoveryAuthority = { publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), hostId: 'host', instanceId: 'install',
    async attestBoot(challenge) { return signed({ version: 1, kind: 'host-boot', hostId: this.hostId, instanceId: this.instanceId, bootId: boot, challenge }) } }
  const body: PlannerAuthorityRetirement = { version: 1, kind: 'planner-authority-retired', policy: 'expired-closed-planner-v1', operationId: 'operation',
    hostId: authority.hostId, instanceId: authority.instanceId, bootId: boot, evidenceDigest: 'a'.repeat(64), lease: { ...lease, reason: 'liveChild' },
    requestDigest: plannerRetirementDigest(request), dispatchDigest: plannerRetirementDigest(dispatch), parent, nativeAgentId: 'native-child',
    observation: { producer: 'operator', observedAt: Date.now(), profile: 'neutron-planner-v1', soleTool: 'mcp__neutron__planner_work',
      invocationDigest: 'b'.repeat(64), nativeEnforcementDigest: 'c'.repeat(64), noPostDispatchToolCalls: true,
      originalExecutor: { pid: process.pid + 1000000, bootId: boot, death: 'observed', evidenceDigest: 'd'.repeat(64) } } }
  const options: PlannerAuthorityRetirementOptions = { authority, stateRoot, admission, runs, attempts, projectIdForRun: value => value.project_slug,
    listProjectIds: () => ['project', 'other'], kernelBootId: () => boot }
  return { dir, db, runs, run, attempts, key, request, state, options, admission, lease, body, signed }
}

test('operator retires exact expired planner without result, worktree, child-exit evidence or parent control; preserves history and siblings', async () => {
  const f = await fixture(), run = f.runs.get(f.run.id), attempt = f.attempts.get(f.key)
  await f.admission.forNativeChild('project').admit(f.run.id, 'sibling')
  const bytes = await readFile(nativeDispatchReceiptPath(f.state, f.request), 'utf8')
  expect(await reconcileClaudeNativeDispatches(f.options)).toMatchObject({ released: 0 })
  expect(await retirePlannerAuthority(f.options, f.signed(f.body))).toEqual({ status: 'released' })
  expect(f.admission.listLeases('liveChild').map(row => row.workRef)).toEqual([JSON.stringify([f.run.id, 'sibling'])])
  expect(f.runs.get(f.run.id)).toEqual(run); expect(f.attempts.get(f.key)).toEqual(attempt)
  expect(await readFile(nativeDispatchReceiptPath(f.state, f.request), 'utf8')).toBe(bytes)
  expect(JSON.parse(f.admission.maintenance.listPlannerRetirements()[0]!.completion!)).toMatchObject({ nativeLoop: 'unknown', outcome: 'unknown' })
  expect(await retirePlannerAuthority(f.options, f.signed(f.body))).toEqual({ status: 'already-retired' })
  const restarted = new ProjectAdmission({ db: f.db, ownerHandle: 'owner', bootId: 'new-gateway' })
  expect((await restarted.forNativeChild('project').admit(f.run.id, f.request.step_id)).status).not.toBe('admitted')
  expect(await retirePlannerAuthority({ ...f.options, admission: restarted }, f.signed(f.body))).toEqual({ status: 'already-retired' })
})

test.each(['forged', 'scope', 'token', 'request', 'dispatch', 'parent', 'child', 'profile', 'tool', 'calls', 'executor', 'kernel'] as const)('refuses %s evidence without blind lease clearing', async change => {
  const f = await fixture(), body = structuredClone(f.body)
  if (change === 'scope') body.lease.scope.projectId = 'other'
  if (change === 'token') body.lease.token = 'foreign'
  if (change === 'request') body.requestDigest = '0'.repeat(64)
  if (change === 'dispatch') body.dispatchDigest = '0'.repeat(64)
  if (change === 'parent') body.parent.sessionId = 'foreign'
  if (change === 'child') body.nativeAgentId = 'foreign'
  if (change === 'profile') (body.observation as { profile: string }).profile = 'unrestricted'
  if (change === 'tool') (body.observation as { soleTool: string }).soleTool = 'Bash'
  if (change === 'calls') (body.observation as { noPostDispatchToolCalls: boolean }).noPostDispatchToolCalls = false
  if (change === 'executor') body.observation.originalExecutor.pid = process.pid
  if (change === 'kernel') body.bootId = 'different'
  const receipt = f.signed(body)
  if (change === 'forged') receipt.signature = Buffer.alloc(64).toString('base64')
  expect(await retirePlannerAuthority(f.options, receipt)).toEqual({ status: 'refused' })
  expect(f.admission.listLeases('liveChild')).toEqual([f.lease])
  expect(f.admission.maintenance.listPlannerRetirements()).toHaveLength(0)
})

test.each(['nonplanner', 'network', 'tools', 'live', 'finished', 'host-preparation'] as const)('refuses ineligible %s work', async change => {
  const f = await fixture(request => {
    if (change === 'nonplanner') request.role = 'build'
    if (change === 'network') request.network = true
    if (change === 'tools') request.tools = 'edit-and-run'
  })
  if (change === 'live') await f.runs.update(f.run.id, { phase: 'forge-init' })
  if (change === 'finished') f.db.runSync("UPDATE code_trident_attempts SET outcome = 'completed' WHERE run_id = ?", [f.run.id])
  if (change === 'host-preparation') expect(await f.admission.maintenance.prepareHostTermination('reserved', f.lease, 'protected-preparation', () => true)).toBe(true)
  expect(await retirePlannerAuthority(f.options, f.signed(f.body))).toEqual({ status: 'refused' })
  expect(f.admission.listLeases('liveChild')).toEqual([f.lease])
})

test('lease stays held behind durable barrier until drain; failed drain remains fenced and retryable', async () => {
  const f = await fixture()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(r => { entered = r }), held = new Promise<void>(r => { release = r })
  const work = retirePlannerAuthority({ ...f.options, drain: async () => { entered(); await held } }, f.signed(f.body))
  await started
  expect(f.admission.maintenance.isPlannerRetired(f.lease.scope, f.lease.workRef)).toBe(true)
  expect(f.admission.listLeases('liveChild')).toEqual([f.lease])
  expect(await f.admission.maintenance.release(f.lease)).toBe(false)
  release(); expect(await work).toEqual({ status: 'released' })
  const second = await fixture()
  expect(await retirePlannerAuthority({ ...second.options, drain: async () => { throw Error('unknown drain') } }, second.signed(second.body))).toEqual({ status: 'refused' })
  expect(second.admission.listLeases('liveChild')).toEqual([second.lease])
  expect(second.admission.maintenance.listPlannerRetirements()[0]?.completion).toBeNull()
  expect(await retirePlannerAuthority(second.options, second.signed(second.body))).toEqual({ status: 'released' })
})


test('actual Open owner route consumes the independently signed retirement without starting a native actor', async () => {
  const boot = currentBootId()!
  expect(boot).toBeTruthy()
  const f = await fixture(undefined, boot)
  const env: NodeJS.ProcessEnv = { ...process.env, NEUTRON_HOME: f.dir, OWNER_HOME: f.dir, NEUTRON_DB_PATH: join(f.dir, 'project.db'),
    NEUTRON_INSTANCE_SLUG: 'owner', NEUTRON_LANDING_STATIC_DIR: join(import.meta.dir, '../../../landing'),
    NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'planner-retirement-test-secret-0123456789', NEUTRON_MODEL_PROVIDER: 'anthropic',
    NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: '1' }
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET', 'NEUTRON_PROJECT_MODELS']) delete env[name]
  let turns = 0
  const token = randomBytes(32).toString('hex')
  const composition = await buildOpenGraphComposer({ env, ownerBearer: token, nativeHostRecoveryAuthority: f.options.authority,
    substrateFactory: () => ({ start() { turns++; throw Error('No native turn permitted') } }) })({ db: f.db, project_slug: 'owner' })
  cleanup.push(async () => { await composition.on_shutdown_start?.(); for (const close of composition.realmode_cleanups ?? []) await close() })
  const call = (authorization: unknown, bearer = token) => composition.admin_respawn_handler!(new Request('http://fixture/admin/retire-planner-authority', {
    method: 'POST', headers: { 'X-Gateway-Token': bearer }, body: JSON.stringify(authorization),
  }))
  expect((await call(f.signed(f.body), 'foreign'))?.status).toBe(403)
  expect((await call({ body: f.body, signature: 'forged' }))?.status).toBe(409)
  expect(f.admission.listLeases('liveChild')).toEqual([f.lease])
  const released = await call(f.signed(f.body))
  expect(released?.status).toBe(200)
  expect(await released?.json()).toEqual({ status: 'released' })
  expect(f.admission.listLeases('liveChild')).toEqual([])
  expect(f.attempts.get(f.key)?.outcome).toBe('unknown')
  expect(turns).toBe(0)
})

test('semantic mutations prove operator authentication, exact dispatch identity, drain and authorized recovery', async () => {
  const source = (await readFile(new URL('../planner-authority-retirement.ts', import.meta.url), 'utf8')).replace(/'(@neutronai\/[^']+)'/g, (_match, specifier: string) => JSON.stringify(import.meta.resolve(specifier)))
  const directory = await mkdtemp(join(tmpdir(), 'planner-retirement-mutants-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const cases = [
    { name: 'authentication', from: '!verifyPlannerAuthorityRetirement(raw, authority)', to: 'false', kind: 'forged' },
    { name: 'dispatch', from: '|| plannerRetirementDigest(dispatch) !== body.dispatchDigest', to: '', kind: 'dispatch' },
    { name: 'drain', from: '(options.drain ?? retirePlannerWork)(request)', to: 'Promise.resolve()', kind: 'drain' },
    { name: 'disabled', from: 'const request = original(options, body)', to: 'const request = undefined', kind: 'disabled' },
  ]
  for (const mutation of cases) {
    expect(source.split(mutation.from)).toHaveLength(2)
    const file = join(directory, mutation.name + '.ts')
    await writeFile(file, source.replace(mutation.from, mutation.to))
    const mutated = await import(file) as { retirePlannerAuthority: typeof retirePlannerAuthority }
    const f = await fixture(), body = structuredClone(f.body)
    if (mutation.kind === 'dispatch') body.dispatchDigest = '0'.repeat(64)
    const receipt = f.signed(body)
    if (mutation.kind === 'forged') receipt.signature = Buffer.alloc(64).toString('base64')
    const options = mutation.kind === 'drain' ? { ...f.options, drain: async () => { throw Error('drain unavailable') } } : f.options
    const expected = mutation.kind === 'disabled' ? 'released' : 'refused'
    expect((await retirePlannerAuthority(options, receipt)).status).toBe(expected)
    const changed = await mutated.retirePlannerAuthority(options, receipt)
    expect(changed.status).toBe(mutation.kind === 'disabled' ? 'refused' : 'released')
  }
})


test.each(['mcpServers', 'hooks', 'skills', 'permissionMode'])('signed offered profile cannot widen the sole-tool boundary through %s', async field => {
  const profile = JSON.parse(PLANNER_PROFILE)
  profile['neutron-planner-v1'][field] = field === 'permissionMode' ? 'bypassPermissions' : { extra: 'fixture' }
  const f = await fixture(undefined, 'kernel', JSON.stringify(profile))
  expect(await retirePlannerAuthority(f.options, f.signed(f.body))).toEqual({ status: 'refused' })
  expect(f.admission.listLeases('liveChild')).toEqual([f.lease])
})
