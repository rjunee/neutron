import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { lifecycleReplHost } from '../support/lifecycle-repl-host.ts'
import { createPersistentReplSubstrate, poolKeyFor, retirePersistentRepl, shutdownAllPersistentRepls } from '@neutronai/runtime/adapters/claude-code/persistent/pool.ts'
import { pool, retiringSessionKeys, supervisedBySessionKey, committedDispatches } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { saveRegistry, loadRegistry } from '@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts'
import { respawnReplSession, runReplWatchdogTick } from '@neutronai/runtime/adapters/claude-code/persistent/supervision.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { PersistentReplSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/persistent/types.ts'
import { setNativeChildLiveness } from '@neutronai/runtime/adapters/claude-code/persistent/native-child-liveness.ts'

const dirs: string[] = []
const censusOwners: string[] = []
const projectId = 'helper-project'
afterEach(async () => {
  await shutdownAllPersistentRepls()
  retiringSessionKeys.clear()
  for (const owner of censusOwners.splice(0)) setNativeChildLiveness(owner, undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function until(check: () => boolean) {
  const limit = Date.now() + 5000
  while (!check() && Date.now() < limit) await Bun.sleep(10)
  expect(check()).toBe(true)
}
async function drain(handle: SessionHandle) {
  const events = []
  for await (const event of handle.events) events.push(event)
  expect(events.some(event => event.kind === 'completion')).toBe(true)
  expect(events.some(event => event.kind === 'error')).toBe(false)
}
async function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'helper-retirement-'))
  dirs.push(cwd)
  // Composer tests register a process-global owner census. Own this fixture's
  // identity and scope so ordered runs exercise retirement past that preflight.
  const owner = `helper-owner-${randomUUID()}`
  const censusReads: Array<string | null> = []
  let census: (scope: string | null) => boolean = () => false
  setNativeChildLiveness(owner, scope => { censusReads.push(scope); return census(scope) })
  censusOwners.push(owner)
  const peer = lifecycleReplHost()
  const reservation = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const sinkPort = reservation.port!
  await reservation.stop(true)
  const options: PersistentReplSubstrateOptions = {
    substrate_instance_id: `cc-llm-${cwd}`, cwd, user_id: owner, credential_identity: 'credential',
    project_id: projectId, conversationProjectId: projectId,
    ptyHost: peer.host, skipTrustSeed: true, idleQuietMs: 0, sinkPort,
  }
  const substrate = createPersistentReplSubstrate(options)
  const spec = { prompt: 'onboarding detail', tools: [], model_preference: ['sonnet'] }
  return { cwd, peer, options, substrate, spec, key: poolKeyFor(options), censusReads,
    setCensus(query: typeof census) { census = query } }
}

test('setup keeps one child through onboarding, retires when complete and fences respawn', async () => {
  const s = await setup()
  await drain(s.substrate.start(s.spec))
  await drain(s.substrate.start(s.spec))
  expect(s.peer.children).toHaveLength(1)
  expect(s.peer.children[0]!.prompts).toHaveLength(2)
  await until(() => pool.has(s.key))
  await until(() => !s.peer.children[0]!.child.hasExited())
  // The terminal event can arrive one microtask before driver cleanup.
  await until(() => (committedDispatches.get(s.key) ?? 0) === 0)
  expect(await retirePersistentRepl(s.key)).toBe('retired')
  expect(s.peer.children[0]!.child.hasExited()).toBe(true)
  expect(pool.has(s.key)).toBe(false)
  expect(respawnReplSession(s.options, s.key, 'wedge-watchdog', 'test', true).ok).toBe(false)
})

test('retiring during setup waits for both active and queued turns', async () => {
  const s = await setup()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  s.peer.holdReplies(() => gate)
  const first = drain(s.substrate.start(s.spec))
  const second = drain(s.substrate.start(s.spec))
  await until(() => s.peer.children[0]?.prompts.length === 1)
  expect(await retirePersistentRepl(s.key)).toBe('deferred')
  expect(s.peer.children[0]!.child.hasExited()).toBe(false)
  release()
  await Promise.all([first, second])
  await until(() => s.peer.children[0]!.child.hasExited())
  expect(s.peer.children[0]!.prompts).toHaveLength(2)
  expect(pool.has(s.key)).toBe(false)
})

test('changed registry generation refuses retirement and preserves its row and live child', async () => {
  const s = await setup()
  await drain(s.substrate.start(s.spec))
  await until(() => (committedDispatches.get(s.key) ?? 0) === 0)
  const session = await pool.get(s.key)!
  const path = join(s.cwd, 'repl-registry.json')
  supervisedBySessionKey.set(s.key, { ...s.options, replRegistryPath: path })
  const row = { sessionKey: s.key, sessionId: session.sessionId, child_generation: 'replacement',
    cwd: s.cwd, channelName: session.channelName, has_session: true, conversationProjectId: projectId }
  saveRegistry(path, { [s.key]: row })
  expect(await retirePersistentRepl(s.key)).toBe('refused')
  expect(s.peer.children[0]!.child.hasExited()).toBe(false)
  expect(loadRegistry(path)[s.key]).toEqual(row)
})

