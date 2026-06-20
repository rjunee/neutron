/**
 * M2.6 Ph5 test #7 + #8a — guest-bearer refresh re-mints, cannot escalate, and
 * 403s a revoked member.
 *
 * An active guest presenting its bearer gets a FRESH bearer with the SAME sub +
 * the SAME single membership (no widening, no class change — brief § 3.2, § 5
 * #4). A REVOKED guest's refresh 403s (brief § 3.3). The handler never touches
 * the invite store (re-redeeming a consumed invite is not a code path) — proven
 * structurally: it imports no invite store, and the consumed invite is untouched.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeJwt, generateKeyPair, type KeyLike } from 'jose'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { ConnectGuestInviteStore } from '../guest-invite-store.ts'
import { ConnectedMembersStore } from '../connected-members-store.ts'
import { acceptGuestMember } from '../member-join.ts'
import { buildGuestRefreshHandler } from '../guest-refresh-handler.ts'
import type { ConnectAuthContext } from '../api/jwt-bearer-middleware.ts'

const PROJECT_ID = 'p-owner-1'
const OWNER = 'connect-node'
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-ph5-refresh-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  db.raw().run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, 'Owner Project', 'private', 'personal', ?, ?)`,
    [PROJECT_ID, new Date(0).toISOString(), new Date(0).toISOString()],
  )
  return db
}

async function makeKey(): Promise<{ getActiveKey: () => Promise<{ kid: string; privateKey: KeyLike }> }> {
  const { privateKey } = await generateKeyPair('EdDSA', { extractable: true })
  return { getActiveKey: async () => ({ kid: 'k1', privateKey }) }
}

async function makeActiveGuest(db: ProjectDb): Promise<{ ctx: ConnectAuthContext; localSlug: string; sub: string; inviteToken: string }> {
  const store = new ConnectedMembersStore(db)
  const inviteStore = new ConnectGuestInviteStore(db)
  const issued = await inviteStore.issue({ project_id: PROJECT_ID, access: 'write', ttl_ms: 60_000, now: 1_000 })
  const accepted = await acceptGuestMember(
    { invite_token: issued.token, display_name: 'Bob', guest_handle: 'bob.example.com' },
    { store, inviteStore, db, now: () => 2_000 },
  )
  return {
    ctx: {
      origin_instance_slug: accepted.origin_slug,
      origin_user_id: accepted.guest_user_id,
      scopes: ['role:member'],
      memberships: [{ slug: accepted.origin_slug, role: 'member', kind: 'user' }],
    },
    localSlug: accepted.member.local_slug,
    sub: accepted.guest_user_id,
    inviteToken: issued.token,
  }
}

describe('Ph5 guest-refresh — re-mint without escalation (test #7, #8a)', () => {
  test('active guest gets a fresh bearer with the SAME sub + membership', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const { ctx, sub } = await makeActiveGuest(db)
    const { getActiveKey } = await makeKey()
    const handler = buildGuestRefreshHandler({ store, owner_slug: OWNER, getActiveKey, now: () => 5_000 })

    const res = await handler(ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; role: string }
    expect(typeof body.token).toBe('string')
    const claims = decodeJwt(body.token)
    // SAME sub, SAME single membership — no widening.
    expect(claims.sub).toBe(sub)
    expect(claims.aud).toEqual([`connect.${OWNER}`])
    const memberships = claims['memberships'] as Array<{ slug: string }>
    expect(memberships).toHaveLength(1)
    expect(memberships[0]?.slug).toBe(ctx.origin_instance_slug)
    // role resolved server-side from the stored row — 'collaborator'.
    expect(body.role).toBe('collaborator')
    // NO role claim leaked into the token.
    expect(claims['role']).toBeUndefined()
  })

  test('a revoked guest is refused (403) and gets no new bearer', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const { ctx, localSlug } = await makeActiveGuest(db)
    await store.setStatus(localSlug, 'revoked')
    const { getActiveKey } = await makeKey()
    const handler = buildGuestRefreshHandler({ store, owner_slug: OWNER, getActiveKey, now: () => 5_000 })

    const res = await handler(ctx)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; token?: string }
    expect(body.error).toBe('member_not_active')
    expect(body.token).toBeUndefined()
  })

  test('refresh does not consume / re-redeem the original invite', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const inviteStore = new ConnectGuestInviteStore(db)
    const { ctx, inviteToken } = await makeActiveGuest(db)
    // The invite was consumed by the accept; refresh must not touch it.
    const before = inviteStore.getByHash((await import('../guest-invite-store.ts')).hashInviteToken(inviteToken))
    expect(before!.redeemed_at_ms).not.toBeNull()
    const { getActiveKey } = await makeKey()
    const handler = buildGuestRefreshHandler({ store, owner_slug: OWNER, getActiveKey, now: () => 5_000 })
    await handler(ctx)
    const after = inviteStore.getByHash((await import('../guest-invite-store.ts')).hashInviteToken(inviteToken))
    // Untouched: same redeemed timestamp, no second redemption path.
    expect(after!.redeemed_at_ms).toBe(before!.redeemed_at_ms)
  })
})
