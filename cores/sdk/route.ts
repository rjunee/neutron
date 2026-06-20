/**
 * @neutronai/cores-sdk — Hono route helper.
 *
 * `mountCoreRoutes(app, options)` wires the four canonical surfaces a
 * Core needs to expose:
 *   GET  /healthz           (always public, no auth)
 *   * /api/*                (auth-required; capability-gated per route
 *                            via the manifest's tools[] declarations)
 *   GET  <admin_mount>/*    (auth-required; the Core's React admin UI;
 *                            mount path comes from its manifest's
 *                            ui_components[].surface === 'route_mount'
 *                            entry — typically `/admin`)
 *   ws   /ws/*              (P3+ — placeholder, not wired in v1)
 *
 * Auth: every non-`/healthz` request must carry an
 *   Authorization: Bearer <start_token>
 * header that resolves through the supplied `validator`. The validator
 * is whichever shape the Core picked at build time —
 * `validatePlatformJwt(...)` in prod, `buildDevPlatformJwtValidator()`
 * in dev. The verified `PlatformAuthResult` is hung off the Hono
 * context as `c.get('auth')`.
 *
 * Capability gate: this v1 helper only checks that the Core declared
 * the required capability for `/api/*` routes the Core itself
 * registers. It does NOT claim to know what each route does — the
 * Core registers its routes with `app.get('/api/foo', ..., {
 * capability_required: 'read:project.db' })` via the
 * `apiHandler({...})` helper exported here. Routes mounted directly
 * on `app` outside this helper are NOT gated; that's the Core's
 * responsibility to use the helper.
 *
 * Cross-refs:
 * - cores/sdk/auth.ts (the validator surface this helper consumes)
 * - cores/sdk/manifest.ts (capabilities[] + ui_components[])
 * - docs/engineering-plan.md § B.P3 (Cores runtime spec — this helper
 *   becomes platform-side in P3 but the Core-author-facing API stays
 *   identical)
 */

import type { Context, Hono, MiddlewareHandler } from 'hono'

import type { PlatformAuthResult, PlatformJwtValidator } from './auth.ts'
import { PlatformJwtError } from './auth.ts'
import type { Capability, NeutronManifest } from './manifest.ts'

/**
 * Minimum Hono shape the helper needs. Cores can pass either a `Hono`
 * instance or a custom Hono subclass — we duck-type against just the
 * methods we use.
 */
export type HonoApp = Pick<
  Hono,
  'get' | 'post' | 'put' | 'delete' | 'use' | 'route' | 'all'
>

/**
 * Auth context that capability-gated routes can read off `c.get('auth')`.
 * Stable shape — Cores depend on this verbatim.
 */
export interface CoreRouteAuth extends PlatformAuthResult {}

export interface MountCoreRoutesOptions {
  /** The Core's stable id (its npm package name, e.g. `@neutronai/dtc-analytics`).
   *  Used in error messages + (P3) audit log. */
  core_id: string
  /** The Core's parsed Zod manifest. Capability gating + admin-mount
   *  resolution both consult this. */
  manifest: NeutronManifest
  /** Token validator. Production: `(t) => validatePlatformJwt(t, jwksUrl, {...})`.
   *  Dev: `buildDevPlatformJwtValidator(...)`. */
  validator: PlatformJwtValidator
  /**
   * Optional health-check body. Default returns `{ ok: true }`. Cores
   * can override to surface upstream-connector status, last-sync ts,
   * etc.
   */
  healthz?: () => Promise<unknown> | unknown
}

const AUTH_VAR = 'auth' as const

/**
 * Build a middleware that validates the bearer token and stashes the
 * verified claim on the context. Failed-auth requests get a uniform
 * 401 with a structured JSON body.
 */
