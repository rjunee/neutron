/**
 * M2.3 — `GET /api/app/projects` unified-list behavior. Covers the four
 * brief-mandated cases:
 *   (a) local-only when the user has no workspace memberships / no resolver
 *   (b) unified response merging local solo + shared workspace projects
 *   (c) graceful degradation when the shared resolver fails
 *   (d) origin_instance propagation + dedup (solo wins on collision)
 */

import { describe, expect, test } from 'bun:test'
import {
  createAppProjectsSurface,
  InMemoryProjectSettingsStore,
  type SharedProjectsResolver,
  type ProjectListItem,
} from '../app-projects-surface.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'

function fixedAuth(user_id: string, project_slug: string): AppWsAuthResolver {
  return {
    mode: 'dev-bypass',
    resolve: async () => ({ user_id, project_slug, mode: 'dev-bypass' }),
  }
}

async function seededStore(owner: string, ids: string[]): Promise<InMemoryProjectSettingsStore> {
  const store = new InMemoryProjectSettingsStore()
  // `get` auto-seeds the row so `list` returns it.
  for (const id of ids) await store.get(owner, id)
  return store
}

function getReq(): Request {
  return new Request('http://t/api/app/projects', {
    method: 'GET',
    headers: { authorization: 'Bearer dev:u-1' },
  })
}

interface ListBody {
  ok: boolean
  projects: ProjectListItem[]
  project_slug: string
  source_errors: Array<{ workspace_instance_slug: string; error: string }>
}

describe('GET /api/app/projects (M2.3 unified list)', () => {
  test('(a) local-only when no shared resolver is wired', async () => {
    const store = await seededStore('alice', ['neutron', 'northwind'])
    const surface = createAppProjectsSurface({ store, auth: fixedAuth('u-1', 'alice') })
    const res = await surface.handler(getReq())
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as ListBody
    expect(body.source_errors).toEqual([])
    expect(body.projects.map((p) => p.id).sort()).toEqual(['neutron', 'northwind'])
    for (const p of body.projects) {
      expect(p.kind).toBe('solo')
      expect(p.origin_instance).toBe('alice')
      expect(p.owning_instance_slug).toBe('alice')
    }
  })

  test('(b) unified: merges local solo + shared workspace projects', async () => {
    const store = await seededStore('alice', ['neutron'])
    const sharedProjects: SharedProjectsResolver = {
      fetch: async (args) => {
        expect(args.user_id).toBe('u-1')
        expect(args.project_slug).toBe('alice')
        return {
          items: [
            { project_id: 'roadmap', display_name: 'Acme Roadmap', owning_instance_slug: 'acme' },
          ],
          source_errors: [],
        }
      },
    }
    const surface = createAppProjectsSurface({ store, auth: fixedAuth('u-1', 'alice'), sharedProjects })
    const res = await surface.handler(getReq())
    const body = (await res!.json()) as ListBody

    const solo = body.projects.find((p) => p.id === 'neutron')!
    const shared = body.projects.find((p) => p.id === 'roadmap')!
    expect(solo.kind).toBe('solo')
    expect(shared.kind).toBe('shared')
    // (d) origin propagates end-to-end.
    expect(shared.origin_instance).toBe('acme')
    expect(shared.owning_instance_slug).toBe('acme')
    expect(shared.name).toBe('Acme Roadmap')
    // Shared items carry the canonical defaults (member doesn't own the origin
    // instance's billing config); R6 collapsed group_shared -> personal.
    expect(shared.billing_mode).toBe('personal')
    expect(body.source_errors).toEqual([])
  })

  test('(c) graceful degradation: a throwing resolver still returns local + a notice', async () => {
    const store = await seededStore('alice', ['neutron'])
    const sharedProjects: SharedProjectsResolver = {
      fetch: async () => {
        throw new Error('identity DB unreachable')
      },
    }
    const surface = createAppProjectsSurface({ store, auth: fixedAuth('u-1', 'alice'), sharedProjects })
    const res = await surface.handler(getReq())
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as ListBody
    expect(body.projects.map((p) => p.id)).toEqual(['neutron'])
    expect(body.source_errors).toHaveLength(1)
    expect(body.source_errors[0]!.error).toContain('identity DB unreachable')
  })

  test('(c2) per-workspace source_errors flow through from the resolver', async () => {
    const store = await seededStore('alice', ['neutron'])
    const sharedProjects: SharedProjectsResolver = {
      fetch: async () => ({
        items: [],
        source_errors: [{ workspace_instance_slug: 'acme', error: 'http_504' }],
      }),
    }
    const surface = createAppProjectsSurface({ store, auth: fixedAuth('u-1', 'alice'), sharedProjects })
    const res = await surface.handler(getReq())
    const body = (await res!.json()) as ListBody
    expect(body.source_errors).toEqual([{ workspace_instance_slug: 'acme', error: 'http_504' }])
  })

  test('(d) dedup: a shared item colliding with a local one is dropped (solo wins)', async () => {
    const store = await seededStore('alice', ['neutron'])
    const sharedProjects: SharedProjectsResolver = {
      fetch: async () => ({
        // Same (owning_instance_slug, id) as the local solo project.
        items: [{ project_id: 'neutron', display_name: 'Dupe', owning_instance_slug: 'alice' }],
        source_errors: [],
      }),
    }
    const surface = createAppProjectsSurface({ store, auth: fixedAuth('u-1', 'alice'), sharedProjects })
    const res = await surface.handler(getReq())
    const body = (await res!.json()) as ListBody
    const neutrons = body.projects.filter((p) => p.id === 'neutron')
    expect(neutrons).toHaveLength(1)
    expect(neutrons[0]!.kind).toBe('solo') // local wins
  })
})

describe('PATCH /settings — rail-refresh hook (rail-redesign)', () => {
  function patchReq(id: string, body: Record<string, unknown>): Request {
    return new Request(`http://t/api/app/projects/${id}/settings`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer dev:u-1', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('fires onRailFieldChanged for an emoji or name PATCH, NOT for privacy', async () => {
    const store = await seededStore('alice', ['neutron'])
    const calls: Array<{ user_id: string }> = []
    const surface = createAppProjectsSurface({
      store,
      auth: fixedAuth('u-1', 'alice'),
      onRailFieldChanged: (input) => calls.push(input),
    })

    // emoji → fires.
    const r1 = await surface.handler(patchReq('neutron', { emoji: '🎯' }))
    expect(r1!.status).toBe(200)
    expect(calls).toEqual([{ user_id: 'u-1' }])

    // name → fires.
    const r2 = await surface.handler(patchReq('neutron', { name: 'Neutron Prime' }))
    expect(r2!.status).toBe(200)
    expect(calls).toHaveLength(2)

    // privacy_mode → rail-invisible, does NOT fire.
    const r3 = await surface.handler(patchReq('neutron', { privacy_mode: 'public' }))
    expect(r3!.status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  test('a rejected emoji PATCH does not fire the hook', async () => {
    const store = await seededStore('alice', ['neutron'])
    const calls: Array<{ user_id: string }> = []
    const surface = createAppProjectsSurface({
      store,
      auth: fixedAuth('u-1', 'alice'),
      onRailFieldChanged: (input) => calls.push(input),
    })
    const res = await surface.handler(patchReq('neutron', { emoji: 'not-an-emoji' }))
    expect(res!.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})
