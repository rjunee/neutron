/**
 * G1 — Route-matrix characterization tests (Phase-0 guardrail; additive).
 *
 * This is a RATCHET that protects the C-phase composition refactor of
 * `gateway/http/compose.ts` (`composeHttpHandler`) + the
 * `CompositionInput → composeInput` mapping in
 * `gateway/composition.ts:buildComposedHttpFromComposition`. It snapshots
 * TODAY's behavior faithfully — it does NOT assert an idealized shape.
 *
 * WHAT IT PINS
 *   (a) The MOUNTED-ROUTE SET as a function of the supplied surfaces:
 *       booting the real graph with the "Open" surface set (via
 *       `composeProductionGraph`, so the ISSUE-#32 mapping is exercised for
 *       real — the same reason every `*-production-composer.test.ts` serves
 *       `graph.fetch`) and asserting each wired route is OWNED (non-404).
 *   (b) The NEGATIVE SPACE — the surfaces the Open composition does NOT wire
 *       (reminders / focus / focus-current / admin / persona / devices /
 *       backups / launcher / tasks). Their canonical routes 404 THROUGH THE
 *       REAL GRAPH, proving the ladder mounts them ONLY when their surface is
 *       supplied. This is what lets the C-phase refactor be caught if it ever
 *       silently DROPS a wired surface (positive route 404s) OR silently ADDS
 *       an unconditional surface (a negative route stops 404ing) — the
 *       "either direction" guard the plan §G1 calls for.
 *   (c) The LADDER ORDER (via `composeHttpHandler` directly, with controlled
 *       recording stubs so the precedence is unambiguous):
 *         - authGate runs FIRST, with the Set-Cookie stitch onto the
 *           downstream response          (compose.ts authGate block)
 *         - chunked-upload BEFORE legacy single-shot upload
 *         - per-project children (tabs / work-board / credentials / codex-auth)
 *           BEFORE the generic appProjects surface
 *         - landing path-set match, then SPA `/projects[/…]` catch-all,
 *           BEFORE the cross-instance connect API, before the default 404.
 *
 * ANCHOR DRIFT vs the plan §G1 text (verified against HEAD 135c2e1):
 *   - The plan lists `connect-auth` in the negative space. Reality disagrees:
 *     `connect-auth-open-mode-production-composer.test.ts` wires
 *     `app_connect_auth_surface` IN OPEN MODE and asserts it reachable, so
 *     connect-auth is an OPEN-POSITIVE surface, not negative space. We
 *     characterize reality: connect-auth is asserted PRESENT in the Open set.
 *   - The line anchors in the plan (`compose.ts:894-948` authGate stitch,
 *     `:1047-1072` chunked-before-legacy) still land on the correct blocks at
 *     HEAD — no numeric drift to correct.
 *
 * OSS-SPLIT NOTE: the Managed production composer (`realmode-composer.ts`) is
 * deploy-config-injected from the private repo (see `gateway/index.ts`
 * `loadGraphComposerFromEnv`) and an Open self-host box boots a `/healthz`-only
 * shell. So the concrete "which surfaces does tier X wire" list lives outside
 * this repo. What IS in this repo — and what the C-phase refactor actually
 * touches — is the SHARED compose seam (`composeHttpHandler` + the mapping).
 * These tests pin that seam: "route owned IFF its surface is supplied, in this
 * ladder order." The Managed-contract variant
 * (`managed-route-matrix.test.ts`) pins that the negative-space
 * `CompositionInput` fields the Managed composer relies on still exist + map.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server, WebSocketHandler } from 'bun'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { composeProductionGraph } from '../composition.ts'
import {
  composeHttpHandler,
  type ComposeHttpHandlerInput,
} from '../http/compose.ts'
import type { AuthGateOptions } from '@neutronai/landing/auth-gate.ts'
import {
  SESSION_COOKIE_NAME,
  formatSetCookie,
  signSessionCookie,
} from '@neutronai/landing/session-cookie.ts'

const OWNER = 'open-route-matrix-owner'

// Bun.serve passes the live `Server` into `fetch`; the composed handler only
// forwards it to `landing.fetch` / `appWs.handler`, neither of which our
// recording stubs read. A structural placeholder is therefore sufficient and
// lets every probe call the handler directly (no port binding, no flake).
const FAKE_SERVER = {} as unknown as Server<unknown>

// A no-op websocket handler for the surface shapes that require one.
const NOOP_WS = {
  open(): void {},
  message(): void {},
  close(): void {},
} as unknown as WebSocketHandler<unknown>

const noOpInputBase = {
  topic_handler: async (): Promise<void> => {},
  approval_notifier: { notify: async (): Promise<undefined> => undefined },
  watchdog_notifier: { notify: async (): Promise<undefined> => undefined },
  reminder_dispatcher: { dispatch: async (): Promise<undefined> => undefined },
  heartbeat_tracker: { lastHeartbeatAt: (): number => Date.now() },
  platform: STUB_PLATFORM,
}

/** JSON sentinel body identifying which surface answered a probe. */
function sentinel(name: string): Response {
  return new Response(JSON.stringify({ surface: name }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** A recording `{ handler }` surface that owns `owns(url, method)` and
 *  disclaims (returns `null`) every other path — the real surfaces'
 *  own-or-disclaim contract, distilled to exactly the routing behavior the
 *  ladder depends on. */
function surface(
  name: string,
  owns: (url: URL, method: string) => boolean,
  calls?: string[],
): { handler: (req: Request) => Promise<Response | null> } {
  return {
    handler: async (req: Request): Promise<Response | null> => {
      calls?.push(name)
      const url = new URL(req.url)
      return owns(url, req.method) ? sentinel(name) : null
    },
  }
}

/** Read a JSON probe response and return the answering surface name (or the
 *  numeric status for a non-sentinel / error response). */
async function answered(res: Response): Promise<string | number> {
  if (res.status !== 200) return res.status
  try {
    const body = (await res.json()) as { surface?: unknown }
    return typeof body.surface === 'string' ? body.surface : res.status
  } catch {
    return res.status
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Part 1 — Open composition route MATRIX + NEGATIVE SPACE (real graph)
// ─────────────────────────────────────────────────────────────────────────

interface GraphHarness {
  fetch: NonNullable<Awaited<ReturnType<typeof composeProductionGraph>>['fetch']>
  close: () => Promise<void>
}

/**
 * Boot the production graph with the "Open" surface set: every user-facing +
 * operator surface EXCEPT the negative-space group. Stub `{ handler }`
 * surfaces exercise the REAL `composition.ts` field→route mapping while
 * keeping each surface's ownership predicate under test control (surface
 * internals have their own `*-production-composer.test.ts`).
 */
async function bootOpenGraph(): Promise<GraphHarness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-open-route-matrix-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,

    // ── landing + operator/http surfaces ──────────────────────────────────
    landing_server: {
      fetch: (): Response => sentinel('landing'),
      websocket: NOOP_WS,
    },
    telegram_webhook: { handler: async (): Promise<Response> => sentinel('telegram') },
    internal_cache_invalidate: {
      invalidateInternalHandle: (): void => {},
      // Token-gated inside the handler; a probe without the header 403s
      // (OWNED — a 404 would mean the route never mounted).
      expectedToken: 'internal-secret',
    },
    slug_check_handler: async (): Promise<Response> => sentinel('slug-check'),
    admin_respawn_handler: async (req: Request): Promise<Response | null> =>
      new URL(req.url).pathname === '/admin/respawn-session'
        ? sentinel('admin-respawn')
        : null,
    chat_history_surface: surface('chat-history', (u) => u.pathname === '/api/v1/chat/history'),
    chat_topics_surface: surface('chat-topics', (u) => u.pathname === '/api/v1/chat/topics'),
    avatar_handler: (): Response => sentinel('avatar'),
    candidate_handler: (): Response => sentinel('candidate'),
    import_upload_handler: async (): Promise<Response> => sentinel('import-upload'),
    chunked_upload_handler: async (req: Request): Promise<Response | null> =>
      /\/api\/upload\/[^/]+\/(start|[^/]+)$/.test(new URL(req.url).pathname) &&
      new URL(req.url).pathname.split('/').length === 5
        ? sentinel('chunked-upload')
        : null,
    import_resume_handler: async (req: Request): Promise<Response | null> =>
      /^\/api\/import\/[^/]+\/resume$/.test(new URL(req.url).pathname)
        ? sentinel('import-resume')
        : null,

    // ── app surfaces (OPEN-positive) ──────────────────────────────────────
    app_ws_surface: {
      handler: async (req: Request): Promise<Response | null> =>
        new URL(req.url).pathname === '/api/app/chat/send' ? sentinel('app-ws') : null,
      websocket: NOOP_WS,
    },
    app_upload_surface: surface('app-upload', (u) => u.pathname === '/api/app/upload'),
    app_projects_surface: surface(
      'app-projects',
      (u) =>
        u.pathname === '/api/app/projects' ||
        /^\/api\/app\/projects\/[^/]+\/settings$/.test(u.pathname),
    ),
    app_connect_auth_surface: surface('app-connect-auth', (u) =>
      u.pathname.startsWith('/api/app/connect/auth/'),
    ),
    app_docs_surface: surface('app-docs', (u) =>
      /^\/api\/app\/projects\/[^/]+\/docs(\/|$)/.test(u.pathname),
    ),
    app_tabs_surface: surface(
      'app-tabs',
      (u) =>
        u.pathname === '/api/app/tabs' ||
        /^\/api\/app\/projects\/[^/]+\/tabs$/.test(u.pathname),
    ),
    app_work_board_surface: surface('app-work-board', (u) =>
      /^\/api\/app\/projects\/[^/]+\/work-board(\/|$)/.test(u.pathname),
    ),
    app_project_credentials_surface: surface('app-project-credentials', (u) =>
      /^\/api\/app\/projects\/[^/]+\/credentials(\/|$)/.test(u.pathname),
    ),
    app_codex_credential_surface: surface(
      'app-codex-credential',
      (u) =>
        u.pathname === '/api/app/codex-auth' ||
        /^\/api\/app\/projects\/[^/]+\/codex-auth$/.test(u.pathname),
    ),

    // ── cores surfaces ────────────────────────────────────────────────────
    cores_surface: surface(
      'cores',
      (u) => u.pathname === '/api/cores' || /^\/api\/cores\/[^/]+$/.test(u.pathname),
    ),
    cores_oauth_surface: surface('cores-oauth', (u) =>
      u.pathname.startsWith('/api/cores/oauth/'),
    ),
    cores_integrations_surface: surface(
      'cores-integrations',
      (u) =>
        u.pathname === '/api/cores/integrations' ||
        u.pathname.startsWith('/api/cores/api-keys/'),
    ),

    // NEGATIVE SPACE — deliberately UNWIRED (asserted absent below):
    //   app_reminders_surface, app_focus_surface, app_focus_current_surface,
    //   app_admin_surface, app_persona_surface, app_devices_surface,
    //   app_backups_surface, app_launcher_surface, app_tasks_surface.
    // authGate is also unset (Open self-host + tests leave it off; see
    //   compose.ts isGatedUserFacingRoute docblock).
  })

  if (graph.fetch === undefined) {
    throw new Error(
      'composeProductionGraph did not expose graph.fetch — route-matrix reachability gap',
    )
  }
  const fetch = graph.fetch
  return {
    fetch,
    close: async (): Promise<void> => {
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

describe('G1 — Open composition route matrix (real graph)', () => {
  let harness: GraphHarness
  const call = (method: string, path: string, headers?: Record<string, string>): Promise<Response> =>
    Promise.resolve(
      harness.fetch(
        new Request(`http://127.0.0.1${path}`, { method, ...(headers ? { headers } : {}) }),
        FAKE_SERVER,
      ),
    )

  beforeAll(async () => {
    harness = await bootOpenGraph()
  })
  afterAll(async () => {
    // Guarded: if beforeAll threw, `harness` is undefined — an unguarded
    // `harness.close()` would throw a TypeError that masks the real setup error.
    await harness?.close()
  })

  // ── positive matrix: each wired surface OWNS its canonical route ────────
  const OWNED: ReadonlyArray<[string, string, string, string]> = [
    // [surface, method, path, expected answering-surface sentinel]
    ['landing', 'GET', '/chat', 'landing'],
    ['chat-history', 'GET', '/api/v1/chat/history', 'chat-history'],
    ['chat-topics', 'GET', '/api/v1/chat/topics', 'chat-topics'],
    ['slug-check', 'GET', '/api/v1/slug/check', 'slug-check'],
    ['admin-respawn', 'POST', '/admin/respawn-session', 'admin-respawn'],
    ['avatar', 'GET', '/avatar.png', 'avatar'],
    ['candidate', 'GET', '/profile-pic/candidate/c1.png', 'candidate'],
    ['chunked-upload', 'POST', '/api/upload/chatgpt/start', 'chunked-upload'],
    ['import-resume', 'POST', '/api/import/job-1/resume', 'import-resume'],
    ['import-upload', 'POST', '/api/upload/chatgpt', 'import-upload'],
    ['app-ws', 'POST', '/api/app/chat/send', 'app-ws'],
    ['app-upload', 'POST', '/api/app/upload', 'app-upload'],
    ['app-tabs(project)', 'GET', '/api/app/projects/p1/tabs', 'app-tabs'],
    ['app-tabs(global)', 'GET', '/api/app/tabs', 'app-tabs'],
    ['app-work-board', 'GET', '/api/app/projects/p1/work-board', 'app-work-board'],
    ['app-project-credentials', 'GET', '/api/app/projects/p1/credentials', 'app-project-credentials'],
    ['app-codex-credential(global)', 'GET', '/api/app/codex-auth', 'app-codex-credential'],
    ['app-codex-credential(project)', 'GET', '/api/app/projects/p1/codex-auth', 'app-codex-credential'],
    ['app-projects(list)', 'GET', '/api/app/projects', 'app-projects'],
    ['app-projects(settings)', 'GET', '/api/app/projects/p1/settings', 'app-projects'],
    ['app-connect-auth', 'GET', '/api/app/connect/auth/status', 'app-connect-auth'],
    ['app-docs', 'GET', '/api/app/projects/p1/docs/tree', 'app-docs'],
    ['cores', 'GET', '/api/cores', 'cores'],
    ['cores-oauth', 'GET', '/api/cores/oauth/google/status', 'cores-oauth'],
    ['cores-integrations', 'GET', '/api/cores/integrations', 'cores-integrations'],
    ['telegram', 'POST', '/webhook/telegram', 'telegram'],
  ]

  for (const [label, method, path, expected] of OWNED) {
    test(`OPEN mounts ${label}: ${method} ${path} → ${expected}`, async () => {
      const res = await call(method, path)
      expect(await answered(res)).toBe(expected)
    })
  }

  test('OPEN mounts internal-cache-invalidate (token-gated → 403, OWNED not 404)', async () => {
    const res = await call('POST', '/internal/cache-invalidate')
    // 403 (forbidden — missing/bad token) proves the route mounted; a 404
    // would mean the mapping never wired it.
    expect(res.status).toBe(403)
  })

  // ── NEGATIVE SPACE: unwired surfaces 404 through the real graph ─────────
  const ABSENT: ReadonlyArray<[string, string, string]> = [
    ['reminders', 'GET', '/api/app/projects/p1/reminders'],
    ['focus', 'GET', '/api/app/focus'],
    ['focus-current', 'GET', '/api/app/focus/current'],
    ['admin', 'GET', '/api/app/admin/personality'],
    ['persona', 'GET', '/api/app/persona/files'],
    ['devices', 'POST', '/api/app/devices/register'],
    ['backups', 'GET', '/api/app/projects/p1/backups'],
    ['launcher', 'GET', '/api/app/projects/p1/launcher'],
    ['tasks', 'GET', '/api/app/projects/p1/tasks'],
  ]

  for (const [label, method, path] of ABSENT) {
    test(`OPEN negative space — ${label} unwired: ${method} ${path} → 404`, async () => {
      const res = await call(method, path)
      expect(res.status).toBe(404)
    })
  }

  test('OPEN negative space — dev mint-session is NOT wired through the graph mapping (404)', async () => {
    // `devMintSession` is a `composeHttpHandler` field with NO
    // `buildComposedHttpFromComposition` mapping — so it is unreachable via
    // `composeProductionGraph`. Pin that fact so a C-phase mapping change
    // that silently promotes it is caught.
    const res = await call('POST', '/api/dev/mint-session')
    expect(res.status).toBe(404)
  })

  test('OPEN — an unknown API path falls through to the default 404', async () => {
    const res = await call('GET', '/api/does-not-exist')
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Part 2 — Ladder ORDER (composeHttpHandler directly, controlled stubs)
// ─────────────────────────────────────────────────────────────────────────

const COOKIE_SECRET = 'route-matrix-cookie-secret-000000000000'
const IDENTITY_BASE = 'https://auth.route-matrix.example'

/** A minimal-but-real auth gate: cookie-valid requests slide-refresh (`allow`
 *  + Set-Cookie), tokenless browser navigations 302 to identity signin. The
 *  JWKS/start-token verifiers are stubbed to "no token here" since these
 *  probes drive only the cookie + no-auth branches. */
const AUTH_GATE: AuthGateOptions = {
  project_slug: OWNER,
  cookie_secret: COOKIE_SECRET,
  resolveKey: async (): Promise<null> => null,
  verifyStartToken: async (): Promise<{ ok: false; reason: 'malformed' }> => ({
    ok: false,
    reason: 'malformed',
  }),
  identity_public_base_url: IDENTITY_BASE,
}

function compose(input: ComposeHttpHandlerInput): (req: Request) => Promise<Response> {
  const handler = composeHttpHandler(input)
  return (req: Request): Promise<Response> => Promise.resolve(handler.fetch(req, FAKE_SERVER))
}

describe('G1 — ladder order: authGate FIRST + Set-Cookie stitch', () => {
  test('cookie-valid /api/app/* → downstream response with the gate Set-Cookie stitched on', async () => {
    const calls: string[] = []
    const fetch = compose({
      defaultHandler: () => new Response('Not Found', { status: 404 }),
      authGate: AUTH_GATE,
      appProjects: surface('app-projects', (u) => u.pathname === '/api/app/projects', calls),
    })
    const cookie = signSessionCookie(OWNER, COOKIE_SECRET, Date.now())
    const res = await fetch(
      new Request('http://127.0.0.1/api/app/projects', {
        headers: { cookie: formatSetCookie(cookie).split(';')[0]! },
      }),
    )
    // Downstream surface answered …
    expect(await answered(res)).toBe('app-projects')
    // … AND the gate's sliding-refresh Set-Cookie was stitched onto it.
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(SESSION_COOKIE_NAME)
    expect(calls).toEqual(['app-projects'])
  })

  test('tokenless browser nav to /chat → 302 signin BEFORE any downstream handler runs', async () => {
    const calls: string[] = []
    const fetch = compose({
      defaultHandler: () => new Response('Not Found', { status: 404 }),
      authGate: AUTH_GATE,
      // The landing stub RECORDS into `calls` before answering — so the
      // `calls === []` assertion below has teeth: it stays empty ONLY because
      // the gate short-circuited before landing ran. A regression that let the
      // request reach landing would push 'landing' and fail the assertion.
      landing: {
        fetch: (): Response => {
          calls.push('landing')
          return sentinel('landing')
        },
        websocket: NOOP_WS,
      },
    })
    const res = await fetch(
      new Request('http://127.0.0.1/chat', { headers: { accept: 'text/html' } }),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toContain(IDENTITY_BASE)
    // The gate short-circuited: the (recording) landing handler was never reached.
    expect(calls).toEqual([])
  })
})

describe('G1 — ladder order: chunked-upload BEFORE legacy single-shot upload', () => {
  const build = (calls: string[]): ((req: Request) => Promise<Response>) =>
    compose({
      defaultHandler: () => new Response('Not Found', { status: 404 }),
      // chunked owns the `/start` + `/<upload_id>` shapes, disclaims the bare
      // `POST /api/upload/<src>` so the legacy handler gets it.
      chunkedUploadHandler: async (req: Request): Promise<Response | null> => {
        calls.push('chunked')
        const p = new URL(req.url).pathname
        return p.split('/').length === 5 ? sentinel('chunked') : null
      },
      importUploadHandler: async (): Promise<Response> => {
        calls.push('legacy')
        return sentinel('legacy')
      },
    })

  test('POST /api/upload/<src>/start → chunked owns it (legacy never consulted)', async () => {
    const calls: string[] = []
    const res = await build(calls)(
      new Request('http://127.0.0.1/api/upload/chatgpt/start', { method: 'POST' }),
    )
    expect(await answered(res)).toBe('chunked')
    expect(calls).toEqual(['chunked'])
  })

  test('POST /api/upload/<src> (bare) → chunked runs FIRST, disclaims, legacy handles', async () => {
    const calls: string[] = []
    const res = await build(calls)(
      new Request('http://127.0.0.1/api/upload/chatgpt', { method: 'POST' }),
    )
    expect(await answered(res)).toBe('legacy')
    // Order is load-bearing: chunked was consulted before legacy.
    expect(calls).toEqual(['chunked', 'legacy'])
  })
})

describe('G1 — ladder order: per-project children BEFORE appProjects', () => {
  // appProjects is GREEDY here (claims every `/api/app/projects/*`) so that a
  // route a per-project child owns can only be answered correctly if that
  // child runs FIRST. If the ladder ever reordered appProjects ahead of a
  // child, these would flip to `app-projects`.
  const greedyProjects = (calls: string[]): ComposeHttpHandlerInput['appProjects'] =>
    surface('app-projects', (u) => u.pathname.startsWith('/api/app/projects/'), calls)

  const cases: Array<[string, string, ComposeHttpHandlerInput]> = []
  const mk = (childKey: keyof ComposeHttpHandlerInput, path: string, name: string): void => {
    const calls: string[] = []
    const input: ComposeHttpHandlerInput = {
      defaultHandler: () => new Response('Not Found', { status: 404 }),
      appProjects: greedyProjects(calls),
      [childKey]: surface(name, () => true, calls),
    } as ComposeHttpHandlerInput
    cases.push([name, path, input])
  }
  mk('appTabs', '/api/app/projects/p1/tabs', 'app-tabs')
  mk('appWorkBoard', '/api/app/projects/p1/work-board', 'app-work-board')
  mk('appProjectCredentials', '/api/app/projects/p1/credentials', 'app-project-credentials')
  mk('appCodexCredential', '/api/app/projects/p1/codex-auth', 'app-codex-credential')

  for (const [name, path, input] of cases) {
    test(`${name} wins over greedy appProjects at ${path}`, async () => {
      const res = await compose(input)(new Request(`http://127.0.0.1${path}`))
      expect(await answered(res)).toBe(name)
    })
  }

  test('appFocusCurrent (more-specific) wins over appFocus at /api/app/focus/current', async () => {
    const res = await compose({
      defaultHandler: () => new Response('Not Found', { status: 404 }),
      appFocus: surface('app-focus', (u) => u.pathname.startsWith('/api/app/focus')),
      appFocusCurrent: surface('app-focus-current', (u) => u.pathname === '/api/app/focus/current'),
    })(new Request('http://127.0.0.1/api/app/focus/current'))
    expect(await answered(res)).toBe('app-focus-current')
  })
})

describe('G1 — ladder order: landing path-set, then SPA catch-all, then connect API, then default', () => {
  const build = (calls: string[]): ((req: Request) => Promise<Response>) =>
    compose({
      defaultHandler: () => new Response('Not Found', { status: 404 }),
      landing: {
        fetch: (): Response => {
          calls.push('landing')
          return sentinel('landing')
        },
        websocket: NOOP_WS,
      },
      // Greedy connect handler: owns EVERYTHING it is asked. It must only ever
      // be reached AFTER landing + the SPA catch-all have disclaimed.
      connectHandler: async (): Promise<Response | null> => {
        calls.push('connect')
        return sentinel('connect')
      },
    })

  test('GET /chat → landing path-set match (connect never reached)', async () => {
    const calls: string[] = []
    const res = await build(calls)(new Request('http://127.0.0.1/chat'))
    expect(await answered(res)).toBe('landing')
    expect(calls).toEqual(['landing'])
  })

  test('GET /projects/p1 → SPA catch-all delegates to landing (before connect)', async () => {
    const calls: string[] = []
    const res = await build(calls)(new Request('http://127.0.0.1/projects/p1'))
    expect(await answered(res)).toBe('landing')
    expect(calls).toEqual(['landing'])
  })

  test('GET /connect/v1/whatever → falls through landing+SPA to the connect API', async () => {
    const calls: string[] = []
    const res = await build(calls)(new Request('http://127.0.0.1/connect/v1/inbound'))
    expect(await answered(res)).toBe('connect')
    // Proof of precedence: connect only ran after the earlier rungs disclaimed.
    expect(calls).toEqual(['connect'])
  })

  test('POST /projects/p1 (non-GET) is NOT an SPA route → connect/default, not landing', async () => {
    const calls: string[] = []
    const res = await build(calls)(new Request('http://127.0.0.1/projects/p1', { method: 'POST' }))
    // isSpaClientRoute matches GET only; a POST falls past landing+SPA to
    // connect (greedy) — never to the landing shell.
    expect(await answered(res)).toBe('connect')
    expect(calls).toEqual(['connect'])
  })

  test('unknown non-SPA path with connect disclaiming → default 404 (SPA never masks it)', async () => {
    const res = await compose({
      defaultHandler: () => new Response('Not Found', { status: 404 }),
      landing: { fetch: (): Response => sentinel('landing'), websocket: NOOP_WS },
      connectHandler: async (): Promise<Response | null> => null,
    })(new Request('http://127.0.0.1/api/app/unknown'))
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Part 3 — the `import_resume_handler`-only boundary (C4 DIVERGENCE FIX)
// ─────────────────────────────────────────────────────────────────────────

describe('G1 — import_resume_handler-only composition (C4 divergence fix)', () => {
  test('supplying ONLY import_resume_handler DOES build the chain and serves the resume route', async () => {
    // RATCHET CHANGE (C4 divergence fix) — this test previously pinned the
    // pre-C4 drift AS-IS: `import_resume_handler` was mapped into
    // `composeInput` but OMITTED from the hand-maintained
    // `hasAnyChainedSurface` gate, so as the ONLY supplied HTTP surface it
    // yielded `graph.fetch === undefined` and its wired route was silently
    // never served (latent prod bug; harmless in practice because every real
    // composition also supplies landing). The pre-C4 comment here required a
    // fix to "change this assertion WITH an explicit ratchet-change PR note"
    // — this is that change. C4 generates the gate from the RouteSlot
    // registry (`gateway/http/route-slots.ts:CHAINED_SURFACE_COMPOSITION_KEYS`)
    // where every mapped surface chain-gates: `chat_history_surface`,
    // `chat_topics_surface`, `import_resume_handler`, and `auth_gate` now
    // count, so the composed fetch exists and the resume route is OWNED.
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-import-resume-only-'))
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    const graph = await composeProductionGraph({
      db,
      project_slug: OWNER,
      ...noOpInputBase,
      import_resume_handler: async (req: Request): Promise<Response | null> =>
        /^\/api\/import\/[^/]+\/resume$/.test(new URL(req.url).pathname)
          ? sentinel('import-resume')
          : null,
      // NOTHING else supplied — import_resume_handler is the sole HTTP surface.
    })
    try {
      expect(graph.fetch).toBeDefined()
      const res = await graph.fetch!(
        new Request('http://127.0.0.1/api/import/job-1/resume', { method: 'POST' }),
        FAKE_SERVER,
      )
      expect(await answered(res)).toBe('import-resume')
      // Non-owned paths still fall through to the default 404 chain.
      const miss = await graph.fetch!(
        new Request('http://127.0.0.1/api/does-not-exist'),
        FAKE_SERVER,
      )
      expect(miss.status).toBe(404)
    } finally {
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('the SAME resume handler DOES route once any gate-counted surface is also present', async () => {
    // Contrast case: add ONE gate-counted surface (landing) alongside the same
    // resume handler → `hasAnyChainedSurface` is now true → the composed fetch
    // exists AND the resume route is OWNED. This proves the divergence above is
    // purely the gate omission, not a broken import-resume mapping.
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-import-resume-plus-'))
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    const graph = await composeProductionGraph({
      db,
      project_slug: OWNER,
      ...noOpInputBase,
      landing_server: { fetch: (): Response => sentinel('landing'), websocket: NOOP_WS },
      import_resume_handler: async (req: Request): Promise<Response | null> =>
        /^\/api\/import\/[^/]+\/resume$/.test(new URL(req.url).pathname)
          ? sentinel('import-resume')
          : null,
    })
    try {
      expect(graph.fetch).toBeDefined()
      const res = await graph.fetch!(
        new Request('http://127.0.0.1/api/import/job-1/resume', { method: 'POST' }),
        FAKE_SERVER,
      )
      expect(await answered(res)).toBe('import-resume')
    } finally {
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
