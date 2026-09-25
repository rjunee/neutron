import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmission } from '../../project-admission.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { seedProject } from './project-admission-fixture.ts'
import { buildLlmCallSubstrate, collectTokensToString, type BuildLlmCallSubstrateInput } from '../build-llm-call-substrate.ts'
import { PROFILE_PHASE_SPEC, PROFILE_WARM_FIRE } from '../substrate-profiles.ts'
import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { PersistentReplSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/persistent/types.ts'
import { poolKeyFor, retirePersistentRepl } from '@neutronai/runtime/adapters/claude-code/persistent/pool.ts'
import { pool, supervisedBySessionKey, childByKey, retiringSessionKeys } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { ReplSession } from '@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts'
import { registerSupervisedSubstrate } from '@neutronai/runtime/adapters/claude-code/persistent/supervision.ts'
import { hasUnresolvedNativeChild, setNativeChildLiveness } from '@neutronai/runtime/adapters/claude-code/persistent/native-child-liveness.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })

async function fixture(overrides: Partial<BuildLlmCallSubstrateInput> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-child-scope-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'project.db')
  seedMigratedDb(path)
  const db = ProjectDb.open(path)
  cleanup.push(() => db.close())
  seedProject(db, 'alpha'); seedProject(db, 'general')
  const admission = new ProjectAdmission({ db, ownerHandle: 'scope-owner', bootId: 'scope-boot' })
  setNativeChildLiveness('scope-owner', id => admission.listLeases('liveChild').some(row => row.scope.projectId === id))
  cleanup.push(() => setNativeChildLiveness('scope-owner', undefined))
  const seen: PersistentReplSubstrateOptions[] = []
  const substrate = buildLlmCallSubstrate({
    pool: newCredentialPool({ strategy: 'fill_first', credentials: [{ id: 'anthropic:scope', kind: 'api_key', secret: 'fixture-key' }] }),
    substrate_instance_id: 'cc-agent-scope-test', user_id: 'scope-owner', cwd: dir, ownerConversation: true,
    ...overrides,
    substrateFactory: options => ({ start: () => {
      seen.push(options)
      return { events: (async function* () { yield { kind: 'completion' as const, substrate_instance_id: options.substrate_instance_id,
        session: { id: 'scope-session', last_active_at: Date.now() }, usage: { input_tokens: 0, output_tokens: 0 } } })(),
        respondToTool: async () => {}, cancel: async () => {}, tool_resolution: 'internal' as const }
    } }),
  })
  const capture = async (metering_context?: NonNullable<AgentSpec['metering_context']>) => {
    await collectTokensToString(substrate!.start({ prompt: 'scope', tools: [], model_preference: [], ...(metering_context ? { metering_context } : {}) }), new AbortController().signal)
    return seen.at(-1)!
  }
  return { dir, admission, capture }
}

test.each(['alpha', null, 'general'] as const)('owner wake preserves exact scope %s and retirement waits only for its child', async scope => {
  const f = await fixture()
  const project_id = scope ?? 'general'
  const stamped = await f.capture({ project_id, conversationProjectId: scope })
  const wake = await f.capture(scope === 'general' ? { project_id, conversationProjectId: scope } : { project_id })
  expect(wake.conversationProjectId).toBe(scope)
  expect(poolKeyFor(wake)).toBe(poolKeyFor(stamped))
  expect((await f.admission.forNativeChild(scope).admit('run', 'step')).status).toBe('admitted')
  const key = poolKeyFor(wake)
  const session = new ReplSession(key, 'generation', 'scope-session', 'channel', f.dir)
  let killed = false
  let acknowledge!: (code: number | null) => void
  session.attachChild({ pid: 2, write() {}, kill() { killed = true; acknowledge(0) }, hasExited: () => killed,
    exited: new Promise(resolve => { acknowledge = resolve }) })
  pool.set(key, Promise.resolve(session)); childByKey.set(key, session.child); supervisedBySessionKey.set(key, wake)
  cleanup.push(() => { pool.delete(key); childByKey.delete(key); supervisedBySessionKey.delete(key); retiringSessionKeys.delete(key) })
  expect(await retirePersistentRepl(key)).toBe('refused')
  expect(killed).toBe(false)
  expect(f.admission.listLeases('liveChild')).toHaveLength(1)
  expect(hasUnresolvedNativeChild(await f.capture({ project_id: 'unrelated', conversationProjectId: 'unrelated' }))).toBe(false)
  const opposite = scope === null ? 'general' : null
  expect(hasUnresolvedNativeChild(await f.capture({ project_id: opposite ?? 'general', conversationProjectId: opposite }))).toBe(false)
  await f.admission.forNativeChild(scope).complete('run', 'step')
  expect(await retirePersistentRepl(key)).toBe('retired')
  expect(killed).toBe(true)
})

