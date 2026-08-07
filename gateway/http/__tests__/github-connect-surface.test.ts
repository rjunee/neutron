/**
 * The owner's GitHub connect surface.
 *
 * Device flow is the one OAuth shape that cannot complete inside a request — the
 * server gets a code, the OWNER types it into a browser, and only then does polling
 * succeed. So the contract under test is start/status, and the properties that matter
 * are the ones where getting it wrong is invisible:
 *
 *   - the code reaches the caller IMMEDIATELY, while polling continues behind it. A
 *     handler that awaited completion would hold a request open for minutes and give
 *     the owner nothing to act on, which is the same as not shipping it.
 *   - a second START returns the SAME code. Two live device codes for one account
 *     means the owner can approve the one the server stopped polling, which presents
 *     as "I approved it and nothing happened".
 *   - the `device_code` NEVER appears in a response. It is the bearer half of the
 *     exchange: anyone holding it can complete the flow and take the token.
 *   - a missing client id is a NAMED error, because device flow cannot produce a
 *     code without one and a generic failure would send someone hunting the network.
 */

import { describe, expect, test } from 'bun:test'

import { createGitHubConnectSurface } from '../github-connect-surface.ts'
import type { PresentableGrant } from '@neutronai/github/connect.ts'

const OWNER = 'owner'
const CLIENT_ID = 'Iv1.synthetic-client-id'
const DEVICE_CODE = 'DEVICE-SECRET-HALF-NEVER-SHOWN'
const TOKEN = 'gho_synthetic_surface_token'

/** Bearer resolver that always authorises the owner. */
const auth = {
  resolve: async () => ({ project_slug: OWNER, user_id: 'owner' }),
} as never

/** A secrets store holding whatever `put` was last given. */
function fakeSecrets(initial: string | null = null) {
  let stored = initial
  return {
    store: {
      async get() {
        return stored
      },
      async put({ plaintext }: { plaintext: string }) {
        stored = plaintext
      },
    } as never,
    read: () => stored,
  }
}

function req(method: 'GET' | 'POST'): Request {
  return new Request('https://t.example.test/api/app/github-auth', {
    method,
    headers: { Authorization: 'Bearer dev:owner' },
  })
}

const GRANT: PresentableGrant = {
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in_seconds: 900,
}

describe('GET — status', () => {
  test('reports not_connected with no token and no flow', async () => {
    const s = fakeSecrets(null)
    const surface = createGitHubConnectSurface({ secrets: s.store, auth, client_id: CLIENT_ID })
    const res = await surface.handler(req('GET'))
    expect(await res!.json()).toMatchObject({ status: 'not_connected' })
  })

  test('reports connected once a token is stored', async () => {
    const s = fakeSecrets(TOKEN)
    const surface = createGitHubConnectSurface({ secrets: s.store, auth, client_id: CLIENT_ID })
    expect(await (await surface.handler(req('GET')))!.json()).toMatchObject({ status: 'connected' })
  })

  test('ignores paths it does not own', async () => {
    const s = fakeSecrets(null)
    const surface = createGitHubConnectSurface({ secrets: s.store, auth, client_id: CLIENT_ID })
    const other = new Request('https://t.example.test/api/app/projects/p1/settings', {
      headers: { Authorization: 'Bearer dev:owner' },
    })
    // null lets the next slot in the ladder claim it.
    expect(await surface.handler(other)).toBeNull()
  })
})

