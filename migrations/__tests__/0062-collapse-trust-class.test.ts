/**
 * Migration 0062 acceptance suite — Neutron Connect membership-model collapse
 * (connect-trust-class-collapse-brief; obviates ISSUES #114).
 *
 * Pins the schema-level contract:
 *   1. The `connected_members.trust_class` column is RENAMED to `role` after 0062.
 *   2. The relaxed CHECK accepts ('owner','collaborator') and REJECTS the old
 *      ('trusted','guest') values.
 *   3. Pre-existing rows backfill: trust_class trusted|guest → role 'collaborator';
 *      owner passes through unchanged.
 *   4. All three indexes that existed on the old table (the 0057 partial UNIQUE
 *      active-identity index + the 0055 home_instance and status indexes) survive
 *      the table rebuild.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../runner.ts'

const MIG_0062 = readFileSync(
  new URL('../0062_collapse_connect_trust_class.sql', import.meta.url),
  'utf8',
)

let tmp: string
let db: Database

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-mig-0062-'))
  db = new Database(join(tmp, 'project.db'), { create: true })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Rebuild the PRE-0062 connected_members (trust_class with the old CHECK), so we
 *  can insert legacy trusted/guest rows and then re-run the 0062 SQL by hand —
 *  the same hand-rerun strategy migration 0040's acceptance test uses (the runner
 *  has no public "stop at version N" API). */
function installPre0062Schema(): void {
  applyMigrations(db) // lands the NEW (post-0062) schema
  db.run('DROP TABLE connected_members')
  db.run(`
    CREATE TABLE connected_members (
        local_slug       TEXT PRIMARY KEY,
        display_name     TEXT NOT NULL,
        trust_class      TEXT NOT NULL
                             CHECK (trust_class IN ('owner', 'trusted', 'guest')),
        home_authority   TEXT,
        home_instance_slug TEXT,
        home_user_id     TEXT,
        gbrain_scope     TEXT NOT NULL
                             CHECK (gbrain_scope IN ('admin', 'write', 'read')),
        approved_at      TEXT,
        status           TEXT NOT NULL
                             CHECK (status IN ('pending', 'active', 'revoked'))
    ) STRICT
  `)
}

function insertLegacy(
  slug: string,
  trustClass: string,
  homeOwner: string | null,
  homeUser: string | null,
  status = 'active',
): void {
  db.run(
    `INSERT INTO connected_members
       (local_slug, display_name, trust_class, home_authority, home_instance_slug,
        home_user_id, gbrain_scope, approved_at, status)
     VALUES (?, ?, ?, NULL, ?, ?, 'write', ?, ?)`,
    [slug, slug, trustClass, homeOwner, homeUser, new Date(0).toISOString(), status],
  )
}

test('0062 backfills trusted/guest → collaborator and leaves owner unchanged', () => {
  installPre0062Schema()
  insertLegacy('owner-slug', 'owner', null, null)
  insertLegacy('maria', 'trusted', 'maria-home', 'u-maria')
  insertLegacy('oleg', 'guest', 'oleg', 'guest-1')

  db.exec(MIG_0062)

  const rows = db
    .query<{ local_slug: string; role: string }, []>(
      `SELECT local_slug, role FROM connected_members ORDER BY local_slug`,
    )
    .all()
  expect(rows).toEqual([
    { local_slug: 'maria', role: 'collaborator' },
    { local_slug: 'oleg', role: 'collaborator' },
    { local_slug: 'owner-slug', role: 'owner' },
  ])
})

test('after 0062 the column is named `role`, and `trust_class` no longer exists', () => {
  installPre0062Schema()
  db.exec(MIG_0062)
  const cols = db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('connected_members')`)
    .all()
    .map((c) => c.name)
  expect(cols).toContain('role')
  expect(cols).not.toContain('trust_class')
})

test('the relaxed CHECK accepts collaborator and rejects the old trusted/guest values', () => {
  installPre0062Schema()
  db.exec(MIG_0062)

  // collaborator + owner are accepted
  db.run(
    `INSERT INTO connected_members
       (local_slug, display_name, role, gbrain_scope, status)
     VALUES ('c1', 'C', 'collaborator', 'write', 'active')`,
  )
  db.run(
    `INSERT INTO connected_members
       (local_slug, display_name, role, gbrain_scope, status)
     VALUES ('o1', 'O', 'owner', 'admin', 'active')`,
  )

  for (const stale of ['trusted', 'guest']) {
    expect(() => {
      db.run(
        `INSERT INTO connected_members
           (local_slug, display_name, role, gbrain_scope, status)
         VALUES (?, 'X', ?, 'write', 'active')`,
        [`x-${stale}`, stale],
      )
    }).toThrow(/CHECK constraint/i)
  }
})

test('all three connected_members indexes survive the rebuild', () => {
  installPre0062Schema()
  db.exec(MIG_0062)
  const idx = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='connected_members'`,
    )
    .all()
    .map((r) => r.name)
  expect(idx).toContain('idx_connected_members_active_identity')
  expect(idx).toContain('idx_connected_members_home_instance')
  expect(idx).toContain('idx_connected_members_status')
})

test('the active-identity UNIQUE index still enforces ≤1 active per (home_instance, home_user)', () => {
  installPre0062Schema()
  db.exec(MIG_0062)
  db.run(
    `INSERT INTO connected_members
       (local_slug, display_name, role, home_instance_slug, home_user_id, gbrain_scope, status)
     VALUES ('a', 'A', 'collaborator', 'h', 'u', 'write', 'active')`,
  )
  expect(() => {
    db.run(
      `INSERT INTO connected_members
         (local_slug, display_name, role, home_instance_slug, home_user_id, gbrain_scope, status)
       VALUES ('b', 'B', 'collaborator', 'h', 'u', 'write', 'active')`,
    )
  }).toThrow(/UNIQUE constraint/i)
})

test('a clean (forward) migration run yields the role column with the relaxed CHECK', () => {
  applyMigrations(db)
  const cols = db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('connected_members')`)
    .all()
    .map((c) => c.name)
  expect(cols).toContain('role')
  expect(cols).not.toContain('trust_class')
  // a fresh instance has zero connected_members
  const n = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM connected_members`).get()
  expect(n!.n).toBe(0)
})
