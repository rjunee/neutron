/**
 * P5.6 — gateway app-devices surface tests.
 *
 * Verifies the two device routes (POST register + POST unregister)
 * round-trip through `composeHttpHandler` with the dev-bypass auth
 * resolver and a real `DevicePushTokenStore` over a temporary SQLite
 * database (mirrors the app-reminders / app-tasks surface tests).
 *
 * The composer wiring for the new surface (`appDevices`) is exercised
 * here via the new `AppDevicesHandler` field on `composeHttpHandler`;
 * the production wiring in `gateway/index.ts` is covered by the
 * existing composition tests once the surface is wired into the
 * realmode composer (see `gateway/composition-landing-and-telegram.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { createLogger } from '@neutronai/logger'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { DevicePushTokenStore } from '../push/store.ts'
import {
  MAX_DEVICE_TOKEN_LEN,
  createAppDevicesSurface,
  type AppDevicesLogger,
} from '../http/app-devices-surface.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'

// --- in-process handler shim (no socket) -------------------------------------
// These surface tests used to bind a real `Bun.serve({ port: 0 })` and round-
// trip via the global `fetch`, holding a live listener + socket buffers in the
// chunk's RSS until teardown. Instead each harness registers its composed
// handler under a unique in-process base, and `fetch` is shadowed at module
// scope so requests to a registered base dispatch straight to
// `composed.fetch(new Request(...))` — identical assertions, no socket.
// Unrelated URLs fall through to the real fetch.
const __composedHandlers = new Map<string, ComposedHttpHandler>()
let __gatewaySeq = 0
const __realFetch = globalThis.fetch.bind(globalThis)
const fetch = ((input: Request | string | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
  const composed = __composedHandlers.get(new URL(req.url).host)
  if (composed !== undefined) return Promise.resolve(composed.fetch(req, undefined as never))
  return __realFetch(input as Parameters<typeof __realFetch>[0], init)
}) as typeof globalThis.fetch

interface Harness {
  base: string
  store: DevicePushTokenStore
  db: ProjectDb
  tmp: string
  /** Every log line the surface actually rendered, in order. */
  lines: string[]
  close(): Promise<void>
}

interface StartOpts {
  /** Swap the store for one that fails, to exercise the 500 path. */
  store?: DevicePushTokenStore
}

