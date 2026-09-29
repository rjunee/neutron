import { afterEach, expect, spyOn, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import { AttemptAccounting } from '@neutronai/trident/attempt-accounting.ts'
import type { NativeUsageBinding } from '@neutronai/trident/native-usage-binding.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { createNativeDispatchSigner } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { reconcileClaudeNativeUsage } from '../claude-native-usage-reconcile.ts'
import { buildOpenGraphComposer } from '../../composer.ts'
import * as recoveryScheduler from '../project-chat-recovery.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'native-usage-'))
  const path = join(dir, 'project.db'); seedMigratedDb(path)
  let db = ProjectDb.open(path)
  cleanups.push(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
  let runs = new TridentRunStore(db), attempts = new TridentAttemptLedger(db)
  await runs.create({ id: 'run', slug: 'run', project_slug: 'owner', repo_path: dir, task: 'Build' })
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'boot' })
  const native = admission.forNativeChild(null)
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'run:build:0', role: 'build', model_id: 'reported', effort: null,
    cwd: dir, writable: true, tools: 'edit', network: false, brief: { path: join(dir, 'brief'), integrity: 'digest' },
    result: { path: join(dir, 'result'), schema: 'v1' }, thread: null, budget: { wall_ms: 1000 }, needs_approval_decision: false }
  const key = { run_id: 'run', step_id: request.step_id, attempt_id: 'dispatch' }
  await new AttemptAccounting(attempts, dir, async () => {}).prepare(request, 'anthropic', 'in-repl',
    { phase: 'build', task_id: 'task', head_sha: 'head', review_seat: null, requested_model: 'reported' }, async () => {})
  await attempts.lifecycle(key, { started_at: Date.now() })
  const child = await native.admit('run', request.step_id)
  if (child.status !== 'admitted') throw Error('fixture child not admitted')
  const authority = native.dispatchAuthority!(child.lease, request)
  authority.prepare()
  authority.record({ kind: 'parent-bound', parent: { sessionId: 'session', childGeneration: 'generation', pid: process.pid, processIdentity: null } })
  authority.record({ kind: 'submission-started' })
  const receipt = authority.record({ kind: 'child-bound', nativeAgentId: 'child' })
  const directory = join(dir, 'subagents'); await mkdir(directory)
  const binding: NativeUsageBinding = { version: 1, lease: authority.lease, receipt, directory, captured_at: Date.now() }
  const identity = { agentId: 'child', sessionId: 'session', isSidechain: true }
  const assistant = (id: string, count: number | null) => ({ ...identity, type: 'assistant', message: { role: 'assistant', id, model: 'reported',
    usage: { input_tokens: count, output_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count } } })
  const transcript = join(directory, 'agent-child.jsonl')
  const initial = { ...identity, type: 'user', message: { role: 'user', content: `Request (data): ${JSON.stringify(request)}` } }
  await writeFile(transcript, [initial, assistant('prefix', 7)].map(row => JSON.stringify(row)).join('\n') + '\n')
  const options = () => ({ attempts, runs, ownerHandle: 'owner', projectIdForRun: () => null,
    event: async () => {} })
  return { dir, path, request, key, binding, authority, admission, native, initial, transcript, assistant, options,
    get attempts() { return attempts }, get db() { return db },
    archive: () => attempts.archiveNativeUsage(key, binding, request),
    finish: () => attempts.lifecycle(key, { ended_at: Date.now(), outcome: 'completed' }),
    reconcile: () => reconcileClaudeNativeUsage(options()),
    reopen() { db.close(); db = ProjectDb.open(path); runs = new TridentRunStore(db); attempts = new TridentAttemptLedger(db) } }
}

test('archived child usage enriches after lease deletion, generation advance and restart without changing completion', async () => {
  const f = await fixture()
  expect(await f.archive()).toBe('recorded')
  expect(await f.archive()).toBe('duplicate')
  const pin = f.authority.lease; pin.scope.ownerHandle = 'forged'
  expect(f.authority.lease.scope.ownerHandle).toBe('owner')
  await f.finish()
  await f.reconcile()
  const outcome = f.attempts.get(f.key)
  expect(f.attempts.receipt(f.key)).toMatchObject({ input_tokens: 7, cost_usd: null })
  await f.native.complete('run', f.request.step_id)
  expect(f.admission.listLeases('liveChild')).toEqual([])
  await f.db.run('UPDATE project_admission_fences SET generation = generation + 1', [])
  const late = f.assistant('ack', 11)
  await appendFile(f.transcript, [late, late, { ...late, message: { ...late.message, usage: { ...late.message.usage, output_tokens: 13 } } }]
    .map(row => JSON.stringify(row)).join('\n') + '\n')
  // No metadata is needed: this is the exact archived child, not rediscovery.
  await writeFile(join(f.binding.directory, 'agent-foreign.meta.json'), '{"description":"build: run:build:0"}')
  f.reopen()
  expect((await f.reconcile()).observed).toBe(1)
  expect(f.attempts.receipt(f.key)).toMatchObject({ input_tokens: 18, output_tokens: 20, cache_read_tokens: 18, cost_usd: null })
  await f.reconcile()
  expect(f.attempts.receipt(f.key)?.input_tokens).toBe(18)
  expect(f.attempts.get(f.key)).toEqual(outcome)
})

