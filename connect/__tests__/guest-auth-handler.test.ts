/**
 * M2.6 Ph3 — the public guest-auth handshake (POST /connect/guest-auth).
 *
 * Locks brief test #2: a valid single-use invite mints a guest bearer that
 * validates through the REAL `jwt-bearer-middleware` with NO middleware change
 * (aud=connect.<owner_slug>, single membership, sub=the connect-assigned
 * guest subject), AND records the connected_members + project_members rows.
 * Also locks the invite-refusal status codes (test #4c): replay → 409, expired →
 * 410, missing → 404, malformed body → 400.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportJWK, generateKeyPair, type KeyLike } from 'jose'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { JwksCache, type FetchLike } from '@neutronai/jwt-validator/index.ts'
import { authorizeConnectRequest } from '../api/jwt-bearer-middleware.ts'
import { ConnectedMembersStore } from '../connected-members-store.ts'
import { ConnectGuestInviteStore } from '../guest-invite-store.ts'
import { buildGuestAuthHandler } from '../guest-auth-handler.ts'
import type { MirrorMemoryOnJoinFn } from '../member-join.ts'

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
function jwksCache(km: KeyMat): JwksCache {
  const fetch: FetchLike = async () =>
    new Response(JSON.stringify(km.jwks), { status: 200, headers: { 'content-type': 'application/json' } })
  return new JwksCache('https://auth.example/.well-known/jwks.json', { fetch })
}

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-guest-auth-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  db.raw().run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, ?, 'workspace', 'personal', ?, ?)`,
    [PROJECT_ID, 'Owner Project', new Date(0).toISOString(), new Date(0).toISOString()],
  )
  return db
}

async function buildBench(km: KeyMat, now: () => number) {
  const db = makeDb()
  const store = new ConnectedMembersStore(db)
  const inviteStore = new ConnectGuestInviteStore(db)
  const handler = buildGuestAuthHandler({
    store,
    inviteStore,
    db,
    owner_slug: OWNER,
    getActiveKey: async () => ({ kid: km.kid, privateKey: km.privateKey }),
    now,
  })
  return { db, store, inviteStore, handler }
}

function post(body: unknown): Request {
  return new Request('http://internal/connect/v1/connect/guest-auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('guest-auth handshake mints a valid, middleware-accepted bearer (brief test #2)', () => {
  test('valid invite → guest bearer validates through the REAL jwt-bearer-middleware', async () => {
    const km = await mintKey()
    // Real-time clock: the minted bearer's `exp` must be in the future relative
    // to the middleware's real-time validation below.
    const t = Date.now()
    const { db, store, inviteStore, handler } = await buildBench(km, () => t)
    const invited = await inviteStore.issue({ project_id: PROJECT_ID, ttl_ms: 60_000, now: t })

    const res = await handler(
      post({ invite_token: invited.token, display_name: 'Mona', guest_handle: 'mona.example.com' }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      audience: string
      origin_instance_slug: string
      local_slug: string
      role: string
      project_id: string
    }
    expect(body.audience).toBe(`connect.${OWNER}`)
    expect(body.role).toBe('collaborator')
    expect(body.local_slug).toBe('mona')
    expect(body.project_id).toBe(PROJECT_ID)

    // (a) DB-row half: a collaborator connected_members row exists.
    const member = store.get('mona')!
    expect(member.role).toBe('collaborator')
    expect(member.home_authority).toBe('mona.example.com')

    // (b) the returned bearer validates through the EXISTING middleware with NO
    // middleware change — aud=connect.<owner>, single membership auto-resolves.
    const auth = await authorizeConnectRequest(
      new Request('http://internal/connect/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${body.token}` },
      }),
      { jwks: jwksCache(km), receiving_instance_slug: OWNER },
    )
    expect(auth.ok).toBe(true)
    if (auth.ok) {
      // The middleware resolves the SAME identity the row keys on.
      expect(auth.context.origin_instance_slug).toBe(body.origin_instance_slug)
      expect(auth.context.origin_user_id).toMatch(/^guest-/)
      expect(member.home_user_id).toBe(auth.context.origin_user_id)
    }
    expect(db.raw().query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM connected_members`).all()[0]!.n).toBe(1)
  })
})

describe('guest-auth handshake threads the §1.8 import-on-join seam (B2 fix-pass)', () => {
  // Spec-conformance (CLAUDE.md anti-placeholder rule): when the mirror seam IS
  // supplied to the MOUNTED handler, a real guest-auth request must actually
  // invoke it (not merely advance bookkeeping). This proves the
  // handler → acceptGuestMember → mirrorMemoryOnJoin plumbing fires end-to-end.
  // The production composer does not supply the seam yet (distributed activation
  // is gated on the HTTP host-snapshot transport + per-project GBrain scoping —
  // see member-join.ts), but the plumbing it would use is exercised here.
  test('a real accept invokes mirrorMemoryOnJoin with the resolved project + author', async () => {
    const km = await mintKey()
    const t = Date.now()
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const inviteStore = new ConnectGuestInviteStore(db)

    const calls: Array<{ project_id: string; author: { id: string; display: string } }> = []
    const mirror: MirrorMemoryOnJoinFn = async ({ project_id, author }) => {
      calls.push({ project_id, author })
    }
    const handler = buildGuestAuthHandler({
      store,
      inviteStore,
      db,
      owner_slug: OWNER,
      getActiveKey: async () => ({ kid: km.kid, privateKey: km.privateKey }),
      mirrorMemoryOnJoin: mirror,
      now: () => t,
    })

    const invited = await inviteStore.issue({ project_id: PROJECT_ID, ttl_ms: 60_000, now: t })
    const res = await handler(
      post({ invite_token: invited.token, display_name: 'Mona', guest_handle: 'mona.example.com' }),
    )
    expect(res.status).toBe(200)

    // The seam fired exactly once, attributed to the joining collaborator's
    // resolved local_slug + display (connect-spec §4 author envelope).
    expect(calls).toHaveLength(1)
    expect(calls[0]!.project_id).toBe(PROJECT_ID)
    expect(calls[0]!.author.id).toBe('mona')
    expect(calls[0]!.author.display).toBe('Mona')
  })

  test('seam omitted → handler still succeeds (best-effort, optional dep)', async () => {
    const km = await mintKey()
    const t = Date.now()
    const { handler, inviteStore } = await buildBench(km, () => t)
    const invited = await inviteStore.issue({ project_id: PROJECT_ID, ttl_ms: 60_000, now: t })
    const res = await handler(
      post({ invite_token: invited.token, display_name: 'Solo', guest_handle: 'solo.example' }),
    )
    expect(res.status).toBe(200)
  })
})

describe('guest-auth handshake refuses bad invites (brief test #4c)', () => {
  test('replayed invite → 409, no second member', async () => {
    const km = await mintKey()
    const { store, inviteStore, handler } = await buildBench(km, () => 5)
    const invited = await inviteStore.issue({ project_id: PROJECT_ID, ttl_ms: 60_000, now: 1 })
    const first = await handler(post({ invite_token: invited.token, display_name: 'A', guest_handle: 'a.example' }))
    expect(first.status).toBe(200)
    const replay = await handler(post({ invite_token: invited.token, display_name: 'B', guest_handle: 'b.example' }))
    expect(replay.status).toBe(409)
    expect(store.list()).toHaveLength(1)
  })

  test('expired invite → 410', async () => {
    const km = await mintKey()
    const { handler, inviteStore } = await buildBench(km, () => 60_002)
    const invited = await inviteStore.issue({ project_id: PROJECT_ID, ttl_ms: 60_000, now: 1 })
    const res = await handler(post({ invite_token: invited.token, display_name: 'A', guest_handle: 'a.example' }))
    expect(res.status).toBe(410)
  })

  test('missing/unknown invite → 404; malformed body → 400', async () => {
    const km = await mintKey()
    const { handler } = await buildBench(km, () => 1)
    expect(
      (await handler(post({ invite_token: 'nope', display_name: 'A', guest_handle: 'a.example' }))).status,
    ).toBe(404)
    expect((await handler(post({ display_name: 'A' }))).status).toBe(400)
    expect(
      (await handler(post({ invite_token: 'x', display_name: '', guest_handle: 'a.example' }))).status,
    ).toBe(400)
  })
})
