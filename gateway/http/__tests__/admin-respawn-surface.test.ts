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
import { resetAdminRespawnRateLimitForTest } from '@neutronai/runtime/adapters/claude-code/persistent/admin-respawn-session.ts'
import type { RespawnOutcome } from '@neutronai/runtime/adapters/claude-code/persistent/session-respawn.ts'

beforeEach(() => resetAdminRespawnRateLimitForTest())

test('cap rearm uses its independent authority callback, never the browser bearer', async () => {
  let releases = 0
  const surface = createAdminRespawnSurface({ gatewayToken: 'operator-secret',
    respawn: () => { throw new Error('cap rearm must not respawn') },
    authorizeCapRearm: value => (value as { signature?: string }).signature === 'operator-proof',
    rearmCap: async value => { if ((value as { signature?: string }).signature !== 'operator-proof') return false
      releases++; return true }, rateLimit: { windowMs: 60000, maxRequests: 1 } })
  const handler = composeHttpHandler({ adminRespawn: surface, defaultHandler })
  const body = { projectId: null, sessionKey: 'key', sessionId: 'session', childGeneration: 'generation', cappedAt: 100 }
  const call = (value: unknown, token?: string) => handler.fetch(new Request('http://x/admin/rearm-session-cap', {
    method: 'POST', headers: token ? { 'X-Gateway-Token': token } : {}, body: JSON.stringify(value),
  }), {} as never)
  expect((await call(body)).status).toBe(403)
  expect((await call(body, 'operator-secret')).status).toBe(403)
  expect((await call({ signature: 'operator-proof', padding: 'x'.repeat(65_536) })).status).toBe(403)
  expect(releases).toBe(0)
  expect((await call({ body, signature: 'operator-proof' })).status).toBe(200)
  expect(releases).toBe(1)
  expect((await call(body, 'operator-secret')).status).toBe(403)
  expect((await call({ body, signature: 'operator-proof' })).status).toBe(429)
  expect(releases).toBe(1)
})

const defaultHandler = (): Response => new Response('default', { status: 200 })

test('host-terminated reconciliation is owner authenticated, bounded and rate limited without invoking respawn or cap release', async () => {
  const seen: unknown[] = []
  const surface = createAdminRespawnSurface({ gatewayToken: 'owner-secret',
    respawn: () => { throw new Error('must not respawn') }, rearmCap: async () => { throw new Error('must not rearm') },
    reconcileTerminatedChat: async request => { seen.push(request); return { status: 'reconciled' } },
    rateLimit: { windowMs: 60000, maxRequests: 2 } })
  const handler = composeHttpHandler({ adminRespawn: surface, defaultHandler })
  const call = (request: unknown, token = 'owner-secret') => handler.fetch(new Request('http://x/admin/reconcile-host-terminated-chat', {
    method: 'POST', headers: { 'X-Gateway-Token': token }, body: JSON.stringify(request),
  }), {} as never)
  expect((await call({}, 'foreign')).status).toBe(403)
  expect(seen).toEqual([])
  expect((await call({ registry: 'x'.repeat(4 * 1024 * 1024) })).status).toBe(409)
  expect(seen).toEqual([])
  const request = { operationId: 'operation', projectId: 'project', bundle: '{}', registry: 'x'.repeat(70_000) }
  expect((await call(request)).status).toBe(200)
  expect(seen).toEqual([request])
  expect((await call(request)).status).toBe(429)
  expect(seen).toHaveLength(1)
})
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
