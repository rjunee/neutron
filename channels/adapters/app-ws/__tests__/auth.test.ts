import { describe, expect, it } from 'bun:test'
import { SignJWT } from 'jose'

import { createAppWsAuthResolver } from '../auth.ts'

describe('createAppWsAuthResolver — dev-bypass', () => {
  const resolver = createAppWsAuthResolver({
    project_slug: 'demo',
    bypass: true,
  })

  it('mode is dev-bypass', () => {
    expect(resolver.mode).toBe('dev-bypass')
  })

  it('accepts a bare user id', async () => {
    const res = await resolver.resolve('sam')
    expect('code' in res).toBe(false)
    if ('code' in res) throw new Error('unreachable')
    expect(res.user_id).toBe('sam')
    expect(res.project_slug).toBe('demo')
  })

  it('accepts a dev:<user_id> token', async () => {
    const res = await resolver.resolve('dev:alice')
    if ('code' in res) throw new Error(`unexpected: ${res.code}`)
    expect(res.user_id).toBe('alice')
  })

  it('rejects empty token', async () => {
    const res = await resolver.resolve('')
    expect('code' in res ? res.code : null).toBe('missing_token')
  })

  it('rejects tokens with disallowed chars', async () => {
    const res = await resolver.resolve('foo bar')
    expect('code' in res ? res.code : null).toBe('malformed_token')
  })
})

describe('createAppWsAuthResolver — HS256', () => {
  const secret = 'dev-secret-please-change'
  const secretBytes = new TextEncoder().encode(secret)
  const resolver = createAppWsAuthResolver({
    project_slug: 'demo',
    bypass: false,
    hs256_secret: secret,
  })

  async function mint(payload: Record<string, unknown>, exp?: number): Promise<string> {
    let jwt = new SignJWT(payload).setProtectedHeader({ alg: 'HS256' })
    if (exp !== undefined) jwt = jwt.setExpirationTime(exp)
    return jwt.sign(secretBytes)
  }

  it('mode is hs256', () => {
    expect(resolver.mode).toBe('hs256')
  })

  it('accepts a valid HS256 JWT', async () => {
    const tok = await mint({ sub: 'bob', project_slug: 'demo' }, Math.floor(Date.now() / 1000) + 60)
    const res = await resolver.resolve(tok)
    if ('code' in res) throw new Error(`unexpected: ${res.code}`)
    expect(res.user_id).toBe('bob')
    expect(res.project_slug).toBe('demo')
  })

  it('rejects tampered signature', async () => {
    const tok = await mint({ sub: 'bob' }, Math.floor(Date.now() / 1000) + 60)
    const tampered = tok.slice(0, -4) + 'AAAA'
    const res = await resolver.resolve(tampered)
    expect('code' in res ? res.code : null).toBe('invalid_signature')
  })

  it('rejects mismatched project_slug', async () => {
    const tok = await mint(
      { sub: 'bob', project_slug: 'other-project' },
      Math.floor(Date.now() / 1000) + 60,
    )
    const res = await resolver.resolve(tok)
    expect('code' in res ? res.code : null).toBe('project_mismatch')
  })

  it('rejects expired token', async () => {
    const tok = await mint({ sub: 'bob' }, Math.floor(Date.now() / 1000) - 60)
    const res = await resolver.resolve(tok)
    expect('code' in res ? res.code : null).toBe('expired_token')
  })

  it('rejects missing sub', async () => {
    const tok = await mint({}, Math.floor(Date.now() / 1000) + 60)
    const res = await resolver.resolve(tok)
    expect('code' in res ? res.code : null).toBe('malformed_token')
  })
})

describe('createAppWsAuthResolver — unconfigured', () => {
  it('rejects any token with code=unconfigured', async () => {
    const resolver = createAppWsAuthResolver({
      project_slug: 'demo',
      bypass: false,
    })
    expect(resolver.mode).toBe('unconfigured')
    const res = await resolver.resolve('anything')
    expect('code' in res ? res.code : null).toBe('unconfigured')
  })
})

