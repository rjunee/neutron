import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose'
import {
  ClaimsSchema,
  JwksCache,
  JwtValidationError,
  NEUTRON_AUDIENCE,
  loadJwks,
  validateJwt,
} from './index.ts'

interface KeyMaterial {
  kid: string
  privateKey: CryptoKey
  publicJwk: JWK
}

async function makeKey(kid: string): Promise<KeyMaterial> {
  // jose v5: generateKeyPair returns CryptoKey objects when run on Bun's WebCrypto.
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' }
  return { kid, privateKey, publicJwk }
}

interface SignOpts {
  audience?: string | string[]
  expSecondsFromNow?: number
  iat?: number
  sub?: string
  memberships?: ReadonlyArray<{ slug: string; role: 'owner' | 'admin' | 'member'; kind: 'user' | 'workspace' }>
}

async function sign(key: KeyMaterial, opts: SignOpts = {}): Promise<string> {
  const aud = opts.audience ?? NEUTRON_AUDIENCE
  const sub = opts.sub ?? 'user-1'
  const memberships = opts.memberships ?? [{ slug: 'user-1', role: 'owner', kind: 'user' }]
  const nowSec = Math.floor(Date.now() / 1000)
  const iat = opts.iat ?? nowSec
  const exp = iat + (opts.expSecondsFromNow ?? 24 * 3600)
  return new SignJWT({ memberships })
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid })
    .setSubject(sub)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setAudience(aud)
    .sign(key.privateKey)
}

describe('jwt-validator — claims schema', () => {
  test('round-trips a valid claims object', () => {
    const data = {
      sub: 'user-1',
      iat: 1_700_000_000,
      exp: 1_700_086_400,
      aud: ['neutron'],
      memberships: [{ slug: 'user-1', role: 'owner', kind: 'user' }],
    }
    const result = ClaimsSchema.safeParse(data)
    expect(result.success).toBe(true)
  })

  test('rejects missing sub', () => {
    const result = ClaimsSchema.safeParse({
      iat: 1,
      exp: 2,
      aud: ['neutron'],
      memberships: [],
    })
    expect(result.success).toBe(false)
  })

  test('rejects invalid role enum', () => {
    const result = ClaimsSchema.safeParse({
      sub: 'user-1',
      iat: 1,
      exp: 2,
      aud: ['neutron'],
      memberships: [{ slug: 'foo', role: 'BOGUS', kind: 'user' }],
    })
    expect(result.success).toBe(false)
  })
})

describe('jwt-validator — validateJwt', () => {
  let key1: KeyMaterial
  let key2: KeyMaterial
  let jwks: JSONWebKeySet

  beforeEach(async () => {
    key1 = await makeKey('k1')
    key2 = await makeKey('k2')
    jwks = { keys: [key1.publicJwk, key2.publicJwk] }
  })

  test('verifies a well-formed token signed by a key in the JWKS', async () => {
    const token = await sign(key1)
    const claims = await validateJwt(token, jwks)
    expect(claims.sub).toBe('user-1')
    expect(claims.aud).toEqual(['neutron'])
    expect(claims.memberships).toHaveLength(1)
  })

  test('rejects an expired token', async () => {
    const token = await sign(key1, { iat: 1_700_000_000, expSecondsFromNow: 60 })
    await expect(validateJwt(token, jwks)).rejects.toBeInstanceOf(JwtValidationError)
  })

  test('rejects a token signed by a key NOT in the JWKS', async () => {
    const stranger = await makeKey('rogue')
    const token = await sign(stranger)
    await expect(validateJwt(token, jwks)).rejects.toBeInstanceOf(JwtValidationError)
  })

  test('rejects a token whose audience is wrong', async () => {
    const token = await sign(key1, { audience: ['someone-else'] })
    await expect(validateJwt(token, jwks)).rejects.toBeInstanceOf(JwtValidationError)
  })

  test('rejects a tampered signature', async () => {
    const token = await sign(key1)
    // Flip a bit in the signature (last segment) — flips base64url 'a'<->'b'.
    const parts = token.split('.')
    const sig = parts[2] ?? ''
    const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1)
    parts[2] = flipped
    const tampered = parts.join('.')
    await expect(validateJwt(tampered, jwks)).rejects.toBeInstanceOf(JwtValidationError)
  })

  test('rotated key — old token still validates while old key is in JWKS', async () => {
    // Issued under key1; jwks still includes key1 + key2; token must still verify.
    const token = await sign(key1)
    const claims = await validateJwt(token, jwks)
    expect(claims.sub).toBe('user-1')
  })

  test('rotated key — old token rejects once old key is removed from JWKS', async () => {
    const token = await sign(key1)
    const onlyNewKey: JSONWebKeySet = { keys: [key2.publicJwk] }
    await expect(validateJwt(token, onlyNewKey)).rejects.toBeInstanceOf(JwtValidationError)
  })

  test('alg confusion: a token with alg=none is rejected', async () => {
    // Hand-craft an unsigned token: header={alg:none,kid:k1}, payload, empty sig.
    const enc = (obj: unknown): string =>
      Buffer.from(JSON.stringify(obj)).toString('base64url')
    const header = enc({ alg: 'none', kid: 'k1' })
    const payload = enc({
      sub: 'user-1',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: ['neutron'],
      memberships: [],
    })
    const token = `${header}.${payload}.`
    await expect(validateJwt(token, jwks)).rejects.toBeInstanceOf(JwtValidationError)
  })

  test('clock skew tolerance respects the option', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await sign(key1, { iat: nowSec - 7200, expSecondsFromNow: 60 }) // expired 1h ago
    // Default skew=0: rejects.
    await expect(validateJwt(token, jwks)).rejects.toBeInstanceOf(JwtValidationError)
    // 2h tolerance: accepts.
    const claims = await validateJwt(token, jwks, { clockToleranceSec: 2 * 3600 })
    expect(claims.sub).toBe('user-1')
  })
})

