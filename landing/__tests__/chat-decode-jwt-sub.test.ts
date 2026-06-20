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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  // The chat.ts module guards its self-bootstrap with `typeof window`,
  // and importing it under a bare Bun runtime gives `undefined` for
  // `window` → the guard short-circuits and decodeJwtSubClaim is just
  // a plain export. We still register a DOM (matching the rest of the
  // landing test suite) so the import surface stays uniform across
  // tests and a future module-level DOM access doesn't crash this one.
  GlobalRegistrator.register({ url: 'https://t-test.neutron.test/chat' })
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    static OPEN = 1
    readyState = 0
    addEventListener(): void {}
    send(): void {}
    close(): void {}
  }
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

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
    const mod = await import('../chat.ts')
    const jwt = makeJwt({
      sub: 'synthetic:e2e:m2-walk-20260517T030139Z',
      aud: 'start-token',
    })
    expect(mod.decodeJwtSubClaim(jwt)).toBe(
      'synthetic:e2e:m2-walk-20260517T030139Z',
    )
  })

  test('returns null for a malformed JWT (no dots)', async () => {
    const mod = await import('../chat.ts')
    expect(mod.decodeJwtSubClaim('not-a-jwt')).toBeNull()
  })

  test('returns null when payload is not valid JSON', async () => {
    const mod = await import('../chat.ts')
    const garbage = `${b64urlEncode('{"alg":"EdDSA"}')}.${b64urlEncode('not-json{')}.sig`
    expect(mod.decodeJwtSubClaim(garbage)).toBeNull()
  })

  test('returns null when sub is missing', async () => {
    const mod = await import('../chat.ts')
    const jwt = makeJwt({ aud: 'start-token' })
    expect(mod.decodeJwtSubClaim(jwt)).toBeNull()
  })

  test('returns null when sub is empty string', async () => {
    const mod = await import('../chat.ts')
    const jwt = makeJwt({ sub: '' })
    expect(mod.decodeJwtSubClaim(jwt)).toBeNull()
  })

  test('handles base64url segments with no padding', async () => {
    const mod = await import('../chat.ts')
    // Force a payload whose base64url encoding has a non-zero padding
    // remainder so the manual `=` re-padding path executes.
    const jwt = makeJwt({ sub: 'ab' })
    expect(mod.decodeJwtSubClaim(jwt)).toBe('ab')
  })

  test('returns null for empty string', async () => {
    const mod = await import('../chat.ts')
    expect(mod.decodeJwtSubClaim('')).toBeNull()
  })
})
