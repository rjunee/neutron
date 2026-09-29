import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { createClaudeNativeDispatchReceipt, nativeDispatchReceiptPath } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { seedProject } from '@neutronai/gateway/wiring/__tests__/project-admission-fixture.ts'
import { reconcileClaudeNativeDispatches, type ClaudeNativeDispatchReconcileOptions } from '../claude-native-dispatch-reconcile.ts'
import { reapProjectBuildState, PROJECT_BUILD_STATE_RETENTION_MS } from '../project-build-state-reaper.ts'
import { buildOpenGraphComposer } from '../../composer.ts'
import * as recoveryScheduler from '../project-chat-recovery.ts'
import { bindReviewRequest, claimReviewReceipt } from '@neutronai/trident/project-review-receipt.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(projectId: string | null = null, submitted: boolean | 'bound' = false,
  panel?: { role: 'review' | 'synthesis'; change?: (request: BoundedWorkRequest) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'native-boot-proof-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'project.db'); seedMigratedDb(dbPath)
  const db = ProjectDb.open(dbPath); cleanup.push(() => db.close())
  seedProject(db, 'general'); seedProject(db, 'other')
  const runs = new TridentRunStore(db)
  const run = await runs.create({ slug: 'work', project_slug: projectId ?? 'owner', repo_path: join(dir, 'code'), task: 'bounded task' })
  const stateRoot = join(dir, '.trident', 'project-builds')
  const state = join(stateRoot, encodeURIComponent(run.id)); await mkdir(state, { recursive: true })
  const attempts = new TridentAttemptLedger(db)
  const request: BoundedWorkRequest = { run_id: run.id, step_id: `${run.id}:plan:0`, role: 'plan', model_id: 'model', effort: null,
    cwd: join(dir, 'code'), writable: true, network: true, tools: 'edit-and-run', brief: { path: join(dir, 'brief'), integrity: 'digest' },
    result: { path: join(state, 'plan.result'), schema: 'project-plan-v2' }, thread: null, budget: { wall_ms: 100 }, needs_approval_decision: false }
  if (panel) {
    const identity = 'a'.repeat(64)
    const directory = join(state, `review-${identity}`)
    Object.assign(request, { role: panel.role, step_id: `review-${identity}:1:0`, writable: false, tools: 'read-only',
      brief: { path: join(directory, 'brief.json'), integrity: 'digest' }, result: { schema: 'verdict', path: join(directory, 'result.json') } })
    panel.change?.(request)
    await claimReviewReceipt(directory, identity)
    await bindReviewRequest(directory, identity, createHash('sha256').update(JSON.stringify(request)).digest('hex'))
    await writeFile(join(directory, 'request.json'), JSON.stringify(request))
  }
  const key = { run_id: run.id, step_id: request.step_id, attempt_id: 'dispatch' }
  await attempts.admit({ ...key, phase: 'decomposition', task_id: 'task', head_sha: 'a'.repeat(40), role: request.role, review_seat: null,
    provider: 'anthropic', requested_model: 'model', resolved_model: 'model', placement: 'in-repl', queued_at: 1 })
  await attempts.lifecycle(key, { prepared_at: 2, started_at: 3 })
  const original = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'original' })
  const port = original.forNativeChild(projectId)
  const child = await port.admit(run.id, request.step_id)
  if (child.status !== 'admitted') throw new Error('Expected child admission')
  const receipt = createClaudeNativeDispatchReceipt(state, request, port.dispatchAuthority!(child.lease, request))
  if (submitted) {
    receipt.record({ kind: 'parent-bound', parent: { sessionId: 'original-session', childGeneration: 'original-generation', pid: 42, processIdentity: null } })
    receipt.record({ kind: 'submission-started' })
    if (submitted === 'bound') receipt.record({ kind: 'child-bound', nativeAgentId: 'original-child' })
    receipt.close()
  } else receipt.record({ kind: 'not-submitted' })
  port.finishPreparing!(child.lease)
  await runs.update(run.id, { phase: 'failed' })
  if (submitted === 'bound') await attempts.lifecycle(key, { ended_at: 4, outcome: 'unknown' })
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'restarted' })
  const options: ClaudeNativeDispatchReconcileOptions = { stateRoot, admission, runs, attempts,
    projectIdForRun: value => value.project_slug === 'owner' ? null : value.project_slug,
    listProjectIds: () => db.all<{ id: string }>('SELECT id FROM projects WHERE deleted_at IS NULL').map(row => row.id) }
  const path = nativeDispatchReceiptPath(state, request)
  const reservation = join(state, `claude-step-${createHash('sha256').update(JSON.stringify([run.id, request.step_id])).digest('hex')}.json`)
  await writeFile(reservation, JSON.stringify(request) + '\n#dispatch-armed\n')
  return { dir, db, dbPath, stateRoot, state, path, reservation, request, key, run, runs, attempts, admission, options, child }
}

