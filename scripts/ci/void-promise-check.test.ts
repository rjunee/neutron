// F3 — unit tests for the bare `void <promise>` gate detector.
//
// The gate (scripts/ci/void-promise-check.mjs) bans fire-and-forget promise
// voids outside the fireAndForget wrapper. These tests pin the detector's
// PRECISION: it must flag `void <call>` (the promise idiom) and must NOT flag
// the unused-binding / no-op voids that share the keyword.
import { describe, expect, test } from 'bun:test'
import { findBareVoidPromiseCalls } from './void-promise-check.mjs'

describe('findBareVoidPromiseCalls', () => {
  test('flags a bare void on a call', () => {
    const hits = findBareVoidPromiseCalls('void emitSystemEvent({ event: "x" })')
    expect(hits.length).toBe(1)
    expect(hits[0]?.text).toContain('void emitSystemEvent')
  })

  test('flags a void on a chained call (…().catch(…))', () => {
    const hits = findBareVoidPromiseCalls('void handle.stop().catch(() => {})')
    expect(hits.length).toBe(1)
  })

  test('flags a void on a multi-line promise chain', () => {
    const src = ['void p', '  .then((r) => r)', '  .catch(() => undefined)'].join('\n')
    const hits = findBareVoidPromiseCalls(src)
    expect(hits.length).toBe(1)
    expect(hits[0]?.line).toBe(1)
  })

  test('flags an immediately-invoked async IIFE void', () => {
    const hits = findBareVoidPromiseCalls('void (async () => { await x() })()')
    expect(hits.length).toBe(1)
  })

  test('does NOT flag the wrapped form', () => {
    const hits = findBareVoidPromiseCalls("fireAndForget('site', emitSystemEvent({}))")
    expect(hits.length).toBe(0)
  })

  test('does NOT flag `void 0` / literal voids', () => {
    expect(findBareVoidPromiseCalls('void 0').length).toBe(0)
    expect(findBareVoidPromiseCalls('void "noop"').length).toBe(0)
  })

  test('does NOT flag the unused-binding void idiom (identifier / member)', () => {
    // `void _exhaustive`, `void driver`, `void this._deps` — not calls.
    expect(findBareVoidPromiseCalls('void _exhaustive').length).toBe(0)
    expect(findBareVoidPromiseCalls('void driver').length).toBe(0)
    expect(findBareVoidPromiseCalls('void this._deps').length).toBe(0)
  })

  test('does NOT flag a void CALL inside a fireAndForget argument (only statements)', () => {
    // A `void x()` appearing as an argument (not an expression-statement) is
    // out of scope — the gate targets the fire-and-forget STATEMENT form.
    const hits = findBareVoidPromiseCalls('const y = (void a(), b())')
    expect(hits.length).toBe(0)
  })

  test('flags each of several statements independently', () => {
    const src = ['void a()', 'void b().catch(() => {})', 'void 0', 'void c'].join('\n')
    expect(findBareVoidPromiseCalls(src).length).toBe(2)
  })
})
