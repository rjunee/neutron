/**
 * M2.6 Ph5 — Codex P1: the in-app revoke must be PROJECT-SCOPED.
 *
 * `ConnectedMembersStore.isProjectMember` is the guard the revoke route uses so
 * an owner of project A cannot revoke a member of project B by slug (the LIFT
 * `revokeMember` is otherwise slug-global). It joins via
 * `project_members.origin_instance = local_slug`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ConnectedMembersStore } from '../connected-members-store.ts'
import { acceptTrustedMember } from '../member-join.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-ph5-scope-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  for (const pid of ['proj-a', 'proj-b']) {
    db.raw().run(
      `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
       VALUES (?, ?, 'workspace', 'personal', ?, ?)`,
      [pid, pid, new Date(0).toISOString(), new Date(0).toISOString()],
    )
  }
  return db
}

describe('Ph5 revoke project-scoping (Codex P1)', () => {
  test('isProjectMember is true only for a member of THAT project', async () => {
    const db = makeDb()
    const store = new ConnectedMembersStore(db)
    const a = await acceptTrustedMember(
      { display_name: 'Alice', home_instance_slug: 'a-org', home_user_id: 'u-a', project_id: 'proj-a', receiving_instance_slug: 'owner' },
      { store, db },
    )
    const b = await acceptTrustedMember(
      { display_name: 'Bob', home_instance_slug: 'b-org', home_user_id: 'u-b', project_id: 'proj-b', receiving_instance_slug: 'owner' },
      { store, db },
    )

    // Each member belongs only to its own project.
    expect(store.isProjectMember('proj-a', a.member.local_slug)).toBe(true)
    expect(store.isProjectMember('proj-b', b.member.local_slug)).toBe(true)
    // Cross-project: owner of proj-a CANNOT see proj-b's member as a proj-a member.
    expect(store.isProjectMember('proj-a', b.member.local_slug)).toBe(false)
    expect(store.isProjectMember('proj-b', a.member.local_slug)).toBe(false)
    // An unknown slug is never a member.
    expect(store.isProjectMember('proj-a', 'ghost')).toBe(false)
  })
})
