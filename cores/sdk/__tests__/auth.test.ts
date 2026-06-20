import { describe, expect, test } from 'bun:test'
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type KeyLike,
  type JSONWebKeySet,
  type JWK,
} from 'jose'

import {
  JwksCache,
  PlatformJwtError,
  buildDevPlatformJwtValidator,
  buildPlatformJwtValidator,
  validatePlatformJwt,
} from '../auth.ts'

interface KeyMaterial {
  kid: string
  privateKey: KeyLike
  publicJwk: JWK
}

async function makeKey(kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    extractable: true,
  })
  const publicJwk: JWK = {
    ...(await exportJWK(publicKey)),
    kid,
    alg: 'EdDSA',
    use: 'sig',
  }
  return { kid, privateKey, publicJwk }
}

interface SignOpts {
  audience?: string | string[]
  expSecondsFromNow?: number
  iat?: number
  sub?: string
  memberships?: ReadonlyArray<{
    slug: string
    role: 'owner' | 'admin' | 'member'
    kind: 'user' | 'workspace'
  }>
}

async function sign(key: KeyMaterial, opts: SignOpts = {}): Promise<string> {
  const aud = opts.audience ?? 'neutron'
  const sub = opts.sub ?? 'user-1'
  const memberships =
    opts.memberships ?? [{ slug: 'topline', role: 'owner' as const, kind: 'user' as const }]
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

describe('auth — validatePlatformJwt — happy path', () => {
  test('returns claims for a valid token whose memberships include the expected slug', async () => {
    const key = await makeKey('k1')
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }
    const token = await sign(key)
    const r = await validatePlatformJwt(token, jwks, {
      expected_project_slug: 'topline',
    })
    expect(r.project_slug).toBe('topline')
    expect(r.user_id).toBe('user-1')
    expect(r.claims.memberships[0]?.slug).toBe('topline')
  })

  test('accepts a string audience (not just array)', async () => {
    const key = await makeKey('k1')
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }
    const token = await sign(key, { audience: 'neutron' })
    await expect(
      validatePlatformJwt(token, jwks, { expected_project_slug: 'topline' }),
    ).resolves.toBeDefined()
  })
})

describe('auth — validatePlatformJwt — rejection paths', () => {
  test('rejects expired token with token_expired', async () => {
    const key = await makeKey('k1')
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }
    const token = await sign(key, {
      iat: Math.floor(Date.now() / 1000) - 10_000,
      expSecondsFromNow: -1_000,
    })
    await expect(
      validatePlatformJwt(token, jwks, { expected_project_slug: 'topline' }),
    ).rejects.toMatchObject({ name: 'PlatformJwtError', code: 'token_expired' })
  })

  test('rejects wrong audience with wrong_audience', async () => {
    const key = await makeKey('k1')
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }
    const token = await sign(key, { audience: 'something-else' })
    await expect(
      validatePlatformJwt(token, jwks, { expected_project_slug: 'topline' }),
    ).rejects.toMatchObject({ name: 'PlatformJwtError', code: 'wrong_audience' })
  })

  test('rejects when memberships do not include expected_project_slug', async () => {
    const key = await makeKey('k1')
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }
    const token = await sign(key, {
      memberships: [{ slug: 'northwind', role: 'owner', kind: 'user' }],
    })
    await expect(
      validatePlatformJwt(token, jwks, { expected_project_slug: 'topline' }),
    ).rejects.toMatchObject({
      name: 'PlatformJwtError',
      code: 'missing_membership',
    })
  })

  test('rejects token signed by a key not in the JWKS', async () => {
    const key1 = await makeKey('k1')
    const key2 = await makeKey('k2')
    const jwks: JSONWebKeySet = { keys: [key2.publicJwk] }
    const token = await sign(key1)
    await expect(
      validatePlatformJwt(token, jwks, { expected_project_slug: 'topline' }),
    ).rejects.toMatchObject({ name: 'PlatformJwtError' })
  })

  test('rejects an empty token string', async () => {
    const jwks: JSONWebKeySet = { keys: [] }
    await expect(
      validatePlatformJwt('', jwks, { expected_project_slug: 'topline' }),
    ).rejects.toMatchObject({ name: 'PlatformJwtError', code: 'token_invalid' })
  })

  test('rejects token whose payload is missing iat (Codex r1 P1)', async () => {
    const key = await makeKey('k1')
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }
    // Hand-craft a token without iat — bypass `setIssuedAt`.
    const token = await new SignJWT({
      memberships: [{ slug: 'topline', role: 'owner', kind: 'user' }],
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: key.kid })
      .setSubject('user-1')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .setAudience('neutron')
      .sign(key.privateKey)
    await expect(
      validatePlatformJwt(token, jwks, { expected_project_slug: 'topline' }),
    ).rejects.toMatchObject({ name: 'PlatformJwtError', code: 'token_invalid' })
  })

  test('rejects token whose memberships[] has a malformed entry (Codex r4 P2)', async () => {
    const key = await makeKey('k1')
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }
    const token = await sign(key, {
      memberships: [
        { slug: 'topline', role: 'owner', kind: 'user' },
        // @ts-expect-error — synthesizing a malformed membership entry
        { slug: 'northwind', role: 'BOGUS', kind: 'user' },
      ],
    })
    await expect(
      validatePlatformJwt(token, jwks, { expected_project_slug: 'topline' }),
    ).rejects.toMatchObject({
      name: 'PlatformJwtError',
      code: 'token_invalid',
    })
  })

  test('rejects token with non-object membership entry (Codex r4 P2)', async () => {
    const key = await makeKey('k1')
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }
    const token = await new SignJWT({
      memberships: ['not-an-object'],
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: key.kid })
      .setSubject('user-1')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .setAudience('neutron')
      .sign(key.privateKey)
    await expect(
      validatePlatformJwt(token, jwks, { expected_project_slug: 'topline' }),
    ).rejects.toMatchObject({
      name: 'PlatformJwtError',
      code: 'token_invalid',
    })
  })
})

