/**
 * G1 — Route-matrix characterization: the MANAGED-CONTRACT variant
 * (Phase-0 guardrail; additive). Sibling of `open-route-matrix.test.ts`.
 *
 * The Managed production composer (`realmode-composer.ts`) is deploy-config-
 * injected from the private repo (`gateway/index.ts:loadGraphComposerFromEnv`),
 * so it cannot be booted here. What CAN — and MUST — be pinned in this repo is
 * the SEAM the Managed composer relies on: the `CompositionInput` fields for
 * the surfaces that Open leaves in its NEGATIVE SPACE but Managed WIRES, plus
 * the Managed-only `auth_gate` + cross-instance `connect_api` fields. If a
 * C-phase refactor drops one of these fields (or its
 * `buildComposedHttpFromComposition` mapping), Managed breaks silently while
 * Open stays green — exactly the failure mode this ratchet exists to catch.
 *
 * This test boots the REAL graph (`composeProductionGraph`, so the field→route
 * mapping is exercised for real) with the negative-space surfaces SUPPLIED and
 * asserts each now OWNS its canonical route — the mirror image of
 * `open-route-matrix.test.ts`, which asserts they 404 when omitted. Together
 * the two files pin the mount set "in either direction": a surface is owned IFF
 * its `CompositionInput` field is supplied.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server, WebSocketHandler } from 'bun'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { composeProductionGraph } from '../composition.ts'
import type { CompositionInput } from '../composition.ts'

const OWNER = 'managed-route-matrix-owner'
const IDENTITY_BASE = 'https://auth.managed-route-matrix.example'
const COOKIE_SECRET = 'managed-route-matrix-cookie-secret-00000000'

const FAKE_SERVER = {} as unknown as Server<unknown>
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

function sentinel(name: string): Response {
  return new Response(JSON.stringify({ surface: name }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function surface(
  name: string,
  owns: (url: URL, method: string) => boolean,
): { handler: (req: Request) => Promise<Response | null> } {
  return {
    handler: async (req: Request): Promise<Response | null> => {
      const url = new URL(req.url)
      return owns(url, req.method) ? sentinel(name) : null
    },
  }
}

async function answered(res: Response): Promise<string | number> {
  if (res.status !== 200) return res.status
  try {
    const body = (await res.json()) as { surface?: unknown }
    return typeof body.surface === 'string' ? body.surface : res.status
  } catch {
    return res.status
  }
}

interface GraphHarness {
  fetch: NonNullable<Awaited<ReturnType<typeof composeProductionGraph>>['fetch']>
  close: () => Promise<void>
}

/**
 * Boot the graph with the Managed superset: the negative-space app surfaces
 * SUPPLIED (reminders / focus / focus-current / admin / persona / devices /
 * backups / launcher / tasks) + the Managed `auth_gate`. Every field here is
 * one the Managed composer wires; the test asserts each maps to its route.
 */
