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

import { describe, expect, it } from 'bun:test'
import { defaultHealthzHandler } from '../index.ts'

describe('default /healthz byte-identical', () => {
  const bootedAt = 1_000
  const handler = defaultHealthzHandler({ project_slug: 'demo', bootedAt })

  it('returns exactly {status, project_slug, uptime_ms} with a fixed shape', async () => {
    const res = await handler(new Request('http://x/healthz'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const body = (await res.json()) as Record<string, unknown>
    // Exactly these three keys — no diagnostics leak.
    expect(Object.keys(body).sort()).toEqual(['project_slug', 'status', 'uptime_ms'])
    expect(body.status).toBe('ok')
    expect(body.project_slug).toBe('demo')
    expect(typeof body.uptime_ms).toBe('number')
  })

  it('a ?deep=1 query changes NOTHING on the default handler', async () => {
    const plain = await handler(new Request('http://x/healthz'))
    const deep = await handler(new Request('http://x/healthz?deep=1'))
    expect(deep.status).toBe(plain.status)
    const [pb, db] = await Promise.all([plain.json(), deep.json()])
    // Same three keys, same static values (uptime_ms may differ by clock only).
    expect(Object.keys(db as object).sort()).toEqual(Object.keys(pb as object).sort())
    expect((db as { status: string }).status).toBe('ok')
    expect((db as { project_slug: string }).project_slug).toBe('demo')
  })

  it('non-healthz paths 404 unchanged', async () => {
    const res = await handler(new Request('http://x/whatever'))
    expect(res.status).toBe(404)
  })
})
