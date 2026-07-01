/**
 * P5.2 — gateway app-projects surface tests.
 *
 * Round-trips the two routes (GET + PATCH `/api/app/projects/<id>/settings`)
 * through `composeHttpHandler` with the dev-bypass auth resolver and
 * the in-memory `InMemoryProjectSettingsStore`. Mirrors the structure
 * of `gateway/__tests__/app-tasks-surface.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'
import {
  createAppProjectsSurface,
  InMemoryProjectSettingsStore,
  type ProjectSettings,
} from '../http/app-projects-surface.ts'

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
const fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input, init)
  const composed = __composedHandlers.get(new URL(req.url).host)
  if (composed !== undefined) return Promise.resolve(composed.fetch(req, undefined as never))
  return __realFetch(input as Parameters<typeof __realFetch>[0], init)
}) as typeof globalThis.fetch

interface Harness {
  base: string
  store: InMemoryProjectSettingsStore
  close(): Promise<void>
}

const PROJECT_SLUG = 'demo'
const PROJECT_ID = 'neutron'

async function startGateway(): Promise<Harness> {
  const store = new InMemoryProjectSettingsStore()
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
  const surface = createAppProjectsSurface({ store, auth })
  const composed = composeHttpHandler({
    appProjects: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const host = `gw-${++__gatewaySeq}.test`
  __composedHandlers.set(host, composed)
  return {
    base: `http://${host}`,
    store,
    close: async () => {
      __composedHandlers.delete(host)
    },
  }
}

async function authedFetch(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', 'Bearer dev:sam')
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

interface SettingsResponse {
  ok: boolean
  project: ProjectSettings
  project_id: string
  project_slug: string
}

describe('app-projects surface — GET /settings', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('rejects requests without a Bearer token', async () => {
    const res = await fetch(`${harness.base}/api/app/projects/${PROJECT_ID}/settings`)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('returns a canonical settings doc for a seeded project', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as SettingsResponse
    expect(json.ok).toBe(true)
    expect(json.project.id).toBe(PROJECT_ID)
    expect(json.project.name).toBe('Neutron')
    expect(json.project.privacy_mode).toBe('private')
    expect(json.project.billing_mode).toBe('personal')
    // Connect engagement mode defaults to all_messages (migration 0088): a
    // fresh group project behaves like a single-person chat out of the box.
    expect(json.project.agent_engagement_mode).toBe('all_messages')
    // Generic default shell — no hardcoded demo members (R6 removed the seed).
    expect(json.project.members).toEqual([])
  })

  it('seeds a default doc for an unknown project_id (humanised label)', async () => {
    const res = await authedFetch(harness.base, '/api/app/projects/fresh-proj/settings')
    expect(res.status).toBe(200)
    const json = (await res.json()) as SettingsResponse
    expect(json.project.id).toBe('fresh-proj')
    expect(json.project.name).toBe('Fresh Proj')
    expect(json.project.privacy_mode).toBe('private')
    expect(json.project.members).toEqual([])
  })

  it('rejects malformed project_id with 400 invalid_project_id', async () => {
    const res = await authedFetch(harness.base, '/api/app/projects/bad%20id/settings')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_project_id')
  })

  it('returns 405 on unexpected methods', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(405)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('method_not_allowed')
  })
})

describe('app-projects surface — PATCH /settings', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('PATCH privacy_mode persists + returns the canonical doc', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ privacy_mode: 'public' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as SettingsResponse
    expect(json.project.privacy_mode).toBe('public')

    // Re-read confirms the in-memory write survives:
    const reread = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/settings`,
    )
    const rereadJson = (await reread.json()) as SettingsResponse
    expect(rereadJson.project.privacy_mode).toBe('public')
  })

  it('PATCH agent_engagement_mode persists + round-trips (Connect 0088)', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ agent_engagement_mode: 'tag_gated' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as SettingsResponse
    expect(json.project.agent_engagement_mode).toBe('tag_gated')
    // privacy_mode is untouched by an engagement-only PATCH:
    expect(json.project.privacy_mode).toBe('private')

    // Re-read confirms the write survives:
    const reread = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/settings`,
    )
    const rereadJson = (await reread.json()) as SettingsResponse
    expect(rereadJson.project.agent_engagement_mode).toBe('tag_gated')
  })

  it('PATCH accepts privacy_mode + agent_engagement_mode together', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ privacy_mode: 'public', agent_engagement_mode: 'tag_gated' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as SettingsResponse
    expect(json.project.privacy_mode).toBe('public')
    expect(json.project.agent_engagement_mode).toBe('tag_gated')
  })

  it('PATCH emoji persists + round-trips (rail-redesign)', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ emoji: '🎯' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as SettingsResponse
    expect(json.project.emoji).toBe('🎯')
    const reread = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`)
    expect(((await reread.json()) as SettingsResponse).project.emoji).toBe('🎯')
  })

  it('PATCH rejects a non-emoji (plain text) emoji value', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ emoji: 'sparkles' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string; field?: string }
    expect(json.code).toBe('invalid_emoji')
    expect(json.field).toBe('emoji')
  })

  it('GET /settings returns a resolved default emoji for a fresh project', async () => {
    // 'neutron' → the ⚛️ keyword default (buildDefaultSettings).
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`)
    const json = (await res.json()) as SettingsResponse
    expect(typeof json.project.emoji).toBe('string')
    expect(json.project.emoji.length).toBeGreaterThan(0)
  })

  it('PATCH rejects invalid agent_engagement_mode values', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ agent_engagement_mode: 'whenever' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string; field?: string }
    expect(json.code).toBe('invalid_agent_engagement_mode')
    expect(json.field).toBe('agent_engagement_mode')
  })

  it('PATCH rejects fields other than privacy_mode with field_not_writable', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ persona: 'Sentinel' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string; field?: string }
    expect(json.code).toBe('field_not_writable')
    expect(json.field).toBe('persona')
  })

  it('PATCH rejects invalid privacy_mode values', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ privacy_mode: 'invalid' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string; field?: string }
    expect(json.code).toBe('invalid_privacy_mode')
    expect(json.field).toBe('privacy_mode')
  })

  it('PATCH with an empty body returns empty_patch', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('empty_patch')
  })

  it('PATCH with malformed JSON returns malformed_json', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/settings`, {
      method: 'PATCH',
      body: '{not json',
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('malformed_json')
  })

  it('PATCH without a Bearer token returns 401', async () => {
    const res = await fetch(`${harness.base}/api/app/projects/${PROJECT_ID}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ privacy_mode: 'public' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('app-projects surface — store isolation', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('two distinct projects do not bleed into each other on PATCH', async () => {
    const patchA = await authedFetch(harness.base, `/api/app/projects/neutron/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ privacy_mode: 'public' }),
    })
    expect(patchA.status).toBe(200)
    const readB = await authedFetch(harness.base, `/api/app/projects/acme/settings`)
    expect(readB.status).toBe(200)
    const jsonB = (await readB.json()) as SettingsResponse
    // acme is an independent generic-default shell — neutron's PATCH must not
    // bleed into it; it stays at the default 'private'.
    expect(jsonB.project.privacy_mode).toBe('private')
  })
})

interface ListResponse {
  ok: boolean
  projects: Array<ProjectSettings & { last_activity_at: string; unread_count: number }>
  project_slug: string
}

describe('app-projects surface — GET /api/app/projects (list)', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('rejects requests without a Bearer token (401 missing_bearer)', async () => {
    const res = await fetch(`${harness.base}/api/app/projects`)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('returns an empty list on a fresh project (starts empty until populated)', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as ListResponse
    expect(json.ok).toBe(true)
    expect(json.projects).toEqual([])
    expect(json.project_slug).toBe(PROJECT_SLUG)
  })

  it('returns every seeded project after their settings have been read', async () => {
    // Touching the per-project settings endpoint seeds the row in
    // the underlying store; the list endpoint then surfaces it.
    await authedFetch(harness.base, `/api/app/projects/neutron/settings`)
    await authedFetch(harness.base, `/api/app/projects/acme/settings`)
    const res = await authedFetch(harness.base, `/api/app/projects`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as ListResponse
    const ids = json.projects.map((p) => p.id).sort()
    expect(ids).toEqual(['acme', 'neutron'])
  })

  it('list items carry the rail-redesign fields (emoji, unread_count, last_activity_at)', async () => {
    await authedFetch(harness.base, `/api/app/projects/neutron/settings`)
    const res = await authedFetch(harness.base, `/api/app/projects`)
    const json = (await res.json()) as ListResponse
    const neutron = json.projects.find((p) => p.id === 'neutron')
    expect(neutron).toBeDefined()
    expect(typeof neutron!.emoji).toBe('string')
    expect(neutron!.emoji.length).toBeGreaterThan(0)
    expect(neutron!.unread_count).toBe(0)
    expect(typeof neutron!.last_activity_at).toBe('string')
  })

  it('returns 501 create_not_configured for POST when no create binding is wired', async () => {
    // This harness wires the surface without a `createProject` binding, so the
    // create route degrades gracefully (read-only / unconfigured deploy).
    const res = await authedFetch(harness.base, `/api/app/projects`, {
      method: 'POST',
      body: JSON.stringify({ name: 'whatever' }),
    })
    expect(res.status).toBe(501)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('create_not_configured')
  })
})

describe('app-projects surface — POST /api/app/projects (create)', () => {
  interface CreateHarness {
    base: string
    calls: Array<{ name: string; user_id: string; project_slug: string }>
    close(): Promise<void>
  }

  async function startCreateGateway(): Promise<CreateHarness> {
    const store = new InMemoryProjectSettingsStore()
    const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
    const calls: CreateHarness['calls'] = []
    const surface = createAppProjectsSurface({
      store,
      auth,
      createProject: async (input) => {
        calls.push(input)
        // Echo a deterministic slug so the test asserts the round-trip shape. A
        // name containing "deleted" simulates the soft-deleted-collision skip.
        const outcome = /deleted/i.test(input.name) ? 'skipped' : 'created'
        return {
          project_id: input.name.toLowerCase().replace(/\s+/g, '-'),
          name: input.name,
          outcome,
        }
      },
    })
    const composed = composeHttpHandler({
      appProjects: { handler: surface.handler },
      defaultHandler: () => new Response('not found', { status: 404 }),
    })
    const host = `gw-${++__gatewaySeq}.test`
    __composedHandlers.set(host, composed)
    return {
      base: `http://${host}`,
      calls,
      close: async () => {
        __composedHandlers.delete(host)
      },
    }
  }

  let harness: CreateHarness
  beforeEach(async () => {
    harness = await startCreateGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('rejects POST without a Bearer token (401 missing_bearer)', async () => {
    const res = await fetch(`${harness.base}/api/app/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Taxes' }),
    })
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
    expect(harness.calls).toEqual([])
  })

  it('rejects a missing/empty name with 400 invalid_name', async () => {
    for (const body of [{}, { name: '   ' }, { name: '' }]) {
      const res = await authedFetch(harness.base, `/api/app/projects`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
      const json = (await res.json()) as { code: string }
      expect(json.code).toBe('invalid_name')
    }
    expect(harness.calls).toEqual([])
  })

  it('creates a project and returns 201 with { project, created }', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects`, {
      method: 'POST',
      body: JSON.stringify({ name: '  My Taxes  ' }),
    })
    expect(res.status).toBe(201)
    const json = (await res.json()) as {
      ok: boolean
      project: { id: string; label: string }
      created: boolean
    }
    expect(json.ok).toBe(true)
    expect(json.created).toBe(true)
    expect(json.project).toEqual({ id: 'my-taxes', label: 'My Taxes' })
    // The binding receives the TRIMMED name + the resolved owner identity
    // (never an agent/client-supplied scope).
    expect(harness.calls).toEqual([
      { name: 'My Taxes', user_id: 'sam', project_slug: PROJECT_SLUG },
    ])
  })

  it('returns 409 project_deleted when the name maps to a soft-deleted project', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Deleted Thing' }),
    })
    expect(res.status).toBe(409)
    const json = (await res.json()) as { ok: boolean; code: string }
    expect(json.ok).toBe(false)
    expect(json.code).toBe('project_deleted')
  })
})
