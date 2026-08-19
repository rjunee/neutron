/**
 * Unit test for the web CODEX CONNECT API client (Settings tab, Part B). Pure
 * over an injected `fetchImpl` — no DOM, no network. Asserts each method targets
 * the right path/method/body, carries the bearer, and surfaces a coded error
 * (the metered-key rejection in particular).
 */

import { describe, expect, it } from 'bun:test'

import { WebCodexCredentialClient, CodexClientError } from '../codex-credential-client.ts'

const BASE = 'https://sam.neutron.test'
const TOKEN = 'dev:sam'

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function capture(res: Response): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  calls: Array<{ url: string; method: string; body: unknown; auth: string | null }>
} {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
        auth: headers['authorization'] ?? null,
      })
      return res
    },
  }
}

describe('WebCodexCredentialClient', () => {
  it('status → GET /codex-auth with bearer', async () => {
    const cap = capture(jsonRes({ ok: true, status: 'not_connected', materialized: false }))
    const client = new WebCodexCredentialClient({ base_url: BASE, token: TOKEN, fetchImpl: cap.fetchImpl })
    const s = await client.status('acme')
    expect(s.status).toBe('not_connected')
    expect(cap.calls[0]?.url).toBe(`${BASE}/api/app/projects/acme/codex-auth`)
    expect(cap.calls[0]?.method).toBe('GET')
    expect(cap.calls[0]?.auth).toBe(`Bearer ${TOKEN}`)
  })

  it('connect → POST { auth } and returns status', async () => {
    const cap = capture(jsonRes({ ok: true, status: 'connected', mode: 'subscription' }, 201))
    const client = new WebCodexCredentialClient({ base_url: BASE, token: TOKEN, fetchImpl: cap.fetchImpl })
    const s = await client.connect('acme', '{"tokens":{"access_token":"a","refresh_token":"r"}}')
    expect(s.status).toBe('connected')
    expect(cap.calls[0]?.method).toBe('POST')
    expect((cap.calls[0]?.body as { auth: string }).auth).toContain('refresh_token')
  })

  it('connect surfaces the metered_key rejection as a coded error', async () => {
    const cap = capture(jsonRes({ ok: false, code: 'metered_key', message: 'subscription only' }, 400))
    const client = new WebCodexCredentialClient({ base_url: BASE, token: TOKEN, fetchImpl: cap.fetchImpl })
    let caught: unknown
    try {
      await client.connect('acme', 'sk-live-abc')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CodexClientError)
    expect((caught as CodexClientError).code).toBe('metered_key')
    expect((caught as CodexClientError).status).toBe(400)
  })

  it('disconnect → DELETE /codex-auth', async () => {
    const cap = capture(jsonRes({ ok: true, disconnected: true }))
    const client = new WebCodexCredentialClient({ base_url: BASE, token: TOKEN, fetchImpl: cap.fetchImpl })
    await client.disconnect('acme')
    expect(cap.calls[0]?.method).toBe('DELETE')
    expect(cap.calls[0]?.url).toBe(`${BASE}/api/app/projects/acme/codex-auth`)
  })

  // ── GLOBAL (primary — General admin UI): the account-wide route ──
  it('statusGlobal → GET /api/app/codex-auth (no project segment)', async () => {
    const cap = capture(jsonRes({ ok: true, status: 'connected', scope: 'global' }))
    const client = new WebCodexCredentialClient({ base_url: BASE, token: TOKEN, fetchImpl: cap.fetchImpl })
    const s = await client.statusGlobal()
    expect(s.status).toBe('connected')
    expect(s.scope).toBe('global')
    expect(cap.calls[0]?.url).toBe(`${BASE}/api/app/codex-auth`)
    expect(cap.calls[0]?.method).toBe('GET')
    expect(cap.calls[0]?.auth).toBe(`Bearer ${TOKEN}`)
  })

  it('connectGlobal → POST /api/app/codex-auth { auth }', async () => {
    const cap = capture(jsonRes({ ok: true, status: 'connected', scope: 'global' }, 201))
    const client = new WebCodexCredentialClient({ base_url: BASE, token: TOKEN, fetchImpl: cap.fetchImpl })
    const s = await client.connectGlobal('{"tokens":{"access_token":"a","refresh_token":"r"}}')
    expect(s.scope).toBe('global')
    expect(cap.calls[0]?.url).toBe(`${BASE}/api/app/codex-auth`)
    expect(cap.calls[0]?.method).toBe('POST')
    expect((cap.calls[0]?.body as { auth: string }).auth).toContain('refresh_token')
  })

  it('disconnectAllSeats → the UNQUALIFIED DELETE, which now removes every seat', async () => {
    // Renamed from `disconnectGlobal`. The route did not change; what the server
    // does with it did — a bare DELETE maps to `disconnectAllAccounts`. A name
    // that says "global" reads as "the global one" rather than "all of them",
    // which is exactly how an unchanged button became destructive.
    const cap = capture(jsonRes({ ok: true, disconnected: true }))
    const client = new WebCodexCredentialClient({ base_url: BASE, token: TOKEN, fetchImpl: cap.fetchImpl })
    await client.disconnectAllSeats()
    expect(cap.calls[0]?.method).toBe('DELETE')
    expect(cap.calls[0]?.url).toBe(`${BASE}/api/app/codex-auth`)
  })

  it('disconnectSeat → DELETE scoped to ONE seat', async () => {
    const cap = capture(jsonRes({ ok: true, disconnected: true }))
    const client = new WebCodexCredentialClient({ base_url: BASE, token: TOKEN, fetchImpl: cap.fetchImpl })
    await client.disconnectSeat('work')
    expect(cap.calls[0]?.method).toBe('DELETE')
    expect(cap.calls[0]?.url).toBe(`${BASE}/api/app/codex-auth?account=work`)
  })

  it('connectGlobal sends the seat name when given, and omits it when not', async () => {
    // Omitting `account` is not neutral: the server resolves it to DEFAULT_SLOT
    // and overwrites the first seat. Both shapes are pinned so neither drifts.
    const named = capture(jsonRes({ ok: true, status: 'connected' }))
    await new WebCodexCredentialClient({ base_url: BASE, token: TOKEN, fetchImpl: named.fetchImpl })
      .connectGlobal('{"tokens":{}}', 'work')
    expect((named.calls[0]?.body as { account?: string }).account).toBe('work')

    const bare = capture(jsonRes({ ok: true, status: 'connected' }))
    await new WebCodexCredentialClient({ base_url: BASE, token: TOKEN, fetchImpl: bare.fetchImpl })
      .connectGlobal('{"tokens":{}}')
    expect((bare.calls[0]?.body as { account?: string }).account).toBeUndefined()
  })
})
