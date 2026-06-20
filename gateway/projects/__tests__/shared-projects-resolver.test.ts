/**
 * M2.3 — production shared-projects resolver: membership enumeration,
 * graceful degradation, the ~10s aggregate cache, and base-URL derivation.
 *
 * `getUnifiedProjects` is injected so these tests never hit the network —
 * the real fan-out is round-trip-tested in
 * `connect/__tests__/connect-api-server.test.ts` +
 * the managed-harness federated-token tests.
 */

import { describe, expect, test } from 'bun:test'
import { generateKeyPair } from 'jose'
import {
  buildSharedProjectsResolver,
  buildInstanceBaseUrl,
  AGGREGATE_CACHE_TTL_MS,
} from '../shared-projects-resolver.ts'
import type { Membership } from '@neutronai/jwt-validator/index.ts'
import type { UnifiedProjectListResult } from '@neutronai/connect/unified-project-list.ts'

// A real EdDSA key so the resolver's internal `mintInstanceToken` call
// actually signs (a stub `{}` key would throw → every workspace would be
// silently skipped as `mint_failed`, masking the merge logic under test).
const { privateKey } = await generateKeyPair('EdDSA', { extractable: true })
const FIXTURE_KEY = { kid: 'k1', privateKey }

function membershipStore(rows: Membership[]) {
  return { list: async () => rows }
}

describe('buildInstanceBaseUrl', () => {
  test('active workspace with a port → loopback URL', () => {
    expect(
      buildInstanceBaseUrl({ kind: 'workspace', status: 'active', port: 7100, subdomain: 'acme.neutron.example' }),
    ).toBe('http://127.0.0.1:7100')
  })
  test('active port-less workspace → subdomain URL', () => {
    expect(
      buildInstanceBaseUrl({ kind: 'workspace', status: 'active', port: null, subdomain: 'acme.neutron.example' }),
    ).toBe('https://acme.neutron.example')
  })
  test('non-workspace / non-active rows are not reachable', () => {
    expect(buildInstanceBaseUrl({ kind: 'user', status: 'active', port: 7100, subdomain: 's' })).toBeNull()
    expect(
      buildInstanceBaseUrl({ kind: 'workspace', status: 'provisioning', port: 7100, subdomain: 's' }),
    ).toBeNull()
  })
})

