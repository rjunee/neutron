/**
 * @neutronai/landing — platform-level signup landing process.
 *
 * Sprint 18 architectural decision: `/api/v1/sign-up` lives on the
 * platform-level signup process, NOT the instance gateway.
 *
 * Reasoning: `/api/v1/sign-up` is fundamentally pre-instance. The user has
 * no slug yet — the route mints an OAuth redirect URL that lands
 * the user on `<auth-host>/oauth/google/start`. The instance
 * gateway is bound to `<slug>.<base-domain>` with subdomain dispatch;
 * the user doesn't know their slug at signup time, so this route can't
 * live there.
 *
 * This boot script runs `createLandingServer` standalone on a configurable
 * port, fronted by a reverse proxy at the signup host. The systemd unit
 * Managed signup service-unit template invokes
 * `bun run landing/boot.ts`.
 *
 * What it serves at the signup host (and the apex base domain —
 * the production reverse proxy routes the apex to this same
 * process, verified live 2026-06-11):
 *   - GET  /                            → static index.html (signup landing CTAs)
 *   - GET  /chat                        → static chat.html (web fallback)
 *   - GET  /chat.js                     → bundled landing client
 *   - GET  /api/v1/sign-up?via=tg|web   → 302 to identity OAuth start
 *   - GET  /invite[?invite=…]           → static invite.html (P2 S5)
 *   - GET  /mobile                      → static mobile.html install page
 *                                          (ISSUES #208 — the wow handoff's
 *                                          MOBILE_APP_URL target; served by
 *                                          createLandingServer's route table)
 *   - POST /onboarding/invite-accept    → 503 (this process does NOT have
 *                                          instance context; the instance
 *                                          gateway accepts invites instead)
 *
 * The landing server no longer serves a chat WebSocket: the legacy
 * `/ws/chat` onboarding socket was removed once onboarding + chat were
 * unified on the per-instance gateway's `/ws/app/chat` Expo-app socket.
 * The signup host therefore 404s any `/ws/chat` request; real chat lives
 * on the instance gateway at `<slug>.<base-domain>/ws/app/chat`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLandingServer } from './server.ts'
import { fireAndForget, installProcessSafetyNet } from '@neutronai/logger/fire-and-forget.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const DEFAULT_PORT = 7_900

/**
 * Resolve the port argument, mirroring `gateway/index.ts:resolveListenPort`'s
 * shape. Precedence: explicit override → `--port=<N>` argv flag →
 * `NEUTRON_SIGNUP_PORT` env → fallback DEFAULT_PORT.
 */
export function resolveSignupPort(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  override?: number,
): number {
  if (override !== undefined) return assertPort(override, '<override>')
  for (const a of argv) {
    if (a.startsWith('--port=')) {
      const raw = a.slice('--port='.length)
      const parsed = Number.parseInt(raw, 10)
      if (Number.isNaN(parsed) || String(parsed) !== raw.trim()) {
        throw new Error(`invalid --port=${raw}: not an integer`)
      }
      return assertPort(parsed, '--port')
    }
  }
  const fromEnv = env['NEUTRON_SIGNUP_PORT']
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = Number.parseInt(fromEnv, 10)
    if (Number.isNaN(parsed) || String(parsed) !== fromEnv.trim()) {
      throw new Error(`invalid NEUTRON_SIGNUP_PORT=${fromEnv}: not an integer`)
    }
    return assertPort(parsed, 'NEUTRON_SIGNUP_PORT')
  }
  return DEFAULT_PORT
}

function assertPort(p: number, label: string): number {
  if (!Number.isInteger(p) || p < 0 || p > 65_535) {
    throw new Error(`invalid ${label}=${p}: must be an integer in [0, 65535]`)
  }
  return p
}

/**
 * Resolve the identity OAuth start URL the platform-landing server
 * 302-redirects `/api/v1/sign-up` to. Production sets
 * `NEUTRON_IDENTITY_OAUTH_URL=https://<auth-host>/oauth/google/start`
 * via the systemd unit's `Environment=` block.
 */
export function resolveIdentityOauthUrl(env: NodeJS.ProcessEnv): string | null {
  const v = env['NEUTRON_IDENTITY_OAUTH_URL']
  return typeof v === 'string' && v.length > 0 ? v : null
}

