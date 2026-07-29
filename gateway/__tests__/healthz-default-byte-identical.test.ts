/**
 * O5 guardrail — the default `/healthz` handler must stay byte-identical.
 *
 * A monitoring probe hits `/healthz` with no query; O5 must not change its
 * shape, status, headers, or latency. This pins the exact contract of
 * `defaultHealthzHandler` so any accidental change (e.g. leaking diagnostics
 * into the default response) fails the build. O5 deliberately did NOT add a
 * `?deep=1` variant — exposing internal state on the unauthenticated liveness
 * probe conflicts with the owner-gate; diagnostics live behind
 * `GET /api/app/admin/diagnostics` instead.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { defaultHealthzHandler } from '../index.ts'

describe('default /healthz byte-identical', () => {
  const bootedAt = 1_000
  const FROZEN_NOW = 5_000 // → uptime_ms = 4000, exactly
  const handler = defaultHealthzHandler({ project_slug: 'demo', bootedAt })

  // Freeze the clock so we can assert the EXACT serialized bytes (uptime_ms is
  // the only clock-derived field).
  const realNow = Date.now
  beforeEach(() => {
    Date.now = () => FROZEN_NOW
  })
  afterEach(() => {
    Date.now = realNow
  })

  // The exact contract a monitoring probe depends on — bytes, not just fields.
  const EXPECTED_BODY = JSON.stringify({ status: 'ok', project_slug: 'demo', uptime_ms: 4000 })

  it('returns byte-identical body + headers for GET /healthz', async () => {
    const res = await handler(new Request('http://x/healthz'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    // No cache/security headers leaked in — the handler sets exactly one.
    expect([...res.headers.keys()]).toEqual(['content-type'])
    expect(await res.text()).toBe(EXPECTED_BODY)
  })

  it('a ?deep=1 query produces the BYTE-IDENTICAL default response', async () => {
    const plain = await handler(new Request('http://x/healthz'))
    const deep = await handler(new Request('http://x/healthz?deep=1'))
    expect(deep.status).toBe(plain.status)
    expect(await deep.text()).toBe(EXPECTED_BODY)
    expect([...deep.headers.keys()]).toEqual(['content-type'])
  })

  it('non-healthz paths 404 unchanged', async () => {
    const res = await handler(new Request('http://x/whatever'))
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('Not Found')
  })
})