function lateResult(request: BoundedWorkRequest) {
  return { schema: request.result.schema, run_id: request.run_id, step_id: request.step_id, kind: 'completed',
    result: { head: 'a'.repeat(40), diff: '', pr: null, payload: {
      strategy: 'single', rationale: 'One bounded change.', implementationPlan: '- [ ] T1 record a note',
      topTask: '- [ ] T1 record a note', executionSpec: 'Record the requested note.', complexity: 'mechanical', remainingTasks: 0,
    } } }
}

function panelResult(request: BoundedWorkRequest, kind = 'completed') {
  return { schema: request.result.schema, run_id: request.run_id, step_id: request.step_id, kind,
    on: kind === 'blocked' ? 'Owner input required' : undefined,
    result: kind === 'blocked' ? undefined : { verdict: 'APPROVE', findings: [] } }
}

for (const role of ['review', 'synthesis'] as const) for (const kind of ['completed', 'blocked'])
test(`late panel ${role} ${kind} releases only the signed original lease without reviving work`, async () => {
  const f = await fixture('general', 'bound', { role })
  await f.admission.forNativeChild('general').admit(f.run.id, f.request.step_id)
  await f.admission.forNativeChild('other').admit(f.run.id, f.request.step_id)
  expect(await reconcileClaudeNativeDispatches(f.options)).toMatchObject({ released: 0, kept: 3 })
  const attempt = f.attempts.get(f.key)
  await writeFile(f.request.result.path, JSON.stringify(panelResult(f.request, kind)))
  expect(await reconcileClaudeNativeDispatches(f.options)).toMatchObject({ released: 1, kept: 2 })
  expect(f.admission.listLeases('liveChild').some(row => row.token === f.child.lease.token)).toBe(false)
  expect(f.runs.get(f.run.id)?.phase).toBe('failed')
  expect(f.attempts.get(f.key)).toEqual(attempt)
  expect(await reconcileClaudeNativeDispatches(f.options)).toMatchObject({ released: 0, kept: 2 })
})

for (const role of ['review', 'synthesis'] as const)
for (const evidence of ['foreign-step', 'foreign-schema', 'invalid-payload', 'malformed-json', 'unarmed', 'missing-reservation',
  'forged-receipt', 'wrong-token', 'wrong-generation', 'live-run', 'foreign-path', 'foreign-identity', 'invalid-round',
  'invalid-attempt', 'missing-claim', 'foreign-claim', 'changed-request', 'invalidated-claim'] as const)
