/**
 * @neutronai/cores-sdk — platform JWT validator.
 *
 * Cores import `validatePlatformJwt` to verify the start_token JWT
 * issued by the configured auth service. The token carries the membership
 * claims that gate every API call into the Core's `/api/*` surface.
 *
 * Two layers:
 *
 *   1. `validatePlatformJwt(token, jwks: JSONWebKeySet, options)` —
 *      LOW-LEVEL. The caller manages the JWKS lifecycle. Steps:
 *       a. Verify EdDSA signature against the supplied JWKS.
 *       b. Confirm `aud` includes `'neutron'` (overridable for tests).
 *       c. Confirm `exp` is in the future (with optional clock skew).
 *       d. Confirm `memberships[]` contains the Core's
 *          `expected_project_slug` — cross-project safety.
 *
 *   2. `buildPlatformJwtValidator({jwks_url, expected_project_slug, ...})`
 *      — HIGH-LEVEL. Wraps a `JwksCache` so the URL is fetched at most
 *      once per `ttlMs` window (default 1h). This is what every Core
 *      should wire into `mountCoreRoutes(app, {validator})` — refetching
 *      JWKS per request would turn every authenticated request into a
 *      network round-trip and a JWKS outage into a 100% auth failure.
 *
 * The cache is a port of `jwt-validator/JwksCache` (same TTL semantics,
 * same stale-on-error behaviour). Cores ship as standalone npm packages
 * in P3+, so the cache is inlined here rather than imported across
 * workspaces.
 *
 * Cross-refs:
 * - jwt-validator/validator.ts (lift target — same shape, same behaviour)
 * - jwt-validator/claims.ts (locked claim shape — `iat`/`exp`/`aud`/
 *   `memberships[]` are required, NOT defaulted)
 * - signup/start-token.ts (issuer side — what the SDK validates)
 * - docs/engineering-plan.md § A.3.4 (locked JWT claim schema)
 */

import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyOptions,
} from 'jose'

/** Minimum membership shape the SDK exposes. Mirrors
 *  `jwt-validator/claims.ts:MembershipSchema`. */
export interface PlatformMembership {
  slug: string
  role: 'owner' | 'admin' | 'member'
  kind: 'user' | 'workspace'
}

/** Subset of validated JWT claims a Core needs to enforce auth. */
export interface PlatformClaims {
  /** Stable user id — the platform-wide UUID, NOT the project_slug. */
  sub: string
  /** Issued at, seconds since epoch. */
  iat: number
  /** Expires at, seconds since epoch. */
  exp: number
  /** Audience array (always normalised — single-string `aud` is widened). */
  aud: string[]
  /** Every project the user is a member of. */
  memberships: PlatformMembership[]
}

/**
 * Validated-JWT result shape returned by `validatePlatformJwt`. The
 * `project_slug` is NOT in the JWT itself — it's the Core's own slug
 * (passed in via `expected_project_slug`) verified against the user's
 * `memberships[]`. This is the cross-project-safety check the platform-
 * side gateway already enforces.
 */
export interface PlatformAuthResult {
  project_slug: string
  user_id: string
  claims: PlatformClaims
}

export type PlatformJwtErrorCode =
  | 'token_invalid'
  | 'token_expired'
  | 'wrong_audience'
  | 'missing_membership'
  | 'jwks_fetch_failed'

