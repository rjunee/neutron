import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose'
import {
  CONNECT_API_PREFIX,
  createConnectApiHandler,
  type ConnectApiHandlers,
} from '../api/server.ts'
import { stampOriginInstance } from '../api/origin-tag.ts'
import { JwksCache, type FetchLike } from '@neutronai/jwt-validator/index.ts'

interface KeyMaterial {
  kid: string
  privateKey: KeyLike
  jwks: { keys: Array<{ kid: string; alg: string; use: string; kty: string; crv: string; x: string }> }
}

async function mintKey(kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  const pubJwk = await exportJWK(publicKey)
  return {
    kid,
    privateKey,
    jwks: {
      keys: [{ kid, alg: 'EdDSA', use: 'sig', ...pubJwk } as KeyMaterial['jwks']['keys'][0]],
    },
  }
}

async function mintToken(
  km: KeyMaterial,
  args: {
    sub: string
    aud: string
    memberships: Array<{ slug: string; role: 'owner' | 'admin' | 'member'; kind: 'user' | 'workspace' }>
  },
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000)
  return new SignJWT({ memberships: args.memberships })
    .setProtectedHeader({ alg: 'EdDSA', kid: km.kid })
    .setSubject(args.sub)
    .setAudience(args.aud)
    .setIssuedAt(now)
    .setExpirationTime(now + 3_600)
    .sign(km.privateKey)
}