test(`late panel ${role} preserves ownership on ${evidence}`, async () => {
  const f = await fixture('general', 'bound', { role, change: request => {
    if (evidence === 'foreign-path') Object.assign(request, { result: { ...request.result, path: request.result.path + '.foreign' } })
    if (evidence === 'foreign-identity') Object.assign(request, { step_id: request.step_id.replace('a'.repeat(64), 'b'.repeat(64)) })
    if (evidence === 'invalid-round') Object.assign(request, { step_id: request.step_id.replace(':1:0', ':0:0') })
    if (evidence === 'invalid-attempt') Object.assign(request, { step_id: request.step_id.replace(':1:0', ':1:2') })
  } })
  const result = panelResult(f.request)
  if (evidence === 'foreign-step') result.step_id += ':foreign'
  if (evidence === 'foreign-schema') result.schema = 'project-review'
  if (evidence === 'invalid-payload') result.result = { verdict: 'INVALID', findings: [] }
  if (evidence === 'unarmed') await writeFile(f.reservation, JSON.stringify(f.request))
  if (evidence === 'missing-reservation') await rm(f.reservation)
  if (evidence === 'forged-receipt') await writeFile(f.path, (await readFile(f.path, 'utf8')).replaceAll('original-child', 'forged-child'))
  if (evidence === 'wrong-token') f.db.runSync('UPDATE project_admission_leases SET token = ?', ['sibling-token'])
  if (evidence === 'wrong-generation') f.db.runSync('UPDATE project_admission_leases SET generation = generation + 1')
  if (evidence === 'live-run') await f.runs.update(f.run.id, { phase: 'forge-init' })
  const directory = join(f.state, `review-${'a'.repeat(64)}`)
  const claim = join(directory, 'receipt.json')
  if (evidence === 'missing-claim') await rm(claim)
  if (evidence === 'foreign-claim') await writeFile(claim, (await readFile(claim, 'utf8')).replace('a'.repeat(64), 'b'.repeat(64)))
  if (evidence === 'changed-request') await writeFile(join(directory, 'request.json'), JSON.stringify({ ...f.request, model_id: 'other' }))
  if (evidence === 'invalidated-claim') await writeFile(claim, JSON.stringify({ ...JSON.parse(await readFile(claim, 'utf8')), invalidated: 'input-changed' }))
  await writeFile(f.request.result.path, evidence === 'malformed-json' ? '{' : JSON.stringify(result))
  expect(await reconcileClaudeNativeDispatches(f.options)).toMatchObject({ released: 0, kept: 1 })
})

for (const kind of ['completed', 'blocked']) test(`late ${kind} releases only its authenticated token, without changing the failed run`, async () => {
  const f = await fixture('general', 'bound')
  await f.admission.forNativeChild('general').admit(f.run.id, f.request.step_id)
  await f.admission.forNativeChild('other').admit(f.run.id, f.request.step_id)
  expect((await reconcileClaudeNativeDispatches(f.options))).toMatchObject({ released: 0, kept: 3 })
  await writeFile(f.request.result.path, JSON.stringify(kind === 'completed' ? lateResult(f.request)
    : { ...lateResult(f.request), kind, on: 'Owner input required' }))
  expect(await reconcileClaudeNativeDispatches(f.options)).toEqual({ status: 'observed', released: 1, kept: 2 })
  expect(f.admission.listLeases('liveChild').some(row => row.token === f.child.lease.token)).toBe(false)
  expect(f.runs.get(f.run.id)?.phase).toBe('failed')
  expect(f.attempts.get(f.key)?.outcome).toBe('unknown')
  expect(await reconcileClaudeNativeDispatches(f.options)).toEqual({ status: 'observed', released: 0, kept: 2 })
})

for (const evidence of ['foreign-step', 'foreign-schema', 'invalid-payload', 'forged-receipt', 'wrong-generation', 'wrong-token', 'unarmed', 'live-run', 'missing-reservation', 'malformed-json', 'symlink', 'fifo']) {
  test(`late result preserves ownership on ${evidence}`, async () => {
    const f = await fixture('general', 'bound')
    const result = lateResult(f.request)
    if (evidence === 'foreign-step') result.step_id += ':foreign'
    if (evidence === 'foreign-schema') result.schema = 'unknown'
    if (evidence === 'invalid-payload') result.result.payload.executionSpec = ''
    if (evidence === 'forged-receipt') await writeFile(f.path, (await readFile(f.path, 'utf8')).replaceAll('original-child', 'forged-child'))
    if (evidence === 'wrong-generation') f.db.runSync('UPDATE project_admission_leases SET generation = generation + 1')
    if (evidence === 'wrong-token') f.db.runSync('UPDATE project_admission_leases SET token = ?', ['sibling-token'])
    if (evidence === 'unarmed') await writeFile(f.reservation, JSON.stringify(f.request))
    if (evidence === 'missing-reservation') await rm(f.reservation)
    if (evidence === 'live-run') await f.runs.update(f.run.id, { phase: 'forge-init' })
    await writeFile(f.request.result.path, JSON.stringify(result))
    if (evidence === 'malformed-json') await writeFile(f.request.result.path, '{"kind":')
    if (evidence === 'symlink') {
      const target = join(f.state, 'other.result')
      await writeFile(target, JSON.stringify(result))
      await rm(f.request.result.path)
      await symlink(target, f.request.result.path)
    }
    if (evidence === 'fifo') {
      await rm(f.request.result.path)
      expect(Bun.spawnSync(['mkfifo', f.request.result.path]).exitCode).toBe(0)
    }
    expect(await reconcileClaudeNativeDispatches(f.options)).toEqual({ status: 'observed', released: 0, kept: 1 })
  })
}

