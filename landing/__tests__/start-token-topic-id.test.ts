/**
 * start-token-topic-id — upload-header resolution across BOTH start-token
 * shapes the landing chat client may hold.
 *
 * THE BUG (Ryan, dogfooding the self-host install): after the import-upload
 * route was mounted (no more 404), uploading a Claude export STILL did not
 * advance onboarding out of `import_upload_pending`. Root cause one layer
 * deeper — `resolveUploadTopicId` decoded the start-token as a JWT (`sub`
 * claim in segment 1), but the Open single-owner start-token
 * (`open/local-start-token.ts`) is a 2-segment HMAC token whose identity is
 * `user_id` in segment 0 and whose segment 1 is the raw HMAC signature. So
 * in real Open usage resolution returned null → the client sent NO
 * `X-Neutron-Topic-Id` → the gateway fell back to topic 'chat' → the upload
 * never correlated to the active session → the engine never advanced.
 *
 * The prior PR's test MASKED this by feeding a JWT-shaped token. These
 * tests mint a REAL Open start-token via the SAME `buildLocalStartTokenAuth`
 * helper the Open server mints with, and assert the header resolves to
 * `web:<user_id>` (NOT null / the 'chat' fallback). They FAIL against the
 * pre-fix JWT-only decoder and PASS after.
 *
 * No DOM is required — `atob` + `TextDecoder` are Bun globals; the leaf is
 * dependency-free (no chat.ts self-bootstrap pulled in).
 */

import { describe, expect, test } from 'bun:test'

import { buildLocalStartTokenAuth } from '../../open/local-start-token.ts'
import {
  decodeJwtSubClaim,
  decodeStartTokenUserId,
  startTokenTopicId,
} from '../start-token-topic-id.ts'

const SECRET = 'open-test-secret-0123456789'

/** Mint a Managed-shaped JWT (header.payload.signature) carrying `sub`. */
function makeJwt(claims: Record<string, unknown>): string {
  const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claims))
  return `${header}.${payload}.signature-bytes-not-verified-client-side`
}

describe('startTokenTopicId — Open single-owner HMAC start-token', () => {
  test('resolves web:<user_id> from a REAL Open start-token (regression: was null)', () => {
    const auth = buildLocalStartTokenAuth(SECRET)
    const token = auth.mint({ project_slug: 'owner', user_id: 'owner' })

    // Sanity: it really is the 2-segment HMAC shape, NOT a 3-segment JWT.
    expect(token.split('.').length).toBe(2)

    // The headline assertion. Pre-fix, `decodeJwtSubClaim` read segment 1
    // (the HMAC signature) as JSON, found no `sub`, and returned null →
    // no header → 'chat' fallback → onboarding stuck.
    expect(startTokenTopicId(token)).toBe('web:owner')
    expect(decodeStartTokenUserId(token)).toBe('owner')
  })

  test('non-owner user_id round-trips into the topic id', () => {
    const auth = buildLocalStartTokenAuth(SECRET)
    const token = auth.mint({ project_slug: 'owner', user_id: 'u-7f3a' })
    expect(startTokenTopicId(token)).toBe('web:u-7f3a')
  })

  test('the pre-fix JWT-only decoder cannot resolve the Open token (documents the bug)', () => {
    const auth = buildLocalStartTokenAuth(SECRET)
    const token = auth.mint({ project_slug: 'owner', user_id: 'owner' })
    // `decodeJwtSubClaim` reads segment 1 = the HMAC signature, not JSON.
    expect(decodeJwtSubClaim(token)).toBeNull()
  })
})

describe('startTokenTopicId — Managed JWT start-token (unaffected)', () => {
  test('resolves web:<sub> from a Managed JWT', () => {
    const jwt = makeJwt({ sub: 'user-123', aud: 'start-token' })
    expect(startTokenTopicId(jwt)).toBe('web:user-123')
    expect(decodeStartTokenUserId(jwt)).toBe('user-123')
    // Back-compat decoder still works for the JWT shape.
    expect(decodeJwtSubClaim(jwt)).toBe('user-123')
  })

  test('non-ASCII sub survives the UTF-8 decode path', () => {
    const jwt = makeJwt({ sub: 'naïve-Ω' })
    expect(startTokenTopicId(jwt)).toBe('web:naïve-Ω')
  })
})

describe('startTokenTopicId — malformed / missing', () => {
  test('returns null for empty / single-segment / non-JSON tokens', () => {
    expect(startTokenTopicId('')).toBeNull()
    expect(startTokenTopicId('not-a-token')).toBeNull()
    // 2-segment but segment 0 isn't JSON → Open path returns null.
    expect(startTokenTopicId('@@@.@@@')).toBeNull()
    // 3-segment JWT with no `sub`.
    expect(startTokenTopicId(makeJwt({ aud: 'x' }))).toBeNull()
  })
})