async function startGateway(opts: StartOpts = {}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-app-devices-'))
  seedMigratedDb(join(tmp, 'owner.db'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  const store = opts.store ?? new DevicePushTokenStore(db)
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  // The REAL logger with a capturing sink, not a mock: these tests assert on
  // the rendered `[app-devices] event=… k=v` line, which is what an operator
  // reads and what the "never log the token" guarantee has to hold for.
  const lines: string[] = []
  const logger: AppDevicesLogger = createLogger('app-devices', {
    sink: (_level, line) => lines.push(line),
  })
  const surface = createAppDevicesSurface({ store, auth, logger })
  const composed = composeHttpHandler({
    appDevices: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const host = `gw-${++__gatewaySeq}.test`
  __composedHandlers.set(host, composed)
  return {
    base: `http://${host}`,
    store,
    db,
    tmp,
    lines,
    close: async () => {
      __composedHandlers.delete(host)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function authedFetch(
  base: string,
  path: string,
  init: RequestInit = {},
  bearerToken: string = 'dev:sam',
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', `Bearer ${bearerToken}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

describe('app-devices surface — POST /api/app/devices/register', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('rejects without a Bearer token', async () => {
    const res = await fetch(`${harness.base}/api/app/devices/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_token: 'tok', platform: 'ios' }),
    })
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('rejects malformed JSON body', async () => {
    const res = await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('malformed_json')
  })

  it('rejects missing device_token', async () => {
    const res = await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'POST',
      body: JSON.stringify({ platform: 'ios' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_device_token')
  })

  it('rejects empty-string device_token', async () => {
    const res = await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'POST',
      body: JSON.stringify({ device_token: '   ', platform: 'ios' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_device_token')
  })

  it(`rejects device_token longer than ${MAX_DEVICE_TOKEN_LEN}`, async () => {
    const tok = 'x'.repeat(MAX_DEVICE_TOKEN_LEN + 1)
    const res = await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'POST',
      body: JSON.stringify({ device_token: tok, platform: 'ios' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_device_token')
  })

  it('rejects invalid platform', async () => {
    const res = await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'POST',
      body: JSON.stringify({ device_token: 'tok', platform: 'desktop' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_platform')
  })

  it('registers a token and returns the row', async () => {
    const res = await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'POST',
      body: JSON.stringify({
        device_token: 'ExponentPushToken[abc]',
        platform: 'ios',
      }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      device: {
        id: string
        project_slug: string
        user_id: string
        platform: string
        registered_at: string
        updated_at: string
      }
    }
    expect(json.ok).toBe(true)
    expect(json.device.project_slug).toBe('demo')
    expect(json.device.user_id).toBe('sam')
    expect(json.device.platform).toBe('ios')
    expect(json.device.id.length).toBeGreaterThan(0)
    expect(json.device.registered_at.length).toBeGreaterThan(0)
    expect(json.device.updated_at).toBe(json.device.registered_at)

    // Verify the row landed in the store.
    const rows = harness.store.listByOwner('demo')
    expect(rows.length).toBe(1)
    expect(rows[0]?.device_token).toBe('ExponentPushToken[abc]')
  })

  it('re-registering the same token is idempotent (single row, fresh updated_at)', async () => {
    const first = await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'POST',
      body: JSON.stringify({
        device_token: 'tok-idem',
        platform: 'ios',
      }),
    })
    expect(first.status).toBe(200)
    const firstJson = (await first.json()) as { device: { id: string; updated_at: string } }
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'POST',
      body: JSON.stringify({
        device_token: 'tok-idem',
        platform: 'ios',
      }),
    })
    expect(second.status).toBe(200)
    const secondJson = (await second.json()) as { device: { id: string; updated_at: string } }
    expect(secondJson.device.id).toBe(firstJson.device.id)
    expect(secondJson.device.updated_at > firstJson.device.updated_at).toBe(true)
    expect(harness.store.listByOwner('demo').length).toBe(1)
  })

  it('a different user can register the same token (device handover)', async () => {
    await authedFetch(
      harness.base,
      '/api/app/devices/register',
      {
        method: 'POST',
        body: JSON.stringify({ device_token: 'shared-device', platform: 'ios' }),
      },
      'dev:sam',
    )
    await authedFetch(
      harness.base,
      '/api/app/devices/register',
      {
        method: 'POST',
        body: JSON.stringify({ device_token: 'shared-device', platform: 'ios' }),
      },
      'dev:alice',
    )
    const rows = harness.store.listByOwner('demo')
    expect(rows.length).toBe(1)
    expect(rows[0]?.user_id).toBe('alice')
  })

  it('multiple tokens per user persist independently', async () => {
    for (const tok of ['ios-tok', 'android-tok', 'ios-tok-2']) {
      const res = await authedFetch(harness.base, '/api/app/devices/register', {
        method: 'POST',
        body: JSON.stringify({
          device_token: tok,
          platform: tok.startsWith('ios') ? 'ios' : 'android',
        }),
      })
      expect(res.status).toBe(200)
    }
    expect(harness.store.listByOwner('demo').length).toBe(3)
    const tokens = harness.store.listByUser('demo', 'sam').map((r) => r.device_token).sort()
    expect(tokens).toEqual(['android-tok', 'ios-tok', 'ios-tok-2'])
  })

  // 2026-05-22 — migration 0042 dropped 'web' from the platform CHECK enum.
  // The HTTP surface should reject web at the validation layer (before
  // hitting the store) so the response carries the canonical error code.
  it('rejects platform=web with invalid_platform', async () => {
    const res = await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'POST',
      body: JSON.stringify({ device_token: 'web-tok', platform: 'web' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_platform')
    expect(harness.store.listByOwner('demo').length).toBe(0)
  })

  it('rejects GET on the register path', async () => {
    const res = await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'GET',
    })
    expect(res.status).toBe(405)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('method_not_allowed')
  })
})

describe('app-devices surface — POST /api/app/devices/unregister', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('removes the row and returns ok=true', async () => {
    await harness.store.register({
      project_slug: 'demo',
      user_id: 'sam',
      device_token: 'tok-to-remove',
      platform: 'ios',
    })
    const res = await authedFetch(harness.base, '/api/app/devices/unregister', {
      method: 'POST',
      body: JSON.stringify({ device_token: 'tok-to-remove' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean }
    expect(json.ok).toBe(true)
    expect(harness.store.listByOwner('demo').length).toBe(0)
  })

  it('returns 404 for an unknown device_token', async () => {
    const res = await authedFetch(harness.base, '/api/app/devices/unregister', {
      method: 'POST',
      body: JSON.stringify({ device_token: 'never-registered' }),
    })
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('device_not_found')
  })

  it('rejects missing device_token in body', async () => {
    const res = await authedFetch(harness.base, '/api/app/devices/unregister', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_device_token')
  })

  it('only unregisters within the caller project scope', async () => {
    // Seed BOTH instances with the same token.
    await harness.store.register({
      project_slug: 'demo',
      user_id: 'sam',
      device_token: 'shared-tok',
      platform: 'ios',
    })
    await harness.store.register({
      project_slug: 'other-project',
      user_id: 'someone',
      device_token: 'shared-tok',
      platform: 'ios',
    })
    const res = await authedFetch(harness.base, '/api/app/devices/unregister', {
      method: 'POST',
      body: JSON.stringify({ device_token: 'shared-tok' }),
    })
    expect(res.status).toBe(200)
    expect(harness.store.getByDeviceToken('demo', 'shared-tok')).toBeNull()
    expect(harness.store.getByDeviceToken('other-project', 'shared-tok')).not.toBeNull()
  })
})

/**
 * ISSUES #487 — the registration path used to be UNOBSERVABLE.
 *
 * `device_push_tokens` was found with zero rows on a live instance. Nothing on
 * this surface logged, so "the app never called register" and "the app called
 * and was rejected" were indistinguishable: both left no trace at all. Every
 * test below asserts a DIAGNOSTIC exists for an outcome that previously
 * produced silence — and the last one asserts what must never be in it.
 */
describe('app-devices surface — registration is observable', () => {
  const TOKEN = 'ExponentPushToken[SECRET-DEVICE-CREDENTIAL-abc999]'
  let harness: Harness
  let previousLevel: string | undefined

  beforeEach(async () => {
    previousLevel = process.env['NEUTRON_LOG_LEVEL']
    process.env['NEUTRON_LOG_LEVEL'] = 'info'
    harness = await startGateway()
  })
  afterEach(async () => {
    if (previousLevel === undefined) delete process.env['NEUTRON_LOG_LEVEL']
    else process.env['NEUTRON_LOG_LEVEL'] = previousLevel
    await harness.close()
  })

  it('a successful registration says so, with the device fingerprinted', async () => {
    const res = await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'POST',
      body: JSON.stringify({ device_token: TOKEN, platform: 'ios' }),
    })
    expect(res.status).toBe(200)
    const line = harness.lines.find((l) => l.includes('event=device_registered'))
    expect(line).toBeDefined()
    expect(line).toContain('project_slug=demo')
    expect(line).toContain('user_id=sam')
    expect(line).toContain('platform=ios')
    expect(line).toContain('first_registration=true')
    expect(line).toMatch(/token_fp=[0-9a-f]{12}\b/)
  })

  it('re-registering the same device is distinguishable from a new one', async () => {
    const body = JSON.stringify({ device_token: TOKEN, platform: 'ios' })
    await authedFetch(harness.base, '/api/app/devices/register', { method: 'POST', body })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await authedFetch(harness.base, '/api/app/devices/register', { method: 'POST', body })
    const registrations = harness.lines.filter((l) => l.includes('event=device_registered'))
    expect(registrations.length).toBe(2)
    expect(registrations[0]).toContain('first_registration=true')
    expect(registrations[1]).toContain('first_registration=false')
    // Same phone, same fingerprint — which is the point of having one.
    const fp = (l: string): string => /token_fp=([0-9a-f]{12})/.exec(l)?.[1] ?? ''
    expect(fp(registrations[0] as string)).toBe(fp(registrations[1] as string))
    expect(fp(registrations[0] as string).length).toBe(12)
  })

  it('a REJECTED registration emits a diagnostic instead of vanishing', async () => {
    const res = await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'POST',
      body: JSON.stringify({ device_token: TOKEN, platform: 'desktop' }),
    })
    expect(res.status).toBe(400)
    const line = harness.lines.find((l) => l.includes('event=device_register_rejected'))
    expect(line).toBeDefined()
    expect(line).toContain('reason=invalid_platform')
  })

  it('an unauthenticated attempt is logged — the app CALLING and being refused', async () => {
    // This is the case the empty table could not be told apart from "the app
    // never called at all", and the one an expired bearer produces.
    const res = await fetch(`${harness.base}/api/app/devices/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_token: TOKEN, platform: 'ios' }),
    })
    expect(res.status).toBe(401)
    const line = harness.lines.find((l) => l.includes('event=device_request_unauthorized'))
    expect(line).toBeDefined()
    expect(line).toContain('route=register')
    expect(line).toContain('reason=missing_bearer')
  })

  it('a store failure is logged AND answered, instead of throwing into the void', async () => {
    const exploding = {
      register: async () => {
        throw new Error('database is locked')
      },
    } as unknown as DevicePushTokenStore
    const broken = await startGateway({ store: exploding })
    try {
      const res = await authedFetch(broken.base, '/api/app/devices/register', {
        method: 'POST',
        body: JSON.stringify({ device_token: TOKEN, platform: 'ios' }),
      })
      expect(res.status).toBe(500)
      const json = (await res.json()) as { code: string }
      expect(json.code).toBe('register_failed')
      const line = broken.lines.find((l) => l.includes('event=device_register_failed'))
      expect(line).toBeDefined()
      expect(line).toContain('database is locked')
    } finally {
      await broken.close()
    }
  })

  it('an unregister — how the table goes back to empty — is logged', async () => {
    await authedFetch(harness.base, '/api/app/devices/register', {
      method: 'POST',
      body: JSON.stringify({ device_token: TOKEN, platform: 'ios' }),
    })
    const res = await authedFetch(harness.base, '/api/app/devices/unregister', {
      method: 'POST',
      body: JSON.stringify({ device_token: TOKEN }),
    })
    expect(res.status).toBe(200)
    const line = harness.lines.find((l) => l.includes('event=device_unregistered'))
    expect(line).toBeDefined()
    expect(line).toMatch(/token_fp=[0-9a-f]{12}\b/)
  })

  it('an unregister for an unknown device is logged as a rejection', async () => {
    const res = await authedFetch(harness.base, '/api/app/devices/unregister', {
      method: 'POST',
      body: JSON.stringify({ device_token: 'never-registered' }),
    })
    expect(res.status).toBe(404)
    const line = harness.lines.find((l) => l.includes('event=device_unregister_rejected'))
    expect(line).toBeDefined()
    expect(line).toContain('reason=device_not_found')
  })

  // THE POINT OF THE CHANGE. A device push token is a credential: anyone
  // holding it can push to the owner's phone. Observability that writes it to
  // journald would trade one defect for a worse one.
  it('NEVER writes the raw device token to the log, on any path', async () => {
    const paths: Array<[string, unknown]> = [
      ['/api/app/devices/register', { device_token: TOKEN, platform: 'ios' }],
      ['/api/app/devices/register', { device_token: TOKEN, platform: 'desktop' }],
      ['/api/app/devices/register', { device_token: TOKEN }],
      ['/api/app/devices/unregister', { device_token: TOKEN }],
      ['/api/app/devices/unregister', { device_token: `${TOKEN}-unknown` }],
    ]
    for (const [path, body] of paths) {
      await authedFetch(harness.base, path, { method: 'POST', body: JSON.stringify(body) })
    }
    // Also the unauthenticated path, which never gets as far as a handler.
    await fetch(`${harness.base}/api/app/devices/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_token: TOKEN, platform: 'ios' }),
    })

    expect(harness.lines.length).toBeGreaterThanOrEqual(6)
    const all = harness.lines.join('\n')
    expect(all).not.toContain(TOKEN)
    // Not even a recognisable slice of it.
    expect(all).not.toContain('SECRET-DEVICE-CREDENTIAL')
    expect(all).not.toContain('ExponentPushToken')
  })
})

describe('app-devices surface — fall-through behaviour', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('disclaims unrelated paths (returns 404 from default handler)', async () => {
    const res = await fetch(`${harness.base}/api/app/something-else`)
    expect(res.status).toBe(404)
  })
})
