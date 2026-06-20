/**
 * M2.6 Ph3 — the public collaborator edge: server-resolved role, no
 * cross-member impersonation, and the fail-closed rate limiter. Drives the REAL
 * `createConnectApiHandler` with a collaborator populated via the real
 * `acceptGuestMember` (the self-hosted token handshake).
 *
 * Locks brief tests:
 *   #4a — role is SERVER-resolved: a collaborator bearer that CLAIMS role='owner'
 *         resolves to its stored collaborator row; the routed turn is attributed
 *         as the collaborator's local_slug, the claim is ignored.
 *   #4b — no cross-member impersonation: a guest cannot deliver a turn stamped as
 *         another member's slug (the body stamp must match the JWT origin → 403),
 *         and the routed turn is re-stamped with the RESOLVED slug regardless.
 *   #5  — the public edge is rate-limited (fail-closed) BEFORE resolve_member /
 *         the ingress run: a per-IP flood at /connect/guest-auth and a per-token
 *         flood at /messages are rejected (429) and the downstream is NOT called.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import {
  createConnectApiHandler,
  type ConnectApiHandlers,
} from '../api/server.ts'
import { createEdgeRateLimiter } from '../api/edge-rate-limiter.ts'
import { stampOriginInstance } from '../api/origin-tag.ts'
import { JwksCache, type FetchLike } from '../../jwt-validator/index.ts'
import { ConnectedMembersStore } from '../connected-members-store.ts'
import { ConnectGuestInviteStore } from '../guest-invite-store.ts'
import {
  acceptGuestMember,
  buildResolveMember,
} from '../member-join.ts'

const OWNER = 'owner-meeting'
const PROJECT_ID = 'p-owner-1'
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

interface KeyMat {
  kid: string
  privateKey: KeyLike
  jwks: { keys: unknown[] }
}
async function mintKey(): Promise<KeyMat> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  const pubJwk = await exportJWK(publicKey)
  return { kid: 'k1', privateKey, jwks: { keys: [{ kid: 'k1', alg: 'EdDSA', use: 'sig', ...pubJwk }] } }
}
function makeJwks(km: KeyMat): JwksCache {
  const fetch: FetchLike = async () =>
    new Response(JSON.stringify(km.jwks), { status: 200, headers: { 'content-type': 'application/json' } })
  return new JwksCache('https://auth.example/.well-known/jwks.json', { fetch })
}
/** Mint a bearer for a collaborator identity, optionally injecting an UNTRUSTED
 *  `role` claim the resolver must ignore. */
