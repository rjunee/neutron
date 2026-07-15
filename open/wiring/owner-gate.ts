/**
 * @neutronai/open — single-owner http-shell owner gate (C3c).
 *
 * Behavior-preserving extraction of the security-sensitive owner-gate cluster of
 * `createOpenComposition` (old `open/composer.ts` lines ~1042-1458 + the
 * module-level `formatOwnerSetCookie` at ~3532): the cookie-mint / one-shot
 * start-token / auth funnel that wraps the landing `fetch`. The composer keeps
 * consuming the returned `openFetch` verbatim (`landing_server.fetch`).
 *
 * The cluster, VERBATIM:
 *   1. `coldStartRedirect(url)` — mints a fresh owner cookie + one-shot local
 *      start-token and 302s to `/chat?start=<token>`.
 *   2. `hasResumableState()` — reads `landing.stateStore.get(project_slug,
 *      OWNER_USER_ID)`; FAILS TOWARD COLD-START on read error (the
 *      stale-cookie-over-wiped-DB guard — the `console.warn` + `return false`
 *      are preserved exactly).
 *   3. The React-shell bootstrap HTML injection (`withReactBootstrap` +
 *      `projectsBootstrapScript` / `onboardingBootstrapScript` /
 *      `claimBootstrapScript`) — injects the canonical project list into the
 *      served `/chat` HTML by exact-regex replace on the `/chat-react.js` module
 *      tag, gated by the `!html.includes('/chat-react.js')` guard.
 *   4. `openFetch(...)` — the gate itself: cookie-present GET serves chat.html;
 *      no-cookie / stale-cookie funnels through `coldStartRedirect`; the
 *      `?start=` JTI is CLAIMED BEFORE the cookie is minted (single-use) via
 *      `claimStartToken` → `startTokenAuth.claimStartTokenJti`; the cookie is
 *      minted ONLY on the first successful claim.
 *
 * THE ONE SANCTIONED DEVIATION (plan-cited old `:1418-1426` and `:1442-1450`):
 * the TWO byte-identical claim-then-mint blocks in the SPA-deep-link path and
 * the `/chat` `?start=` gate are converged onto the single inline
 * `claimAndMintThenServe(startToken, sourceRes, url)` helper below. Both former
 * call sites now share it, preserving the exact claim-then-mint / single-use JTI
 * / cookie-mint-only-on-first-claim semantics (the only per-site difference was
 * the source-Response local — `spaRes` vs `res` — now a parameter).
 *
 * This is a NEW leaf the composer imports DOWNWARD — it must never import back
 * into `open/composer.ts`. The shared rail-row reader (`readProjectRows`) is
 * threaded in as a dep because it is ALSO consumed by the composer's live
 * `projects_changed` app-ws emit + topic-rail surface (it stays composer-owned).
 */

import { createLogger } from '@neutronai/logger'
import type { HttpGate } from '@neutronai/gateway/http/http-gate.ts'
import { isLandingRoute } from '@neutronai/landing/routes.ts'
import { isSpaClientRoute } from '@neutronai/landing/spa-routes.ts'
import { readSessionCookie, signSessionCookie } from '@neutronai/landing/session-cookie.ts'
import type { ConsumedTokensStore } from '@neutronai/runtime/start-token-types.ts'
import type { LandingStackWithEngine } from '@neutronai/gateway/realmode-composer/build-landing-stack.ts'
import type { LocalStartTokenAuth } from '../local-start-token.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'
import type { ProjectActivity, PreviewFrom } from '../project-rail.ts'
import type { OpenWiringContext } from './context.ts'

/**
 * The canonical rail-row shape the bootstrap injection reads. Mirrors the
 * composer's `readProjectRows()` return type exactly (id + label + the
 * rail-redesign fields) so the composer → dep assignment is byte-identical.
 */
const log = createLogger('open-owner-gate')

export interface ProjectRailRow {
  id: string
  label: string
  emoji: string
  unread: number
  last_activity_at: string
  activity: ProjectActivity
  preview: string | null
  preview_from: PreviewFrom
  live_runs: number
}

