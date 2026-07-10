/**
 * @neutronai/landing — minimal HTTP + WebSocket server (P2 S2).
 *
 * Per docs/plans/P2-onboarding.md § 2.9 Path B: "P2 ships a minimal HTML
 * chat surface (raw chat.html + WebSocket on the gateway port; ~150 LOC
 * of fresh code) so that path B is functional during M2 even if the
 * polished Expo/React UI from P5 isn't done."
 *
 * This module wires the `/chat` GET handler (serving `chat.html` from
 * disk) plus the rest of the landing HTTP surface (SPA shell, brand
 * assets, /start + /recover + sign-up redirects, install-token routes).
 * Production deploys this as a Bun.serve subprocess on the instance
 * gateway host; the instance subdomain reverse-proxy config forwards
 * `<slug>.<base-domain>/chat` to this process.
 *
 * Chat itself is no longer served here: the legacy `/ws/chat` onboarding
 * socket was removed once onboarding + chat were unified onto the single
 * `/ws/app/chat` Expo-app WebSocket (see `gateway/http/app-ws-surface.ts`
 * + `open/composer.ts`). The landing server now serves the SPA + HTTP
 * routes only; the `websocket` field is a defensive close-stub kept for
 * type-compat with the gateway multiplex.
 *
 * Codex r1 P1 fix — the prior commit shipped only the static client
 * files, leaving the web sign-up path pointing at a 404. This adds the
 * server-side seam so the route is functional.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 2026-05-28 final-handoff sprint — re-export the canonical MOBILE_APP_URL
// constant so the landing surface (favicon link, OG meta, future deep-link
// route, debug pages) can reference it without duplicating the string. The
// single source of truth lives in `contracts/handoff-config.ts` (moved there
// L2, 2026-07 — critic-layering.md §2.1 edge #7 `landing → onboarding`;
// `onboarding/interview/final-handoff-config.ts`, which owns the adjacent
// prompt builders that surface the URL to the user, keeps its own re-export
// of the same leaf). A grep for the URL literal across .ts sources should
// match only that one definition — see
// `landing/__tests__/mobile-app-url-constant.test.ts` which guards the
// property.
export { MOBILE_APP_URL } from '@neutronai/contracts/handoff-config.ts'

import { renderMobileInstallHtml } from './mobile-install-config.ts'
import { isSpaClientRoute } from './spa-routes.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Sprint 26 r2 (Argus MINOR fix) — build the CSP header for the
 * Telegram onboarding landing page from SHA-256 hashes of every inline
 * `<script>` and `<style>` block in the HTML payload. Hashes let us
 * keep the inline blocks (the page is fully self-contained — useful
 * for static-CDN deploys) while still dropping `'unsafe-inline'` so a
 * future XSS-injected `<script>` is rejected by the browser.
 *
 * Order-insensitive: hash digests are content-addressed; the browser
 * matches against the set of declared hashes regardless of source
 * position. Multiple blocks of the same type are supported.
 */
