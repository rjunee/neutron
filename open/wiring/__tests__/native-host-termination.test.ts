import { afterEach, expect, spyOn, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import { currentBootId } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import type { NativeHostRecoveryAuthority, NativeHostTerminationPreparation, SignedHostEvidence } from '@neutronai/runtime/workers/native-host-termination.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { seedProject } from '@neutronai/gateway/wiring/__tests__/project-admission-fixture.ts'
import { prepareNativeHostTermination, reconcileNativeHostTerminations, type NativeHostTerminationOptions } from '../native-host-termination.ts'
import { buildOpenGraphComposer } from '../../composer.ts'
import * as authorityLoader from '../../native-host-recovery-authority.ts'
import { prepareConfiguredNativeHostTermination, readHostTerminationPreparation } from '../../prepare-native-host-termination.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'native-host-termination-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'project.db'); seedMigratedDb(path)
  const db = ProjectDb.open(path); cleanup.push(() => db.close())
  seedProject(db, 'project'); seedProject(db, 'other')
  const runs = new TridentRunStore(db)
  const run = await runs.create({ slug: 'old-work', project_slug: 'project', repo_path: join(dir, 'code'), task: 'Specified implementation task' })
  await runs.update(run.id, { phase: 'failed' })
  const step = `${run.id}:plan:0`
  const attempts = new TridentAttemptLedger(db)
  const key = { run_id: run.id, step_id: step, attempt_id: 'dispatch' }
  await attempts.admit({ ...key, phase: 'decomposition', task_id: 'task', head_sha: 'a'.repeat(40), role: 'plan', review_seat: null,
    provider: 'anthropic', requested_model: 'model', resolved_model: 'model', placement: 'in-repl', queued_at: 1 })
  await attempts.lifecycle(key, { prepared_at: 2, started_at: 3 })
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'gateway-before' })
  await admission.forNativeChild('project').admit(run.id, step)
  // The actual problem is an unsigned legacy producer; no dispatch signature is manufactured.
  db.runSync('UPDATE project_admission_leases SET producer = ?', ['native-child:legacy-gateway'])
  const lease = admission.listLeases('liveChild')[0]!
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signed = <T>(body: T): SignedHostEvidence<T> => ({ body, signature: sign(null, Buffer.from(JSON.stringify(body)), privateKey).toString('base64') })
  let kernel = 'old-kernel'
  const authority: NativeHostRecoveryAuthority = {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), hostId: 'operator-host', instanceId: 'canonical-instance',
    async attestBoot(challenge) { return signed({ version: 1, kind: 'host-boot', hostId: this.hostId, instanceId: this.instanceId, bootId: kernel, challenge }) },
  }
  const preparation = signed<NativeHostTerminationPreparation>({ version: 1, kind: 'native-host-termination-preparation',
    operationId: 'recovery-operation', hostId: authority.hostId, instanceId: authority.instanceId,
    bootId: kernel, evidenceDigest: 'a'.repeat(64), lease: { ...lease, reason: 'liveChild' } })
  const options: NativeHostTerminationOptions = { authority, admission, runs, attempts,
    projectIdForRun: r => r.project_slug, listProjectIds: () => ['project', 'other'], kernelBootId: () => kernel }
  return { dir, path, db, admission, runs, run, key, attempts, options, authority, signed, preparation, lease,
    setKernel: (value: string) => { kernel = value } }
}

