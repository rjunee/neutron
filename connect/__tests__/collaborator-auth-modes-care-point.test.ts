/**
 * MEDIUM-risk seam (connect-trust-class-collapse-brief, "the one care-point"):
 *
 * A SINGLE "invite a collaborator" flow must be able to route a Managed invitee
 * through the OAuth accept (acceptTrustedMember) AND a Neutron Open invitee
 * through the token handshake (acceptGuestMember) — the two genuinely-different
 * accept MECHANICS that the collapse preserved — and have BOTH land as
 * `role='collaborator'`, with NO user-visible tier reintroduced.
 *
 * This is the load-bearing assertion of the whole sprint: the two auth mechanics
 * stay, but they are no longer an identity tier. If a future change re-stamps one
 * path with a distinct role, or the resolver returns anything other than
 * 'collaborator' for either, this test fails.
 *
 * No SQL-stub: both members are created via the REAL accept functions and read
 * back from the real per-project DB.
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
  acceptTrustedMember,
  acceptGuestMember,
  buildResolveMember,
} from '../member-join.ts'
import type { ConnectAuthContext } from '../api/jwt-bearer-middleware.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

const PROJECT_ID = 'p-owner-collab'
const RECEIVING = 'owner-meeting'

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-collab-care-'))
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

function ctx(slug: string, userId: string): ConnectAuthContext {
  return {
    origin_instance_slug: slug,
    origin_user_id: userId,
    scopes: [],
    memberships: [],
  }
}

describe('one collaborator invite, two auth mechanics, one role (MEDIUM seam)', () => {
  test('Managed-OAuth accept AND self-hosted token accept BOTH land role=collaborator with no tier', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const resolve = buildResolveMember({ store })

    // --- Path A: a Managed invitee on another instance (OAuth bearer accept). ---
    const managed = await acceptTrustedMember(
      {
        display_name: 'Managed Maria',
        home_instance_slug: 'maria-managed',
        home_user_id: 'u-maria',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db },
    )
    expect(managed.member.role).toBe('collaborator')

    // --- Path B: a Neutron Open self-hoster (single-use token handshake). ---
    const inviteStore = new ConnectGuestInviteStore(db)
    const invited = await inviteStore.issue({ project_id: PROJECT_ID, ttl_ms: 600_000, now: 1 })
    const open = await acceptGuestMember(
      { invite_token: invited.token, display_name: 'Open Oleg', guest_handle: 'oleg.example.com' },
      { store, inviteStore, db, now: () => 2 },
    )
    expect(open.member.role).toBe('collaborator')

    // Both stored rows carry the SAME role — the auth mechanism did not stamp a
    // tier onto identity.
    expect(store.get(managed.member.local_slug)!.role).toBe('collaborator')
    expect(store.get(open.member.local_slug)!.role).toBe('collaborator')

    // The resolver (the load-bearing gate) returns role='collaborator' for BOTH,
    // regardless of which mechanism authenticated them.
    const rManaged = await resolve(ctx('maria-managed', 'u-maria'))
    const rOpen = await resolve(ctx(open.origin_slug, open.guest_user_id))
    expect(rManaged).toMatchObject({ ok: true, role: 'collaborator' })
    expect(rOpen).toMatchObject({ ok: true, role: 'collaborator' })

    // The project roster shows two distinct collaborators and NO tier axis: the
    // ONLY non-owner role present is 'collaborator'. If a tier ever leaks back in,
    // this set grows and the test fails.
    const roster = store.listByProject(PROJECT_ID)
    expect(roster).toHaveLength(2)
    const roles = new Set(roster.map((m) => m.role))
    expect([...roles]).toEqual(['collaborator'])

    // The two members remain DISTINCT identities (distinct local_slugs) — the
    // collapse unified the role, not the members.
    expect(managed.member.local_slug).not.toBe(open.member.local_slug)
  })
})