describe('buildSharedProjectsResolver', () => {
  const activeWorkspace = (slug: string) => ({
    kind: 'workspace',
    status: 'active',
    port: 7100,
    subdomain: `${slug}.neutron.example`,
  })

  test('no workspace memberships → empty items, no fan-out', async () => {
    let unifiedCalls = 0
    const resolver = buildSharedProjectsResolver({
      user_instance_slug: 'alice',
      membershipStore: membershipStore([{ slug: 'alice', role: 'owner', kind: 'user' }]),
      lookupInstance: () => undefined,
      getActiveKey: async () => FIXTURE_KEY,
      getUnifiedProjects: async () => {
        unifiedCalls += 1
        return { projects: [], source_errors: [] }
      },
      now: () => 1_000,
    })
    const res = await resolver.fetch({ user_id: 'u-alice', project_slug: 'alice' })
    expect(res.items).toEqual([])
    expect(res.source_errors).toEqual([])
    // No sources → we skip the fan-out entirely.
    expect(unifiedCalls).toBe(0)
  })

  test('merges workspace projects + propagates origin', async () => {
    const resolver = buildSharedProjectsResolver({
      user_instance_slug: 'alice',
      membershipStore: membershipStore([
        { slug: 'alice', role: 'owner', kind: 'user' },
        { slug: 'acme', role: 'member', kind: 'workspace' },
      ]),
      lookupInstance: (slug) => activeWorkspace(slug),
      getActiveKey: async () => FIXTURE_KEY,
      getUnifiedProjects: async (input): Promise<UnifiedProjectListResult> => {
        // The resolver passed exactly one source (acme) with a minted token.
        expect(input.instance_sources.map((s) => s.instance_slug)).toEqual(['acme'])
        expect(input.instance_sources[0]!.bearer_token.length).toBeGreaterThan(0)
        return {
          projects: [
            { project_id: 'roadmap', display_name: 'Roadmap', kind: 'group', owning_instance_slug: 'acme' },
          ],
          source_errors: [],
        }
      },
      now: () => 1_000,
    })
    const res = await resolver.fetch({ user_id: 'u-alice', project_slug: 'alice' })
    expect(res.items).toEqual([
      { project_id: 'roadmap', display_name: 'Roadmap', owning_instance_slug: 'acme' },
    ])
  })

  test('graceful degradation: a failed workspace surfaces in source_errors', async () => {
    const resolver = buildSharedProjectsResolver({
      user_instance_slug: 'alice',
      membershipStore: membershipStore([{ slug: 'acme', role: 'member', kind: 'workspace' }]),
      lookupInstance: (slug) => activeWorkspace(slug),
      getActiveKey: async () => FIXTURE_KEY,
      getUnifiedProjects: async () => ({
        projects: [],
        // connect-side fake return uses the renamed instance_slug field…
        source_errors: [{ instance_slug: 'acme', error: 'http_503' }],
      }),
      now: () => 1_000,
    })
    const res = await resolver.fetch({ user_id: 'u-alice', project_slug: 'alice' })
    expect(res.items).toEqual([])
    // …and the resolver translates it to the HTTP-contract workspace_instance_slug key.
    expect(res.source_errors).toEqual([{ workspace_instance_slug: 'acme', error: 'http_503' }])
  })

  test('an unreachable (un-provisioned) workspace is reported as no_base_url', async () => {
    const resolver = buildSharedProjectsResolver({
      user_instance_slug: 'alice',
      membershipStore: membershipStore([{ slug: 'ghost', role: 'member', kind: 'workspace' }]),
      lookupInstance: () => undefined, // not in the registry
      getActiveKey: async () => FIXTURE_KEY,
      getUnifiedProjects: async () => ({ projects: [], source_errors: [] }),
      now: () => 1_000,
    })
    const res = await resolver.fetch({ user_id: 'u-alice', project_slug: 'alice' })
    expect(res.source_errors).toEqual([{ workspace_instance_slug: 'ghost', error: 'no_base_url' }])
  })

  test('aggregate cache: a second call inside the TTL skips re-enumeration', async () => {
    let listCalls = 0
    let t = 1_000
    const resolver = buildSharedProjectsResolver({
      user_instance_slug: 'alice',
      membershipStore: {
        list: async () => {
          listCalls += 1
          return [{ slug: 'acme', role: 'member', kind: 'workspace' }]
        },
      },
      lookupInstance: (slug) => activeWorkspace(slug),
      getActiveKey: async () => FIXTURE_KEY,
      getUnifiedProjects: async () => ({
        projects: [{ project_id: 'p', display_name: 'P', kind: 'group', owning_instance_slug: 'acme' }],
        source_errors: [],
      }),
      now: () => t,
    })
    await resolver.fetch({ user_id: 'u-alice', project_slug: 'alice' })
    t += AGGREGATE_CACHE_TTL_MS - 1 // still inside the window
    await resolver.fetch({ user_id: 'u-alice', project_slug: 'alice' })
    expect(listCalls).toBe(1)

    // Past the TTL → re-enumerates.
    t += 2
    await resolver.fetch({ user_id: 'u-alice', project_slug: 'alice' })
    expect(listCalls).toBe(2)
  })

  test('invalidate(user_id) drops the aggregate cache', async () => {
    let listCalls = 0
    const resolver = buildSharedProjectsResolver({
      user_instance_slug: 'alice',
      membershipStore: {
        list: async () => {
          listCalls += 1
          return [{ slug: 'acme', role: 'member', kind: 'workspace' }]
        },
      },
      lookupInstance: (slug) => activeWorkspace(slug),
      getActiveKey: async () => FIXTURE_KEY,
      getUnifiedProjects: async () => ({ projects: [], source_errors: [] }),
      now: () => 1_000,
    })
    await resolver.fetch({ user_id: 'u-alice', project_slug: 'alice' })
    resolver.invalidate('u-alice')
    await resolver.fetch({ user_id: 'u-alice', project_slug: 'alice' })
    expect(listCalls).toBe(2)
  })
})