function buildAuthMiddleware(
  validator: PlatformJwtValidator,
): MiddlewareHandler {
  return async (c: Context, next): Promise<Response | void> => {
    const header = c.req.header('Authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (match === null) {
      return c.json(
        {
          error: 'unauthorized',
          detail: 'missing or malformed Authorization: Bearer <token> header',
        },
        401,
      )
    }
    const token = (match[1] ?? '').trim()
    let auth: PlatformAuthResult
    try {
      auth = await validator(token)
    } catch (err) {
      const code =
        err instanceof PlatformJwtError ? err.code : 'token_invalid'
      const detail =
        err instanceof Error ? err.message : 'token validation failed'
      return c.json({ error: code, detail }, 401)
    }
    c.set(AUTH_VAR, auth)
    await next()
    return
  }
}

/**
 * Wire the four canonical surfaces. Returns `{ adminMountPath }` so
 * the caller can register its React-bundle handler under the resolved
 * path without re-parsing the manifest.
 *
 * Idempotent over a fresh `Hono` instance; re-mounting onto an app
 * that already has competing routes will end up with both handlers
 * (Hono's last-match-wins behaviour).
 */
export function mountCoreRoutes(
  app: HonoApp,
  options: MountCoreRoutesOptions,
): { adminMountPath: string | null } {
  // /healthz — public.
  const healthzBody = options.healthz ?? ((): { ok: true } => ({ ok: true }))
  app.get('/healthz', async (c: Context): Promise<Response> => {
    const body = await Promise.resolve(healthzBody())
    return c.json(body)
  })

  // Auth gate covers everything except /healthz. Hono evaluates use()
  // in registration order; this runs before the Core's own /api and
  // admin handlers, but AFTER /healthz already matched. Register on
  // BOTH the bare path and the wildcard since Hono's `/api/*` glob
  // does NOT match the exact `/api` segment — same root-path edge
  // case the admin mount handles below.
  const auth = buildAuthMiddleware(options.validator)
  app.use('/api', auth)
  app.use('/api/*', auth)

  // Resolve admin mount from the manifest. A Core may declare zero or
  // one route_mount surface; v1 takes the first one if multiple are
  // declared (tested by the route_mount manifest fixture).
  const adminMount = options.manifest.ui_components.find(
    (c) => c.surface === 'route_mount' && typeof c.mount_path === 'string',
  )
  let adminMountPath: string | null = null
  if (adminMount !== undefined && adminMount.mount_path !== undefined) {
    adminMountPath = adminMount.mount_path
    // Cover BOTH the bare mount path (e.g. /admin) AND its subtree
    // (e.g. /admin/*). Hono's `/admin/*` glob does NOT match the
    // exact `/admin` segment, so a Core that serves an SPA shell or
    // redirect at the root path would otherwise be reachable without
    // a bearer token.
    app.use(adminMountPath, auth)
    app.use(`${adminMountPath}/*`, auth)
  }

  return { adminMountPath }
}

/**
 * Capability-gated route handler decorator. Wraps a Core's `/api/*`
 * handler so the platform checks the manifest declared the required
 * capability before dispatch. Used like:
 *
 * ```ts
 * app.get('/api/foo', apiHandler({
 *   manifest,
 *   capability_required: 'read:project.db',
 *   handler: async (c, auth) => c.json({...}),
 * }))
 * ```
 *
 * If the Core's manifest does NOT declare the capability, the
 * decorator returns a 500 at call time — this is ALWAYS a Core author
 * bug, never a runtime condition. Catching it loud at install/dev
 * boot beats silently 200ing.
 */
export interface ApiHandlerOptions {
  manifest: NeutronManifest
  capability_required: Capability
  handler: (c: Context, auth: CoreRouteAuth) => Response | Promise<Response>
}

export function apiHandler(
  options: ApiHandlerOptions,
): (c: Context) => Promise<Response> {
  const declared = options.manifest.capabilities.includes(
    options.capability_required,
  )
  return async (c: Context): Promise<Response> => {
    if (!declared) {
      return c.json(
        {
          error: 'misconfigured',
          detail: `core manifest does not declare capability=${options.capability_required}`,
        },
        500,
      )
    }
    const auth = c.get(AUTH_VAR) as CoreRouteAuth | undefined
    if (auth === undefined) {
      return c.json(
        {
          error: 'unauthorized',
          detail: 'auth context missing — mountCoreRoutes was not called',
        },
        401,
      )
    }
    return options.handler(c, auth)
  }
}
