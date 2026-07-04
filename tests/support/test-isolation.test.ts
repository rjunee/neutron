/**
 * Unit tests for the G9 shared test-isolation testkit.
 *
 * These assert the two properties that make the helper a fix rather than a
 * convenience wrapper: (1) each call gets a UNIQUE, real, existing home dir
 * with the standard env vars pointed inside it, and (2) `restore()` puts the
 * environment back EXACTLY — including deleting keys that were unset before —
 * so nothing leaks into the next file in the same `bun test` process.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

import {
  ISOLATED_HOME_ENV_KEYS,
  createIsolatedHome,
  reserveFreePort,
  type IsolatedHome,
} from './test-isolation.ts'

// Defensive: any home left un-restored by a failing assertion is torn down
// here so it cannot pollute a sibling test in this same file.
let openHomes: IsolatedHome[] = []
afterEach(() => {
  for (const h of openHomes) h.restore()
  openHomes = []
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
    process.env[KEY] = 'original'

    const home = createIsolatedHome({
      extraEnvKeys: [KEY],
      env: { [KEY]: 'overridden', NEUTRON_ISO_TEST_DELETED: 'gone-after' },
    })
    expect(process.env[KEY]).toBe('overridden')
    expect(process.env['NEUTRON_ISO_TEST_DELETED']).toBe('gone-after')

    home.restore()
    expect(process.env[KEY]).toBe('original')
    expect('NEUTRON_ISO_TEST_DELETED' in process.env).toBe(false)

    delete process.env[KEY]
  })

  test('env override with undefined deletes the key while active', () => {
    process.env['NEUTRON_ISO_PRESENT'] = 'yes'
    const home = createIsolatedHome({ env: { NEUTRON_ISO_PRESENT: undefined } })
    expect('NEUTRON_ISO_PRESENT' in process.env).toBe(false)
    home.restore()
    expect(process.env['NEUTRON_ISO_PRESENT']).toBe('yes')
    delete process.env['NEUTRON_ISO_PRESENT']
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
