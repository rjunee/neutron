/**
 * @neutronai/gateway/http — session-cookie → user-claim resolver.
 *
 * Extracted from the inline `cookieToUserClaim` closure in
 * `gateway/index.ts` (persistent-session-cookie sprint, 2026-05-27) as
 * part of the 2026-06-10 slug-rename P0 fix so the cookie-auth
 * invariant is unit-testable against the REAL production code path.
 *
 * Resolves the HMAC session cookie (see `landing/session-cookie.ts`)
 * into `{ project_slug, user_id, set_cookie? }` for every cookie-authed
 * surface: the `/ws/chat` upgrade, `GET /api/v1/chat/history`,
 * `GET /api/v1/chat/topics`, and the M2.5 cross-instance auth routes.
 *
 * Instance binding (2026-06-10 fix): the cookie's slug is matched against
 * THIS gateway's instance via `ownerIdentityMismatch` — the canonical
 * internal-handle comparison — NOT a raw string compare against
 * `url_slug`. The session cookie is minted from the public subdomain
 * (the renameable `url_slug`), while the gateway is bound to the frozen
 * `internal_handle`; after a post-onboarding slug rename the two
 * diverge ("kairos" vs "t-33333333") and the old raw compare rejected
 * every cookie-authed request (401 `project_mismatch`, sidebar rendered
 * General-only). Accepting EITHER the current url_slug OR the internal
 * handle also keeps pre-rename browser sessions alive across a rename.
 *
 * The claim's outbound `project_slug` is the row's CURRENT `url_slug`,
 * and the sliding-refresh `set_cookie` re-signs the CURRENT `url_slug`
 * — so a stale pre-rename cookie converges to the new slug on its
 * first authenticated request.
 */

import {
  formatSetCookie,
  readSessionCookie,
  signSessionCookie,
} from '../../landing/session-cookie.ts'
import {
  buildOwnerHandleResolver,
  ownerIdentityMismatch,
  type OwnerHandleLookup,
} from './auth-helpers.ts'

export interface CookieUserClaim {
  project_slug: string
  user_id: string
  set_cookie?: string
}

/** Registry view this module needs — the canonical-handle lookups plus
 *  the owner lookup on the gateway's own row. Satisfied by the
 *  provisioning registry (`OwnersRegistry`). */
export interface CookieClaimRegistry extends OwnerHandleLookup {
  getByInternalHandle(
    internal_handle: string,
  ): { internal_handle: string; url_slug: string; owner_user_id: string | null } | undefined
}

export interface BuildCookieUserClaimOpts {
  /** `NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET` (>= 16 chars, caller-validated). */
  cookie_secret: string
  /** The frozen registry PK this gateway serves (`NEUTRON_INSTANCE_SLUG`). */
  internal_handle: string
  /** Instance registry (read-only open is fine — lookups only). */
  registry: CookieClaimRegistry
  /** Wall clock injectable for test determinism. Defaults to `Date.now`. */
  now?: () => number
  /** Log-tag prefix; defaults to the gateway's internal handle. */
  log_owner?: string
}

export function buildCookieUserClaim(
  opts: BuildCookieUserClaimOpts,
): (req: Request) => Promise<CookieUserClaim | null> {
  const now = opts.now ?? ((): number => Date.now())
  const log_owner = opts.log_owner ?? opts.internal_handle
  const resolveOwnerHandle = buildOwnerHandleResolver(opts.registry)
  return async (req: Request): Promise<CookieUserClaim | null> => {
    const observed = now()
    const cookieSlug = readSessionCookie(req, opts.cookie_secret, observed)
    if (cookieSlug === null) return null
    const row = opts.registry.getByInternalHandle(opts.internal_handle)
    if (row === undefined) return null
    // Enforce same-instance binding: a cookie minted for another instance on
    // the same apex must NOT authenticate here. Canonical internal-handle
    // comparison (NOT raw url_slug) — see module header for the
    // slug-rename invariant this protects.
    if (ownerIdentityMismatch(cookieSlug, row.internal_handle, resolveOwnerHandle)) {
      return null
    }
    const owner = row.owner_user_id
    if (typeof owner !== 'string' || owner.length === 0) return null
    try {
      const refreshed = signSessionCookie(row.url_slug, opts.cookie_secret, observed)
      return {
        project_slug: row.url_slug,
        user_id: owner,
        set_cookie: formatSetCookie(refreshed),
      }
    } catch (err) {
      console.warn(
        `[cookie-user-claim] project=${log_owner} refresh-cookie sign failed (falling through to no-refresh accept):`,
        err,
      )
      return {
        project_slug: row.url_slug,
        user_id: owner,
      }
    }
  }
}
