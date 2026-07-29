/**
 * @neutronai/landing/routes — the landing surface's route manifest.
 *
 * C5 (world-class-refactor plan §C5) — the single source of truth for WHICH
 * paths the per-instance gateway's HTTP precedence chain delegates to the
 * landing server. Before this unit the predicate + its path set lived as a
 * hand-maintained `LANDING_PATHS` literal inside `gateway/http/route-slots.ts`
 * (a "3-incident 404 factory"), duplicating routing knowledge the landing
 * server itself owns. Now the landing package OWNS the manifest and the
 * gateway CONSUMES it (`route-slots.ts` imports `isLandingRoute` from here for
 * the `landing` slot's match; `landing/server.ts` re-exports it so the surface
 * that implements the routes also publishes their contract).
 *
 * This is a deliberately TINY leaf (mirrors `landing/spa-routes.ts`): it pulls
 * in NO runtime from `landing/server.ts` (which readFileSyncs assets + calls
 * `Bun.build`), so the gateway can import it without dragging the whole landing
 * server into `gateway/http`'s module graph.
 *
 * GENERATED: `LANDING_ROUTE_PATHS` and the exact-match arm of `isLandingRoute`
 * are both derived from the ONE `LANDING_ROUTE_MANIFEST` declaration below; the
 * prefix + root-with-invite arms are declared alongside it. The transition test
 * (`landing/__tests__/routes-transition.test.ts`) pins the generated set +
 * predicate against a frozen snapshot of the pre-C5 `LANDING_PATHS` literal, so
 * the relocation is behavior-identical by construction.
 */

/**
 * Exact `url.pathname` values the per-instance gateway delegates to the landing
 * server. ORDER is not load-bearing (membership is a Set lookup) but is kept
 * grouped-by-incident to preserve the historical rationale.
 *
 * Matches the routes implemented in `landing/server.ts`:
 *   - `GET  /chat`                       chat-react SPA shell (or auth-gate page)
 *   - `GET  /chat-react.js`              bundled client
 *   - `GET  /api/v1/sign-up`             OAuth redirect trampoline
 *   - `GET  /invite[?invite=…]`          static HTML (when invite_html present)
 *   - `GET  /invite.js`                  bundled client
 *   - `POST /onboarding/invite-accept`   accept handler
 *   - `GET  /recover`                    S17 — silent reconnect after a
 *                                        post-slug-rename WS disconnect
 *   - `GET  /start`                      2026-05-22 — `?token=` (or legacy
 *                                        `?start=`) lands returning owners on
 *                                        the per-instance gateway; the handler
 *                                        302s to `/chat?start=<token>`.
 *   - `GET  /mobile`, `/site.webmanifest`, `/favicon.svg`, `/apple-touch-icon.png`
 *                                        ISSUES #208 — install page + PWA/brand
 *                                        assets (none auth-gated).
 *
 * Two entries are NOT served by `landing/server.ts` — they are gateway
 * precedence SAFETY NETS so a slug-renamed instance whose per-instance chain
 * would otherwise fall through to the default 404 keeps reaching the real
 * `chat_history_surface` / `chat_topics_surface` rungs (which are bound EARLIER
 * in `ROUTE_SLOTS`, so they win before this landing match is ever consulted):
 *   - `/api/v1/chat/history`             2026-05-28 chat-history hydration sprint
 *   - `/api/v1/chat/topics`             2026-05-28 sidebar topic-rail sprint
 * They live in the manifest (not the gateway) so the landing↔gateway routing
 * contract stays in ONE place; the comments above pin why each is present.
 */
export const LANDING_ROUTE_MANIFEST = [
  '/chat',
  '/chat-react.js',
  '/api/v1/sign-up',
  '/invite',
  '/invite.js',
  '/onboarding/invite-accept',
  '/recover',
  '/start',
  '/api/v1/chat/history',
  '/api/v1/chat/topics',
  '/mobile',
  '/site.webmanifest',
  '/favicon.svg',
  '/apple-touch-icon.png',
  //   - `/favicon.ico`                    2026-07-18 favicon sprint. Browsers
  //     request it at the origin automatically (no markup needed) and cache the
  //     404 negatively; without it in this manifest the gateway never routes the
  //     path to landing at all, so the brand-asset allowlist alone is not enough.
  //     APPENDED LAST — `landing/__tests__/routes-transition.test.ts` pins
  //     declaration order against a frozen pre-C5 snapshot + an append-only
  //     `ADDED_SINCE_C5` list; keep new paths at the end and mirror them there.
  '/favicon.ico',
] as const

/**
 * Path prefixes (variable trailing segment) the landing server owns.
 *   - `/oauth/max/install-token` — AUTH-CORRECTION (2026-06-28). The Claude-Max
 *     OAuth install-token handoff routes
 *     (`/oauth/max/install-token/{initiate,<signup_id>.sh,complete,state}`) are
 *     served by landing's `installTokenHandler`. They carry a variable
 *     `<signup_id>.sh` segment so a path-Set match won't do — prefix-match the
 *     whole surface. None are auth-gated (the gate only covers `/`, `/chat`,
 *     `/api/app/*`), which is correct: the handoff is the PRE-auth step.
 */
export const LANDING_ROUTE_PREFIXES = ['/oauth/max/install-token'] as const

/**
 * GENERATED — the exact-path allowlist as a Set (derived from
 * `LANDING_ROUTE_MANIFEST`). Re-exported test-helper view so other modules (or
 * tests) can assert routing without re-implementing the predicate.
 */
export const LANDING_ROUTE_PATHS: ReadonlySet<string> = new Set(LANDING_ROUTE_MANIFEST)

/**
 * Does the per-instance gateway delegate `pathname` (a `method` request, with
 * `hasInviteQuery` = does the URL carry `?invite=`) to the landing server?
 *
 * Behavior-identical to the pre-C5 `gateway/http/route-slots.ts:isLandingRoute`
 * — the exact-match arm reads the generated `LANDING_ROUTE_PATHS`, the prefix
 * arm reads `LANDING_ROUTE_PREFIXES`, and the root-with-`?invite=` short-circuit
 * is preserved verbatim.
 */
export function isLandingRoute(
  pathname: string,
  method: string,
  hasInviteQuery: boolean,
): boolean {
  if (LANDING_ROUTE_PATHS.has(pathname)) return true
  if (LANDING_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
  // Root path with `?invite=` is the invite landing short-circuit.
  if (pathname === '/' && method === 'GET' && hasInviteQuery) return true
  return false
}