export class PlatformJwtError extends Error {
  override readonly name = 'PlatformJwtError'
  constructor(
    readonly code: PlatformJwtErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

/**
 * Options for `validatePlatformJwt`. The Core passes its own slug as
 * `expected_project_slug`; the validator confirms the JWT names that
 * instance in `memberships[]`. Cores running on a per-slug instance host
 * MUST always pass their own slug — accepting a token that names a
 * different instance is the cross-project safety bug.
 */
export interface ValidatePlatformJwtOptions {
  /** The Core's own instance slug. The validator confirms the JWT's
   *  `memberships[]` contains this slug. */
  expected_project_slug: string
  /** Required `aud` value. Default: `'neutron'`. */
  audience?: string
  /** Allowed clock skew in seconds. Default: 0. */
  clockToleranceSec?: number
  /** Override `now` for tests. */
  now?: () => number
}

export async function validatePlatformJwt(
  token: string,
  jwks: JSONWebKeySet,
  options: ValidatePlatformJwtOptions,
): Promise<PlatformAuthResult> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new PlatformJwtError('token_invalid', 'token must be a non-empty string')
  }
  if (!Array.isArray(jwks.keys)) {
    throw new PlatformJwtError('token_invalid', 'jwks missing keys[]')
  }
  const audience = options.audience ?? 'neutron'
  const localKeySet = createLocalJWKSet(jwks)
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
    if (err instanceof joseErrors.JWTExpired) {
      throw new PlatformJwtError('token_expired', err.message, err)
    }
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      const code: PlatformJwtErrorCode =
        err.claim === 'aud' ? 'wrong_audience' : 'token_invalid'
      throw new PlatformJwtError(code, err.message, err)
    }
    if (err instanceof joseErrors.JOSEError) {
      throw new PlatformJwtError('token_invalid', err.code ?? err.message, err)
    }
    throw new PlatformJwtError(
      'token_invalid',
      err instanceof Error ? err.message : 'unknown verify failure',
      err,
    )
  }
  const claims = parseClaims(result.payload)
  const matched = claims.memberships.find(
    (m) => m.slug === options.expected_project_slug,
  )
  if (matched === undefined) {
    throw new PlatformJwtError(
      'missing_membership',
      `JWT memberships[] does not include project_slug=${options.expected_project_slug}`,
    )
  }
  return {
    project_slug: options.expected_project_slug,
    user_id: claims.sub,
    claims,
  }
}

/**
 * Parse the validated payload into the SDK's claim shape. `iat`,
 * `exp`, `aud`, and `memberships[]` are REQUIRED — missing or non-
 * numeric `iat`/`exp` rejects with `token_invalid` rather than
 * silently defaulting to 0 (which would let a malformed token with
 * a valid signature + audience through). Mirrors
 * `jwt-validator/claims.ts:ClaimsSchema`.
 */
function parseClaims(payload: Record<string, unknown>): PlatformClaims {
  const sub = typeof payload.sub === 'string' ? payload.sub : ''
  if (sub === '') {
    throw new PlatformJwtError('token_invalid', 'sub claim required')
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new PlatformJwtError('token_invalid', 'iat claim required (number)')
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new PlatformJwtError('token_invalid', 'exp claim required (number)')
  }
  const iat = payload.iat
  const exp = payload.exp
  const audRaw = payload.aud
  const aud = Array.isArray(audRaw)
    ? audRaw.filter((v): v is string => typeof v === 'string')
    : typeof audRaw === 'string'
      ? [audRaw]
      : []
  if (aud.length === 0) {
    throw new PlatformJwtError('token_invalid', 'aud claim required')
  }
  const membershipsRaw = payload.memberships
  if (!Array.isArray(membershipsRaw)) {
    throw new PlatformJwtError(
      'token_invalid',
      'memberships claim must be an array',
    )
  }
  // Strict mode (Codex r4): every memberships[] entry must be a
  // valid object — slug + role + kind. Silently filtering out
  // malformed entries would let `validatePlatformJwt` accept a
  // token that `jwt-validator/validateJwt` rejects, splitting Core
  // auth from gateway auth on the same payload. Fail-closed instead.
  const memberships: PlatformMembership[] = []
  for (let i = 0; i < membershipsRaw.length; i++) {
    const m = membershipsRaw[i]
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
      throw new PlatformJwtError(
        'token_invalid',
        `memberships[${i}] must be a non-null object`,
      )
    }
    const obj = m as Record<string, unknown>
    const slug = obj.slug
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new PlatformJwtError(
        'token_invalid',
        `memberships[${i}].slug must be a non-empty string`,
      )
    }
    const role = obj.role
    if (role !== 'owner' && role !== 'admin' && role !== 'member') {
      throw new PlatformJwtError(
        'token_invalid',
        `memberships[${i}].role must be owner|admin|member`,
      )
    }
    const kind = obj.kind
    if (kind !== 'user' && kind !== 'workspace') {
      throw new PlatformJwtError(
        'token_invalid',
        `memberships[${i}].kind must be user|workspace`,
      )
    }
    memberships.push({ slug, role, kind })
  }
  return { sub, iat, exp, aud, memberships }
}

