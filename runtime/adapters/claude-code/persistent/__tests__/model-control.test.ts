import { afterEach, expect, test } from 'bun:test'
import { getPersistentReplModel, switchPersistentReplModel } from '../model-control.ts'
import { pool, supervisedBySessionKey } from '../pool-state.ts'
import { poolKeyFor } from '../pool.ts'
import { ReplSession } from '../repl-session.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'

const keys: string[] = []
afterEach(() => { for (const key of keys.splice(0)) { pool.delete(key); supervisedBySessionKey.delete(key) } })

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
