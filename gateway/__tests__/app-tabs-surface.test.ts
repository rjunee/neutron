/**
 * WAVE 3 PR-1 — gateway app-tabs (tab-resolver) surface tests.
 *
 * Verifies the two read-only routes (`GET /api/app/projects/<id>/tabs` +
 * `GET /api/app/tabs`) round-trip through `composeHttpHandler` with the
 * dev-bypass auth resolver, covering BOTH flag states:
 *   - flag ON  (`enabled:true`)  → 200 + builtin descriptors
 *   - flag OFF (`enabled:false`) → routes disclaim → default 404 chain
 * plus auth, method, and project_id validation contracts.
 *
 * Mirrors the in-process handler shim from app-launcher-surface.test.ts
 * (no real socket — composed.fetch is dispatched directly).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'
import { createAppTabsSurface } from '../http/app-tabs-surface.ts'
import type { TabDescriptor } from '../../tabs/registry.ts'

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

function startGateway(enabled: boolean): Harness {
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const surface = createAppTabsSurface({ auth, enabled })
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

describe('app-tabs surface — flag ON, project tabs', () => {
  let harness: Harness
  beforeEach(() => {
    harness = startGateway(true)
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
    expect(json.tabs.map((t) => t.key)).toEqual(['chat', 'documents', 'tasks'])
    expect(json.tabs.every((t) => t.source === 'builtin' && t.scope === 'project')).toBe(true)
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
})

describe('app-tabs surface — flag ON, global tabs', () => {
  let harness: Harness
  beforeEach(() => {
    harness = startGateway(true)
  })
  afterEach(async () => {
    await harness.close()
  })

  it('returns only the builtin Admin global tab', async () => {
    const res = await authedFetch(harness.base, `/api/app/tabs`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as TabsPayload
    expect(json.ok).toBe(true)
    expect(json.scope).toBe('global')
    expect(json.project_id).toBeUndefined()
    expect(json.tabs.map((t) => t.key)).toEqual(['admin'])
    expect(json.tabs[0]!.scope).toBe('global')
  })

  it('still enforces Bearer auth on the global route', async () => {
    const res = await fetch(`${harness.base}/api/app/tabs`)
    expect(res.status).toBe(401)
  })
})

describe('app-tabs surface — flag OFF (disclaim → 404)', () => {
  let harness: Harness
  beforeEach(() => {
    harness = startGateway(false)
  })
  afterEach(async () => {
    await harness.close()
  })

  it('404s the per-project route (falls through to the default chain)', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/tabs`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not found')
  })

  it('404s the global route', async () => {
    const res = await authedFetch(harness.base, `/api/app/tabs`)
    expect(res.status).toBe(404)
  })

  it('disclaims BEFORE auth — no 401 leaks the surface existence', async () => {
    // No bearer token, flag off: still a plain 404, not a 401.
    const res = await fetch(`${harness.base}/api/app/tabs`)
    expect(res.status).toBe(404)
  })
})

describe('app-tabs surface — non-owned paths', () => {
  it('disclaims unrelated /api/app/* paths so the chain keeps walking', async () => {
    const harness = startGateway(true)
    try {
      const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/launcher`)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('not found')
    } finally {
      await harness.close()
    }
  })
})
