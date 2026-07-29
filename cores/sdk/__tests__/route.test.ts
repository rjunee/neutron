import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { buildDevPlatformJwtValidator } from '../auth.ts'
import {
  apiHandler,
  mountCoreRoutes,
} from '../route.ts'
import type { NeutronManifest } from '../manifest.ts'

function makeManifest(): NeutronManifest {
  return {
    capabilities: ['read:project.db'],
    tier_support: ['regular'],
    tools: [],
    ui_components: [
      {
        name: 'Admin',
        entry_point: './admin/index.tsx',
        surface: 'route_mount',
        mount_path: '/admin',
      },
    ],
    billing_hooks: [],
    linked_sources: [],
    secrets: [],
    compat: { coreApi: '^1.0.0' },
    build: { neutronVersion: '0.1.0' },
  }
}

function makeApp(): { app: Hono; adminMountPath: string | null } {
  const validator = buildDevPlatformJwtValidator({
    admin_email: 'user@example.com',
    bearer_token: 'dev-token',
    project_slug: 'topline',
    bypass_env_guard: true,
  })
  const app = new Hono()
  const { adminMountPath } = mountCoreRoutes(app, {
    core_id: '@neutronai/dtc-analytics',
    manifest: makeManifest(),
    validator,
  })
  return { app, adminMountPath }
}

describe('route — mountCoreRoutes', () => {
  test('GET /healthz is public and returns {ok: true}', async () => {
    const { app } = makeApp()
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })

  test('GET /healthz uses the override healthz body when supplied', async () => {
    const validator = buildDevPlatformJwtValidator({
      admin_email: 'user@example.com',
      bearer_token: 't',
      project_slug: 'topline',
      bypass_env_guard: true,
    })
    const app = new Hono()
    mountCoreRoutes(app, {
      core_id: 'x',
      manifest: makeManifest(),
      validator,
      healthz: () => ({ ok: true, last_sync_ts: 12345 }),
    })
    const res = await app.request('/healthz')
    const body = await res.json()
    expect(body).toEqual({ ok: true, last_sync_ts: 12345 })
  })

  test('GET /api route without Authorization header returns 401', async () => {
    const { app } = makeApp()
    app.get('/api/foo', (c) => c.json({ x: 1 }))
    const res = await app.request('/api/foo')
    expect(res.status).toBe(401)
  })

  test('GET /api route with malformed Authorization returns 401', async () => {
    const { app } = makeApp()
    app.get('/api/foo', (c) => c.json({ x: 1 }))
    const res = await app.request('/api/foo', {
      headers: { Authorization: 'Token dev-token' },
    })
    expect(res.status).toBe(401)
  })

  test('GET /api route with valid Bearer token reaches the handler with auth context', async () => {
    const { app } = makeApp()
    app.get(
      '/api/foo',
      apiHandler({
        manifest: makeManifest(),
        capability_required: 'read:project.db',
        handler: async (c, auth) => c.json({ slug: auth.project_slug, user: auth.user_id }),
      }),
    )
    const res = await app.request('/api/foo', {
      headers: { Authorization: 'Bearer dev-token' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ slug: 'topline', user: 'user@example.com' })
  })

  test('apiHandler returns 500 when capability not declared in manifest', async () => {
    const { app } = makeApp()
    app.get(
      '/api/bar',
      apiHandler({
        manifest: makeManifest(),
        capability_required: 'write:project.db',
        handler: async (c) => c.json({ x: 1 }),
      }),
    )
    const res = await app.request('/api/bar', {
      headers: { Authorization: 'Bearer dev-token' },
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('misconfigured')
  })

  test('admin mount path resolves from manifest route_mount component', async () => {
    const { adminMountPath } = makeApp()
    expect(adminMountPath).toBe('/admin')
  })

  test('admin mount path is null when no route_mount surface declared', () => {
    const validator = buildDevPlatformJwtValidator({
      admin_email: 'r',
      bearer_token: 't',
      project_slug: 'topline',
      bypass_env_guard: true,
    })
    const manifest: NeutronManifest = {
      ...makeManifest(),
      ui_components: [
        { name: 'L', entry_point: './l.tsx', surface: 'launcher_icon' },
      ],
    }
    const app = new Hono()
    const { adminMountPath } = mountCoreRoutes(app, {
      core_id: 'x',
      manifest,
      validator,
    })
    expect(adminMountPath).toBe(null)
  })

  test('admin mount path requires Bearer auth', async () => {
    const { app, adminMountPath } = makeApp()
    expect(adminMountPath).toBe('/admin')
    app.get('/admin/index.html', (c) => c.text('<html>'))
    const unauth = await app.request('/admin/index.html')
    expect(unauth.status).toBe(401)
    const ok = await app.request('/admin/index.html', {
      headers: { Authorization: 'Bearer dev-token' },
    })
    expect(ok.status).toBe(200)
  })

  test('GET /api (bare root) without Authorization returns 401 (Codex r2 P2)', async () => {
    // Same root-path edge case as admin: Hono's /api wildcard glob doesn't
    // match the bare /api segment. The fix registers auth on both.
    const { app } = makeApp()
    app.get('/api', (c) => c.json({ x: 1 }))
    const unauth = await app.request('/api')
    expect(unauth.status).toBe(401)
    const ok = await app.request('/api', {
      headers: { Authorization: 'Bearer dev-token' },
    })
    expect(ok.status).toBe(200)
  })

  test('admin mount ROOT requires Bearer auth (Codex r1 P1)', async () => {
    // Hono's /admin/* glob does NOT match the bare /admin segment.
    // The fix registers auth on both the bare path and the wildcard.
    const { app, adminMountPath } = makeApp()
    expect(adminMountPath).toBe('/admin')
    app.get('/admin', (c) => c.text('<html>spa shell</html>'))
    const unauth = await app.request('/admin')
    expect(unauth.status).toBe(401)
    const ok = await app.request('/admin', {
      headers: { Authorization: 'Bearer dev-token' },
    })
    expect(ok.status).toBe(200)
  })
})
