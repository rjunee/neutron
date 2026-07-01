/**
 * landing/spa-routes — SPA client-route predicate (doc-link deep-link 404 fix).
 *
 * The chat-react SPA client-routes project-scoped deep links — most importantly
 * the P-A doc-reference URL `/projects/<id>/docs?path=…` the agent renders as a
 * tappable link (see `landing/chat-react/doc-link-nav.ts`). Tapping that link
 * IN the SPA is intercepted client-side, but a HARD load (new tab, bookmark,
 * shared URL) hits the gateway's HTTP precedence chain, which has no route
 * serving the SPA shell for anything but the exact `/chat` path — so the deep
 * link falls through to the default 404 (`gateway/http/compose.ts`).
 *
 * This predicate lets the gateway delegate such a browser navigation to the
 * landing server, which serves the chat-react shell so the SPA boots and
 * client-routes to the deep link (`config.ts` → `ProjectShell` open-on-boot).
 *
 * The match is deliberately NARROW: only `GET /projects[/…]`. That prefix is
 * disjoint from every API / asset / operator surface (`/api/`, `/ws/`,
 * `/webhook/`, `/internal/`, `/admin/`, `/oauth/`, `/.well-known/`, `/healthz`,
 * `/chat-react.js`, `/avatar.png`, the brand assets), all of which are matched
 * EARLIER in the compose chain and keep returning their own real 404s. So the
 * catch-all can never mask an API/asset 404 — an unknown `/api/app/…` path still
 * 404s through the default handler.
 */

/** True when `pathname` is a chat-react SPA client-route the shell should serve
 *  (a browser GET navigation into `/projects[/…]`). Non-GET methods and every
 *  other path return false so they keep their existing routing. */
export function isSpaClientRoute(pathname: string, method: string): boolean {
  if (method !== 'GET') return false
  return pathname === '/projects' || pathname.startsWith('/projects/')
}
