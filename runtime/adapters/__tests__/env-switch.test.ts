/**
 * The sanctioned env-switch helper, held to its own rule.
 *
 * `pinEnvSwitch` is the ONE module permitted to write `HERDR_SOCKET_PATH` or
 * `NEUTRON_PTY_E2E` (see `tests/integration/pty-e2e-registered.test.ts`). Concentrating
 * the write in one place only helps if that place is correct, and when it was first
 * written it had no tests at all: two mutations of its restore — writing the STRING
 * `'undefined'` for an absent prior value, and not restoring at all — both survived the
 * whole guard suite. A helper introduced to close a hole is not exempt from the rule it
 * enforces.
 *
 * The key used here is deliberately NOT one of the switches: writing a switch key from
 * anywhere but the helper is precisely what the guard refuses, and a test that had to be
 * exempted from the rule it is testing would be evidence of nothing.
 */
import { describe, expect, test } from 'bun:test'
import { DEAD_HERDR_SOCKET, pinEnvSwitch, restoreEnv } from './env-switch.ts'

const PROBE = 'NEUTRON_ENV_SWITCH_PROBE'

describe('restoreEnv puts back ABSENCE as well as a value', () => {
  test('an absent prior value is restored by DELETING, never as the string "undefined"', () => {
    process.env[PROBE] = '/dead'
    restoreEnv(PROBE, undefined)
    // Both halves: the key is really gone, AND it is not the truthy string that every
    // reader of a path-shaped switch would accept as a real path.
    expect(PROBE in process.env).toBe(false)
    expect(process.env[PROBE]).toBeUndefined()
    expect(process.env[PROBE]).not.toBe('undefined')
  })

  test('a present prior value is written back exactly', () => {
    process.env[PROBE] = '/dead'
    restoreEnv(PROBE, '/the/original.sock')
    expect(process.env[PROBE]).toBe('/the/original.sock')
    delete process.env[PROBE]
  })

  test('an EMPTY prior value is a value, not an absence', () => {
    // '' is falsy, so a `prior || delete` implementation loses it — and an empty switch
    // is a state a caller can legitimately have set.
    process.env[PROBE] = '/dead'
    restoreEnv(PROBE, '')
    expect(PROBE in process.env).toBe(true)
    expect(process.env[PROBE]).toBe('')
    delete process.env[PROBE]
  })
})

describe('pinEnvSwitch actually pins', () => {
  // Registers the hooks at module scope, the way every caller does. The RESTORE half
  // runs after the last test in this file and so cannot be observed from inside it —
  // that is what `restoreEnv`'s own cases above are for.
  pinEnvSwitch(PROBE, '/pinned/by/the/helper.sock')

  test('the value is in place by the time the tests run', () => {
    expect(process.env[PROBE]).toBe('/pinned/by/the/helper.sock')
  })
})

describe('the shared constants', () => {
  test('the dead socket path is one nothing can be listening on', () => {
    expect(DEAD_HERDR_SOCKET.startsWith('/nonexistent/')).toBe(true)
  })
})
