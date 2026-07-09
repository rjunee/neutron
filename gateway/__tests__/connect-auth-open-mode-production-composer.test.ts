/**
 * M2.5 (Argus r1 BLOCKER #2) — production-composer reachability guard for the
 * Open-mode connect auth surface + the federated shared-projects path.
 *
 * The headline M2.5 deliverable (Open client surface + FederatedTokenStore +
 * open workspace-source resolver) shipped in r1 instantiated NOWHERE outside
 * unit tests — `gateway/composition.ts` + `gateway/http/compose.ts` were
 * untouched, so on a real Open box the 4 endpoints 404'd and the landing panel
 * hid itself. This test is the closing guard: it boots the production graph in
 * the SAME shape `gateway/index.ts` does at boot in 'open' mode and asserts:
 *
 *   1. `GET  /api/app/connect/auth/status`     → 200 {connected:false}
 *   2. `POST /api/app/connect/auth/start`      → 200 {auth_url} at the
 *                                                      identity service
 *   3. `GET  /api/app/connect/auth/callback`   → 302 (not 404)
 *   4. `POST /api/app/connect/auth/disconnect` → 200 {ok:true}
 *
 * (A fifth test used to live here proving the shared-projects resolver fans
 * out over a federated JWT via the open-mode `openResolveBaseUrl` path. It
 * was deleted alongside `gateway/connect/open-instance-source-resolver.ts` /
 * `syndication-relay.ts` in the wave-1 dead-code kill (refactor plan §K1):
 * `composition.ts` never actually wires that resolver into the production
 * graph, so the test only ever exercised `buildSharedProjectsResolver` in
 * isolation, not a reachable path.)
 *
 * A future refactor that drops `app_connect_auth_surface` from
 * `composeProductionGraph` / `composeHttpHandler`, or that reverts the
 * open-mode resolver to the managed-hardcoded path, MUST fail this test.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { composeProductionGraph } from '../composition.ts'
import { createAppConnectAuthSurface } from '../http/app-connect-auth.ts'
import { FederatedTokenStore } from '../connect/federated-token-store.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import {
  formatSetCookie,
  readSessionCookie,
  signSessionCookie,
} from '@neutronai/landing/session-cookie.ts'

const OWNER = 'open-client-owner'
const INTERNAL_HANDLE = 'ih-open-client'
const AUTH_BASE = 'https://auth.neutron.example'
// M2.5 follow-up #6 (ISSUES #84) — the surface is now session-gated, so the
// reachability fetches below carry a valid session cookie minted with this
// secret and verified by the resolver wired into the surface (mirrors the
// production `cookieToUserClaim` cookie path). The `Cookie:` header value is
// just the `name=value` pair from the Set-Cookie string.
const COOKIE_SECRET = 'test-connect-session-secret-7777777789'
const SESSION_COOKIE_HEADER = formatSetCookie(
  signSessionCookie(OWNER, COOKIE_SECRET, Date.now()),
).split(';')[0]!
const AUTHED = { headers: { cookie: SESSION_COOKIE_HEADER } }

const noOpInputBase = {
  topic_handler: async () => {},
  approval_notifier: { notify: async () => undefined },
  watchdog_notifier: { notify: async () => undefined },
  reminder_dispatcher: { dispatch: async () => undefined },
  heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
  platform: STUB_PLATFORM,
}

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  secrets: SecretsStore
  tmp: string
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-ct-open-composer-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  const secrets = new SecretsStore({ data_dir: tmp, db })
  // Construct the FederatedTokenStore exactly as the open-mode boot block
  // does — with NO credential present yet (the user connects later). This is
  // the boot-guard requirement: the store + surface are wired even before the
  // first OAuth completes, so `/status` answers `not-connected` instead of 404.
  const store = new FederatedTokenStore({
    secrets,
    internal_handle: INTERNAL_HANDLE,
    auth_base_url: AUTH_BASE,
  })
  const surface = createAppConnectAuthSurface({
    store,
    auth_base_url: AUTH_BASE,
    // Session gate (ISSUES #84) — wire the same cookie-verify path production
    // wires via `cookieToUserClaim`. A valid session cookie for THIS instance
    // yields a claim; everything else is unauthenticated.
    resolveUserClaim: async (req) => {
      const slug = readSessionCookie(req, COOKIE_SECRET, Date.now())
      return slug === OWNER ? { project_slug: slug, user_id: 'u-open' } : null
    },
    project_slug: OWNER,
  })

  // Boot the production graph with the surface threaded through. A rename /
  // removal of `app_connect_auth_surface` from the typed CompositionInput
  // breaks this at compile time BEFORE the runtime test runs.
  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_connect_auth_surface: { handler: surface.handler },
  })

  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error(
      'composeProductionGraph did not expose graph.fetch — connect auth surface reachability gap',
    )
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket

  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })

  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    graph,
    db,
    secrets,
    tmp,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

let harness: Harness
beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

test('production composer mounts GET /api/app/connect/auth/status → 200 not-connected', async () => {
  const res = await fetch(`${harness.base}/api/app/connect/auth/status`, AUTHED)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { connected: boolean }
  expect(body.connected).toBe(false)
})

test('production composer mounts POST /api/app/connect/auth/start → 200 with identity auth_url', async () => {
  const res = await fetch(`${harness.base}/api/app/connect/auth/start`, {
    method: 'POST',
    ...AUTHED,
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { auth_url: string }
  const authUrl = new URL(body.auth_url)
  expect(authUrl.origin).toBe(AUTH_BASE)
  expect(authUrl.pathname).toBe('/oauth/connect/google/start')
  // The callback baked into return_url points back at THIS gateway's surface.
  const returnUrl = new URL(authUrl.searchParams.get('return_url') ?? '')
  expect(returnUrl.pathname).toBe('/api/app/connect/auth/callback')
})

test('production composer mounts GET /api/app/connect/auth/callback → 302 (not 404)', async () => {
  // No connect_code → the surface 302s back with connect=error,
  // proving the route is OWNED (a 404 would mean the surface never mounted).
  const res = await fetch(`${harness.base}/api/app/connect/auth/callback`, {
    redirect: 'manual',
    ...AUTHED,
  })
  expect(res.status).toBe(302)
  const location = res.headers.get('location') ?? ''
  expect(location).toContain('connect=error')
})

test('production composer mounts POST /api/app/connect/auth/disconnect → 200 ok', async () => {
  const res = await fetch(`${harness.base}/api/app/connect/auth/disconnect`, {
    method: 'POST',
    ...AUTHED,
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean }
  expect(body.ok).toBe(true)
})

test('ISSUES #84 — unauthenticated requests to all four routes 401 through the production graph', async () => {
  // No session cookie → the surface 401s every route end-to-end, even with the
  // optional compose-level auth-gate UNWIRED (this test boots without it). This
  // is the security guarantee: the surface itself gates, not the gate.
  const status = await fetch(`${harness.base}/api/app/connect/auth/status`)
  expect(status.status).toBe(401)
  const start = await fetch(`${harness.base}/api/app/connect/auth/start`, {
    method: 'POST',
  })
  expect(start.status).toBe(401)
  const callback = await fetch(
    `${harness.base}/api/app/connect/auth/callback?connect_code=attacker.code`,
    { redirect: 'manual' },
  )
  expect(callback.status).toBe(401)
  const disconnect = await fetch(
    `${harness.base}/api/app/connect/auth/disconnect`,
    { method: 'POST' },
  )
  expect(disconnect.status).toBe(401)
})

// The 'open-mode shared-projects resolver (wired as boot does) fans out over
// the federated JWT' test that lived here was deleted alongside
// `gateway/connect/open-instance-source-resolver.ts` / `syndication-relay.ts`
// (refactor plan §K1, wave-1 kill). It exercised `buildSharedProjectsResolver`
// directly with an inline `openResolveBaseUrl` — `composition.ts` never wires
// that resolver into the production graph, so the path it covered was dead
// outside this one unit test.
