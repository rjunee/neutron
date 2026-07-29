/**
 * @neutronai/channels/app-ws — auth resolver for the Expo app WebSocket
 * surface (per SPEC.md § Phases→Steps / P5.1).
 *
 * The production target is the multi-aud EdDSA JWT minted by
 * the configured auth authority (engineering-plan § A.3.4). That OAuth flow
 * is wired in a later sub-sprint; until then this resolver supports
 * two narrow modes so the Expo chat surface is reachable end-to-end:
 *
 *   1. `dev-bypass` — when `NEUTRON_APP_WS_BYPASS=1`. Accepts ANY
 *      non-empty token of the form `dev:<user_id>` (or just
 *      `<user_id>`) and binds it to the gateway's own instance slug.
 *      ONLY for development; the instance gateway logs a loud warn
 *      at boot when this mode is enabled.
 *
 *   2. `hs256-shared-secret` — when `NEUTRON_APP_WS_DEV_SECRET` is
 *      set. The resolver verifies the token against the shared
 *      secret (HS256), expects `sub` (user_id) + optional
 *      `project_slug`, and rejects expired tokens. Suitable for
 *      multi-developer dev where each engineer has a token they
 *      paste into the Expo client without standing up the full
 *      identity service.
 *
 *   3. `jwks` — when `jwks_url` is set (the identity service's
 *      `/.well-known/jwks.json`). This is the PRODUCTION mode and the
 *      one the mobile app's login-first flow depends on: the owner signs
 *      in at central identity, the identity service hands back an
 *      RS256 bearer scoped to ONE instance slug, and this resolver
 *      verifies it offline against the published public keys. See
 *      `resolveJwks` for the exact claim contract.
 *
 * All three modes share a single `createAppWsAuthResolver` entry point,
 * and exactly ONE is live per process — `jwks_url` wins when set
 * (production), then `bypass`, then `hs256_secret`, else `unconfigured`.
 * There is deliberately no credential CHAIN: a token that fails the
 * configured mode is rejected rather than retried against a weaker one.
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
// Timing-safe slug comparison (ISSUE #34). The HS256 bearer's verified
// `project_slug` claim is cross-checked against this gateway's slug; a plain
// `!==` short-circuits on the first byte mismatch and leaks the shared-prefix
// length of this instance's slug through response timing. Route it through the
// shared constant-time primitive (the same one the landing cookie + gateway
// surfaces use).
import { constantTimeEqual } from '@neutronai/runtime/constant-time-equal.ts'

export type AppWsAuthMode = 'dev-bypass' | 'hs256' | 'jwks'

export interface AppWsAuthResolved {
  /** Stable id derived from the JWT (or the raw dev-bypass token). */
  user_id: string
  /**
   * Instance slug the connection is authorized for — the gateway's own frozen
   * owner handle. Credential surfaces construct an `OwnerHandle` from this via
   * `asOwnerHandle(resolved.project_slug)` at the point it is resolved from auth
   * (the spec's known-good construction site); the shared auth-resolved types
   * stay plain `string` so N1 doesn't trigger the full N2/N3 rename.
   */
  project_slug: string
  /** Auth mode that produced this result — surfaced in logs only. */
  mode: AppWsAuthMode
}

export interface AppWsAuthError {
  code:
    | 'missing_token'
    | 'malformed_token'
    | 'invalid_signature'
    | 'expired_token'
    | 'project_mismatch'
    | 'unconfigured'
  message: string
}

export interface AppWsAuthResolverOptions {
  /** The gateway's own instance slug. Tokens binding to a different slug are rejected. */
  project_slug: string
  /** When set, enables `dev-bypass`. */
  bypass: boolean
  /** When set, enables HS256 validation against this secret. */
  hs256_secret?: string
  /**
   * The identity service's JWKS endpoint (`…/.well-known/jwks.json`).
   * When set this is the ONLY live mode — see the file header. This is what
   * makes the mobile login-first flow's instance-scoped bearer acceptable.
   */
  jwks_url?: string
  /**
   * Required `aud` on a JWKS-verified token. OPTIONAL: when omitted the
   * audience is not checked, because the authorization binding that actually
   * matters is the `slug` claim cross-check below (this gateway only accepts a
   * token minted FOR IT), and hardcoding an audience literal here would pin
   * this public tree to one deployment's vocabulary. Set it when the operator
   * knows their identity service's audience value.
   */
  jwks_audience?: string
  /**
   * Required `iss` on a JWKS-verified token. OPTIONAL, same reasoning as
   * `jwks_audience` — this public tree cannot hardcode one deployment's issuer
   * literal. Set it and a token is additionally required to have been minted by
   * that issuer, which is cheap defence-in-depth for the day an instance trusts
   * more than one key source: signature + `slug` alone would then accept a token
   * from ANY issuer in the set, and `iss` is what keeps the two apart.
   */
  jwks_issuer?: string
  /**
   * Test seam — supply the verification key resolver directly instead of
   * fetching `jwks_url`. Real builds never pass this; `createRemoteJWKSet`
   * owns fetching, caching and key rotation.
   */
  jwks_key_resolver?: JWTVerifyGetKey
  /** Override `Date.now` for tests. */
  now?: () => number
}

