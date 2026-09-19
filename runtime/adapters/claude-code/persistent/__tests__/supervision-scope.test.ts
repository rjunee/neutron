import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeCodeSubstrateAuto, deriveReplSupervisionPaths } from '../../index.ts'
import { beginBootAdoption, resetBootAdoptionForTests } from '../boot-adoption.ts'
import { poolKeyFor, shutdownAllPersistentRepls } from '../pool.ts'
import { childByKey, pool, supervisedBySessionKey } from '../pool-state.ts'
import { saveRegistry, type ReplRegistryRecord } from '../repl-registry.ts'
import { registerSupervisedSubstrate, respawnReplSession, runReplWatchdogTick, runCwdDriftWatchdogTick, startModelUpdateWatchdogForInstance } from '../supervision.ts'
import { drainPendingRespawns } from '../pending-respawn.ts'
import { enqueuePendingRespawn } from '../pending-respawns-queue.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'
import type { PtyChild } from '../pty-host.ts'
import type { ReplSession } from '../repl-session.ts'
import { setBestModelOverride } from '../../../../models.ts'

const dirs: string[] = []
afterEach(async () => {
  childByKey.clear(); pool.clear(); supervisedBySessionKey.clear()
  await shutdownAllPersistentRepls()
  resetBootAdoptionForTests()
  setBestModelOverride(undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(kind: 'legacy' | 'mismatch' | 'project') {
  const dir = mkdtempSync(join(tmpdir(), 'repl-supervision-scope-'))
  dirs.push(dir)
  const paths = deriveReplSupervisionPaths(dir)
  const options: PersistentReplSubstrateOptions = {
    substrate_instance_id: 'scope-test', user_id: 'owner', credential_identity: 'cred', cwd: dir,
    project_id: kind === 'project' ? 'project' : 'general',
    ...(kind === 'mismatch' ? { conversationProjectId: null } : {}),
    replRegistryPath: paths.replRegistryPath, pendingRespawnsPath: paths.pendingRespawnsPath,
  }
  const key = poolKeyFor(options)
  const row: ReplRegistryRecord = {
    sessionKey: key, sessionId: 'cccccccc-1111-2222-3333-444444444444', cwd: dir,
    channelName: 'neutron-11112222333344445555666677778888', has_session: true,
    pid: 31337, child_generation: 'old-generation', first_ready_at: 1,
    ...(kind === 'mismatch' ? { conversationProjectId: 'other' } : {}),
  }
  saveRegistry(paths.replRegistryPath, { [key]: row })
  return { options, key, row, paths }
}

for (const kind of ['legacy', 'mismatch'] as const) {
  test(`${kind} refusal grants no registration and watchdog makes no crash annotation`, async () => {
    const { options, key, paths } = fixture(kind)
    const before = readFileSync(paths.replRegistryPath, 'utf8')
    expect((await beginBootAdoption(options, key)).kind).toBe('undecided')
    createClaudeCodeSubstrateAuto({ substrate_instance_id: options.substrate_instance_id,
      cwd: options.cwd!, user_id: options.user_id!, project_id: options.project_id!,
      credential_identity: options.credential_identity!,
      ...(options.conversationProjectId === undefined ? {} : { conversationProjectId: options.conversationProjectId }),
    })
    expect(supervisedBySessionKey.has(key)).toBe(false)
    let notices = 0, probes = 0
    // Legacy has no owner registration. Mismatch simulates an old registration
    // that became invalid after the row was replaced; both must remain inert.
    if (kind === 'mismatch') supervisedBySessionKey.set(key, options)
    const result = await runReplWatchdogTick({ ...options, onChildCrash: () => { notices++ } }, {
      now: () => 120_000, isPidAlive: () => { probes++; return false },
      healthProbe: async () => { probes++; return false },
    })
    expect(result).toEqual([{ sessionKey: key, action: 'scope-refused', respawned: false }])
    expect(notices).toBe(0); expect(probes).toBe(0)
    expect(readFileSync(paths.replRegistryPath, 'utf8')).toBe(before)
  })

  for (const force of [false, true]) {
    test(`${kind} respawn refuses before force/cap writes, kill, or eviction (force=${force})`, () => {
      const { options, key, paths } = fixture(kind)
      let killed = 0
      const child = { hasExited: () => false, kill: () => { killed++ } } as unknown as PtyChild
      childByKey.set(key, child)
      const pooled = new Promise<never>(() => {})
      pool.set(key, pooled)
      const before = readFileSync(paths.replRegistryPath, 'utf8')
      const result = respawnReplSession(options, key, 'admin-endpoint', 'scope test', force)
      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('scope')
      expect(killed).toBe(0); expect(childByKey.get(key)).toBe(child); expect(pool.get(key)).toBe(pooled)
      expect(readFileSync(paths.replRegistryPath, 'utf8')).toBe(before)
    })
  }

  test(`${kind} stale registration cannot consume pending inbound`, async () => {
    const { options, key, row, paths } = fixture(kind)
    supervisedBySessionKey.set(key, options)
    enqueuePendingRespawn(paths.pendingRespawnsPath, { sessionKey: key, sessionId: row.sessionId,
      cwd: row.cwd, droppedInbound: 'preserve me' })
    const before = readFileSync(paths.pendingRespawnsPath, 'utf8')
    const result = await drainPendingRespawns(options, { baseDelayMs: 0 })
    expect(result).toEqual([{ sessionKey: key, replayed: false, skipped: 'scope-refused' }])
    expect(readFileSync(paths.pendingRespawnsPath, 'utf8')).toBe(before)
  })

  test(`${kind} stale pooled registration cannot actuate cwd or model watchdogs`, async () => {
    const { options, key, paths } = fixture(kind)
    supervisedBySessionKey.set(key, options)
    pool.set(key, Promise.resolve({ hasChildExited: () => false, child: { pid: 31337 } } as ReplSession))
    const before = readFileSync(paths.replRegistryPath, 'utf8')
    let cwdProbes = 0
    await runCwdDriftWatchdogTick(options, { cwdDriftProbeCwd: async () => { cwdProbes++; return '/wrong' } })
    expect(cwdProbes).toBe(0)
    setBestModelOverride('opus')
    writeFileSync(paths.modelUpdateStatePath, JSON.stringify({ last_known_model: 'claude-opus-98' }))
    let notices = 0
    const watchdog = startModelUpdateWatchdogForInstance({ ...options,
      modelUpdateStatePath: paths.modelUpdateStatePath,
      modelProbe: async () => ({ ok: true, model: 'claude-opus-99' }),
      onModelUpdate: () => { notices++ },
    })
    await watchdog.tick()
    expect(notices).toBe(1)
    expect(readFileSync(paths.replRegistryPath, 'utf8')).toBe(before)
  })
}

test('ordinary unregistered project crash notification remains supported', async () => {
  const { options, key } = fixture('project')
  let notices = 0
  const result = await runReplWatchdogTick({ ...options, onChildCrash: () => { notices++ } }, {
    now: () => 120_000, isPidAlive: () => false, healthProbe: async () => false,
  })
  expect(notices).toBe(1)
  expect(result).toEqual([{ sessionKey: key, action: 'unregistered-skip', respawned: false }])
  registerSupervisedSubstrate(options)
  expect(supervisedBySessionKey.has(key)).toBe(true)
})