test('operator preparation bridge resolves the server install and preserves exact refusal semantics', async () => {
  const f = await fixture()
  const boot = currentBootId()!
  expect(boot).toBeTruthy()
  f.setKernel(boot)
  const preparation = f.signed({ ...f.preparation.body, bootId: boot })
  const load = spyOn(authorityLoader, 'loadNativeHostRecoveryAuthority').mockReturnValue(f.authority)
  const env = { NEUTRON_HOME: f.dir, NEUTRON_DB_PATH: f.path, NEUTRON_INSTANCE_SLUG: 'owner' }
  try {
    expect(await prepareConfiguredNativeHostTermination(preparation, { ...env, NEUTRON_INSTANCE_SLUG: 'foreign' })).toBe(false)
    expect(await prepareConfiguredNativeHostTermination(preparation, env)).toBe(true)
    expect(await prepareConfiguredNativeHostTermination(preparation, env)).toBe(true)
    expect(f.admission.maintenance.listHostTerminations()[0]?.termination).toBeNull()
    expect(f.admission.listLeases('liveChild')).toHaveLength(1)
    load.mockReturnValue(undefined)
    expect(await prepareConfiguredNativeHostTermination(preparation, env)).toBe(false)
  } finally { load.mockRestore() }
  async function* input(...chunks: (string | Uint8Array)[]) { yield* chunks }
  expect(await readHostTerminationPreparation(input('{"body":', '{}}'))).toEqual({ body: {} })
  await expect(readHostTerminationPreparation(input(Buffer.alloc(65_537)))).rejects.toThrow('too large')
  await expect(readHostTerminationPreparation(input('{}{}'))).rejects.toThrow()
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../prepare-native-host-termination.ts')],
    { env: { ...process.env, ...env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  child.stdin.write('{}'); child.stdin.end()
  expect(await child.exited).toBe(1)
  expect(await new Response(child.stdout).text()).toBe('{"status":"refused"}\n')
  expect(await new Response(child.stderr).text()).toBe('')
})

test('prepared recovery gates the exact scope, survives restart, and atomically retires only its exact legacy lease', async () => {
  const f = await fixture()
  const beforeRun = f.runs.get(f.run.id); const beforeAttempt = f.attempts.get(f.key)
  await f.admission.forNativeChild('project').admit(f.run.id, 'different-step')
  await f.admission.admit('project', 'build', 'work-board', 'different-run')
  expect(await prepareNativeHostTermination(f.options, f.preparation)).toBe(true)
  expect(await prepareNativeHostTermination(f.options, f.preparation)).toBe(true)
  expect(await f.admission.admit('project', 'conversation', 'chat', 'new')).toMatchObject({ status: 'fenced' })
  expect((await f.admission.forNativeChild('project').admit('different-run', 'new-step')).status).toBe('unknown')
  expect((await f.admission.forNativeChild('other').admit('other-run', 'other-step')).status).toBe('admitted')
  const restart = new ProjectAdmission({ db: f.db, ownerHandle: 'owner', bootId: 'gateway-after' })
  expect(await reconcileNativeHostTerminations({ ...f.options, admission: restart })).toEqual({ status: 'observed', released: 0, kept: 1 })
  expect(restart.hasUnresolvedNativeChildForChat('project')).toBe(true)
  f.setKernel('new-kernel')
  expect(await reconcileNativeHostTerminations({ ...f.options, admission: restart })).toEqual({ status: 'observed', released: 1, kept: 0 })
  expect(restart.listLeases('liveChild').map(row => row.token)).not.toContain(f.lease.token)
  expect(restart.listLeases('liveChild')).toHaveLength(2)
  expect(restart.hasUnresolvedNativeChildForChat('project')).toBe(true) // the other unknown child remains
  const row = restart.maintenance.listHostTerminations()[0]!
  expect(JSON.parse(row.termination!)).toMatchObject({ kind: 'terminated-by-host-reboot', operationId: f.preparation.body.operationId })
  expect(f.runs.get(f.run.id)).toEqual(beforeRun)
  expect(f.attempts.get(f.key)).toEqual(beforeAttempt)
  expect(await reconcileNativeHostTerminations(f.options)).toEqual({ status: 'observed', released: 0, kept: 0 })
  expect(await prepareNativeHostTermination(f.options, f.preparation)).toBe(false)
})

test('preparation reserves its exact lease against ordinary release and survives restored trust', async () => {
  const f = await fixture()
  await f.admission.forNativeChild('project').admit(f.run.id, 'independent-step')
  expect(await prepareNativeHostTermination(f.options, f.preparation)).toBe(true)
  expect(await f.admission.maintenance.release(f.lease)).toBe(false)
  expect(await f.admission.forNativeChild('project').complete(f.run.id, f.key.step_id)).toBe(0)
  expect(await f.admission.forNativeChild('project').complete(f.run.id, 'independent-step')).toBe(1)
  expect(f.admission.listLeases('liveChild').map(row => row.token)).toEqual([f.lease.token])
  const originalPin = f.authority.publicKey
  f.authority.publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  f.setKernel('new-kernel')
  expect((await reconcileNativeHostTerminations(f.options)).status).toBe('unavailable')
  f.authority.publicKey = originalPin
  expect(await reconcileNativeHostTerminations(f.options)).toEqual({ status: 'observed', released: 1, kept: 0 })
  expect(f.admission.hasUnresolvedNativeChildForChat('project')).toBe(false)
})

for (const bad of ['signature', 'host', 'instance', 'evidence', 'kind', 'boot', 'key'] as const) {
  test(`preparation refuses ${bad} without creating a recovery record`, async () => {
    const f = await fixture()
    const value = structuredClone(f.preparation)
    if (bad === 'signature') value.signature = 'invalid'
    if (bad === 'host') value.body.hostId = 'foreign'
    if (bad === 'instance') value.body.instanceId = 'foreign'
    if (bad === 'evidence') value.body.evidenceDigest = ''
    if (bad === 'kind') (value.body as { kind: string }).kind = 'not-submitted'
    if (bad === 'boot') f.setKernel('new-kernel')
    if (bad === 'key') f.authority.publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    // Malformed bodies must refuse even if an authority signed them.
    const submitted = bad === 'signature' || bad === 'key' ? value : f.signed(value.body)
    expect(await prepareNativeHostTermination(f.options, submitted)).toBe(false)
    expect(f.admission.maintenance.listHostTerminations()).toEqual([])
    expect(f.admission.hasUnresolvedNativeChildForChat('project')).toBe(true)
  })
}

for (const changed of ['token', 'generation', 'scope_key', 'producer', 'reason', 'work_ref'] as const) {
  test(`changed lease ${changed} cannot be consumed or reopen the recovery scope`, async () => {
    const f = await fixture()
    expect(await prepareNativeHostTermination(f.options, f.preparation)).toBe(true)
    f.setKernel('new-kernel')
    const value = changed === 'generation' ? 5 : changed === 'scope_key' ? JSON.stringify(['owner', 'other'])
      : changed === 'reason' ? 'build' : 'different'
    if (changed === 'scope_key') await f.admission.maintenance.register({ ownerHandle: 'owner', projectId: 'other' })
    f.db.runSync(`UPDATE project_admission_leases SET ${changed} = ? WHERE token = ?`, [value, f.lease.token])
    expect(await reconcileNativeHostTerminations(f.options)).toEqual({ status: 'observed', released: 0, kept: 1 })
    expect(f.admission.maintenance.listHostTerminations()[0]?.termination).toBeNull()
    expect(f.admission.hasUnresolvedNativeChildForChat('project')).toBe(true)
    expect((await f.admission.admit('project', 'build', 'work-board', 'fresh')).status).toBe('fenced')
  })
}

for (const bad of ['unavailable', 'wrong-host', 'wrong-instance', 'wrong-key', 'stale-challenge', 'boot-disagrees', 'kernel-unreadable', 'torn-preparation'] as const) {
  test(`recovery retains the scope on ${bad}`, async () => {
    const f = await fixture()
    expect(await prepareNativeHostTermination(f.options, f.preparation)).toBe(true)
    f.setKernel('new-kernel')
    if (bad === 'unavailable') f.options.authority = undefined
    if (bad === 'wrong-host') f.authority.hostId = 'another-host'
    if (bad === 'wrong-instance') f.authority.instanceId = 'another-instance'
    if (bad === 'wrong-key') f.authority.publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    if (bad === 'kernel-unreadable') f.options.kernelBootId = () => undefined
    if (bad === 'stale-challenge' || bad === 'boot-disagrees') f.authority.attestBoot = async challenge => f.signed({
      version: 1, kind: 'host-boot', hostId: f.authority.hostId, instanceId: f.authority.instanceId,
      bootId: bad === 'boot-disagrees' ? 'other-kernel' : 'new-kernel', challenge: bad === 'stale-challenge' ? 'replayed' : challenge })
    if (bad === 'torn-preparation') f.db.runSync('UPDATE native_host_terminations SET preparation = ?', ['{'])
    const result = await reconcileNativeHostTerminations(f.options)
    expect(result.status === 'unavailable' || result.released === 0).toBe(true)
    expect(f.admission.listLeases('liveChild')).toHaveLength(1)
    expect(f.admission.hasUnresolvedNativeChildForChat('project')).toBe(true)
  })
}

for (const invalid of ['live-run', 'foreign-scope', 'foreign-owner', 'missing-attempt', 'headless', 'foreign-provider', 'deleted-project'] as const) {
  test(`canonical work eligibility refuses ${invalid}`, async () => {
    const f = await fixture()
    if (invalid === 'live-run') await f.runs.update(f.run.id, { phase: 'task-plan' })
    if (invalid === 'foreign-scope') f.options.projectIdForRun = () => 'other'
    if (invalid === 'foreign-owner') f.options.admission = new ProjectAdmission({ db: f.db, ownerHandle: 'another-owner', bootId: 'boot' })
    if (invalid === 'missing-attempt') f.db.runSync('DELETE FROM code_trident_attempts WHERE run_id = ?', [f.run.id])
    if (invalid === 'headless') f.db.runSync("UPDATE code_trident_attempts SET placement = 'headless' WHERE run_id = ?", [f.run.id])
    if (invalid === 'foreign-provider') f.db.runSync("UPDATE code_trident_attempts SET provider = 'openai-codex' WHERE run_id = ?", [f.run.id])
    if (invalid === 'deleted-project') f.options.listProjectIds = () => []
    expect(await prepareNativeHostTermination(f.options, f.preparation)).toBe(false)
    expect(f.admission.listLeases('liveChild')).toHaveLength(1)
  })
}

test('failure after exact lease deletion rolls back both facts; retry succeeds', async () => {
  const f = await fixture()
  expect(await prepareNativeHostTermination(f.options, f.preparation)).toBe(true)
  f.setKernel('new-kernel')
  f.db.runSync("CREATE TRIGGER interrupt_recovery BEFORE UPDATE ON native_host_terminations BEGIN SELECT RAISE(ABORT, 'interrupted'); END")
  expect(await reconcileNativeHostTerminations(f.options)).toEqual({ status: 'observed', released: 0, kept: 1 })
  expect(f.admission.listLeases('liveChild')).toHaveLength(1)
  expect(f.admission.maintenance.listHostTerminations()[0]?.termination).toBeNull()
  f.db.runSync('DROP TRIGGER interrupt_recovery')
  expect(await reconcileNativeHostTerminations(f.options)).toEqual({ status: 'observed', released: 1, kept: 0 })
  expect(f.admission.hasUnresolvedNativeChildForChat('project')).toBe(false)
  expect((await f.admission.admit('project', 'conversation', 'chat', 'new')).status).toBe('admitted')
})

test('a disk-reopened database consumes preparation through actual Open composition before any native actor', async () => {
  const f = await fixture()
  expect(await prepareNativeHostTermination(f.options, f.preparation)).toBe(true)
  const db = ProjectDb.open(f.path); cleanup.push(() => db.close())
  const realBoot = currentBootId()
  expect(realBoot).toBeDefined()
  f.setKernel(realBoot!)
  const env: NodeJS.ProcessEnv = { ...process.env, NEUTRON_HOME: f.dir, OWNER_HOME: f.dir, NEUTRON_DB_PATH: f.path,
    NEUTRON_INSTANCE_SLUG: 'owner', NEUTRON_LANDING_STATIC_DIR: join(import.meta.dir, '../../../landing'),
    NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'host-termination-test-secret-0123456789', NEUTRON_MODEL_PROVIDER: 'anthropic',
    NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: '1' }
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET', 'NEUTRON_PROJECT_MODELS']) delete env[key]
  let turns = 0
  const composition = await buildOpenGraphComposer({ env, nativeHostRecoveryAuthority: f.authority,
    substrateFactory: () => { expect(f.admission.maintenance.listHostTerminations()[0]?.termination).not.toBeNull()
      return { start() { turns++; throw new Error('No native turn permitted') } } } })({ db, project_slug: 'owner' })
  cleanup.push(async () => { await composition.on_shutdown_start?.(); for (const close of composition.realmode_cleanups ?? []) await close() })
  expect(f.admission.listLeases('liveChild')).toEqual([])
  expect(f.runs.get(f.run.id)?.phase).toBe('failed')
  expect(turns).toBe(0)
})
