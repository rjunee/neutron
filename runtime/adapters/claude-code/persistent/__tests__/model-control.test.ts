import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getPersistentReplModel, switchPersistentReplModel } from '../model-control.ts'
import { pool, supervisedBySessionKey, childByKey, retiringSessionKeys } from '../pool-state.ts'
import { poolKeyFor, retirePersistentRepl } from '../pool.ts'
import { hasUnresolvedNativeChild, hasUnresolvedNativeChildForChat, setNativeChildLiveness } from '../native-child-liveness.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../../../../../tests/support/migrated-db.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplSession } from '../repl-session.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'

const keys: string[] = []
beforeEach(() => setNativeChildLiveness('owner', undefined))
afterEach(() => { for (const key of keys.splice(0)) { pool.delete(key); supervisedBySessionKey.delete(key); childByKey.delete(key); retiringSessionKeys.delete(key) } })

test('a local chat preparation exemption never weakens model and retirement liveness', () => {
  const scope = { user_id: 'owner', conversationProjectId: 'project-a' }
  setNativeChildLiveness('owner', projectId => projectId === 'project-a', () => false)
  expect(hasUnresolvedNativeChild(scope)).toBe(true)
  expect(hasUnresolvedNativeChildForChat(scope)).toBe(false)
  expect(hasUnresolvedNativeChild({ ...scope, conversationProjectId: 'project-b' })).toBe(false)
  setNativeChildLiveness('owner', undefined)
  expect(hasUnresolvedNativeChild(scope)).toBe(false)
  expect(hasUnresolvedNativeChildForChat(scope)).toBe(false)
})

function register(scope: string | null | undefined, sessionId: string, extra: Partial<PersistentReplSubstrateOptions> = {}) {
  const options: PersistentReplSubstrateOptions = {
    substrate_instance_id: 'cc-agent-model-test', user_id: 'owner', project_id: 'general',
    credential_identity: 'credential', frontierModelFloor: true, instance_slug: 'instance',
    ...(scope === undefined ? {} : { conversationProjectId: scope }), ...extra,
  }
  const key = poolKeyFor(options)
  const session = new ReplSession(key, 'generation', sessionId, 'channel', '/tmp')
  session.attachChild({ pid: 1, write() { throw new Error('unexpected input') }, kill() {},
    hasExited: () => false, exited: new Promise(() => {}) })
  keys.push(key); supervisedBySessionKey.set(key, options); pool.set(key, Promise.resolve(session))
  return { key, session }
}

test('General and a literal general project resolve different sessions in both directions', async () => {
  const general = register(null, 'general-conversation')
  const project = register('general', 'literal-general-project')
  expect(general.key).not.toBe(project.key)
  expect((await getPersistentReplModel({ userId: 'owner', projectId: null, instanceSlug: 'instance' })).sessionId).toBe('general-conversation')
  expect((await getPersistentReplModel({ userId: 'owner', projectId: 'general', instanceSlug: 'instance' })).sessionId).toBe('literal-general-project')
  await expect(switchPersistentReplModel({ userId: 'owner', projectId: 'general' }, { sessionId: 'general-conversation', model: 'haiku' })).rejects.toMatchObject({ code: 'session-changed' })
  await expect(switchPersistentReplModel({ userId: 'owner', projectId: null }, { sessionId: 'literal-general-project', model: 'haiku' })).rejects.toMatchObject({ code: 'session-changed' })
})

test('legacy ambiguous General, wrong owner and wrong instance all refuse discovery', async () => {
  register(undefined, 'legacy')
  for (const projectId of [null, 'general']) {
    await expect(getPersistentReplModel({ userId: 'owner', projectId })).rejects.toMatchObject({ code: 'unavailable' })
  }
  register('project', 'known', { project_id: 'project' })
  expect((await getPersistentReplModel({ userId: 'owner', projectId: 'project', instanceSlug: 'instance' })).sessionId).toBe('known')
  await expect(getPersistentReplModel({ userId: 'other', projectId: 'project' })).rejects.toMatchObject({ code: 'unavailable' })
  await expect(getPersistentReplModel({ userId: 'owner', projectId: 'project', instanceSlug: 'other' })).rejects.toMatchObject({ code: 'unavailable' })
})

test('a queued turn is busy before activeTurn exists and becomes available after release', async () => {
  const { session } = register(null, 'conversation')
  const release = await session.acquireTurn()
  expect((await getPersistentReplModel({ userId: 'owner', projectId: null })).status).toBe('busy')
  await expect(switchPersistentReplModel({ userId: 'owner', projectId: null }, { sessionId: 'conversation', model: 'haiku' })).rejects.toMatchObject({ code: 'busy' })
  release()
  expect((await getPersistentReplModel({ userId: 'owner', projectId: null })).status).toBe('unsupported')
})

test('an auxiliary floored substrate never becomes the conversation model control target', async () => {
  register(null, 'conversation')
  register(undefined, 'nudge', { substrate_instance_id: 'cc-nudge-model-test' })
  expect((await getPersistentReplModel({ userId: 'owner', projectId: null })).sessionId).toBe('conversation')
})

test('restart durable child blocks only its exact owner and project retirement and model control', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-child-'))
  const path = join(dir, 'project.db')
  seedMigratedDb(path)
  let db = ProjectDb.open(path)
  try {
    const admission = new ProjectAdmission({ db, ownerHandle: 'durable-owner', bootId: 'before' })
    await admission.forNativeChild(null).admit('failed-run', 'build:0')
    await admission.releaseBuild(null, 'failed-run')
    db.close()
    db = ProjectDb.open(path)
    const restarted = new ProjectAdmission({ db, ownerHandle: 'durable-owner', bootId: 'after' })
    setNativeChildLiveness('owner', projectId => restarted.listLeases('liveChild').some(row => row.scope.projectId === projectId))
    const target = register(null, 'child-parent')
    let killed = false
    let acknowledge!: (code: number | null) => void
    target.session.attachChild({ pid: 2, write() {}, kill() { killed = true; acknowledge(0) },
      hasExited: () => killed, exited: new Promise(resolve => { acknowledge = resolve }) })
    childByKey.set(target.key, target.session.child)
    register('general', 'other-project')
    expect(await retirePersistentRepl(target.key)).toBe('refused')
    expect(killed).toBe(false)
    expect(pool.has(target.key)).toBe(true)
    await expect(switchPersistentReplModel({ userId: 'owner', projectId: null }, { sessionId: 'child-parent', model: 'haiku' })).rejects.toMatchObject({ code: 'busy' })
    expect((await getPersistentReplModel({ userId: 'owner', projectId: 'general' })).status).toBe('unsupported')
    register(null, 'other-owner', { user_id: 'someone-else' })
    expect((await getPersistentReplModel({ userId: 'someone-else', projectId: null })).status).toBe('unsupported')
    await restarted.forNativeChild(null).complete('failed-run', 'build:0')
    expect((await getPersistentReplModel({ userId: 'owner', projectId: null })).status).toBe('unsupported')
    expect(await retirePersistentRepl(target.key)).toBe('retired')
    expect(killed).toBe(true)
  } finally {
    setNativeChildLiveness('owner', undefined)
    expect(hasUnresolvedNativeChild({ user_id: 'owner' })).toBe(false)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