test('matching registry identity is removed only after the child exits; other rows survive', async () => {
  const s = await setup()
  await drain(s.substrate.start(s.spec))
  await until(() => (committedDispatches.get(s.key) ?? 0) === 0)
  const session = await pool.get(s.key)!
  const path = join(s.cwd, 'repl-registry.json')
  supervisedBySessionKey.set(s.key, { ...s.options, replRegistryPath: path })
  const row = { sessionKey: s.key, sessionId: session.sessionId, child_generation: session.childGeneration,
    cwd: s.cwd, channelName: session.channelName, has_session: true, conversationProjectId: projectId }
  const unrelated = { ...row, sessionKey: 'owner-chat', sessionId: 'different-session' }
  saveRegistry(path, { [s.key]: row, 'owner-chat': unrelated })
  const kill = s.peer.children[0]!.child.kill
  let rowExistedAtKill = false
  s.peer.children[0]!.child.kill = signal => {
    rowExistedAtKill = loadRegistry(path)[s.key]?.sessionId === session.sessionId
    kill(signal)
  }
  expect(await retirePersistentRepl(s.key)).toBe('retired')
  expect(rowExistedAtKill).toBe(true)
  expect(s.peer.children[0]!.child.hasExited()).toBe(true)
  expect(loadRegistry(path)[s.key]).toBeUndefined()
  expect(loadRegistry(path)['owner-chat']).toEqual(unrelated)
})

test('cancelling a disposable background worker closes it and leaves the chat child usable', async () => {
  const s = await setup()
  await drain(s.substrate.start(s.spec))
  await until(() => (committedDispatches.get(s.key) ?? 0) === 0)
  const background = createPersistentReplSubstrate({ ...s.options,
    substrate_instance_id: 'cc-nudge-test', ephemeral: true })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  s.peer.holdReplies(() => gate)
  const handle = background.start(s.spec)
  await until(() => s.peer.children[1]?.prompts.length === 1)
  await handle.cancel()
  const events = []
  for await (const event of handle.events) events.push(event)
  expect(events.some(event => event.kind === 'completion')).toBe(false)
  await until(() => s.peer.children[1]!.child.hasExited())
  expect(s.peer.children[0]!.child.hasExited()).toBe(false)
  release()
  s.peer.holdReplies()
  await drain(s.substrate.start(s.spec))
  expect(s.peer.children).toHaveLength(2)
  expect(s.peer.children[0]!.prompts).toHaveLength(2)
})

test.each([
  { screen: 'Finished\n❯\n', outcome: 'retired' },
  { screen: 'Working\n❯\nesc to interrupt', outcome: 'refused' },
  { screen: 'unrecognized screen', outcome: 'refused' },
  { screen: null, outcome: 'refused' },
])('an adopted legacy helper needs fresh positive idle evidence: $outcome $screen', async ({ screen, outcome }) => {
  const s = await setup()
  await drain(s.substrate.start(s.spec))
  await until(() => (committedDispatches.get(s.key) ?? 0) === 0)
  const session = await pool.get(s.key)!
  session.adopted = true
  session.child.readScreen = async () => {
    if (screen === null) throw new Error('capture unavailable')
    return screen
  }
  expect(await retirePersistentRepl(s.key)).toBe(outcome)
  expect(session.hasChildExited()).toBe(outcome === 'retired')
})

test('a watchdog probe already in flight cannot report a deliberately retired helper as crashed', async () => {
  const s = await setup()
  await drain(s.substrate.start(s.spec))
  await until(() => (committedDispatches.get(s.key) ?? 0) === 0)
  const session = await pool.get(s.key)!
  const path = join(s.cwd, 'repl-registry.json')
  let crashReports = 0
  const options = { ...s.options, replRegistryPath: path, onChildCrash: async () => { crashReports += 1 } }
  supervisedBySessionKey.set(s.key, options)
  saveRegistry(path, { [s.key]: { sessionKey: s.key, sessionId: session.sessionId,
    child_generation: session.childGeneration, cwd: s.cwd, channelName: session.channelName,
    has_session: true, conversationProjectId: projectId, first_ready_at: Date.now() - 100_000 } })
  let release!: () => void
  let probing = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const tick = runReplWatchdogTick(options, { healthProbe: async () => { probing = true; await gate; return false } })
  await until(() => probing)
  expect(await retirePersistentRepl(s.key)).toBe('retired')
  release()
  await tick
  expect(crashReports).toBe(0)
  expect(s.peer.children).toHaveLength(1)
})

test.each(['same-project-child', 'other-project-child', 'census-error', 'unknown-scope'])
('supervised HTTP helper retirement requires a clear project census: %s', async state => {
  const s = await setup()
  await drain(s.substrate.start(s.spec))
  await until(() => (committedDispatches.get(s.key) ?? 0) === 0)
  const session = await pool.get(s.key)!
  const path = join(s.cwd, 'repl-registry.json')
  const options = { ...s.options, replRegistryPath: path }
  if (state === 'unknown-scope') {
    delete options.project_id
    delete options.conversationProjectId
  }
  supervisedBySessionKey.set(s.key, options)
  const row = { sessionKey: s.key, sessionId: session.sessionId, child_generation: session.childGeneration,
    cwd: s.cwd, channelName: session.channelName, has_session: true, conversationProjectId: projectId }
  saveRegistry(path, { [s.key]: row })
  s.setCensus(scope => {
    if (state === 'census-error') throw new Error('census unavailable')
    return scope === (state === 'other-project-child' ? 'another-project' : projectId)
  })
  s.censusReads.length = 0
  const retired = state === 'other-project-child'
  expect(await retirePersistentRepl(s.key)).toBe(retired ? 'retired' : 'refused')
  expect(s.peer.children[0]!.child.hasExited()).toBe(retired)
  expect(loadRegistry(path)[s.key]).toEqual(retired ? undefined : row)
  expect(pool.has(s.key)).toBe(!retired)
  expect(retiringSessionKeys.has(s.key)).toBe(retired)
  expect(s.censusReads).toEqual(state === 'unknown-scope' ? [] : retired ? [projectId, projectId] : [projectId])
})
