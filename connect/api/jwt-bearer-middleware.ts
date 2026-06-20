/**
 * Bearer-JWT middleware for the cross-instance API. Wraps
 * `@neutronai/jwt-validator` to enforce four invariants per § A.3.5 of the
 * P1 plan:
 *
 *   1. Authorization header carries a Bearer token.
 *   2. Token validates against the cached JWKS (signature, EdDSA, exp).
 *   3. `aud` includes `connect.<receiving_instance_slug>` — the calling
 *      instance must have minted a token specifically for THIS instance.
 *   4. The token carries an `origin_instance` membership claim — the
 *      cross-instance API only accepts content stamped with an origin slug
 *      reachable from the caller's memberships. (We don't trust an
 *      attacker-supplied `origin_instance` body field; it must be derivable
 *      from the JWT.)
 *
 * Returns the resolved auth context to the handler so it can enforce
 * `origin` matches the body's stamp + apply per-scope authorization.
 */

import { validateJwt, type JwksCache } from '../../jwt-validator/index.ts'
import type { Membership } from '../../jwt-validator/claims.ts'

export interface ConnectAuthContext {
  /** Slug of the originating instance (workspace OR user) — derived from the
   *  caller's memberships, NEVER from the request body. */
  origin_instance_slug: string
  /** Platform user_id of the speaker. */
  origin_user_id: string
  /** Roles / scopes the caller is authorized for, copied from JWT
   *  memberships. */
  scopes: ReadonlyArray<string>
  /** Full memberships array, useful for downstream policy decisions. */
  memberships: ReadonlyArray<Membership>
}

export interface AuthSuccess {
  ok: true
  context: ConnectAuthContext
}

export interface AuthFailure {
  ok: false
  status: 401 | 403
  reason: string
}

export type AuthResult = AuthSuccess | AuthFailure

export interface JwtBearerMiddlewareOptions {
  /** JWKS cache pointing at the auth authority's /.well-known/jwks.json. */
  jwks: JwksCache
  /** Slug of the instance hosting THIS cross-instance API. */
  receiving_instance_slug: string
  /**
   * Optional injection point for the slug the caller claims to speak as.
   * Defaults to the origin header (cross-checked against memberships).
   * The cross-instance API client always sets this; receiver always validates.
   */
  read_claimed_origin?: (req: Request) => string | null
  /** Override the wall clock for tests. */
  now?: () => number
}

/**
 * Default origin-claim reader: the `x-origin-*` HTTP header (untrusted).
 * The middleware enforces the value must match a slug in the caller's JWT memberships.
 */
function defaultReadClaimedOrigin(req: Request): string | null {
  return req.headers.get('x-origin-instance')
}

/**
 * Authorize a single request. Returns the auth context (success) or a
 * 401/403 reason (failure). Pure function — no Hono / Express coupling
 * so the same shape works in Bun.serve fetch handlers and in tests.
 */
export async function authorizeConnectRequest(
  req: Request,
  opts: JwtBearerMiddlewareOptions,
): Promise<AuthResult> {
  const auth = req.headers.get('authorization')
  if (auth === null) {
    return { ok: false, status: 401, reason: 'missing_bearer' }
  }
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (m === null) {
    return { ok: false, status: 401, reason: 'malformed_bearer' }
  }
  const token = m[1]
  if (token === undefined || token.length === 0) {
    return { ok: false, status: 401, reason: 'malformed_bearer' }
  }

  // Required `aud` is `connect.<receiving_slug>` — calling instances
  // mint a token specifically for THIS receiving instance. A token minted
  // for the global `neutron` audience does NOT pass.
  const requiredAud = `connect.${opts.receiving_instance_slug}`
  let claims
  try {
    claims = await validateJwt(token, await opts.jwks.get(), {
      audience: requiredAud,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    })
  } catch (err) {
    return {
      ok: false,
      status: 401,
      reason: `jwt_invalid: ${err instanceof Error ? err.message : 'unknown'}`,
    }
  }

  // The caller must declare which membership they're speaking as. We
  // accept either the origin header OR a single-membership JWT (auto-resolves).
  // Multi-membership JWTs without the header are ambiguous; we reject so the
  // speaker has to be explicit.
  const reader = opts.read_claimed_origin ?? defaultReadClaimedOrigin
  const claimed = reader(req)
  let originSlug: string | null = null
  if (claimed !== null && claimed !== '') {
    if (!claims.memberships.some((m) => m.slug === claimed)) {
      return {
        ok: false,
        status: 403,
        reason: 'origin_not_a_member',
      }
    }
    originSlug = claimed
  } else if (claims.memberships.length === 1) {
    originSlug = claims.memberships[0]?.slug ?? null
  } else {
    return {
      ok: false,
      status: 403,
      reason: 'ambiguous_origin: provide X-Origin-Instance header',
    }
  }
  if (originSlug === null) {
    return { ok: false, status: 403, reason: 'no_origin' }
  }

  const role = claims.memberships.find((m) => m.slug === originSlug)?.role
  const scopes: string[] = role !== undefined ? [`role:${role}`] : []

  return {
    ok: true,
    context: {
      origin_instance_slug: originSlug,
      origin_user_id: claims.sub,
      scopes,
      memberships: claims.memberships,
    },
  }
}
