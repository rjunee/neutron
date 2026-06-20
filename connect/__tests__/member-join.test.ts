/**
 * M2.6 Ph2 — trusted-member join / leave lifecycle + the resolve_member gate.
 *
 * Locks brief tests:
 *   #1 — member join creates the FULL identity record (connected_members row +
 *        project_members row with origin_instance = local_slug + membership seam).
 *   #2 — identity namespacing: two members named "Mona" from two home
 *        authorities get DISTINCT local_slugs + distinct project_members.origin_instance.
 *   #5 — member leave / revoke: status flips and the resolve_member gate 403s.
 *   + authorization → access mapping (read|write, connect-spec §1.4).
 *
 * No SQL-stub past the join: every assertion reads the real per-project DB rows.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { ConnectedMembersStore } from '../connected-members-store.ts'
import {
  acceptTrustedMember,
  revokeMember,
  buildResolveMember,
  TRUSTED_HOME_AUTHORITY,
  type AcceptTrustedMemberResult,
} from '../member-join.ts'
import { SLUG_RE } from '../slug-format.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

const PROJECT_ID = 'p-owner-1'
const RECEIVING = 'owner-meeting'

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-connect-member-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  // project_members FK → projects(id); seed the owner's project.
  raw2run(db)
  return db
}

function raw2run(db: ProjectDb): void {
  db.raw().run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, ?, 'workspace', 'personal', ?, ?)`,
    [PROJECT_ID, 'Owner Project', new Date(0).toISOString(), new Date(0).toISOString()],
  )
}

interface ProjectMemberRow {
  user_id: string
  name: string
  role: string
  origin_instance: string | null
}

function readProjectMember(db: ProjectDb, userId: string): ProjectMemberRow | null {
  return (
    db
      .raw()
      .query<ProjectMemberRow, [string, string]>(
        `SELECT user_id, name, role, origin_instance FROM project_members
           WHERE project_id = ? AND user_id = ? LIMIT 1`,
      )
      .get(PROJECT_ID, userId) ?? null
  )
}

describe('acceptTrustedMember — full identity record (brief test #1)', () => {
  test('creates connected_members + project_members(origin_instance) + calls membership seam', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const seen: Array<{ workspace_instance_slug: string; accepter_user_id: string; role: string }> =
      []

    const result = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-home',
        home_user_id: 'u-mona',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      {
        store,
        db,
        registerMembership: async (args) => {
          seen.push(args)
        },
        now: () => 1_700_000_000_000,
      },
    )

    expect(result.reused).toBe(false)
    // connected_members row
    const member = store.get(result.member.local_slug)
    expect(member).not.toBeNull()
    expect(member!.role).toBe('collaborator')
    expect(member!.home_authority).toBe(TRUSTED_HOME_AUTHORITY)
    expect(member!.home_instance_slug).toBe('mona-home')
    expect(member!.home_user_id).toBe('u-mona')
    expect(member!.status).toBe('active')
    expect(member!.access).toBe('write') // collaborator default
    expect(member!.approved_at).not.toBeNull()
    expect(SLUG_RE.test(member!.local_slug)).toBe(true)
    expect(member!.local_slug).toBe('mona')

    // project_members row carries origin_instance = local_slug
    const pm = readProjectMember(db, 'u-mona')
    expect(pm).not.toBeNull()
    expect(pm!.name).toBe('Mona')
    expect(pm!.role).toBe('member')
    expect(pm!.origin_instance).toBe('mona')

    // membership seam (LIFT — M2.5) invoked with the right args
    expect(seen).toEqual([
      { workspace_instance_slug: RECEIVING, accepter_user_id: 'u-mona', role: 'member' },
    ])
  })

  test('read access is recordable; collaborator default → write (admin dropped, OQ-4)', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    // The owner is the only admin (connect-spec §1.4): the access axis collapsed
    // to {read, write}. An owner-chosen `read` grant persists verbatim.
    const r = await acceptTrustedMember(
      {
        display_name: 'peer-a-user',
        home_instance_slug: 'peer-a-home',
        home_user_id: 'u-peer-a',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
        access: 'read',
      },
      { store, db },
    )
    expect(store.get(r.member.local_slug)!.access).toBe('read')

    // No explicit access → collaborator default 'write'.
    const w = await acceptTrustedMember(
      {
        display_name: 'peer-b-user',
        home_instance_slug: 'peer-b-home',
        home_user_id: 'u-peer-b',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )
    expect(store.get(w.member.local_slug)!.access).toBe('write')
  })

  test('re-accept of an active member is idempotent (no duplicate identity)', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
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
    const b = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-home',
        home_user_id: 'u-mona',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )
    expect(b.reused).toBe(true)
    expect(b.member.local_slug).toBe(a.member.local_slug)
    expect(store.list()).toHaveLength(1)
  })

  test('SECURITY: a 2nd DISTINCT user in the same instance mints its OWN identity (not reused)', async () => {
    // Idempotency keys on (home_instance_slug, home_user_id), not the instance slug
    // alone. A single origin instance holds many users; the second user must get a
    // distinct local_slug, not be reused-as the first (Argus r1 BLOCKER guard).
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const a = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'acme',
        home_user_id: 'u-1',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )
    const b = await acceptTrustedMember(
      {
        display_name: 'Dana',
        home_instance_slug: 'acme', // SAME instance
        home_user_id: 'u-2', // DIFFERENT user
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )
    expect(b.reused).toBe(false)
    expect(b.member.local_slug).not.toBe(a.member.local_slug)
    expect(store.list()).toHaveLength(2)
    // Each identity resolves to ITS OWN row, never the other's.
    expect(store.resolveActiveByHomeIdentity('acme', 'u-1')!.local_slug).toBe(
      a.member.local_slug,
    )
    expect(store.resolveActiveByHomeIdentity('acme', 'u-2')!.local_slug).toBe(
      b.member.local_slug,
    )
    // A 3rd, never-accepted user in the same instance resolves to nothing → 403.
    expect(store.resolveActiveByHomeIdentity('acme', 'u-3')).toBeNull()
  })
})

describe('identity namespacing — no collision (brief test #2)', () => {
  test('two "Mona"s from two home authorities → distinct local_slugs + origin_instance', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)

    const a = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-acme',
        home_user_id: 'u-1',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
        home_authority: 'auth.neutron.example',
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
        home_authority: 'auth.neutron.example',
      },
      { store, db },
    )

    expect(a.member.local_slug).not.toBe(b.member.local_slug)
    expect(a.member.local_slug).toBe('mona')
    expect(b.member.local_slug).toBe('mona-2')
    for (const s of [a.member.local_slug, b.member.local_slug]) {
      expect(SLUG_RE.test(s)).toBe(true)
    }
    expect(readProjectMember(db, 'u-1')!.origin_instance).toBe('mona')
    expect(readProjectMember(db, 'u-2')!.origin_instance).toBe('mona-2')
  })
})

describe('ISSUES #108 — slug-allocator race under concurrency (brief test #7)', () => {
  // Regression guard for ISSUES #108. Two DISTINCT users that share a
  // display_name, accepted CONCURRENTLY against the SAME project DB, must each
  // get a distinct grammar-valid local_slug (base + base-2) with NO throw.
  //
  // Pre-fix (slug computed OUTSIDE the accept tx) both racers read hasSlug=false
  // before either committed, both picked the same base 'mona', and the second
  // INSERT collided on the local_slug PK → its promise rejected → Promise.all
  // rejected. Post-fix the allocation lives INSIDE the tx; the ProjectDb
  // per-instance write mutex serializes the BEGIN→COMMIT window, so the second
  // racer's hasSlug('mona') sees the first's committed row and deterministically
  // picks 'mona-2'. Verified RED against a reverted (out-of-tx) allocation.
  test('two concurrent accepts of distinct users sharing a display_name → distinct slugs, no PK collision', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)

    const accept = (slug: string, uid: string): Promise<AcceptTrustedMemberResult> =>
      acceptTrustedMember(
        {
          display_name: 'Mona',
          home_instance_slug: slug,
          home_user_id: uid,
          project_id: PROJECT_ID,
          receiving_instance_slug: RECEIVING,
          home_authority: 'auth.neutron.example',
        },
        { store, db },
      )

    // Fire both BEFORE awaiting either: this is the true-concurrency window the
    // mutex must serialize. Promise.all rejects if the loser hits the PK.
    const [a, b] = await Promise.all([accept('mona-acme', 'u-1'), accept('mona-globex', 'u-2')])

    // Both succeeded with DISTINCT, grammar-valid slugs — one base, one -2.
    expect(a.member.local_slug).not.toBe(b.member.local_slug)
    expect(new Set([a.member.local_slug, b.member.local_slug])).toEqual(new Set(['mona', 'mona-2']))
    for (const s of [a.member.local_slug, b.member.local_slug]) {
      expect(SLUG_RE.test(s)).toBe(true)
    }

    // Both connected_members rows persisted, both project_members carry their
    // own origin_instance = local_slug — no lost write, no overwrite.
    expect(store.get('mona')).not.toBeNull()
    expect(store.get('mona-2')).not.toBeNull()
    const pm1 = readProjectMember(db, 'u-1')!.origin_instance
    const pm2 = readProjectMember(db, 'u-2')!.origin_instance
    expect(new Set([pm1, pm2])).toEqual(new Set(['mona', 'mona-2']))
  })
})

describe('member leave / revoke (brief test #5)', () => {
  test('revoke flips status and the resolve_member gate refuses with 403', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const resolve = buildResolveMember({ store })

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

    // While active: resolves to the member's local_slug + the server-resolved
    // role (read from the stored row, never the token).
    const ok = await resolve(makeCtx('mona-home', 'u-mona'))
    expect(ok).toEqual({
      ok: true,
      local_slug: a.member.local_slug,
      role: 'collaborator',
      access: 'write',
      display_name: a.member.display_name,
    })

    // Revoke → status flips, membership seam called.
    const revokedSeen: Array<{ workspace_instance_slug: string; member_user_id: string }> = []
    const res = await revokeMember(
      { local_slug: a.member.local_slug, receiving_instance_slug: RECEIVING },
      {
        store,
        revokeMembership: async (args) => {
          revokedSeen.push(args)
        },
      },
    )
    expect(res.revoked).toBe(true)
    expect(store.get(a.member.local_slug)!.status).toBe('revoked')
    expect(revokedSeen).toEqual([
      { workspace_instance_slug: RECEIVING, member_user_id: 'u-mona' },
    ])

    // After revoke: the gate 403s.
    const denied = await resolve(makeCtx('mona-home', 'u-mona'))
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.status).toBe(403)
  })

  test('re-accept after revoke succeeds atomically + re-points project_members (Codex P1)', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const resolve = buildResolveMember({ store })

    const first = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-home',
        home_user_id: 'u-mona',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )
    expect(first.member.local_slug).toBe('mona')
    expect(readProjectMember(db, 'u-mona')!.origin_instance).toBe('mona')

    // Revoke — leaves the project_members row in place (accepted semantics).
    await revokeMember(
      { local_slug: first.member.local_slug, receiving_instance_slug: RECEIVING },
      { store },
    )

    // Re-accept the SAME member: the old project_members (project_id, user_id)
    // row still exists. The accept must NOT throw on the composite PK and must
    // NOT strand an active row — it re-points project_members to the new slug.
    const second = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-home',
        home_user_id: 'u-mona',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )
    expect(second.reused).toBe(false)
    expect(second.member.status).toBe('active')
    // The re-accept resolves cleanly (the active identity is the new one).
    const r = await resolve(makeCtx('mona-home', 'u-mona'))
    expect(r).toEqual({
      ok: true,
      local_slug: second.member.local_slug,
      role: 'collaborator',
      access: 'write',
      display_name: second.member.display_name,
    })
    // project_members re-pointed to the new active slug (no PK-collision throw,
    // no stale origin_instance).
    expect(readProjectMember(db, 'u-mona')!.origin_instance).toBe(
      second.member.local_slug,
    )
    // Exactly one active member resolves for this home instance.
    expect(store.list().filter((m) => m.status === 'active')).toHaveLength(1)
  })

  test('revoke of an unknown slug is a no-op', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const res = await revokeMember(
      { local_slug: 'nobody', receiving_instance_slug: RECEIVING },
      { store },
    )
    expect(res.revoked).toBe(false)
  })
})

function makeCtx(originSlug: string, userId: string) {
  return {
    origin_instance_slug: originSlug,
    origin_user_id: userId,
    scopes: [],
    memberships: [],
  }
}
