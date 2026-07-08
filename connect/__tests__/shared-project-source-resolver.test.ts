/**
 * Shared-project source resolver: memberships → UnifiedProjectListSource[]
 * (connect-spec §1.7).
 */

import { describe, expect, test } from 'bun:test'
import { resolveSharedProjectSources } from '../shared-project-source-resolver.ts'
import type { Membership } from '@neutronai/jwt-validator/index.ts'

const MEMBERSHIPS: Membership[] = [
  { slug: 'alice', role: 'owner', kind: 'user' }, // own user instance — must be skipped
  { slug: 'acme', role: 'member', kind: 'workspace' },
  { slug: 'beta-co', role: 'admin', kind: 'workspace' },
]

describe('resolveSharedProjectSources', () => {
  test('builds one source per shared-project membership, skipping the own instance', async () => {
    const res = await resolveSharedProjectSources({
      user_instance_slug: 'alice',
      memberships: MEMBERSHIPS,
      resolveBaseUrl: (slug) => `http://127.0.0.1/${slug}`,
      mintToken: async (slug) => `tok-${slug}`,
    })
    expect(res.sources).toEqual([
      { instance_slug: 'acme', base_url: 'http://127.0.0.1/acme', bearer_token: 'tok-acme' },
      {
        instance_slug: 'beta-co',
        base_url: 'http://127.0.0.1/beta-co',
        bearer_token: 'tok-beta-co',
      },
    ])
    expect(res.skipped).toEqual([])
  })

  test('a user with no shared-project memberships yields zero sources', async () => {
    const res = await resolveSharedProjectSources({
      user_instance_slug: 'alice',
      memberships: [{ slug: 'alice', role: 'owner', kind: 'user' }],
      resolveBaseUrl: () => 'http://x',
      mintToken: async () => 'tok',
    })
    expect(res.sources).toEqual([])
    expect(res.skipped).toEqual([])
  })

  test('skips (does not throw on) a host with no resolvable base URL', async () => {
    const res = await resolveSharedProjectSources({
      user_instance_slug: 'alice',
      memberships: MEMBERSHIPS,
      resolveBaseUrl: (slug) => (slug === 'acme' ? null : `http://127.0.0.1/${slug}`),
      mintToken: async (slug) => `tok-${slug}`,
    })
    expect(res.sources.map((s) => s.instance_slug)).toEqual(['beta-co'])
    expect(res.skipped).toEqual([{ instance_slug: 'acme', reason: 'no_base_url' }])
  })

  test('skips a host whose token fails to mint', async () => {
    const res = await resolveSharedProjectSources({
      user_instance_slug: 'alice',
      memberships: MEMBERSHIPS,
      resolveBaseUrl: (slug) => `http://127.0.0.1/${slug}`,
      mintToken: async (slug) => (slug === 'beta-co' ? null : `tok-${slug}`),
    })
    expect(res.sources.map((s) => s.instance_slug)).toEqual(['acme'])
    expect(res.skipped).toEqual([{ instance_slug: 'beta-co', reason: 'mint_failed' }])
  })

  test('dedups a duplicated host slug in the membership list', async () => {
    let mints = 0
    const res = await resolveSharedProjectSources({
      user_instance_slug: 'alice',
      memberships: [
        { slug: 'acme', role: 'member', kind: 'workspace' },
        { slug: 'acme', role: 'member', kind: 'workspace' },
      ],
      resolveBaseUrl: (slug) => `http://127.0.0.1/${slug}`,
      mintToken: async (slug) => {
        mints += 1
        return `tok-${slug}`
      },
    })
    expect(res.sources).toHaveLength(1)
    expect(mints).toBe(1)
  })
})
