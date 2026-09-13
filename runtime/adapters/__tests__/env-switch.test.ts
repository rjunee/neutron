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

// A PRIOR VALUE THAT EXISTS, set before `pinEnvSwitch` captures it. The module body runs
// before any `describe` callback, so this is in place when the helper reads it.
const PROBE_ABSENT = 'NEUTRON_ENV_SWITCH_PROBE_ABSENT'
const PROBE_PRESENT = 'NEUTRON_ENV_SWITCH_PROBE_PRESENT'
const ORIGINAL = '/the/original.sock'
process.env[PROBE_PRESENT] = ORIGINAL

describe('pinEnvSwitch pins', () => {
  // Registered the way every caller registers it.
  pinEnvSwitch(PROBE_ABSENT, '/pinned-over-nothing.sock')
  pinEnvSwitch(PROBE_PRESENT, '/pinned-over-a-value.sock')

  test('both values are in place by the time the tests run', () => {
    expect(process.env[PROBE_ABSENT]).toBe('/pinned-over-nothing.sock')
    expect(process.env[PROBE_PRESENT]).toBe('/pinned-over-a-value.sock')
  })
})

// THE WIRING, NOT THE FUNCTION — and this is the half that was missing. `restoreEnv`'s
// own cases prove the function does the right thing; nothing proved `pinEnvSwitch` ever
// CALLS it. Its `afterAll` could be deleted outright and every test here still passed,
// while the switch stayed pinned for every suite that ran afterwards — which is the exact
// failure this helper exists to prevent. The static guard cannot catch it either, because
// it exempts this helper by design.
//
// A LATER SIBLING `describe` IS THE OBSERVABLE. Its tests run after the previous
// describe's `afterAll`, so by the time these execute the restore has either happened or
// has not. That ordering is asserted rather than assumed — the case above pins the value
// DURING, these pin it AFTER, and the two together cannot both pass unless the hook ran.
describe('...and the restore RAN — not merely implemented', () => {
  test('a prior that was ABSENT is absent again, not the string "undefined"', () => {
    expect(PROBE_ABSENT in process.env).toBe(false)
    expect(process.env[PROBE_ABSENT]).not.toBe('undefined')
  })

  test('a prior that was PRESENT is back to its exact value', () => {
    expect(process.env[PROBE_PRESENT]).toBe(ORIGINAL)
  })

  test('CONTROL — the pinned values are really gone, so this is not a vacuous pass', () => {
    // Without this, a helper that never wrote anything in the first place would satisfy
    // both cases above: "restored" and "never touched" look identical from here.
    expect(process.env[PROBE_ABSENT]).not.toBe('/pinned-over-nothing.sock')
    expect(process.env[PROBE_PRESENT]).not.toBe('/pinned-over-a-value.sock')
  })
})

// THE PRIOR VALUE IS CAPTURED WHEN `pinEnvSwitch` IS CALLED, NOT INSIDE `beforeAll`, and
// this is the case that tells the two apart. Pin the same key twice in one scope: the
// `beforeAll` hooks run in order, so a capture made inside the second one records what the
// FIRST hook just wrote. The restores then unwind to that intermediate value instead of to
// the original, and the key is left pinned for every suite that follows.
//
// Written because the mutation that moves the capture into `beforeAll` SURVIVED every
// other case here — across files it makes no difference, since a file's `afterAll` has
// already run before the next file's `beforeAll`. A survivor is only ever a weak test or a
// property with no observable, and this one turned out to be the first.
const PROBE_TWICE = 'NEUTRON_ENV_SWITCH_PROBE_TWICE'
const TWICE_ORIGINAL = '/before/any/pin.sock'
process.env[PROBE_TWICE] = TWICE_ORIGINAL

describe('the same key pinned TWICE in one scope', () => {
  pinEnvSwitch(PROBE_TWICE, '/first.sock')
  pinEnvSwitch(PROBE_TWICE, '/second.sock')

  test('the last pin wins while the scope runs', () => {
    expect(process.env[PROBE_TWICE]).toBe('/second.sock')
  })
})

describe('...and both restores unwind to the ORIGINAL, not to each other', () => {
  test('the value is what it was before either pin', () => {
    expect(process.env[PROBE_TWICE]).toBe(TWICE_ORIGINAL)
  })
})

describe('the shared constants', () => {
  test('the dead socket path is one nothing can be listening on', () => {
    expect(DEAD_HERDR_SOCKET.startsWith('/nonexistent/')).toBe(true)
  })
})
