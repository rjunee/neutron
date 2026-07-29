/**
 * @neutronai/runtime — constant-time-equal leaf.
 *
 * The ONE timing-safe byte-equality primitive. Consolidates the hand-rolled
 * `timingSafeEqual` + length-precheck boilerplate the 2026-06-15 Open refactor
 * audit (P3-10) found duplicated across four auth contexts: the landing
 * session-cookie verifier, the runtime internal-signature verifier, the
 * persistent admin-respawn token compare, and the gateway instance-slug
 * compare. Each kept its OWN length pre-check + `node:crypto` import; the
 * per-context wrapping (null guards, hex decoding, result inversion) stays
 * local at the call site — only this primitive is shared.
 *
 * Timing safety: the `length` pre-check is REQUIRED — `node:crypto`'s
 * `timingSafeEqual` throws on unequal-length buffers, so every original copy
 * already guarded length first. That pre-check leaks only the LENGTH (standard
 * and unavoidable for `timingSafeEqual`); it is NOT a content early-return, so
 * the byte comparison itself stays fully constant-time.
 */

import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time equality of two byte sequences. Strings are encoded with
 * `encoding` (default `utf8`); Buffers are compared as-is. Returns `false` the
 * moment the byte lengths differ (the mandatory `timingSafeEqual` length
 * guard), otherwise performs a constant-time byte comparison.
 */
export function constantTimeEqual(
  a: Buffer | string,
  b: Buffer | string,
  encoding: BufferEncoding = 'utf8',
): boolean {
  const aBuf = typeof a === 'string' ? Buffer.from(a, encoding) : a
  const bBuf = typeof b === 'string' ? Buffer.from(b, encoding) : b
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}