export interface AppWsAuthResolver {
  resolve(token: string): Promise<AppWsAuthResolved | AppWsAuthError>
  /** Auth mode the resolver is operating in. Surfaced in boot logs. */
  mode: AppWsAuthMode | 'unconfigured'
}

const DEV_BYPASS_PREFIX = 'dev:'

export function createAppWsAuthResolver(
  opts: AppWsAuthResolverOptions,
): AppWsAuthResolver {
  const { project_slug, bypass, hs256_secret, jwks_url, jwks_key_resolver } = opts
  // PRODUCTION FIRST. `bypass` is derived from a LOOPBACK bind, and a hosted
  // instance binds to loopback behind a reverse proxy — so if `bypass` were
  // checked first, a hosted install could never accept the identity service's
  // bearer (the login-first flow would sign in and then have every request
  // rejected). Configuring a JWKS url is the operator's statement that real
  // identity is live, so it outranks the dev lanes.
  if (jwks_url !== undefined && jwks_url.length > 0) {
    const now = opts.now ?? (() => Date.now())
    // `createRemoteJWKSet` owns the fetch, the in-process cache, the
    // rotation-triggered re-fetch and its own cooldown — no cache to maintain
    // here. Built ONCE per resolver so a request burst shares one key set.
    const keys = jwks_key_resolver ?? createRemoteJWKSet(new URL(jwks_url))
    const audience = opts.jwks_audience
    const issuer = opts.jwks_issuer
    return {
      mode: 'jwks',
      resolve: async (token) =>
        resolveJwks(token, project_slug, keys, now, audience, issuer),
    }
  }
  if (bypass) {
    return {
      mode: 'dev-bypass',
      resolve: async (token) => resolveDevBypass(token, project_slug),
    }
  }
  if (hs256_secret !== undefined && hs256_secret.length > 0) {
    const secretBytes = new TextEncoder().encode(hs256_secret)
    const now = opts.now ?? (() => Date.now())
    return {
      mode: 'hs256',
      resolve: async (token) => resolveHs256(token, project_slug, secretBytes, now),
    }
  }
  return {
    mode: 'unconfigured',
    resolve: async () => ({
      code: 'unconfigured',
      message:
        'app-ws auth resolver is unconfigured (set NEUTRON_IDENTITY_JWKS_URL=<jwks-url> ' +
        'to accept identity-service bearers, NEUTRON_APP_WS_BYPASS=1 for dev, ' +
        'or NEUTRON_APP_WS_DEV_SECRET=<secret> for HS256 dev).',
    }),
  }
}

/**
 * Verify an RS256 bearer minted by the identity service against its published
 * JWKS. This is the credential the mobile app receives from the login-first
 * discovery call, so it is the production path for a remote client.
 *
 * THE CLAIM CONTRACT (all four are required — a token missing any one is
 * rejected, never downgraded):
 *
 *   1. `alg: RS256`, signature verifies against a key in the JWKS.
 *   2. `exp` in the future (jose enforces it during `jwtVerify`).
 *   3. `sub` — a non-empty string; the identity service's account id.
 *   4. `slug` — a non-empty string EQUAL to this gateway's own slug,
 *      compared constant-time (ISSUE #34: a byte-wise `!==` leaks this
 *      instance's slug prefix through response timing).
 *
 * (4) IS THE AUTHORIZATION. An identity service issues two kinds of bearer:
 * an ACCOUNT-scoped one (no `slug`, whose only job is to ask "where is my
 * instance?") and an INSTANCE-scoped one (carrying the `slug` it was minted
 * for). Only the second may drive an instance, so a token with NO `slug`
 * claim is refused here — accepting it would let an account-scoped bearer,
 * which any signed-in account holds, operate someone else's install.
 */
async function resolveJwks(
  token: string,
  project_slug: string,
  keys: JWTVerifyGetKey,
  now: () => number,
  audience: string | undefined,
  issuer: string | undefined,
): Promise<AppWsAuthResolved | AppWsAuthError> {
  if (typeof token !== 'string' || token.length === 0) {
    return { code: 'missing_token', message: 'app-ws: token is required' }
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      currentDate: new Date(now()),
      ...(audience === undefined ? {} : { audience }),
      ...(issuer === undefined ? {} : { issuer }),
    })
    const sub = payload.sub
    if (typeof sub !== 'string' || sub.length === 0) {
      return { code: 'malformed_token', message: 'app-ws: JWT missing sub' }
    }
    const tokenSlug = (payload as { slug?: unknown }).slug
    if (typeof tokenSlug !== 'string' || tokenSlug.length === 0) {
      return {
        code: 'project_mismatch',
        message:
          'app-ws: JWT carries no slug claim — an account-scoped bearer cannot drive an instance',
      }
    }
    if (!constantTimeEqual(tokenSlug, project_slug)) {
      return {
        code: 'project_mismatch',
        message: 'app-ws: JWT slug claim does not name this instance',
      }
    }
    return { user_id: sub, project_slug, mode: 'jwks' }
  } catch (err) {
    return classifyJwtError(err, 'app-ws')
  }
}