test('signed terminal refusal reconciles at restart without resuming the run; other scopes and tokens survive', async () => {
  const f = await fixture()
  await f.admission.forNativeChild(null).admit(f.run.id, f.request.step_id)
  await f.admission.forNativeChild('general').admit(f.run.id, f.request.step_id)
  expect(await reconcileClaudeNativeDispatches(f.options)).toEqual({ status: 'observed', released: 1, kept: 2 })
  expect(f.runs.get(f.run.id)?.phase).toBe('failed')
  expect(f.admission.listLeases('liveChild').some(row => row.token === f.child.lease.token)).toBe(false)
  expect(await reconcileClaudeNativeDispatches(f.options)).toEqual({ status: 'observed', released: 0, kept: 2 })
})

for (const field of ['provider', 'placement', 'resolved_model', 'role', 'prepared_at', 'started_at', 'outcome'] as const) {
  test(`canonical attempt mismatch preserves signed refusal: ${field}`, async () => {
    const f = await fixture()
    const value = field === 'provider' ? 'openai-codex' : field === 'placement' ? 'headless' : field === 'outcome' ? 'completed'
      : field === 'prepared_at' || field === 'started_at' ? null : 'foreign'
    f.db.runSync(`UPDATE code_trident_attempts SET ${field} = ?${field === 'outcome' ? ', ended_at = 4' : ''} WHERE run_id = ?`, [value, f.run.id])
    expect(await reconcileClaudeNativeDispatches(f.options)).toEqual({ status: 'observed', released: 0, kept: 1 })
  })
}

for (const evidence of ['submitted', 'unsigned', 'forged', 'missing', 'torn', 'wrong-scope', 'deleted-project', 'missing-attempt'] as const) {
  test(`boot retains unresolved or foreign child evidence: ${evidence}`, async () => {
    const f = await fixture('general', evidence === 'submitted')
    if (evidence === 'unsigned') f.db.runSync('UPDATE project_admission_leases SET producer = ?', ['native-child:old-boot'])
    if (evidence === 'missing') await rm(f.path)
    if (evidence === 'forged') await writeFile(f.path, (await readFile(f.path, 'utf8')).replaceAll('model', 'other'))
    if (evidence === 'torn') await writeFile(f.path, (await readFile(f.path, 'utf8')).slice(0, -1))
    if (evidence === 'wrong-scope') f.db.runSync('UPDATE code_trident_runs SET project_slug = ? WHERE id = ?', ['other', f.run.id])
    if (evidence === 'deleted-project') f.db.runSync('UPDATE projects SET deleted_at = ? WHERE id = ?', ['2026-01-01', 'general'])
    if (evidence === 'missing-attempt') f.db.runSync('DELETE FROM code_trident_attempts WHERE run_id = ?', [f.run.id])
    expect(await reconcileClaudeNativeDispatches(f.options)).toEqual({ status: 'observed', released: 0, kept: 1 })
  })
}

test('unavailable census is explicit and a later autonomous pass can recover', async () => {
  const f = await fixture()
  const list = f.options.listProjectIds
  f.options.listProjectIds = () => { throw new Error('temporary read failure') }
  expect(await reconcileClaudeNativeDispatches(f.options)).toEqual({ status: 'unavailable' })
  expect(f.admission.listLeases('liveChild')).toHaveLength(1)
  f.options.listProjectIds = list
  expect((await reconcileClaudeNativeDispatches(f.options))).toMatchObject({ status: 'observed', released: 1 })
})

