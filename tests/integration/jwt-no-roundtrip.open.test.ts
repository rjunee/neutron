import { describe, expect, test } from 'bun:test'
import {
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  SignJWT,
  type KeyLike,
  type JWK,
} from 'jose'
import {
  JwksCache,
  NEUTRON_AUDIENCE,
  validateJwt,
  type Claims,
  type FetchLike,
} from '@neutronai/jwt-validator/index.ts'

interface ProbeFetch {
  fetch: FetchLike
  count: () => number
  reset: () => void
  history: () => string[]
}

/**
 * Make a fetch wrapper that delegates to `inner` and counts every call. The
 * "no roundtrip" assertion is: ZERO calls happen after the JWKS is cached.
 */
function makeProbeFetch(inner: FetchLike): ProbeFetch {
  let count = 0
  const log: string[] = []
  const fetch: FetchLike = async (input, init) => {
    count += 1
    log.push(typeof input === 'string' ? input : String(input))
    return inner(input, init)
  }
  return {
    fetch,
    count: () => count,
    reset: () => {
      count = 0
      log.length = 0
    },
    history: () => [...log],
  }
}

interface LocalKey {
  kid: string
  privateKey: KeyLike
  publicJwk: JWK
}

/**
 * Mint a key pair locally (no central identity service). The public half is
 * published as a JWKS entry; the private half signs the access token. This is
 * the same in-process signing primitive `jwt-validator/jwt.test.ts` uses — it
 * lets the Open carve prove the local-validation contract WITHOUT booting the
 * central identity service.
 */
async function makeLocalKey(kid: string): Promise<LocalKey> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' }
  return { kid, privateKey, publicJwk }
}

/**
 * Sign an access JWT locally with the supplied key. `nowSec` anchors iat/exp to
 * the same frozen clock the validator uses so the token is valid at validation
 * time.
 */
async function signLocalToken(
  key: LocalKey,
  opts: {
    sub: string
    nowSec: number
    memberships?: ReadonlyArray<{ slug: string; role: 'owner' | 'admin' | 'member'; kind: 'user' | 'workspace' }>
  },
): Promise<string> {
  const memberships = opts.memberships ?? []
  return new SignJWT({ memberships })
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid })
    .setSubject(opts.sub)
    .setIssuedAt(opts.nowSec)
    .setExpirationTime(opts.nowSec + 24 * 3600)
    .setAudience(NEUTRON_AUDIENCE)
    .sign(key.privateKey)
}

/**
 * The architectural lock from `docs/engineering-plan.md` § A.3.4:
 *
 *   "Each owner caches the pubkey + validates JWTs locally with NO
 *   per-request callback."
 *
 * This Open-carve test proves the contract WITHOUT the central identity
 * service. It:
 *   1. Mints an EdDSA key pair locally (jose) and signs an access JWT with it.
 *   2. Publishes the public half as a single-key JWKS.
 *   3. Loads the JWKS into a JwksCache instance with a probe fetch.
 *   4. Validates the JWT 100 times while watching the probe.
 *
 * After step 3, step 4 must show ZERO additional fetch calls — every
 * subsequent validation reads cached JWKS material in-process. No callback to
 * any identity service ever happens.
 */
describe('integration — local JWT validation makes no callback to identity service', () => {
  test('100 validations after JWKS load: 0 fetch calls', async () => {
    const NOW = 1_700_000_000_000
    const nowSec = Math.floor(NOW / 1000)

    // 1. Mint a key + sign an access JWT entirely in-process.
    const key = await makeLocalKey('k1')
    const token = await signLocalToken(key, {
      sub: 'user-1',
      nowSec,
      memberships: [{ slug: 'user-1', role: 'owner', kind: 'user' }],
    })
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }

    // 2. Wire a probe fetch that returns the in-process JWKS — but we'll
    //    only call this fetch ONCE (during JwksCache.get()), and zero
    //    times afterwards.
    const inner: FetchLike = async (_url) =>
      new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    const probe = makeProbeFetch(inner)
    const cache = new JwksCache('https://auth.test/.well-known/jwks.json', {
      fetch: probe.fetch,
      ttlMs: 60 * 60 * 1_000,
      now: () => NOW,
    })

    // 3. First load — exactly one fetch call expected.
    const loadedJwks = await cache.get()
    expect(probe.count()).toBe(1)
    expect(loadedJwks.keys).toHaveLength(1)

    // 4. Validate the JWT 100 times. No additional fetch calls.
    for (let i = 0; i < 100; i++) {
      const claims: Claims = await validateJwt(token, loadedJwks, { now: () => NOW })
      expect(claims.sub).toBe('user-1')
      // Re-fetch from the cache — the cache itself must not phone home
      // when the cached entry is still in TTL.
      const same = await cache.get()
      expect(same).toBe(loadedJwks)
    }
    expect(probe.count()).toBe(1) // STILL one — no roundtrip.
  })

  test('JwksCache survives auth-service outage within TTL', async () => {
    // Same architectural intent: if the auth service goes down for up to 24h
    // (the locked refresh-token grace window), per-owner gateways must keep
    // validating JWTs they've already cached the JWKS for.
    const NOW = 1_700_000_000_000
    const nowSec = Math.floor(NOW / 1000)

    const key = await makeLocalKey('k1')
    const token = await signLocalToken(key, { sub: 'user-2', nowSec })
    const jwks: JSONWebKeySet = { keys: [key.publicJwk] }

    let outage = false
    const inner: FetchLike = async (_url) => {
      if (outage) return new Response('boom', { status: 503 })
      return new Response(JSON.stringify(jwks), { status: 200 })
    }
    const probe = makeProbeFetch(inner)
    const cache = new JwksCache('https://auth.test/.well-known/jwks.json', {
      fetch: probe.fetch,
      ttlMs: 60 * 60 * 1_000,
      now: () => NOW,
    })
    const loaded = await cache.get()
    expect(probe.count()).toBe(1)

    // Simulate auth-service outage. Validation continues without touching auth.
    outage = true
    for (let i = 0; i < 10; i++) {
      const claims = await validateJwt(token, loaded, { now: () => NOW })
      expect(claims.sub).toBe('user-2')
    }
    expect(probe.count()).toBe(1)
  })
})
