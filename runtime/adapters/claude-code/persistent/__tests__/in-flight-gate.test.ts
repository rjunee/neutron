/**
 * in-flight-gate.test.ts — the process-local respawn/tick mutex (S2 § 6
 * acceptance #3, the same-process half of "no double-spawn").
 */

import { describe, it, expect } from 'bun:test'
import { makeInFlightGate } from '../in-flight-gate.ts'

describe('in-flight-gate', () => {
  it('first claim wins, second is refused until release', () => {
    const gate = makeInFlightGate()
    expect(gate.claim()).toBe(true)
    expect(gate.claim()).toBe(false)
    expect(gate.claim()).toBe(false)
    gate.release()
    expect(gate.claim()).toBe(true)
  })

  it('release is idempotent (safe without a prior claim)', () => {
    const gate = makeInFlightGate()
    gate.release()
    gate.release()
    expect(gate.claim()).toBe(true)
  })

  it('exactly one of N concurrent claimers wins', () => {
    const gate = makeInFlightGate()
    // JS is single-threaded; sync claim() calls don't interleave — the gate
    // guarantees exactly one winner among any burst.
    const winners = Array.from({ length: 8 }, () => gate.claim()).filter(Boolean)
    expect(winners.length).toBe(1)
  })
})
