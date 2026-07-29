import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyOptions,
} from 'jose'
import { ClaimsSchema, NEUTRON_AUDIENCE, type Claims } from './claims.ts'

/**
 * Minimal in-process fetch surface so callers can inject a tracking fetch in
 * tests (e.g. `jwt-no-roundtrip.test.ts` asserts validators don't phone home
 * after the JWKS is cached). Not exported as a top-level type because the
 * standard `typeof globalThis.fetch` is already structurally compatible.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface JwksCacheEntry {
  jwks: JSONWebKeySet
  fetchedAt: number
  expiresAt: number
}

const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1_000 // 1h, matches the per-instance pubkey-distribute cadence.

export interface LoadJwksOptions {
  /** TTL for the cached JWKS. Default: 1h. */
  ttlMs?: number
  /** Injectable fetch (for tests / non-default transports). Default: globalThis.fetch. */
  fetch?: FetchLike
  /** Time source — injectable for deterministic cache-expiry tests. Default: Date.now. */
  now?: () => number
}

/**
 * Cached JWKS loader. Calls the auth service's JWKS endpoint at most
 * once per `ttlMs` window. The validator (`validateJwt`) consumes a JWKS the
 * caller has already loaded — this layer is a convenience cache to keep
 * gateways from re-hitting auth on every request.
 *
 * The cache is per-instance (caller scopes it to a process / module). For
 * the per-instance gateway boot path, instantiate once at boot, pin to the
 * known auth URL, refresh on TTL expiry. If the auth service is
 * unreachable, the in-memory copy keeps validating until ttl expires AND
 * the in-flight refresh succeeds — bounded auth-service-outage tolerance
 * matches the locked 24h refresh-token grace window in § A.3.4.
 */
export class JwksCache {
  private cache: JwksCacheEntry | null = null
  private inflight: Promise<JSONWebKeySet> | null = null
  private readonly ttlMs: number
  private readonly fetchImpl: FetchLike
  private readonly now: () => number

  constructor(
    private readonly url: string,
    options: LoadJwksOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_JWKS_TTL_MS
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Return a cached JWKS or fetch a fresh copy. Concurrent callers share a
   * single in-flight request so an N-way burst at TTL boundary causes one
   * upstream call, not N.
   */
  async get(): Promise<JSONWebKeySet> {
    const now = this.now()
    if (this.cache !== null && now < this.cache.expiresAt) {
      return this.cache.jwks
    }
    if (this.inflight !== null) return this.inflight
    this.inflight = this.refresh(now).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async refresh(now: number): Promise<JSONWebKeySet> {
    /**
     * Surviving an auth-service blip is the whole point of caching, so
     * stale-on-error covers BOTH:
     *   (a) non-OK HTTP response (5xx, 4xx) — the upstream answered
     *       something but couldn't serve us, and
     *   (b) network-level failure where `fetch()` REJECTS — DNS failure,
     *       connection refused, TCP timeout. Without a try/catch the cache
     *       drops to "throw past TTL" and per-instance gateways stop
     *       validating tokens during any network blip, which directly
     *       contradicts the locked § A.3.4 "24h grace" intent.
     *
     * If we have NO cache (first-fetch-on-boot), surface the error so the
     * caller knows auth bootstrapped wrong.
     */
    let res: Response
    try {
      res = await this.fetchImpl(this.url)
    } catch (err) {
      if (this.cache !== null) return this.cache.jwks
      throw new JwtValidationError(`JWKS fetch failed: ${err instanceof Error ? err.message : 'unknown'}`, {
        cause: err,
      })
    }
    if (!res.ok) {
      if (this.cache !== null) return this.cache.jwks
      throw new JwtValidationError(`JWKS fetch failed: ${res.status}`)
    }
    let body: JSONWebKeySet
    try {
      body = (await res.json()) as JSONWebKeySet
    } catch (err) {
      if (this.cache !== null) return this.cache.jwks
      throw new JwtValidationError('JWKS response not JSON', { cause: err })
    }
    if (!Array.isArray(body.keys)) {
      if (this.cache !== null) return this.cache.jwks
      throw new JwtValidationError('JWKS response missing keys[]')
    }
    this.cache = {
      jwks: body,
      fetchedAt: now,
      expiresAt: now + this.ttlMs,
    }
    return body
  }

  /** Force-evict the cache so the next `get()` re-fetches. Used by tests. */
  invalidate(): void {
    this.cache = null
  }

  /** Internal: peek at the cached entry. Used by tests. */
  peek(): JwksCacheEntry | null {
    return this.cache
  }
}

/** Convenience: one-shot fetch + cache. Equivalent to `new JwksCache(url).get()`. */
export async function loadJwks(url: string, options: LoadJwksOptions = {}): Promise<JSONWebKeySet> {
  return new JwksCache(url, options).get()
}

export class JwtValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'JwtValidationError'
  }
}

export interface ValidateJwtOptions {
  /** Required `aud` value. Default: `'neutron'`. */
  audience?: string
  /** Override `now` for clock-skew tests. */
  now?: () => number
  /** Allowed clock skew in seconds when checking exp/nbf. Default: 0. */
  clockToleranceSec?: number
}

/**
 * Verify a JWT against the supplied JWKS. Steps:
 *   1. Decode the protected header; locate the kid in the JWKS.
 *   2. Verify the EdDSA signature on the (header || '.' || payload) bytes.
 *   3. Confirm `aud` includes the required audience.
 *   4. Confirm `exp` is in the future (with optional clock skew).
 *   5. Validate the payload shape via the Zod ClaimsSchema.
 *
 * No HTTP. The whole point of this surface is local-only validation per
 * `docs/engineering-plan.md` § A.3.4.
 */
export async function validateJwt(
  token: string,
  jwks: JSONWebKeySet,
  options: ValidateJwtOptions = {},
): Promise<Claims> {
  const audience = options.audience ?? NEUTRON_AUDIENCE
  const localKeySet = createLocalJWKSet(jwks)
  // Build options conditionally to satisfy `exactOptionalPropertyTypes`:
  // jose's `JWTVerifyOptions.currentDate` is `Date | undefined` only when
  // omitted — passing `undefined` explicitly fails the strict check.
  const verifyOpts: JWTVerifyOptions = {
    audience,
    algorithms: ['EdDSA'],
    clockTolerance: options.clockToleranceSec ?? 0,
  }
  if (options.now !== undefined) {
    verifyOpts.currentDate = new Date(options.now())
  }
  let result
  try {
    result = await jwtVerify(token, localKeySet, verifyOpts)
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) {
      throw new JwtValidationError(`jwt verification failed: ${err.code ?? err.message}`, {
        cause: err,
      })
    }
    throw new JwtValidationError('jwt verification failed', { cause: err })
  }
  const parsed = ClaimsSchema.safeParse(result.payload)
  if (!parsed.success) {
    throw new JwtValidationError(`jwt claims schema invalid: ${parsed.error.message}`, {
      cause: parsed.error,
    })
  }
  return parsed.data
}
