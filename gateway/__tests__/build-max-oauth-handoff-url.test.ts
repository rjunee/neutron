/**
 * Argus r1 BLOCKER (2026-05-28) — URL-shape regression test for the
 * in-chat "Connect Claude Max" handoff.
 *
 * Context: the per-instance gateway wires a `maxOauthEngineHook` into
 * the InterviewEngine so a tap on the `attach_max` button at
 * `max_oauth_offered` produces a fresh `/oauth/max/start?...` URL the
 * user is sent to. The identity service's `/oauth/max/start` handler
 * (identity/oauth/max-handoff.ts:374-376) returns HTTP 400 "missing
 * start_token" without all three required query params — so a hook that
 * omits any of them silently bricks the Connect flow into a 400 page.
 *
 * The R1 PR shipped a hook that built the slug and return params but not
 * `start_token=`. Argus caught it on review. No test in the existing
 * maxOauth suite (engine-side `phase-max-oauth-offered-auto-skip.test.ts`
 * or gateway-side `build-default-realmode-composer.test.ts`) pinned
 * the rendered URL's query-param shape — that's the gap this file
 * closes. Argus quote: "adding one would have caught this."
 *
 * The helper under test is a pure synchronous function so it can be
 * exercised without the full composer boot — the failure mode is a
 * missing required field, which the typed signature already prevents
 * for callers (caller MUST pass `start_token`) and which a literal
 * URL assertion pins for the implementation.
 */

import { describe, expect, test } from 'bun:test'
import { buildMaxOauthHandoffUrl } from '../index.ts'

describe('buildMaxOauthHandoffUrl', () => {
  test('rendered URL carries non-empty start_token query param (Argus r1 BLOCKER pin)', () => {
    const url = buildMaxOauthHandoffUrl({
      project_slug: 'alice',
      identity_public_base_url: 'https://identity.neutron.example',
      base_domain: 'neutron.example',
      start_token: 'jwt-abc-123',
    })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('start_token')).toBe('jwt-abc-123')
    expect((parsed.searchParams.get('start_token') ?? '').length).toBeGreaterThan(0)
  })

  test('rendered URL carries owner + return + start_token together (all three required by identity handler)', () => {
    const url = buildMaxOauthHandoffUrl({
      project_slug: 'bob',
      identity_public_base_url: 'https://identity.neutron.example',
      base_domain: 'neutron.example',
      start_token: 'jwt-xyz-789',
    })
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/oauth/max/start')
    expect(parsed.searchParams.get('owner')).toBe('bob')
    expect(parsed.searchParams.get('return')).toBe(
      'https://bob.neutron.example/chat',
    )
    expect(parsed.searchParams.get('start_token')).toBe('jwt-xyz-789')
  })

  test('return URL slot is built from base_domain + project_slug (per-project subdomain)', () => {
    const url = buildMaxOauthHandoffUrl({
      project_slug: 'carol',
      identity_public_base_url: 'https://identity.example.dev',
      base_domain: 'example.dev',
      start_token: 'tok-1',
    })
    expect(new URL(url).searchParams.get('return')).toBe(
      'https://carol.example.dev/chat',
    )
  })

  test('identity_public_base_url origin is preserved (no accidental rewrite to localhost or production)', () => {
    const url = buildMaxOauthHandoffUrl({
      project_slug: 'dave',
      identity_public_base_url: 'http://localhost:9999',
      base_domain: 'neutron.example',
      start_token: 'tok-local',
    })
    const parsed = new URL(url)
    expect(parsed.origin).toBe('http://localhost:9999')
    expect(parsed.pathname).toBe('/oauth/max/start')
  })
})
