/**
 * HTTP surface test for `GET /api/app/usage`.
 *
 * The load-bearing assertion is that "nothing to report" is a 200 with a reason,
 * not an error status. Two clients render this, and making each of them infer a
 * display state from a status code is how the two would drift apart.
 */

import { describe, expect, it } from 'bun:test'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import type { CredentialUsagePayload } from '@neutronai/contracts/credential-usage.ts'

import { createAppUsageSurface } from '../http/app-usage-surface.ts'

const OWNER = 'demo'

function surfaceFor(payload: CredentialUsagePayload) {
  return createAppUsageSurface({
    auth: createAppWsAuthResolver({ project_slug: OWNER, bypass: true }),
    snapshot: () => payload,
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
