/**
 * @neutronai/runtime — Internal HMAC sign/verify (Sprint B, 2026-05-20).
 *
 * Shared HMAC signing for server-to-server install-token + Cores OAuth
 * calls. Lifted out of `identity/oauth/internal-signature.ts` so
 * `gateway/http/cores-oauth-surface.ts` can sign/verify internal handoff
 * requests without taking an import edge on the Managed `identity/`
 * tree.
 *
 * Same wire-shape + verification rules as the legacy module; the legacy
 * file now re-exports from here for back-compat with the install-token
 * + identity-side callers.
 *
 * Signature shape:
 *
 *   hex(HMAC-SHA256(shared_secret,
 *                   METHOD + '\n' + PATH + '\n' + TIMESTAMP + '\n' + sha256(body)))
 *
 * - `path` is the URL path WITHOUT query string.
 * - `body` is empty for GETs.
 * - `timestamp_ms` is a Unix-ms integer carried on the wire in the
 *   `x-internal-timestamp` request header. Including it inside the
 *   HMAC payload binds the timestamp to the rest of the signed fields
 *   (an attacker rewriting the header cannot keep the signature valid).
 *
 * Argus PR #210 minor #3 (2026-05-19) — pre-r2 the message only covered
 * METHOD+PATH+body. A captured `/register` signature on Cores OAuth
 * could be replayed at any time before the underlying pending row
 * expired (up to 10 min) to re-register stale state. Adding the
 * timestamp + verifying server-side within ±5 min closes the replay
 * window. Single-use pending rows still defend `/ingest` after the
 * fact, but `/register` had no second line of defense before.
 */

import { createHash, createHmac } from 'node:crypto'
import { constantTimeEqual } from './constant-time-equal.ts'

export interface SignInternalRequestInput {
  method: 'GET' | 'POST'
  path: string
  body: string
  shared_secret: string
  /** Unix-ms — production callers pass `Date.now()`; tests inject. */
  timestamp_ms: number
}

export function signInternalRequest(input: SignInternalRequestInput): string {
  const bodyHash = createHash('sha256').update(input.body, 'utf8').digest('hex')
  const message =
    `${input.method}\n${input.path}\n${input.timestamp_ms}\n${bodyHash}`
  return createHmac('sha256', input.shared_secret).update(message, 'utf8').digest('hex')
}

/** Default ±5 min replay window. The cores-oauth flow's pending row TTL
 *  is 10 min; a 5-min window means a captured signature is unusable for
 *  more than half the row's lifetime, even before single-use consume
 *  kicks in. Aligns with the install-token handoff's per-row TTL. */
export const INTERNAL_REQUEST_MAX_SKEW_MS = 5 * 60 * 1_000

export interface VerifyInternalRequestInput {
  method: 'GET' | 'POST'
  path: string
  body: string
  shared_secret: string
  /** Hex-encoded signature supplied via `x-internal-signature`. */
  supplied_signature: string
  /** Raw header value of `x-internal-timestamp` (string form). */
  supplied_timestamp_header: string
  /** Server wall-clock at verify time (Unix-ms). */
  now_ms: number
  /** Override the ±skew window. Defaults to INTERNAL_REQUEST_MAX_SKEW_MS. */
  max_skew_ms?: number
}

export type VerifyInternalRequestResult =
  | { ok: true }
  | { ok: false; code: 'missing_timestamp' | 'invalid_timestamp' | 'stale_timestamp' | 'invalid_signature' }

/**
 * Combined timestamp + signature verification. Order is deliberate:
 *
 *   1. Header presence (`missing_timestamp` if absent).
 *   2. Parseable integer (`invalid_timestamp` otherwise).
 *   3. Within ±max_skew_ms of `now_ms` (`stale_timestamp` otherwise).
 *   4. HMAC match in constant time (`invalid_signature` otherwise).
 *
 * Returning a discriminated result instead of throwing keeps the call
 * sites Response-shape-aware without sprinkling try/catch.
 */
export function verifyInternalRequest(
  input: VerifyInternalRequestInput,
): VerifyInternalRequestResult {
  if (input.supplied_timestamp_header.length === 0) {
    return { ok: false, code: 'missing_timestamp' }
  }
  const ts = Number.parseInt(input.supplied_timestamp_header, 10)
  if (!Number.isFinite(ts) || ts <= 0) {
    return { ok: false, code: 'invalid_timestamp' }
  }
  const skew = input.max_skew_ms ?? INTERNAL_REQUEST_MAX_SKEW_MS
  if (Math.abs(input.now_ms - ts) > skew) {
    return { ok: false, code: 'stale_timestamp' }
  }
  const expected = signInternalRequest({
    method: input.method,
    path: input.path,
    body: input.body,
    shared_secret: input.shared_secret,
    timestamp_ms: ts,
  })
  if (!constantTimeHexEquals(input.supplied_signature, expected)) {
    return { ok: false, code: 'invalid_signature' }
  }
  return { ok: true }
}

function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  let aBuf: Buffer
  let bBuf: Buffer
  try {
    aBuf = Buffer.from(a, 'hex')
    bBuf = Buffer.from(b, 'hex')
  } catch {
    return false
  }
  // Reject empty signatures locally; the shared leaf handles the length
  // pre-check + constant-time byte comparison.
  if (aBuf.length === 0) return false
  return constantTimeEqual(aBuf, bBuf)
}
