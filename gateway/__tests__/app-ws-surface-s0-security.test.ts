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
import {
  appWsOriginAllowed,
  createAppWsSurface,
  normalizeWebOrigins,
  requestSelfOrigin,
} from '../http/app-ws-surface.ts'

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

function makeSurface(
  app_ws_token?: string,
  allowed_web_origins?: readonly string[],
): ReturnType<typeof createAppWsSurface> {
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({ registry, receiver: { receive: async () => {} } })
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  return createAppWsSurface({
    adapter,
    registry,
    auth,
    project_slug: 'demo',
    ...(app_ws_token !== undefined ? { app_ws_token } : {}),
    ...(allowed_web_origins !== undefined ? { allowed_web_origins } : {}),
  })
}

/** Build a `/ws/app/chat` upgrade Request with optional Origin + token. */
function upgradeReq(opts: { origin?: string; token?: string }): Request {
  const headers = new Headers({ host: HOST })
  if (opts.origin !== undefined) headers.set('origin', opts.origin)
  const q = opts.token !== undefined ? `?token=${encodeURIComponent(opts.token)}` : ''
  return new Request(`http://${HOST}/ws/app/chat${q}`, { method: 'GET', headers })
}

describe('appWsOriginAllowed — pure same-origin predicate (canonical)', () => {
  // Second arg is the server's OWN canonical origin (scheme+host+port).
  it('allows a MISSING Origin (native Expo/CLI clients send none)', () => {
    expect(appWsOriginAllowed(null, SAME_ORIGIN)).toBe(true)
  })
  it('allows a same-origin browser (Origin === selfOrigin)', () => {
    expect(appWsOriginAllowed(SAME_ORIGIN, SAME_ORIGIN)).toBe(true)
  })
  it('REJECTS a scheme downgrade against the same host (https self vs http Origin)', () => {
    // High #1 — host-only comparison used to allow this; canonical must not.
    expect(appWsOriginAllowed(`http://${HOST}`, `https://${HOST}`)).toBe(false)
    expect(appWsOriginAllowed(`https://${HOST}`, `http://${HOST}`)).toBe(false)
  })
  it('rejects a cross-origin page the owner merely visits', () => {
    expect(appWsOriginAllowed('https://evil.example', SAME_ORIGIN)).toBe(false)
    expect(appWsOriginAllowed('http://127.0.0.1:9999', SAME_ORIGIN)).toBe(false)
  })
  it('rejects an opaque/sandboxed Origin ("null") and a missing selfOrigin', () => {
    expect(appWsOriginAllowed('null', SAME_ORIGIN)).toBe(false)
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

const WEB_ORIGIN = 'https://app.example.test'

describe('normalizeWebOrigins — configured-origin canonicalization', () => {
  it('canonicalizes each valid base URL to scheme+host+port (path stripped)', () => {
    expect(normalizeWebOrigins([WEB_ORIGIN, 'http://web.local:8080/x'])).toEqual([
      'https://app.example.test',
      'http://web.local:8080',
    ])
  })
  it('drops empty / whitespace / malformed / opaque entries (fail-closed)', () => {
    expect(normalizeWebOrigins(['', '   ', 'not a url', 'ht!tp://[', 'foo://bar'])).toEqual([])
  })
})

describe('appWsOriginAllowed — S2 (a) configured owner web origin allow-list', () => {
  it('allows a cross-origin browser Origin that matches a configured web origin', () => {
    // Reverse-proxied deploy: Origin !== selfOrigin, but it IS the configured
    // owner web origin → allowed.
    expect(appWsOriginAllowed(WEB_ORIGIN, SAME_ORIGIN, [WEB_ORIGIN])).toBe(true)
  })
  it('MUTATION: the SAME cross-origin is rejected without the allow-list', () => {
    // Remove the allow-list (the S2 broadening) → the request goes red.
    expect(appWsOriginAllowed(WEB_ORIGIN, SAME_ORIGIN, [])).toBe(false)
    expect(appWsOriginAllowed(WEB_ORIGIN, SAME_ORIGIN)).toBe(false)
  })
  it('High #1: a configured HTTPS origin does NOT authorize http / ftp / wrong-port', () => {
    // Scheme downgrade (network-injectable http page) — rejected.
    expect(appWsOriginAllowed('http://app.example.test', SAME_ORIGIN, [WEB_ORIGIN])).toBe(false)
    // Non-http(s) scheme sharing the host — rejected.
    expect(appWsOriginAllowed('ftp://app.example.test', SAME_ORIGIN, [WEB_ORIGIN])).toBe(false)
    // Wrong port — rejected.
    expect(appWsOriginAllowed('https://app.example.test:8443', SAME_ORIGIN, [WEB_ORIGIN])).toBe(
      false,
    )
    // The exact configured canonical origin — still allowed.
    expect(appWsOriginAllowed('https://app.example.test', SAME_ORIGIN, [WEB_ORIGIN])).toBe(true)
  })
  it('still rejects an unrelated cross-origin even with an allow-list present', () => {
    expect(appWsOriginAllowed('https://evil.example', SAME_ORIGIN, [WEB_ORIGIN])).toBe(false)
  })
  it('still allows same-origin and missing-Origin regardless of the allow-list', () => {
    expect(appWsOriginAllowed(SAME_ORIGIN, SAME_ORIGIN, [WEB_ORIGIN])).toBe(true)
    expect(appWsOriginAllowed(null, SAME_ORIGIN, [WEB_ORIGIN])).toBe(true)
  })
})

describe('S2 (a) — WS upgrade accepts a configured cross-origin owner page', () => {
  it('ALLOWS the configured web origin (101) but REJECTS it without the config (403)', async () => {
    // Configured: the reverse-proxied owner page connects.
    const configured = makeSurface(undefined, [WEB_ORIGIN])
    const okRes = await configured.handler(
      upgradeReq({ origin: WEB_ORIGIN, token: 'sam' }),
      makeFakeServer().server,
    )
    expect(okRes!.status).toBe(101)

    // MUTATION: same request, surface built WITHOUT allowed_web_origins → 403.
    const bare = makeSurface()
    const rejRes = await bare.handler(
      upgradeReq({ origin: WEB_ORIGIN, token: 'sam' }),
      makeFakeServer().server,
    )
    expect(rejRes!.status).toBe(403)
    expect(((await rejRes!.json()) as { code: string }).code).toBe('bad_origin')
  })

  it('REJECTS a scheme downgrade (http) of a configured HTTPS owner origin (403)', async () => {
    const configured = makeSurface(undefined, [WEB_ORIGIN])
    const res = await configured.handler(
      upgradeReq({ origin: 'http://app.example.test', token: 'sam' }),
      makeFakeServer().server,
    )
    expect(res!.status).toBe(403)
    expect(((await res!.json()) as { code: string }).code).toBe('bad_origin')
  })
})

describe('requestSelfOrigin — canonical self-origin (Blocker B)', () => {
  /** Build a request with an explicit scheme/host and optional X-Forwarded-Proto. */
  function reqWith(opts: { scheme: string; host: string; xfp?: string }): Request {
    const headers = new Headers({ host: opts.host })
    if (opts.xfp !== undefined) headers.set('x-forwarded-proto', opts.xfp)
    return new Request(`${opts.scheme}://${opts.host}/ws/app/chat`, { method: 'GET', headers })
  }

  it('strips the default port (https :443, http :80) so it matches a browser Origin', () => {
    expect(requestSelfOrigin(reqWith({ scheme: 'https', host: 'app.example.test:443' }))).toBe(
      'https://app.example.test',
    )
    expect(requestSelfOrigin(reqWith({ scheme: 'http', host: 'app.example.test:80' }))).toBe(
      'http://app.example.test',
    )
  })
  it('lower-cases the host (casing is not significant)', () => {
    expect(requestSelfOrigin(reqWith({ scheme: 'https', host: 'APP.Example.TEST' }))).toBe(
      'https://app.example.test',
    )
  })
  it('keeps a non-default port', () => {
    expect(requestSelfOrigin(reqWith({ scheme: 'http', host: '127.0.0.1:7800' }))).toBe(
      'http://127.0.0.1:7800',
    )
  })
  it('uses the FIRST token of a comma-separated X-Forwarded-Proto', () => {
    // Proxy chain reports `https, http`; the external scheme is https.
    expect(
      requestSelfOrigin(reqWith({ scheme: 'http', host: 'app.example.test', xfp: 'https, http' })),
    ).toBe('https://app.example.test')
  })
  it('falls back to the socket scheme on a malformed / untrusted forwarded proto', () => {
    expect(
      requestSelfOrigin(reqWith({ scheme: 'http', host: 'app.example.test', xfp: 'ht!tp' })),
    ).toBe('http://app.example.test')
    expect(
      requestSelfOrigin(reqWith({ scheme: 'https', host: 'app.example.test', xfp: 'gopher' })),
    ).toBe('https://app.example.test')
  })
  it('returns null when the Host header is absent', () => {
    expect(
      requestSelfOrigin(new Request('http://x/ws/app/chat', { method: 'GET' })),
    ).toBe(null)
  })
})

describe('S2 (a)/Blocker B — WS upgrade accepts a canonical same-origin page', () => {
  function upgradeReqFull(opts: {
    scheme: string
    host: string
    origin: string
    xfp?: string
    token: string
  }): Request {
    const headers = new Headers({ host: opts.host, origin: opts.origin })
    if (opts.xfp !== undefined) headers.set('x-forwarded-proto', opts.xfp)
    return new Request(`${opts.scheme}://${opts.host}/ws/app/chat?token=${opts.token}`, {
      method: 'GET',
      headers,
    })
  }

  it('ALLOWS an HTTPS same-origin upgrade on the default :443 port (101)', async () => {
    const surface = makeSurface()
    const res = await surface.handler(
      upgradeReqFull({
        scheme: 'https',
        host: 'app.example.test:443',
        origin: 'https://app.example.test',
        xfp: 'https',
        token: 'sam',
      }),
      makeFakeServer().server,
    )
    expect(res!.status).toBe(101)
  })

  it('ALLOWS a mixed-case Host same-origin upgrade (101)', async () => {
    const surface = makeSurface()
    const res = await surface.handler(
      upgradeReqFull({
        scheme: 'https',
        host: 'APP.example.test',
        origin: 'https://app.example.test',
        xfp: 'https',
        token: 'sam',
      }),
      makeFakeServer().server,
    )
    expect(res!.status).toBe(101)
  })

  it('a proxy-forwarded HTTPS (comma XFP) same-origin upgrade is accepted (101)', async () => {
    const surface = makeSurface()
    const res = await surface.handler(
      upgradeReqFull({
        scheme: 'http', // gateway sees http from the proxy…
        host: 'app.example.test',
        origin: 'https://app.example.test', // …but the browser is on https
        xfp: 'https, http',
        token: 'sam',
      }),
      makeFakeServer().server,
    )
    expect(res!.status).toBe(101)
  })
})
