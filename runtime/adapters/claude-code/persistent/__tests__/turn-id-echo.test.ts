/**
 * turn-id-echo.test.ts — S3 #107 reply-correlation unit (replaces the deleted
 * turn-id-fifo unit). Pins the stateless scalar + stale-reply-debt logic, incl.
 * the Codex-r1-P1 abandoned-turn case the bare scalar mishandled.
 */

import { describe, it, expect } from 'bun:test'
import { TurnIdEcho } from '../turn-id-echo.ts'

describe('TurnIdEcho — happy path (one reply per message, in order)', () => {
  it('tags each reply with its own injected turn id; read-and-clears', () => {
    const e = new TurnIdEcho()
    e.onInject('inc:1')
    expect(e.onReply()).toBe('inc:1')
    e.onInject('inc:2')
    expect(e.onReply()).toBe('inc:2')
    // No pending → undefined (substrate rejects an uncorrelated reply).
    expect(e.onReply()).toBeUndefined()
  })
})

describe('TurnIdEcho — primary meta echo wins', () => {
  it('returns the echoed meta turn_id verbatim regardless of the scalar', () => {
    const e = new TurnIdEcho()
    e.onInject('inc:1')
    // A straggler carrying its OWN id is forwarded as-is — the substrate's
    // <incarnation>:<seq> check rejects it, never mis-attributes.
    expect(e.onReply('other:9')).toBe('other:9')
    // The scalar is untouched by the meta path → the real reply still resolves.
    expect(e.onReply()).toBe('inc:1')
  })
})

describe('TurnIdEcho — abandoned turn (Codex r1 P1: timeout-path misattribution)', () => {
  it('skips an abandoned turn’s late reply instead of tagging it with the live turn id', () => {
    const e = new TurnIdEcho()
    // Turn 1 injected, then ABANDONED (substrate timed it out) and turn 2 injected
    // before turn 1’s reply arrived → one unit of debt.
    e.onInject('inc:1')
    e.onInject('inc:2')
    expect(e.staleReplyDebt).toBe(1)
    // Turn 1’s late reply arrives FIRST (CC replies in arrival order) → skipped
    // (no id → substrate rejects), NOT mis-tagged as inc:2.
    expect(e.onReply()).toBeUndefined()
    // Turn 2’s real reply arrives next → correctly tagged inc:2.
    expect(e.onReply()).toBe('inc:2')
    expect(e.staleReplyDebt).toBe(0)
  })

  it('handles multiple consecutive abandoned turns', () => {
    const e = new TurnIdEcho()
    e.onInject('inc:1')
    e.onInject('inc:2')
    e.onInject('inc:3')
    expect(e.staleReplyDebt).toBe(2)
    expect(e.onReply()).toBeUndefined() // inc:1 straggler
    expect(e.onReply()).toBeUndefined() // inc:2 straggler
    expect(e.onReply()).toBe('inc:3') // inc:3 live
  })

  it('a non-matching meta straggler CONSUMES one debt unit (Codex r2 P2)', () => {
    const e = new TurnIdEcho()
    // Turn 1 injected then ABANDONED; turn 2 injected before turn 1's reply → debt=1.
    e.onInject('inc:1')
    e.onInject('inc:2')
    expect(e.staleReplyDebt).toBe(1)
    // Turn 1's abandoned straggler arrives WITH its meta id (≠ live scalar inc:2):
    // forwarded as-is (the substrate's <incarnation>:<seq> check rejects it). It IS
    // the in-order late reply the debt was banked to absorb, so it consumes one debt
    // unit instead of leaking it.
    expect(e.onReply('inc:1')).toBe('inc:1')
    expect(e.staleReplyDebt).toBe(0)
    // Turn 2's legitimate FALLBACK (no-meta) reply now resolves. Pre-fix the leaked
    // debt skipped it (returned undefined → rejected → turn 2 timed out despite
    // having replied) — the exact mixed meta/no-meta failure the finding names.
    expect(e.onReply()).toBe('inc:2')
  })

  it('does not consume debt when there is none (lone meta straggler, debt=0)', () => {
    const e = new TurnIdEcho()
    e.onInject('inc:1')
    // A straggler meta id for a different turn with NO outstanding debt is just
    // forwarded; debt stays 0 and the live scalar is untouched.
    expect(e.onReply('old:9')).toBe('old:9')
    expect(e.staleReplyDebt).toBe(0)
    expect(e.onReply()).toBe('inc:1')
  })
})

describe('TurnIdEcho — meta echo for the live turn clears the scalar (Codex r1 P2)', () => {
  it('does NOT bank phantom debt after a meta-correlated reply for the in-flight turn', () => {
    const e = new TurnIdEcho()
    // Turn 1 injected, then answered via the PRIMARY meta echo carrying its own id.
    e.onInject('inc:1')
    expect(e.onReply('inc:1')).toBe('inc:1')
    // The completed turn's scalar is cleared, so injecting turn 2 banks NO debt.
    e.onInject('inc:2')
    expect(e.staleReplyDebt).toBe(0)
    // Turn 2's legitimate (non-meta) reply resolves — pre-fix the phantom debt
    // skipped it (returned undefined → rejected → turn 2 timed out).
    expect(e.onReply()).toBe('inc:2')
  })

  it('a straggler meta id (≠ live scalar) does not clear the live turn', () => {
    const e = new TurnIdEcho()
    e.onInject('inc:5')
    // Straggler for a DIFFERENT turn arrives first → forwarded, scalar untouched.
    expect(e.onReply('old:1')).toBe('old:1')
    // The live turn's real reply still resolves.
    expect(e.onReply()).toBe('inc:5')
  })
})

describe('TurnIdEcho — undefined inject (no correlation)', () => {
  it('a turn injected with no id resolves to undefined', () => {
    const e = new TurnIdEcho()
    e.onInject(undefined)
    expect(e.onReply()).toBeUndefined()
  })
})
