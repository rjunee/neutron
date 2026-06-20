/**
 * M2.3 — round-trip test for the outbound cross-instance token minter.
 *
 * The load-bearing guarantee: a token minted by `mintInstanceToken`
 * PASSES the real inbound verifier (`authorizeConnectRequest`). If the
 * audience format, claim shape, or signing algorithm drifts between the two
 * sides, this test fails — not a production fan-out at 2am.
 */

import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, type KeyLike } from 'jose'
import {
  mintInstanceToken,
  CROSS_INSTANCE_TOKEN_TTL_SECONDS,
} from '../api/mint-instance-token.ts'
import { authorizeConnectRequest } from '../api/jwt-bearer-middleware.ts'
import { JwksCache, type FetchLike, type Membership } from '../../jwt-validator/index.ts'

async function fixtureKey(kid: string): Promise<{
  kid: string
  privateKey: KeyLike
  jwks: JwksCache
}> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  const pubJwk = await exportJWK(publicKey)
  const jwksBody = { keys: [{ kid, alg: 'EdDSA', use: 'sig', ...pubJwk }] }
  const fetchLike: FetchLike = async () =>
    new Response(JSON.stringify(jwksBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  return {
    kid,
    privateKey,
    jwks: new JwksCache('https://auth.example/.well-known/jwks.json', { fetch: fetchLike }),
  }
}

const MEMBERSHIPS: Membership[] = [
  { slug: 'alice', role: 'owner', kind: 'user' },
  { slug: 'acme', role: 'member', kind: 'workspace' },
]

describe('mintInstanceToken', () => {
  test('mints a token that the inbound middleware accepts for the target workspace', async () => {
    const key = await fixtureKey('k1')
    const minted = await mintInstanceToken({
      getActiveKey: async () => ({ kid: key.kid, privateKey: key.privateKey }),
      userId: 'u-alice',
      memberships: MEMBERSHIPS,
      targetInstanceSlug: 'acme',
      now: Date.now(),
    })
    expect(minted.audience).toBe('connect.acme')

    const req = new Request('http://acme/connect/v1/projects', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${minted.token}`,
        // The user declares they're speaking as their own user instance.
        'x-origin-instance': 'alice',
      },
    })
    const auth = await authorizeConnectRequest(req, {
      jwks: key.jwks,
      receiving_instance_slug: 'acme',
    })
    expect(auth.ok).toBe(true)
    if (auth.ok) {
      expect(auth.context.origin_instance_slug).toBe('alice')
      expect(auth.context.origin_user_id).toBe('u-alice')
    }
  })

  test('a token minted for one workspace is rejected by a different receiving instance', async () => {
    const key = await fixtureKey('k1')
    const minted = await mintInstanceToken({
      getActiveKey: async () => ({ kid: key.kid, privateKey: key.privateKey }),
      userId: 'u-alice',
      memberships: MEMBERSHIPS,
      targetInstanceSlug: 'acme',
      now: Date.now(),
    })
    // Replay against a DIFFERENT instance — audience mismatch must 401.
    const req = new Request('http://other/connect/v1/projects', {
      method: 'GET',
      headers: { authorization: `Bearer ${minted.token}`, 'x-origin-instance': 'alice' },
    })
    const auth = await authorizeConnectRequest(req, {
      jwks: key.jwks,
      receiving_instance_slug: 'other',
    })
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.status).toBe(401)
  })

  test('declaring an origin the user is not a member of is rejected (403)', async () => {
    const key = await fixtureKey('k1')
    const minted = await mintInstanceToken({
      getActiveKey: async () => ({ kid: key.kid, privateKey: key.privateKey }),
      userId: 'u-alice',
      memberships: MEMBERSHIPS,
      targetInstanceSlug: 'acme',
      now: Date.now(),
    })
    const req = new Request('http://acme/connect/v1/projects', {
      method: 'GET',
      headers: { authorization: `Bearer ${minted.token}`, 'x-origin-instance': 'not-a-member' },
    })
    const auth = await authorizeConnectRequest(req, {
      jwks: key.jwks,
      receiving_instance_slug: 'acme',
    })
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.status).toBe(403)
  })

  test('defaults to a short TTL', async () => {
    const key = await fixtureKey('k1')
    const now = 1_700_000_000_000
    const minted = await mintInstanceToken({
      getActiveKey: async () => ({ kid: key.kid, privateKey: key.privateKey }),
      userId: 'u-alice',
      memberships: MEMBERSHIPS,
      targetInstanceSlug: 'acme',
      now,
    })
    // Decode the exp claim without verifying (we already verified above).
    const [, payloadB64] = minted.token.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8')) as {
      iat: number
      exp: number
    }
    expect(payload.exp - payload.iat).toBe(CROSS_INSTANCE_TOKEN_TTL_SECONDS)
  })
})
