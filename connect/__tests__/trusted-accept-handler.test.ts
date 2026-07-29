/**
 * M2.6 Ph5 test #4 — the cross-instance trusted accept wires acceptTrustedMember.
 *
 * An invitee resolved to a DIFFERENT origin instance (the M2.5 cross-instance bearer
 * IS the gate) accepts a connect invite → acceptTrustedMember runs, recording a
 * `connected_members` role='collaborator' row + a `project_members`
 * origin_instance row. Single-use is preserved (a replay 409s). The owner-chosen
 * scope rides the invite.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair, exportJWK, type KeyLike } from 'jose'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ConnectedMembersStore } from '../connected-members-store.ts'
import { issueInviteToken, type InviteSigningKey } from '../../onboarding/api/invite-link-generate.ts'
import { buildTrustedAcceptHandler } from '../trusted-accept-handler.ts'
import type { MirrorMemoryOnJoinFn } from '../member-join.ts'
import type { ConnectAuthContext } from '../api/jwt-bearer-middleware.ts'

const PROJECT_ID = 'p-owner-1'
const OWNER = 'connect-node'
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-ph5-trusted-'))
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

interface KeyBundle {
  signing: InviteSigningKey
  resolveKey: (kid: string) => Promise<KeyLike | null>
}

async function makeKeys(): Promise<KeyBundle> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  // Re-import the public key as a KeyLike via JWK round-trip (mirrors a JWKS).
  const pubJwk = await exportJWK(publicKey)
  const { importJWK } = await import('jose')
  const pub = (await importJWK({ ...pubJwk, alg: 'EdDSA' }, 'EdDSA')) as KeyLike
  return {
    signing: { kid: 'k1', privateKey },
    resolveKey: async (kid) => (kid === 'k1' ? pub : null),
  }
}

function ctxFor(originInstance: string, userId: string): ConnectAuthContext {
  return {
    origin_instance_slug: originInstance,
    origin_user_id: userId,
    scopes: ['role:member'],
    memberships: [{ slug: originInstance, role: 'member', kind: 'user' }],
  }
}

function readProjectMember(db: ProjectDb, userId: string): { origin_instance: string } | null {
  return (
    db
      .raw()
      .query<{ origin_instance: string }, [string, string]>(
        `SELECT origin_instance FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`,
      )
      .get(PROJECT_ID, userId) ?? null
  )
}

describe('Ph5 trusted cross-instance accept (test #4)', () => {
  test('wires acceptTrustedMember → trusted member row + origin_instance; M2.5 bearer is the gate', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const keys = await makeKeys()
    const issued = await issueInviteToken({
      workspace_instance_slug: OWNER,
      project_id: PROJECT_ID,
      invitee_email: 'bob@other.org',
      inviter_user_id: 'u-owner',
      inviter_instance_slug: OWNER,
      signing_key: keys.signing,
      inviter_db: db,
      access: 'write',
      now: () => 1_000,
    })

    const handler = buildTrustedAcceptHandler({
      store,
      db,
      owner_slug: OWNER,
      resolveKey: keys.resolveKey,
      now: () => 2_000,
    })
    // The authenticated cross-instance identity (a DIFFERENT origin instance) is
    // the M2.5 gate — supplied as the validated bearer context.
    const ctx = ctxFor('other-org', 'u-bob')
    const res = await handler(
      ctx,
      new Request('http://connect/x', { method: 'POST', body: JSON.stringify({ invite_token: issued.token, display_name: 'Bob' }) }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: string; local_slug: string; project_id: string }
    expect(body.role).toBe('collaborator')
    expect(body.project_id).toBe(PROJECT_ID)

    // acceptTrustedMember actually ran: a collaborator connected_members row keyed
    // on the AUTHENTICATED cross-instance identity + a project_members origin_instance.
    const member = store.resolveActiveByHomeIdentity('other-org', 'u-bob')
    expect(member).not.toBeNull()
    expect(member!.role).toBe('collaborator')
    expect(member!.access).toBe('write')
    const pm = readProjectMember(db, 'u-bob')
    expect(pm).not.toBeNull()
    expect(pm!.origin_instance).toBe(member!.local_slug)
  })

  test('single-use preserved — a replayed accept 409s', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const keys = await makeKeys()
    const issued = await issueInviteToken({
      workspace_instance_slug: OWNER,
      project_id: PROJECT_ID,
      invitee_email: 'bob@other.org',
      inviter_user_id: 'u-owner',
      inviter_instance_slug: OWNER,
      signing_key: keys.signing,
      inviter_db: db,
      now: () => 1_000,
    })
    const handler = buildTrustedAcceptHandler({ store, db, owner_slug: OWNER, resolveKey: keys.resolveKey, now: () => 2_000 })
    const mk = (): Request =>
      new Request('http://connect/x', { method: 'POST', body: JSON.stringify({ invite_token: issued.token }) })
    const first = await handler(ctxFor('other-org', 'u-bob'), mk())
    expect(first.status).toBe(200)
    const second = await handler(ctxFor('other-org', 'u-bob'), mk())
    expect(second.status).toBe(409)
  })

  test('threads the §1.8 import-on-join seam — a real accept invokes mirrorMemoryOnJoin (B2 fix-pass)', async () => {
    // Spec-conformance: when the mirror seam IS supplied to the MOUNTED handler,
    // a real trusted-accept must actually invoke it with the resolved project +
    // §4 author (the joining collaborator's local_slug + display). Proves the
    // handler → acceptTrustedMember → mirrorMemoryOnJoin plumbing fires. The
    // production composer does not supply it yet (distributed activation gated on
    // the HTTP host-snapshot transport + per-project GBrain scoping — member-join.ts).
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const keys = await makeKeys()
    const issued = await issueInviteToken({
      workspace_instance_slug: OWNER,
      project_id: PROJECT_ID,
      invitee_email: 'dana@other.org',
      inviter_user_id: 'u-owner',
      inviter_instance_slug: OWNER,
      signing_key: keys.signing,
      inviter_db: db,
      access: 'write',
      now: () => 1_000,
    })

    const calls: Array<{ project_id: string; author: { id: string; display: string } }> = []
    const mirror: MirrorMemoryOnJoinFn = async ({ project_id, author }) => {
      calls.push({ project_id, author })
    }
    const handler = buildTrustedAcceptHandler({
      store,
      db,
      owner_slug: OWNER,
      resolveKey: keys.resolveKey,
      mirrorMemoryOnJoin: mirror,
      now: () => 2_000,
    })
    const res = await handler(
      ctxFor('dana-org', 'u-dana'),
      new Request('http://connect/x', {
        method: 'POST',
        body: JSON.stringify({ invite_token: issued.token, display_name: 'Dana' }),
      }),
    )
    expect(res.status).toBe(200)

    const member = store.resolveActiveByHomeIdentity('dana-org', 'u-dana')!
    expect(calls).toHaveLength(1)
    expect(calls[0]!.project_id).toBe(PROJECT_ID)
    expect(calls[0]!.author.id).toBe(member.local_slug)
    expect(calls[0]!.author.display).toBe('Dana')
  })

  test('the owner-chosen read scope rides the invite into the member row', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const keys = await makeKeys()
    const issued = await issueInviteToken({
      workspace_instance_slug: OWNER,
      project_id: PROJECT_ID,
      invitee_email: 'carol@other.org',
      inviter_user_id: 'u-owner',
      inviter_instance_slug: OWNER,
      signing_key: keys.signing,
      inviter_db: db,
      access: 'read',
      now: () => 1_000,
    })
    const handler = buildTrustedAcceptHandler({ store, db, owner_slug: OWNER, resolveKey: keys.resolveKey, now: () => 2_000 })
    const res = await handler(
      ctxFor('carol-org', 'u-carol'),
      new Request('http://connect/x', { method: 'POST', body: JSON.stringify({ invite_token: issued.token }) }),
    )
    expect(res.status).toBe(200)
    const member = store.resolveActiveByHomeIdentity('carol-org', 'u-carol')
    expect(member!.access).toBe('read')
  })
})
