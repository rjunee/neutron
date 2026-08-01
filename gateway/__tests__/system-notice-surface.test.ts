/**
 * HTTP surface test for `POST /api/app/system-notice`.
 *
 * Two things carry weight here.
 *
 * AUTH, in the PRODUCTION mode. This route writes a durable message into the
 * owner's transcript that renders as the system speaking, so the auth check is
 * not paperwork — without it the route is a message-injection hole. The tests
 * therefore run the resolver in `jwks` mode against a real RS256 key pair (the
 * `jwks_key_resolver` seam, so the fetch/cache behaviour of jose's
 * `createRemoteJWKSet` is not what is under test) and walk the whole rejection
 * set: no bearer, a token minted for a DIFFERENT instance, an account-scoped
 * token with no `slug` claim at all, an expired one, and one signed by a key
 * outside the published JWKS. Each must 401 AND must leave `deliver` untouched —
 * asserting the status alone would still pass if the message had already been
 * posted. MUTATION-TESTED: deleting the `resolveBearer` 401 branch in
 * `gateway/http/system-notice-surface.ts` turns five of these red.
 *
 * DURABILITY. The envelope must be `'inert'`, never `'none'`. A rotation, an
 * incident, an operator note — the whole reason something outside the process is
 * speaking is that the owner is not watching, so a live-only pill would be gone
 * by the time he looked. `'inert'` is what puts it in the transcript he opens
 * later. That is pinned as an explicit assertion rather than left to the shape
 * of a snapshot.
 */

import { describe, expect, it } from 'bun:test'
import { SignJWT } from 'jose'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { DeliveryEnvelope, DeliveryResult } from '../http/deliver.ts'

import { createSystemNoticeSurface } from '../http/system-notice-surface.ts'

const URL_SYSTEM_NOTICE = 'https://box.example.com/api/app/system-notice'
const THIS_INSTANCE = 'this-instance'
const OWNER_TOPIC = 'app:owner-1'

const NOW_MS = 1_800_000_000_000
const NOW_SEC = Math.floor(NOW_MS / 1_000)

interface Harness {
  handler: (req: Request) => Promise<Response | null>
  /** Every `deliver` call the surface made, in order. */
  calls: Array<{ topic_id: string; envelope: DeliveryEnvelope }>
  /** Mint an RS256 bearer against the published test JWKS. */
  mint: (claims: Record<string, unknown>, expSec?: number) => Promise<string>
  /** Mint against a key that is NOT in the published JWKS. */
  mintForeign: (claims: Record<string, unknown>) => Promise<string>
}

/**
 * Build the surface over a recording `deliver` and a real `jwks`-mode resolver.
 * `deliverImpl` overrides the seam's behaviour for the failure-path tests.
 */
async function harness(
  deliverImpl?: (topic_id: string, envelope: DeliveryEnvelope) => Promise<DeliveryResult>,
): Promise<Harness> {
  const { generateKeyPair, createLocalJWKSet, exportJWK } = await import('jose')
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey)
  jwk.kid = 'test-kid'
  jwk.alg = 'RS256'
  const foreign = await generateKeyPair('RS256')

  const auth: AppWsAuthResolver = createAppWsAuthResolver({
    project_slug: THIS_INSTANCE,
    // TRUE on purpose — a hosted box binds loopback, so `bypass` is derived-true
    // there. `jwks_url` must still win, which is what makes this the production
    // path rather than the dev lane.
    bypass: true,
    jwks_url: 'https://identity.example.com/.well-known/jwks.json',
    jwks_key_resolver: createLocalJWKSet({ keys: [jwk] }),
    now: () => NOW_MS,
  })

  const calls: Harness['calls'] = []
  const surface = createSystemNoticeSurface({
    auth,
    owner_topic_id: OWNER_TOPIC,
    deliver: async (topic_id, envelope) => {
      calls.push({ topic_id, envelope })
      if (deliverImpl !== undefined) return deliverImpl(topic_id, envelope)
      return { prompt_id: 'row-1', persisted: true, delivered_live: true }
    },
  })

  const unsigned = (claims: Record<string, unknown>, expSec: number): SignJWT =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuedAt(NOW_SEC)
      .setExpirationTime(expSec)

  return {
    handler: surface.handler,
    calls,
    mint: (claims, expSec = NOW_SEC + 600) => unsigned(claims, expSec).sign(privateKey),
    mintForeign: (claims) => unsigned(claims, NOW_SEC + 600).sign(foreign.privateKey),
  }
}

