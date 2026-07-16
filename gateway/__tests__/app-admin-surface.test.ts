/**
 * P5.7 — gateway app-admin surface tests.
 *
 * Round-trips the admin routes (gateway restart POST, GBrain browse
 * GET, connectors list GET, the P7.4 Phase 2 project-backup family)
 * through `composeHttpHandler` with the dev-bypass auth resolver. The
 * connectors route runs against a real `ProjectDb` after the canonical
 * migrations apply; the memory route runs against an in-memory
 * `MemoryStore` stub. The restart route runs against a spy callback
 * so the test runner is never SIGTERMed.
 *
 * Personality editing moved to the sibling `/api/app/persona/*`
 * surface (`admin-personality-surface.test.ts`); the legacy
 * `/personality` GET + PUT routes were removed by ISSUE #31
 * (2026-05-23) and now 404 — covered below as a regression guard.
 *
 * Tests mirror the structure of `app-tasks-surface.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { CoreInstallationsStore } from '@neutronai/cores-runtime/installations-store.ts'
import type { MemoryStore } from '@neutronai/gbrain-memory/memory-store.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  createAppAdminSurface,
  type DeploymentTier,
} from '../http/app-admin-surface.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'

// --- in-process handler shim (no socket) -------------------------------------
// These surface tests used to bind a real `Bun.serve({ port: 0 })` and round-
// trip via the global `fetch`, holding a live listener + socket buffers in the
// chunk's RSS until teardown. Instead each harness registers its composed
// handler under a unique in-process base, and `fetch` is shadowed at module
// scope so requests to a registered base dispatch straight to
// `composed.fetch(new Request(...))` — identical assertions, no socket.
// Unrelated URLs fall through to the real fetch.
const __composedHandlers = new Map<string, ComposedHttpHandler>()
let __gatewaySeq = 0
const __realFetch = globalThis.fetch.bind(globalThis)
const fetch = ((input: Request | string | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
  const composed = __composedHandlers.get(new URL(req.url).host)
  if (composed !== undefined) return Promise.resolve(composed.fetch(req, undefined as never))
  return __realFetch(input as Parameters<typeof __realFetch>[0], init)
}) as typeof globalThis.fetch

interface Harness {
  base: string
  tmp: string
  owner_home: string
  db: ProjectDb
  coresStore: CoreInstallationsStore
  restartSpy: { calls: number }
  close(): Promise<void>
}

const PROJECT_SLUG = 'demo'
const OTHER_OWNER = 'someone-else'

interface StartOptions {
  tier?: DeploymentTier
  memoryStore?: MemoryStore
  withCores?: boolean
}

async function startGateway(opts: StartOptions = {}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-app-admin-'))
  const owner_home = join(tmp, 'owner_home')
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const coresStore = new CoreInstallationsStore({ db })
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
  const restartSpy = { calls: 0 }
  const surfaceOpts: Parameters<typeof createAppAdminSurface>[0] = {
    auth,
    owner_home,
    project_slug: PROJECT_SLUG,
    restartGateway: () => {
      restartSpy.calls += 1
    },
  }
  if (opts.tier !== undefined) surfaceOpts.tier = opts.tier
  if (opts.withCores !== false) surfaceOpts.coresStore = coresStore
  if (opts.memoryStore !== undefined) surfaceOpts.memoryStore = opts.memoryStore
  const surface = createAppAdminSurface(surfaceOpts)
  const composed = composeHttpHandler({
    appAdmin: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const host = `gw-${++__gatewaySeq}.test`
  __composedHandlers.set(host, composed)
  return {
    base: `http://${host}`,
    tmp,
    owner_home,
    db,
    coresStore,
    restartSpy,
    close: async () => {
      __composedHandlers.delete(host)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function authedFetch(
  base: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', `Bearer ${init.token ?? 'dev:sam'}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  // strip our custom token field before passing to fetch
  const { token: _ignored, ...rest } = init
  void _ignored
  return fetch(`${base}${path}`, { ...rest, headers })
}

describe('app-admin — auth + project isolation', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('rejects requests without a Bearer token (401)', async () => {
    const res = await fetch(`${h.base}/api/app/admin/connectors`)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('returns 404 for unknown admin sub-routes', async () => {
    const res = await authedFetch(h.base, '/api/app/admin/unknown')
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('unknown_admin_route')
  })

  it('falls through (returns 404 from default handler) for non-admin paths', async () => {
    const res = await authedFetch(h.base, '/api/app/projects/xx/tasks')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not found')
  })

  it('rejects bearer that resolves to a different project (403)', async () => {
    // Spin up a second auth resolver issuing dev tokens for OTHER_OWNER
    // alongside the live surface. We do this by minting a token whose
    // claim doesn't match PROJECT_SLUG; the dev-bypass resolver maps
    // `dev:<user_id>` to its own project_slug, so we instead build the
    // surface with its own auth pinned to OTHER_OWNER and assert the
    // project_mismatch path.
    await h.close()
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-app-admin-mis-'))
    const owner_home = join(tmp, 'owner_home')
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    const otherAuth = createAppWsAuthResolver({ project_slug: OTHER_OWNER, bypass: true })
    const surface = createAppAdminSurface({
      auth: otherAuth,
      owner_home,
      project_slug: PROJECT_SLUG,
      restartGateway: () => {},
    })
    const composed = composeHttpHandler({
      appAdmin: { handler: surface.handler },
      defaultHandler: () => new Response('not found', { status: 404 }),
    })
    const host = `gw-${++__gatewaySeq}.test`
    __composedHandlers.set(host, composed)
    try {
      const res = await fetch(`http://${host}/api/app/admin/connectors`, {
        headers: { authorization: 'Bearer dev:sam' },
      })
      expect(res.status).toBe(403)
      const json = (await res.json()) as { code: string }
      expect(json.code).toBe('project_mismatch')
    } finally {
      __composedHandlers.delete(host)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    }
    h = await startGateway()
  })
})

describe('app-admin — legacy /personality route removed (ISSUE #31, 2026-05-23)', () => {
  // Regression guard: the legacy GET + PUT routes that wrote
  // `<owner_home>/persona/SOUL.md` + the vestigial tone/style
  // companion file were ripped out by ISSUE #31 because they
  // duplicated the canonical `/api/app/persona/*` surface (PR #280)
  // without an mtime guard. Both verbs must now fall through to the
  // surface's default `unknown_admin_route` 404, NOT a 405 or any
  // other status.
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  for (const method of ['GET', 'PUT'] as const) {
    it(`${method} returns 404 unknown_admin_route`, async () => {
      const init: RequestInit & { token?: string } = { method }
      if (method === 'PUT') {
        init.body = JSON.stringify({ persona_text: 'noop' })
      }
      const res = await authedFetch(h.base, '/api/app/admin/personality', init)
      expect(res.status).toBe(404)
      const json = (await res.json()) as { ok: boolean; code: string }
      expect(json.ok).toBe(false)
      expect(json.code).toBe('unknown_admin_route')
    })
  }
})

describe('app-admin — gateway restart', () => {
  it('Open tier — POST triggers the restart callback exactly once', async () => {
    const h = await startGateway({ tier: 'open' })
    try {
      const res = await authedFetch(h.base, '/api/app/admin/gateway/restart', {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as {
        ok: boolean
        triggered: boolean
        tier: string
        project_slug: string
      }
      expect(json.triggered).toBe(true)
      expect(json.tier).toBe('open')
      expect(json.project_slug).toBe(PROJECT_SLUG)
      // setImmediate defers the kill — wait one tick.
      await new Promise<void>((r) => setImmediate(r))
      expect(h.restartSpy.calls).toBe(1)
    } finally {
      await h.close()
    }
  })

  it('Managed tier — POST returns 503 + redirect_hint, never calls restart', async () => {
    const h = await startGateway({ tier: 'managed' })
    try {
      const res = await authedFetch(h.base, '/api/app/admin/gateway/restart', {
        method: 'POST',
      })
      expect(res.status).toBe(503)
      const json = (await res.json()) as {
        ok: boolean
        code: string
        redirect_hint: string
      }
      expect(json.ok).toBe(false)
      expect(json.code).toBe('restart_not_supported_on_managed')
      expect(json.redirect_hint).toBe('/admin/restart')
      await new Promise<void>((r) => setImmediate(r))
      expect(h.restartSpy.calls).toBe(0)
    } finally {
      await h.close()
    }
  })

  it('rejects GET with 405 method_not_allowed', async () => {
    const h = await startGateway()
    try {
      const res = await authedFetch(h.base, '/api/app/admin/gateway/restart')
      expect(res.status).toBe(405)
      const json = (await res.json()) as { code: string }
      expect(json.code).toBe('method_not_allowed')
      await new Promise<void>((r) => setImmediate(r))
      expect(h.restartSpy.calls).toBe(0)
    } finally {
      await h.close()
    }
  })
})

describe('app-admin — memory', () => {
  it('returns configured=false when no memory store is wired', async () => {
    const h = await startGateway()
    try {
      const res = await authedFetch(h.base, '/api/app/admin/memory')
      expect(res.status).toBe(200)
      const json = (await res.json()) as {
        ok: boolean
        configured: boolean
        stats: unknown
        entries: unknown[]
      }
      expect(json.ok).toBe(true)
      expect(json.configured).toBe(false)
      expect(json.stats).toBeNull()
      expect(json.entries).toEqual([])
    } finally {
      await h.close()
    }
  })

  it('returns stats + truncated entries when a memory store is wired', async () => {
    const memoryStore: MemoryStore = {
      async add() {
        return { id: 'noop' }
      },
      async query(input) {
        const limit = input.limit ?? 10
        const rows = [
          { id: 'm1', content: 'short note', metadata: {}, score: 0.9 },
          {
            id: 'm2',
            content: 'a much longer entry that the surface should truncate to 280 characters with an ellipsis once it goes past the cap. '.repeat(4),
            metadata: {},
            score: 0.7,
          },
        ]
        return rows.slice(0, limit)
      },
      async delete() {},
      async stats() {
        return { count: 42, size_bytes: 4096 }
      },
    }
    const h = await startGateway({ memoryStore })
    try {
      const res = await authedFetch(h.base, '/api/app/admin/memory')
      const json = (await res.json()) as {
        configured: boolean
        stats: { count: number; size_bytes: number }
        entries: Array<{ id: string; content_preview: string; score: number }>
      }
      expect(json.configured).toBe(true)
      expect(json.stats.count).toBe(42)
      expect(json.entries).toHaveLength(2)
      expect(json.entries[0]!.id).toBe('m1')
      expect(json.entries[0]!.content_preview).toBe('short note')
      // m2 should be truncated to 280 + ellipsis
      expect(json.entries[1]!.content_preview.endsWith('…')).toBe(true)
      expect(json.entries[1]!.content_preview.length).toBeLessThanOrEqual(281)
    } finally {
      await h.close()
    }
  })

  it('rejects non-GET with 405', async () => {
    const h = await startGateway()
    try {
      const res = await authedFetch(h.base, '/api/app/admin/memory', { method: 'POST' })
      expect(res.status).toBe(405)
    } finally {
      await h.close()
    }
  })
})

describe('app-admin — connectors', () => {
  it('returns an empty list when no Cores are installed', async () => {
    const h = await startGateway()
    try {
      const res = await authedFetch(h.base, '/api/app/admin/connectors')
      expect(res.status).toBe(200)
      const json = (await res.json()) as {
        ok: boolean
        configured: boolean
        connectors: unknown[]
      }
      expect(json.ok).toBe(true)
      expect(json.configured).toBe(true)
      expect(json.connectors).toEqual([])
    } finally {
      await h.close()
    }
  })

  it('lists live installations and excludes uninstalled rows', async () => {
    const h = await startGateway()
    try {
      await h.coresStore.record({
        owner_slug: PROJECT_SLUG,
        core_slug: 'tasks',
        package_name: '@neutronai/core-tasks',
        package_version: '0.1.0',
        capabilities: ['db.read', 'db.write'],
        data_layout: 'tables',
      })
      await h.coresStore.record({
        owner_slug: PROJECT_SLUG,
        core_slug: 'reminders',
        package_name: '@neutronai/core-reminders',
        package_version: '0.2.0',
        capabilities: ['db.read'],
        data_layout: 'tables',
      })
      await h.coresStore.markUninstalled(PROJECT_SLUG, 'reminders')
      const res = await authedFetch(h.base, '/api/app/admin/connectors')
      const json = (await res.json()) as {
        connectors: Array<{ slug: string; capabilities: string[] }>
      }
      expect(json.connectors).toHaveLength(1)
      expect(json.connectors[0]!.slug).toBe('tasks')
      expect(json.connectors[0]!.capabilities).toEqual(['db.read', 'db.write'])
    } finally {
      await h.close()
    }
  })

  it('does not leak other owners Core installations', async () => {
    const h = await startGateway()
    try {
      await h.coresStore.record({
        owner_slug: PROJECT_SLUG,
        core_slug: 'mine',
        package_name: '@neutronai/core-mine',
        package_version: '0.1.0',
        capabilities: [],
        data_layout: 'tables',
      })
      await h.coresStore.record({
        owner_slug: 'someone-else',
        core_slug: 'theirs',
        package_name: '@neutronai/core-theirs',
        package_version: '0.1.0',
        capabilities: [],
        data_layout: 'tables',
      })
      const res = await authedFetch(h.base, '/api/app/admin/connectors')
      const json = (await res.json()) as { connectors: Array<{ slug: string }> }
      const slugs = json.connectors.map((c) => c.slug)
      expect(slugs).toContain('mine')
      expect(slugs).not.toContain('theirs')
    } finally {
      await h.close()
    }
  })

  it('returns configured=false when no cores store is wired', async () => {
    const h = await startGateway({ withCores: false })
    try {
      const res = await authedFetch(h.base, '/api/app/admin/connectors')
      const json = (await res.json()) as { configured: boolean; connectors: unknown[] }
      expect(json.configured).toBe(false)
      expect(json.connectors).toEqual([])
    } finally {
      await h.close()
    }
  })
})
