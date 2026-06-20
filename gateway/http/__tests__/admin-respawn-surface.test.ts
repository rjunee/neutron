/**
 * admin-respawn-surface.test.ts — substrate-lift S2 § 2 row #13.
 *
 * Closes Argus r1 BLOCKING #2: the operator force-respawn handler was built +
 * unit-tested but NOTHING routed to it, so `POST /admin/respawn-session` was
 * unreachable in prod. These tests exercise the surface THROUGH the live compose
 * chain (`composeHttpHandler`) — the same path production mounts — proving the
 * route is reachable, token-gated, and disclaims (falls through) for any
 * path/method it doesn't own.
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import { composeHttpHandler } from '../compose.ts'
import { createAdminRespawnSurface } from '../admin-respawn-surface.ts'
import { resetAdminRespawnRateLimitForTest } from '../../../runtime/adapters/claude-code/persistent/admin-respawn-session.ts'
import type { RespawnOutcome } from '../../../runtime/adapters/claude-code/persistent/session-respawn.ts'

beforeEach(() => resetAdminRespawnRateLimitForTest())

const defaultHandler = (): Response => new Response('default', { status: 200 })
const ok = (sessionKey: string): RespawnOutcome => ({ ok: true, sessionKey, sessionId: 'uuid-x', initiatedAt: 1 })

function composedWithSurface(over: { token?: string; respawn?: (k: string) => RespawnOutcome } = {}) {
  const surface = createAdminRespawnSurface({
    gatewayToken: over.token ?? 'op-secret',
    respawn: over.respawn ?? ((k) => ok(k)),
  })
  return composeHttpHandler({ adminRespawn: { handler: surface.handler }, defaultHandler })
}

describe('POST /admin/respawn-session — mounted through the compose chain', () => {
  test('routes to the surface and force-respawns the resolved session key (202)', async () => {
    let seen = ''
    const composed = composedWithSurface({ respawn: (k) => { seen = k; return ok(k) } })
    const req = new Request('http://x/admin/respawn-session?session=capped-key', {
      method: 'POST',
      headers: { 'X-Gateway-Token': 'op-secret' },
    })
    const res = await composed.fetch(req, {} as never)
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ ok: true, session_key: 'capped-key', status: 'respawn-initiated' })
    expect(seen).toBe('capped-key') // the live route actuated the respawn
  })

  test('403 without the operator token (auth enforced on the live route)', async () => {
    const composed = composedWithSurface()
    const req = new Request('http://x/admin/respawn-session?session=k', { method: 'POST' })
    const res = await composed.fetch(req, {} as never)
    expect(res.status).toBe(403)
  })

  test('disclaims a non-POST method → falls through to defaultHandler', async () => {
    const composed = composedWithSurface()
    const req = new Request('http://x/admin/respawn-session?session=k', {
      method: 'GET',
      headers: { 'X-Gateway-Token': 'op-secret' },
    })
    const res = await composed.fetch(req, {} as never)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('default')
  })

  test('disclaims an unowned path → falls through to defaultHandler', async () => {
    const composed = composedWithSurface()
    const req = new Request('http://x/admin/something-else', {
      method: 'POST',
      headers: { 'X-Gateway-Token': 'op-secret' },
    })
    const res = await composed.fetch(req, {} as never)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('default')
  })

  test('two mounted surfaces have ISOLATED rate-limit windows (Codex P2)', async () => {
    // Two instance gateways in one process. Exhausting surface A's window must NOT
    // 429 surface B's operator recovery requests.
    const rl = { windowMs: 60_000, maxRequests: 2 }
    const surfaceA = createAdminRespawnSurface({ gatewayToken: 'tok', respawn: (k) => ok(k), rateLimit: rl })
    const surfaceB = createAdminRespawnSurface({ gatewayToken: 'tok', respawn: (k) => ok(k), rateLimit: rl })
    const composedA = composeHttpHandler({ adminRespawn: { handler: surfaceA.handler }, defaultHandler })
    const composedB = composeHttpHandler({ adminRespawn: { handler: surfaceB.handler }, defaultHandler })
    const mk = () =>
      new Request('http://x/admin/respawn-session?session=k', {
        method: 'POST',
        headers: { 'X-Gateway-Token': 'tok' },
      })
    // Exhaust A (2 ok, 3rd 429).
    expect((await composedA.fetch(mk(), {} as never)).status).toBe(202)
    expect((await composedA.fetch(mk(), {} as never)).status).toBe(202)
    expect((await composedA.fetch(mk(), {} as never)).status).toBe(429)
    // B is unaffected — its own window is fresh.
    expect((await composedB.fetch(mk(), {} as never)).status).toBe(202)
    expect((await composedB.fetch(mk(), {} as never)).status).toBe(202)
    expect((await composedB.fetch(mk(), {} as never)).status).toBe(429)
  })

  test('when no adminRespawn surface is wired the route is unbound (falls through)', async () => {
    const composed = composeHttpHandler({ defaultHandler })
    const req = new Request('http://x/admin/respawn-session?session=k', {
      method: 'POST',
      headers: { 'X-Gateway-Token': 'op-secret' },
    })
    const res = await composed.fetch(req, {} as never)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('default')
  })
})
