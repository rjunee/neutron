/**
 * C5 transition test — the landing route manifest (`landing/routes.ts`) is a
 * behavior-identical relocation of the pre-C5 `LANDING_PATHS` literal + the
 * `isLandingRoute` predicate that lived in `gateway/http/route-slots.ts`.
 *
 * `PRE_C5_LANDING_PATHS` below is a FROZEN byte-for-byte snapshot of that
 * deleted literal. The tests pin:
 *   1. the GENERATED `LANDING_ROUTE_PATHS` Set === the frozen literal (same
 *      members, same size — no addition/removal snuck in with the move), and
 *   2. `isLandingRoute` reproduces the exact three-arm decision (exact-set
 *      membership, the `/oauth/max/install-token` prefix, and the
 *      root-with-`?invite=` short-circuit), including the negative space.
 *
 * If a future edit changes the landing↔gateway routing contract, update BOTH
 * the manifest and this frozen snapshot in the same commit — the diff is the
 * audit trail for a routing change on the auth-adjacent surface.
 */

import { describe, expect, test } from 'bun:test'
import {
  isLandingRoute,
  LANDING_ROUTE_MANIFEST,
  LANDING_ROUTE_PATHS,
} from '../routes.ts'
// Consume through the GATEWAY barrel too, to prove the re-export chain
// (route-slots.ts → compose.ts) still resolves to the same single source.
import {
  isLandingRoute as gatewayIsLandingRoute,
  LANDING_ROUTE_PATHS as gatewayLandingRoutePaths,
} from '@neutronai/gateway/http/compose.ts'

/** FROZEN snapshot of the pre-C5 `route-slots.ts` `LANDING_PATHS` literal. */
const PRE_C5_LANDING_PATHS: readonly string[] = [
  '/chat',
  '/chat-react.js',
  '/api/v1/sign-up',
  '/invite',
  '/invite.js',
  '/onboarding/invite-accept',
  '/recover',
  '/start',
  '/api/v1/chat/history',
  '/api/v1/chat/topics',
  '/mobile',
  '/site.webmanifest',
  '/favicon.svg',
  '/apple-touch-icon.png',
]

describe('C5 landing route manifest — transition parity', () => {
  test('generated LANDING_ROUTE_PATHS === frozen pre-C5 literal', () => {
    expect(LANDING_ROUTE_PATHS.size).toBe(PRE_C5_LANDING_PATHS.length)
    for (const p of PRE_C5_LANDING_PATHS) {
      expect(LANDING_ROUTE_PATHS.has(p)).toBe(true)
    }
    // No EXTRA member snuck in beyond the frozen set.
    for (const p of LANDING_ROUTE_PATHS) {
      expect(PRE_C5_LANDING_PATHS.includes(p)).toBe(true)
    }
  })

  test('manifest declaration order matches the frozen literal', () => {
    expect([...LANDING_ROUTE_MANIFEST] as string[]).toEqual([...PRE_C5_LANDING_PATHS])
  })

  test('the gateway barrel re-exports the SAME single source', () => {
    // Identity, not just equality — route-slots.ts re-exports the imported
    // value rather than defining its own copy.
    expect(gatewayLandingRoutePaths).toBe(LANDING_ROUTE_PATHS)
    expect(gatewayIsLandingRoute).toBe(isLandingRoute)
  })

  describe('isLandingRoute — three-arm decision parity', () => {
    test('exact-path arm: every frozen path matches (GET, no invite)', () => {
      for (const p of PRE_C5_LANDING_PATHS) {
        expect(isLandingRoute(p, 'GET', false)).toBe(true)
      }
    })

    test('install-token prefix arm (variable trailing segment)', () => {
      expect(isLandingRoute('/oauth/max/install-token', 'GET', false)).toBe(true)
      expect(isLandingRoute('/oauth/max/install-token/initiate', 'POST', false)).toBe(true)
      expect(isLandingRoute('/oauth/max/install-token/abc123.sh', 'GET', false)).toBe(true)
      expect(isLandingRoute('/oauth/max/install-token/complete', 'GET', false)).toBe(true)
      expect(isLandingRoute('/oauth/max/install-token/state', 'GET', false)).toBe(true)
    })

    test('install-token prefix boundary — preserves the pre-C5 startsWith semantics', () => {
      // FAITHFUL RELOCATION: the pre-C5 `gateway/http/route-slots.ts:273` used
      // the identical bare `pathname.startsWith('/oauth/max/install-token')` with
      // NO trailing delimiter, so a sibling like `/oauth/max/install-tokenized`
      // ALSO matched. This test pins that byte-identical behavior so the C5 move
      // provably changed nothing (tightening the prefix would be a behavior
      // change — out of scope for this relocation — and is harmless anyway: the
      // landing `installTokenHandler` returns null on a non-handoff path, so the
      // request falls through to a 404 either way).
      expect(isLandingRoute('/oauth/max/install-tokenized', 'GET', false)).toBe(true)
      // Anything NOT under the prefix stays out.
      expect(isLandingRoute('/oauth/max/install', 'GET', false)).toBe(false)
      expect(isLandingRoute('/oauth/max', 'GET', false)).toBe(false)
    })

    test('root-with-?invite= short-circuit (GET only, requires the flag)', () => {
      expect(isLandingRoute('/', 'GET', true)).toBe(true)
      // Without the invite flag the bare root is NOT a landing route.
      expect(isLandingRoute('/', 'GET', false)).toBe(false)
      // POST / with invite is not the short-circuit (GET-only).
      expect(isLandingRoute('/', 'POST', true)).toBe(false)
    })

    test('negative space: non-landing paths fall through', () => {
      expect(isLandingRoute('/healthz', 'GET', false)).toBe(false)
      expect(isLandingRoute('/connect/v1/messages', 'POST', false)).toBe(false)
      expect(isLandingRoute('/ws/chat', 'GET', false)).toBe(false)
      expect(isLandingRoute('/ws/app/chat', 'GET', false)).toBe(false)
      expect(isLandingRoute('/api/app/projects', 'GET', false)).toBe(false)
      expect(isLandingRoute('/webhook/telegram', 'POST', false)).toBe(false)
    })
  })
})
