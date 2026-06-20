/**
 * M2.6 Ph3 — ConnectGuestInviteStore: issuance + atomic single-use redemption.
 *
 * Locks brief test #4c (no credential forgery / replay): a replayed invite 409s
 * (already_redeemed), an expired invite is refused, an unknown token is refused —
 * each BEFORE any member write. Also asserts the raw token is NEVER persisted
 * (only its SHA-256 hash), so a DB read cannot leak a usable invite.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import {
  ConnectGuestInviteStore,
  GuestInviteError,
  hashInviteToken,
} from '../guest-invite-store.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

const NOW = 1_700_000_000_000

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-guest-invite-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  return db
}

describe('ConnectGuestInviteStore — issuance', () => {
  test('issue persists ONLY the token hash, never the raw token', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({
      project_id: 'p-1',
      ttl_ms: 60_000,
      now: NOW,
    })
    expect(issued.token.length).toBeGreaterThan(20)
    expect(issued.expires_at_ms).toBe(NOW + 60_000)

    // The raw token string never appears in the DB; the stored key is its hash.
    const rows = db
      .raw()
      .query<{ token_hash: string }, []>(`SELECT token_hash FROM connect_guest_invites`)
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token_hash).toBe(hashInviteToken(issued.token))
    expect(rows[0]!.token_hash).not.toBe(issued.token)
    expect(store.getByHash(issued.token_hash)!.project_id).toBe('p-1')
    expect(store.getByHash(issued.token_hash)!.access).toBe('write')
  })
})

describe('ConnectGuestInviteStore — atomic single-use claim (brief test #4c)', () => {
  test('a valid invite claims once; a replay 409s (already_redeemed)', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({ project_id: 'p-1', ttl_ms: 60_000, now: NOW })

    const claim = await db.transaction((tx) =>
      store.claimInTx(tx, issued.token, NOW + 1_000),
    )
    expect(claim.project_id).toBe('p-1')
    expect(claim.access).toBe('write')

    // Replay → already_redeemed (single-use). No second claim.
    await expect(
      db.transaction((tx) => store.claimInTx(tx, issued.token, NOW + 2_000)),
    ).rejects.toMatchObject({ name: 'GuestInviteError', reason: 'already_redeemed' })

    // redeemed_at_ms is set; the row is spent.
    const row = store.getByHash(issued.token_hash)!
    expect(row.redeemed_at_ms).not.toBeNull()
  })

  test('an expired invite is refused (no claim)', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({ project_id: 'p-1', ttl_ms: 60_000, now: NOW })
    await expect(
      db.transaction((tx) => store.claimInTx(tx, issued.token, NOW + 60_001)),
    ).rejects.toMatchObject({ reason: 'expired' })
    // Still unredeemed (the expiry path never claims).
    expect(store.getByHash(issued.token_hash)!.redeemed_at_ms).toBeNull()
  })

  test('an unknown token is refused (not_found)', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    await expect(
      db.transaction((tx) => store.claimInTx(tx, 'never-issued', NOW)),
    ).rejects.toMatchObject({ reason: 'not_found' })
  })

  test('GuestInviteError carries a machine-readable reason', () => {
    const e = new GuestInviteError('expired')
    expect(e.name).toBe('GuestInviteError')
    expect(e.reason).toBe('expired')
  })
})
