import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { seedProject } from '@neutronai/gateway/wiring/__tests__/project-admission-fixture.ts'
import { seedMigratedDb } from '../../../../../tests/support/migrated-db.ts'
import { poolKeyFor } from '../pool.ts'
import { childByKey, pool, pendingChildKills, supervisedBySessionKey } from '../pool-state.ts'
import { getRecord, saveRegistry } from '../repl-registry.ts'
import { setNativeChildLiveness } from '../native-child-liveness.ts'
import { respawnReplSession, respawnSupervisedSession } from '../supervision.ts'
import * as spawn from '../spawn.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'respawn-native-child-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'project.db')
  seedMigratedDb(path)
  const db = ProjectDb.open(path)
  let closed = false
  cleanup.push(() => { if (!closed) db.close() })
  seedProject(db, 'alpha'); seedProject(db, 'beta')
  const admission = new ProjectAdmission({ db, ownerHandle: 'respawn-child-owner', bootId: 'respawn-proof' })
  const query = (scope: string | null) => admission.listLeases('liveChild').some(row => row.scope.projectId === scope)
  setNativeChildLiveness('respawn-child-owner', query)
  cleanup.push(() => setNativeChildLiveness('respawn-child-owner', undefined))
  const options: PersistentReplSubstrateOptions = { substrate_instance_id: 'cc-agent-respawn-child',
    user_id: 'respawn-child-owner', project_id: 'alpha', conversationProjectId: 'alpha', credential_identity: 'fixture',
    cwd: dir, replRegistryPath: join(dir, 'registry.json') }
  const key = poolKeyFor(options)
  let killed = false
  let acknowledge!: (code: number | null) => void
  const child = { pid: 2, write() {}, kill() { killed = true; acknowledge(0) }, hasExited: () => killed,
    exited: new Promise<number | null>(resolve => { acknowledge = resolve }) }
  childByKey.set(key, child)
  const parent = Promise.resolve({ child } as never)
  pool.set(key, parent)
  supervisedBySessionKey.set(key, options)
  saveRegistry(options.replRegistryPath!, { [key]: { sessionKey: key, sessionId: 'child-parent', cwd: dir,
    channelName: 'neutron-11112222333344445555666677778888', has_session: true, recent_respawns: [], conversationProjectId: 'alpha' } })
  const finalSpawn = spyOn(spawn, 'getOrSpawnSession').mockImplementation(() => new Promise(() => {}))
  cleanup.push(async () => {
    // A successful kill resumes asynchronously; drain to the mocked boundary
    // before restoring it so no actual provider can be spawned during cleanup.
    await pendingChildKills.get(key)
    await Bun.sleep(0)
    finalSpawn.mockRestore()
    childByKey.delete(key); pool.delete(key); pendingChildKills.delete(key); supervisedBySessionKey.delete(key)
  })
  const trigger = (force: boolean) => force
    ? respawnSupervisedSession(options.replRegistryPath!, key)
    : respawnReplSession(options, key, 'wedge-watchdog', 'health-dead', false)
  return { admission, query, options, key, parent, finalSpawn, trigger, killed: () => killed,
    closeDb: () => { db.close(); closed = true } }
}

for (const force of [false, true]) {
  test(`durable unknown child refuses watchdog/admin respawn; completion permits it (force=${force})`, async () => {
    const f = fixture()
    await f.admission.forNativeChild('alpha').admit('failed-run', 'step')
    await f.admission.releaseBuild('alpha', 'failed-run')
    const bytes = readFileSync(f.options.replRegistryPath!, 'utf8')
    expect(f.trigger(force).ok).toBe(false)
    expect(f.killed()).toBe(false)
    expect(pool.get(f.key)).toBe(f.parent)
    expect(childByKey.has(f.key)).toBe(true)
    expect(f.admission.listLeases('liveChild')).toHaveLength(1)
    expect(readFileSync(f.options.replRegistryPath!, 'utf8')).toBe(bytes)
    expect(f.finalSpawn).not.toHaveBeenCalled()
    await f.admission.forNativeChild('alpha').complete('failed-run', 'step')
    expect(f.trigger(force).ok).toBe(true)
    await Bun.sleep(0)
    expect(f.killed()).toBe(true)
    expect(pool.has(f.key)).toBe(false)
    expect(f.finalSpawn).toHaveBeenCalledTimes(1)
    expect(f.admission.listLeases('liveChild')).toEqual([])
  })

  test(`no child in this scope permits respawn despite another project's child (force=${force})`, async () => {
    const f = fixture()
    await f.admission.forNativeChild('beta').admit('other-run', 'step')
    expect(f.trigger(force).ok).toBe(true)
    await Bun.sleep(0)
    expect(f.killed()).toBe(true)
    expect(f.finalSpawn).toHaveBeenCalledTimes(1)
    expect(f.admission.listLeases('liveChild')).toHaveLength(1)
  })

  test(`unreadable durable child authority refuses respawn (force=${force})`, () => {
    const f = fixture()
    f.closeDb()
    expect(f.trigger(force).ok).toBe(false)
    expect(f.killed()).toBe(false)
    expect(pool.get(f.key)).toBe(f.parent)
    expect(f.finalSpawn).not.toHaveBeenCalled()
  })

  test(`child discovered after registry claim refuses before kill and clears claim (force=${force})`, async () => {
    const f = fixture()
    await f.admission.forNativeChild('alpha').admit('run', 'step')
    let reads = 0
    setNativeChildLiveness('respawn-child-owner', scope => ++reads === 1 ? false : f.query(scope))
    expect(f.trigger(force).ok).toBe(false)
    expect(reads).toBe(2)
    expect(f.killed()).toBe(false)
    expect(pool.get(f.key)).toBe(f.parent)
    expect(getRecord(f.options.replRegistryPath!, f.key)?.respawn_in_flight_at).toBeUndefined()
    expect(f.admission.listLeases('liveChild')).toHaveLength(1)
    expect(f.finalSpawn).not.toHaveBeenCalled()
  })
}
