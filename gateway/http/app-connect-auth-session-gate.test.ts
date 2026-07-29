/**
 * M2.5 follow-up #6 (ISSUES #84, P1 security) — app-session gate on the
 * Open-mode connect auth surface.
 *
 * Proves all four routes 401 an UNAUTHENTICATED caller BEFORE any
 * FederatedTokenStore probe / mutation, and that an authenticated caller still
 * completes the legitimate flow. The attack this closes: a third party on a
 * publicly-reachable Open gateway hits `/callback?connect_code=<their own
 * code>` (overwriting the instance's federated credential) or `/disconnect`
 * (wiping it) with no app session.
 */

import { describe, expect, test } from 'bun:test'
import {
  createAppConnectAuthSurface,
  type AppConnectAuthClaim,
  type FederatedTokenStoreLike,
} from './app-connect-auth.ts'
import { type FederatedStatus } from '../connect/federated-token-store.ts'

const OWNER = 'alice'

/**
 * Build a surface with a store stub that COUNTS every method call, so a test
 * can assert "the store was never touched" after a 401. `claim` is what the
 * injected resolver returns — `null` means unauthenticated.
 */
function gatedSurface(opts: {
  claim: AppConnectAuthClaim | null
  project_slug?: string
}): {
  handler: (req: Request) => Promise<Response | null>
  calls: { connectViaRedeem: number; status: number; disconnect: number }
} {
  const calls = { connectViaRedeem: 0, status: 0, disconnect: 0 }
  const store: FederatedTokenStoreLike = {
    connectViaRedeem: async (): Promise<FederatedStatus> => {
      calls.connectViaRedeem++
      return { connected: true, user_instance_slug: OWNER }
    },
    status: async (): Promise<FederatedStatus> => {
      calls.status++
      return { connected: true, user_instance_slug: OWNER, refresh_expires_at_ms: 123 }
    },
    disconnect: async (): Promise<void> => {
      calls.disconnect++
    },
  }
  return {
    calls,
    handler: createAppConnectAuthSurface({
      store,
      auth_base_url: 'https://auth.neutron.example',
      resolveUserClaim: async () => opts.claim,
      project_slug: opts.project_slug ?? OWNER,
    }).handler,
  }
}

function req(path: string, method: string): Request {
  return new Request(`https://alice.local${path}`, { method })
}

describe('app-connect-auth session gate (ISSUES #84)', () => {
  test('unauthenticated GET /callback → 401, store NOT touched', async () => {
    const { handler, calls } = gatedSurface({ claim: null })
    const res = await handler(
      req('/api/app/connect/auth/callback?connect_code=attacker.code', 'GET'),
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
    // The mutation never ran — credential overwrite blocked BEFORE redeem.
    expect(calls.connectViaRedeem).toBe(0)
  })

  test('unauthenticated POST /disconnect → 401, store NOT touched', async () => {
    const { handler, calls } = gatedSurface({ claim: null })
    const res = await handler(req('/api/app/connect/auth/disconnect', 'POST'))
    expect(res!.status).toBe(401)
    // The wipe never ran.
    expect(calls.disconnect).toBe(0)
  })

  test('unauthenticated POST /start → 401', async () => {
    const { handler } = gatedSurface({ claim: null })
    const res = await handler(req('/api/app/connect/auth/start', 'POST'))
    expect(res!.status).toBe(401)
  })

  test('unauthenticated GET /status → 401, store NOT probed', async () => {
    const { handler, calls } = gatedSurface({ claim: null })
    const res = await handler(req('/api/app/connect/auth/status', 'GET'))
    expect(res!.status).toBe(401)
    // Connection-state leak blocked — `status()` never queried.
    expect(calls.status).toBe(0)
  })

  test('a connect cookie (claim.project_slug mismatch) → 401, store NOT touched', async () => {
    // Defense-in-depth: even a structurally-valid claim bound to a DIFFERENT
    // instance is rejected before any mutation.
    const { handler, calls } = gatedSurface({
      claim: { project_slug: 'mallory', user_id: 'u-mallory' },
      project_slug: OWNER,
    })
    const res = await handler(
      req('/api/app/connect/auth/callback?connect_code=x.y', 'GET'),
    )
    expect(res!.status).toBe(401)
    expect(calls.connectViaRedeem).toBe(0)
  })

  test('authenticated GET /callback with a valid code → 302 connected (flow still works)', async () => {
    const { handler, calls } = gatedSurface({
      claim: { project_slug: OWNER, user_id: 'u1' },
    })
    const res = await handler(
      req('/api/app/connect/auth/callback?connect_code=c1.s1', 'GET'),
    )
    expect(res!.status).toBe(302)
    expect(res!.headers.get('location')).toContain('connect=connected')
    expect(calls.connectViaRedeem).toBe(1)
  })

  test('authenticated POST /disconnect → 200 ok, credential cleared (flow still works)', async () => {
    const { handler, calls } = gatedSurface({
      claim: { project_slug: OWNER, user_id: 'u1' },
    })
    const res = await handler(req('/api/app/connect/auth/disconnect', 'POST'))
    expect(res!.status).toBe(200)
    expect(await res!.json()).toEqual({ ok: true })
    expect(calls.disconnect).toBe(1)
  })

  test('authenticated GET /status → 200 with connection state (flow still works)', async () => {
    const { handler, calls } = gatedSurface({
      claim: { project_slug: OWNER, user_id: 'u1' },
    })
    const res = await handler(req('/api/app/connect/auth/status', 'GET'))
    expect(res!.status).toBe(200)
    expect(await res!.json()).toEqual({
      connected: true,
      user_instance_slug: OWNER,
      refresh_expires_at_ms: 123,
    })
    expect(calls.status).toBe(1)
  })

  test('non-owned path still falls through (null) WITHOUT a 401 — composition intact', async () => {
    // A tokenless request to a sibling path must NOT be turned into a 401 that
    // shadows another surface; the handler disclaims it with `null`.
    const { handler } = gatedSurface({ claim: null })
    const res = await handler(req('/api/app/projects', 'GET'))
    expect(res).toBeNull()
  })

  test('owned path with the wrong method falls through (null), unauthenticated', async () => {
    // e.g. GET /start is not an owned (path, method) pair — it must fall
    // through rather than 401, so the auth gate never fires for it.
    const { handler } = gatedSurface({ claim: null })
    const res = await handler(req('/api/app/connect/auth/start', 'GET'))
    expect(res).toBeNull()
  })
})