/**
 * The composed dependencies the owner gate reads that the narrow wiring context
 * does NOT carry. Each is threaded verbatim from the composer local of the same
 * name.
 */
export interface WireOwnerGateDeps {
  /**
   * The single shared HMAC secret for both the session cookie AND the local
   * start-token (`NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET`, defaulted defensively
   * by the composer).
   */
  cookieSecret: string
  /** Single-owner local start-token auth (mint / verify / claim). */
  startTokenAuth: LocalStartTokenAuth
  /**
   * The ONE shared single-use store for start-token JTIs — the `?start=` JTI is
   * claimed against it at the HTTP cookie-mint gate so a leaked token is
   * single-use.
   */
  consumedTokens: ConsumedTokensStore
  /** The landing stack — supplies `stateStore.get` (resume check) + `fetch`. */
  landing: LandingStackWithEngine
  /**
   * The canonical project-list reader (the `projects`-table source of truth).
   * COMPOSER-OWNED (also drives the live `projects_changed` emit + topic rail),
   * threaded here as the READER the page bootstrap injection consumes.
   */
  readProjectRows: () => ProjectRailRow[]
  /**
   * S0 security quick-patch (b) — the per-boot app-ws token, minted once per
   * boot by the composer. Injected into the served `/chat` bootstrap as
   * `window.__neutron_app_ws_token` so the React client presents it (instead of
   * the guessable `dev:<owner>` default) on the WS upgrade + every /api/app/*
   * bearer call. A fresh boot mints a fresh token, invalidating any prior one.
   */
  appWsToken: string
}

export interface WiredOwnerGate {
  /** The single-owner http-shell gate; consumed as `landing_server.fetch`. */
  openFetch: (
    req: Request,
    server: import('bun').Server<unknown>,
  ) => Response | Promise<Response>
  /**
   * C5b — the same single-owner gate re-expressed as the unified `HttpGate`
   * seam, so Open flows through `composition.auth_gate` exactly like Managed
   * (instead of wiring `openFetch` as `landing_server.fetch`). The Open composer
   * supplies THIS as `auth_gate` and points `landing_server.fetch` at the RAW
   * landing surface. `apply` routes ONLY `GET /chat` + SPA client-route deep
   * links to `openFetch` (the paths the owner gate meaningfully gates); every
   * other request — including the bare `GET /`, which `openFetch`'s shadowed
   * `/` branch never handled in the compose chain, and `/api/app/*`, which the
   * owner gate never touched — falls through to `next()` (the route ladder),
   * preserving the exact pre-C5b behavior. `openFetch` itself is UNCHANGED.
   */
  gate: HttpGate
}

/**
 * Build the `Set-Cookie` header value for the single owner's session. Mirrors
 * `landing/session-cookie.ts:formatSetCookie` but drops `Secure` on plain
 * http loopback (a self-hoster running `bun start` over http://127.0.0.1
 * without TLS) so the browser actually stores + returns the cookie. Behind
 * TLS (https) the `Secure` flag is set as normal.
 */
function formatOwnerSetCookie(
  project_slug: string,
  secret: string,
  url: URL,
): string {
  const c = signSessionCookie(project_slug, secret, Date.now())
  const secure = url.protocol === 'https:' ? '; Secure' : ''
  return `${c.name}=${c.value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${c.max_age_s}${secure}`
}

/**
 * Construct the Open composition's single-owner owner gate from the narrow
 * wiring context plus the composed `deps`. The composer keeps consuming the
 * returned `openFetch` exactly as today (`landing_server.fetch`).
 */
