import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose'
import {
  authorizeConnectRequest,
  type JwtBearerMiddlewareOptions,
} from '../api/jwt-bearer-middleware.ts'
import { JwksCache, type FetchLike } from '@neutronai/jwt-validator/index.ts'

interface KeyMaterial {
  kid: string
  privateKey: KeyLike
  jwks: { keys: Array<{ kid: string; alg: string; use: string; kty: string; crv: string; x: string }> }
}

async function mintKey(kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  const pubJwk = await exportJWK(publicKey)
  const jwks = {
    keys: [
      {
        kid,
        alg: 'EdDSA',
        use: 'sig',
        ...pubJwk,
      },
    ],
  }
  return { kid, privateKey, jwks: jwks as KeyMaterial['jwks'] }
}

async function mintToken(
  km: KeyMaterial,
  args: {
    sub: string
    aud: string | string[]
    memberships: Array<{ slug: string; role: 'owner' | 'admin' | 'member'; kind: 'user' | 'workspace' }>
    expSecondsFromNow?: number
  },
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000)
  return new SignJWT({ memberships: args.memberships })
    .setProtectedHeader({ alg: 'EdDSA', kid: km.kid })
    .setSubject(args.sub)
    .setAudience(args.aud)
    .setIssuedAt(now)
    .setExpirationTime(now + (args.expSecondsFromNow ?? 3_600))
    .sign(km.privateKey)
}

function makeJwksCache(km: KeyMaterial): JwksCache {
  const fakeFetch: FetchLike = async () =>
    new Response(JSON.stringify(km.jwks), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  return new JwksCache('https://auth.example/.well-known/jwks.json', { fetch: fakeFetch })
}

describe('authorizeConnectRequest', () => {
  test('happy path: valid Bearer with connect.<slug> aud + matching membership', async () => {
    const km = await mintKey('k1')
    const token = await mintToken(km, {
      sub: 'user-1',
      aud: 'connect.alice',
      memberships: [{ slug: 'workspace-1', role: 'owner', kind: 'workspace' }],
    })
    const req = new Request('http://t/connect/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-origin-instance': 'workspace-1',
        'content-type': 'application/json',
      },
    })
    const opts: JwtBearerMiddlewareOptions = {
      jwks: makeJwksCache(km),
      receiving_instance_slug: 'alice',
    }
    const r = await authorizeConnectRequest(req, opts)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.context.origin_instance_slug).toBe('workspace-1')
      expect(r.context.origin_user_id).toBe('user-1')
      expect(r.context.scopes).toEqual(['role:owner'])
    }
  })

  test('missing Authorization → 401 missing_bearer', async () => {
    const km = await mintKey('k1')
    const req = new Request('http://t/connect/v1/messages')
    const r = await authorizeConnectRequest(req, {
      jwks: makeJwksCache(km),
      receiving_instance_slug: 'alice',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(401)
      expect(r.reason).toBe('missing_bearer')
    }
  })

  test('malformed Bearer → 401', async () => {
    const km = await mintKey('k1')
    const req = new Request('http://t/m', { headers: { authorization: 'Token abc' } })
    const r = await authorizeConnectRequest(req, {
      jwks: makeJwksCache(km),
      receiving_instance_slug: 'alice',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed_bearer')
  })

  test('wrong audience (neutron generic, not connect.<slug>) → 401 jwt_invalid', async () => {
    const km = await mintKey('k1')
    const token = await mintToken(km, {
      sub: 'user-1',
      aud: 'neutron',
      memberships: [{ slug: 'workspace-1', role: 'owner', kind: 'workspace' }],
    })
    const req = new Request('http://t/m', { headers: { authorization: `Bearer ${token}` } })
    const r = await authorizeConnectRequest(req, {
      jwks: makeJwksCache(km),
      receiving_instance_slug: 'alice',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(401)
      expect(r.reason).toContain('jwt_invalid')
    }
  })

  test('aud for a DIFFERENT receiving instance → 401', async () => {
    const km = await mintKey('k1')
    const token = await mintToken(km, {
      sub: 'user-1',
      aud: 'connect.bob', // bob, not alice
      memberships: [{ slug: 'workspace-1', role: 'member', kind: 'workspace' }],
    })
    const req = new Request('http://t/m', {
      headers: {
        authorization: `Bearer ${token}`,
        'x-origin-instance': 'workspace-1',
      },
    })
    const r = await authorizeConnectRequest(req, {
      jwks: makeJwksCache(km),
      receiving_instance_slug: 'alice', // alice receives, not bob
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('jwt_invalid')
  })

  test('claimed origin not in memberships → 403 origin_not_a_member', async () => {
    const km = await mintKey('k1')
    const token = await mintToken(km, {
      sub: 'user-1',
      aud: 'connect.alice',
      memberships: [{ slug: 'workspace-1', role: 'member', kind: 'workspace' }],
    })
    const req = new Request('http://t/m', {
      headers: {
        authorization: `Bearer ${token}`,
        'x-origin-instance': 'workspace-evil', // not in memberships
      },
    })
    const r = await authorizeConnectRequest(req, {
      jwks: makeJwksCache(km),
      receiving_instance_slug: 'alice',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(403)
      expect(r.reason).toBe('origin_not_a_member')
    }
  })

  test('multi-membership without X-Origin-Instance → 403 ambiguous_origin', async () => {
    const km = await mintKey('k1')
    const token = await mintToken(km, {
      sub: 'user-1',
      aud: 'connect.alice',
      memberships: [
        { slug: 'workspace-1', role: 'member', kind: 'workspace' },
        { slug: 'workspace-2', role: 'member', kind: 'workspace' },
      ],
    })
    const req = new Request('http://t/m', { headers: { authorization: `Bearer ${token}` } })
    const r = await authorizeConnectRequest(req, {
      jwks: makeJwksCache(km),
      receiving_instance_slug: 'alice',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('ambiguous_origin')
  })

  test('single-membership auto-resolves origin without header', async () => {
    const km = await mintKey('k1')
    const token = await mintToken(km, {
      sub: 'user-1',
      aud: 'connect.alice',
      memberships: [{ slug: 'workspace-1', role: 'admin', kind: 'workspace' }],
    })
    const req = new Request('http://t/m', { headers: { authorization: `Bearer ${token}` } })
    const r = await authorizeConnectRequest(req, {
      jwks: makeJwksCache(km),
      receiving_instance_slug: 'alice',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.context.origin_instance_slug).toBe('workspace-1')
  })
})
