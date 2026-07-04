/**
 * Unit tests for the G9 shared test-isolation testkit.
 *
 * These assert the two properties that make the helper a fix rather than a
 * convenience wrapper: (1) each call gets a UNIQUE, real, existing home dir
 * with the standard env vars pointed inside it, and (2) `restore()` puts the
 * environment back EXACTLY — including deleting keys that were unset before —
 * so nothing leaks into the next file in the same `bun test` process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

import {
  ISOLATED_HOME_ENV_KEYS,
  createIsolatedHome,
  reserveFreePort,
  type IsolatedHome,
} from './test-isolation.ts'

// A suite that TESTS env isolation must itself never leak env — otherwise
// running it with an ambient value set (e.g. `NEUTRON_DB_PATH=… bun test`)
// would corrupt sibling files, the exact failure this testkit prevents. So we
// snapshot the FULL ambient env before each test and restore it exactly after,
// which lets each test freely mutate/delete any key for its own assertions
// without owning the ambient save/restore.
let envSnapshot: Record<string, string | undefined> = {}
let openHomes: IsolatedHome[] = []
beforeEach(() => {
  envSnapshot = { ...process.env }
})
afterEach(() => {
  // First the tmpdir teardown, newest-first (LIFO): each home snapshots the
  // LIVE env at create time, so a later home's snapshot captures the earlier
  // home's values — unwinding in reverse is the only order that would land the
  // owned keys back correctly (see the "overlapping homes restore LIFO" test).
  // rmSync of each home's dir happens here regardless of the env restore below.
  for (const h of [...openHomes].reverse()) h.restore()
  openHomes = []
  // Then restore the FULL ambient env exactly: drop keys a test added, put
  // back keys it changed or deleted.
  for (const k of Object.keys(process.env)) {
    if (!(k in envSnapshot)) delete process.env[k]
  }
  for (const k of Object.keys(envSnapshot)) {
    const v = envSnapshot[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
function track(h: IsolatedHome): IsolatedHome {
  openHomes.push(h)
  return h
}

describe('createIsolatedHome', () => {
  test('creates a real, existing, unique home dir and points env at it', () => {
    const home = track(createIsolatedHome())

    expect(existsSync(home.dir)).toBe(true)
    expect(process.env['NEUTRON_HOME']).toBe(home.dir)
    expect(process.env['OWNER_HOME']).toBe(home.dir)
    expect(process.env['NEUTRON_DB_PATH']).toBe(home.dbPath)
    expect(home.dbPath.startsWith(home.dir)).toBe(true)
    expect(process.env['NEUTRON_INSTANCE_SLUG']).toBe('owner')
  })

  test('two calls never share a dir (the anti-pollution invariant)', () => {
    const a = track(createIsolatedHome())
    const b = track(createIsolatedHome())
    expect(a.dir).not.toBe(b.dir)
    expect(a.dbPath).not.toBe(b.dbPath)
  })

  test('overlapping homes restore LIFO back to the original env', () => {
    // Two live homes at once: `b` is created while `a` is still active, so
    // `b`'s snapshot captures `a`'s paths. Restoring newest-first (b then a)
    // must land the env back on its true pre-create values; restoring a-then-b
    // would leave the env pointing at `a`'s already-deleted dir (the leak this
    // testkit exists to prevent — the exact footgun a naive FIFO teardown hits).
    const before: Record<string, string | undefined> = {}
    for (const k of ISOLATED_HOME_ENV_KEYS) before[k] = process.env[k]

    // track() both so a mid-test assertion failure still tears them down via
    // afterEach (restore() is idempotent, so the manual LIFO restores below
    // remain the assertions under test).
    const a = track(createIsolatedHome({ slug: 'lifo-a' }))
    const b = track(createIsolatedHome({ slug: 'lifo-b' }))
    expect(process.env['NEUTRON_HOME']).toBe(b.dir)

    b.restore()
    // After the newest is unwound, env is back to the still-live `a`.
    expect(process.env['NEUTRON_HOME']).toBe(a.dir)
    expect(existsSync(a.dir)).toBe(true)

    a.restore()
    for (const k of ISOLATED_HOME_ENV_KEYS) {
      expect(process.env[k]).toBe(before[k])
    }
    expect(existsSync(a.dir)).toBe(false)
    expect(existsSync(b.dir)).toBe(false)
  })

  test('restore() puts env back exactly and removes the dir', () => {
    const before: Record<string, string | undefined> = {}
    for (const k of ISOLATED_HOME_ENV_KEYS) before[k] = process.env[k]

    const home = createIsolatedHome({ slug: 'custom' })
    expect(process.env['NEUTRON_INSTANCE_SLUG']).toBe('custom')
    const dir = home.dir

    home.restore()

    for (const k of ISOLATED_HOME_ENV_KEYS) {
      expect(process.env[k]).toBe(before[k])
    }
    expect(existsSync(dir)).toBe(false)
  })

  test('restore() DELETES a key that was unset before (no phantom leak)', () => {
    // Drives NEUTRON_DB_PATH unset→set→unset; the file-level afterEach restores
    // whatever ambient value it had, so this test can mutate it freely.
    delete process.env['NEUTRON_DB_PATH']
    expect('NEUTRON_DB_PATH' in process.env).toBe(false)

    const home = createIsolatedHome()
    expect(process.env['NEUTRON_DB_PATH']).toBe(home.dbPath)

    home.restore()
    expect('NEUTRON_DB_PATH' in process.env).toBe(false)
  })

  test('restore() is idempotent', () => {
    const home = createIsolatedHome()
    home.restore()
    expect(() => home.restore()).not.toThrow()
    expect(existsSync(home.dir)).toBe(false)
  })

  test('extraEnvKeys and env overrides are snapshotted and restored', () => {
    const KEY = 'NEUTRON_ISO_TEST_EXTRA_KEY'
    // Establish both preconditions explicitly so the assertions below hold
    // regardless of ambient env: KEY starts 'original', the DELETED key starts
    // unset (its restore-to-absent is what we're checking).
    process.env[KEY] = 'original'
    delete process.env['NEUTRON_ISO_TEST_DELETED']

    const home = createIsolatedHome({
      extraEnvKeys: [KEY],
      env: { [KEY]: 'overridden', NEUTRON_ISO_TEST_DELETED: 'gone-after' },
    })
    expect(process.env[KEY]).toBe('overridden')
    expect(process.env['NEUTRON_ISO_TEST_DELETED']).toBe('gone-after')

    home.restore()
    expect(process.env[KEY]).toBe('original')
    expect('NEUTRON_ISO_TEST_DELETED' in process.env).toBe(false)
    // No manual cleanup: the file-level afterEach restores the ambient env
    // exactly (KEY back to its pre-test value, NEUTRON_ISO_TEST_DELETED gone).
  })

  test('env override with undefined deletes the key while active', () => {
    process.env['NEUTRON_ISO_PRESENT'] = 'yes'
    const home = createIsolatedHome({ env: { NEUTRON_ISO_PRESENT: undefined } })
    expect('NEUTRON_ISO_PRESENT' in process.env).toBe(false)
    home.restore()
    expect(process.env['NEUTRON_ISO_PRESENT']).toBe('yes')
    // ambient restore handled by the file-level afterEach.
  })
})

describe('reserveFreePort', () => {
  test('returns a usable, in-range port', async () => {
    const port = await reserveFreePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65_536)
  })

  test('successive reservations are (almost always) distinct', async () => {
    const ports = await Promise.all([reserveFreePort(), reserveFreePort(), reserveFreePort()])
    // The OS hands out different ephemeral ports for concurrently-open :0
    // sockets; at least two of three must differ.
    expect(new Set(ports).size).toBeGreaterThan(1)
  })
})
