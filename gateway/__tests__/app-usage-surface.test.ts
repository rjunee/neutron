/**
 * HTTP surface test for `GET /api/app/usage` and `GET /api/app/usage/dashboard`.
 *
 * The load-bearing assertion is that "nothing to report" is a 200 with a reason,
 * not an error status. Two clients render this, and making each of them infer a
 * display state from a status code is how the two would drift apart.
 *
 * The second load-bearing assertion is that the two paths do not swallow each
 * other. The meter's path is a strict prefix of the dashboard's, so a single
 * `startsWith` anywhere in this file's history would have served the meter's body
 * from the dashboard's URL — a wrong answer with a 200, which no client could
 * detect.
 */

import { describe, expect, it } from 'bun:test'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import type { CredentialUsagePayload } from '@neutronai/contracts/credential-usage.ts'
import type { PoolSummary } from '@neutronai/persistence/usage-samples-store.ts'

import { createAppUsageSurface } from '../http/app-usage-surface.ts'

const OWNER = 'demo'

/** A pool with nothing recorded — the shape a first render actually gets. */
const EMPTY_POOL: PoolSummary = {
  pool: 'anthropic',
  measured_at: null,
  account_label: null,
  session: null,
  weekly: null,
}

function surfaceFor(
  payload: CredentialUsagePayload,
  pools: ReadonlyArray<PoolSummary> = [EMPTY_POOL],
) {
  return createAppUsageSurface({
    auth: createAppWsAuthResolver({ project_slug: OWNER, bypass: true }),
    snapshot: () => payload,
    dashboard: () => pools,
  })
}

function authedDashboardGet(): Request {
  return new Request('https://box.example.com/api/app/usage/dashboard', {
    headers: { authorization: 'Bearer any-token' },
  })
}

function authedGet(): Request {
  return new Request('https://box.example.com/api/app/usage', {
    headers: { authorization: 'Bearer any-token' },
  })
}

describe('GET /api/app/usage', () => {
  it('serves a measured reading', async () => {
    const surface = surfaceFor({
      available: true,
      session: 0.17,
      weekly: 0.34,
      measured_at: 1_700_000_000_000,
    })
    const res = await surface.handler(authedGet())
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({
      available: true,
      session: 0.17,
      weekly: 0.34,
      measured_at: 1_700_000_000_000,
    })
  })

  it('serves "nothing to report" as a 200 with a reason, never as an error status', async () => {
    const surface = surfaceFor({ available: false, reason: 'no_credential' })
    const res = await surface.handler(authedGet())
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ available: false, reason: 'no_credential' })
  })

  it('rejects an unauthenticated read — utilization is owner-only', async () => {
    const surface = surfaceFor({ available: false, reason: 'no_credential' })
    const res = await surface.handler(new Request('https://box.example.com/api/app/usage'))
    expect(res?.status).toBe(401)
  })

  it('rejects a non-GET', async () => {
    const surface = surfaceFor({ available: false, reason: 'no_credential' })
    const res = await surface.handler(
      new Request('https://box.example.com/api/app/usage', {
        method: 'POST',
        headers: { authorization: 'Bearer any-token' },
      }),
    )
    expect(res?.status).toBe(405)
  })

  it('falls through for any other path so sibling surfaces still see the request', async () => {
    const surface = surfaceFor({ available: false, reason: 'no_credential' })
    expect(await surface.handler(new Request('https://box.example.com/api/app/tabs'))).toBeNull()
  })
})

describe('GET /api/app/usage/dashboard', () => {
  const MEASURED: PoolSummary = {
    pool: 'anthropic',
    measured_at: 1_700_000_000_000,
    account_label: null,
    session: {
      fraction: 0.75,
      reset_at: 1_700_009_000_000,
      resets_in_ms: 9_000_000,
      pace: 1.5,
      exhausts_at: 1_700_003_000_000,
    },
    weekly: { fraction: 0.36, reset_at: null, resets_in_ms: null, pace: null, exhausts_at: null },
  }

  it('serves the summarised series under a `pools` array', async () => {
    const surface = surfaceFor({ available: false, reason: 'no_credential' }, [MEASURED])
    const res = await surface.handler(authedDashboardGet())
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ pools: [MEASURED] })
  })

  it('serves an empty series as null windows, not as an error', async () => {
    // A dashboard whose first render is a failure state teaches the owner to
    // distrust it. "No readings yet" is a display state, so it is a 200.
    const surface = surfaceFor({ available: false, reason: 'no_credential' })
    const res = await surface.handler(authedDashboardGet())
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ pools: [EMPTY_POOL] })
  })

  it('does NOT serve the meter body from the dashboard path', async () => {
    // The regression this exists for: `/api/app/usage` is a strict prefix of
    // `/api/app/usage/dashboard`, so a prefix match on the meter would answer
    // here with `{available:…}` and a 200. The dashboard client would decode
    // that to "no pools" and render an empty card forever.
    const surface = surfaceFor(
      { available: true, session: 0.5, weekly: 0.5, measured_at: 1 },
      [MEASURED],
    )
    const body = (await (await surface.handler(authedDashboardGet()))?.json()) as Record<
      string,
      unknown
    >
    expect(body['available']).toBeUndefined()
    expect(Array.isArray(body['pools'])).toBe(true)
  })

  it('does NOT serve the dashboard body from the meter path', async () => {
    // The mirror case. Both directions are checked because a prefix bug in
    // either handler produces a 200 with the wrong body, and a test that only
    // pins one direction leaves the other free to break.
    const surface = surfaceFor(
      { available: true, session: 0.5, weekly: 0.5, measured_at: 1 },
      [MEASURED],
    )
    const body = (await (await surface.handler(authedGet()))?.json()) as Record<string, unknown>
    expect(body['pools']).toBeUndefined()
    expect(body['available']).toBe(true)
  })

  it('rejects an unauthenticated dashboard read', async () => {
    const surface = surfaceFor({ available: false, reason: 'no_credential' }, [MEASURED])
    const res = await surface.handler(
      new Request('https://box.example.com/api/app/usage/dashboard'),
    )
    expect(res?.status).toBe(401)
  })

  it('rejects a non-GET on the dashboard, and names the path it rejected', async () => {
    const surface = surfaceFor({ available: false, reason: 'no_credential' }, [MEASURED])
    const res = await surface.handler(
      new Request('https://box.example.com/api/app/usage/dashboard', {
        method: 'DELETE',
        headers: { authorization: 'Bearer any-token' },
      }),
    )
    expect(res?.status).toBe(405)
    // The message used to hardcode the meter's path; on the dashboard that would
    // tell the caller to GET a different URL than the one they asked about.
    expect(((await res?.json()) as { message: string }).message).toContain('/api/app/usage/dashboard')
  })
})