function makeJwks(km: KeyMaterial): JwksCache {
  const fakeFetch: FetchLike = async () =>
    new Response(JSON.stringify(km.jwks), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  return new JwksCache('https://auth.example/.well-known/jwks.json', { fetch: fakeFetch })
}

describe('connect API server', () => {
  test('GET /health returns 200 + receiving_instance_slug (unauthed)', async () => {
    const km = await mintKey('k1')
    const handler = createConnectApiHandler({
      receiving_instance_slug: 'alice',
      auth: { jwks: makeJwks(km), receiving_instance_slug: 'alice' },
      handlers: stubHandlers(),
    })
    const r = await handler(
      new Request('http://t/connect/v1/health', { method: 'GET' }),
    )
    expect(r).not.toBeNull()
    expect(r!.status).toBe(200)
    const body = (await r!.json()) as { status: string; receiving_instance_slug: string }
    expect(body.status).toBe('ok')
    expect(body.receiving_instance_slug).toBe('alice')
  })

  test('returns null for paths outside CONNECT_API_PREFIX', async () => {
    const km = await mintKey('k1')
    const handler = createConnectApiHandler({
      receiving_instance_slug: 'alice',
      auth: { jwks: makeJwks(km), receiving_instance_slug: 'alice' },
      handlers: stubHandlers(),
    })
    const r = await handler(new Request('http://t/healthz'))
    expect(r).toBeNull()
  })

  test('POST /messages happy path: 202 + ack_id + handler invoked', async () => {
    const km = await mintKey('k1')
    const seen: Array<{ origin: string; topic: string }> = []
    const handlers: ConnectApiHandlers = {
      on_inbound_message: async (ctx, msg) => {
        seen.push({
          origin: ctx.origin_instance_slug,
          topic: msg.payload.topic_id,
        })
        return { ack_id: 'msg-1' }
      },
      list_projects: async () => [],
    }
    const handler = createConnectApiHandler({
      receiving_instance_slug: 'alice',
      auth: { jwks: makeJwks(km), receiving_instance_slug: 'alice' },
      handlers,
    })
    const token = await mintToken(km, {
      sub: 'u-1',
      aud: 'connect.alice',
      memberships: [{ slug: 'workspace-1', role: 'owner', kind: 'workspace' }],
    })
    const body = stampOriginInstance(
      { topic_id: 't-1', speaker_user_id: 'u-1', body: { msg: 'hi' } },
      'workspace-1',
    )
    const r = await handler(
      new Request('http://t/connect/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-origin-instance': 'workspace-1',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    )
    expect(r!.status).toBe(202)
    expect(seen).toEqual([{ origin: 'workspace-1', topic: 't-1' }])
  })

  test('POST /messages without bearer → 401', async () => {
    const km = await mintKey('k1')
    const handler = createConnectApiHandler({
      receiving_instance_slug: 'alice',
      auth: { jwks: makeJwks(km), receiving_instance_slug: 'alice' },
      handlers: stubHandlers(),
    })
    const r = await handler(
      new Request('http://t/connect/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    )
    expect(r!.status).toBe(401)
  })

  test('POST /messages with unstamped body → 400 missing_origin_instance_stamp', async () => {
    const km = await mintKey('k1')
    const handler = createConnectApiHandler({
      receiving_instance_slug: 'alice',
      auth: { jwks: makeJwks(km), receiving_instance_slug: 'alice' },
      handlers: stubHandlers(),
    })
    const token = await mintToken(km, {
      sub: 'u-1',
      aud: 'connect.alice',
      memberships: [{ slug: 'workspace-1', role: 'owner', kind: 'workspace' }],
    })
    const r = await handler(
      new Request('http://t/connect/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-origin-instance': 'workspace-1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ topic_id: 't-1', speaker_user_id: 'u-1', body: {} }),
      }),
    )
    expect(r!.status).toBe(400)
    const body = (await r!.json()) as { error: string }
    expect(body.error).toBe('missing_origin_instance_stamp')
  })

  test('POST /messages with body stamp ≠ JWT origin → 403 origin_stamp_mismatch', async () => {
    const km = await mintKey('k1')
    const handler = createConnectApiHandler({
      receiving_instance_slug: 'alice',
      auth: { jwks: makeJwks(km), receiving_instance_slug: 'alice' },
      handlers: stubHandlers(),
    })
    const token = await mintToken(km, {
      sub: 'u-1',
      aud: 'connect.alice',
      memberships: [{ slug: 'workspace-1', role: 'member', kind: 'workspace' }],
    })
    const body = stampOriginInstance(
      { topic_id: 't-1', speaker_user_id: 'u-1', body: {} },
      'workspace-2', // ← stamp is different from JWT origin (workspace-1)
    )
    const r = await handler(
      new Request('http://t/connect/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-origin-instance': 'workspace-1',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    )
    expect(r!.status).toBe(403)
  })

  test('GET /projects returns handler output', async () => {
    const km = await mintKey('k1')
    const handlers: ConnectApiHandlers = {
      on_inbound_message: async () => ({ ack_id: 'x' }),
      list_projects: async () => [
        {
          project_id: 'p-1',
          display_name: 'P1',
          kind: 'solo',
          owning_instance_slug: 'alice',
        },
      ],
    }
    const handler = createConnectApiHandler({
      receiving_instance_slug: 'alice',
      auth: { jwks: makeJwks(km), receiving_instance_slug: 'alice' },
      handlers,
    })
    const token = await mintToken(km, {
      sub: 'u-1',
      aud: 'connect.alice',
      memberships: [{ slug: 'alice', role: 'owner', kind: 'user' }],
    })
    const r = await handler(
      new Request('http://t/connect/v1/projects', {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    expect(r!.status).toBe(200)
    const body = (await r!.json()) as { projects: Array<{ project_id: string }> }
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0]?.project_id).toBe('p-1')
  })

  test('unknown subpath under prefix → 404', async () => {
    const km = await mintKey('k1')
    const handler = createConnectApiHandler({
      receiving_instance_slug: 'alice',
      auth: { jwks: makeJwks(km), receiving_instance_slug: 'alice' },
      handlers: stubHandlers(),
    })
    const token = await mintToken(km, {
      sub: 'u-1',
      aud: 'connect.alice',
      memberships: [{ slug: 'alice', role: 'owner', kind: 'user' }],
    })
    const r = await handler(
      new Request('http://t/connect/v1/unknown', {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    expect(r!.status).toBe(404)
  })

  test('CONNECT_API_PREFIX is the locked /connect/v1', () => {
    expect(CONNECT_API_PREFIX).toBe('/connect/v1')
  })

  test('non-canonical prefix returns null so the handler can be chained', async () => {
    // The handler declines (returns null) any path outside CONNECT_API_PREFIX
    // so the caller can chain it with other surfaces (e.g. an OAuth callback
    // or a /healthz handler). A path under the canonical /connect/v1 prefix
    // would be served (200/404), so we assert the negative path against a
    // genuinely non-canonical prefix.
    const km = await mintKey('k1')
    const handler = createConnectApiHandler({
      receiving_instance_slug: 'alice',
      auth: { jwks: makeJwks(km), receiving_instance_slug: 'alice' },
      handlers: stubHandlers(),
    })
    const r = await handler(
      new Request('http://t/healthz', { method: 'GET' }),
    )
    expect(r).toBeNull()
  })

  test('POST /messages returns 501 not_implemented when handler not configured (Argus r1 B2)', async () => {
    // Argus r1 BLOCKER fix: an unconfigured `on_inbound_message` MUST
    // surface as 501 Not Implemented, NOT 500 from a `throw` stub. The
    // server gates handler lookup BEFORE body parsing so accidental
    // real traffic gets a documented status code.
    const km = await mintKey('k1')
    const handler = createConnectApiHandler({
      receiving_instance_slug: 'alice',
      auth: { jwks: makeJwks(km), receiving_instance_slug: 'alice' },
      handlers: {
        list_projects: async () => [],
        // on_inbound_message intentionally undefined
      },
    })
    const token = await mintToken(km, {
      sub: 'u-1',
      aud: 'connect.alice',
      memberships: [{ slug: 'workspace-1', role: 'owner', kind: 'workspace' }],
    })
    const r = await handler(
      new Request('http://t/connect/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-origin-instance': 'workspace-1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    )
    expect(r!.status).toBe(501)
    const body = (await r!.json()) as { error: string; surface: string }
    expect(body.error).toBe('not_implemented')
    expect(body.surface).toBe('connect.on_inbound_message')
  })

  test('GET /projects returns 501 not_implemented when handler not configured (Argus r1 B2)', async () => {
    const km = await mintKey('k1')
    const handler = createConnectApiHandler({
      receiving_instance_slug: 'alice',
      auth: { jwks: makeJwks(km), receiving_instance_slug: 'alice' },
      handlers: {
        on_inbound_message: async () => ({ ack_id: 'x' }),
        // list_projects intentionally undefined
      },
    })
    const token = await mintToken(km, {
      sub: 'u-1',
      aud: 'connect.alice',
      memberships: [{ slug: 'alice', role: 'owner', kind: 'user' }],
    })
    const r = await handler(
      new Request('http://t/connect/v1/projects', {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    expect(r!.status).toBe(501)
    const body = (await r!.json()) as { error: string; surface: string }
    expect(body.error).toBe('not_implemented')
    expect(body.surface).toBe('connect.list_projects')
  })

  test('POST /messages with both handlers configured returns 202 (configured route still works)', async () => {
    // Sanity: making handlers optional must not break the configured-
    // path. Mirrors the existing happy-path test but is a stand-alone
    // assertion against accidental regression on the dispatch wiring.
    const km = await mintKey('k1')
    const handler = createConnectApiHandler({
      receiving_instance_slug: 'alice',
      auth: { jwks: makeJwks(km), receiving_instance_slug: 'alice' },
      handlers: stubHandlers(),
    })
    const token = await mintToken(km, {
      sub: 'u-1',
      aud: 'connect.alice',
      memberships: [{ slug: 'workspace-1', role: 'owner', kind: 'workspace' }],
    })
    const body = stampOriginInstance(
      { topic_id: 't-1', speaker_user_id: 'u-1', body: { msg: 'hi' } },
      'workspace-1',
    )
    const r = await handler(
      new Request('http://t/connect/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-origin-instance': 'workspace-1',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    )
    expect(r!.status).toBe(202)
  })
})

function stubHandlers(): ConnectApiHandlers {
  return {
    on_inbound_message: async () => ({ ack_id: 'stub' }),
    list_projects: async () => [],
  }
}