/**
 * LOGIN-FIRST (2026-07-25) — the production credential. The mobile app signs in
 * at an identity service and receives an RS256 bearer scoped to ONE instance
 * slug; this mode is the only thing that makes that bearer usable, so these
 * cover the whole claim contract in `resolveJwks`.
 *
 * The key resolver is INJECTED (`jwks_key_resolver`) rather than served over
 * HTTP: the fetch/cache/rotation behaviour belongs to jose's
 * `createRemoteJWKSet`, and pinning it here would test jose, not us.
 */
describe('createAppWsAuthResolver — jwks (RS256 identity-service bearer)', () => {
  const nowMs = 1_800_000_000_000
  const nowSec = Math.floor(nowMs / 1_000)

  async function harness(
    overrides: { project_slug?: string; audience?: string; issuer?: string } = {},
  ) {
    const { generateKeyPair, createLocalJWKSet, exportJWK } = await import('jose')
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const jwk = await exportJWK(publicKey)
    jwk.kid = 'test-kid'
    jwk.alg = 'RS256'
    const resolver = createAppWsAuthResolver({
      project_slug: overrides.project_slug ?? 'my-instance',
      // TRUE on purpose: a hosted instance binds loopback, so `bypass` is true
      // there. `jwks_url` MUST still win — otherwise the RS256 bearer hits the
      // dev-bypass path and is rejected as malformed, which is exactly the
      // "sign-in works, every request 401s" failure this mode removes.
      bypass: true,
      jwks_url: 'https://identity.example.com/.well-known/jwks.json',
      jwks_key_resolver: createLocalJWKSet({ keys: [jwk] }),
      ...(overrides.audience === undefined ? {} : { jwks_audience: overrides.audience }),
      ...(overrides.issuer === undefined ? {} : { jwks_issuer: overrides.issuer }),
      now: () => nowMs,
    })
    const mint = async (
      claims: Record<string, unknown>,
      expSec = nowSec + 600,
    ): Promise<string> =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuedAt(nowSec)
        .setExpirationTime(expSec)
        .sign(privateKey)
    return { resolver, mint }
  }

  it('mode is jwks and it OUTRANKS bypass (a loopback-bound hosted instance)', async () => {
    const { resolver } = await harness()
    expect(resolver.mode).toBe('jwks')
  })

  it('accepts an instance-scoped token whose slug names this gateway', async () => {
    const { resolver, mint } = await harness()
    const res = await resolver.resolve(await mint({ sub: 'acct-7', slug: 'my-instance' }))
    if ('code' in res) throw new Error(`unexpected: ${res.code} ${res.message}`)
    expect(res.user_id).toBe('acct-7')
    expect(res.project_slug).toBe('my-instance')
    expect(res.mode).toBe('jwks')
  })

  it('REJECTS an account-scoped token (no slug claim) — it cannot drive an instance', async () => {
    const { resolver, mint } = await harness()
    const res = await resolver.resolve(await mint({ sub: 'acct-7' }))
    expect('code' in res ? res.code : null).toBe('project_mismatch')
  })

  it('rejects a token scoped to a DIFFERENT instance', async () => {
    const { resolver, mint } = await harness()
    const res = await resolver.resolve(await mint({ sub: 'acct-7', slug: 'someone-else' }))
    expect('code' in res ? res.code : null).toBe('project_mismatch')
  })

  it('rejects an expired token', async () => {
    const { resolver, mint } = await harness()
    const res = await resolver.resolve(
      await mint({ sub: 'acct-7', slug: 'my-instance' }, nowSec - 1),
    )
    expect('code' in res ? res.code : null).toBe('expired_token')
  })

  it('rejects a token signed by a key outside the published JWKS', async () => {
    const { generateKeyPair } = await import('jose')
    const { resolver } = await harness()
    const rogue = await generateKeyPair('RS256')
    const forged = await new SignJWT({ sub: 'acct-7', slug: 'my-instance' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 600)
      .sign(rogue.privateKey)
    const res = await resolver.resolve(forged)
    expect('code' in res ? res.code : null).toBe('invalid_signature')
  })

  it('rejects a dev-bypass style token — jwks mode has no weaker fallback lane', async () => {
    const { resolver } = await harness()
    const res = await resolver.resolve('dev:owner')
    expect('code' in res).toBe(true)
  })

  it('rejects missing sub', async () => {
    const { resolver, mint } = await harness()
    const res = await resolver.resolve(await mint({ slug: 'my-instance' }))
    expect('code' in res ? res.code : null).toBe('malformed_token')
  })

  it('enforces the audience when the operator configured one', async () => {
    const { resolver, mint } = await harness({ audience: 'expected-aud' })
    const wrong = await resolver.resolve(
      await mint({ sub: 'acct-7', slug: 'my-instance', aud: 'other-aud' }),
    )
    expect('code' in wrong).toBe(true)
    const right = await resolver.resolve(
      await mint({ sub: 'acct-7', slug: 'my-instance', aud: 'expected-aud' }),
    )
    expect('code' in right).toBe(false)
  })

  it('enforces the issuer when the operator pinned one', async () => {
    // Defence-in-depth for the day an instance trusts more than one key source:
    // signature + `slug` alone would accept a token from ANY issuer in the set.
    const { resolver, mint } = await harness({ issuer: 'https://identity.example.com' })
    const wrong = await resolver.resolve(
      await mint({ sub: 'acct-7', slug: 'my-instance', iss: 'https://evil.example.com' }),
    )
    expect('code' in wrong).toBe(true)
    const right = await resolver.resolve(
      await mint({ sub: 'acct-7', slug: 'my-instance', iss: 'https://identity.example.com' }),
    )
    expect('code' in right).toBe(false)
  })

  it('does NOT check the issuer when none is pinned — the pin is opt-in', async () => {
    const { resolver, mint } = await harness()
    const res = await resolver.resolve(
      await mint({ sub: 'acct-7', slug: 'my-instance', iss: 'https://anything.example.com' }),
    )
    expect('code' in res).toBe(false)
  })

  it('rejects empty token', async () => {
    const { resolver } = await harness()
    const res = await resolver.resolve('')
    expect('code' in res ? res.code : null).toBe('missing_token')
  })
})

/**
 * THE MISCONFIGURED-INSTANCE DIAGNOSTIC (Argus round-2 BLOCKER on PR #440).
 *
 * An instance behind a reverse proxy binds to loopback, so `bypass` is true
 * there by derivation. If the operator has not set `NEUTRON_IDENTITY_JWKS_URL`,
 * the login-first bearer — a real RS256 JWT — lands in the dev-bypass lane, which
 * cannot verify it. It is still correctly REFUSED (no auth bypass), but it used to
 * be refused as "dev token is empty or too long", which names nothing the operator
 * did: sign-in succeeds, then every authenticated request 401s with a message that
 * points at the wrong thing entirely.
 *
 * These pin that the refusal still happens AND that it now names the missing env.
 */
describe('createAppWsAuthResolver — dev-bypass receiving a real JWT', () => {
  const resolver = createAppWsAuthResolver({ project_slug: 'my-instance', bypass: true })

  it('refuses a JWT-shaped bearer and NAMES the missing JWKS configuration', async () => {
    const jwt = `${'a'.repeat(40)}.${'b'.repeat(120)}.${'c'.repeat(80)}`
    const res = await resolver.resolve(jwt)
    expect('code' in res ? res.code : null).toBe('unconfigured')
    // The actionable part: the operator learns which variable to set.
    expect('message' in res && res.message).toContain('NEUTRON_IDENTITY_JWKS_URL')
    // And it no longer blames a "dev token" the operator never supplied.
    expect('message' in res && res.message).not.toContain('too long')
  })

  it('still ACCEPTS a genuine dev token — the diagnostic is shape-gated, not a kill switch', async () => {
    const res = await resolver.resolve('dev:owner')
    if ('code' in res) throw new Error(`unexpected: ${res.code} ${res.message}`)
    expect(res.user_id).toBe('owner')
    expect(res.mode).toBe('dev-bypass')
  })

  it('an opaque token with dots is NOT mistaken for a JWT', async () => {
    // Two segments, not three — the shape check must not swallow ordinary
    // dotted opaque ids, which the char-set guard already permits.
    const res = await resolver.resolve('team.owner')
    if ('code' in res) throw new Error(`unexpected: ${res.code} ${res.message}`)
    expect(res.user_id).toBe('team.owner')
  })

  it('an over-long NON-JWT token still reports the length problem', async () => {
    // The length guard is not replaced, only preceded.
    const res = await resolver.resolve('x'.repeat(200))
    expect('code' in res ? res.code : null).toBe('malformed_token')
    expect('message' in res && res.message).toContain('too long')
  })
})
