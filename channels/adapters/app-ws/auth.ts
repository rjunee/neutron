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
 * Both modes share a single `resolveAppWsAuth` entry point. The
 * production EdDSA / JWKS validator slots in here in a follow-up
 * sprint (call into `jwt-validator/` with `algorithms: ['EdDSA']`
 * + audience `'neutron'` + `project_slug` cross-check).
 */

import { jwtVerify } from 'jose'
// Timing-safe slug comparison (ISSUE #34). The HS256 bearer's verified
// `project_slug` claim is cross-checked against this gateway's slug; a plain
// `!==` short-circuits on the first byte mismatch and leaks the shared-prefix
// length of this instance's slug through response timing. Route it through the
// shared constant-time primitive (the same one the landing cookie + gateway
// surfaces use).
import { constantTimeEqual } from '../../../runtime/constant-time-equal.ts'

export type AppWsAuthMode = 'dev-bypass' | 'hs256'

export interface AppWsAuthResolved {
  /** Stable id derived from the JWT (or the raw dev-bypass token). */
  user_id: string
  /** Instance slug the connection is authorized for. */
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
  const { project_slug, bypass, hs256_secret } = opts
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
        'app-ws auth resolver is unconfigured (set NEUTRON_APP_WS_BYPASS=1 for dev, ' +
        'or NEUTRON_APP_WS_DEV_SECRET=<secret> for HS256 dev).',
    }),
  }
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
      return { code: 'expired_token', message: `app-ws: JWT expired (${message})` }
    }
    return { code: 'invalid_signature', message: `app-ws: JWT verify failed (${message})` }
  }
}