/* ----------------------------------------------------------------------
 * JwksCache — in-process JWKS cache.
 * Lifted from `jwt-validator/validator.ts:JwksCache` (same TTL semantics,
 * same stale-on-error behaviour, same in-flight de-dup). Inlined so a
 * Core that ships outside the monorepo (P3+) doesn't need to pull in
 * `@neutronai/jwt-validator` separately.
 * -------------------------------------------------------------------- */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1_000 // 1h, matches the per-instance pubkey-distribute cadence.

export interface JwksCacheEntry {
  jwks: JSONWebKeySet
  fetchedAt: number
  expiresAt: number
}

export interface JwksCacheOptions {
  /** TTL for the cached JWKS. Default: 1h. */
  ttlMs?: number
  /** Injectable fetch (for tests / non-default transports). Default: globalThis.fetch. */
  fetch?: FetchLike
  /** Time source — injectable for deterministic cache-expiry tests. Default: Date.now. */
  now?: () => number
}

export class JwksCache {
  private cache: JwksCacheEntry | null = null
  private inflight: Promise<JSONWebKeySet> | null = null
  private readonly ttlMs: number
  private readonly fetchImpl: FetchLike
  private readonly now: () => number

  constructor(
    private readonly url: string,
    options: JwksCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_JWKS_TTL_MS
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.now = options.now ?? ((): number => Date.now())
  }

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
    let res: Response
    try {
      res = await this.fetchImpl(this.url)
    } catch (err) {
      // Stale-on-error: a transient JWKS-service blip should NOT
      // cascade into 100% auth failures across the Core. Per
      // jwt-validator/validator.ts:JwksCache.refresh — first-fetch-on-
      // boot still surfaces; cached + outage continues serving.
      if (this.cache !== null) return this.cache.jwks
      throw new PlatformJwtError(
        'jwks_fetch_failed',
        err instanceof Error ? err.message : 'unknown',
        err,
      )
    }
    if (!res.ok) {
      if (this.cache !== null) return this.cache.jwks
      throw new PlatformJwtError('jwks_fetch_failed', `JWKS fetch ${res.status}`)
    }
    let body: JSONWebKeySet
    try {
      body = (await res.json()) as JSONWebKeySet
    } catch (err) {
      if (this.cache !== null) return this.cache.jwks
      throw new PlatformJwtError('jwks_fetch_failed', 'JWKS response not JSON', err)
    }
    if (!Array.isArray(body.keys)) {
      if (this.cache !== null) return this.cache.jwks
      throw new PlatformJwtError('jwks_fetch_failed', 'JWKS missing keys[]')
    }
    this.cache = { jwks: body, fetchedAt: now, expiresAt: now + this.ttlMs }
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

/* ----------------------------------------------------------------------
 * Validator factory shape — the Core-facing high-level API.
 * -------------------------------------------------------------------- */

export type PlatformJwtValidator = (
  token: string,
) => Promise<PlatformAuthResult>

export interface BuildPlatformJwtValidatorOptions
  extends ValidatePlatformJwtOptions,
    JwksCacheOptions {
  /** JWKS endpoint URL — typically
   *  `https://auth.example.test/.well-known/jwks.json`. */
  jwks_url: string
}

/**
 * Build a token-validator function with a JwksCache underneath. This
 * is what `mountCoreRoutes(app, {validator})` consumes in production.
 *
 * The returned function fetches JWKS at most once per `ttlMs` (default
 * 1h) and survives transient JWKS outages by serving the previously
 * cached key set. On first-fetch-on-boot, JWKS-service downtime
 * surfaces as `PlatformJwtError('jwks_fetch_failed')`.
 */
export function buildPlatformJwtValidator(
  options: BuildPlatformJwtValidatorOptions,
): PlatformJwtValidator {
  const cacheOpts: JwksCacheOptions = {}
  if (options.ttlMs !== undefined) cacheOpts.ttlMs = options.ttlMs
  if (options.fetch !== undefined) cacheOpts.fetch = options.fetch
  if (options.now !== undefined) cacheOpts.now = options.now
  const cache = new JwksCache(options.jwks_url, cacheOpts)
  const validateOpts: ValidatePlatformJwtOptions = {
    expected_project_slug: options.expected_project_slug,
  }
  if (options.audience !== undefined) validateOpts.audience = options.audience
  if (options.clockToleranceSec !== undefined) {
    validateOpts.clockToleranceSec = options.clockToleranceSec
  }
  if (options.now !== undefined) validateOpts.now = options.now
  return async (token: string): Promise<PlatformAuthResult> => {
    const jwks = await cache.get()
    return validatePlatformJwt(token, jwks, validateOpts)
  }
}

/**
 * Dev-mode stub. Returns a validator with the same signature as
 * `buildPlatformJwtValidator` but bypassing JWKS — accepts a single
 * hardcoded `bearer_token` and yields fixed claims. NEVER ship to prod.
 *
 * Guard: the factory throws unless `NEUTRON_DEV_AUTH=1` is set in the
 * process env. Cores that accidentally instantiate this in a prod
 * config will fail loud at boot rather than quietly skipping auth.
 *
 * Typical use (`dtc-analytics` dev boot):
 *
 * ```ts
 * const validator = process.env.NODE_ENV === 'production'
 *   ? buildPlatformJwtValidator({jwks_url: JWKS_URL, expected_project_slug: SLUG})
 *   : buildDevPlatformJwtValidator({
 *       admin_email: 'user@example.com',
 *       bearer_token: 'dev-token-tabs',
 *       project_slug: SLUG,
 *     })
 * ```
 */
export interface DevPlatformJwtValidatorOptions {
  /** Email surfaced in the synthetic claims. */
  admin_email: string
  /** The literal token string the validator accepts. */
  bearer_token: string
  /** The instance slug the synthetic membership names. */
  project_slug: string
  /**
   * Allow construction without `NEUTRON_DEV_AUTH=1`. Tests pass true;
   * prod callers MUST NEVER pass true.
   */
  bypass_env_guard?: boolean
}

export function buildDevPlatformJwtValidator(
  options: DevPlatformJwtValidatorOptions,
): PlatformJwtValidator {
  if (
    options.bypass_env_guard !== true &&
    (typeof process === 'undefined' || process.env['NEUTRON_DEV_AUTH'] !== '1')
  ) {
    throw new PlatformJwtError(
      'token_invalid',
      'buildDevPlatformJwtValidator requires NEUTRON_DEV_AUTH=1 — never enable in production',
    )
  }
  const claims: PlatformClaims = {
    sub: options.admin_email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 24 * 3600,
    aud: ['neutron'],
    memberships: [
      { slug: options.project_slug, role: 'owner', kind: 'user' },
    ],
  }
  return async (token: string): Promise<PlatformAuthResult> => {
    if (token !== options.bearer_token) {
      throw new PlatformJwtError(
        'token_invalid',
        'dev-mode validator: bearer_token mismatch',
      )
    }
    return {
      project_slug: options.project_slug,
      user_id: options.admin_email,
      claims,
    }
  }
}
