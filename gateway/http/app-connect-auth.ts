/**
 * App connect auth surface (M2.5) — Open client side.
 *
 * The settings affordance "Connect to the shared identity service to join
 * shared projects" drives these routes on the Open instance's own gateway:
 *
 *   POST /api/app/connect/auth/start[?provider=google|apple]
 *     → { auth_url } pointing at the auth service's dedicated
 *       connect OAuth start, carrying THIS gateway's callback as return_url.
 *
 *   GET  /api/app/connect/auth/callback?connect_code=<code>
 *     → redeems the one-time code (server-to-server), persists the federated
 *       credential, 302s back to the app root with `?connect=connected`.
 *
 *   GET  /api/app/connect/auth/status
 *     → { connected, user_instance_slug?, access_expires_at_ms?, refresh_expires_at_ms? }
 *
 *   POST /api/app/connect/auth/disconnect
 *     → { ok: true }  (drops the stored credential)
 *
 * The handler returns `null` for non-matching requests so it composes with the
 * other app surfaces.
 *
 * ## Auth (M2.5 follow-up #6 — ISSUES #84, P1 security gate)
 *
 * All four routes mutate or probe the instance-wide `FederatedTokenStore`, so
 * each one is gated behind the SAME cookie-session auth the chat surface uses
 * (`landing/session-cookie.ts` via the injected `resolveUserClaim` closure —
 * production wires the identical `cookieToUserClaim` the WS upgrade +
 * chat-history surface consume). Without this gate, an attacker on a publicly
 * reachable Open gateway could hit `/callback?connect_code=<their code>`
 * to overwrite the instance's federated credential, or `/disconnect` to wipe it,
 * with NO authenticated session.
 *
 * Cookie auth (not bearer) is the right substrate here because `/callback` is
 * a top-level browser navigation arriving from the OAuth provider's 302 — it
 * carries only the `SameSite=Lax` session cookie, never an `Authorization`
 * header. The XHR routes (`/start`, `/status`, `/disconnect`) are issued
 * same-origin from the web settings panel, so they carry the same cookie. This
 * surface is mounted in Open mode only (web-only); Managed never mounts it.
 *
 * The auth check runs BEFORE any `store` probe or mutation, so an
 * unauthenticated request gets a 401 with the federated-token store untouched.
 */

import {
  FederatedConnectError,
  type FederatedStatus,
} from '../connect/federated-token-store.ts'
import { ownerIdentityMismatch, type OwnerHandleResolver } from './auth-helpers.ts'

const BASE_PATH = '/api/app/connect/auth'

/** The subset of FederatedTokenStore this surface drives — narrowed so tests
 *  can stub it without a real SecretsStore. */
export interface FederatedTokenStoreLike {
  connectViaRedeem(code: string): Promise<FederatedStatus>
  status(): Promise<FederatedStatus>
  disconnect(): Promise<void>
}

/**
 * Verified app-session claim — the subset of `cookieToUserClaim`'s return
 * shape this surface needs. Structurally compatible with the closure
 * `gateway/index.ts` wires (which also carries an optional `set_cookie`).
 */
export interface AppConnectAuthClaim {
  project_slug: string
  user_id: string
}

export interface AppConnectAuthDeps {
  store: FederatedTokenStoreLike
  /** Base URL of the identity service, e.g. https://auth.example.test */
  auth_base_url: string
  /**
   * Where to send the browser after a successful (or failed) connect. Default
   * `'/'`. A query param `connect=connected|error` is appended.
   */
  app_redirect_path?: string
  /**
   * Cookie-session auth resolver — gates all four routes (M2.5 follow-up #6,
   * ISSUES #84). Returns the verified `{ project_slug, user_id }` claim on a
   * valid session cookie, or `null` when the cookie is missing / invalid /
   * connect. Production wires the same `cookieToUserClaim` closure the WS
   * upgrade + chat-history surface use. When cookie auth is unwired on a
   * deploy, the boot path supplies a fail-closed resolver (`async () => null`)
   * so the routes 401 rather than mutate unauthenticated.
   */
  resolveUserClaim(req: Request): Promise<AppConnectAuthClaim | null>
  /**
   * This surface's instance slug — defense-in-depth re-check on the resolved
   * claim (the closure already asserts `claim.project_slug === project_slug`,
   * mirroring the bearer-auth surfaces that re-assert instance binding).
   */
  project_slug: string
  /**
   * Canonical slug → owner_handle resolver (2026-06-10 slug-rename
   * P0). Production wires `buildOwnerHandleResolver(ownersRegistry)`
   * so the instance-identity guard compares frozen internal handles, not
   * renameable url_slugs. When unset the guard degrades to the raw
   * compare (registry-less test compositions).
   */
  resolveOwnerHandle?: OwnerHandleResolver
}

