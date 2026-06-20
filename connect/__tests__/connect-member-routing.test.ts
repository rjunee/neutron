/**
 * M2.6 Ph2 — Connect Server multi-member routing over the EXISTING cross-instance
 * transport. Drives the real `createConnectApiHandler` with `resolve_member`
 * wired to a real ConnectedMembersStore (populated via the real join handler).
 *
 * Locks brief tests:
 *   #3 — multi-member routing into ONE owner session: two authenticated members
 *        each POST /messages → both reach on_inbound_message, each re-namespaced
 *        to its own meeting-point local_slug (attributed, not the raw caller slug).
 *   #4 — substrate-independence: routing delivers with NEUTRON_PERSISTENT_REPL
 *        UNSET (current cli-transport). No code path on the routing seam reads
 *        the persistent-REPL flag.
 *   #5 — revoke stops delivery: after revoke the next POST 403s and never reaches
 *        on_inbound_message.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
import { stampOriginInstance } from '../api/origin-tag.ts'
import { JwksCache, type FetchLike } from '../../jwt-validator/index.ts'
import { ConnectedMembersStore } from '../connected-members-store.ts'
import {
  acceptTrustedMember,
  revokeMember,
  buildResolveMember,
} from '../member-join.ts'

const RECEIVING = 'owner-meeting'
const PROJECT_ID = 'p-owner-1'

interface KeyMaterial {
  kid: string
  privateKey: KeyLike
  jwks: { keys: unknown[] }
}

async function mintKey(kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  const pubJwk = await exportJWK(publicKey)
  return { kid, privateKey, jwks: { keys: [{ kid, alg: 'EdDSA', use: 'sig', ...pubJwk }] } }
}

async function mintToken(
  km: KeyMaterial,
  args: { sub: string; aud: string; slug: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000)
  return new SignJWT({
    memberships: [{ slug: args.slug, role: 'member', kind: 'user' }],
  })
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

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

// Substrate-independence guard (brief test #4): the routing seam must work with
// the persistent-REPL flag OFF. Pin it unset for the whole suite.
let prevFlag: string | undefined
beforeEach(() => {
  prevFlag = process.env['NEUTRON_PERSISTENT_REPL']
  delete process.env['NEUTRON_PERSISTENT_REPL']
})
afterEach(() => {
  if (prevFlag === undefined) delete process.env['NEUTRON_PERSISTENT_REPL']
  else process.env['NEUTRON_PERSISTENT_REPL'] = prevFlag
})

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-connect-routing-'))
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

interface Captured {
  ctxOrigin: string
  bodyOrigin: string
  topic: string
}

async function postTurn(
  handler: (req: Request) => Promise<Response | null>,
  token: string,
  homeSlug: string,
  topic: string,
): Promise<Response> {
  const body = stampOriginInstance(
    { topic_id: topic, speaker_user_id: 'speaker', body: { text: 'hello' } },
    homeSlug,
  )
  const r = await handler(
    new Request('http://t/connect/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-origin-instance': homeSlug,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )
  return r!
}

describe('Connect Server multi-member routing (brief test #3)', () => {
  test('two members each POST → both reach on_inbound_message, attributed by local_slug', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const km = await mintKey('k1')

    // Two members named "Mona" from two home authorities → 'mona' + 'mona-2'.
    const a = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-acme',
        home_user_id: 'u-1',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )
    const b = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-globex',
        home_user_id: 'u-2',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )

    const captured: Captured[] = []
    const handlers: ConnectApiHandlers = {
      on_inbound_message: async (ctx, msg) => {
        captured.push({
          ctxOrigin: ctx.origin_instance_slug,
          bodyOrigin: msg.origin_instance,
          topic: msg.payload.topic_id,
        })
        return { ack_id: `ack-${captured.length}` }
      },
      resolve_member: buildResolveMember({ store }),
    }
    const handler = createConnectApiHandler({
      receiving_instance_slug: RECEIVING,
      auth: { jwks: makeJwks(km), receiving_instance_slug: RECEIVING },
      handlers,
    })

    const tokenA = await mintToken(km, {
      sub: 'u-1',
      aud: `connect.${RECEIVING}`,
      slug: 'mona-acme',
    })
    const tokenB = await mintToken(km, {
      sub: 'u-2',
      aud: `connect.${RECEIVING}`,
      slug: 'mona-globex',
    })

    const rA = await postTurn(handler, tokenA, 'mona-acme', 'topic-a')
    const rB = await postTurn(handler, tokenB, 'mona-globex', 'topic-b')

    expect(rA.status).toBe(202)
    expect(rB.status).toBe(202)

    // BOTH reach the one owner session, each re-namespaced to its OWN local_slug
    // (the raw caller slug 'mona-acme'/'mona-globex' is NOT what attributes the turn).
    expect(captured).toEqual([
      { ctxOrigin: a.member.local_slug, bodyOrigin: a.member.local_slug, topic: 'topic-a' },
      { ctxOrigin: b.member.local_slug, bodyOrigin: b.member.local_slug, topic: 'topic-b' },
    ])
    expect(a.member.local_slug).toBe('mona')
    expect(b.member.local_slug).toBe('mona-2')
  })

  test('SECURITY: a 2nd distinct user in the SAME origin instance who was never accepted gets 403 (no slug inheritance)', async () => {
    // Accept-gate bypass + cross-user impersonation regression guard (Argus r1
    // BLOCKER / Codex P1). A single origin instance holds MANY platform users.
    // Only u-1 is accepted into the owner session; u-2 — a legitimately
    // authenticated member of the SAME instance 'mona-acme' but never accepted —
    // must NOT inherit u-1's local_slug and must NOT reach the owner session.
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const km = await mintKey('k1')

    const accepted = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-acme',
        home_user_id: 'u-1',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )

    const captured: Captured[] = []
    const handler = createConnectApiHandler({
      receiving_instance_slug: RECEIVING,
      auth: { jwks: makeJwks(km), receiving_instance_slug: RECEIVING },
      handlers: {
        on_inbound_message: async (ctx, msg) => {
          captured.push({
            ctxOrigin: ctx.origin_instance_slug,
            bodyOrigin: msg.origin_instance,
            topic: msg.payload.topic_id,
          })
          return { ack_id: 'x' }
        },
        resolve_member: buildResolveMember({ store }),
      },
    })

    // u-1 (accepted) → 202, attributed to its assigned slug.
    const tokenAccepted = await mintToken(km, {
      sub: 'u-1',
      aud: `connect.${RECEIVING}`,
      slug: 'mona-acme',
    })
    expect((await postTurn(handler, tokenAccepted, 'mona-acme', 't-ok')).status).toBe(202)

    // u-2 (same instance, NEVER accepted) → 403, never delivered.
    const tokenImposter = await mintToken(km, {
      sub: 'u-2',
      aud: `connect.${RECEIVING}`,
      slug: 'mona-acme',
    })
    const denied = await postTurn(handler, tokenImposter, 'mona-acme', 't-deny')
    expect(denied.status).toBe(403)
    const body = (await denied.json()) as { error: string; reason: string }
    expect(body.error).toBe('member_not_resolved')
    expect(body.reason).toBe('member_not_active')

    // Only the accepted member's turn reached the owner session — u-2 never did,
    // and crucially u-2 was NOT attributed as the accepted member's slug.
    expect(captured).toEqual([
      {
        ctxOrigin: accepted.member.local_slug,
        bodyOrigin: accepted.member.local_slug,
        topic: 't-ok',
      },
    ])
  })

  test('substrate-independence: routing delivers with NEUTRON_PERSISTENT_REPL unset (brief test #4)', async () => {
    expect(process.env['NEUTRON_PERSISTENT_REPL']).toBeUndefined()
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const km = await mintKey('k1')
    await acceptTrustedMember(
      {
        display_name: 'Solo',
        home_instance_slug: 'solo-home',
        home_user_id: 'u-solo',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )
    let delivered = false
    const handler = createConnectApiHandler({
      receiving_instance_slug: RECEIVING,
      auth: { jwks: makeJwks(km), receiving_instance_slug: RECEIVING },
      handlers: {
        on_inbound_message: async () => {
          delivered = true
          return { ack_id: 'x' }
        },
        resolve_member: buildResolveMember({ store }),
      },
    })
    const token = await mintToken(km, {
      sub: 'u-solo',
      aud: `connect.${RECEIVING}`,
      slug: 'solo-home',
    })
    const r = await postTurn(handler, token, 'solo-home', 'topic')
    expect(r.status).toBe(202)
    expect(delivered).toBe(true)
  })
})

describe('revoke stops delivery (brief test #5, HTTP layer)', () => {
  test('after revoke the next POST 403s and never reaches on_inbound_message', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const km = await mintKey('k1')
    const a = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-home',
        home_user_id: 'u-mona',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )

    let deliveries = 0
    const handler = createConnectApiHandler({
      receiving_instance_slug: RECEIVING,
      auth: { jwks: makeJwks(km), receiving_instance_slug: RECEIVING },
      handlers: {
        on_inbound_message: async () => {
          deliveries += 1
          return { ack_id: 'x' }
        },
        resolve_member: buildResolveMember({ store }),
      },
    })
    const token = await mintToken(km, {
      sub: 'u-mona',
      aud: `connect.${RECEIVING}`,
      slug: 'mona-home',
    })

    // Active → 202, delivered.
    expect((await postTurn(handler, token, 'mona-home', 't1')).status).toBe(202)
    expect(deliveries).toBe(1)

    // Revoke → next POST 403, NOT delivered.
    await revokeMember(
      { local_slug: a.member.local_slug, receiving_instance_slug: RECEIVING },
      { store },
    )
    const denied = await postTurn(handler, token, 'mona-home', 't2')
    expect(denied.status).toBe(403)
    expect(deliveries).toBe(1) // unchanged — the revoked turn never reached the handler
    const body = (await denied.json()) as { error: string; reason: string }
    expect(body.error).toBe('member_not_resolved')
    expect(body.reason).toBe('member_not_active')
  })
})

describe('read/write post-boundary gate (connect-spec §1.4)', () => {
  test('a read collaborator POST /messages is refused 403 and never reaches the host session', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const km = await mintKey('k1')
    // Owner granted this collaborator READ access — observe only, cannot post.
    await acceptTrustedMember(
      {
        display_name: 'Reader',
        home_instance_slug: 'reader-home',
        home_user_id: 'u-read',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
        access: 'read',
      },
      { store, db },
    )

    let deliveries = 0
    const handler = createConnectApiHandler({
      receiving_instance_slug: RECEIVING,
      auth: { jwks: makeJwks(km), receiving_instance_slug: RECEIVING },
      handlers: {
        on_inbound_message: async () => {
          deliveries += 1
          return { ack_id: 'x' }
        },
        resolve_member: buildResolveMember({ store }),
      },
    })
    const token = await mintToken(km, {
      sub: 'u-read',
      aud: `connect.${RECEIVING}`,
      slug: 'reader-home',
    })

    const denied = await postTurn(handler, token, 'reader-home', 't-read')
    expect(denied.status).toBe(403)
    // The read turn is refused at the post boundary, BEFORE the host session.
    expect(deliveries).toBe(0)
    const body = (await denied.json()) as { error: string; reason: string }
    expect(body.error).toBe('read_only_member')
    expect(body.reason).toBe('member_access_read')
  })

  test('a write collaborator POST /messages is routed normally (202, delivered)', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const km = await mintKey('k1')
    await acceptTrustedMember(
      {
        display_name: 'Writer',
        home_instance_slug: 'writer-home',
        home_user_id: 'u-write',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
        access: 'write',
      },
      { store, db },
    )
    let delivered = false
    const handler = createConnectApiHandler({
      receiving_instance_slug: RECEIVING,
      auth: { jwks: makeJwks(km), receiving_instance_slug: RECEIVING },
      handlers: {
        on_inbound_message: async () => {
          delivered = true
          return { ack_id: 'x' }
        },
        resolve_member: buildResolveMember({ store }),
      },
    })
    const token = await mintToken(km, {
      sub: 'u-write',
      aud: `connect.${RECEIVING}`,
      slug: 'writer-home',
    })
    expect((await postTurn(handler, token, 'writer-home', 't-write')).status).toBe(202)
    expect(delivered).toBe(true)
  })
})

describe('multi-author attribution stamp (connect-spec §4)', () => {
  test('a routed collaborator turn carries the uniform author {id: local_slug, display: display_name}', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const km = await mintKey('k1')
    const m = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-acme',
        home_user_id: 'u-1',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )

    let captured: { id: string; display: string } | undefined
    const handler = createConnectApiHandler({
      receiving_instance_slug: RECEIVING,
      auth: { jwks: makeJwks(km), receiving_instance_slug: RECEIVING },
      handlers: {
        on_inbound_message: async (_ctx, msg) => {
          captured = msg.payload.author
          return { ack_id: 'x' }
        },
        resolve_member: buildResolveMember({ store }),
      },
    })
    const token = await mintToken(km, {
      sub: 'u-1',
      aud: `connect.${RECEIVING}`,
      slug: 'mona-acme',
    })
    expect((await postTurn(handler, token, 'mona-acme', 't')).status).toBe(202)
    // Author is server-derived from the resolved member row — id = local_slug,
    // display = display_name. NEVER trusted from the wire.
    expect(captured).toEqual({ id: m.member.local_slug, display: 'Mona' })
  })

  test('a client-supplied author in the body is OVERWRITTEN server-side (forge-proof, §4.2)', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const km = await mintKey('k1')
    const m = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-acme',
        home_user_id: 'u-1',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )

    let captured: { id: string; display: string } | undefined
    const handler = createConnectApiHandler({
      receiving_instance_slug: RECEIVING,
      auth: { jwks: makeJwks(km), receiving_instance_slug: RECEIVING },
      handlers: {
        on_inbound_message: async (_ctx, msg) => {
          captured = msg.payload.author
          return { ack_id: 'x' }
        },
        resolve_member: buildResolveMember({ store }),
      },
    })
    const token = await mintToken(km, {
      sub: 'u-1',
      aud: `connect.${RECEIVING}`,
      slug: 'mona-acme',
    })
    // The caller forges an author claiming to be someone else.
    const forged = stampOriginInstance(
      {
        topic_id: 't',
        speaker_user_id: 'speaker',
        body: { text: 'hello' },
        author: { id: 'someone-else', display: 'Impersonator' },
      },
      'mona-acme',
    )
    const r = await handler(
      new Request('http://t/connect/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-origin-instance': 'mona-acme',
          'content-type': 'application/json',
        },
        body: JSON.stringify(forged),
      }),
    )
    expect(r!.status).toBe(202)
    // The forged author is discarded; the server stamp wins.
    expect(captured).toEqual({ id: m.member.local_slug, display: 'Mona' })
  })
})
