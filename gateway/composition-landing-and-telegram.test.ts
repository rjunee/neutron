/**
 * Sprint 18 — composition wiring tests.
 *
 * Per docs/plans/2026-05-05-001-feat-per-instance-gateway-http-routes-plan.md.
 * Verifies that `gateway/index.ts:boot` composes the new
 * `landing_server` + `telegram_webhook` fields on `CompositionInput`
 * into the `Bun.serve` precedence chain, alongside the existing
 * `connect_api` wiring.
 *
 * Each test boots a real `Bun.serve` on `port: 0`, hits the listener with
 * `fetch(`http://localhost:${server.port}/...`)`, and asserts the right
 * leg of the precedence chain ran (telegram > landing > cross-instance >
 * /healthz default).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportJWK, generateKeyPair, type KeyLike } from 'jose'
import { boot } from './index.ts'
import { JwksCache, type FetchLike } from '../jwt-validator/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

interface KeyMaterial {
  kid: string
  privateKey: KeyLike
  jwks: { keys: Array<{ kid: string; alg: string; use: string }> }
}

async function mintKey(): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  const pubJwk = await exportJWK(publicKey)
  return {
    kid: 'k1',
    privateKey,
    jwks: { keys: [{ kid: 'k1', alg: 'EdDSA', use: 'sig', ...pubJwk } as KeyMaterial['jwks']['keys'][0]] },
  }
}

function makeJwksCache(km: KeyMaterial): JwksCache {
  const fakeFetch: FetchLike = async () =>
    new Response(JSON.stringify(km.jwks), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  return new JwksCache('https://auth.example/.well-known/jwks.json', { fetch: fakeFetch })
}

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop()!, { recursive: true, force: true })
  }
  delete process.env['NEUTRON_DB_PATH']
  delete process.env['NEUTRON_INSTANCE_SLUG']
  delete process.env['NOTIFY_SOCKET']
})

interface LandingRecorder {
  fetchCalls: Array<{ pathname: string; method: string }>
  wsOpens: number
}

function makeLandingHandler(rec: LandingRecorder): {
  fetch: (req: Request, server: import('bun').Server<unknown>) => Response | Promise<Response>
  websocket: import('bun').WebSocketHandler<unknown>
} {
  return {
    fetch: async (req) => {
      const url = new URL(req.url)
      rec.fetchCalls.push({ pathname: url.pathname, method: req.method })
      if (url.pathname === '/chat' && req.method === 'GET') {
        return new Response('chat-html', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      if (url.pathname === '/api/v1/sign-up' && req.method === 'GET') {
        return new Response(null, { status: 302, headers: { location: 'https://auth.example/oauth/start' } })
      }
      if (url.pathname === '/mobile' && req.method === 'GET') {
        return new Response('mobile-html', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      return new Response('landing-404', { status: 404 })
    },
    websocket: {
      open() {
        rec.wsOpens++
      },
      message() {},
      close() {},
    },
  }
}

interface TelegramRecorder {
  posts: Array<{ secret_token: string | null; body: string }>
}

function makeTelegramWebhookHandler(rec: TelegramRecorder): (req: Request) => Promise<Response> {
  return async (req) => {
    const secret = req.headers.get('x-telegram-bot-api-secret-token')
    const body = await req.text()
    rec.posts.push({ secret_token: secret, body })
    if (secret !== 'tg-secret-1') return new Response('forbidden', { status: 403 })
    return new Response('ok', { status: 200 })
  }
}

describe('boot composer with landing_server wires /chat + /api/v1/sign-up', () => {
  test('GET /chat reaches the landing handler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-comp-landing-chat-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    const rec: LandingRecorder = { fetchCalls: [], wsOpens: 0 }
    const handle = await boot({
      port: 0,
      composer: ({ db, project_slug }) => ({
        db,
        project_slug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
        landing_server: makeLandingHandler(rec),
      }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.server.port}/chat`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('chat-html')
      expect(rec.fetchCalls).toHaveLength(1)
      expect(rec.fetchCalls[0]).toEqual({ pathname: '/chat', method: 'GET' })
    } finally {
      await handle.shutdown()
    }
  })

  test('GET /mobile reaches the landing handler (ISSUES #208 — was: default 404 fall-through)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-comp-landing-mobile-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    const rec: LandingRecorder = { fetchCalls: [], wsOpens: 0 }
    const handle = await boot({
      port: 0,
      composer: ({ db, project_slug }) => ({
        db,
        project_slug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
        landing_server: makeLandingHandler(rec),
      }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.server.port}/mobile`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('mobile-html')
      // Delegation happened (the composed default 404 never calls the
      // landing handler — same precedence-chain bug class as ISSUES #59).
      expect(rec.fetchCalls).toHaveLength(1)
      expect(rec.fetchCalls[0]).toEqual({ pathname: '/mobile', method: 'GET' })
    } finally {
      await handle.shutdown()
    }
  })

  test('GET /api/v1/sign-up reaches the landing handler with 302', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-comp-landing-signup-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    const rec: LandingRecorder = { fetchCalls: [], wsOpens: 0 }
    const handle = await boot({
      port: 0,
      composer: ({ db, project_slug }) => ({
        db,
        project_slug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
        landing_server: makeLandingHandler(rec),
      }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.server.port}/api/v1/sign-up?via=web`, {
        redirect: 'manual',
      })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('https://auth.example/oauth/start')
    } finally {
      await handle.shutdown()
    }
  })

  test('GET /healthz still reachable when landing is wired (cross-instance fall-through)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-comp-landing-healthz-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    const rec: LandingRecorder = { fetchCalls: [], wsOpens: 0 }
    const handle = await boot({
      port: 0,
      composer: ({ db, project_slug }) => ({
        db,
        project_slug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
        landing_server: makeLandingHandler(rec),
      }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.server.port}/healthz`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status: string; project_slug: string }
      expect(body.status).toBe('ok')
      expect(body.project_slug).toBe('alice')
    } finally {
      await handle.shutdown()
    }
  })
})

describe('boot composer with telegram_webhook wires /webhook/telegram', () => {
  test('POST /webhook/telegram with correct secret returns 200', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-comp-tg-good-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    const rec: TelegramRecorder = { posts: [] }
    const handle = await boot({
      port: 0,
      composer: ({ db, project_slug }) => ({
        db,
        project_slug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
        telegram_webhook: { handler: makeTelegramWebhookHandler(rec) },
      }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.server.port}/webhook/telegram`, {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'tg-secret-1', 'content-type': 'application/json' },
        body: JSON.stringify({ update_id: 1 }),
      })
      expect(res.status).toBe(200)
      expect(rec.posts).toHaveLength(1)
      expect(rec.posts[0]?.secret_token).toBe('tg-secret-1')
    } finally {
      await handle.shutdown()
    }
  })

  test('POST /webhook/telegram with wrong secret returns 403 from handler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-comp-tg-bad-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    const rec: TelegramRecorder = { posts: [] }
    const handle = await boot({
      port: 0,
      composer: ({ db, project_slug }) => ({
        db,
        project_slug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
        telegram_webhook: { handler: makeTelegramWebhookHandler(rec) },
      }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.server.port}/webhook/telegram`, {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
        body: '{}',
      })
      expect(res.status).toBe(403)
    } finally {
      await handle.shutdown()
    }
  })

  test('GET /webhook/telegram (wrong method) does NOT route to telegram handler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-comp-tg-getmiss-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    const rec: TelegramRecorder = { posts: [] }
    const handle = await boot({
      port: 0,
      composer: ({ db, project_slug }) => ({
        db,
        project_slug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
        telegram_webhook: { handler: makeTelegramWebhookHandler(rec) },
      }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.server.port}/webhook/telegram`)
      expect(res.status).toBe(404)
      expect(rec.posts).toHaveLength(0)
    } finally {
      await handle.shutdown()
    }
  })
})

describe('boot composer with all four surfaces wires precedence chain', () => {
  test('telegram > landing > cross-instance > healthz precedence holds end-to-end', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-comp-all-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    const km = await mintKey()
    const landing: LandingRecorder = { fetchCalls: [], wsOpens: 0 }
    const tg: TelegramRecorder = { posts: [] }

    const handle = await boot({
      port: 0,
      composer: ({ db, project_slug }) => ({
        db,
        project_slug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
        landing_server: makeLandingHandler(landing),
        telegram_webhook: { handler: makeTelegramWebhookHandler(tg) },
        connect_api: {
          auth: { jwks: makeJwksCache(km), receiving_instance_slug: project_slug },
          handlers: {
            on_inbound_message: async () => ({ ack_id: 'x' }),
            list_projects: async () => [],
          },
        },
      }),
    })
    try {
      const tgRes = await fetch(`http://127.0.0.1:${handle.server.port}/webhook/telegram`, {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'tg-secret-1' },
        body: '{}',
      })
      expect(tgRes.status).toBe(200)
      expect(tg.posts).toHaveLength(1)

      const chatRes = await fetch(`http://127.0.0.1:${handle.server.port}/chat`)
      expect(chatRes.status).toBe(200)
      expect(landing.fetchCalls.map((c) => c.pathname)).toContain('/chat')

      // Cross-instance /health endpoint (unauthed liveness path).
      const ctRes = await fetch(`http://127.0.0.1:${handle.server.port}/connect/v1/health`)
      expect(ctRes.status).toBe(200)

      // Default fallthrough.
      const hzRes = await fetch(`http://127.0.0.1:${handle.server.port}/healthz`)
      expect(hzRes.status).toBe(200)
    } finally {
      await handle.shutdown()
    }
  })
})

describe('boot composer with no chained surfaces falls back to /healthz only', () => {
  test('legacy P1 composer (no landing/tg/cross-instance) keeps /healthz reachable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-comp-legacy-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    const handle = await boot({
      port: 0,
      composer: ({ db, project_slug }) => ({
        db,
        project_slug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
      }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.server.port}/healthz`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status: string }
      expect(body.status).toBe('ok')
      // Unknown route → 404 from defaultHealthzHandler.
      const miss = await fetch(`http://127.0.0.1:${handle.server.port}/anything-else`)
      expect(miss.status).toBe(404)
    } finally {
      await handle.shutdown()
    }
  })
})