test('unknown, malformed and foreign observations retain earlier spend; missing fields can later become known', async () => {
  const f = await fixture(); await f.archive(); await f.finish(); await f.reconcile()
  await f.db.run('UPDATE code_trident_native_usage_bindings SET binding = ?', ['{}'])
  expect((await f.reconcile()).unavailable).toBe(1)
  expect(f.attempts.receipt(f.key)?.input_tokens).toBe(7)
  await f.db.run('UPDATE code_trident_native_usage_bindings SET binding = ?', [JSON.stringify(f.binding)])
  await rm(f.transcript)
  expect((await f.reconcile()).unavailable).toBe(1)
  expect(f.attempts.receipt(f.key)?.input_tokens).toBe(7)
  for (const rows of ['{', '', JSON.stringify({ ...f.initial, sessionId: 'foreign' }) + '\n']) {
    await writeFile(f.transcript, rows)
    await f.reconcile()
    expect(f.attempts.receipt(f.key)?.input_tokens).toBe(7)
  }
  const partial = f.assistant('ack', null)
  await writeFile(f.transcript, [f.initial, f.assistant('prefix', 7), partial].map(row => JSON.stringify(row)).join('\n') + '\n')
  await f.reconcile()
  expect(f.attempts.receipt(f.key)?.input_tokens).toBe(7)
  await appendFile(f.transcript, JSON.stringify(f.assistant('ack', 9)) + '\n')
  await f.reconcile()
  expect(f.attempts.receipt(f.key)).toMatchObject({ input_tokens: 16, cost_usd: null })
})

test('archive conflicts, self-selected keys, changed full requests and foreign canonical identities are refused', async () => {
  const f = await fixture(); await f.archive(); await f.finish()
  await expect(f.attempts.archiveNativeUsage(f.key, { ...f.binding, directory: join(f.dir, 'other') }, f.request)).rejects.toThrow('conflict')
  await expect(f.attempts.archiveNativeUsage(f.key, f.binding, { ...f.request, budget: { wall_ms: 2000 } })).rejects.toThrow('authenticated')
  const attacker = createNativeDispatchSigner()
  const forged = attacker.begin({ ...f.binding.lease, producer: `native-child:forged:${attacker.keyDigest}` }, f.request)
  forged.prepare(); forged.record({ kind: 'parent-bound', parent: f.binding.receipt.body.parent! }); forged.record({ kind: 'submission-started' })
  const counterfeit = forged.record({ kind: 'child-bound', nativeAgentId: 'child' })
  await expect(f.attempts.archiveNativeUsage(f.key, { ...f.binding, receipt: counterfeit }, f.request)).rejects.toThrow('authenticated')
  // Even a caller trying to replace the independent pin cannot rewrite the archive.
  await expect(f.attempts.archiveNativeUsage(f.key, { ...f.binding, lease: forged.lease, receipt: counterfeit }, f.request)).rejects.toThrow('conflict')
  for (const mutate of [
    (b: NativeUsageBinding) => { b.receipt.publicKey = 'self-selected-key' },
    (b: NativeUsageBinding) => { b.lease.producer = 'native-child:other:' + '0'.repeat(64) },
    (b: NativeUsageBinding) => { b.receipt.body.nativeAgentId = 'foreign' },
    (b: NativeUsageBinding) => { b.receipt.body.parent!.sessionId = 'foreign' },
    (b: NativeUsageBinding) => { b.receipt.body.request = { ...f.request, run_id: 'foreign' } },
  ]) {
    const changed = structuredClone(f.binding); mutate(changed)
    await expect(f.attempts.archiveNativeUsage(f.key, changed, f.request)).rejects.toThrow()
  }
  expect((await reconcileClaudeNativeUsage({ ...f.options(), ownerHandle: 'foreign' })).unavailable).toBe(1)
  expect((await reconcileClaudeNativeUsage({ ...f.options(), projectIdForRun: () => 'foreign' })).unavailable).toBe(1)
  for (const [field, value] of [['role', 'fix'], ['resolved_model', 'foreign'], ['provider', 'openai-codex'],
    ['placement', 'headless'], ['prepared_at', null], ['started_at', null]] as const) {
    const previous = f.attempts.get(f.key)![field]
    await f.db.run(`UPDATE code_trident_attempts SET ${field} = ? WHERE run_id = ?`, [value, 'run'])
    expect((await f.reconcile()).unavailable).toBe(1)
    await f.db.run(`UPDATE code_trident_attempts SET ${field} = ? WHERE run_id = ?`, [previous, 'run'])
  }
  expect((await f.reconcile()).observed).toBe(1)
})

