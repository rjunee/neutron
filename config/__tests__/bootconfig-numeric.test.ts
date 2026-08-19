/**
 * C1 — numeric-knob loud-failure test.
 *
 * The C1 mandate: a bad numeric env must FAIL LOUD (a clear thrown error), not
 * silently become `NaN` (the pre-C1 behavior at every `parseInt(...)` site).
 * The UNSET path still returns the verbatim default (covered here + in the
 * defaults table).
 */

import { describe, expect, test } from 'bun:test'

import { resolveBootConfig } from '../index.ts'

describe('C1 BootConfig — numeric knobs fail loud (never NaN)', () => {
  const NUMERIC_VARS = [
    'NEUTRON_PORT',
    'NEUTRON_MAX_UPLOAD_BYTES',
    'NEUTRON_MAX_SYNTHESIS_PROJECTS',
    'NEUTRON_OVERNIGHT_MAX_CONCURRENT',
    'NEUTRON_OVERNIGHT_MAX_PER_WINDOW',
    'NEUTRON_REPL_KEEPALIVE_MS',
  ] as const

  test('a non-numeric value throws with the var name (not NaN)', () => {
    for (const name of NUMERIC_VARS) {
      expect(() => resolveBootConfig({ [name]: 'abc' })).toThrow(name)
    }
  })

  test('a fractional value throws (integers only)', () => {
    expect(() => resolveBootConfig({ NEUTRON_MAX_SYNTHESIS_PROJECTS: '10.5' })).toThrow(
      'NEUTRON_MAX_SYNTHESIS_PROJECTS',
    )
  })

  test('out-of-range values throw', () => {
    expect(() => resolveBootConfig({ NEUTRON_PORT: '70000' })).toThrow('NEUTRON_PORT') // > 65535
    expect(() => resolveBootConfig({ NEUTRON_PORT: '-1' })).toThrow('NEUTRON_PORT')
    expect(() => resolveBootConfig({ NEUTRON_MAX_SYNTHESIS_PROJECTS: '0' })).toThrow(
      'NEUTRON_MAX_SYNTHESIS_PROJECTS',
    ) // must be >= 1
    expect(() => resolveBootConfig({ NEUTRON_OVERNIGHT_MAX_CONCURRENT: '0' })).toThrow(
      'NEUTRON_OVERNIGHT_MAX_CONCURRENT',
    )
  })

  test('valid numeric overrides parse to numbers (no NaN anywhere)', () => {
    const c = resolveBootConfig({
      NEUTRON_PORT: '9001',
      NEUTRON_MAX_UPLOAD_BYTES: '10737418240',
      NEUTRON_MAX_SYNTHESIS_PROJECTS: '24',
      NEUTRON_OVERNIGHT_MAX_CONCURRENT: '4',
      NEUTRON_OVERNIGHT_MAX_PER_WINDOW: '16',
      NEUTRON_REPL_KEEPALIVE_MS: '5000',
    })
    expect(c.port).toBe(9001)
    expect(c.maxUploadBytes).toBe(10737418240)
    expect(c.maxSynthesisProjects).toBe(24)
    expect(c.overnightMaxConcurrent).toBe(4)
    expect(c.overnightMaxPerWindow).toBe(16)
    expect(c.replKeepaliveMs).toBe(5000)
    for (const v of [
      c.port,
      c.maxUploadBytes,
      c.maxSynthesisProjects,
      c.overnightMaxConcurrent,
      c.overnightMaxPerWindow,
      c.replKeepaliveMs,
    ]) {
      expect(Number.isNaN(v as number)).toBe(false)
    }
  })

  test('empty string is treated as unset → default', () => {
    const c = resolveBootConfig({ NEUTRON_PORT: '', NEUTRON_MAX_SYNTHESIS_PROJECTS: '' })
    expect(c.port).toBeUndefined()
    expect(c.maxSynthesisProjects).toBe(10)
  })

  test('port 0 (random-free-port request) is accepted', () => {
    expect(resolveBootConfig({ NEUTRON_PORT: '0' }).port).toBe(0)
  })

  // Regression (Codex, C1 review): the legacy `resolveListenPort` rejected
  // non-canonical lexicals via `String(parsed) === fromEnv.trim()`. A naive
  // `Number(raw)` would silently accept them (`0x10`→16, `1e3`→1000), loosening
  // validation. The canonical-decimal guard preserves the old strictness.
  test('non-canonical NEUTRON_PORT lexicals throw (hex / scientific / sign / leading-zero)', () => {
    for (const bad of ['0x10', '1e3', '+16', '016', '0b1', '1_6']) {
      expect(() => resolveBootConfig({ NEUTRON_PORT: bad })).toThrow('NEUTRON_PORT')
    }
  })

  test('surrounding whitespace on NEUTRON_PORT is tolerated (canonical after trim)', () => {
    expect(resolveBootConfig({ NEUTRON_PORT: '  9001  ' }).port).toBe(9001)
  })

  // THE BLANK CLASS, WHICH IS WHERE ONE VARIABLE HAD TWO ANSWERS. The test above
  // covers whitespace AROUND a number; nothing covered whitespace INSTEAD of one.
  // Measured before the fix: `NEUTRON_PORT=''` → `undefined` (seam default 7800),
  // `NEUTRON_PORT=' '` → a hard boot refusal. Same variable, same "the operator
  // set nothing" intent, opposite outcomes, and every identity read in this repo
  // already answers UNSET for both.
  test('a WHITESPACE-ONLY NEUTRON_PORT is unset, exactly as an empty one is', () => {
    for (const blank of [' ', '   ', '\t', '\n', '\t\n ']) {
      const c = resolveBootConfig({ NEUTRON_PORT: blank })
      expect(c.port).toBeUndefined()
    }
    // CONTROL — "blank is unset" did not become "everything is unset". A real
    // value still parses, and the empty case still behaves as it always did.
    expect(resolveBootConfig({ NEUTRON_PORT: '9001' }).port).toBe(9001)
    expect(resolveBootConfig({ NEUTRON_PORT: '' }).port).toBeUndefined()
  })

  test('a blank NEUTRON_PORT never resolves to 0 — whitespace coerces to zero, and 0 means "bind random"', () => {
    // THE ASSERTION THAT NAMES THE NUMBER, because `undefined` and `0` are both
    // "falsy port" and only one of them is safe. `Number('   ')` is 0, NOT NaN,
    // so `Number.isInteger` accepts a blank and this knob's floor is 0 — the only
    // thing that ever rejected a blank was the canonical-decimal STRING compare,
    // whose comment justifies it purely in terms of hex/scientific/signed
    // lexicals. Narrowing that compare to skip blanks (`raw.trim().length > 0 &&
    // …`) is the natural way to bring this knob onto the blank-is-unset rule and
    // it yields port 0 — an ephemeral port nothing routes to, with
    // `boot-listener-registry`'s in-use guard (`port !== 0`) disabled, silently.
    //
    // THIS ASSERTION IS REDUNDANT AS A DETECTOR AND KEPT AS DOCUMENTATION, said
    // plainly because the first draft of this comment claimed the opposite and a
    // cross-model reviewer caught it. `toBeUndefined()` above ALREADY fails on 0
    // (measured: `expect(received).toBeUndefined()` / `Received: 0`), so this
    // adds no coverage. What it adds is the NAME of the wrong value: a reader who
    // sees `toBeUndefined()` go red learns the parse changed, and a reader who
    // sees `Expected: not 0` learns which value it changed to and why that one is
    // dangerous rather than merely wrong. Claiming coverage it does not provide
    // would be the same unproved-claim defect this whole sequence is about.
    for (const blank of [' ', '   ', '\t\n ']) {
      expect(resolveBootConfig({ NEUTRON_PORT: blank }).port).not.toBe(0)
    }
    // CONTROL — an EXPLICIT '0' is still honoured, so the guard above rejects the
    // coercion and not the value. Without this, refusing 0 outright would pass.
    expect(resolveBootConfig({ NEUTRON_PORT: '0' }).port).toBe(0)
  })
})
