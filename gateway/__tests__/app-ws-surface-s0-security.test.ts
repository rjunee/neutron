/**
 * S0 security quick-patch — boundary tests for the `/ws/app/chat` upgrade:
 *   (a) same-origin guard (`appWsOriginAllowed` + handler rejection), and
 *   (b) the per-boot app-ws token gate for browser-origin upgrades.
 *
 * These exercise the auth boundary directly at the surface handler (no real
 * socket needed for the reject paths): the handler returns a `Response`
 * (403/401) before `server.upgrade` for a rejected upgrade, and calls
 * `server.upgrade` (→ 101) for an accepted one. A fake `Server` captures the
 * upgrade so the accept path is observable without a live WebSocket.
 */
import { describe, expect, it } from 'bun:test'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { AppWsAdapter, InMemoryAppWsSessionRegistry } from '@neutronai/channels/index.ts'
import { appWsOriginAllowed, createAppWsSurface } from '../http/app-ws-surface.ts'

const HOST = '127.0.0.1:7800'
const SAME_ORIGIN = `http://${HOST}`
const BOOT_TOKEN = 'nbt_boot_AAAAAAAAAAAAAAAAAAAAAAAA'
const PREV_BOOT_TOKEN = 'nbt_boot_BBBBBBBBBBBBBBBBBBBBBBBB'

/** A minimal fake Bun server whose `upgrade` records the socket data. */
function makeFakeServer(upgradeResult = true): {
  server: import('bun').Server<unknown>
  lastData: () => unknown
} {
  let captured: unknown
  const server = {
    upgrade: (_req: Request, opts?: { data?: unknown }) => {
      captured = opts?.data
      return upgradeResult
    },
  } as unknown as import('bun').Server<unknown>
  return { server, lastData: () => captured }
}

function makeSurface(app_ws_token?: string): ReturnType<typeof createAppWsSurface> {
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({ registry, receiver: { receive: async () => {} } })
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  return createAppWsSurface({
    adapter,
    registry,
    auth,
    project_slug: 'demo',
    ...(app_ws_token !== undefined ? { app_ws_token } : {}),
  })
}

/** Build a `/ws/app/chat` upgrade Request with optional Origin + token. */
function upgradeReq(opts: { origin?: string; token?: string }): Request {
  const headers = new Headers({ host: HOST })
  if (opts.origin !== undefined) headers.set('origin', opts.origin)
  const q = opts.token !== undefined ? `?token=${encodeURIComponent(opts.token)}` : ''
  return new Request(`http://${HOST}/ws/app/chat${q}`, { method: 'GET', headers })
}

describe('appWsOriginAllowed — pure same-origin predicate', () => {
  it('allows a MISSING Origin (native Expo/CLI clients send none)', () => {
    expect(appWsOriginAllowed(null, HOST)).toBe(true)
  })
  it('allows a same-origin browser (Origin host === Host)', () => {
    expect(appWsOriginAllowed(SAME_ORIGIN, HOST)).toBe(true)
    expect(appWsOriginAllowed(`https://${HOST}`, HOST)).toBe(true)
  })
  it('rejects a cross-origin page the owner merely visits', () => {
    expect(appWsOriginAllowed('https://evil.example', HOST)).toBe(false)
    expect(appWsOriginAllowed('http://127.0.0.1:9999', HOST)).toBe(false)
  })
  it('rejects an opaque/sandboxed Origin ("null") and a missing Host', () => {
    expect(appWsOriginAllowed('null', HOST)).toBe(false)
    expect(appWsOriginAllowed(SAME_ORIGIN, null)).toBe(false)
  })
})

describe('S0 (a) — WS upgrade same-origin guard', () => {
  it('REJECTS a cross-origin upgrade with 403 bad_origin (even with a valid token)', async () => {
    const surface = makeSurface(BOOT_TOKEN)
    const { server } = makeFakeServer()
    const res = await surface.handler(
      upgradeReq({ origin: 'https://evil.example', token: BOOT_TOKEN }),
      server,
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    expect(((await res!.json()) as { code: string }).code).toBe('bad_origin')
  })

  it('REJECTS a cross-origin upgrade even when no per-boot token is configured', async () => {
    const surface = makeSurface() // no app_ws_token — origin check is always on
    const { server } = makeFakeServer()
    const res = await surface.handler(
      upgradeReq({ origin: 'https://evil.example', token: 'sam' }),
      server,
    )
    expect(res!.status).toBe(403)
    expect(((await res!.json()) as { code: string }).code).toBe('bad_origin')
  })

  it('ALLOWS a native (no-Origin) upgrade — bearer-only auth path (101)', async () => {
    const surface = makeSurface(BOOT_TOKEN)
    const { server, lastData } = makeFakeServer()
    // Native client sends NO Origin and the legacy dev bearer; the token gate is
    // skipped and the resolver accepts it.
    const res = await surface.handler(upgradeReq({ token: 'sam' }), server)
    expect(res!.status).toBe(101)
    expect((lastData() as { user_id: string }).user_id).toBe('sam')
  })
})

describe('S0 (b) — per-boot app-ws token gate (browser-origin upgrades)', () => {
  it('ALLOWS a same-origin browser presenting the correct per-boot token (101)', async () => {
    const surface = makeSurface(BOOT_TOKEN)
    const { server, lastData } = makeFakeServer()
    const res = await surface.handler(
      upgradeReq({ origin: SAME_ORIGIN, token: BOOT_TOKEN }),
      server,
    )
    expect(res!.status).toBe(101)
    expect((lastData() as { user_id: string }).user_id).toBe(BOOT_TOKEN)
  })

  it('REJECTS a same-origin browser presenting the guessable dev:owner bearer (401)', async () => {
    const surface = makeSurface(BOOT_TOKEN)
    const { server } = makeFakeServer()
    const res = await surface.handler(
      upgradeReq({ origin: SAME_ORIGIN, token: 'dev:owner' }),
      server,
    )
    expect(res!.status).toBe(401)
    expect(((await res!.json()) as { code: string }).code).toBe('bad_app_ws_token')
  })

  it('REJECTS a same-origin browser with a token from a PREVIOUS boot (per-boot)', async () => {
    // This boot minted BOOT_TOKEN; a page cached from a prior boot carries
    // PREV_BOOT_TOKEN, which no longer matches → rejected.
    const surface = makeSurface(BOOT_TOKEN)
    const { server } = makeFakeServer()
    const res = await surface.handler(
      upgradeReq({ origin: SAME_ORIGIN, token: PREV_BOOT_TOKEN }),
      server,
    )
    expect(res!.status).toBe(401)
    expect(((await res!.json()) as { code: string }).code).toBe('bad_app_ws_token')
  })

  it('REJECTS a same-origin browser with an ABSENT token (401)', async () => {
    const surface = makeSurface(BOOT_TOKEN)
    const { server } = makeFakeServer()
    const res = await surface.handler(upgradeReq({ origin: SAME_ORIGIN }), server)
    expect(res!.status).toBe(401)
    expect(((await res!.json()) as { code: string }).code).toBe('bad_app_ws_token')
  })

  it('is a NO-OP when no per-boot token is configured (back-compat): browser dev bearer connects', async () => {
    const surface = makeSurface() // no app_ws_token
    const { server, lastData } = makeFakeServer()
    const res = await surface.handler(
      upgradeReq({ origin: SAME_ORIGIN, token: 'sam' }),
      server,
    )
    expect(res!.status).toBe(101)
    expect((lastData() as { user_id: string }).user_id).toBe('sam')
  })
})
