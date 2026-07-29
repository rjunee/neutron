/**
 * M2.6 Ph3 — acceptGuestMember lifecycle + the shared #108 allocator fix.
 *
 * Locks brief tests:
 *   #2 (guest handshake records a scoped credential — the DB-row half): an
 *      accepted collaborator writes a connected_members row role='collaborator',
 *      home_authority=<handle>, status='active', grammar-valid local_slug + a
 *      project_members row with origin_instance=local_slug.
 *   #4c (single-use): a replayed invite throws + writes NO second member.
 *   #6 (revoke): a guest revoke flips status and the resolver 403s the guest.
 *   #7 (ISSUES #108): two CONCURRENT accepts of the SAME display_name produce
 *      two DISTINCT grammar-valid slugs with no PK collision — proven for BOTH
 *      the guest path AND the trusted path (the allocator fix is shared).
 *
 * No SQL-stub past the join: every assertion reads the real per-project DB rows.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ConnectedMembersStore } from '../connected-members-store.ts'
import { ConnectGuestInviteStore } from '../guest-invite-store.ts'
import {
  acceptGuestMember,
  acceptTrustedMember,
  buildResolveMember,
  revokeMember,
} from '../member-join.ts'
import { SLUG_RE } from '../slug-format.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

const PROJECT_ID = 'p-owner-1'
const RECEIVING = 'owner-meeting'

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-guest-join-'))
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

interface ProjectMemberRow {
  user_id: string
  origin_instance: string | null
}
function readProjectMember(db: ProjectDb, userId: string): ProjectMemberRow | null {
  return (
    db
      .raw()
      .query<ProjectMemberRow, [string, string]>(
        `SELECT user_id, origin_instance FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`,
      )
      .get(PROJECT_ID, userId) ?? null
  )
}

describe('acceptGuestMember — full identity record (brief test #2 / DB half)', () => {
  test('records a guest connected_members row + project_members(origin_instance)', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const inviteStore = new ConnectGuestInviteStore(db)
    const invited = await inviteStore.issue({
      project_id: PROJECT_ID,
      ttl_ms: 60_000,
      now: 1_700_000_000_000,
    })

    const accepted = await acceptGuestMember(
      {
        invite_token: invited.token,
        display_name: 'Mona',
        guest_handle: 'mona.example.com',
      },
      { store, inviteStore, db, now: () => 1_700_000_000_000 },
    )

    const member = store.get(accepted.member.local_slug)!
    expect(member.role).toBe('collaborator')
    expect(member.home_authority).toBe('mona.example.com') // self-asserted handle
    expect(member.status).toBe('active')
    expect(member.access).toBe('write') // collaborator default from the invite
    expect(SLUG_RE.test(member.local_slug)).toBe(true)
    expect(member.local_slug).toBe('mona')
    // home_user_id is a CONNECT-ASSIGNED unique id (not self-asserted).
    expect(member.home_user_id).toBe(accepted.guest_user_id)
    expect(member.home_user_id).toMatch(/^guest-/)
    expect(accepted.project_id).toBe(PROJECT_ID)

    // project_members row carries origin_instance = local_slug.
    expect(readProjectMember(db, accepted.guest_user_id)!.origin_instance).toBe('mona')

    // The invite is now spent (single-use), stamped with the assigned slug.
    expect(inviteStore.getByHash(invited.token_hash)!.redeemed_at_ms).not.toBeNull()
    expect(inviteStore.getByHash(invited.token_hash)!.redeemed_by_slug).toBe('mona')
  })

  test('a replayed invite throws and writes NO second member (brief test #4c)', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const inviteStore = new ConnectGuestInviteStore(db)
    const invited = await inviteStore.issue({ project_id: PROJECT_ID, ttl_ms: 60_000, now: 1 })

    await acceptGuestMember(
      { invite_token: invited.token, display_name: 'Mona', guest_handle: 'a.example' },
      { store, inviteStore, db, now: () => 2 },
    )
    await expect(
      acceptGuestMember(
        { invite_token: invited.token, display_name: 'Mallory', guest_handle: 'm.example' },
        { store, inviteStore, db, now: () => 3 },
      ),
    ).rejects.toMatchObject({ name: 'GuestInviteError', reason: 'already_redeemed' })

    // Exactly ONE member exists — the replay rolled back before any write.
    expect(store.list()).toHaveLength(1)
  })

  test('a guest and a trusted member named "Mona" never collide (one namespace)', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const inviteStore = new ConnectGuestInviteStore(db)
    const trusted = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-home',
        home_user_id: 'u-mona',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )
    const invited = await inviteStore.issue({ project_id: PROJECT_ID, ttl_ms: 60_000, now: 1 })
    const guest = await acceptGuestMember(
      { invite_token: invited.token, display_name: 'Mona', guest_handle: 'mona.example' },
      { store, inviteStore, db, now: () => 2 },
    )
    expect(trusted.member.local_slug).toBe('mona')
    expect(guest.member.local_slug).toBe('mona-2')
    expect(guest.member.local_slug).not.toBe(trusted.member.local_slug)
  })
})

describe('guest revoke stops resolution (brief test #6)', () => {
  test('revoke flips status and the resolver 403s the guest', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const inviteStore = new ConnectGuestInviteStore(db)
    const resolve = buildResolveMember({ store })
    const invited = await inviteStore.issue({ project_id: PROJECT_ID, ttl_ms: 60_000, now: 1 })
    const guest = await acceptGuestMember(
      { invite_token: invited.token, display_name: 'Mona', guest_handle: 'mona.example' },
      { store, inviteStore, db, now: () => 2 },
    )

    // While active: resolves to the guest's local_slug + server-resolved class.
    const ok = await resolve({
      origin_instance_slug: guest.origin_slug,
      origin_user_id: guest.guest_user_id,
      scopes: [],
      memberships: [],
    })
    expect(ok).toEqual({
      ok: true,
      local_slug: 'mona',
      role: 'collaborator',
      access: 'write',
      display_name: 'Mona',
    })

    await revokeMember(
      { local_slug: guest.member.local_slug, receiving_instance_slug: RECEIVING },
      { store },
    )
    expect(store.get(guest.member.local_slug)!.status).toBe('revoked')

    const denied = await resolve({
      origin_instance_slug: guest.origin_slug,
      origin_user_id: guest.guest_user_id,
      scopes: [],
      memberships: [],
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.status).toBe(403)
  })
})

describe('ISSUES #108 — slug allocated INSIDE the accept tx (brief test #7)', () => {
  test('two CONCURRENT trusted accepts of the SAME display_name → two DISTINCT slugs', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const [a, b] = await Promise.all([
      acceptTrustedMember(
        {
          display_name: 'Mona',
          home_instance_slug: 'home-a',
          home_user_id: 'u-a',
          project_id: PROJECT_ID,
          receiving_instance_slug: RECEIVING,
        },
        { store, db },
      ),
      acceptTrustedMember(
        {
          display_name: 'Mona',
          home_instance_slug: 'home-b',
          home_user_id: 'u-b',
          project_id: PROJECT_ID,
          receiving_instance_slug: RECEIVING,
        },
        { store, db },
      ),
    ])
    expect(a.member.local_slug).not.toBe(b.member.local_slug)
    for (const s of [a.member.local_slug, b.member.local_slug]) {
      expect(SLUG_RE.test(s)).toBe(true)
    }
    expect(store.list()).toHaveLength(2)
    // No failed insert: both members are active + resolvable.
    expect(store.list().filter((m) => m.status === 'active')).toHaveLength(2)
  })

  test('two CONCURRENT guest accepts of the SAME display_name → two DISTINCT slugs', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const inviteStore = new ConnectGuestInviteStore(db)
    const i1 = await inviteStore.issue({ project_id: PROJECT_ID, ttl_ms: 60_000, now: 1 })
    const i2 = await inviteStore.issue({ project_id: PROJECT_ID, ttl_ms: 60_000, now: 1 })
    const [a, b] = await Promise.all([
      acceptGuestMember(
        { invite_token: i1.token, display_name: 'Mona', guest_handle: 'a.example' },
        { store, inviteStore, db, now: () => 2 },
      ),
      acceptGuestMember(
        { invite_token: i2.token, display_name: 'Mona', guest_handle: 'b.example' },
        { store, inviteStore, db, now: () => 2 },
      ),
    ])
    expect(a.member.local_slug).not.toBe(b.member.local_slug)
    for (const s of [a.member.local_slug, b.member.local_slug]) {
      expect(SLUG_RE.test(s)).toBe(true)
    }
    expect(store.list()).toHaveLength(2)
  })
})
