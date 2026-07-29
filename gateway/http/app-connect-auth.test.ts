import { describe, expect, test } from 'bun:test'
import {
  createAppConnectAuthSurface,
  type FederatedTokenStoreLike,
} from './app-connect-auth.ts'
import {
  FederatedConnectError,
  type FederatedStatus,
} from '../connect/federated-token-store.ts'

function surface(over: Partial<FederatedTokenStoreLike> = {}): {
  handler: (req: Request) => Promise<Response | null>
  redeemed: string[]
} {
  const redeemed: string[] = []
  const store: FederatedTokenStoreLike = {
    connectViaRedeem: async (code): Promise<FederatedStatus> => {
      redeemed.push(code)
      return { connected: true, user_instance_slug: 'alice' }
    },
    status: async (): Promise<FederatedStatus> => ({ connected: false }),
    disconnect: async (): Promise<void> => {},
    ...over,
  }
  return {
    redeemed,
    handler: createAppConnectAuthSurface({
      store,
      auth_base_url: 'https://auth.neutron.example',
      // These existing behavioural tests exercise the AUTHENTICATED path, so
      // the resolver always returns a valid claim bound to this surface's
      // instance. The unauthenticated 401 gate is covered in
      // `app-connect-auth-session-gate.test.ts`.
      resolveUserClaim: async () => ({ project_slug: 'alice', user_id: 'u1' }),
      project_slug: 'alice',
    }).handler,
  }
}

describe('app-connect-auth surface', () => {
  test('POST /start returns an auth_url with the callback as return_url', async () => {
    const { handler } = surface()
    const res = await handler(
      new Request('https://alice.local/api/app/connect/auth/start', { method: 'POST' }),
    )
    expect(res).not.toBeNull()
    const body = (await res!.json()) as { auth_url: string }
    const u = new URL(body.auth_url)
    expect(u.origin).toBe('https://auth.neutron.example')
    expect(u.pathname).toBe('/oauth/connect/google/start')
    expect(u.searchParams.get('return_url')).toBe(
      'https://alice.local/api/app/connect/auth/callback',
    )
  })

  test('POST /start?return_path=... bakes app_return into the callback return_url', async () => {
    const { handler } = surface()
    const res = await handler(
      new Request(
        'https://alice.local/api/app/connect/auth/start?return_path=' +
          encodeURIComponent('/invite?invite=XYZ'),
        { method: 'POST' },
      ),
    )
    const body = (await res!.json()) as { auth_url: string }
    const returnUrl = new URL(new URL(body.auth_url).searchParams.get('return_url')!)
    expect(returnUrl.pathname).toBe('/api/app/connect/auth/callback')
    expect(returnUrl.searchParams.get('app_return')).toBe('/invite?invite=XYZ')
  })

  test('POST /start rejects a non-relative return_path (open-redirect guard)', async () => {
    const { handler } = surface()
    const res = await handler(
      new Request(
        'https://alice.local/api/app/connect/auth/start?return_path=' +
          encodeURIComponent('//evil.com/x'),
        { method: 'POST' },
      ),
    )
    const body = (await res!.json()) as { auth_url: string }
    const returnUrl = new URL(new URL(body.auth_url).searchParams.get('return_url')!)
    expect(returnUrl.searchParams.get('app_return')).toBeNull()
  })

  test('GET /callback?app_return=... redirects back to the originating page', async () => {
    const { handler } = surface()
    const res = await handler(
      new Request(
        'https://alice.local/api/app/connect/auth/callback?connect_code=c1.s1&app_return=' +
          encodeURIComponent('/invite?invite=XYZ'),
        { method: 'GET' },
      ),
    )
    expect(res!.status).toBe(302)
    const loc = new URL(res!.headers.get('location')!)
    expect(loc.pathname).toBe('/invite')
    expect(loc.searchParams.get('invite')).toBe('XYZ')
    expect(loc.searchParams.get('connect')).toBe('connected')
  })

  test('POST /start?provider=apple selects apple', async () => {
    const { handler } = surface()
    const res = await handler(
      new Request('https://alice.local/api/app/connect/auth/start?provider=apple', {
        method: 'POST',
      }),
    )
    const body = (await res!.json()) as { auth_url: string }
    expect(new URL(body.auth_url).pathname).toBe('/oauth/connect/apple/start')
  })

  test('GET /callback redeems the code and 302s with connected', async () => {
    const { handler, redeemed } = surface()
    const res = await handler(
      new Request(
        'https://alice.local/api/app/connect/auth/callback?connect_code=c1.s1',
        { method: 'GET' },
      ),
    )
    expect(res!.status).toBe(302)
    expect(redeemed).toEqual(['c1.s1'])
    expect(res!.headers.get('location')).toContain('connect=connected')
  })

  test('GET /callback without a code 302s with error', async () => {
    const { handler } = surface()
    const res = await handler(
      new Request('https://alice.local/api/app/connect/auth/callback', { method: 'GET' }),
    )
    expect(res!.status).toBe(302)
    expect(res!.headers.get('location')).toContain('connect=error')
  })

  test('GET /callback 302s with error when redeem fails', async () => {
    const { handler } = surface({
      connectViaRedeem: async () => {
        throw new FederatedConnectError('redeem rejected: 400', 400)
      },
    })
    const res = await handler(
      new Request(
        'https://alice.local/api/app/connect/auth/callback?connect_code=bad',
        { method: 'GET' },
      ),
    )
    expect(res!.status).toBe(302)
    expect(res!.headers.get('location')).toContain('connect=error')
  })

  test('GET /status returns the store status', async () => {
    const { handler } = surface({
      status: async () => ({ connected: true, user_instance_slug: 'alice', refresh_expires_at_ms: 123 }),
    })
    const res = await handler(
      new Request('https://alice.local/api/app/connect/auth/status', { method: 'GET' }),
    )
    expect(await res!.json()).toEqual({
      connected: true,
      user_instance_slug: 'alice',
      refresh_expires_at_ms: 123,
    })
  })

  test('POST /disconnect drops the credential', async () => {
    let dropped = 0
    const { handler } = surface({
      disconnect: async () => {
        dropped++
      },
    })
    const res = await handler(
      new Request('https://alice.local/api/app/connect/auth/disconnect', { method: 'POST' }),
    )
    expect(await res!.json()).toEqual({ ok: true })
    expect(dropped).toBe(1)
  })

  test('returns null for non-matching paths', async () => {
    const { handler } = surface()
    const res = await handler(new Request('https://alice.local/api/app/projects', { method: 'GET' }))
    expect(res).toBeNull()
  })
})