export interface BootSignupHandle {
  port: number
  /**
   * Idempotent close. `force: true` forwards to `Bun.serve.stop(true)` so
   * idle keep-alive sockets are closed alongside the listener — for
   * in-process callers (tests) where the keep-alive idle timer would
   * otherwise hang the event loop at end of suite. Production callers
   * leave it unset so in-flight requests drain within `TimeoutStopSec`.
   */
  stop: (opts?: { force?: boolean }) => Promise<void>
}

export interface BootSignupOptions {
  port?: number
  /** Override identity OAuth URL (test injection). */
  identityOauthUrl?: string
  /** Override static dir; defaults to the @neutronai/landing package root. */
  staticDir?: string
  /**
   * C2 (OSS split) — pre-built install-token route dispatcher, injected
   * by the Managed boot wrapper. The Anthropic-Max one-liner installer
   * is Managed-tier machinery (the Managed provisioning onboarding-api
   * landing wrapper); this Open boot script never constructs it. Unset (the
   * Open self-host default) leaves the surface unmounted.
   */
  installTokenHandler?: (req: Request) => Promise<Response | null>
  /**
   * C2 (OSS split) — directory carrying the workspace-invite assets
   * (`invite.html` / `invite.ts`), injected by the Managed boot
   * wrapper. Unset → `createLandingServer` falls back to `static_dir`,
   * where the files no longer exist on an Open tree, so the invite
   * routes self-disable.
   */
  inviteAssetsDir?: string
}