test.each([['setup', PROFILE_PHASE_SPEC], ['fire', PROFILE_WARM_FIRE]] as const)('trusted %s helper retires without applying the owner child census', async (role, profile) => {
  const f = await fixture({ ownerConversation: false, profile })
  const options = await f.capture()
  expect(options.nativeChildCensusRole).toBe(role)
  expect(options.conversationProjectId).toBeUndefined()
  expect(f.admission.listLeases('liveChild')).toEqual([])
  const key = poolKeyFor(options)
  const session = new ReplSession(key, 'generation', 'helper-session', 'channel', f.dir)
  let killed = false
  let acknowledge!: (code: number | null) => void
  session.attachChild({ pid: 2, write() {}, kill() { killed = true; acknowledge(0) }, hasExited: () => killed,
    exited: new Promise(resolve => { acknowledge = resolve }) })
  pool.set(key, Promise.resolve(session)); childByKey.set(key, session.child); supervisedBySessionKey.set(key, options)
  cleanup.push(() => { pool.delete(key); childByKey.delete(key); supervisedBySessionKey.delete(key); retiringSessionKeys.delete(key) })
  expect(await retirePersistentRepl(key)).toBe('retired')
  expect(killed).toBe(true)
  // A profile-shaped clone and a helper-looking name are not constructor authority.
  const untrusted = await fixture({ ownerConversation: false, profile: { ...profile }, substrate_instance_id: 'cc-llm-sibling' })
  const clone = await untrusted.capture()
  expect(clone.nativeChildCensusRole).toBeUndefined()
  expect(hasUnresolvedNativeChild(clone)).toBe(true)
})

test.each([null, 'general', 'alpha'])('an auxiliary marker cannot weaken explicit owner scope %s', async scope => {
  const f = await fixture({ ownerConversation: false, profile: PROFILE_PHASE_SPEC })
  await f.admission.forNativeChild(scope).admit('run', 'step')
  const scoped = await f.capture({ project_id: scope ?? 'general', conversationProjectId: scope })
  expect(hasUnresolvedNativeChild(scoped)).toBe(true)
  const owner = await fixture({ ownerConversation: true, profile: PROFILE_PHASE_SPEC })
  expect((await owner.capture({ project_id: scope ?? 'general', conversationProjectId: scope })).nativeChildCensusRole).toBeUndefined()
})

test('same-key supervision cannot erase named scope; ambiguous legacy scope stays uncertain', async () => {
  const f = await fixture()
  const stamped = await f.capture({ project_id: 'alpha', conversationProjectId: 'alpha' })
  const { conversationProjectId: _scope, ...unstamped } = stamped
  const key = poolKeyFor(stamped)
  cleanup.push(() => supervisedBySessionKey.delete(key))
  registerSupervisedSubstrate({ ...stamped, replRegistryPath: join(f.dir, 'registry.json') })
  registerSupervisedSubstrate({ ...unstamped, replRegistryPath: join(f.dir, 'registry.json') })
  expect(supervisedBySessionKey.get(key)?.conversationProjectId).toBe('alpha')
  await f.admission.forNativeChild('alpha').admit('run', 'step')
  expect(hasUnresolvedNativeChild(unstamped)).toBe(true)
  expect(hasUnresolvedNativeChild({ user_id: 'scope-owner' })).toBe(true)
  expect(hasUnresolvedNativeChild({ user_id: 'scope-owner', project_id: 'general' })).toBe(true)
  expect(hasUnresolvedNativeChild({ user_id: 'scope-owner', project_id: 'default' })).toBe(true)
  expect(hasUnresolvedNativeChild({ user_id: 'scope-owner', project_id: 'general', conversationProjectId: null })).toBe(false)
  expect(hasUnresolvedNativeChild({ user_id: 'different-owner', project_id: 'alpha', conversationProjectId: 'alpha' })).toBe(false)
})