describe('POST — start', () => {
  test('returns the code IMMEDIATELY while polling continues behind it', async () => {
    const s = fakeSecrets(null)
    let resolvePoll: () => void = () => undefined
    const surface = createGitHubConnectSurface({
      secrets: s.store,
      auth,
      client_id: CLIENT_ID,
      connect: async ({ present }) => {
        await present(GRANT)
        // Still polling — resolves only when the test lets it.
        await new Promise<void>((r) => {
          resolvePoll = r
        })
        return { connected: true }
      },
    })

    const body = (await (await surface.handler(req('POST')))!.json()) as Record<string, unknown>
    // Answered while the flow is unfinished. If the handler awaited completion this
    // would hang until the timeout rather than returning.
    expect(body['status']).toBe('awaiting_owner')
    expect(body['user_code']).toBe('ABCD-1234')
    expect(body['verification_uri']).toBe('https://github.com/login/device')
    resolvePoll()
  })

  test('a SECOND start returns the same code, not a rival flow', async () => {
    const s = fakeSecrets(null)
    let starts = 0
    const surface = createGitHubConnectSurface({
      secrets: s.store,
      auth,
      client_id: CLIENT_ID,
      connect: async ({ present }) => {
        starts += 1
        await present(GRANT)
        await new Promise<void>(() => undefined)
        return { connected: true }
      },
    })
    const a = (await (await surface.handler(req('POST')))!.json()) as Record<string, unknown>
    const b = (await (await surface.handler(req('POST')))!.json()) as Record<string, unknown>
    expect(a['user_code']).toBe(b['user_code'])
    // The decisive part: GitHub was asked once.
    expect(starts).toBe(1)
  })

  test('the stored token becomes readable once the flow completes', async () => {
    const s = fakeSecrets(null)
    const surface = createGitHubConnectSurface({
      secrets: s.store,
      auth,
      client_id: CLIENT_ID,
      connect: async ({ present, store, owner_handle }) => {
        await present(GRANT)
        await (store as unknown as { put(r: { plaintext: string }): Promise<void> }).put({
          plaintext: TOKEN,
        })
        void owner_handle
        return { connected: true }
      },
    })
    await surface.handler(req('POST'))
    // Let the background completion settle.
    await new Promise((r) => setTimeout(r, 20))
    expect(s.read()).toBe(TOKEN)
    expect(await (await surface.handler(req('GET')))!.json()).toMatchObject({ status: 'connected' })
  })

  test('an already-connected account does not mint a new code', async () => {
    const s = fakeSecrets(TOKEN)
    let starts = 0
    const surface = createGitHubConnectSurface({
      secrets: s.store,
      auth,
      client_id: CLIENT_ID,
      connect: async () => {
        starts += 1
        return { connected: true }
      },
    })
    expect(await (await surface.handler(req('POST')))!.json()).toMatchObject({ status: 'connected' })
    // Inviting the owner to authorise twice is a bug, not a no-op.
    expect(starts).toBe(0)
  })

  test('a failed start is a NAMED error, and stores nothing', async () => {
    const s = fakeSecrets(null)
    const surface = createGitHubConnectSurface({
      secrets: s.store,
      auth,
      client_id: CLIENT_ID,
      // `present` never runs — this is the first-call-to-GitHub failure.
      connect: async () => ({ connected: false, reason: 'protocol_error' }),
    })
    const res = await surface.handler(req('POST'))
    expect(res!.status).toBe(502)
    const body = (await res!.json()) as Record<string, unknown>
    expect(JSON.stringify(body)).toContain('protocol_error')
    expect(s.read()).toBeNull()
  })

  test('a missing client id is a named 503, not a generic failure', async () => {
    const s = fakeSecrets(null)
    const surface = createGitHubConnectSurface({ secrets: s.store, auth, client_id: null })
    const res = await surface.handler(req('POST'))
    expect(res!.status).toBe(503)
    expect(JSON.stringify(await res!.json())).toContain('github_client_id_unset')
  })
})

describe('nothing bearer-shaped ever leaves the surface', () => {
  test('neither the device_code nor the token appears in any response', async () => {
    const s = fakeSecrets(null)
    const surface = createGitHubConnectSurface({
      secrets: s.store,
      auth,
      client_id: CLIENT_ID,
      connect: async ({ present, store }) => {
        // A presenter is handed a type that structurally omits `device_code`; this
        // asserts the RESPONSE too, in case a future edit widens what is echoed.
        await present(GRANT)
        await (store as unknown as { put(r: { plaintext: string }): Promise<void> }).put({
          plaintext: TOKEN,
        })
        return { connected: true }
      },
    })
    const post = await (await surface.handler(req('POST')))!.text()
    await new Promise((r) => setTimeout(r, 20))
    const get = await (await surface.handler(req('GET')))!.text()
    for (const body of [post, get]) {
      expect(body).not.toContain(DEVICE_CODE)
      expect(body).not.toContain(TOKEN)
    }
  })

  test('the issued-code log line carries the short code only', async () => {
    const s = fakeSecrets(null)
    const lines: Array<{ event: string; detail: Record<string, unknown> }> = []
    const surface = createGitHubConnectSurface({
      secrets: s.store,
      auth,
      client_id: CLIENT_ID,
      log: (event, detail) => lines.push({ event, detail }),
      connect: async ({ present }) => {
        await present(GRANT)
        await new Promise<void>(() => undefined)
        return { connected: true }
      },
    })
    await surface.handler(req('POST'))
    const issued = lines.find((l) => l.event === 'github_device_code_issued')
    expect(issued).toBeDefined()
    // A journal line is a durable artifact.
    expect(JSON.stringify(issued)).not.toContain(DEVICE_CODE)
    expect(JSON.stringify(issued)).toContain('ABCD-1234')
  })
})