function post(token: string | null, body: unknown): Request {
  return new Request(URL_SYSTEM_NOTICE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/app/system-notice — auth', () => {
  it('accepts a bearer minted FOR THIS INSTANCE and posts the notice', async () => {
    const h = await harness()
    const token = await h.mint({ sub: 'acct-7', slug: THIS_INSTANCE })
    const res = await h.handler(post(token, { body: 'switched to a different subscription' }))
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({
      ok: true,
      prompt_id: 'row-1',
      delivered_live: true,
    })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.topic_id).toBe(OWNER_TOPIC)
    expect(h.calls[0]?.envelope.body).toBe('switched to a different subscription')
  })

  it('REJECTS a request with no bearer at all — and posts nothing', async () => {
    const h = await harness()
    const res = await h.handler(post(null, { body: 'unauthenticated' }))
    expect(res?.status).toBe(401)
    expect(((await res?.json()) as { code?: string } | undefined)?.code).toBe('missing_bearer')
    // The load-bearing half: a 401 that had ALREADY delivered would still be a
    // hole. Nothing may reach the seam.
    expect(h.calls).toHaveLength(0)
  })

  it('REJECTS a bearer minted for a DIFFERENT instance — and posts nothing', async () => {
    const h = await harness()
    const token = await h.mint({ sub: 'acct-7', slug: 'someone-elses-box' })
    const res = await h.handler(post(token, { body: 'cross-instance injection' }))
    expect(res?.status).toBe(401)
    expect(((await res?.json()) as { code?: string } | undefined)?.code).toBe('project_mismatch')
    expect(h.calls).toHaveLength(0)
  })

  it('REJECTS an account-scoped bearer with no slug claim — and posts nothing', async () => {
    const h = await harness()
    const token = await h.mint({ sub: 'acct-7' })
    const res = await h.handler(post(token, { body: 'account-scoped' }))
    expect(res?.status).toBe(401)
    expect(((await res?.json()) as { code?: string } | undefined)?.code).toBe('project_mismatch')
    expect(h.calls).toHaveLength(0)
  })

  it('REJECTS an expired bearer — and posts nothing', async () => {
    const h = await harness()
    const token = await h.mint({ sub: 'acct-7', slug: THIS_INSTANCE }, NOW_SEC - 1)
    const res = await h.handler(post(token, { body: 'stale credential' }))
    expect(res?.status).toBe(401)
    expect(((await res?.json()) as { code?: string } | undefined)?.code).toBe('expired_token')
    expect(h.calls).toHaveLength(0)
  })

  it('REJECTS a bearer signed outside the published JWKS — and posts nothing', async () => {
    const h = await harness()
    const token = await h.mintForeign({ sub: 'acct-7', slug: THIS_INSTANCE })
    const res = await h.handler(post(token, { body: 'forged' }))
    expect(res?.status).toBe(401)
    expect(((await res?.json()) as { code?: string } | undefined)?.code).toBe('invalid_signature')
    expect(h.calls).toHaveLength(0)
  })

  it('checks auth BEFORE parsing the body — a malformed body from a stranger is still a 401', async () => {
    const h = await harness()
    const res = await h.handler(
      new Request(URL_SYSTEM_NOTICE, { method: 'POST', body: 'not json' }),
    )
    expect(res?.status).toBe(401)
    expect(h.calls).toHaveLength(0)
  })
})

describe('POST /api/app/system-notice — delivery', () => {
  it("uses durability 'inert' so the notice survives until the owner next opens the app", async () => {
    const h = await harness()
    const token = await h.mint({ sub: 'acct-7', slug: THIS_INSTANCE })
    await h.handler(post(token, { body: 'something happened while you were away' }))
    // NOT 'none': a live-only pill is gone by the time an absent owner looks,
    // which is the one moment this message exists for.
    expect(h.calls[0]?.envelope.durability).toBe('inert')
  })

  it('delivers to the composition-fixed owner topic — the caller cannot choose one', async () => {
    const h = await harness()
    const token = await h.mint({ sub: 'acct-7', slug: THIS_INSTANCE })
    await h.handler(
      post(token, { body: 'note', topic_id: 'app:someone-else', durability: 'none' }),
    )
    expect(h.calls[0]?.topic_id).toBe(OWNER_TOPIC)
    expect(h.calls[0]?.envelope.durability).toBe('inert')
  })

  it('reports an undelivered-live notice as a success — the durable row is the guarantee', async () => {
    const h = await harness(async () => ({
      prompt_id: 'row-9',
      persisted: true,
      delivered_live: false,
    }))
    const token = await h.mint({ sub: 'acct-7', slug: THIS_INSTANCE })
    const res = await h.handler(post(token, { body: 'nobody is connected' }))
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({
      ok: true,
      prompt_id: 'row-9',
      delivered_live: false,
    })
  })

  it('surfaces a durable-persist failure as a 503, never a 200', async () => {
    const h = await harness(async () => {
      throw new Error('button store is down')
    })
    const token = await h.mint({ sub: 'acct-7', slug: THIS_INSTANCE })
    const res = await h.handler(post(token, { body: 'will not persist' }))
    expect(res?.status).toBe(503)
    expect(((await res?.json()) as { code?: string } | undefined)?.code).toBe('delivery_failed')
  })
})

describe('POST /api/app/system-notice — validation and routing', () => {
  it('rejects an empty / whitespace-only body', async () => {
    const h = await harness()
    const token = await h.mint({ sub: 'acct-7', slug: THIS_INSTANCE })
    for (const body of [{}, { body: '' }, { body: '   ' }, { body: 42 }]) {
      const res = await h.handler(post(token, body))
      expect(res?.status).toBe(400)
    }
    expect(h.calls).toHaveLength(0)
  })

  it('rejects a body over the chat transport cap', async () => {
    const h = await harness()
    const token = await h.mint({ sub: 'acct-7', slug: THIS_INSTANCE })
    const res = await h.handler(post(token, { body: 'x'.repeat(16_385) }))
    expect(res?.status).toBe(413)
    expect(h.calls).toHaveLength(0)
  })

  it('rejects a non-POST', async () => {
    const h = await harness()
    const res = await h.handler(new Request(URL_SYSTEM_NOTICE))
    expect(res?.status).toBe(405)
  })

  it('falls through for any other path so sibling surfaces still see the request', async () => {
    const h = await harness()
    expect(await h.handler(new Request('https://box.example.com/api/app/usage'))).toBeNull()
  })
})