export function buildOpenOwnerGate(
  ctx: OpenWiringContext,
  deps: WireOwnerGateDeps,
): WiredOwnerGate {
  const { db, env, project_slug } = ctx
  const { cookieSecret, startTokenAuth, consumedTokens, landing, readProjectRows, appWsToken } =
    deps

  // Mint a fresh owner cookie + one-shot local start-token and 302 to the
  // PROVEN cold-start path (/chat?start=<token> → engine.start → first
  // onboarding prompt). Used both for a no-cookie visit AND for the
  // stale-cookie fallback so a valid-but-unresumable cookie funnels into the
  // exact same working path instead of a loader that spins forever.
  const coldStartRedirect = (url: URL): Response => {
    const token = startTokenAuth.mint({ project_slug, user_id: OWNER_USER_ID })
    const headers = new Headers({
      location: `/chat?start=${encodeURIComponent(token)}`,
    })
    headers.append('set-cookie', formatOwnerSetCookie(project_slug, cookieSecret, url))
    return new Response(null, { status: 302, headers })
  }

  // Does this owner have an onboarding session worth resuming? A returning
  // visit with a valid cookie is only safe to serve chat.html (→ cookie-only
  // WS resume) when there is real resumable state. A fresh/wiped DB (no
  // `onboarding_state` row — the owner re-ran install.sh, the data dir was
  // cleared, or onboarding never started) has nothing to resume: the
  // cookie-only WS open registers a sender but the General topic re-emits
  // NOTHING, so the client wedges on the "Setting things up…" loader forever
  // (the loader only clears when the first real content lands). In that case
  // we MUST fall back to the cold-start path so a valid-but-stale cookie can
  // never strand the client.
  const hasResumableState = async (): Promise<boolean> => {
    try {
      const row = await landing.stateStore.get(project_slug, OWNER_USER_ID)
      return row !== null
    } catch (err) {
      // Fail toward cold-start: if the state row can't be read we can't
      // prove a resume will land, and a hung loader is strictly worse than
      // a fresh onboarding bounce. `engine.start` is idempotent — it
      // re-emits the CURRENT phase prompt — so cold-starting a user who
      // actually had state simply re-surfaces where they left off.
      log.warn('resumable_state_read_threw', {
        note: 'treating as no resumable state (cold-start)',
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
      return false
    }
  }

  // P1b — React shell project bootstrap. `chat-react/config.ts` reads the
  // owner's project list + active project from `window.__neutron_projects` /
  // `window.__neutron_active_project_id`; nothing set them, so the React
  // ProjectShell had `projectId === null` forever and never fetched
  // `/api/app/projects/<id>/tabs` — the Documents/Tasks tabs stayed hidden even
  // with their backends mounted (Codex r1). Inject the canonical project list
  // (from the `projects` table — the source of truth onboarding writes) into
  // the served `/chat` HTML so the shell opens on a real project with its tabs.
  const projectsBootstrapScript = (): string => {
    const projects = readProjectRows()
    // Escape `<` so a project name can never break out of the <script> context.
    const enc = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c')
    const active = projects.length > 0 ? enc(projects[0]!.id) : 'null'
    // Codex r1 [P1] — Open's `?start=` token is a local HMAC payload, NOT a JWT
    // with a `sub` claim, so `chat-react/config.ts:decodeJwtSub` returns null
    // and the client throws `ChatBootstrapError` before it can open
    // `/ws/app/chat`. Inject the owner identity explicitly so the client
    // derives `userId` (→ its default `dev:<owner>` app-ws bearer, the one our
    // owner-restricted resolver accepts) and connects.
    // S0 (b) — inject the per-boot app-ws token. The client reads
    // `window.__neutron_app_ws_token` (chat-react/config.ts) and sends it as its
    // WS + /api/app/* bearer instead of the guessable `dev:<owner>` default, so a
    // page from a previous boot carries a stale token.
    // SCOPE (do not overclaim): S0 hardens the WS UPGRADE — a browser-origin
    // `/ws/app/chat` upgrade is rejected unless it presents this exact token
    // (app-ws-surface.ts). The `/api/app/*` resolver ADDS this token as a valid
    // owner credential but still ACCEPTS the legacy `dev:owner` bearer (the
    // pre-existing dev-bypass); server-side rejection of `dev:owner` on every
    // /api/app/* surface is S1's job (per-install owner credential + C5 gate seam).
    // S0 closes the most exploitable hole (WS bypasses CORS); the HTTP bearer
    // path is CORS/SOP-mitigated cross-origin and hardened fully in S1.
    return (
      `<script>window.__neutron_user_id=${enc(OWNER_USER_ID)};` +
      `window.__neutron_projects=${enc(projects)};` +
      `window.__neutron_app_ws_token=${enc(appWsToken)};` +
      `window.__neutron_active_project_id=${active};</script>`
    )
  }
  // BUG 1 (auto-start) — tell the React client whether THIS owner is still
  // onboarding so a fresh session shows the auto-start loader ("Setting things
  // up…") instead of the steady-state "Send a message to begin." empty state.
  // Mirrors `isOnboardingActive` below: no `onboarding_state` row OR a
  // non-terminal phase ⇒ active. Kept as a SEPARATE injected <script> from
  // `projectsBootstrapScript` (and away from the `?start=` gate) to minimise
  // the merge surface with the in-flight forge-p2-followups edits.
  const onboardingBootstrapScript = (): string => {
    let active = false
    try {
      const row = db
        .prepare<{ phase: string }, [string, string]>(
          `SELECT phase FROM onboarding_state WHERE project_slug = ? AND user_id = ?`,
        )
        .get(project_slug, OWNER_USER_ID)
      active = row == null ? true : row.phase !== 'completed' && row.phase !== 'failed'
    } catch {
      // Unknown (no table yet / read error) → false so a steady-state chat
      // never wedges on the loader; a genuinely-fresh onboarding briefly shows
      // the plain empty state before the server's opener lands.
      active = false
    }
    return `<script>window.__neutron_onboarding_active=${active ? 'true' : 'false'};</script>`
  }
  // Managed post-onboarding claim redirect — a CONFIG passthrough, not a flag.
  // When env `NEUTRON_POST_ONBOARDING_CLAIM_URL` is set (the Managed overlay
  // points it at the control-plane `/claim`), inject it into the page bootstrap so the
  // React client can navigate there when it receives the `onboarding_completed`
  // frame. When UNSET (the Open self-host default) NOTHING is injected — the
  // client's config reads `undefined` and the redirect no-ops. There is ONE
  // code path (redirect-if-present); absence of the env is the "off" state.
  const claimBootstrapScript = (): string => {
    const claimUrl = env['NEUTRON_POST_ONBOARDING_CLAIM_URL']
    if (typeof claimUrl !== 'string' || claimUrl.length === 0) return ''
    // Escape `<` so the URL can never break out of the <script> context.
    const enc = JSON.stringify(claimUrl).replace(/</g, '\\u003c')
    return `<script>window.__neutron_post_onboarding_claim_url=${enc};</script>`
  }
  const withReactBootstrap = async (res: Response | Promise<Response>): Promise<Response> => {
    const r = await res
    const ct = r.headers.get('content-type') ?? ''
    if (!ct.includes('text/html')) return r
    const html = await r.text()
    // No-op if the React shell marker isn't present (e.g. the auth-gate page).
    if (!html.includes('/chat-react.js')) {
      const headers = new Headers(r.headers)
      return new Response(html, { status: r.status, headers })
    }
    const claimScript = claimBootstrapScript()
    // Match the shell's module script tag whether or not it carries a
    // `?v=<hash>` cache-bust query — `landing/server.ts` now versions the URL
    // (ISSUES #353) so an exact-string match on the bare tag would silently
    // drop EVERY bootstrap injection (projects/onboarding/claim). Inject the
    // bootstrap scripts immediately before the tag, preserving it (query and
    // all). Function replacement so `$` in the injected JSON isn't treated as a
    // `String.replace` special pattern.
    const injected = html.replace(
      /<script type="module" src="\/chat-react\.js(?:\?v=[^"]*)?"><\/script>/,
      (tag) =>
        `${projectsBootstrapScript()}\n${onboardingBootstrapScript()}` +
        `${claimScript.length > 0 ? `\n${claimScript}` : ''}` +
        `\n${tag}`,
    )
    const headers = new Headers(r.headers)
    headers.delete('content-length')
    return new Response(injected, { status: r.status, headers })
  }

  // FIX 2 — verify + atomically claim a one-shot `?start=` token at the HTTP
  // cookie-mint gate. Returns true ONLY for the FIRST presentation of a
  // valid, unexpired, unclaimed token; every replay (bad signature, expired,
  // or already-claimed JTI) returns false so the gate refuses to mint a fresh
  // owner cookie. The `resolveKey` arg satisfies the DI verifier shape — the
  // local HMAC verifier never calls it (single owner, one shared secret).
  const claimStartToken = async (token: string): Promise<boolean> => {
    try {
      const payload = await startTokenAuth.verifyStartToken({
        token,
        resolveKey: async () => null,
      })
      await startTokenAuth.claimStartTokenJti({
        jti: payload.jti,
        expires_at_ms: payload.expires_at_ms,
        consumedTokens,
      })
      return true
    } catch {
      return false
    }
  }

  // THE ONE SANCTIONED DEDUP — the shared claim-then-mint tail. Both the SPA
  // deep-link path and the `/chat` `?start=` gate previously inlined a
  // byte-identical block here (old `:1418-1426` and `:1442-1450`), differing
  // only in the source-Response local (`spaRes` vs `res`, now the `sourceRes`
  // param). Converged onto ONE helper: claim the `?start=` JTI single-use
  // FIRST, inject the React bootstrap into the served response, and append the
  // owner Set-Cookie ONLY when the claim succeeded (cookie-mint-only-on-first-
  // claim). Behavior-identical to the two former inline blocks.
  const claimAndMintThenServe = async (
    startToken: string | null,
    sourceRes: Response | Promise<Response>,
    url: URL,
  ): Promise<Response> => {
    const minted = startToken !== null ? await claimStartToken(startToken) : false
    const r = await withReactBootstrap(sourceRes)
    const headers = new Headers(r.headers)
    if (minted) {
      headers.append('set-cookie', formatOwnerSetCookie(project_slug, cookieSecret, url))
    }
    return new Response(r.body, { status: r.status, headers })
  }

  const openFetch = (
    req: Request,
    server: import('bun').Server<unknown>,
  ): Response | Promise<Response> => {
    const url = new URL(req.url)
    const isGet = req.method === 'GET'
    const hasValidCookie =
      isGet && readSessionCookie(req, cookieSecret, Date.now()) === project_slug
    const hasStart = url.searchParams.has('start')

    // Bare root → the onboarding/chat product entry point. A valid cookie
    // bounces to /chat (where the resumable-state check below runs); a fresh
    // visitor cold-starts directly.
    if (isGet && url.pathname === '/') {
      if (hasValidCookie) {
        return new Response(null, { status: 302, headers: { location: '/chat' } })
      }
      return coldStartRedirect(url)
    }

    // Fresh /chat visit (no cookie, no token) → cold-start.
    if (isGet && url.pathname === '/chat' && !hasStart && !hasValidCookie) {
      return coldStartRedirect(url)
    }

    // Returning /chat visit WITH a valid cookie but no `?start=` token:
    // serve chat.html ONLY when there's resumable state; otherwise cold-start
    // so a valid-but-stale cookie over a fresh/wiped DB can never wedge the
    // client on the "Setting things up…" loader. The happy path (a real
    // in-progress / completed session has an `onboarding_state` row) still
    // serves chat.html and resumes via the cookie-only WS path unchanged.
    if (isGet && url.pathname === '/chat' && !hasStart && hasValidCookie) {
      return hasResumableState().then((resumable) =>
        resumable ? withReactBootstrap(landing.fetch(req, server)) : coldStartRedirect(url),
      )
    }

    // SPA client-route deep link (doc-link 404 fix) — a HARD load / share of
    // a project-scoped URL (e.g. `/projects/<id>/docs?path=…`, the P-A
    // doc-reference link). It serves the SAME chat-react shell as /chat, so it
    // needs the SAME owner cookie-mint + React-bootstrap injection: without the
    // injected `__neutron_user_id` / `__neutron_projects` the client throws
    // ChatBootstrapError and never opens the doc. A no-cookie/no-token visit
    // mints the owner cookie and bounces back to the SAME deep link
    // (preserving the doc path — unlike /chat's cold-start, which resets to
    // onboarding); the reload then carries a valid cookie and serves the
    // injected shell, which client-routes to the doc (`ProjectShell` boot-open).
    if (isGet && isSpaClientRoute(url.pathname, req.method)) {
      if (!hasValidCookie && !hasStart) {
        const headers = new Headers({ location: `${url.pathname}${url.search}` })
        headers.append('set-cookie', formatOwnerSetCookie(project_slug, cookieSecret, url))
        return new Response(null, { status: 302, headers })
      }
      const spaRes = landing.fetch(req, server)
      if (!hasValidCookie) {
        // Arrived with a `?start=` token (a shared link opened in a fresh
        // browser that already went through the mint bounce): claim it
        // single-use + mint the cookie, then inject + serve — identical to the
        // /chat `?start=` gate below (shared `claimAndMintThenServe`).
        const startToken = url.searchParams.get('start')
        return claimAndMintThenServe(startToken, spaRes, url)
      }
      return withReactBootstrap(spaRes)
    }

    // Otherwise serve via the landing server, ensuring the owner cookie is
    // set on the /chat page load so the WS reconnect path works.
    const res = landing.fetch(req, server)
    // Cookie-mint gate: a `/chat` load WITHOUT a valid cookie reaches here only
    // with a `?start=` token (the no-cookie/no-token case cold-starts above).
    // FIX 2 — make that token single-use: verify + claim its JTI and mint the
    // owner cookie ONLY on the first claim. A replayed/invalid token still
    // serves the page but mints NO cookie, so a leaked `?start=` URL can grant
    // the owner session at most once within its TTL.
    if (isGet && url.pathname === '/chat' && !hasValidCookie) {
      const startToken = url.searchParams.get('start')
      return claimAndMintThenServe(startToken, res, url)
    }
    // A /chat load WITH a valid cookie (e.g. arriving with a fresh `?start=`)
    // still needs the project bootstrap injected.
    if (isGet && url.pathname === '/chat') {
      return withReactBootstrap(res)
    }
    return res
  }

  // C5b — the unified `HttpGate` view of the owner gate. It routes to `openFetch`
  // EXACTLY the request set that invoked `openFetch` in the pre-C5b wiring, where
  // `openFetch` WAS `landing_server.fetch`: the landing rung
  // (`isLandingRoute(pathname, method, hasInvite)`) OR the SPA client-route rung
  // (`isSpaClientRoute`). Everything else falls through to `next()` (the ladder,
  // now serving the RAW landing surface). This preserves behavior byte-for-byte:
  //
  //   - `GET /chat`, isLandingRoute paths, and SPA deep links → `openFetch`
  //     (which gates `/chat` + SPA and is a pure `landing.fetch` passthrough for
  //     the rest — the ladder's raw-landing rung produces the same bytes for
  //     those passthrough paths, so it makes no difference which serves them).
  //   - `GET /?invite=<x>` → isLandingRoute('/','GET', hasInvite=true) === true
  //     → `openFetch`, whose `/` branch owner-cold-starts / bounces to `/chat`
  //     EXACTLY as on main (the landing rung matched root-with-invite there too).
  //   - bare `GET /` (no `invite`) → isLandingRoute('/','GET',false) === false
  //     and not SPA → `next()`. `openFetch`'s `/` branch stays SHADOWED/dead,
  //     identical to main (the landing rung never matched a bare root).
  //   - `/api/app/*` → neither predicate → `next()` (the app surface), which
  //     `openFetch` never handled on main.
  const gate: HttpGate = {
    apply(req, server, next): Promise<Response> {
      const url = new URL(req.url)
      const invokesOpenFetch =
        isLandingRoute(url.pathname, req.method, url.searchParams.has('invite')) ||
        isSpaClientRoute(url.pathname, req.method)
      if (invokesOpenFetch) {
        return Promise.resolve(openFetch(req, server))
      }
      return next()
    },
  }

  return { openFetch, gate }
}
