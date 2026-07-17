/**
 * ISSUES #40 (owner-timezone WRITE path) — boundary tests for the app-ws surface
 * seam that captures the client-reported IANA `tz` off the connect query string
 * and fires `on_client_timezone` in `open`.
 *
 * Contract:
 *   - a boundary-valid `tz` is captured onto the socket data at upgrade and, on
 *     `open`, fires `on_client_timezone` keyed on the SOCKET's auth-resolved
 *     `project_slug` (owner-auth-gated — a client-supplied owner is impossible).
 *   - a garbage / absent `tz` is not captured, so the hook never fires.
 *   - an upgrade that FAILS auth (wide bind, no token) is rejected BEFORE
 *     `server.upgrade`, so the hook never fires (mirrors the upload-surface
 *     wide-bind fail-closed gate).
 *
 * The reject paths need no live socket — the handler returns a `Response` before
 * `server.upgrade`. The accept path uses a fake `Server` to capture the socket
 * data, then drives `websocket.open` with a fake `ServerWebSocket`.
 */
import { describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'

import {
  AppWsAdapter,
  InMemoryAppWsSessionRegistry,
  createAppWsAuthResolver,
} from '@neutronai/channels/index.ts'
import {
  MAX_TIMEZONE_LEN,
  sanitizeTimezone,
} from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { isValidIanaTimezone } from '../storage/owner-metadata.ts'
import { createAppWsSurface } from '../http/app-ws-surface.ts'

const HOST = '127.0.0.1:7800'
const SAME_ORIGIN = `http://${HOST}`

interface TzCall {
  user_id: string
  project_slug: string
  tz: string
}

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

function makeSurface(opts?: {
  app_ws_token?: string
  require_token_without_origin?: boolean
}): { surface: ReturnType<typeof createAppWsSurface>; calls: TzCall[] } {
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({ registry, receiver: { receive: async () => {} } })
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const calls: TzCall[] = []
  const surface = createAppWsSurface({
    adapter,
    registry,
    auth,
    project_slug: 'demo',
    on_client_timezone: ({ user_id, project_slug, tz }) => {
      calls.push({ user_id, project_slug, tz })
    },
    ...(opts?.app_ws_token !== undefined ? { app_ws_token: opts.app_ws_token } : {}),
    ...(opts?.require_token_without_origin !== undefined
      ? { require_token_without_origin: opts.require_token_without_origin }
      : {}),
  })
  return { surface, calls }
}

/** A `/ws/app/chat` upgrade Request with optional Origin + token + tz. */
function upgradeReq(opts: { origin?: string; token?: string; tz?: string }): Request {
  const headers = new Headers({ host: HOST })
  if (opts.origin !== undefined) headers.set('origin', opts.origin)
  const q = new URLSearchParams()
  if (opts.token !== undefined) q.set('token', opts.token)
  if (opts.tz !== undefined) q.set('tz', opts.tz)
  const qs = q.toString()
  return new Request(`http://${HOST}/ws/app/chat${qs.length > 0 ? `?${qs}` : ''}`, {
    method: 'GET',
    headers,
  })
}

/** Minimal fake socket that satisfies the `open` handler's `ws.send`. */
function fakeWs(data: unknown): ServerWebSocket<unknown> {
  return {
    data,
    send: () => 1,
  } as unknown as ServerWebSocket<unknown>
}

// BLOCKER 2 — direct boundary coverage for the untrusted-input sanitizer. This
// is the query-string gate (trim + length cap + charset) BEFORE the socket data
// captures a zone; loosening the cap or charset must redden a test here.
describe('sanitizeTimezone — untrusted-input boundary gate (ISSUES #40)', () => {
  it('accepts a real IANA zone with / and _ (charset must not reject legit zones)', () => {
    expect(sanitizeTimezone('America/Argentina/Buenos_Aires')).toBe(
      'America/Argentina/Buenos_Aires',
    )
    expect(sanitizeTimezone('America/New_York')).toBe('America/New_York')
    expect(sanitizeTimezone('Etc/GMT+5')).toBe('Etc/GMT+5')
    expect(sanitizeTimezone('UTC')).toBe('UTC')
  })

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeTimezone('  America/New_York  ')).toBe('America/New_York')
    expect(sanitizeTimezone('\tAsia/Singapore\n')).toBe('Asia/Singapore')
  })

  it('rejects empty + whitespace-only input', () => {
    expect(sanitizeTimezone('')).toBeNull()
    expect(sanitizeTimezone('   ')).toBeNull()
    expect(sanitizeTimezone('\t\n')).toBeNull()
  })

  it('rejects non-string input safely', () => {
    expect(sanitizeTimezone(undefined)).toBeNull()
    expect(sanitizeTimezone(null)).toBeNull()
    expect(sanitizeTimezone(42)).toBeNull()
    expect(sanitizeTimezone({ tz: 'America/New_York' })).toBeNull()
    expect(sanitizeTimezone(['America/New_York'])).toBeNull()
  })

  it('rejects a bad charset (spaces, punctuation, injection)', () => {
    expect(sanitizeTimezone('bad zone!!')).toBeNull()
    expect(sanitizeTimezone('UTC; DROP TABLE instance_metadata')).toBeNull()
    expect(sanitizeTimezone('../../etc/passwd\0')).toBeNull()
  })

  it('enforces the length cap: exactly MAX accepted, MAX+1 rejected', () => {
    // Build IANA-charset strings at the boundary so ONLY the length differs.
    const at = 'A'.repeat(MAX_TIMEZONE_LEN)
    const over = 'A'.repeat(MAX_TIMEZONE_LEN + 1)
    expect(at.length).toBe(64)
    expect(sanitizeTimezone(at)).toBe(at)
    expect(sanitizeTimezone(over)).toBeNull()
    // The cap applies AFTER trim — trailing space that brings a 64-char zone
    // back under the cap still passes.
    expect(sanitizeTimezone(`${at} `)).toBe(at)
  })

  it('a syntactically-plausible but UNKNOWN zone passes the sanitizer but is rejected authoritatively', () => {
    // The cheap charset gate lets `Foo/Bar` through (it looks IANA-shaped)...
    expect(sanitizeTimezone('Foo/Bar')).toBe('Foo/Bar')
    // ...and the authoritative server-side check (Intl) then rejects it, so it is
    // never persisted. Two-layer defense: shape guard + real validation.
    expect(isValidIanaTimezone('Foo/Bar')).toBe(false)
  })
})