test('reaper retains original unresolved child evidence; exact proven release makes expired state reclaimable', async () => {
  const f = await fixture()
  const now = Date.now() + PROJECT_BUILD_STATE_RETENTION_MS * 2
  const reaper = { stateRoot: f.stateRoot, runs: f.runs, nativeChildren: () => f.admission.listLeases('liveChild'), now }
  expect(await reapProjectBuildState(reaper)).toEqual([])
  expect(await Bun.file(f.path).exists()).toBe(true)
  expect((await reconcileClaudeNativeDispatches(f.options))).toMatchObject({ released: 1 })
  expect(await reapProjectBuildState(reaper)).toEqual([f.run.id])
  expect(await Bun.file(f.path).exists()).toBe(false)
})

test('unreadable and malformed native census cannot discard expired original receipts', async () => {
  const f = await fixture()
  const options = { stateRoot: f.stateRoot, runs: f.runs, now: Date.now() + PROJECT_BUILD_STATE_RETENTION_MS * 2 }
  await expect(reapProjectBuildState({ ...options, nativeChildren: () => { throw new Error('DB unreadable') } })).rejects.toThrow('DB unreadable')
  f.db.runSync('UPDATE project_admission_leases SET work_ref = ?', ['unreadable'])
  expect(await reapProjectBuildState({ ...options, nativeChildren: () => f.admission.listLeases('liveChild') })).toEqual([])
  expect(await Bun.file(f.path).exists()).toBe(true)
})

for (const role of ['plan', 'review', 'synthesis'] as const)
for (const submitted of (role === 'plan' ? [false, 'bound'] : ['bound']) as (false | 'bound')[]) for (const availableAtBoot of [true, false]) test(`actual Open composition consumes terminal evidence without a turn: role=${role}, submitted=${submitted}, present-at-boot=${availableAtBoot}`, async () => {
  const f = await fixture(null, submitted, role === 'plan' ? undefined : { role })
  const artifact = submitted ? f.request.result.path : f.path
  if (submitted) await writeFile(artifact, JSON.stringify(role === 'plan' ? lateResult(f.request) : panelResult(f.request)))
  const bytes = await readFile(artifact, 'utf8')
  if (!availableAtBoot) await rm(artifact)
  const env: NodeJS.ProcessEnv = { ...process.env, NEUTRON_HOME: f.dir, OWNER_HOME: f.dir, NEUTRON_DB_PATH: f.dbPath,
    NEUTRON_INSTANCE_SLUG: 'owner', NEUTRON_LANDING_STATIC_DIR: join(import.meta.dir, '../../../landing'),
    NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'native-reconcile-test-secret-0123456789', NEUTRON_MODEL_PROVIDER: 'anthropic',
    NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: '1' }
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET', 'NEUTRON_PROJECT_MODELS']) delete env[key]
  let turns = 0
  const start = recoveryScheduler.startProjectChatRecovery
  const timer = spyOn(recoveryScheduler, 'startProjectChatRecovery').mockImplementation((recover, onError) => start(recover, onError, 2))
  cleanup.push(() => timer.mockRestore())
  const composition = await buildOpenGraphComposer({ env, substrateFactory: () => ({ start() { turns++; throw new Error('No native turn permitted') } }) })({ db: f.db, project_slug: 'owner' })
  cleanup.push(async () => {
    await composition.on_shutdown_start?.()
    for (const close of composition.realmode_cleanups ?? []) await close()
  })
  expect(f.admission.listLeases('liveChild')).toHaveLength(availableAtBoot ? 0 : 1)
  await composition.on_graph_ready!()
  if (!availableAtBoot) {
    expect(f.admission.listLeases('liveChild')).toHaveLength(1)
    await writeFile(artifact, bytes)
    const until = Date.now() + 1500
    while (f.admission.listLeases('liveChild').length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(f.admission.listLeases('liveChild')).toEqual([])
  expect(f.runs.get(f.run.id)?.phase).toBe('failed')
  expect(turns).toBe(0)
})
