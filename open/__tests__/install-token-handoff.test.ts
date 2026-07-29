/**
 * Unit tests for the Open Claude-Max OAuth install-token handoff
 * (`open/install-token-handoff.ts`). Covers the initiate → .sh → complete →
 * state lifecycle, token-shape validation, idempotency, expiry, and that the
 * injected persist/restart side effects fire exactly once.
 */

import { describe, expect, test } from 'bun:test'

import {
  buildOpenInstallTokenHandler,
  buildReconnectHandoff,
  InstallTokenStore,
} from '../install-token-handoff.ts'

const GOOD_TOKEN = 'sk-ant-oat01-' + 'A'.repeat(40)
const ORIGIN = 'http://127.0.0.1:7800'

function makeHandler(opts?: { now?: () => number; ttlMs?: number }) {
  let persisted: string | null = null
  let restarts = 0
  let seq = 0
  const handler = buildOpenInstallTokenHandler({
    persistToken: (t) => {
      persisted = t
    },
    requestRestart: () => {
      restarts++
    },
    genSignupId: () => `00000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`,
    ...(opts?.now ? { now: opts.now } : {}),
    ...(opts?.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  })
  return {
    handler,
    state: () => ({ persisted, restarts }),
  }
}

function req(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Request {
  const headers: Record<string, string> = { ...extraHeaders }
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new Request(`${ORIGIN}${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  })
}

async function initiate(handler: ReturnType<typeof buildOpenInstallTokenHandler>) {
  const res = await handler.handle(req('POST', '/oauth/max/install-token/initiate'))
  expect(res).not.toBeNull()
  expect(res!.status).toBe(200)
  return (await res!.json()) as { signup_id: string; command: string; script_url: string }
}

describe('install-token handoff', () => {
  test('non-matching path → null (chain continues)', async () => {
    const { handler } = makeHandler()
    expect(await handler.handle(req('GET', '/chat'))).toBeNull()
    expect(await handler.handle(req('GET', '/oauth/google/start'))).toBeNull()
  })

  test('initiate mints a signup_id + a one-liner for this origin', async () => {
    const { handler } = makeHandler()
    const j = await initiate(handler)
    expect(j.signup_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(j.script_url).toBe(`${ORIGIN}/oauth/max/install-token/${j.signup_id}.sh`)
    expect(j.command).toBe(`curl -fsSL ${j.script_url} | bash`)
  })

  test('GET /<id>.sh renders the installer with signup_id + callback', async () => {
    const { handler } = makeHandler()
    const j = await initiate(handler)
    const res = await handler.handle(req('GET', `/oauth/max/install-token/${j.signup_id}.sh`))
    expect(res!.status).toBe(200)
    expect(res!.headers.get('content-type')).toContain('text/plain')
    const script = await res!.text()
    expect(script).toContain('claude setup-token')
    expect(script).toContain(`SIGNUP_ID='${j.signup_id}'`)
    expect(script).toContain(`CALLBACK_URL='${ORIGIN}/oauth/max/install-token/complete'`)
    expect(script).toContain('https://claude.ai/install.sh')
  })

  test('honours X-Forwarded-Proto/Host so a reverse-proxied HTTPS origin is not downgraded to http', async () => {
    // A TLS-terminating reverse proxy (e.g. Caddy/nginx) forwards to this
    // process over plain HTTP on loopback — the raw request `url.origin` is
    // `http://` even though the public client used `https://`. Without
    // honouring the forwarded headers, the emitted CALLBACK_URL is `http://`
    // and the proxy's http→https redirect (308) breaks the installer's bare
    // `curl -X POST` (no -L). Regression test for that bug.
    const { handler } = makeHandler()
    const initiateRes = await handler.handle(
      req('POST', '/oauth/max/install-token/initiate', undefined, {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'neutron.example.com',
      }),
    )
    const j = (await initiateRes!.json()) as { signup_id: string; script_url: string }
    expect(j.script_url).toBe(
      `https://neutron.example.com/oauth/max/install-token/${j.signup_id}.sh`,
    )

    const shRes = await handler.handle(
      req('GET', `/oauth/max/install-token/${j.signup_id}.sh`, undefined, {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'neutron.example.com',
      }),
    )
    const script = await shRes!.text()
    expect(script).toContain(
      `CALLBACK_URL='https://neutron.example.com/oauth/max/install-token/complete'`,
    )
  })

  test('GET /<id>.sh for an unknown id → 404', async () => {
    const { handler } = makeHandler()
    const res = await handler.handle(
      req('GET', '/oauth/max/install-token/00000000-0000-4000-8000-999999999999.sh'),
    )
    expect(res!.status).toBe(404)
  })

  test('complete with a valid token persists, restarts, marks completed', async () => {
    const { handler, state } = makeHandler()
    const j = await initiate(handler)

    let res = await handler.handle(
      req('GET', `/oauth/max/install-token/state?signup_id=${j.signup_id}`),
    )
    expect(((await res!.json()) as { status: string }).status).toBe('pending')

    res = await handler.handle(
      req('POST', '/oauth/max/install-token/complete', { signup_id: j.signup_id, token: GOOD_TOKEN }),
    )
    expect(res!.status).toBe(204)
    expect(state().persisted).toBe(GOOD_TOKEN)
    expect(state().restarts).toBe(1)

    res = await handler.handle(
      req('GET', `/oauth/max/install-token/state?signup_id=${j.signup_id}`),
    )
    expect(((await res!.json()) as { status: string }).status).toBe('completed')
  })

  test('complete is idempotent — second callback does not restart again', async () => {
    const { handler, state } = makeHandler()
    const j = await initiate(handler)
    await handler.handle(
      req('POST', '/oauth/max/install-token/complete', { signup_id: j.signup_id, token: GOOD_TOKEN }),
    )
    const res = await handler.handle(
      req('POST', '/oauth/max/install-token/complete', { signup_id: j.signup_id, token: GOOD_TOKEN }),
    )
    expect(res!.status).toBe(200)
    expect(((await res!.json()) as { status: string }).status).toBe('already_completed')
    expect(state().restarts).toBe(1)
  })

  test('complete rejects a malformed token (no persist, no restart)', async () => {
    const { handler, state } = makeHandler()
    const j = await initiate(handler)
    const res = await handler.handle(
      req('POST', '/oauth/max/install-token/complete', { signup_id: j.signup_id, token: 'sk-ant-nope' }),
    )
    expect(res!.status).toBe(400)
    expect(state().persisted).toBeNull()
    expect(state().restarts).toBe(0)
  })

  test('complete for an unknown signup_id → 404', async () => {
    const { handler } = makeHandler()
    const res = await handler.handle(
      req('POST', '/oauth/max/install-token/complete', {
        signup_id: '00000000-0000-4000-8000-000000000000',
        token: GOOD_TOKEN,
      }),
    )
    expect(res!.status).toBe(404)
  })

  test('store growth is bounded — a flood of handoffs evicts the oldest (FIFO)', () => {
    const store = new InstallTokenStore()
    const ids: string[] = []
    for (let i = 0; i < 600; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      ids.push(id)
      store.create(id)
    }
    // The earliest rows were evicted (cap 512); the most recent survive.
    expect(store.get(ids[0]!)).toBeNull()
    expect(store.get(ids[599]!)).not.toBeNull()
  })

  test('a handoff past its TTL reads expired and rejects completion', async () => {
    let clock = 1_000_000
    const { handler, state } = makeHandler({ now: () => clock, ttlMs: 60_000 })
    const j = await initiate(handler)
    clock += 60_001 // past TTL

    const stateRes = await handler.handle(
      req('GET', `/oauth/max/install-token/state?signup_id=${j.signup_id}`),
    )
    expect(stateRes!.status).toBe(200)
    expect(((await stateRes!.json()) as { status: string }).status).toBe('expired')

    const completeRes = await handler.handle(
      req('POST', '/oauth/max/install-token/complete', { signup_id: j.signup_id, token: GOOD_TOKEN }),
    )
    expect(completeRes!.status).toBe(410)
    expect(state().persisted).toBeNull()
    expect(state().restarts).toBe(0)

    // The .sh installer also refuses to render for an expired handoff.
    const shRes = await handler.handle(
      req('GET', `/oauth/max/install-token/${j.signup_id}.sh`),
    )
    expect(shRes!.status).toBe(410)
  })
})