describe('app-ws surface — owner-timezone capture (ISSUES #40)', () => {
  it('captures a valid tz at upgrade and FORWARDS the resolved user_id + instance slug to the hook', async () => {
    // The surface is identity-agnostic: it forwards BOTH the auth-resolved
    // `user_id` (here `sam`, parsed from the dev token) and the instance
    // `project_slug` (`demo`) so the CONSUMER can enforce owner authorization.
    // Note `sam !== demo`: authentication binds many users to one instance, so
    // the OWNER gate is the wiring's job (see open-wiring-app-ws.test.ts) — the
    // surface never hardcodes the owner identity.
    const { surface, calls } = makeSurface()
    const { server, lastData } = makeFakeServer()
    const res = await surface.handler(
      upgradeReq({ origin: SAME_ORIGIN, token: 'dev:sam', tz: 'America/New_York' }),
      server,
    )
    expect(res?.status).toBe(101)
    const data = lastData() as { tz?: string; project_slug: string }
    // Captured onto the socket data at upgrade.
    expect(data.tz).toBe('America/New_York')

    await surface.websocket.open!(fakeWs(data) as ServerWebSocket<never>)
    // Fired once, carrying the AUTH-RESOLVED user_id + instance slug — never a
    // client-supplied identity.
    expect(calls).toEqual([
      { user_id: 'sam', project_slug: 'demo', tz: 'America/New_York' },
    ])
  })

  it('does not capture / fire when no tz is reported', async () => {
    const { surface, calls } = makeSurface()
    const { server, lastData } = makeFakeServer()
    await surface.handler(upgradeReq({ origin: SAME_ORIGIN, token: 'dev:sam' }), server)
    const data = lastData() as { tz?: string }
    expect(data.tz).toBeUndefined()
    await surface.websocket.open!(fakeWs(data) as ServerWebSocket<never>)
    expect(calls).toEqual([])
  })

  it('drops a malformed tz (bad charset) — hook never fires', async () => {
    const { surface, calls } = makeSurface()
    const { server, lastData } = makeFakeServer()
    await surface.handler(
      upgradeReq({ origin: SAME_ORIGIN, token: 'dev:sam', tz: 'bad zone!!' }),
      server,
    )
    const data = lastData() as { tz?: string }
    expect(data.tz).toBeUndefined()
    await surface.websocket.open!(fakeWs(data) as ServerWebSocket<never>)
    expect(calls).toEqual([])
  })

  it('owner-auth-gated: a wide-bind upgrade with NO token is rejected before upgrade — hook never fires', async () => {
    // Wide bind (require_token_without_origin) with a configured per-boot token.
    // An Origin-less client presenting no token is 401'd BEFORE server.upgrade,
    // so the tz never reaches the socket and the write hook never runs (mirrors
    // the upload-surface wide-bind fail-closed gate).
    const { surface, calls } = makeSurface({
      app_ws_token: 'nbt_secret_AAAAAAAAAAAAAAAAAAAA',
      require_token_without_origin: true,
    })
    const { server, lastData } = makeFakeServer()
    const res = await surface.handler(
      upgradeReq({ tz: 'America/New_York' }), // no origin, no token
      server,
    )
    expect(res?.status).toBe(401)
    // server.upgrade was never called → nothing captured, hook never fired.
    expect(lastData()).toBeUndefined()
    expect(calls).toEqual([])
  })
})