describe('jwt-validator — JwksCache', () => {
  let key1: KeyMaterial
  let jwks: JSONWebKeySet
  let fetchCalls: number

  beforeEach(async () => {
    key1 = await makeKey('k1')
    jwks = { keys: [key1.publicJwk] }
    fetchCalls = 0
  })

  function makeFetch(jwksToServe: JSONWebKeySet | null): (input: string) => Promise<Response> {
    return async (_input: string) => {
      fetchCalls += 1
      if (jwksToServe === null) {
        return new Response('boom', { status: 503 })
      }
      return new Response(JSON.stringify(jwksToServe), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
  }

  test('first get() fetches; subsequent gets within TTL hit the cache', async () => {
    const cache = new JwksCache('http://example.invalid/jwks', {
      fetch: makeFetch(jwks),
      ttlMs: 60_000,
    })
    const a = await cache.get()
    const b = await cache.get()
    const c = await cache.get()
    expect(a).toEqual(jwks)
    expect(b).toEqual(jwks)
    expect(c).toEqual(jwks)
    expect(fetchCalls).toBe(1)
  })

  test('TTL expiry triggers a refresh', async () => {
    let now = 1_000_000
    const cache = new JwksCache('http://example.invalid/jwks', {
      fetch: makeFetch(jwks),
      ttlMs: 60_000,
      now: () => now,
    })
    await cache.get()
    expect(fetchCalls).toBe(1)
    now += 30_000 // half-way through TTL
    await cache.get()
    expect(fetchCalls).toBe(1)
    now += 31_000 // past TTL
    await cache.get()
    expect(fetchCalls).toBe(2)
  })

  test('concurrent gets at TTL boundary cause one upstream call, not N', async () => {
    const cache = new JwksCache('http://example.invalid/jwks', {
      fetch: makeFetch(jwks),
      ttlMs: 60_000,
    })
    const results = await Promise.all([cache.get(), cache.get(), cache.get(), cache.get()])
    for (const r of results) expect(r).toEqual(jwks)
    expect(fetchCalls).toBe(1)
  })

  test('upstream THROW (network failure) with stale cache: returns stale rather than re-throwing', async () => {
    // Codex r1 P2 finding: the original cache only handled !res.ok. When
    // fetch() rejects outright (DNS failure / refused connection /
    // timeout) the cache used to propagate the exception and drop local
    // validation past the TTL — directly contradicting the locked
    // 24h-grace tolerance from § A.3.4.
    let networkUp = true
    const fetchImpl = async (_input: string): Promise<Response> => {
      fetchCalls += 1
      if (!networkUp) throw new TypeError('fetch failed: ECONNREFUSED')
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    let now = 1_000_000
    const cache = new JwksCache('http://example.invalid/jwks', {
      fetch: fetchImpl,
      ttlMs: 60_000,
      now: () => now,
    })
    await cache.get()
    expect(fetchCalls).toBe(1)
    networkUp = false
    now += 120_000 // expire
    const stale = await cache.get()
    expect(stale).toEqual(jwks)
    expect(fetchCalls).toBe(2)
  })

  test('upstream NON-OK with stale cache: returns stale rather than throwing', async () => {
    let serve: JSONWebKeySet | null = jwks
    const fetchImpl = (_input: string): Promise<Response> => {
      fetchCalls += 1
      if (serve === null) return Promise.resolve(new Response('boom', { status: 503 }))
      return Promise.resolve(
        new Response(JSON.stringify(serve), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    let now = 1_000_000
    const cache = new JwksCache('http://example.invalid/jwks', {
      fetch: fetchImpl,
      ttlMs: 60_000,
      now: () => now,
    })
    await cache.get()
    expect(fetchCalls).toBe(1)
    serve = null
    now += 120_000 // expire
    const stale = await cache.get()
    expect(stale).toEqual(jwks) // served stale, did not throw
    expect(fetchCalls).toBe(2)
  })

  test('upstream failure with NO cache: throws', async () => {
    const cache = new JwksCache('http://example.invalid/jwks', {
      fetch: makeFetch(null),
    })
    await expect(cache.get()).rejects.toBeInstanceOf(JwtValidationError)
  })

  test('loadJwks one-shot equivalent', async () => {
    const out = await loadJwks('http://example.invalid/jwks', {
      fetch: makeFetch(jwks),
    })
    expect(out).toEqual(jwks)
    expect(fetchCalls).toBe(1)
  })
})