test('overlapping passes refuse across ledger wrappers; each pass bounds its backlog', async () => {
  const f = await fixture(); await f.archive(); await f.finish()
  const release = f.attempts.acquireNativeUsagePass()!
  try {
    expect(await reconcileClaudeNativeUsage({ ...f.options(), attempts: new TridentAttemptLedger(f.db) }))
      .toEqual({ status: 'busy', observed: 0, unavailable: 0 })
  } finally { release() }
  for (let i = 0; i < 20; i++) {
    const identity = { ...f.attempts.get(f.key)!, step_id: `other-${i}` }
    await f.attempts.admit(identity)
    await f.attempts.lifecycle(identity, { ended_at: Date.now(), outcome: 'unknown' })
    await f.db.run('INSERT INTO code_trident_native_usage_bindings (run_id, step_id, attempt_id, binding) VALUES (?, ?, ?, ?)',
      ['run', identity.step_id, 'dispatch', JSON.stringify(f.binding)])
  }
  expect(f.attempts.nativeUsageCandidates()).toHaveLength(16)
  const firstKeys = f.attempts.nativeUsageCandidates().map(key => key.step_id)
  const fixedNow = Date.now()
  const fixed = spyOn(Date, 'now').mockReturnValue(fixedNow)
  try {
    const first = await f.reconcile()
    expect(first.observed + first.unavailable).toBe(16)
    expect(f.attempts.nativeUsageCandidates().slice(0, 5).every(k => !firstKeys.includes(k.step_id))).toBe(true)
    expect(f.attempts.receipt(f.key)).toBeNull()
    const second = await f.reconcile()
    expect(second.observed).toBe(1)
    expect(f.attempts.receipt(f.key)?.input_tokens).toBe(7)
  } finally { fixed.mockRestore() }
  let tick = Date.now()
  const clock = spyOn(Date, 'now').mockImplementation(() => { tick += 1001; return tick })
  try { expect(await f.reconcile()).toEqual({ status: 'observed', observed: 0, unavailable: 0 }) }
  finally { clock.mockRestore() }
})

test('actual Open startup and recurring recovery enrich an archived ended attempt without dispatch or a lease', async () => {
  const f = await fixture(); await f.archive(); await f.finish(); await f.native.complete('run', f.request.step_id)
  const before = f.attempts.get(f.key)
  const env: NodeJS.ProcessEnv = { ...process.env, NEUTRON_HOME: f.dir, OWNER_HOME: f.dir, NEUTRON_DB_PATH: f.path,
    NEUTRON_INSTANCE_SLUG: 'owner', NEUTRON_LANDING_STATIC_DIR: join(import.meta.dir, '../../../landing'),
    NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'native-usage-test-secret-0123456789', NEUTRON_MODEL_PROVIDER: 'anthropic',
    NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: '1' }
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET', 'NEUTRON_PROJECT_MODELS']) delete env[key]
  let turns = 0
  const start = recoveryScheduler.startProjectChatRecovery
  const timer = spyOn(recoveryScheduler, 'startProjectChatRecovery').mockImplementation((recover, onError) => start(recover, onError, 2))
  cleanups.push(async () => { timer.mockRestore() })
  const composition = await buildOpenGraphComposer({ env, substrateFactory: () => ({ start() { turns++; throw Error('No native turn permitted') } }) })({ db: f.db, project_slug: 'owner' })
  cleanups.push(async () => {
    await composition.on_shutdown_start?.()
    for (const close of composition.realmode_cleanups ?? []) await close()
  })
  expect(f.attempts.receipt(f.key)?.input_tokens).toBe(7)
  await composition.on_graph_ready!()
  await appendFile(f.transcript, JSON.stringify(f.assistant('late-ack', 11)) + '\n')
  const until = Date.now() + 1500
  while (f.attempts.receipt(f.key)?.input_tokens !== 18 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
  expect(f.attempts.receipt(f.key)).toMatchObject({ input_tokens: 18, cost_usd: null })
  expect(f.attempts.get(f.key)).toEqual(before)
  expect(f.admission.listLeases('liveChild')).toEqual([])
  expect(turns).toBe(0)
})
