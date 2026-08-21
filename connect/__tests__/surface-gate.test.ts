/**
 * Connect SURFACE STATE GATE semantics (ISSUES #421).
 *
 * The mount-level, served-over-HTTP proof lives in
 * `open/__tests__/open-connect-served.test.ts`. This file pins the predicate
 * itself against real rows, case by case, so the exact meaning of "open" is
 * legible and a change to it has to be deliberate.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import { buildConnectSurfaceGate, connectSurfaceIsOpen } from '../surface-gate.ts'

const NOW = 1_800_000_000_000

let dir: string
let db: ProjectDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'connect-surface-gate-'))
  seedMigratedDb(join(dir, 'owner.db'))
  db = ProjectDb.open(join(dir, 'owner.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function insertInvite(opts: {
  hash: string
  expiresAtMs: number
  redeemedAtMs?: number | null
}): void {
  db.runSync(
    `INSERT INTO connect_guest_invites
       (token_hash, project_id, display_name_hint, access,
        created_at_ms, expires_at_ms, redeemed_at_ms, redeemed_by_slug)
     VALUES (?, 'proj-1', NULL, 'write', ?, ?, ?, NULL)`,
    [opts.hash, NOW - 1000, opts.expiresAtMs, opts.redeemedAtMs ?? null],
  )
}

function insertMember(opts: {
  slug: string
  status: 'pending' | 'active' | 'revoked'
  homeInstanceSlug?: string | null
}): void {
  db.runSync(
    `INSERT INTO connected_members
       (local_slug, display_name, role, home_authority, home_instance_slug,
        home_user_id, access, approved_at, status)
     VALUES (?, 'Someone', 'collaborator', 'guest.example.com', ?, ?, 'write', ?, ?)`,
    [
      opts.slug,
      opts.homeInstanceSlug === undefined ? 'guest.example.com' : opts.homeInstanceSlug,
      // (home_instance_slug, home_user_id) is UNIQUE — a distinct user per row.
      `u-${opts.slug}`,
      new Date(NOW).toISOString(),
      opts.status,
    ],
  )
}

describe('connectSurfaceIsOpen', () => {
  test('a fresh install is CLOSED', () => {
    expect(connectSurfaceIsOpen(db, NOW)).toBe(false)
  })

  test('a LIVE invite OPENS it — the owner deliberately opening the door', () => {
    insertInvite({ hash: 'a'.repeat(64), expiresAtMs: NOW + 60_000 })
    expect(connectSurfaceIsOpen(db, NOW)).toBe(true)
  })

  test('an EXPIRED invite does NOT open it', () => {
    insertInvite({ hash: 'b'.repeat(64), expiresAtMs: NOW - 1 })
    expect(connectSurfaceIsOpen(db, NOW)).toBe(false)
  })

  test('a REDEEMED invite alone does NOT open it — but the member it admitted DOES', () => {
    // Redemption consumes the invite. If (1) were the only condition, the
    // handshake would close the door on the guest it had just let in.
    insertInvite({ hash: 'c'.repeat(64), expiresAtMs: NOW + 60_000, redeemedAtMs: NOW })
    expect(connectSurfaceIsOpen(db, NOW)).toBe(false)

    insertMember({ slug: 'guest-1', status: 'active' })
    expect(connectSurfaceIsOpen(db, NOW)).toBe(true)
  })

  test('a PENDING member keeps it open; a REVOKED one does not', () => {
    insertMember({ slug: 'pending-1', status: 'pending' })
    expect(connectSurfaceIsOpen(db, NOW)).toBe(true)

    db.runSync(`UPDATE connected_members SET status = 'revoked' WHERE local_slug = ?`, [
      'pending-1',
    ])
    expect(connectSurfaceIsOpen(db, NOW)).toBe(false)
  })

  test('revoking the LAST member closes it again — the gate is a two-way door', () => {
    insertMember({ slug: 'guest-1', status: 'active' })
    insertMember({ slug: 'guest-2', status: 'active' })
    expect(connectSurfaceIsOpen(db, NOW)).toBe(true)

    db.runSync(`UPDATE connected_members SET status = 'revoked' WHERE local_slug = 'guest-1'`)
    expect(connectSurfaceIsOpen(db, NOW)).toBe(true) // guest-2 still holds it open

    db.runSync(`UPDATE connected_members SET status = 'revoked' WHERE local_slug = 'guest-2'`)
    expect(connectSurfaceIsOpen(db, NOW)).toBe(false)
  })

  test('an OWNER row (NULL home_instance_slug) never holds the door open on its own', () => {
    // An owner row is local bookkeeping, not somebody dialling in from outside.
    // If it counted, every install would be permanently open.
    insertMember({ slug: 'owner', status: 'active', homeInstanceSlug: null })
    expect(connectSurfaceIsOpen(db, NOW)).toBe(false)
  })

  test('an unreadable / pre-migration DB FAILS CLOSED', () => {
    const closed = ProjectDb.open(join(dir, 'no-migrations.db'))
    try {
      // Tables absent → the probe throws → CLOSED, never open-by-accident.
      expect(connectSurfaceIsOpen(closed, NOW)).toBe(false)
    } finally {
      closed.close()
    }
  })
})

describe('buildConnectSurfaceGate', () => {
  test('re-reads state on EVERY call — never latched at construction', () => {
    // This is what makes "create your first invite and it works, no restart"
    // true. A gate that cached its answer at build time would report closed
    // forever on an install that started empty.
    const gate = buildConnectSurfaceGate({ db, now: () => NOW })
    expect(gate.isOpen()).toBe(false)

    insertInvite({ hash: 'd'.repeat(64), expiresAtMs: NOW + 60_000 })
    expect(gate.isOpen()).toBe(true)

    db.runSync(`DELETE FROM connect_guest_invites`)
    expect(gate.isOpen()).toBe(false)
  })

  test('honours the injected clock, so an invite lapses without a restart', () => {
    let clock = NOW
    const gate = buildConnectSurfaceGate({ db, now: () => clock })
    insertInvite({ hash: 'e'.repeat(64), expiresAtMs: NOW + 10_000 })
    expect(gate.isOpen()).toBe(true)

    clock = NOW + 10_001
    expect(gate.isOpen()).toBe(false)
  })
})
