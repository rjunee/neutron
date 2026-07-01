/**
 * WAVE 3 — gateway app-tabs (tab-resolver) surface tests.
 *
 * Verifies the two read-only routes (`GET /api/app/projects/<id>/tabs` +
 * `GET /api/app/tabs`) round-trip through `composeHttpHandler` with the
 * dev-bypass auth resolver. WAVE 3 ships WITHOUT a feature flag (SPEC
 * Decisions Log, 2026-06-23) — the surface is ALWAYS on; there is no
 * `enabled`/`NEUTRON_TABS_REGISTRY` gate. Covers:
 *   - builtin-only surface (no Cores wired) → 200 + builtin descriptors
 *   - Core union (PR-2): per-project + global installed Cores fold their
 *     `project_tab` surfaces into the resolved set
 *   - auth, method, and project_id validation contracts
 *
 * Mirrors the in-process handler shim from app-launcher-surface.test.ts
 * (no real socket — composed.fetch is dispatched directly).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'
import { createAppTabsSurface } from '../http/app-tabs-surface.ts'
import type { TabDescriptor } from '../../tabs/registry.ts'
import { CoreInstallationsStore } from '../../cores/runtime/installations-store.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import type { CoresModuleState } from '../cores/composer-state.ts'
import type { BundledCore } from '../../cores/runtime/bundled-registry.ts'

// --- in-process handler shim (no socket) -------------------------------------
const __composedHandlers = new Map<string, ComposedHttpHandler>()
let __gatewaySeq = 0
const __realFetch = globalThis.fetch.bind(globalThis)
const fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input, init)
  const composed = __composedHandlers.get(new URL(req.url).host)
  if (composed !== undefined) return Promise.resolve(composed.fetch(req, undefined as never))
  return __realFetch(input as Parameters<typeof __realFetch>[0], init)
}) as typeof globalThis.fetch

interface Harness {
  base: string
  close(): Promise<void>
}

const PROJECT_ID = 'demo-project'
const PROJECT_SLUG = 'demo'

interface StartOptions {
  cores?: CoresModuleState
  installations?: CoreInstallationsStore
}

function startGateway(opts: StartOptions = {}): Harness {
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
  const surface = createAppTabsSurface({ auth, ...opts })
  const composed = composeHttpHandler({
    appTabs: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const host = `gw-${++__gatewaySeq}.test`
  __composedHandlers.set(host, composed)
  return {
    base: `http://${host}`,
    close: async () => {
      __composedHandlers.delete(host)
    },
  }
}

async function authedFetch(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', 'Bearer dev:sam')
  return fetch(`${base}${path}`, { ...init, headers })
}

interface TabsPayload {
  ok: boolean
  scope: string
  project_id?: string
  tabs: TabDescriptor[]
}

// --- helpers to build an in-memory installations store + fake cores state ----

function openStore(): { store: CoreInstallationsStore; db: ProjectDb } {
  const tmp = mkdtempSync(join(tmpdir(), 'app-tabs-surface-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  return { store: new CoreInstallationsStore({ db, now: () => 1_000_000 }), db }
}

/** A minimal fake CoresModuleState whose registry returns a single Core that
 *  declares a `project_tab` surface. Only the fields the surface reads are
 *  populated (`registry.get`, `launcherIcons`). */
function fakeCoresState(core: {
  slug: string
  entry_point: string
  label?: string
}): CoresModuleState {
  const bundled = {
    slug: core.slug,
    package_name: `@neutronai/${core.slug}`,
    package_version: '1.0.0',
    coreDir: `/fake/${core.slug}`,
    source: 'bundled',
    rootDir: '/fake',
    manifest: {
      capabilities: [],
      tier_support: ['regular'],
      tools: [],
      ui_components: [
        { name: `${core.slug}-tab`, entry_point: core.entry_point, surface: 'project_tab' },
      ],
      billing_hooks: [],
      linked_sources: [],
      secrets: [],
      compat: { coreApi: '1.0' },
      build: { neutronVersion: '1.0' },
    },
  } as unknown as BundledCore
  const launcherIcons = new Map<string, { label: string }>()
  if (core.label !== undefined) launcherIcons.set(core.slug, { label: core.label })
  return {
    registry: {
      get: (slug: string) => (slug === core.slug ? bundled : null),
      list: () => [bundled],
    },
    installed: new Map(),
    failures: [],
    launcherIcons,
  } as unknown as CoresModuleState
}

