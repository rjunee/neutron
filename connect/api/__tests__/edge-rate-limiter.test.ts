/**
 * Unit coverage for the public-edge fixed-window limiter, with an explicit
 * regression for ISSUES #110: the map key composes `bucket` and `key` with a
 * U+0000 (NUL) separator. The source previously embedded a LITERAL NUL byte
 * (making git treat the file as binary); it now uses the `\x00` string escape,
 * which yields the SAME U+0000 separator at runtime. These tests pin that
 * separator's behaviour so the byte-equivalent change can never regress the
 * key space (no collisions across distinct (bucket,key) pairs).
 */

import { describe, expect, test } from 'bun:test'

import {
  createEdgeRateLimiter,
  type RateLimitBucket,
} from '../edge-rate-limiter.ts'

describe('createEdgeRateLimiter — fixed window', () => {
  test('allows up to `max` hits per window, rejects the (max+1)-th', () => {
    const t = 1000
    const rl = createEdgeRateLimiter({
      windowMs: 60_000,
      max: 3,
      now: () => t,
    })
    expect(rl.check('messages', 'caller-a')).toBe(true) // 1
    expect(rl.check('messages', 'caller-a')).toBe(true) // 2
    expect(rl.check('messages', 'caller-a')).toBe(true) // 3
    expect(rl.check('messages', 'caller-a')).toBe(false) // 4 — over cap
  })

  test('window rolls over after windowMs', () => {
    let t = 1000
    const rl = createEdgeRateLimiter({
      windowMs: 60_000,
      max: 1,
      now: () => t,
    })
    expect(rl.check('guest-auth', '1.2.3.4')).toBe(true)
    expect(rl.check('guest-auth', '1.2.3.4')).toBe(false)
    t += 60_000 // next window
    expect(rl.check('guest-auth', '1.2.3.4')).toBe(true)
  })

  test('per-bucket caps are independent; an unconfigured bucket is unlimited', () => {
    const rl = createEdgeRateLimiter({
      windowMs: 60_000,
      max: { 'guest-auth': 1 }, // `messages` not configured → unlimited
      now: () => 1000,
    })
    expect(rl.check('guest-auth', 'ip')).toBe(true)
    expect(rl.check('guest-auth', 'ip')).toBe(false) // capped at 1
    for (let i = 0; i < 50; i++) {
      expect(rl.check('messages', 'caller')).toBe(true) // never capped
    }
  })
})

describe('map-key separation (ISSUES #110 regression)', () => {
  test('distinct keys within the same bucket are counted independently', () => {
    const rl = createEdgeRateLimiter({
      windowMs: 60_000,
      max: 1,
      now: () => 1000,
    })
    expect(rl.check('messages', 'caller-a')).toBe(true)
    // A different key in the same bucket must NOT inherit caller-a's count.
    expect(rl.check('messages', 'caller-b')).toBe(true)
    // But the SAME (bucket,key) is now over cap.
    expect(rl.check('messages', 'caller-a')).toBe(false)
    expect(rl.check('messages', 'caller-b')).toBe(false)
  })

  test('the same key text under different buckets does not collide', () => {
    const rl = createEdgeRateLimiter({
      windowMs: 60_000,
      max: 1,
      now: () => 1000,
    })
    // Identical `key` ("1.2.3.4") but different buckets → distinct windows.
    expect(rl.check('guest-auth', '1.2.3.4')).toBe(true)
    expect(rl.check('messages', '1.2.3.4')).toBe(true)
    expect(rl.check('guest-auth', '1.2.3.4')).toBe(false)
    expect(rl.check('messages', '1.2.3.4')).toBe(false)
  })

  test('the runtime separator is exactly U+0000 (byte-equivalence pin)', () => {
    // The whole #110 fix rests on `\x00` compiling to the SAME single code unit
    // (U+0000) that the previously-embedded literal NUL byte was. Pin it here.
    // Build the expected separator via String.fromCharCode(0) so THIS test file
    // never itself embeds a literal NUL (which would re-binary it in git).
    const nul = String.fromCharCode(0)
    const sep = `${'a'}\x00${'b'}`
    expect(sep).toBe('a' + nul + 'b')
    expect(sep.charCodeAt(1)).toBe(0)
    expect(sep.length).toBe(3)
  })
})

// Type-only assertion that the public bucket union is reachable from tests.
const _bucket: RateLimitBucket = 'events'
void _bucket
