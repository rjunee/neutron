import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as spawn from '../spawn.ts'
import { respawnReplSession } from '../supervision.ts'
import { flockAvailable, setFlockImplForTests } from '../registry-lock.ts'
import { getRecord, saveRegistry, type ReplRegistryRecord } from '../repl-registry.ts'
import { classifyThrownSpawnError } from '../classify-spawn-error.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'

const dirs: string[] = []
afterEach(() => {
  setFlockImplForTests(undefined)
  mock.restore()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(force = false) {
  expect(flockAvailable()).toBe(true)
  const dir = mkdtempSync(join(tmpdir(), 'respawn-claim-'))
  dirs.push(dir)
  const path = join(dir, 'registry.json')
  const key = `respawn-${dirs.length}-${dir}`
  const row: ReplRegistryRecord = {
    sessionKey: key, sessionId: 'resume-session', cwd: dir,
    channelName: 'neutron-15ab0d54e889689d70965ba3f945b480', has_session: true, recent_respawns: [],
    ...(force ? { capped_at: 1 } : {}),
  }
  saveRegistry(path, { [key]: row })
  // Intercept only the final spawn boundary. Registry, lock, plan and dispatch are real.
  const calls = spyOn(spawn, 'getOrSpawnSession').mockImplementation(() => new Promise(() => {}))
  const options = { replRegistryPath: path } as PersistentReplSubstrateOptions
  return { path, key, row, calls, options }
}

for (const force of [false, true]) {
  test(`unheld lock refuses without changing bytes or spawning, force=${force}`, () => {
    const { path, key, row, calls, options } = fixture(force)
    const before = readFileSync(path, 'utf8')
    let attempts = 0
    setFlockImplForTests(() => { attempts += 1; return 1 })
    const outcome = respawnReplSession(options, key, 'admin-endpoint', 'manual', force)
    expect(attempts).toBeGreaterThan(0)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('registry-write-refused')
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(getRecord(path, key)).toEqual(row)
    expect(calls).not.toHaveBeenCalled()
    // The failed acquisition must also release the process-local gate for a retry.
    setFlockImplForTests(() => 0)
    expect(respawnReplSession(options, key, 'admin-endpoint', 'manual', force).ok).toBe(true)
    expect(calls).toHaveBeenCalledTimes(1)
  })

  test(`held lock claims a stamp and spawns one resume, force=${force}`, () => {
    const { path, key, row, calls, options } = fixture(force)
    let attempts = 0
    setFlockImplForTests(() => { attempts += 1; return 0 })
    const outcome = respawnReplSession(options, key, 'admin-endpoint', 'manual', force)
    expect(attempts).toBeGreaterThan(0)
    expect(outcome.ok).toBe(true)
    expect(getRecord(path, key)?.respawn_in_flight_at).toBe(outcome.initiatedAt)
    expect(getRecord(path, key)?.capped_at).toBeUndefined()
    expect(calls).toHaveBeenCalledTimes(1)
    expect(calls.mock.calls[0]?.[3]).toEqual({ sessionId: row.sessionId })
    expect(respawnReplSession(options, key, 'admin-endpoint', 'manual', force).ok).toBe(false)
    expect(calls).toHaveBeenCalledTimes(1)
  })
}

test('recording refusal carries its class independently of the message', () => {
  const { key, options } = fixture()
  setFlockImplForTests(() => 1)
  const outcome = respawnReplSession(options, key, 'crash-watchdog', 'test')
  expect(outcome.error).toBeInstanceOf(Error)
  outcome.error!.message = 'unrelated wording'
  expect(classifyThrownSpawnError(outcome.error)).toBe('repl_unreconciled')
})

test('held lock with unreadable registry refuses the unpersisted decision', () => {
  const { path, key, calls, options } = fixture()
  rmSync(path)
  mkdirSync(path)
  setFlockImplForTests(() => 0)
  const outcome = respawnReplSession(options, key, 'crash-watchdog', 'test')
  expect(outcome.reason).toBe('registry-write-refused')
  expect(classifyThrownSpawnError(outcome.error)).toBe('repl_unreconciled')
  expect(statSync(path).isDirectory()).toBe(true)
  expect(calls).not.toHaveBeenCalled()
})