async function mintGuestToken(
  km: KeyMat,
  args: { sub: string; slug: string; claimRole?: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000)
  const payload: Record<string, unknown> = {
    memberships: [{ slug: args.slug, role: 'member', kind: 'user' }],
  }
  if (args.claimRole !== undefined) payload['role'] = args.claimRole
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: km.kid })
    .setSubject(args.sub)
    .setAudience(`connect.${OWNER}`)
    .setIssuedAt(now)
    .setExpirationTime(now + 3_600)
    .sign(km.privateKey)
}

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-guest-edge-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  db.raw().run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, 'Owner Project', 'workspace', 'personal', ?, ?)`,
    [PROJECT_ID, new Date(0).toISOString(), new Date(0).toISOString()],
  )
  return db
}

async function acceptGuest(db: ProjectDb, handle: string, displayName: string) {
  const store = new ConnectedMembersStore(db)
  const inviteStore = new ConnectGuestInviteStore(db)
  const invited = await inviteStore.issue({ project_id: PROJECT_ID, ttl_ms: 600_000, now: 1 })
  return acceptGuestMember(
    { invite_token: invited.token, display_name: displayName, guest_handle: handle },
    { store, inviteStore, db, now: () => 2 },
  )
}

describe('role is server-resolved, never self-asserted (brief test #4a)', () => {
  test('a collaborator bearer claiming role=owner routes attributed as the collaborator', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const km = await mintKey()
    const guest = await acceptGuest(db, 'mona.example', 'Mona')

    const captured: Array<{ ctxOrigin: string; bodyOrigin: string }> = []
    const resolveSpy = buildResolveMember({ store })
    const handlers: ConnectApiHandlers = {
      on_inbound_message: async (ctx, msg) => {
        captured.push({ ctxOrigin: ctx.origin_instance_slug, bodyOrigin: msg.origin_instance })
        return { ack_id: 'a' }
      },
      resolve_member: resolveSpy,
    }
    const handler = createConnectApiHandler({
      receiving_instance_slug: OWNER,
      auth: { jwks: makeJwks(km), receiving_instance_slug: OWNER },
      handlers,
    })

    const token = await mintGuestToken(km, {
      sub: guest.guest_user_id,
      slug: guest.origin_slug,
      claimRole: 'owner', // the lie — must be ignored
    })
    const body = stampOriginInstance(
      { topic_id: 't', speaker_user_id: 's', body: { text: 'hi' } },
      guest.origin_slug,
    )
    const res = await handler(
      new Request('http://t/connect/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    expect(res!.status).toBe(202)
    // Attributed as the collaborator's local_slug, NOT 'owner' / the home slug.
    expect(captured).toHaveLength(1)
    expect(captured[0]!.ctxOrigin).toBe(guest.member.local_slug)
    expect(captured[0]!.bodyOrigin).toBe(guest.member.local_slug)
    // The stored row's role is authoritative.
    const direct = await resolveSpy({
      origin_instance_slug: guest.origin_slug,
      origin_user_id: guest.guest_user_id,
      scopes: [],
      memberships: [],
    })
    expect(direct).toMatchObject({ ok: true, role: 'collaborator' })
  })
})

describe('no cross-member impersonation (brief test #4b)', () => {
  test('a guest cannot deliver a turn stamped as another member (body must match JWT origin)', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const km = await mintKey()
    const guestA = await acceptGuest(db, 'a.example', 'Alice')
    const guestB = await acceptGuest(db, 'b.example', 'Bob')

    const captured: Array<{ ctxOrigin: string }> = []
    const handler = createConnectApiHandler({
      receiving_instance_slug: OWNER,
      auth: { jwks: makeJwks(km), receiving_instance_slug: OWNER },
      handlers: {
        on_inbound_message: async (ctx) => {
          captured.push({ ctxOrigin: ctx.origin_instance_slug })
          return { ack_id: 'a' }
        },
        resolve_member: buildResolveMember({ store }),
      },
    })
    const tokenA = await mintGuestToken(km, { sub: guestA.guest_user_id, slug: guestA.origin_slug })

    // A stamps the body with B's local_slug → 403 (body must equal A's JWT origin).
    const forged = stampOriginInstance({ topic_id: 't', speaker_user_id: 's', body: {} }, guestB.member.local_slug)
    const denied = await handler(
      new Request('http://t/connect/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
        body: JSON.stringify(forged),
      }),
    )
    expect(denied!.status).toBe(403)
    expect(captured).toHaveLength(0) // never reached the ingress

    // A stamps correctly → routed, attributed as A's slug (never B's).
    const ok = stampOriginInstance({ topic_id: 't', speaker_user_id: 's', body: {} }, guestA.origin_slug)
    const res = await handler(
      new Request('http://t/connect/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
        body: JSON.stringify(ok),
      }),
    )
    expect(res!.status).toBe(202)
    expect(captured).toEqual([{ ctxOrigin: guestA.member.local_slug }])
    expect(guestA.member.local_slug).not.toBe(guestB.member.local_slug)
  })
})

describe('public edge is rate-limited, fail-closed, BEFORE routing (brief test #5)', () => {
  test('per-token flood at /messages is rejected before resolve_member / the ingress', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const km = await mintKey()
    const guest = await acceptGuest(db, 'mona.example', 'Mona')

    let resolveCalls = 0
    let ingressCalls = 0
    const handler = createConnectApiHandler({
      receiving_instance_slug: OWNER,
      auth: { jwks: makeJwks(km), receiving_instance_slug: OWNER },
      rate_limiter: createEdgeRateLimiter({ windowMs: 60_000, max: { 'guest-auth': 1, messages: 1, events: 1 }, now: () => 1000 }),
      handlers: {
        on_inbound_message: async () => {
          ingressCalls += 1
          return { ack_id: 'a' }
        },
        resolve_member: async (ctx) => {
          resolveCalls += 1
          return buildResolveMember({ store })(ctx)
        },
      },
    })
    const token = await mintGuestToken(km, { sub: guest.guest_user_id, slug: guest.origin_slug })
    const body = stampOriginInstance({ topic_id: 't', speaker_user_id: 's', body: {} }, guest.origin_slug)
    const send = () =>
      handler(
        new Request('http://t/connect/v1/messages', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )

    const first = await send()
    expect(first!.status).toBe(202)
    const second = await send()
    expect(second!.status).toBe(429) // over the per-token cap
    // The throttled request never reached the routing layer.
    expect(resolveCalls).toBe(1)
    expect(ingressCalls).toBe(1)
  })

  test('per-IP flood at /connect/guest-auth is rejected before the handler runs', async () => {
    const db = makeDb()
    const km = await mintKey()
    let guestAuthCalls = 0
    const handler = createConnectApiHandler({
      receiving_instance_slug: OWNER,
      auth: { jwks: makeJwks(km), receiving_instance_slug: OWNER },
      rate_limiter: createEdgeRateLimiter({ windowMs: 60_000, max: { 'guest-auth': 1, messages: 99, events: 99 }, now: () => 1000 }),
      handlers: {
        guest_auth: async () => {
          guestAuthCalls += 1
          return new Response('{}', { status: 200 })
        },
      },
    })
    const req = () =>
      handler(
        new Request('http://t/connect/v1/connect/guest-auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
          body: '{}',
        }),
      )
    expect((await req())!.status).toBe(200)
    expect((await req())!.status).toBe(429) // over the per-IP cap
    expect(guestAuthCalls).toBe(1) // the throttled request never reached the handler
  })

  test('guest_auth route 404s when the handler is not wired (non-connect node)', async () => {
    const db = makeDb()
    const km = await mintKey()
    void db
    const handler = createConnectApiHandler({
      receiving_instance_slug: OWNER,
      auth: { jwks: makeJwks(km), receiving_instance_slug: OWNER },
      handlers: {},
    })
    const res = await handler(
      new Request('http://t/connect/v1/connect/guest-auth', { method: 'POST', body: '{}' }),
    )
    expect(res!.status).toBe(404)
  })
})