// Direct coverage of the on-demand reconnect closure the composer (and, verbatim,
// a hosted deployment) run — the seam that a "Reconnect" button tap drives. Round-2
// gap-close: previously only a fake seam was injected in the turn-runner tests, so
// the real synthetic-Request / status / JSON-parse logic was untested.
describe('buildReconnectHandoff', () => {
  test('drives a real handler and mints a fresh loopback-origin command', async () => {
    const { handler } = makeHandler()
    const reconnect = buildReconnectHandoff(handler.handle, 7800)
    const minted = await reconnect()
    expect(minted).not.toBeNull()
    // The synthetic request carries no X-Forwarded-* headers, so the command is
    // minted at the loopback origin on the requested port (not a public origin).
    expect(minted!.command).toContain('http://127.0.0.1:7800/oauth/max/install-token/')
    expect(minted!.command).toContain('.sh | bash')
    expect(minted!.command.startsWith('curl -fsSL ')).toBe(true)
  })

  test('honours the injected port in the minted command', async () => {
    const { handler } = makeHandler()
    const reconnect = buildReconnectHandoff(handler.handle, 9123)
    const minted = await reconnect()
    expect(minted!.command).toContain('http://127.0.0.1:9123/oauth/max/install-token/')
  })

  test('each tap mints a DISTINCT fresh signup_id (no reuse of a stale handoff)', async () => {
    const { handler } = makeHandler()
    const reconnect = buildReconnectHandoff(handler.handle, 7800)
    const a = await reconnect()
    const b = await reconnect()
    expect(a!.command).not.toBe(b!.command)
  })

  test('degrades to null (no throw) when the handler yields a non-200 response', async () => {
    const reconnect = buildReconnectHandoff(
      async () => new Response('nope', { status: 500 }),
      7800,
    )
    expect(await reconnect()).toBeNull()
  })

  test('degrades to null when the handler chain-misses (returns null)', async () => {
    const reconnect = buildReconnectHandoff(async () => null, 7800)
    expect(await reconnect()).toBeNull()
  })

  test('degrades to null when the 200 body has no command string', async () => {
    const reconnect = buildReconnectHandoff(
      async () => Response.json({ signup_id: 'x' }),
      7800,
    )
    expect(await reconnect()).toBeNull()
  })

  test('degrades to null when the handler throws (never propagates)', async () => {
    const reconnect = buildReconnectHandoff(async () => {
      throw new Error('boom')
    }, 7800)
    expect(await reconnect()).toBeNull()
  })
})