describe('auth — JwksCache', () => {
  test('caches JWKS for ttlMs (Codex r1 P1: stops per-request fetch)', async () => {
    const key = await makeKey('k1')
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }
    let fetchCount = 0
    const fetchImpl = async (): Promise<Response> => {
      fetchCount += 1
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const cache = new JwksCache('http://example.invalid/jwks', {
      fetch: fetchImpl,
      ttlMs: 60_000,
    })
    await cache.get()
    await cache.get()
    await cache.get()
    expect(fetchCount).toBe(1)
  })

  test('serves stale JWKS on transient fetch error', async () => {
    const key = await makeKey('k1')
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }
    let serve: 'good' | 'bad' = 'good'
    const fetchImpl = async (): Promise<Response> => {
      if (serve === 'bad') throw new Error('network down')
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    let fakeNow = 1_000_000
    const cache = new JwksCache('http://example.invalid/jwks', {
      fetch: fetchImpl,
      ttlMs: 60_000,
      now: () => fakeNow,
    })
    await cache.get()
    fakeNow += 120_000 // expire the cache
    serve = 'bad'
    const result = await cache.get()
    expect(result).toEqual(jwks)
  })

  test('throws when first-fetch-on-boot fails', async () => {
    const cache = new JwksCache('http://example.invalid/jwks', {
      fetch: async () => {
        throw new Error('nope')
      },
    })
    await expect(cache.get()).rejects.toMatchObject({
      name: 'PlatformJwtError',
      code: 'jwks_fetch_failed',
    })
  })
})

describe('auth — buildPlatformJwtValidator (high-level factory)', () => {
  test('caches JWKS across validator calls', async () => {
    const key = await makeKey('k1')
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }
    let fetchCount = 0
    const fetchImpl = async (): Promise<Response> => {
      fetchCount += 1
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const validator = buildPlatformJwtValidator({
      jwks_url: 'http://example.invalid/jwks',
      expected_project_slug: 'topline',
      fetch: fetchImpl,
    })
    const token = await sign(key)
    await validator(token)
    await validator(token)
    await validator(token)
    expect(fetchCount).toBe(1)
  })
})

describe('auth — buildDevPlatformJwtValidator', () => {
  test('throws without NEUTRON_DEV_AUTH unless bypass_env_guard is set', () => {
    expect(() =>
      buildDevPlatformJwtValidator({
        admin_email: 'user@example.com',
        bearer_token: 'dev',
        project_slug: 'topline',
      }),
    ).toThrow(PlatformJwtError)
  })

  test('accepts the matching bearer token and returns synthetic claims', async () => {
    const validator = buildDevPlatformJwtValidator({
      admin_email: 'user@example.com',
      bearer_token: 'dev-token',
      project_slug: 'topline',
      bypass_env_guard: true,
    })
    const r = await validator('dev-token')
    expect(r.project_slug).toBe('topline')
    expect(r.user_id).toBe('user@example.com')
    expect(r.claims.memberships[0]?.slug).toBe('topline')
    expect(r.claims.memberships[0]?.role).toBe('owner')
  })

  test('rejects an incorrect bearer token', async () => {
    const validator = buildDevPlatformJwtValidator({
      admin_email: 'user@example.com',
      bearer_token: 'dev-token',
      project_slug: 'topline',
      bypass_env_guard: true,
    })
    await expect(validator('wrong')).rejects.toMatchObject({
      name: 'PlatformJwtError',
      code: 'token_invalid',
    })
  })
})