function buildOnboardingTelegramCsp(html: string): string {
  const scriptHashes = collectInlineHashes(html, 'script')
  const styleHashes = collectInlineHashes(html, 'style')
  const scriptDirective = ["'self'", ...scriptHashes].join(' ')
  const styleDirective = ["'self'", ...styleHashes].join(' ')
  return [
    "default-src 'self'",
    `script-src ${scriptDirective}`,
    `style-src ${styleDirective}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

function collectInlineHashes(html: string, tag: 'script' | 'style'): string[] {
  // The static landing HTML uses bare `<script>` / `<style>` opens (no
  // attributes). We deliberately do NOT match tags with attributes —
  // any future tag with `src=` / `href=` is fetched by URL and
  // covered by `'self'`, not the inline-hash whitelist. Inline blocks
  // with attributes (e.g. `<script type="module">`) would need a
  // schema bump here; flag at PR review time.
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const body = match[1] ?? ''
    const digest = createHash('sha256').update(body, 'utf8').digest('base64')
    out.push(`'sha256-${digest}'`)
  }
  return out
}

export type {
  ChatOutbound,
  AgentMessageOutbound,
  AgentAckOutbound,
  RedirectOutbound,
  SlugRenamedOutbound,
  AgentTypingStartOutbound,
  AgentTypingEndOutbound,
  ErrorOutbound,
  TopicSwitchedOutbound,
  SessionReadyOutbound,
  ImportProgressOutbound,
} from './chat-protocol.ts'

export interface LandingServerOptions {
  /** Directory containing `chat.html` + compiled `chat.js`. */
  static_dir?: string
  /**
   * C2 (OSS split) — directory containing the workspace-invite assets
   * (`invite.html` + `invite.ts`). The invite flow is Managed-tier
   * machinery; its assets relocated out of the Open `landing/` package,
   * so the Managed boot wrapper points this at their new home. Defaults
   * to `static_dir` (back-compat: a dir that carries all assets
   * together). When the files are absent the invite routes self-disable
   * (existsSync-guarded), which is the Open self-host default.
   */
  invite_assets_dir?: string
  /** Port to listen on; production wires to the per-instance gateway port. */
  port?: number
  /** Optional hostname; defaults to '0.0.0.0' for ipv4 binding. */
  hostname?: string
  /**
   * Codex r9 P1 fix: the landing CTAs link to `/api/v1/sign-up?via=tg|web`.
   * The identity service owns OAuth start; this option lets the landing
   * server 302-redirect those CTAs to the identity URL so the public
   * deploy is functional out of the box. When unset, /api/v1/sign-up
   * returns 503 with a clear "identity_oauth_url not configured"
   * message so ops can spot the missing config quickly.
   *
   * The function receives the original `via` query param (`tg` or
   * `web`) and returns the absolute identity OAuth start URL with
   * `?via=...` appended. Production wires this to e.g.
   * `https://<auth-host>/oauth/google/start`.
   */
  resolveSignupRedirect?: (input: { via: 'tg' | 'web' }) => string
  /**
   * P2 S5 — POST /onboarding/invite-accept handler.
   *
   * Codex r2 P1 fix: `landing/invite.ts` posts the user's accept tap
   * to `/onboarding/invite-accept`. Without this hook the landing
   * server 404s the POST and the invite page is functionally broken.
   *
   * When set, the landing server routes POST /onboarding/invite-accept
   * to this handler. The handler is responsible for parsing
   * `{ invite_token: string }` from the body, threading the
   * authenticated session (accepter_user_id + accepter_email +
   * accepter_user_instance_slug) from the gateway's session cookie,
   * and returning a JSON `InviteAcceptResponseShape` body.
   *
   * When unset the route returns 503 with a clear
   * "invite_accept_handler not configured" message so ops can spot
   * the gap (mirrors `resolveSignupRedirect`'s pattern).
   */
  inviteAcceptHandler?: (req: Request) => Promise<Response>
  /**
   * Anthropic Max one-liner installer — handler for the four
   * install-token routes (`/install-token`, `/install/<id>.sh`,
   * `/api/v1/install-token-callback`, `/api/v1/install-token-status`).
   *
   * The dispatcher returns a `Response` if the request matched one
   * of those routes, or `null` if not. We delegate at the top of
   * `fetch()` so the install-token surface 200s before the static
   * `/chat` / `/onboarding/telegram` / wildcard 404 fallback runs.
   *
   * When unset, the install-token surface is unmounted entirely —
   * the boot script wires it only when the identity-service URL +
   * shared secret are both configured.
   */
  installTokenHandler?: (req: Request) => Promise<Response | null>
  /**
   * S17 (2026-05-17) — `GET /recover` handler. Mounted on the per-
   * instance gateway so a same-origin /recover fetch from chat.ts after
   * a post-slug-rename WS disconnect lands on a handler that can mint
   * a fresh start-token bound to the CURRENT slug.
   *
   * Without this, the per-instance gateway returns 404 and the chat
   * client surfaces "disconnected. refresh to continue." instead of
   * silently reconnecting via the 302 → /chat?start=<fresh> flow
   * implemented by `signup/recover-handler.ts:handleRecover`.
   *
   * The per-instance gateway's prod composer (`gateway/index.ts`) wires
   * a closure that calls `handleRecover(req, …)` against the platform
   * instances registry + identity DB. Optional — gateways that don't
   * configure identity-service access leave this unset and the route
   * 404s through the default chain (parity with the platform proxy's
   * 503-when-unwired behaviour: the chat client falls back to a
   * manual-refresh hint either way).
   */
  recoverHandler?: (req: Request) => Promise<Response>
  /**
   * 2026-05-27 persistent-session-cookie sprint (Part B) — resolve the
   * cookie-authenticated user's identity for a chat upgrade that
   * arrives with only a session cookie (no `?start=` token). Returns
   * the cookie's `project_slug` + the owner's `user_id` when the cookie
   * is valid for THIS gateway's instance; returns `null` when the cookie
   * is missing, malformed, expired, signed with the wrong secret, OR
   * binds a different instance slug.
   *
   * The optional `set_cookie` is a pre-formatted `Set-Cookie` header
   * value (e.g. `__neutron_chat_session=…; HttpOnly; Secure;
   * SameSite=Lax; Path=/; Max-Age=2592000`) emitted on the 101
   * upgrade response so cookie-only WS upgrades roll the session-
   * cookie expiry forward in lockstep with HTTP-side sliding refresh
   * from `landing/auth-gate.ts`.
   *
   * Production wires this against the platform instances registry +
   * `signSessionCookie` / `readSessionCookie` from
   * `landing/session-cookie.ts` (same shape as `mintStartToken`
   * on `auth_gate`). Optional — when unset, cookie-only WS upgrades
   * 400 the same way a missing-start-token request does, preserving
   * back-compat for dev / smoke deploys that don't wire identity.
   *
   * Precedence: `?start=<jwt>` ALWAYS wins. The cookie hook is only
   * consulted when no start-token query param is present, so a
   * mixed-auth request (cookie + token) walks the existing token path
   * untouched.
   */
  cookieToUserClaim?: (req: Request) => Promise<{
    project_slug: string
    user_id: string
    set_cookie?: string
  } | null>
  /**
   * ISSUES #318 (2026-06-21) — Open self-host Claude-auth gate (defense in
   * depth for the installer gate). When provided AND `isUnauthenticated()`
   * returns true, a `GET /chat` serves the "Authenticate Claude to continue"
   * page instead of the chat shell — so a box booted with NO Claude substrate
   * credential (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` both unset)
   * never presents an interactive-looking chat that silently produces nothing.
   *
   * `isUnauthenticated` is evaluated per request (a closure over the live
   * environment) so a restart that finally has the token clears the gate
   * without rebuilding the server. Managed leaves this UNSET — its substrate is
   * per-user Max OAuth / BYO key resolved elsewhere, not from this process's
   * env — so the gate is inert there and `GET /chat` serves the shell as before.
   */
  chatAuthGate?: {
    isUnauthenticated: () => boolean
  }
}

/**
 * Returned by `createLandingServer`: the `{ fetch, websocket }` pair the
 * caller plugs into Bun.serve (or composes into a per-instance gateway). A
 * named export so the realmode-composer factory can declare its return
 * type without `ReturnType<typeof createLandingServer>` magic (TS
 * reviewer Sprint 19 P3 recommendation).
 */
export interface LandingServer {
  fetch: (req: Request, server: import('bun').Server<unknown>) => Response | Promise<Response>
  websocket: import('bun').WebSocketHandler<unknown>
}

/**
 * AUTH-CORRECTION (Ryan-locked 2026-06-28) — the Open Claude-Max OAuth handoff
 * page served at `GET /chat` when the box has no working Claude credential AND
 * no ambient Keychain login (`resolveOpenLlmPool(env) === null`). This is the
 * DEFAULT first onboarding screen: a FUNCTIONAL handoff, not the dead 503 that
 * only printed manual instructions.
 *
 * On load the inline script `POST`s `/oauth/max/install-token/initiate` to mint
 * a one-liner (`curl … | bash`) that installs the `claude` CLI, runs
 * `claude setup-token`, and POSTs the captured `sk-ant-oat…` token back to
 * `/complete` — which persists it to `.env` and restarts Neutron so the
 * substrate comes up LIVE. The page polls `GET /chat` for the
 * 503 → (restart) → 200 transition and auto-advances into onboarding. A manual
 * `claude setup-token` → paste box is the secondary path; the static "add to
 * `.env` + restart" copy is the final fallback if the handoff routes are
 * unmounted (e.g. a Managed deploy that hasn't wired its handler).
 *
 * The Keychain fast-path (#101) sits ABOVE this in `resolveOpenLlmPool`: when
 * the owner already has an ambient `claude` login, the gate never renders.
 *
 * Self-contained: one inline `<style>` + one DETERMINISTIC inline `<script>`
 * (no `signup_id` baked in — it's fetched at runtime), so `chatAuthGateCsp()`
 * can pin the script with a `sha256-` hash and the page needs no external asset.
 */
const CHAT_AUTH_GATE_SCRIPT = `(function(){
  var PFX='/oauth/max/install-token';
  var signupId=null,activating=false,activeTicks=0;
  var MAX_ACTIVATING_TICKS=30; // ~60s at 2s/poll before we surface a manual fallback
  function $(id){return document.getElementById(id)}
  function setStatus(t){var s=$('ng-status');if(s)s.textContent=t}
  function setManual(t){var m=$('ng-manual-status');if(m)m.textContent=t}
  function show(id,on){var e=$(id);if(e)e.style.display=on?'':'none'}
  function fail(msg){activating=false;setStatus(msg);var d=$('ng-manual-details');if(d)d.open=true}
  // Primary navigation trigger: poll GET /chat for the 503 -> (restart) -> 200
  // transition. This is robust across the restart that WIPES the in-memory
  // store — we never rely on catching the brief 'completed' window before the
  // process exits. /state is consulted only for nicer messaging.
  function tick(){
    fetch('/chat',{cache:'no-store',redirect:'manual'}).then(function(r){
      if(r.status===200){location.href='/chat';return} // authed process is live
      if(activating){
        if(++activeTicks>MAX_ACTIVATING_TICKS){fail('Restart did not finish. Paste your token below, or run \\u0060neutron restart\\u0060 and reload.');return}
        setStatus('Connected — restarting Neutron…');
        setTimeout(tick,2000);return;
      }
      if(signupId){
        fetch(PFX+'/state?signup_id='+encodeURIComponent(signupId),{cache:'no-store'})
          .then(function(s){return s.ok?s.json():{status:(s.status===404?'gone':'err')}})
          .then(function(j){
            // 'gone' (404) for a signup_id WE hold means the store was wiped by
            // the restart — treat it as completion and switch to the /chat watch.
            if(j.status==='completed'||j.status==='gone'){activating=true;activeTicks=0;setStatus('Connected — restarting Neutron…')}
            else if(j.status==='expired'){init()}
            else setStatus('Run the command above in your terminal — this page advances automatically.')
          }).catch(function(){}).then(function(){setTimeout(tick,2000)});
        return;
      }
      setTimeout(tick,2000);
    }).catch(function(){
      // Connection refused: the server is mid-restart (or, un-supervised, gone).
      activating=true;
      if(++activeTicks>MAX_ACTIVATING_TICKS){fail('Neutron is not responding. If it does not come back, run \\u0060neutron restart\\u0060.');return}
      setStatus('Almost there — Neutron is restarting…');
      setTimeout(tick,2000);
    });
  }
  function init(){
    activating=false;activeTicks=0;
    fetch(PFX+'/initiate',{method:'POST',cache:'no-store'})
      .then(function(r){return r.ok?r.json():null})
      .then(function(j){
        if(!j||!j.signup_id){show('ng-auto',false);return}
        signupId=j.signup_id;
        var c=$('ng-cmd');if(c)c.textContent=j.command;
        show('ng-auto',true);
        setStatus('Run the command above in your terminal — this page advances automatically.');
      }).catch(function(){show('ng-auto',false)});
  }
  var copy=$('ng-copy');
  if(copy)copy.addEventListener('click',function(){
    var t=($('ng-cmd')||{}).textContent||'';
    if(navigator.clipboard)navigator.clipboard.writeText(t);
    copy.textContent='Copied';setTimeout(function(){copy.textContent='Copy'},1500);
  });
  var man=$('ng-manual-submit');
  if(man)man.addEventListener('click',function(){
    var ta=$('ng-token'),tok=((ta&&ta.value)||'').trim();
    if(!/^sk-ant-oat[0-9]{2}-/.test(tok)){setManual('That does not look like a setup-token (starts with sk-ant-oat…).');return}
    if(!signupId){setManual('Still preparing — try again in a moment.');return}
    setManual('Activating…');
    fetch(PFX+'/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({signup_id:signupId,token:tok})})
      .then(function(r){if(r.status===204||r.status===200){activating=true;activeTicks=0;setStatus('Connected — restarting Neutron…')}else{setManual('Token rejected (HTTP '+r.status+'). Check it and retry.')}})
      .catch(function(){setManual('Could not reach Neutron. Retry.')});
  });
  init();
  setTimeout(tick,1500);
})();`

export function renderChatAuthGateHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Authenticate Claude — Neutron</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #e6e6f0; background: #0e0e16;
  }
  .card {
    max-width: 560px; width: 100%; background: #16161f;
    border: 1px solid #2a2a3a; border-radius: 14px; padding: 32px;
  }
  h1 { margin: 0 0 6px; font-size: 20px; color: #fff; }
  p.lead { margin: 0 0 20px; color: #a6a6c0; }
  ol { margin: 0 0 12px; padding-left: 20px; }
  li { margin: 0 0 14px; }
  code, .cmd {
    display: block; margin-top: 6px; padding: 10px 12px; border-radius: 8px;
    background: #0a0a12; border: 1px solid #2a2a3a; color: #7cf;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    word-break: break-all; white-space: pre-wrap;
  }
  .row { display: flex; gap: 8px; align-items: flex-start; margin-top: 8px; }
  .row .cmd { flex: 1; margin-top: 0; }
  button {
    cursor: pointer; border-radius: 8px; border: 1px solid #2a2a3a;
    background: #23233a; color: #e6e6f0; padding: 9px 14px; font-size: 13px;
  }
  button:hover { background: #2c2c47; }
  .status { margin: 14px 0 0; color: #8fd; font-size: 13px; min-height: 18px; }
  textarea {
    width: 100%; margin-top: 8px; padding: 10px 12px; border-radius: 8px;
    background: #0a0a12; border: 1px solid #2a2a3a; color: #e6e6f0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    min-height: 64px; resize: vertical;
  }
  details { margin-top: 18px; border-top: 1px solid #2a2a3a; padding-top: 14px; }
  summary { cursor: pointer; color: #a6a6c0; font-size: 14px; }
  .alt { color: #a6a6c0; font-size: 13px; margin: 12px 0 0; }
  .foot { color: #6f6f88; font-size: 13px; border-top: 1px solid #2a2a3a;
          margin-top: 18px; padding-top: 16px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
         background: #f0a020; margin-right: 8px; vertical-align: middle; }
</style>
</head>
<body>
  <main class="card">
    <h1><span class="dot"></span>Authenticate Claude to continue</h1>
    <p class="lead">Neutron runs on your Claude account. Connect it once to start —
       this takes about a minute and stays on your machine.</p>

    <div id="ng-auto" style="display:none">
      <p>In a terminal on this machine, run:</p>
      <div class="row">
        <code class="cmd" id="ng-cmd">preparing…</code>
        <button id="ng-copy" type="button">Copy</button>
      </div>
      <p class="status" id="ng-status">Preparing your install command…</p>
    </div>

    <details id="ng-manual-details">
      <summary>Prefer to do it by hand?</summary>
      <ol>
        <li>Run <code>claude setup-token</code> — it opens a browser and prints a
            token (<code>sk-ant-oat…</code>).</li>
        <li>Paste the token here to activate without restarting by hand:
          <textarea id="ng-token" placeholder="sk-ant-oat…" spellcheck="false"></textarea>
          <div class="row"><button id="ng-manual-submit" type="button">Activate</button></div>
          <p class="status" id="ng-manual-status"></p>
        </li>
      </ol>
      <p class="alt">Or set <code>CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat…</code> (or
         <code>ANTHROPIC_API_KEY=sk-ant-…</code> for API billing) in your
         <code>.env</code> and restart Neutron.</p>
    </details>

    <p class="foot">Neutron spawns the <code>claude</code> CLI as its LLM substrate —
       it never calls api.anthropic.com directly.</p>
  </main>
  <script>${CHAT_AUTH_GATE_SCRIPT}</script>
</body>
</html>`
}

/**
 * CSP for the auth-gate page: pin the one deterministic inline `<script>` with a
 * `sha256-` hash (no `'unsafe-inline'` for scripts), allow the inline `<style>`,
 * and permit same-origin `fetch` to the install-token routes. Computed once.
 */
export function chatAuthGateCsp(): string {
  const hash = createHash('sha256').update(CHAT_AUTH_GATE_SCRIPT, 'utf8').digest('base64')
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'sha256-${hash}'`,
    "connect-src 'self'",
  ].join('; ')
}

/**
 * ISSUES #353 — strong content ETag for a served asset's bytes. Pure + total;
 * used to cache-bust `/chat-react.js` (see `resolveChatReactJs`'s caller in
 * `createLandingServer`): the response carries `cache-control: no-cache`
 * (always revalidate) plus this ETag, so the browser must round-trip a
 * conditional GET on every load — a redeploy that changed the bundle's bytes
 * gets a fresh 200 with the new code instead of silently replaying a stale
 * cached copy from a prior `max-age`-cached response (the "work pane empty
 * until a manual hard-refresh" bug). Unchanged bytes still get a cheap 304 (no
 * re-download). Quoted per RFC 9110 — ETag values are a DQUOTE-wrapped opaque
 * string, compared byte-for-byte against `if-none-match`.
 */
export function computeAssetEtag(bytes: string): string {
  return `"sha256-${createHash('sha256').update(bytes, 'utf8').digest('hex')}"`
}

/**
 * ISSUES #353 (Codex r1 P2) — RFC 9110 §13.1.2 `If-None-Match` evaluation.
 * `*` matches any current representation; otherwise the header is a
 * comma-separated LIST of validators and matches if ANY member equals our ETag
 * (a browser can legitimately send `"a", "b"`). `If-None-Match` uses WEAK
 * comparison, so an optional `W/` prefix is stripped before comparing — though
 * our ETag is strong and self-issued (clients echo it verbatim). Being
 * over-strict here only costs a missed 304 (a fresh 200 is still correct bytes),
 * never a staleness bug — but honoring the list/`*` forms keeps the cache
 * behavior spec-correct.
 */
export function ifNoneMatchSatisfied(header: string | null, etag: string): boolean {
  if (header === null) return false
  const h = header.trim()
  if (h === '') return false
  if (h === '*') return true
  const norm = (t: string): string => t.trim().replace(/^W\//, '')
  const want = norm(etag)
  return h.split(',').some((token) => norm(token) === want)
}

/**
 * Bun.serve handler that surfaces the landing `/chat` (HTTP) SPA shell
 * plus the rest of the landing HTTP routes. Chat moved to the unified
 * `/ws/app/chat` Expo-app socket, so this server no longer upgrades a
 * websocket; the `websocket` field is a defensive close-stub. Caller is
 * responsible for SIGTERM handling + graceful shutdown — the returned
 * `stop()` closes the server.
 */
export function createLandingServer(options: LandingServerOptions): LandingServer {
  const static_dir = options.static_dir ?? HERE
  // P0b (2026-06-26) — React/assistant-ui is the ONLY web chat client. The
  // vanilla `chat.html`/`chat.ts` surface and the `NEUTRON_WEB_CHAT_CLIENT`
  // flag were DELETED (Ryan-locked: no feature flags, no dual code paths), so a
  // fresh single-owner Open install always serves the tabbed React shell
  // (ProjectShell → ChatApp with the Documents/Tasks tabs) at `/chat`.
  //
  // `chat-react.html` is the shell (loads `/chat-react.js`); the JS is either a
  // pre-built `chat-react.js` next to it or lazily bundled from
  // `chat-react/main.tsx` on first request (minified — it carries React +
  // assistant-ui). The shell is REQUIRED: a single-owner Open install always
  // ships it, so its absence is a packaging error (throw at boot), NOT a
  // silent fall-back to a now-nonexistent vanilla client.
  const chat_react_html_path = join(static_dir, 'chat-react.html')
  if (!existsSync(chat_react_html_path)) {
    throw new Error(`landing static_dir missing chat-react.html: ${chat_react_html_path}`)
  }
  const chat_react_html = readFileSync(chat_react_html_path)
  const chat_react_js_prebuilt_path = join(static_dir, 'chat-react.js')
  let chat_react_js_cache: string | null = existsSync(chat_react_js_prebuilt_path)
    ? readFileSync(chat_react_js_prebuilt_path, 'utf8')
    : null
  const chat_react_entry_path = join(static_dir, 'chat-react', 'main.tsx')
  // P2 S5 — invite landing short-circuit. Optional: callers that haven't
  // wired the invite handler yet skip the route entirely so the existing
  // /chat surface stays untouched. C2 (OSS split): the invite assets are
  // Managed-tier and live outside this package — resolved via
  // `invite_assets_dir`, defaulting to `static_dir` for back-compat.
  const invite_assets_dir = options.invite_assets_dir ?? static_dir
  const invite_html_path = join(invite_assets_dir, 'invite.html')
  const invite_html: Buffer | null = existsSync(invite_html_path) ? readFileSync(invite_html_path) : null
  // Sprint 26 — Telegram onboarding landing page. The identity service
  // 302s telegram-signup users here after OAuth completes; the page
  // renders an "Open Telegram to continue" deeplink button targeting
  // the per-instance bot. Ships as a static file so the platform-landing
  // process can serve it without any additional wiring; absent file
  // means the route 404s through the default fallback (dev / pre-Sprint-26
  // deploys with no bot pool configured).
  const onboarding_telegram_path = join(static_dir, 'onboarding-telegram.html')
  const onboarding_telegram_html: Buffer | null = existsSync(onboarding_telegram_path)
    ? readFileSync(onboarding_telegram_path)
    : null
  // Sprint 26 r2 (Argus MINOR fix) — drop `'unsafe-inline'` from the
  // landing's CSP by precomputing SHA-256 hashes of the page's inline
  // <script> and <style> blocks at load time. Hashes are stable across
  // process restarts (HTML is a versioned static file) and the CSP
  // header is built once and cached.
  const onboarding_telegram_csp: string | null =
    onboarding_telegram_html !== null
      ? buildOnboardingTelegramCsp(onboarding_telegram_html.toString('utf8'))
      : null
  const invite_js_prebuilt_path = join(invite_assets_dir, 'invite.js')
  let invite_js_cache: string | null = existsSync(invite_js_prebuilt_path)
    ? readFileSync(invite_js_prebuilt_path, 'utf8')
    : null
  const invite_ts_path = join(invite_assets_dir, 'invite.ts')
  // ISSUES #208 — `/mobile` install page. The wow handoff's "Get the
  // mobile app" button points at `MOBILE_APP_URL` (the `/mobile` path on
  // the apex domain); the apex is served by the signup-landing process
  // which delegates here, so loading the page in THIS shared route table
  // makes the existing URL resolve on BOTH surfaces (apex + per-instance
  // subdomains) with no Caddy change — and retroactively fixes the dead
  // links in already-delivered handoff messages. Store links are rendered server-side at construction from
  // `mobile-install-config.ts` (empty constants → greyed coming-soon;
  // filled → live anchors). Absent file falls through to the default
  // 404 like the other optional static pages.
  const mobile_html_path = join(static_dir, 'mobile.html')
  const mobile_html: Buffer | null = existsSync(mobile_html_path)
    ? Buffer.from(renderMobileInstallHtml(readFileSync(mobile_html_path, 'utf8')), 'utf8')
    : null
  // ISSUES #208 — PWA/brand assets on the per-instance surface. The
  // signup-landing boot script serves these from its own allowlist
  // (landing/boot.ts), but the per-instance gateway previously served
  // NOTHING for them, so chat.html could not link a manifest or icons —
  // Add-to-Home-Screen on `<slug>.<base>/chat` produced an icon-less
  // screenshot shortcut. Same literal-match allowlist shape as boot.ts
  // (no path traversal). Missing files fall through to the default 404.
  const brand_assets = new Map<string, { body: Buffer; type: string }>()
  for (const [route, file, type] of [
    ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
    ['/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'],
    ['/site.webmanifest', 'site.webmanifest', 'application/manifest+json'],
  ] as const) {
    const p = join(static_dir, file)
    if (existsSync(p)) brand_assets.set(route, { body: readFileSync(p), type })
  }
  async function resolveChatReactJs(): Promise<string | null> {
    if (chat_react_js_cache !== null) return chat_react_js_cache
    if (!existsSync(chat_react_entry_path)) return null
    try {
      const result = await Bun.build({
        entrypoints: [chat_react_entry_path],
        target: 'browser',
        format: 'esm',
        // Minified: the bundle carries React + ReactDOM + assistant-ui +
        // chat-core (~0.6 MB minified). Cached after the first build.
        minify: true,
        sourcemap: 'none',
      })
      if (!result.success || result.outputs.length === 0) return null
      const out = result.outputs[0]
      if (out === undefined) return null
      chat_react_js_cache = await out.text()
      return chat_react_js_cache
    } catch {
      return null
    }
  }
  // ISSUES #353 — the ETag is derived from the resolved bundle bytes, which are
  // themselves cached for the process lifetime (`chat_react_js_cache` above is
  // set once, either from the prebuilt file or the first `Bun.build`), so the
  // hash only needs computing once per process too.
  let chat_react_js_etag: string | null = null
  function getChatReactJsEtag(js: string): string {
    if (chat_react_js_etag === null) chat_react_js_etag = computeAssetEtag(js)
    return chat_react_js_etag
  }
  // ISSUES #353 (Codex r1 blocker) — the ETag + `no-cache` only bust the cache
  // AFTER the browser revalidates. But the current prod serves `/chat-react.js`
  // with `max-age=86400` under an UNVERSIONED URL, so a client (or proxy) that
  // still holds a fresh copy replays the STALE bundle from cache without ever
  // hitting the server — the `no-cache` headers never run, and the stale code
  // persists up to a day post-deploy. Fix = version the URL: inject a short
  // content id into the shell's `<script src>` so the cache KEY changes the
  // instant the bytes change, bypassing any stale entry cached under the bare
  // URL. `chat_react_js_cache` is populated at construction from the prebuilt
  // bundle in a real install, so the shell is always versioned in prod; the dev
  // lazy-build path is null until the first `/chat-react.js` request, so its
  // first shell load is unversioned (harmless — the JS `no-cache`+ETag still
  // guarantees correctness) and every subsequent load is versioned.
  const chat_react_html_str = chat_react_html.toString('utf8')
  let chat_react_html_versioned: string | null = null
  async function getVersionedChatReactShell(): Promise<string> {
    if (chat_react_html_versioned !== null) return chat_react_html_versioned
    // RESOLVE the bundle before serving so the URL is versioned even on the
    // lazy-build path's very FIRST /chat (Codex r3): otherwise that first shell
    // ships the bare URL and a stale cross-deploy cache is replayed. In a real
    // install `chat_react_js_cache` is already populated (prebuilt at
    // construction) so this is a cheap cache hit; lazy-dev builds once here.
    const js = await resolveChatReactJs()
    if (js === null) return chat_react_html_str // packaging error — /chat-react.js 404s anyway
    const version = createHash('sha256').update(js, 'utf8').digest('hex').slice(0, 12)
    chat_react_html_versioned = chat_react_html_str.replace(
      'src="/chat-react.js"',
      `src="/chat-react.js?v=${version}"`,
    )
    return chat_react_html_versioned
  }
  async function resolveInviteJs(): Promise<string | null> {
    if (invite_js_cache !== null) return invite_js_cache
    if (!existsSync(invite_ts_path)) return null
    try {
      const result = await Bun.build({
        entrypoints: [invite_ts_path],
        target: 'browser',
        format: 'esm',
        minify: false,
        sourcemap: 'none',
      })
      if (!result.success || result.outputs.length === 0) return null
      const out = result.outputs[0]
      if (out === undefined) return null
      invite_js_cache = await out.text()
      return invite_js_cache
    } catch {
      return null
    }
  }
  return {
    async fetch(req, server): Promise<Response> {
      const url = new URL(req.url)
      // Anthropic Max one-liner installer surface (install-token).
      // The handler returns null on miss so the rest of this fetch
      // chain runs unaffected; matched routes return their Response.
      if (options.installTokenHandler !== undefined) {
        const installTokenRes = await options.installTokenHandler(req)
        if (installTokenRes !== null) return installTokenRes
      }
      // S17 (2026-05-17) — /recover dispatch. Mounted ahead of /chat so
      // a same-origin /recover fetch from chat.ts (post-slug-rename WS
      // disconnect on the per-instance subdomain) reaches the handler
      // before any of the catch-all branches. See
      // `signup/recover-handler.ts:handleRecover` for the contract.
      if (
        url.pathname === '/recover' &&
        req.method === 'GET' &&
        options.recoverHandler !== undefined
      ) {
        return options.recoverHandler(req)
      }
      // 2026-05-22 — `/start?token=` (or `?start=` legacy) lands on the
      // per-instance gateway when a returning user signed in via the
      // identity service: `identity/main.ts:onReturningWebSignin` builds
      // a per-instance deep link once the owner has picked a real URL
      // slug (`url_slug !== internal_handle`) so the user lands on
      // `<slug>.<apex>` from the first hop instead of the shared
      // `chat.<apex>` host. The token IS the auth gate (validated by
      // `/chat`'s `validateStartToken` immediately downstream); this
      // handler is a thin URL rewrite that keeps the deep-link shape
      // symmetric with `landing/onboarding-chat-proxy.ts:457-482`.
      //
      // Debug + import-source params pass through so the destination
      // `/chat?start=...` page's chat.html bootstrap can re-enable
      // debug mode + import affordances (URL-only propagation per
      // Codex T13 r13 P3).
      if (url.pathname === '/start' && req.method === 'GET') {
        const token = url.searchParams.get('token') ?? url.searchParams.get('start') ?? ''
        if (token.length === 0) {
          return new Response('missing start token', { status: 400 })
        }
        const dest = new URL('/chat', `${url.protocol}//${url.host}`)
        dest.searchParams.set('start', token)
        for (const key of ['debug', 'import']) {
          const v = url.searchParams.get(key)
          if (v !== null) dest.searchParams.set(key, v)
        }
        return new Response(null, {
          status: 302,
          headers: { location: `${dest.pathname}${dest.search}` },
        })
      }
      // Serve the chat-react SPA shell (or the Claude-auth gate page when no
      // substrate credential is present). Shared by `GET /chat` and the SPA
      // client-route catch-all below so a hard-loaded deep link boots the same
      // shell + honours the same auth gate as `/chat`.
      async function serveChatReactShell(): Promise<Response> {
        // ISSUES #318 — app-level Claude-auth gate. A box with no working
        // substrate credential would render an interactive-looking chat that
        // silently produces nothing; show a clear "authenticate Claude" page
        // instead. Evaluated per request so a restart-with-token clears it.
        if (options.chatAuthGate?.isUnauthenticated() === true) {
          return new Response(renderChatAuthGateHtml(), {
            // 503: the chat surface is intentionally unavailable until a
            // credential is present (not a 200 "here's your chat" lie, not a
            // 404 "no such page"). Browsers render the HTML body regardless.
            // The page is the FUNCTIONAL Claude-Max OAuth handoff — its inline
            // script drives `/oauth/max/install-token/*` to capture a token and
            // auto-advance; the CSP pins that script by hash.
            status: 503,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'content-security-policy': chatAuthGateCsp(),
            },
          })
        }
        // P0b — React is the only client. Always serve the tabbed React shell
        // (no flag, no `?client=` branch, no vanilla fallback). The shell is
        // loaded + asserted at construction, so this is unconditional.
        // ISSUES #353 — serve the version-injected shell, and `no-store` it so a
        // stale-cached shell can't defeat the `?v=` bust by pointing at an old
        // bundle URL. The shell is a tiny dynamic, auth-gated app frame; not
        // caching it costs nothing and is what makes the URL versioning airtight.
        return new Response(await getVersionedChatReactShell(), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      if (url.pathname === '/chat' && req.method === 'GET') {
        return await serveChatReactShell()
      }
      // Serve the lazily-bundled React client. Returns 404 only on a packaging
      // error (the `chat-react/main.tsx` entry missing) — the shell that
      // references `/chat-react.js` is required at boot, so in a real install
      // this always resolves.
      if (url.pathname === '/chat-react.js' && req.method === 'GET') {
        const js = await resolveChatReactJs()
        if (js === null) return new Response('chat-react.js unavailable', { status: 404 })
        // ISSUES #353 — cache-bust the bundle. No `max-age` (so the browser
        // always revalidates) + a strong content ETag: unchanged bytes round-trip
        // a cheap 304, but the instant a redeploy changes the bundle the ETag
        // changes with it and the very next load gets the new bytes — no stale
        // cache, no manual hard-refresh required.
        const etag = getChatReactJsEtag(js)
        const headers = {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-cache',
          etag,
        }
        if (ifNoneMatchSatisfied(req.headers.get('if-none-match'), etag)) {
          return new Response(null, { status: 304, headers })
        }
        return new Response(js, { headers })
      }
      // ISSUES #208 — mobile install/landing page (see construction note).
      if (mobile_html !== null && url.pathname === '/mobile' && req.method === 'GET') {
        return new Response(new Uint8Array(mobile_html), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      // ISSUES #208 — PWA/brand assets (manifest + icons) so the
      // per-instance chat surface is installable. Mirrors boot.ts headers.
      if (req.method === 'GET') {
        const asset = brand_assets.get(url.pathname)
        if (asset !== undefined) {
          return new Response(new Uint8Array(asset.body), {
            headers: {
              'content-type': asset.type,
              'cache-control': 'public, max-age=86400',
            },
          })
        }
      }
      if (url.pathname === '/api/v1/sign-up' && req.method === 'GET') {
        // Codex r9 P1: redirect the landing CTA to the identity OAuth
        // start URL. Without `resolveSignupRedirect` configured, ops
        // sees a clear 503 instead of a silent 404.
        if (options.resolveSignupRedirect === undefined) {
          return new Response(
            'identity_oauth_url not configured. Set resolveSignupRedirect on LandingServerOptions.',
            { status: 503 },
          )
        }
        // Argus follow-up: accept long-form `via=telegram` (the canonical
        // shape that `identity/service.ts:readSignupVia` already accepts)
        // alongside the short `via=tg`. Direct deeplinks or future deploys
        // using `?via=telegram` would otherwise silently fall through to
        // the web flow, sending Telegram users to the wrong surface.
        const via_raw = url.searchParams.get('via') ?? ''
        const via: 'tg' | 'web' =
          via_raw === 'tg' || via_raw === 'telegram' ? 'tg' : 'web'
        const target = options.resolveSignupRedirect({ via })
        return new Response(null, {
          status: 302,
          headers: { location: target },
        })
      }
      if (
        invite_html !== null &&
        (url.pathname === '/invite' || url.pathname === '/') &&
        req.method === 'GET' &&
        url.searchParams.has('invite')
      ) {
        return new Response(new Uint8Array(invite_html), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      // Sprint 26 — Telegram landing: a friendly HTML page with an
      // "Open Telegram" deeplink button. Identity 302s
      // here with the bot, signin_event_id, and slug params. The page
      // reads those params client-side to build the t.me deeplink.
      if (
        onboarding_telegram_html !== null &&
        url.pathname === '/onboarding/telegram' &&
        req.method === 'GET'
      ) {
        return new Response(new Uint8Array(onboarding_telegram_html), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            // Defense-in-depth: the page uses one inline <script> +
            // one inline <style> block to build the deeplink from
            // query params. Sprint 26 r2 (Argus MINOR fix) replaces
            // `'unsafe-inline'` with SHA-256 hashes of the actual
            // block bodies so an XSS-injected <script> would be
            // rejected by the browser even if the query whitelist
            // were bypassed.
            'content-security-policy':
              onboarding_telegram_csp ??
              "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
          },
        })
      }
      if (url.pathname === '/invite.js' && req.method === 'GET') {
        const js = await resolveInviteJs()
        if (js === null) return new Response('invite.js unavailable', { status: 404 })
        return new Response(js, {
          headers: { 'content-type': 'application/javascript; charset=utf-8' },
        })
      }
      if (url.pathname === '/onboarding/invite-accept' && req.method === 'POST') {
        if (options.inviteAcceptHandler === undefined) {
          return new Response(
            JSON.stringify({
              status: 'error',
              reason: 'invite_accept_handler not configured. Set inviteAcceptHandler on LandingServerOptions.',
            }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          )
        }
        return options.inviteAcceptHandler(req)
      }
      // SPA client-route catch-all — a hard load / share of a project-scoped
      // deep link (e.g. the P-A doc-reference URL `/projects/<id>/docs?path=…`)
      // must serve the chat-react shell so the SPA boots and client-routes to
      // the deep link instead of 404ing. Scoped to `GET /projects[/…]`
      // (`isSpaClientRoute`), a prefix disjoint from every API/asset/websocket
      // path — those are matched earlier here + in the compose chain, so this
      // never masks a real 404. All other unknown paths keep returning 404.
      if (isSpaClientRoute(url.pathname, req.method)) {
        return await serveChatReactShell()
      }
      // The legacy `/ws/chat` onboarding WebSocket upgrade was removed —
      // onboarding + chat are unified on the `/ws/app/chat` Expo-app
      // socket (see `gateway/http/app-ws-surface.ts`). A request to
      // `/ws/chat` now simply falls through to the 404 below.
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws): void {
        // /ws/chat removed — onboarding + chat are unified on /ws/app/chat.
        // Nothing upgrades to a landing socket anymore; this is a defensive stub.
        try {
          ws.close(1011, 'chat moved to /ws/app/chat')
        } catch {
          /* already closed */
        }
      },
      // `message` is required by Bun's WebSocketHandler type. Nothing ever
      // reaches it (the landing server no longer upgrades a socket), but a
      // defensive no-op keeps the `{ fetch, websocket }` shape type-compatible
      // with the gateway multiplex.
      message(): void {
        /* no landing socket — chat moved to /ws/app/chat */
      },
    },
  }
}
