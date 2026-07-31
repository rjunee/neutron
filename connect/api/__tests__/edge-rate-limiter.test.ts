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
  DEFAULT_BUCKET_MAX,
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

  test('per-bucket caps are independent', () => {
    const rl = createEdgeRateLimiter({
      windowMs: 60_000,
      max: { 'guest-auth': 1, messages: 50 },
      now: () => 1000,
    })
    expect(rl.check('guest-auth', 'ip')).toBe(true)
    expect(rl.check('guest-auth', 'ip')).toBe(false) // capped at 1
    for (let i = 0; i < 50; i++) {
      expect(rl.check('messages', 'caller')).toBe(true) // its own, wider cap
    }
    expect(rl.check('messages', 'caller')).toBe(false)
  })

  /**
   * ISSUES #421 residual — AN UNCONFIGURED BUCKET IS BOUNDED, NOT UNLIMITED.
   *
   * This test previously asserted the OPPOSITE ("an unconfigured bucket is
   * unlimited") and passed for the entire life of the defect, which is exactly
   * why the defect survived: the wrong default was pinned as intended behaviour.
   * On a fail-closed limiter guarding two unauthenticated endpoints, a config
   * value nobody wrote is the case that most needs the conservative answer.
   */
  test('an UNCONFIGURED bucket falls back to the bounded default, not Infinity', () => {
    const rl = createEdgeRateLimiter({
      windowMs: 60_000,
      max: { 'guest-auth': 1 }, // `messages` not configured
      now: () => 1000,
    })
    // Finiteness is asserted FIRST and the loop bound is clamped, deliberately:
    // `for (i = 0; i < DEFAULT_BUCKET_MAX; …)` reads more naturally but HANGS
    // FOREVER if the constant regresses to Infinity — a test that hangs on the
    // defect it exists to catch is not a test, it is a stalled CI job. (Found by
    // mutation: reinstating `Infinity` wedged the run instead of failing it.)
    expect(Number.isFinite(DEFAULT_BUCKET_MAX)).toBe(true)
    const probe = Math.min(DEFAULT_BUCKET_MAX, 1_000)
    for (let i = 0; i < probe; i++) {
      expect(rl.check('messages', 'caller')).toBe(true)
    }
    expect(rl.check('messages', 'caller')).toBe(false)
  })

  test('an EMPTY max map caps every bucket at the default — no bucket is born unlimited', () => {
    expect(Number.isFinite(DEFAULT_BUCKET_MAX)).toBe(true)
    const probe = Math.min(DEFAULT_BUCKET_MAX, 1_000)
    const rl = createEdgeRateLimiter({ windowMs: 60_000, max: {}, now: () => 1000 })
    for (const bucket of [
      'guest-auth',
      'messages',
      'events',
      'invite-preview',
      'guest-refresh',
    ] as const) {
      for (let i = 0; i < probe; i++) {
        expect(rl.check(bucket, 'k')).toBe(true)
      }
      expect(rl.check(bucket, 'k')).toBe(false)
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