/**
 * Does this bearer have the SHAPE of a signed JWT (three non-empty base64url
 * segments)? A shape check only — nothing here is trusted, and it decides which
 * diagnostic to emit, never whether to accept a token.
 *
 * Deliberately shape-based rather than "is it long": an HS256 dev token is also a
 * JWT and also cannot be verified by the bypass lane, so both should get the
 * configuration message rather than a length complaint.
 */
function looksLikeJwt(token: string): boolean {
  const parts = token.split('.')
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))
}

function resolveDevBypass(
  token: string,
  project_slug: string,
): AppWsAuthResolved | AppWsAuthError {
  if (typeof token !== 'string' || token.length === 0) {
    return { code: 'missing_token', message: 'app-ws: token is required' }
  }
  const user_id = token.startsWith(DEV_BYPASS_PREFIX)
    ? token.slice(DEV_BYPASS_PREFIX.length)
    : token
  // NAME THE REAL MISCONFIGURATION. A hosted instance binds to loopback behind a
  // reverse proxy, so `bypass` is on there by derivation; if the operator has not
  // set NEUTRON_IDENTITY_JWKS_URL, the login-first bearer — a real RS256 JWT —
  // lands HERE instead of in the JWKS resolver. It then fails the length guard
  // below and reports "dev token is empty or too long", which describes nothing
  // the operator did and sends them hunting the wrong thing. The signed-in owner
  // sees only a 401 on every request. Detecting the JWT shape costs one split and
  // turns that dead end into the actual instruction. (Argus round-2 BLOCKER on
  // PR #440: the whole login-first flow presents this way when the env is unset.)
  if (looksLikeJwt(token)) {
    return {
      code: 'unconfigured',
      message:
        'app-ws: received a JWT bearer but no identity JWKS is configured, so it cannot be ' +
        'verified — this instance is falling back to dev-bypass because it is bound to ' +
        'loopback. Set NEUTRON_IDENTITY_JWKS_URL=<identity-service>/.well-known/jwks.json ' +
        'to accept identity-service bearers (the mobile login-first flow needs it).',
    }
  }
  if (user_id.length === 0 || user_id.length > 128) {
    return { code: 'malformed_token', message: 'app-ws: dev token is empty or too long' }
  }
  // Char-set guard. We're forming a synthetic channel_topic_id from the
  // user_id — keep it ASCII-safe to avoid surprises downstream.
  if (!/^[A-Za-z0-9._:-]+$/.test(user_id)) {
    return {
      code: 'malformed_token',
      message: 'app-ws: dev token contains characters outside [A-Za-z0-9._:-]',
    }
  }
  return { user_id, project_slug, mode: 'dev-bypass' }
}

async function resolveHs256(
  token: string,
  project_slug: string,
  secret: Uint8Array,
  now: () => number,
): Promise<AppWsAuthResolved | AppWsAuthError> {
  if (typeof token !== 'string' || token.length === 0) {
    return { code: 'missing_token', message: 'app-ws: token is required' }
  }
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      currentDate: new Date(now()),
    })
    const sub = payload.sub
    if (typeof sub !== 'string' || sub.length === 0) {
      return { code: 'malformed_token', message: 'app-ws: JWT missing sub' }
    }
    const tokenProjectSlug = (payload as { project_slug?: unknown }).project_slug
    if (tokenProjectSlug !== undefined && tokenProjectSlug !== null) {
      if (typeof tokenProjectSlug !== 'string' || !constantTimeEqual(tokenProjectSlug, project_slug)) {
        return {
          code: 'project_mismatch',
          message: `app-ws: JWT project_slug=${JSON.stringify(tokenProjectSlug)} but this gateway is '${project_slug}'`,
        }
      }
    }
    return { user_id: sub, project_slug, mode: 'hs256' }
  } catch (err) {
    return classifyJwtError(err, 'app-ws')
  }
}

/**
 * Map a `jose` verification throw onto the resolver's error taxonomy. Shared by
 * the HS256 and JWKS modes so the two cannot drift apart on what "expired"
 * versus "bad signature" means.
 */
function classifyJwtError(err: unknown, prefix: string): AppWsAuthError {
  const message = err instanceof Error ? err.message : String(err)
  // jose throws `JWTExpired` (extends `JWTClaimValidationFailed`) with
  // `code: 'ERR_JWT_EXPIRED'` AND `claim: 'exp'` when the token is
  // past `exp`. The class name string is the most reliable
  // discriminator across jose minor versions.
  const errCode = (err as { code?: unknown }).code
  const errName = (err as { name?: unknown }).name
  if (
    errCode === 'ERR_JWT_EXPIRED' ||
    errName === 'JWTExpired' ||
    /expired/i.test(message)
  ) {
    return { code: 'expired_token', message: `${prefix}: JWT expired (${message})` }
  }
  return { code: 'invalid_signature', message: `${prefix}: JWT verify failed (${message})` }
}
