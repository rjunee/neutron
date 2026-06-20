/**
 * admin-respawn-session.test.ts — the operator force-recover endpoint
 * (S2 § 2 row #13 / DoD "admin-respawn-session live; clears capped_at").
 * Covers the pure status mapping + the Request adapter's auth + rate-limit +
 * param resolution.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  handleAdminRespawnSession,
  handleAdminRespawnSessionRequest,
  resetAdminRespawnRateLimitForTest,
  type AdminRespawnRequestDeps,
} from '../admin-respawn-session.ts'
import type { RespawnOutcome } from '../session-respawn.ts'

beforeEach(() => resetAdminRespawnRateLimitForTest())

const ok = (sessionKey: string): RespawnOutcome => ({ ok: true, sessionKey, sessionId: 'uuid-x', initiatedAt: 1 })

describe('handleAdminRespawnSession — status mapping', () => {
  it('400 on empty session key', () => {
    expect(handleAdminRespawnSession('', { respawn: () => ok('k') }).status).toBe(400)
  })

  it('202 respawn-initiated on success', () => {
    const res = handleAdminRespawnSession('k', { respawn: () => ok('k') })
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ ok: true, session_key: 'k', status: 'respawn-initiated' })
  })

  it('404 session-not-found', () => {
    const res = handleAdminRespawnSession('k', { respawn: () => ({ ok: false, reason: 'session-not-found' }) })
    expect(res.status).toBe(404)
  })

  it('409 no-session-to-resume', () => {
    const res = handleAdminRespawnSession('k', { respawn: () => ({ ok: false, reason: 'no-session-to-resume' }) })
    expect(res.status).toBe(409)
  })

  it('502 spawn-cwd-invalid', () => {
    const res = handleAdminRespawnSession('k', { respawn: () => ({ ok: false, reason: 'spawn-cwd-invalid' }) })
    expect(res.status).toBe(502)
  })

  it('500 for a generic spawn failure', () => {
    const res = handleAdminRespawnSession('k', { respawn: () => ({ ok: false, reason: 'spawn-failed' }) })
    expect(res.status).toBe(500)
  })
})

describe('handleAdminRespawnSessionRequest — auth + rate-limit + params', () => {
  function deps(over: Partial<AdminRespawnRequestDeps> = {}): AdminRespawnRequestDeps {
    return { gatewayToken: 'secret', respawn: (k) => ok(k), ...over }
  }

  it('403 without the gateway token', async () => {
    const req = new Request('http://x/admin/respawn-session?session=k', { method: 'POST' })
    const res = await handleAdminRespawnSessionRequest(req, deps())
    expect(res.status).toBe(403)
  })

  it('403 on a wrong token (constant-time compare) — same length and different length', async () => {
    for (const bad of ['secreX', 'wrong-and-longer', '']) {
      const req = new Request('http://x/admin/respawn-session?session=k', {
        method: 'POST',
        headers: { 'X-Gateway-Token': bad },
      })
      const res = await handleAdminRespawnSessionRequest(req, deps())
      expect(res.status).toBe(403)
    }
  })

  it('202 with the token + ?session= query param', async () => {
    const req = new Request('http://x/admin/respawn-session?session=k', {
      method: 'POST',
      headers: { 'X-Gateway-Token': 'secret' },
    })
    const res = await handleAdminRespawnSessionRequest(req, deps())
    expect(res.status).toBe(202)
  })

  it('resolves session from the JSON body when no query param', async () => {
    let seen = ''
    const req = new Request('http://x/admin/respawn-session', {
      method: 'POST',
      headers: { 'X-Gateway-Token': 'secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: 'from-body' }),
    })
    const res = await handleAdminRespawnSessionRequest(
      req,
      deps({ respawn: (k) => { seen = k; return ok(k) } }),
    )
    expect(res.status).toBe(202)
    expect(seen).toBe('from-body')
  })

  it('forces the respawn so capped_at can be operator-released', async () => {
    // The production `respawn` dep wraps respawnReplSession(..., force=true);
    // here we assert the endpoint calls respawn for the resolved key (the force
    // semantics live in respawnReplSession and are covered in repl-supervision).
    let called = false
    const req = new Request('http://x/admin/respawn-session?session=capped-key', {
      method: 'POST',
      headers: { 'X-Gateway-Token': 'secret' },
    })
    await handleAdminRespawnSessionRequest(req, deps({ respawn: (k) => { called = k === 'capped-key'; return ok(k) } }))
    expect(called).toBe(true)
  })

  it('429 after exceeding the rate-limit window', async () => {
    const d = deps({ rateLimit: { windowMs: 60_000, maxRequests: 2 } })
    const mk = () =>
      new Request('http://x/admin/respawn-session?session=k', {
        method: 'POST',
        headers: { 'X-Gateway-Token': 'secret' },
      })
    expect((await handleAdminRespawnSessionRequest(mk(), d)).status).toBe(202)
    expect((await handleAdminRespawnSessionRequest(mk(), d)).status).toBe(202)
    expect((await handleAdminRespawnSessionRequest(mk(), d)).status).toBe(429)
  })
})
