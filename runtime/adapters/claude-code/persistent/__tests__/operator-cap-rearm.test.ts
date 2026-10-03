import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as capacity from '../../../../workers/claude-capacity-client.ts'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { rearmReplCap, type CapRearmRequest } from '../operator-cap-rearm.ts'
import { poolKeyFor } from '../pool.ts'
import { saveRegistry, getRecord, type ReplRegistryRecord } from '../repl-registry.ts'
import { setNativeChildLiveness } from '../native-child-liveness.ts'
import { setFlockImplForTests } from '../registry-lock.ts'
import { retiringSessionKeys } from '../pool-state.ts'
import { recoverStartupRepl } from '../startup-recovery.ts'
import { resetBootAdoptionForTests } from '../boot-adoption.ts'
import { ReplSession } from '../repl-session.ts'
import { sessionJsonlPath } from '../session-size-watchdog.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'

const dirs: string[] = []
let unregisteredPin: ReturnType<typeof spyOn>
let unregisteredRoute: ReturnType<typeof spyOn>
beforeEach(() => {
  // Registry fixtures use native self-host auth, not the surrounding host route.
  unregisteredPin = spyOn(capacity, 'loadClaudeCapacityPin').mockReturnValue(undefined)
  unregisteredRoute = spyOn(capacity, 'nativeRelayRouteFingerprint').mockReturnValue(undefined)
})
afterEach(() => {
  unregisteredRoute.mockRestore()
  unregisteredPin.mockRestore()
  setFlockImplForTests(undefined)
  setNativeChildLiveness('cap-test-owner', undefined)
  retiringSessionKeys.clear()
  resetBootAdoptionForTests()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'operator-cap-')); dirs.push(dir)
  const options: PersistentReplSubstrateOptions = { substrate_instance_id: 'cap-test', user_id: 'cap-test-owner',
    project_id: 'project-a', conversationProjectId: 'project-a', cwd: dir, replRegistryPath: join(dir, 'registry.json'),
    projectsDir: join(dir, 'projects'), sinkTokenPath: join(dir, 'sink-token') }
  const key = poolKeyFor(options)
  const row: ReplRegistryRecord = { sessionKey: key, sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    child_generation: 'original-generation', cwd: dir, channelName: 'neutron-11112222333344445555666677778888',
    conversationProjectId: 'project-a', has_session: true, model: 'claude-test', capped_at: 100,
    first_ready_at: 100000, recent_respawns: [1, 2, 3],
    reuse: { auth_fingerprint: '', tool_surface: 'Read', tool_bridge: false } }
  saveRegistry(options.replRegistryPath!, { [key]: row, unrelated: { ...row, sessionKey: 'unrelated' } })
  const request: CapRearmRequest = { projectId: 'project-a', sessionKey: key, sessionId: row.sessionId,
    childGeneration: row.child_generation!, cappedAt: 100 }
  const bytes = () => readFileSync(options.replRegistryPath!, 'utf8')
  const rearm = (authorized = () => true) => rearmReplCap(options, request, authorized)
  return { dir, key, row, options, request, bytes, rearm }
}

test('explicit exact rearm clears only the cap and enables separately invoked ordinary startup recovery', async () => {
  const f = fixture()
  const transcript = sessionJsonlPath(f.row.sessionId, f.dir, f.options.projectsDir)
  mkdirSync(dirname(transcript), { recursive: true }); writeFileSync(transcript, '{"retained":true}\n')
  let spawns = 0
  const recover = () => recoverStartupRepl(f.options, f.key, [{ name: 'Read' }], {
    adoption: { listProcesses: () => [] },
    spawn: async () => { spawns++; return new ReplSession(f.key, 'new-generation', f.row.sessionId, 'channel', f.dir) },
  })
  expect((await recover()).status).toBe('refused') // later ready never releases the cap
  expect(spawns).toBe(0)
  expect(f.rearm()).toBe(true)
  expect(spawns).toBe(0) // rearm itself never resumes
  const { capped_at: _cap, ...expected } = f.row
  expect(getRecord(f.options.replRegistryPath!, f.key)).toEqual(expected)
  expect(getRecord(f.options.replRegistryPath!, 'unrelated')).toEqual({ ...f.row, sessionKey: 'unrelated' })
  expect(f.rearm()).toBe(false) // replay cannot release a different cap episode
  expect((await recover()).status).toBe('resumed')
  expect(spawns).toBe(1)
})

test.each(['sessionId', 'childGeneration', 'cappedAt', 'sessionKey', 'projectId'] as const)('stale or foreign %s refuses byte-identically', field => {
  const f = fixture(); const before = f.bytes()
  const changed = { ...f.request, [field]: field === 'cappedAt' ? 101 : 'foreign' }
  expect(rearmReplCap(f.options, changed, () => true)).toBe(false)
  expect(f.bytes()).toBe(before)
  expect(f.rearm()).toBe(true)
})

test.each(['asleep_at', 'respawn_in_flight_at', 'spawn_reservation_by', 'conversationProjectId', 'reuse', 'cwd', 'has_session'] as const)('unsafe row %s retains its cap', field => {
  const f = fixture()
  const value = field === 'reuse' ? { ...f.row.reuse!, auth_fingerprint: 'foreign' }
    : field === 'has_session' ? false : ['asleep_at', 'respawn_in_flight_at'].includes(field) ? 1 : 'foreign'
  saveRegistry(f.options.replRegistryPath!, { [f.key]: { ...f.row, [field]: value } })
  const before = f.bytes(); expect(f.rearm()).toBe(false); expect(f.bytes()).toBe(before)
  saveRegistry(f.options.replRegistryPath!, { [f.key]: f.row }); expect(f.rearm()).toBe(true)
})

test('unresolved child, unavailable authority, retirement and unheld lock all refuse before writing', () => {
  const f = fixture(); const before = f.bytes()
  setNativeChildLiveness('cap-test-owner', () => true)
  expect(f.rearm()).toBe(false); expect(f.bytes()).toBe(before)
  setNativeChildLiveness('cap-test-owner', () => false)
  expect(f.rearm(() => false)).toBe(false); expect(f.bytes()).toBe(before)
  expect(f.rearm(() => { throw new Error('unavailable') })).toBe(false); expect(f.bytes()).toBe(before)
  retiringSessionKeys.add(f.key)
  expect(f.rearm()).toBe(false); expect(f.bytes()).toBe(before)
  retiringSessionKeys.delete(f.key)
  setFlockImplForTests(() => 1)
  expect(f.rearm()).toBe(false); expect(f.bytes()).toBe(before)
  setFlockImplForTests(undefined)
  expect(f.rearm()).toBe(true)
})