describe('app-tabs surface — builtin-only (no Cores wired)', () => {
  let harness: Harness
  beforeEach(() => {
    harness = startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('rejects requests without a Bearer token', async () => {
    const res = await fetch(`${harness.base}/api/app/projects/${PROJECT_ID}/tabs`)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('returns the builtin project tabs in order', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tabs`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as TabsPayload
    expect(json.ok).toBe(true)
    expect(json.scope).toBe('project')
    expect(json.project_id).toBe(PROJECT_ID)
    expect(json.tabs.map((t) => t.key)).toEqual(['chat', 'work_board', 'documents', 'settings'])
    expect(json.tabs.every((t) => t.source === 'builtin' && t.scope === 'project')).toBe(true)
  })

  it('returns only the builtin Admin global tab', async () => {
    const res = await authedFetch(harness.base, `/api/app/tabs`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as TabsPayload
    expect(json.scope).toBe('global')
    expect(json.tabs.map((t) => t.key)).toEqual(['admin'])
  })

  it('rejects a malformed project_id', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/has%20space/tabs`)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_project_id')
  })

  it('returns 405 for a non-GET method', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tabs`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(405)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('method_not_allowed')
  })

  it('still enforces Bearer auth on the global route', async () => {
    const res = await fetch(`${harness.base}/api/app/tabs`)
    expect(res.status).toBe(401)
  })
})

describe('app-tabs surface — Core union (PR-2)', () => {
  it('folds a PER-PROJECT-installed Core tab into the project set, with <project_id> substituted', async () => {
    const { store } = openStore()
    await store.record({
      project_slug: PROJECT_SLUG,
      core_slug: 'notes',
      package_name: '@neutronai/notes',
      package_version: '1.0.0',
      capabilities: [],
      data_layout: 'tables',
    })
    const cores = fakeCoresState({
      slug: 'notes',
      entry_point: '/projects/<project_id>/notes',
      label: 'Notes',
    })
    const harness = startGateway({ cores, installations: store })
    try {
      const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tabs`)
      expect(res.status).toBe(200)
      const json = (await res.json()) as TabsPayload
      expect(json.tabs.map((t) => t.key)).toEqual([
        'chat',
        'work_board',
        'documents',
        'settings',
        'core:notes',
      ])
      const notes = json.tabs.find((t) => t.key === 'core:notes')!
      expect(notes.source).toBe('core')
      expect(notes.core_slug).toBe('notes')
      expect(notes.label).toBe('Notes')
      expect(notes.mount).toEqual({ kind: 'webview', target: `/projects/${PROJECT_ID}/notes` })
    } finally {
      await harness.close()
    }
  })

  it('does NOT leak a per-project Core into the GLOBAL set', async () => {
    const { store } = openStore()
    await store.record({
      project_slug: PROJECT_SLUG,
      core_slug: 'notes',
      package_name: '@neutronai/notes',
      package_version: '1.0.0',
      capabilities: [],
      data_layout: 'tables',
    })
    const cores = fakeCoresState({ slug: 'notes', entry_point: '/projects/<project_id>/notes' })
    const harness = startGateway({ cores, installations: store })
    try {
      const res = await authedFetch(harness.base, `/api/app/tabs`)
      const json = (await res.json()) as TabsPayload
      expect(json.tabs.map((t) => t.key)).toEqual(['admin'])
    } finally {
      await harness.close()
    }
  })

  it('folds a GLOBALLY-installed Core tab into the global set (placeholder kept)', async () => {
    const { store } = openStore()
    await store.recordGlobal({
      core_slug: 'admin-core',
      package_name: '@neutronai/admin-core',
      package_version: '1.0.0',
      capabilities: [],
    })
    const cores = fakeCoresState({
      slug: 'admin-core',
      entry_point: '/projects/<project_id>/admin-core',
      label: 'Admin Core',
    })
    const harness = startGateway({ cores, installations: store })
    try {
      const res = await authedFetch(harness.base, `/api/app/tabs`)
      const json = (await res.json()) as TabsPayload
      expect(json.tabs.map((t) => t.key)).toEqual(['admin', 'core:admin-core'])
      const tab = json.tabs.find((t) => t.key === 'core:admin-core')!
      // Global scope keeps the <project_id> placeholder for the client.
      expect(tab.mount.target).toBe('/projects/<project_id>/admin-core')
    } finally {
      await harness.close()
    }
  })

  it('skips an uninstalled (tombstoned) global Core', async () => {
    const { store } = openStore()
    await store.recordGlobal({
      core_slug: 'admin-core',
      package_name: '@neutronai/admin-core',
      package_version: '1.0.0',
      capabilities: [],
    })
    await store.markGlobalUninstalled('admin-core')
    const cores = fakeCoresState({ slug: 'admin-core', entry_point: '/x/<project_id>' })
    const harness = startGateway({ cores, installations: store })
    try {
      const res = await authedFetch(harness.base, `/api/app/tabs`)
      const json = (await res.json()) as TabsPayload
      expect(json.tabs.map((t) => t.key)).toEqual(['admin'])
    } finally {
      await harness.close()
    }
  })
})

describe('app-tabs surface — non-owned paths', () => {
  it('disclaims unrelated /api/app/* paths so the chain keeps walking', async () => {
    const harness = startGateway()
    try {
      const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/launcher`)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('not found')
    } finally {
      await harness.close()
    }
  })
})
