/**
 * LOGIN-FIRST e2e (2026-07-25) — an identity-service RS256 bearer must actually
 * DRIVE a composed Open instance.
 *
 * WHY THIS EXISTS. The mobile app's login-first flow signs the owner in at a
 * central identity service and is handed a bearer scoped to ONE instance slug.
 * Round 1 of this branch persisted that bearer as the session while NO Open
 * resolver could verify it: `appOwnerAuth` accepted only the per-install owner
 * bearer (which a phone cannot know) or a dev-bypass/HS256 token, so sign-in
 * SUCCEEDED and then every authenticated request 401'd — and the flow's own
 * adoption probe hits UNAUTHENTICATED `/healthz`, so nothing surfaced it. That
 * is the "done means WIRED + SERVED" bar, and this test is what holds it: it
 * drives the REAL composed graph's `/api/app/chat/send` with a real RS256 token
 * verified against a real HTTP JWKS endpoint.
 *
 * Mutation-verify: drop the composer's `NEUTRON_IDENTITY_JWKS_URL` threading (or
 * the `mode === 'jwks'` owner normalisation) → the ACCEPT case goes 401.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { exportJWK, generateKeyPair, SignJWT } from 'jose'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** This gateway's own slug — the value a token's `slug` claim must match. */
const INSTANCE_SLUG = 'owner'

let home: IsolatedHome

function recordingSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock',
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>

/** The Bearer path a remote (phone) client uses — no Origin, no cookie. */
function httpSend(token: string): Request {
  return new Request('http://127.0.0.1:7800/api/app/chat/send', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:7800',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ body: 'hi' }),
  })
}

interface Built {
  close: () => Promise<void>
  fetch: (req: Request, srv: import('bun').Server<unknown>) => Response | Promise<Response>
}

async function buildGraph(): Promise<Built> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => recordingSubstrate()) as any,
  })
  let composition: Awaited<ReturnType<typeof composer>>
  try {
    composition = await composer({ db, project_slug: INSTANCE_SLUG })
  } catch (err) {
    db.close()
    throw err
  }
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined) throw new Error('graph has no fetch handler')
  return {
    fetch: graph.fetch,
    close: async () => {
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
      }
      await graph.shutdown()
      db.close()
    },
  }
}

/**
 * A REAL HTTP JWKS endpoint. The composer builds its key resolver from the URL
 * alone (jose's `createRemoteJWKSet` does the fetching), so serving the keys
 * over HTTP is what proves the env var is actually threaded and consumed —
 * injecting a key set here would prove nothing about the wiring.
 */
interface Identity {
  jwksUrl: string
  mint: (claims: Record<string, unknown>, ttlSec?: number) => Promise<string>
  stop: () => void
}

async function startIdentity(): Promise<Identity> {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey)
  jwk.kid = 'kid-e2e'
  jwk.alg = 'RS256'
  jwk.use = 'sig'
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === '/.well-known/jwks.json'
        ? Response.json({ keys: [jwk] })
        : new Response('not found', { status: 404 }),
  })
  return {
    jwksUrl: `http://127.0.0.1:${server.port}/.well-known/jwks.json`,
    mint: async (claims, ttlSec = 600) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'kid-e2e' })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1_000) + ttlSec)
        .sign(privateKey),
    stop: () => server.stop(true),
  }
}

let identity: Identity

beforeEach(async () => {
  identity = await startIdentity()
  home = createIsolatedHome({
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      'NEUTRON_HOST',
      'NEUTRON_IDENTITY_JWKS_URL',
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-identity-jwks-test',
      // Loopback bind on purpose: a hosted instance sits behind a reverse proxy
      // on 127.0.0.1, which is exactly the case where `bypass` would otherwise
      // shadow the JWKS mode and reject the phone's bearer as malformed.
      NEUTRON_HOST: '127.0.0.1',
      NEUTRON_IDENTITY_JWKS_URL: identity.jwksUrl,
    },
  })
})

afterEach(() => {
  home.restore()
  identity.stop()
})

describe('login-first e2e — an identity-service RS256 bearer drives a composed Open instance', () => {
  test('an instance-scoped token is ACCEPTED as the owner on /api/app/chat/send', async () => {
    const built = await buildGraph()
    try {
      const token = await identity.mint({ sub: 'acct-e2e-9', slug: INSTANCE_SLUG })
      const res = await built.fetch(httpSend(token), fakeServer)
      // Exact 200 + `{ok:true}` — "not 401" would also pass on a 403/404/500.
      expect(res.status).toBe(200)
      expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true })
    } finally {
      await built.close()
    }
  })

  test('an ACCOUNT-scoped token (no slug claim) is REJECTED', async () => {
    // Every signed-in account holds one of these — it must not drive an install.
    const built = await buildGraph()
    try {
      const token = await identity.mint({ sub: 'acct-e2e-9' })
      const res = await built.fetch(httpSend(token), fakeServer)
      expect(res.status).toBe(401)
    } finally {
      await built.close()
    }
  })

  test("a token scoped to a DIFFERENT instance's slug is REJECTED", async () => {
    const built = await buildGraph()
    try {
      const token = await identity.mint({ sub: 'acct-e2e-9', slug: 'somebody-elses-box' })
      const res = await built.fetch(httpSend(token), fakeServer)
      expect(res.status).toBe(401)
    } finally {
      await built.close()
    }
  })

  test('an EXPIRED instance-scoped token is REJECTED', async () => {
    const built = await buildGraph()
    try {
      const token = await identity.mint({ sub: 'acct-e2e-9', slug: INSTANCE_SLUG }, -60)
      const res = await built.fetch(httpSend(token), fakeServer)
      expect(res.status).toBe(401)
    } finally {
      await built.close()
    }
  })

  test('a malformed NEUTRON_IDENTITY_JWKS_URL fails composition LOUDLY, never silently off', async () => {
    // A typo must not degrade to "identity quietly disabled", which would
    // reproduce the sign-in-then-401 confusion this whole path removes.
    process.env['NEUTRON_IDENTITY_JWKS_URL'] = 'not-a-url'
    await expect(buildGraph()).rejects.toThrow(/NEUTRON_IDENTITY_JWKS_URL/)
  })
})
