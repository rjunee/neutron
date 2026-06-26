/**
 * S11 — `decodeJwtSubClaim` unit tests.
 *
 * The production landing chat client decodes the start-token JWT's
 * `sub` claim client-side so the upload affordance can send
 * `X-Neutron-Topic-Id: web:<sub>` on every `/api/upload/<source>`
 * POST. Signature verification already happened server-side at the WS
 * upgrade boundary; the client only needs the routing identity, so
 * decode-without-verify is correct (and dependency-free).
 *
 * No DOM is required — `atob` + `TextDecoder` are Bun globals.
 */

import { describe, expect, test } from 'bun:test'
import { decodeJwtSubClaim } from '../start-token-topic-id.ts'

function b64urlEncode(s: string): string {
  // Bun has Buffer; this avoids pulling in a base64url dep.
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = b64urlEncode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))
  const body = b64urlEncode(JSON.stringify(payload))
  // Signature segment is intentionally garbage — decodeJwtSubClaim
  // does not verify. Production verification happens server-side at
  // the WS upgrade boundary.
  return `${header}.${body}.dontcare`
}

describe('decodeJwtSubClaim (S11)', () => {
  test('extracts sub from a well-formed JWT', async () => {
    const jwt = makeJwt({
      sub: 'synthetic:e2e:m2-walk-20260517T030139Z',
      aud: 'start-token',
    })
    expect(decodeJwtSubClaim(jwt)).toBe(
      'synthetic:e2e:m2-walk-20260517T030139Z',
    )
  })

  test('returns null for a malformed JWT (no dots)', async () => {
    expect(decodeJwtSubClaim('not-a-jwt')).toBeNull()
  })

  test('returns null when payload is not valid JSON', async () => {
    const garbage = `${b64urlEncode('{"alg":"EdDSA"}')}.${b64urlEncode('not-json{')}.sig`
    expect(decodeJwtSubClaim(garbage)).toBeNull()
  })

  test('returns null when sub is missing', async () => {
    const jwt = makeJwt({ aud: 'start-token' })
    expect(decodeJwtSubClaim(jwt)).toBeNull()
  })

  test('returns null when sub is empty string', async () => {
    const jwt = makeJwt({ sub: '' })
    expect(decodeJwtSubClaim(jwt)).toBeNull()
  })

  test('handles base64url segments with no padding', async () => {
    // Force a payload whose base64url encoding has a non-zero padding
    // remainder so the manual `=` re-padding path executes.
    const jwt = makeJwt({ sub: 'ab' })
    expect(decodeJwtSubClaim(jwt)).toBe('ab')
  })

  test('returns null for empty string', async () => {
    expect(decodeJwtSubClaim('')).toBeNull()
  })
})