export async function bootSignup(options: BootSignupOptions = {}): Promise<BootSignupHandle> {
  const port = resolveSignupPort(process.argv, process.env, options.port)
  const identityOauthUrl = options.identityOauthUrl ?? resolveIdentityOauthUrl(process.env)
  const staticDir = options.staticDir ?? HERE

  // Defensive: the static dir MUST contain the React chat shell
  // (createLandingServer throws if `chat-react.html` is missing — P0b made
  // React the only client). Surface a clearer error here pointing at the
  // resolved path so a misconfigured deploy is easy to diagnose.
  const chatHtmlPath = join(staticDir, 'chat-react.html')
  if (!existsSync(chatHtmlPath)) {
    throw new Error(`landing static dir missing chat-react.html: ${chatHtmlPath}`)
  }

  // C2 (OSS split) — the install-token surface is injected pre-built by
  // the Managed boot wrapper (the Managed provisioning onboarding-api
  // landing/signup-landing-boot.ts). This Open boot script no longer
  // resolves the install-token env nor constructs the routes: a direct
  // `bun landing/boot.ts` (Open self-host) runs with the surface
  // unmounted, by design.
  const landing = createLandingServer({
    static_dir: staticDir,
    ...(options.inviteAssetsDir !== undefined
      ? { invite_assets_dir: options.inviteAssetsDir }
      : {}),
    ...(identityOauthUrl !== null && identityOauthUrl !== undefined
      ? {
          resolveSignupRedirect: ({ via }: { via: 'tg' | 'web' }): string =>
            withQueryParam(identityOauthUrl, 'via', via),
        }
      : {}),
    ...(options.installTokenHandler !== undefined
      ? { installTokenHandler: options.installTokenHandler }
      : {}),
  })

  // Sprint 18 — also serve the static `index.html` at `/` so the
  // platform-landing process can replace the `/var/www/signup` static
  // deploy without an extra Caddy `file_server` directive. Matches the
  // existing landing server pattern (chat.html embedded at boot).
  const indexHtmlPath = join(staticDir, 'index.html')
  const indexHtml: Buffer | null = existsSync(indexHtmlPath) ? readFileSync(indexHtmlPath) : null

  // Static branding assets — favicon, apple-touch-icon, webmanifest, OG
  // image, logo. Loaded once at boot and served from a small allowlist
  // (no path traversal: every served path is a literal match). Missing
  // files fall through to landing.fetch's 404. Mirrors the
  // neutronagent.ai marketing site asset shape so social embeds + PWA
  // installs render the same brand.
  type Asset = { body: Buffer; type: string }
  const assetEntries: Array<readonly [string, string, string]> = [
    ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
    ['/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'],
    ['/site.webmanifest', 'site.webmanifest', 'application/manifest+json'],
    ['/logo.svg', 'logo.svg', 'image/svg+xml'],
    ['/og/neutron-og.png', 'og/neutron-og.png', 'image/png'],
  ]
  const assets = new Map<string, Asset>()
  for (const [route, file, type] of assetEntries) {
    const p = join(staticDir, file)
    if (existsSync(p)) assets.set(route, { body: readFileSync(p), type })
  }

  const server = Bun.serve({
    port,
    fetch: async (req: Request, srv): Promise<Response> => {
      try {
        const url = new URL(req.url)
        // Static index.html at `/` ONLY when no `?invite=` query (the
        // landing server owns the invite short-circuit at `/?invite=…`).
        if (
          indexHtml !== null &&
          url.pathname === '/' &&
          req.method === 'GET' &&
          !url.searchParams.has('invite')
        ) {
          return new Response(new Uint8Array(indexHtml), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }
        if (req.method === 'GET') {
          const a = assets.get(url.pathname)
          if (a !== undefined) {
            return new Response(new Uint8Array(a.body), {
              headers: {
                'content-type': a.type,
                'cache-control': 'public, max-age=86400',
              },
            })
          }
        }
        return await landing.fetch(req, srv)
      } catch (err) {
        console.error('signup landing handler threw:', err)
        return new Response('Internal Server Error', { status: 500 })
      }
    },
    websocket: landing.websocket,
  })

  if (server.port === undefined) {
    throw new Error('Bun.serve did not bind a port for the signup landing')
  }

  return {
    port: server.port,
    stop: async (opts) => {
      // Production default: graceful drain. opts.force=true forwards
      // closeActiveConnections=true so idle keep-alive sockets close
      // alongside the listener.
      //
      // Auto-force when NODE_ENV='test' (bun test sets this for us) so
      // in-process test runners exit cleanly. Without this, idle
      // keep-alive sockets owned by the listener keep Bun's event loop
      // alive on the keep-alive idle timer (~5 min) and `bun test` hangs
      // at suite end. systemd-spawned production processes do not set
      // NODE_ENV, so their semantics are unchanged.
      const force = opts?.force ?? process.env['NODE_ENV'] === 'test'
      await server.stop(force)
    },
  }
}

/**
 * Append (or replace) a query parameter on a URL string. Used by the
 * production `resolveSignupRedirect` to thread the `?via=tg|web` hint
 * through to the identity OAuth start URL.
 */
function withQueryParam(rawUrl: string, key: string, value: string): string {
  const u = new URL(rawUrl)
  u.searchParams.set(key, value)
  return u.toString()
}

if (import.meta.main) {
  // F3 — standalone entrypoint: install the process-level rejection/exception
  // net so an UNEXPECTED failure here (this process does NOT go through the
  // gateway `boot()` that installs it) is logged-then-crashed, not a bare exit.
  // RESIDUAL: covers the body onward; this dual library+entry module's OWN
  // static imports (stable internal modules) are the accepted in-module-install
  // limit (no bootstrap split — it exports `bootSignup`/`createLandingServer`).
  installProcessSafetyNet()

  // Top-level await: Bun supports TLA in entry modules. An unhandled
  // rejection exits non-zero, which systemd's Restart=always policy
  // converts into a respawn after RestartSec=5s.
  //
  // C2 (OSS split): direct execution is the OPEN entry — no install-token
  // surface, no invite assets. The Managed production entry is
  // provisioning onboarding-api `landing/signup-landing-boot.ts`,
  // which injects both (the systemd unit template points there).
  const handle = await bootSignup()
  console.log(`[signup-landing] listening on 127.0.0.1:${handle.port}`)
  process.once('SIGTERM', () => {
    fireAndForget('boot.stop', handle.stop(), (err) => {
      console.error('signup-landing stop failed:', err)
    })
  })
  process.once('SIGINT', () => {
    fireAndForget('boot.stop', handle.stop(), (err) => {
      console.error('signup-landing stop failed:', err)
    })
  })
}
