/**
 * Sprint 19 Phase 1 — `buildJwksResolveKey` unit tests.
 *
 * The adapter sits between `JwksCache.get()` and the
 * `(kid) => Promise<KeyLike | null>` shape that
 * `gateway/http/chat-bridge.ts:buildWebChatBridge` consumes via
 * `signup/start-token.ts:verifyStartToken`.
 *
 * Verifies:
 *   - Valid EdDSA JWK → resolves to importable KeyLike (round-trips through
 *     jose.exportJWK / generateKeyPair).
 *   - Unknown `kid` → null.
 *   - Algorithm-confusion guard: `jwk.alg === 'RS256'` → null.
 *   - Symmetric / wrong-kty guard: `kty === 'oct'` and `kty === 'EC'` → null.
 *   - Curve guard: `crv === 'Ed448'` → null.
 *
 * The JwksCache dependency is stubbed via a class that implements `.get()`;
 * we don't reach for the real network-backed cache because the adapter
 * only consumes the cache's return value.
 */

import { describe, expect, test } from 'bun:test'
import {
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
} from 'jose'
import { buildJwksResolveKey } from '../resolve-key.ts'
import type { JwksCache } from '../validator.ts'

/**
 * Minimal stub for JwksCache. The adapter only calls `.get()`, so we
 * cast the stub to `JwksCache` for compatibility with the parameter
 * type; the rest of the cache surface is irrelevant here.
 */
class StubJwksCache {
  constructor(private readonly set: JSONWebKeySet) {}
  async get(): Promise<JSONWebKeySet> {
    return this.set
  }
}

function asJwksCache(stub: StubJwksCache): JwksCache {
  return stub as unknown as JwksCache
}

async function mintEdDSAJwk(kid: string): Promise<JWK> {
  const { publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  const pubJwk = await exportJWK(publicKey)
  return { ...pubJwk, kid, alg: 'EdDSA', use: 'sig' }
}

describe('buildJwksResolveKey', () => {
  test('returns importable KeyLike for valid EdDSA JWK with matching kid', async () => {
    const jwk = await mintEdDSAJwk('k1')
    const cache = new StubJwksCache({ keys: [jwk] })
    const resolveKey = buildJwksResolveKey(asJwksCache(cache))

    const key = await resolveKey('k1')
    expect(key).not.toBeNull()
    // Asymmetric key material — the adapter has narrowed away Uint8Array.
    expect(key instanceof Uint8Array).toBe(false)
  })

  test('returns null for unknown kid', async () => {
    const jwk = await mintEdDSAJwk('k1')
    const cache = new StubJwksCache({ keys: [jwk] })
    const resolveKey = buildJwksResolveKey(asJwksCache(cache))

    expect(await resolveKey('k-unknown')).toBeNull()
  })

  test("returns null when jwk.alg === 'RS256' (algorithm-confusion guard)", async () => {
    // We don't need the JWK to be a real RSA key — the adapter refuses
    // BEFORE calling importJWK, so a JWK with alg=RS256 fails fast.
    const jwk: JWK = { kid: 'rs1', kty: 'OKP', crv: 'Ed25519', alg: 'RS256', x: 'x' }
    const cache = new StubJwksCache({ keys: [jwk] })
    const resolveKey = buildJwksResolveKey(asJwksCache(cache))

    expect(await resolveKey('rs1')).toBeNull()
  })

  test("returns null when jwk.kty === 'oct' (symmetric — never EdDSA pubkey)", async () => {
    const jwk: JWK = { kid: 'oct1', kty: 'oct', alg: 'EdDSA', k: 'AAAA' }
    const cache = new StubJwksCache({ keys: [jwk] })
    const resolveKey = buildJwksResolveKey(asJwksCache(cache))

    expect(await resolveKey('oct1')).toBeNull()
  })

  test("returns null when jwk.kty === 'EC' (wrong key type)", async () => {
    const jwk: JWK = {
      kid: 'ec1',
      kty: 'EC',
      crv: 'P-256',
      alg: 'EdDSA',
      x: 'x',
      y: 'y',
    }
    const cache = new StubJwksCache({ keys: [jwk] })
    const resolveKey = buildJwksResolveKey(asJwksCache(cache))

    expect(await resolveKey('ec1')).toBeNull()
  })

  test("returns null when jwk.crv === 'Ed448' (wrong curve)", async () => {
    const jwk: JWK = {
      kid: 'ed448-1',
      kty: 'OKP',
      crv: 'Ed448',
      alg: 'EdDSA',
      x: 'x',
    }
    const cache = new StubJwksCache({ keys: [jwk] })
    const resolveKey = buildJwksResolveKey(asJwksCache(cache))

    expect(await resolveKey('ed448-1')).toBeNull()
  })
})