async function bootManagedGraph(): Promise<GraphHarness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-managed-route-matrix-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  const auth_gate: CompositionInput['auth_gate'] = {
    project_slug: OWNER,
    cookie_secret: COOKIE_SECRET,
    resolveKey: async (): Promise<null> => null,
    verifyStartToken: async (): Promise<{ ok: false; reason: 'malformed' }> => ({
      ok: false,
      reason: 'malformed',
    }),
    identity_public_base_url: IDENTITY_BASE,
  }

  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,

    // Landing present so the gate has a browser-facing surface behind it.
    landing_server: { fetch: (): Response => sentinel('landing'), websocket: NOOP_WS },

    // The Managed auth gate (Open self-host leaves this unset).
    auth_gate,

    // ── the NEGATIVE-SPACE surfaces, now SUPPLIED (Managed-relied fields) ──
    app_launcher_surface: surface('app-launcher', (u) =>
      /^\/api\/app\/projects\/[^/]+\/launcher(\/|$)/.test(u.pathname),
    ),
    app_tasks_surface: surface('app-tasks', (u) =>
      /^\/api\/app\/projects\/[^/]+\/tasks(\/|$)/.test(u.pathname),
    ),
    app_reminders_surface: surface('app-reminders', (u) =>
      /^\/api\/app\/projects\/[^/]+\/reminders(\/|$)/.test(u.pathname),
    ),
    app_focus_surface: surface('app-focus', (u) => u.pathname === '/api/app/focus'),
    app_focus_current_surface: surface('app-focus-current', (u) => u.pathname === '/api/app/focus/current'),
    app_admin_surface: surface('app-admin', (u) => u.pathname.startsWith('/api/app/admin/')),
    app_persona_surface: surface('app-persona', (u) => u.pathname.startsWith('/api/app/persona/')),
    app_devices_surface: surface('app-devices', (u) => u.pathname.startsWith('/api/app/devices/')),
    app_backups_surface: surface('app-backups', (u) =>
      /^\/api\/app\/projects\/[^/]+\/(backups|restore)(\/|$)?/.test(u.pathname),
    ),
  })

  if (graph.fetch === undefined) {
    throw new Error(
      'composeProductionGraph did not expose graph.fetch — managed route-matrix reachability gap',
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

describe('G1 — Managed-contract route matrix (negative-space surfaces WIRED)', () => {
  let harness: GraphHarness
  // Managed gates /api/app/* — mobile/app JSON calls send Accept: application/json
  // so the gate falls through (`pass-through-unauthed`) to the surface. We use
  // that header on every probe so the negative-space surface itself answers.
  const call = (method: string, path: string): Promise<Response> =>
    Promise.resolve(
      harness.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers: { accept: 'application/json' },
        }),
        FAKE_SERVER,
      ),
    )

  beforeAll(async () => {
    harness = await bootManagedGraph()
  })
  afterAll(async () => {
    // Guarded: if beforeAll threw, `harness` is undefined — an unguarded
    // `harness.close()` would throw a TypeError that masks the real setup error.
    await harness?.close()
  })

  const OWNED: ReadonlyArray<[string, string, string, string]> = [
    ['app-launcher', 'GET', '/api/app/projects/p1/launcher', 'app-launcher'],
    ['app-tasks', 'GET', '/api/app/projects/p1/tasks', 'app-tasks'],
    ['app-reminders', 'GET', '/api/app/projects/p1/reminders', 'app-reminders'],
    ['app-focus', 'GET', '/api/app/focus', 'app-focus'],
    ['app-focus-current', 'GET', '/api/app/focus/current', 'app-focus-current'],
    ['app-admin', 'GET', '/api/app/admin/personality', 'app-admin'],
    ['app-persona', 'GET', '/api/app/persona/files', 'app-persona'],
    ['app-devices', 'POST', '/api/app/devices/register', 'app-devices'],
    ['app-backups', 'GET', '/api/app/projects/p1/backups', 'app-backups'],
  ]

  for (const [label, method, path, expected] of OWNED) {
    test(`MANAGED wires ${label}: ${method} ${path} → ${expected}`, async () => {
      const res = await call(method, path)
      expect(await answered(res)).toBe(expected)
    })
  }

  test('MANAGED auth_gate maps through the graph: tokenless browser GET /chat → 302 signin', async () => {
    // A browser navigation (Accept: text/html) with no cookie/token trips the
    // gate BEFORE landing — proving `composition.auth_gate` mapped onto the
    // compose `authGate`. Open leaves this unset, so /chat would render.
    const res = await harness.fetch(
      new Request('http://127.0.0.1/chat', { headers: { accept: 'text/html' } }),
      FAKE_SERVER,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toContain(IDENTITY_BASE)
  })
})

describe('G1 — Managed-contract: connect_api is the field that mounts the cross-instance API', () => {
  // Boot the graph with an explicit connect_api override (present or omitted)
  // and probe the cross-instance surface. Pinning BOTH directions closes the
  // ratchet hole: the OMITTED case guards a dropped route binding, the SUPPLIED
  // case guards a dropped field mapping (`composition.ts:111` / `:143`).
  async function withConnectGraph(
    connect_api: NonNullable<CompositionInput['connect_api']> | undefined,
    probe: (fetch: NonNullable<Awaited<ReturnType<typeof composeProductionGraph>>['fetch']>) => Promise<void>,
  ): Promise<void> {
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-managed-connect-'))
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    const graph = await composeProductionGraph({
      db,
      project_slug: OWNER,
      ...noOpInputBase,
      landing_server: { fetch: (): Response => sentinel('landing'), websocket: NOOP_WS },
      ...(connect_api !== undefined ? { connect_api } : {}),
    })
    try {
      expect(graph.fetch).toBeDefined()
      await probe(graph.fetch!)
    } finally {
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  test('WITHOUT connect_api, /connect/v1/* is unmounted (404) — the route binding is field-gated', async () => {
    // The cross-instance connect API is dynamic-imported ONLY when
    // `composition.connect_api` is supplied — omit it and the route 404s.
    await withConnectGraph(undefined, async (fetch) => {
      const res = await fetch(
        new Request('http://127.0.0.1/connect/v1/inbound', { method: 'POST' }),
        FAKE_SERVER,
      )
      expect(res.status).toBe(404)
    })
  })

  test('WITH connect_api supplied, /connect/v1/health is OWNED (200) — the field mapping mounts the API', async () => {
    // `/connect/v1/health` is the one intentionally-unauthed connect route
    // (`connect/api/server.ts` — GET, no bearer), so a minimal connect_api with
    // empty handlers is enough to prove the cross-instance handler mounted.
    // `auth.jwks` is never touched by the health path, so a structural
    // placeholder suffices. If the supplied-field mapping is ever dropped, this
    // flips to 404.
    const connect_api: NonNullable<CompositionInput['connect_api']> = {
      auth: {
        receiving_instance_slug: OWNER,
      } as unknown as NonNullable<CompositionInput['connect_api']>['auth'],
      handlers: {},
    }
    await withConnectGraph(connect_api, async (fetch) => {
      const res = await fetch(
        new Request('http://127.0.0.1/connect/v1/health', { method: 'GET' }),
        FAKE_SERVER,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status?: string; receiving_instance_slug?: string }
      expect(body.status).toBe('ok')
      expect(body.receiving_instance_slug).toBe(OWNER)
    })
  })
})
