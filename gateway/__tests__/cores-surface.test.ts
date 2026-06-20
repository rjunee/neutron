/**
 * P3 cores wire-up — `/api/cores` HTTP surface tests.
 *
 * Covers:
 *   - `GET /api/cores` returns the bundled-Cores catalog with per-row
 *     install state derived from `cores.installed` / `cores.failures`.
 *   - `GET /api/cores/<slug>` returns the full manifest + the
 *     `core_installations` row (when installed) or omits installation
 *     (when failed / not_installed).
 *   - 404 for an unknown slug.
 *   - 401 when no Authorization bearer is sent.
 *   - 405 on a wrong HTTP method.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { SecretsStore } from '../../auth/secrets-store.ts'
import { ToolRegistry } from '../../tools/registry.ts'
import { createAppWsAuthResolver } from '../../channels/index.ts'
import { CoreInstallationsStore } from '../../cores/runtime/installations-store.ts'
import { createCoresSurface } from '../http/cores-surface.ts'
import { installBundledCores } from '../cores/install-bundled.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const OWNER = 'surface-test'

// Deployment-mode-aware expectations — see cores-composition.test.ts. The
// Tier 2 staging Core `dtc_analytics` (under `cores/paid-staging/`) is
// stripped by the Sprint C Open carve, so the carved Open tree installs 6
// and the catalog row count drops by one. Derive from on-disk presence.
const HAS_PAID_STAGING = existsSync(join(REPO_ROOT, 'cores', 'paid-staging', 'dtc-analytics'))
const INSTALLED_SLUGS = [
  'codegen_core',
  'notes',
  'reminders_core',
  'research_core',
  'tasks_core',
  'agent_settings',
  ...(HAS_PAID_STAGING ? ['dtc_analytics'] : []),
].sort()
// total catalog rows = installed + the 2 manifest_invalid failures
// (calendar_core, email_managed_core).
const EXPECTED_CATALOG_LEN = INSTALLED_SLUGS.length + 2

interface Bench {
  ownerHome: string
  db: ProjectDb
  base: string
  server: import('bun').Server<unknown>
}

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    await fn()
  }
})

async function makeBench(): Promise<Bench> {
  const ownerHome = mkdtempSync(join(tmpdir(), 'neutron-cores-surface-'))
  cleanups.push(() => rmSync(ownerHome, { recursive: true, force: true }))
  const dbDir = join(ownerHome, 'db')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  const secrets = new SecretsStore({ data_dir: ownerHome, db })
  const tools = new ToolRegistry()
  const installations = new CoreInstallationsStore({ db })
  const cores = await installBundledCores({
    project_slug: OWNER,
    projectDb: db,
    dataDir: ownerHome,
    tools,
    secretsStore: secrets,
    rootDirs: [REPO_ROOT],
  })
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const surface = createCoresSurface({
    cores: {
      registry: cores.registry,
      installed: cores.installed,
      failures: cores.failures,
      launcherIcons: cores.launcherIcons,
    },
    installations,
    auth,
  })
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const r = await surface.handler(req)
      return r ?? new Response('not found', { status: 404 })
    },
  })
  cleanups.push(() => server.stop(true).then(() => undefined))
  return { ownerHome, db, base: `http://127.0.0.1:${server.port}`, server }
}

async function authedFetch(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', `Bearer dev:${OWNER}`)
  return fetch(`${base}${path}`, { ...init, headers })
}

describe('GET /api/cores', () => {
  let bench: Bench
  beforeEach(async () => {
    bench = await makeBench()
  })

  test('returns the bundled catalog with mixed install_state', async () => {
    const res = await authedFetch(bench.base, '/api/cores')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; cores: Array<{ slug: string; install_state: string; install_error?: { code: string } }> }
    expect(body.ok).toBe(true)
    // 8 Tier 1 free Cores + 1 Tier 2 staging Core (DTC Analytics) = 9 in the
    // monorepo / Managed tree. (agent_settings, the "tweak later" Core,
    // added 2026-06-03.) The Sprint C Open carve strips `cores/paid-staging/`,
    // so the carved Open tree returns 8; the Managed adapter's multi-root
    // walk re-surfaces the paid Core (per docs/research/neutron-cores-
    // marketplace-split-2026-05-17.md § 3).
    expect(body.cores).toHaveLength(EXPECTED_CATALOG_LEN)
    const installed = body.cores.filter((c) => c.install_state === 'installed').map((c) => c.slug).sort()
    const failed = body.cores.filter((c) => c.install_state === 'failed').map((c) => c.slug).sort()
    expect(installed).toEqual(INSTALLED_SLUGS)
    expect(failed).toEqual(['calendar_core', 'email_managed_core'])
    for (const c of body.cores.filter((c) => c.install_state === 'failed')) {
      expect(c.install_error?.code).toBe('manifest_invalid')
    }
  })

  test('rejects requests without a bearer token', async () => {
    const res = await fetch(`${bench.base}/api/cores`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('missing_bearer')
  })

  test('rejects non-GET methods', async () => {
    const res = await authedFetch(bench.base, '/api/cores', { method: 'POST' })
    expect(res.status).toBe(405)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.code).toBe('method_not_allowed')
  })
})

describe('GET /api/cores/:slug', () => {
  let bench: Bench
  beforeEach(async () => {
    bench = await makeBench()
  })

  test('returns full manifest + installation for an installed Core', async () => {
    const res = await authedFetch(bench.base, '/api/cores/notes')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      core: {
        slug: string
        install_state: string
        manifest: { capabilities: string[]; tools: unknown[] }
        installation?: { package_name: string; installed_at: number }
      }
    }
    expect(body.ok).toBe(true)
    expect(body.core.slug).toBe('notes')
    expect(body.core.install_state).toBe('installed')
    expect(body.core.manifest.capabilities).toContain('write:notes.db')
    expect(body.core.manifest.tools.length).toBeGreaterThan(0)
    expect(body.core.installation).toBeDefined()
    expect(body.core.installation?.package_name).toBe('@neutronai/notes')
    expect(body.core.installation?.installed_at).toBeGreaterThan(0)
  })

  test('returns manifest + install_error for a failed Core; no installation', async () => {
    const res = await authedFetch(bench.base, '/api/cores/calendar_core')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      core: {
        slug: string
        install_state: string
        install_error?: { code: string }
        installation?: unknown
      }
    }
    expect(body.core.slug).toBe('calendar_core')
    expect(body.core.install_state).toBe('failed')
    expect(body.core.install_error?.code).toBe('manifest_invalid')
    expect(body.core.installation).toBeUndefined()
  })

  test('returns 404 for an unknown slug', async () => {
    const res = await authedFetch(bench.base, '/api/cores/nope_doesnt_exist')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('unknown_core')
  })
})

describe('POST /api/cores/install + /api/cores/uninstall', () => {
  let bench: Bench
  beforeEach(async () => {
    bench = await makeBench()
  })

  test('install responds with requires_restart hint (mark-only, no live boot)', async () => {
    const res = await authedFetch(bench.base, '/api/cores/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'notes' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      slug: string
      requires_restart: boolean
      restart_hint: string
    }
    expect(body.ok).toBe(true)
    expect(body.slug).toBe('notes')
    expect(body.requires_restart).toBe(true)
    expect(body.restart_hint).toContain('/api/app/admin/gateway/restart')
  })

  test('uninstall responds with requires_restart hint (mark-only)', async () => {
    const res = await authedFetch(bench.base, '/api/cores/uninstall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'notes' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      slug: string
      requires_restart: boolean
      restart_hint: string
    }
    expect(body.ok).toBe(true)
    expect(body.requires_restart).toBe(true)
    expect(body.restart_hint).toContain('/api/app/admin/gateway/restart')
  })
})

describe('cores surface — pass-through', () => {
  let bench: Bench
  beforeEach(async () => {
    bench = await makeBench()
  })

  test('returns null (404 via the test fallback) for paths it does not own', async () => {
    const res = await fetch(`${bench.base}/api/something-else`)
    expect(res.status).toBe(404)
  })
})
