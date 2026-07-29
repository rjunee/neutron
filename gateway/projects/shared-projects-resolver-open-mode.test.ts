/**
 * M2.5 — open-mode shared-projects resolution.
 *
 * In 'open' deployment mode the aggregator must use the single federated
 * multi-aud JWT as the bearer for every workspace (NOT the in-process minter,
 * which the Open client can't run — it has no signing key) and resolve base
 * URLs via the public ingress resolver.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildSharedProjectsResolver,
  type SharedProjectsResolverDeps,
} from './shared-projects-resolver.ts'
import type { Membership } from '@neutronai/jwt-validator/index.ts'
import type { UnifiedProjectListSource } from '@neutronai/connect/unified-project-list.ts'

const MEMBERSHIPS: Membership[] = [
  { slug: 'alice', role: 'owner', kind: 'user' },
  { slug: 'acme', role: 'member', kind: 'workspace' },
]

test('open mode stamps the CENTRAL kind:user membership slug as origin, NOT the local box slug', async () => {
  // Security boundary (Argus r2 #2): on a real Open deployment the local
  // self-host slug (`deps.user_instance_slug`) differs from the central-assigned
  // user slug carried in the federated JWT's memberships. The outbound origin
  // MUST be the central slug — the receiving workspace 403s `origin_not_a_member`
  // if it sees the local slug. The other open-mode tests use matching slugs, so
  // they can't catch a regression to `deps.user_instance_slug`; this pins the
  // divergent case (restores coverage lost when the old resolver test was removed
  // with the dead `open-instance-source-resolver`).
  const MEMBERSHIPS_DIVERGENT: Membership[] = [
    { slug: 'central-alice', role: 'owner', kind: 'user' },
    { slug: 'acme', role: 'member', kind: 'workspace' },
  ]
  let capturedUserSlug: string | undefined

  const deps: SharedProjectsResolverDeps = {
    user_instance_slug: 'local-box', // local self-host slug — deliberately != central
    membershipStore: { list: async () => MEMBERSHIPS_DIVERGENT },
    deployment_mode: 'open',
    federatedToken: async () => 'federated-multi-aud-jwt',
    openResolveBaseUrl: (slug) => `https://${slug}.neutron.example`,
    getUnifiedProjects: async (input) => {
      capturedUserSlug = input.user_instance_slug
      return { projects: [], source_errors: [] }
    },
  }

  const resolver = buildSharedProjectsResolver(deps)
  await resolver.fetch({ user_id: 'u-alice', project_slug: 'central-alice' })

  // The origin stamped for every outbound workspace request must be the central
  // membership slug, never the local box slug.
  expect(capturedUserSlug).toBe('central-alice')
  expect(capturedUserSlug).not.toBe('local-box')
})

test('open mode uses the federated JWT + open base-url resolver for every workspace', async () => {
  let capturedSources: ReadonlyArray<UnifiedProjectListSource> = []
  let federatedCalls = 0

  const deps: SharedProjectsResolverDeps = {
    user_instance_slug: 'alice',
    membershipStore: { list: async () => MEMBERSHIPS },
    deployment_mode: 'open',
    federatedToken: async () => {
      federatedCalls++
      return 'federated-multi-aud-jwt'
    },
    openResolveBaseUrl: (slug) => `https://${slug}.neutron.example`,
    // getActiveKey intentionally omitted — open mode must never reach it.
    getUnifiedProjects: async (input) => {
      capturedSources = input.instance_sources
      return {
        projects: [
          {
            project_id: 'p1',
            display_name: 'Q3 Marketing',
            kind: 'group',
            owning_instance_slug: 'acme',
          },
        ],
        source_errors: [],
      }
    },
  }

  const resolver = buildSharedProjectsResolver(deps)
  const result = await resolver.fetch({ user_id: 'u-alice', project_slug: 'alice' })

  expect(capturedSources).toHaveLength(1)
  expect(capturedSources[0]).toEqual({
    instance_slug: 'acme',
    base_url: 'https://acme.neutron.example',
    bearer_token: 'federated-multi-aud-jwt',
  })
  expect(federatedCalls).toBeGreaterThanOrEqual(1)
  expect(result.items).toHaveLength(1)
  expect(result.items[0]?.project_id).toBe('p1')
})

test('open mode skips the workspace when not connected (federatedToken null)', async () => {
  const deps: SharedProjectsResolverDeps = {
    user_instance_slug: 'alice',
    membershipStore: { list: async () => MEMBERSHIPS },
    deployment_mode: 'open',
    federatedToken: async () => null,
    openResolveBaseUrl: (slug) => `https://${slug}.neutron.example`,
    getUnifiedProjects: async (input) => {
      expect(input.instance_sources).toHaveLength(0)
      return { projects: [], source_errors: [] }
    },
  }
  const resolver = buildSharedProjectsResolver(deps)
  const result = await resolver.fetch({ user_id: 'u-alice', project_slug: 'alice' })
  expect(result.items).toHaveLength(0)
  // the workspace is reported as skipped (mint_failed) — graceful degradation
  expect(result.source_errors.some((e) => e.workspace_instance_slug === 'acme')).toBe(true)
})