export interface AppConnectAuthSurface {
  handler(req: Request): Promise<Response | null>
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Accept ONLY a same-origin relative path (`/foo?bar`) — never an absolute or
 * protocol-relative URL — so the post-OAuth redirect can't be turned into an
 * open redirect. Returns the path on success, null otherwise.
 */
function safeRelativePath(raw: string | null): string | null {
  if (raw === null || raw.length === 0) return null
  if (raw[0] !== '/') return null
  // Reject `//evil.com` (protocol-relative) and backslash tricks.
  if (raw[1] === '/' || raw[1] === '\\') return null
  if (raw.includes('\\')) return null
  return raw
}

export function createAppConnectAuthSurface(
  deps: AppConnectAuthDeps,
): AppConnectAuthSurface {
  const authBase = deps.auth_base_url.replace(/\/+$/, '')
  const appRedirect = deps.app_redirect_path ?? '/'

  return {
    async handler(req: Request): Promise<Response | null> {
      const url = new URL(req.url)
      if (!url.pathname.startsWith(BASE_PATH)) return null
      const sub = url.pathname.slice(BASE_PATH.length)

      // Only the four owned (path, method) pairs are claimed by this surface.
      // Anything else under BASE_PATH falls through (`null`) so the compose
      // chain keeps dispatching — and, crucially, so a tokenless request to a
      // NON-owned path is not turned into a 401 that would shadow a sibling.
      const isOwnedRoute =
        (sub === '/start' && req.method === 'POST') ||
        (sub === '/callback' && req.method === 'GET') ||
        (sub === '/status' && req.method === 'GET') ||
        (sub === '/disconnect' && req.method === 'POST')
      if (!isOwnedRoute) return null

      // M2.5 follow-up #6 (ISSUES #84) — gate every owned route behind the
      // app-session cookie BEFORE any store probe / mutation. An
      // unauthenticated caller gets a 401 and the FederatedTokenStore is never
      // touched (no `connectViaRedeem`, no `disconnect`, no `status`), closing
      // the connect credential-overwrite / wipe attack.
      // Canonical internal-handle comparison — the claim carries the
      // renameable url_slug while `deps.project_slug` is the frozen
      // internal handle; a raw compare broke on every slug rename
      // (2026-06-10 P0).
      const claim = await deps.resolveUserClaim(req)
      if (
        claim === null ||
        ownerIdentityMismatch(claim.project_slug, deps.project_slug, deps.resolveOwnerHandle)
      ) {
        return json(401, {
          error: 'unauthorized',
          message: 'a valid app session is required for connect auth',
        })
      }

      // POST /start[?provider=&return_path=/invite?invite=...] → auth URL.
      // `return_path` (a same-origin relative path) is baked into the callback
      // so the browser lands back on the ORIGINATING page (e.g. the invite
      // page, whose boot-time `?connect=connected` retry then fires) —
      // not the app root. It survives the OAuth round-trip because
      // `completeConnectAuth` preserves existing return_url query params
      // when it appends `connect_code`.
      if (sub === '/start' && req.method === 'POST') {
        const providerRaw = (url.searchParams.get('provider') ?? 'google').toLowerCase()
        const provider = providerRaw === 'apple' ? 'apple' : 'google'
        const callback = new URL(`${url.origin}${BASE_PATH}/callback`)
        const returnPath = safeRelativePath(url.searchParams.get('return_path'))
        if (returnPath !== null) callback.searchParams.set('app_return', returnPath)
        const authUrl = new URL(`${authBase}/oauth/connect/${provider}/start`)
        authUrl.searchParams.set('return_url', callback.toString())
        return json(200, { auth_url: authUrl.toString() })
      }

      // GET /callback?connect_code=...[&app_return=/invite?...]
      //   → redeem + persist + redirect back to the originating page (or the
      //     configured app root) with connect=connected|error.
      if (sub === '/callback' && req.method === 'GET') {
        const code = url.searchParams.get('connect_code') ?? ''
        const appReturn = safeRelativePath(url.searchParams.get('app_return'))
        const dest = new URL(appReturn ?? appRedirect, url.origin)
        if (code.length === 0) {
          dest.searchParams.set('connect', 'error')
          return Response.redirect(dest.toString(), 302)
        }
        try {
          await deps.store.connectViaRedeem(code)
          dest.searchParams.set('connect', 'connected')
        } catch (err) {
          if (!(err instanceof FederatedConnectError)) throw err
          dest.searchParams.set('connect', 'error')
        }
        return Response.redirect(dest.toString(), 302)
      }

      // GET /status → connection state.
      if (sub === '/status' && req.method === 'GET') {
        const status = await deps.store.status()
        return json(200, status)
      }

      // POST /disconnect → drop the credential.
      if (sub === '/disconnect' && req.method === 'POST') {
        await deps.store.disconnect()
        return json(200, { ok: true })
      }

      return null
    },
  }
}
