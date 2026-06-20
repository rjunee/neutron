import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  AppWsAdapter,
  InMemoryAppWsSessionRegistry,
  appWsTopicId,
  createAppWsAuthResolver,
  type AppWsOutbound,
} from '../../channels/index.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { createAppWsSurface } from '../http/app-ws-surface.ts'
import type { IncomingEvent } from '../../channels/types.ts'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  receivedEvents: IncomingEvent[]
  registry: InMemoryAppWsSessionRegistry
  adapter: AppWsAdapter
  close(): Promise<void>
}

async function startGateway(): Promise<Harness> {
  const receivedEvents: IncomingEvent[] = []
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({
    registry,
    receiver: {
      receive: async (e) => {
        receivedEvents.push(e)
      },
    },
  })
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const surface = createAppWsSurface({ adapter, registry, auth, project_slug: 'demo' })
  const composed = composeHttpHandler({
    appWs: { handler: surface.handler, websocket: surface.websocket },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    receivedEvents,
    registry,
    adapter,
    close: async () => {
      await server.stop(true)
    },
  }
}

describe('app-ws gateway surface — HTTP POST /api/app/chat/send', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('rejects requests without a Bearer token', async () => {
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hi' }),
    })
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('rejects malformed JSON', async () => {
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev:sam' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })

  it('echoes the user message and dispatches an IncomingEvent', async () => {
    // Pre-register a fake sender so we can observe the echo.
    const captured: AppWsOutbound[] = []
    harness.registry.register(appWsTopicId('sam'), (e) => captured.push(e))
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev:sam' },
      body: JSON.stringify({ body: 'hello from expo', client_msg_id: 'c-1' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      message_id: string
      echo: { type: 'user_message'; body: string; client_msg_id?: string }
    }
    expect(json.ok).toBe(true)
    expect(typeof json.message_id).toBe('string')
    // Codex P1 fix: response body includes the canonical envelope so
    // the client can render even when the WS is down.
    expect(json.echo.type).toBe('user_message')
    expect(json.echo.body).toBe('hello from expo')
    expect(json.echo.client_msg_id).toBe('c-1')

    expect(captured.length).toBe(1)
    const env = captured[0]
    if (env === undefined || env.type !== 'user_message') {
      throw new Error('expected user_message echo')
    }
    expect(env.body).toBe('hello from expo')
    expect(env.client_msg_id).toBe('c-1')

    expect(harness.receivedEvents.length).toBe(1)
    expect(harness.receivedEvents[0]?.body.text).toBe('hello from expo')
    expect(harness.receivedEvents[0]?.channel_kind).toBe('app_socket')
  })

  it('rejects bodies above MAX_USER_MESSAGE_LEN with 413', async () => {
    // Codex P2 fix: HTTP parity with the WS path's decode cap.
    const tooLong = 'a'.repeat(20_000)
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev:sam' },
      body: JSON.stringify({ body: tooLong }),
    })
    expect(res.status).toBe(413)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('body_too_long')
  })

  it('returns echo body even when no socket is registered (HTTP-only sends)', async () => {
    // Codex P1 fix: when the WS is down the gateway still echoes via
    // the response body so the client doesn't lose the user's
    // message.
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev:offline' },
      body: JSON.stringify({ body: 'when ws is down' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      echo: { type: 'user_message'; body: string }
    }
    expect(json.ok).toBe(true)
    expect(json.echo.body).toBe('when ws is down')
  })

  it('returns 401 when token char-set is rejected', async () => {
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev: bad space' },
      body: JSON.stringify({ body: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  it('round-trips project_id when set in the POST body (P5.2)', async () => {
    // Pre-register a fake sender so we can observe the echo.
    const captured: AppWsOutbound[] = []
    harness.registry.register(appWsTopicId('sam'), (e) => captured.push(e))
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev:sam' },
      body: JSON.stringify({
        body: 'in project acme',
        client_msg_id: 'c-1',
        project_id: 'acme',
      }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      echo: { type: 'user_message'; body: string; project_id?: string }
    }
    expect(json.echo.project_id).toBe('acme')

    expect(captured.length).toBe(1)
    const env = captured[0]
    if (env === undefined || env.type !== 'user_message') {
      throw new Error('expected user_message echo')
    }
    expect(env.project_id).toBe('acme')
  })

  it('drops malformed project_id silently (P5.2 — sanitize-and-strip semantics)', async () => {
    const captured: AppWsOutbound[] = []
    harness.registry.register(appWsTopicId('sam'), (e) => captured.push(e))
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev:sam' },
      body: JSON.stringify({
        body: 'malformed project id is ignored',
        // Spaces + slashes — not allowed by sanitizeProjectId.
        project_id: 'invalid / project',
      }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      echo: { type: 'user_message'; body: string; project_id?: string }
    }
    // Malformed values are silently dropped — the rest of the send
    // succeeds without project scoping.
    expect(json.echo.project_id).toBeUndefined()
    expect(captured[0]?.type).toBe('user_message')
    if (captured[0]?.type === 'user_message') {
      expect(captured[0]?.project_id).toBeUndefined()
    }
  })

  it('omits project_id when none is sent (back-compat with P5.1 clients)', async () => {
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev:sam' },
      body: JSON.stringify({ body: 'global / unscoped' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      echo: { type: 'user_message'; body: string; project_id?: string }
    }
    expect(json.echo.project_id).toBeUndefined()
  })

  // Argus r1 BLOCKING #3 — HTTP fallback was reading only
  // `{ body, client_msg_id, project_id }` and dropping attachments,
  // so the WS-down path silently lost every image attach.
  it('threads attachments through both echo and dispatch on the HTTP fallback (P5.1)', async () => {
    const captured: AppWsOutbound[] = []
    harness.registry.register(appWsTopicId('sam'), (e) => captured.push(e))
    const attachments = [
      'https://cdn.example/img.png',
      '/api/app/upload/sam/aabb1122.png',
    ]
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev:sam' },
      body: JSON.stringify({
        body: 'check out this image',
        client_msg_id: 'c-imgs',
        attachments,
      }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      echo: { type: 'user_message'; attachments?: ReadonlyArray<string> }
    }
    expect(json.echo.attachments).toEqual(attachments)
    // Echo via the registry — the optimistic-bubble reconciliation path.
    expect(captured.length).toBe(1)
    const env = captured[0]
    if (env === undefined || env.type !== 'user_message') {
      throw new Error('expected user_message echo via registry')
    }
    expect(env.attachments).toEqual(attachments)
    // dispatchInbound — the agent loop sees attachments on
    // IncomingEvent.adapter_metadata.attachments.
    expect(harness.receivedEvents.length).toBe(1)
    expect(harness.receivedEvents[0]?.adapter_metadata?.attachments).toEqual(
      attachments,
    )
  })

  // Argus r1 BLOCKING #2 — composer enables Send when attachments are
  // present even with an empty body. HTTP path was returning 400
  // `missing_body`, so the optimistic bubble flipped failed.
  it('accepts attachments-only sends (empty body) via HTTP (P5.1)', async () => {
    const captured: AppWsOutbound[] = []
    harness.registry.register(appWsTopicId('sam'), (e) => captured.push(e))
    const attachments = ['/api/app/upload/sam/aabb1122.png']
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev:sam' },
      body: JSON.stringify({ body: '', attachments }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      echo: { type: 'user_message'; body: string; attachments?: ReadonlyArray<string> }
    }
    expect(json.echo.body).toBe('')
    expect(json.echo.attachments).toEqual(attachments)
    expect(captured[0]?.type).toBe('user_message')
    expect(harness.receivedEvents.length).toBe(1)
  })

  // Argus r1 BLOCKING #2 — still rejects neither-body-nor-attachments
  // with the same `missing_body` shape so empty-on-empty sends never
  // smuggle past the gate.
  it('rejects empty body AND no attachments with missing_body (P5.1)', async () => {
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev:sam' },
      body: JSON.stringify({ body: '', attachments: [] }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_body')
  })
})

describe('app-ws gateway surface — WS /ws/app/chat', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('rejects upgrade with missing token (401)', async () => {
    const res = await fetch(`${harness.base}/ws/app/chat`)
    // Bun's WS upgrade response with no upgrade header returns the
    // server's normal Response; here we expect a 401 JSON body.
    expect(res.status).toBe(401)
  })

  it('upgrades and round-trips a user_message via the WebSocket', async () => {
    const ws = new WebSocket(`${wsUrl(harness.base)}/ws/app/chat?token=sam`)
    const events: AppWsOutbound[] = []
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await opened
    // First envelope is session_ready
    await waitFor(() => events.some((e) => e.type === 'session_ready'))
    const ready = events.find((e) => e.type === 'session_ready')
    if (ready === undefined || ready.type !== 'session_ready') throw new Error('expected session_ready')
    expect(ready.user_id).toBe('sam')
    expect(ready.project_slug).toBe('demo')
    expect(ready.topic_id).toBe('app:sam')

    // Send an inbound user_message; the gateway echoes it back.
    ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'from ws', client_msg_id: 'c-2' }))
    await waitFor(() => events.some((e) => e.type === 'user_message'))
    const echo = events.find((e) => e.type === 'user_message')
    if (echo === undefined || echo.type !== 'user_message') throw new Error('expected user_message echo')
    expect(echo.body).toBe('from ws')
    expect(echo.client_msg_id).toBe('c-2')

    expect(harness.receivedEvents.length).toBe(1)
    expect(harness.receivedEvents[0]?.body.text).toBe('from ws')

    ws.close()
    await new Promise((r) => setTimeout(r, 50))
  })

  it('emits an error envelope on malformed inbound', async () => {
    const ws = new WebSocket(`${wsUrl(harness.base)}/ws/app/chat?token=sam`)
    const events: AppWsOutbound[] = []
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await opened
    await waitFor(() => events.some((e) => e.type === 'session_ready'))
    ws.send('not-json')
    await waitFor(() => events.some((e) => e.type === 'error'))
    const err = events.find((e) => e.type === 'error')
    if (err === undefined || err.type !== 'error') throw new Error('expected error envelope')
    expect(err.code).toBe('malformed_json')
    ws.close()
    await new Promise((r) => setTimeout(r, 50))
  })

  it('falls through to default handler on unrelated paths', async () => {
    const res = await fetch(`${harness.base}/unrelated`)
    expect(res.status).toBe(404)
  })

  it('captures project_id from upgrade query + echoes on session_ready (P5.2)', async () => {
    const ws = new WebSocket(
      `${wsUrl(harness.base)}/ws/app/chat?token=sam&project_id=acme`,
    )
    const events: AppWsOutbound[] = []
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await opened
    await waitFor(() => events.some((e) => e.type === 'session_ready'))
    const ready = events.find((e) => e.type === 'session_ready')
    if (ready === undefined || ready.type !== 'session_ready') {
      throw new Error('expected session_ready')
    }
    expect(ready.project_id).toBe('acme')

    // Send a user_message WITHOUT a fresh project_id — the gateway
    // should fall back to the upgrade-time stash.
    ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'project-scoped' }))
    await waitFor(() => events.some((e) => e.type === 'user_message'))
    const echo = events.find((e) => e.type === 'user_message')
    if (echo === undefined || echo.type !== 'user_message') {
      throw new Error('expected user_message echo')
    }
    expect(echo.project_id).toBe('acme')

    // Now switch project mid-socket (the client moved tabs).
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'user_message',
        body: 'switched project',
        project_id: 'neutron',
      }),
    )
    await waitFor(() => events.filter((e) => e.type === 'user_message').length >= 2)
    const echoes = events.filter((e) => e.type === 'user_message')
    const switched = echoes[echoes.length - 1]
    if (switched === undefined || switched.type !== 'user_message') {
      throw new Error('expected second user_message echo')
    }
    expect(switched.project_id).toBe('neutron')

    ws.close()
    await new Promise((r) => setTimeout(r, 50))
  })

  it('omits project_id when none is passed on upgrade (P5.1 back-compat)', async () => {
    const ws = new WebSocket(`${wsUrl(harness.base)}/ws/app/chat?token=sam`)
    const events: AppWsOutbound[] = []
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await opened
    await waitFor(() => events.some((e) => e.type === 'session_ready'))
    const ready = events.find((e) => e.type === 'session_ready')
    if (ready === undefined || ready.type !== 'session_ready') {
      throw new Error('expected session_ready')
    }
    expect(ready.project_id).toBeUndefined()
    ws.close()
    await new Promise((r) => setTimeout(r, 50))
  })

  // Argus r1 BLOCKING #2 — the WS decoder used to hard-reject
  // body.length === 0 before checking attachments. Composer enables
  // Send when attachments.length > 0 even with no text; the gateway
  // must accept the same shape.
  it('accepts attachments-only WS sends (empty body) (P5.1)', async () => {
    const ws = new WebSocket(`${wsUrl(harness.base)}/ws/app/chat?token=sam`)
    const events: AppWsOutbound[] = []
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await opened
    await waitFor(() => events.some((e) => e.type === 'session_ready'))
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'user_message',
        body: '',
        attachments: ['/api/app/upload/sam/cafef00d.png'],
      }),
    )
    await waitFor(() => events.some((e) => e.type === 'user_message'))
    const echo = events.find((e) => e.type === 'user_message')
    if (echo === undefined || echo.type !== 'user_message') {
      throw new Error('expected user_message echo')
    }
    expect(echo.body).toBe('')
    expect(echo.attachments).toEqual(['/api/app/upload/sam/cafef00d.png'])
    ws.close()
    await new Promise((r) => setTimeout(r, 50))
  })

  // Argus r1 BLOCKING #2 — still drop "no body AND no attachments"
  // envelopes silently on the WS path.
  it('drops WS envelopes with neither body nor attachments (P5.1)', async () => {
    const ws = new WebSocket(`${wsUrl(harness.base)}/ws/app/chat?token=sam`)
    const events: AppWsOutbound[] = []
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await opened
    await waitFor(() => events.some((e) => e.type === 'session_ready'))
    ws.send(JSON.stringify({ v: 1, type: 'user_message', body: '' }))
    await waitFor(() => events.some((e) => e.type === 'error'))
    const err = events.find((e) => e.type === 'error')
    if (err === undefined || err.type !== 'error') {
      throw new Error('expected error envelope')
    }
    expect(err.code).toBe('malformed_envelope')
    ws.close()
    await new Promise((r) => setTimeout(r, 50))
  })

  it('round-trips attachments on the user_message envelope (P5.1)', async () => {
    const ws = new WebSocket(`${wsUrl(harness.base)}/ws/app/chat?token=sam`)
    const events: AppWsOutbound[] = []
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await opened
    await waitFor(() => events.some((e) => e.type === 'session_ready'))

    ws.send(
      JSON.stringify({
        v: 1,
        type: 'user_message',
        body: 'with image',
        attachments: ['https://cdn.example/img.png', '/api/app/upload/abc'],
      }),
    )
    await waitFor(() => events.some((e) => e.type === 'user_message'))
    const echo = events.find((e) => e.type === 'user_message')
    if (echo === undefined || echo.type !== 'user_message') {
      throw new Error('expected user_message echo')
    }
    expect(echo.attachments).toEqual(['https://cdn.example/img.png', '/api/app/upload/abc'])

    // IncomingEvent.adapter_metadata.attachments mirror.
    expect(harness.receivedEvents.length).toBeGreaterThan(0)
    const last = harness.receivedEvents[harness.receivedEvents.length - 1]
    expect(last?.adapter_metadata?.attachments).toEqual([
      'https://cdn.example/img.png',
      '/api/app/upload/abc',
    ])

    ws.close()
    await new Promise((r) => setTimeout(r, 50))
  })

  it('drops malformed project_id on upgrade query string (P5.2)', async () => {
    // Spaces in the value won't survive URL encoding cleanly but the
    // gateway's sanitiser is what we're testing — pass a value that
    // URL-encodes fine but trips the char-class check.
    const ws = new WebSocket(
      `${wsUrl(harness.base)}/ws/app/chat?token=sam&project_id=${encodeURIComponent('bad/value')}`,
    )
    const events: AppWsOutbound[] = []
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await opened
    await waitFor(() => events.some((e) => e.type === 'session_ready'))
    const ready = events.find((e) => e.type === 'session_ready')
    if (ready === undefined || ready.type !== 'session_ready') {
      throw new Error('expected session_ready')
    }
    expect(ready.project_id).toBeUndefined()
    ws.close()
    await new Promise((r) => setTimeout(r, 50))
  })
})

function wsUrl(base: string): string {
  return base.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://')
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
