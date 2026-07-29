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
})
