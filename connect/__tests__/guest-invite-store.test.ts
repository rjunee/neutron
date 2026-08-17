/**
 * M2.6 Ph3 — ConnectGuestInviteStore: issuance + atomic single-use redemption.
 *
 * Locks brief test #4c (no credential forgery / replay): a replayed invite 409s
 * (already_redeemed), an expired invite is refused, an unknown token is refused —
 * each BEFORE any member write. Also asserts the raw token is NEVER persisted
 * (only its SHA-256 hash), so a DB read cannot leak a usable invite.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { openMigratedDatabaseAt } from '../../tests/support/migrated-db.ts'
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
  const raw = openMigratedDatabaseAt(dbPath)
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

/**
 * ISSUES #421 residual — REVOCATION.
 *
 * Before migration 0110 an invite had two terminal states and the owner drove
 * neither: the guest redeemed it, or the clock passed it. These pin the third —
 * the owner takes it back — at the store level, where the guarantees are
 * (guarded, idempotent, project-scoped, and refused at claim).
 */
describe('ConnectGuestInviteStore — revocation', () => {
  test('revoke marks the invite and reports the state it was in', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({ project_id: 'p1', ttl_ms: 60_000, now: NOW })

    expect(store.getByHash(issued.token_hash)!.revoked_at_ms).toBeNull()
    const r = await store.revoke('p1', issued.token_hash, NOW + 5)
    expect(r).toEqual({ revoked: true, prior_state: 'live' })
    expect(store.getByHash(issued.token_hash)!.revoked_at_ms).toBe(NOW + 5)
  })

  test('revoke is idempotent: the second call is a no-op that does not rewrite the timestamp', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({ project_id: 'p1', ttl_ms: 60_000, now: NOW })

    expect((await store.revoke('p1', issued.token_hash, NOW + 5)).revoked).toBe(true)
    const second = await store.revoke('p1', issued.token_hash, NOW + 900)
    expect(second).toEqual({ revoked: false, prior_state: 'revoked' })
    // The ORIGINAL withdrawal time survives — an audit trail that a re-revoke
    // could overwrite would be worse than none.
    expect(store.getByHash(issued.token_hash)!.revoked_at_ms).toBe(NOW + 5)
  })

  test('revoke is PROJECT-SCOPED: the right id under the wrong project finds nothing', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({ project_id: 'p1', ttl_ms: 60_000, now: NOW })

    expect(await store.revoke('p2', issued.token_hash, NOW + 5)).toEqual({
      revoked: false,
      prior_state: null,
    })
    // Untouched — a wrong-project call must not have side effects.
    expect(store.getByHash(issued.token_hash)!.revoked_at_ms).toBeNull()
    // …and the invite is still claimable.
    await expect(
      db.transaction((tx) => store.claimInTx(tx, issued.token, NOW + 10)),
    ).resolves.toMatchObject({ project_id: 'p1' })
  })

  test('an unknown invite id reports prior_state null, never an error', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    expect(await store.revoke('p1', hashInviteToken('never-issued'), NOW)).toEqual({
      revoked: false,
      prior_state: null,
    })
  })

  test('a REVOKED invite is refused at claim, and refused as `revoked` internally', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({ project_id: 'p1', ttl_ms: 60_000, now: NOW })
    await store.revoke('p1', issued.token_hash, NOW + 5)

    await expect(
      db.transaction((tx) => store.claimInTx(tx, issued.token, NOW + 10)),
    ).rejects.toMatchObject({ reason: 'revoked' })
    // The refusal happened BEFORE any claim — the row is still unredeemed, so
    // nothing downstream (a member insert) could have run.
    expect(store.getByHash(issued.token_hash)!.redeemed_at_ms).toBeNull()
  })

  test('the claim UPDATE refuses a revoked invite even when the pre-check read STALE data (the race)', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({ project_id: 'p1', ttl_ms: 60_000, now: NOW })
    // Capture the row as it looked BEFORE the withdrawal, then withdraw it.
    const stale = store.getByHash(issued.token_hash)!
    await store.revoke('p1', issued.token_hash, NOW + 1)

    // A concurrent revoke that commits between `claimInTx`'s SELECT and its
    // UPDATE is not reproducible on one connection (the ProjectDb mutex holds
    // the BEGIN→COMMIT window), but it IS reachable from a second connection to
    // the same file. Simulate its ONE observable consequence — a pre-check fed a
    // pre-revocation row — by handing `claimInTx` a tx whose read returns the
    // stale row while every write goes to the real, revoked database. If the
    // UPDATE's `revoked_at_ms IS NULL` guard is removed, the claim succeeds and
    // a withdrawn invite mints a member.
    await expect(
      db.transaction(async (tx) => {
        const staleReadingTx = {
          ...tx,
          prepare: () => ({ get: () => stale, all: () => [stale] }),
          runSync: (sql: string, params: unknown[]) =>
            (tx as unknown as { runSync: (s: string, p: unknown[]) => { changes: number } })
              .runSync(sql, params),
        } as unknown as typeof tx
        return store.claimInTx(staleReadingTx, issued.token, NOW + 10)
      }),
    ).rejects.toMatchObject({ reason: 'already_redeemed' })

    // Nothing was claimed — the guard, not the pre-check, is what refused.
    expect(store.getByHash(issued.token_hash)!.redeemed_at_ms).toBeNull()
  })

  test('revoking an already-SPENT invite is allowed and reports `redeemed` as the prior state', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({ project_id: 'p1', ttl_ms: 60_000, now: NOW })
    await db.transaction((tx) => store.claimInTx(tx, issued.token, NOW + 1))

    // An audit act, not an eviction: revoking a spent invite does NOT eject the
    // member it already created (that is `revokeMember`). The caller is told
    // which state it found so it can say something true about it.
    expect(await store.revoke('p1', issued.token_hash, NOW + 5)).toEqual({
      revoked: true,
      prior_state: 'redeemed',
    })
  })
})

describe('ConnectGuestInviteStore — the owner ledger', () => {
  test('listByProject derives each invite state and scopes to the project', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const live = await store.issue({ project_id: 'p1', ttl_ms: 60_000, now: NOW })
    const spent = await store.issue({ project_id: 'p1', ttl_ms: 60_000, now: NOW + 1 })
    const gone = await store.issue({ project_id: 'p1', ttl_ms: 60_000, now: NOW + 2 })
    const aged = await store.issue({ project_id: 'p1', ttl_ms: 1, now: NOW + 3 })
    await store.issue({ project_id: 'p2', ttl_ms: 60_000, now: NOW + 4 })

    await db.transaction((tx) => store.claimInTx(tx, spent.token, NOW + 10))
    await store.revoke('p1', gone.token_hash, NOW + 11)

    const ledger = store.listByProject('p1', NOW + 20)
    expect(ledger.length).toBe(4) // p2's invite is not here
    const byId = new Map(ledger.map((i) => [i.invite_id, i.state]))
    expect(byId.get(live.token_hash)).toBe('live')
    expect(byId.get(spent.token_hash)).toBe('redeemed')
    expect(byId.get(gone.token_hash)).toBe('revoked')
    expect(byId.get(aged.token_hash)).toBe('expired')

    // Newest first, so the invite an owner just minted is the one they see.
    expect(ledger[0]!.invite_id).toBe(aged.token_hash)
    // The ledger never carries a raw token — there is none to carry.
    expect(JSON.stringify(ledger)).not.toContain(live.token)
  })

  test('a revoked-AND-expired invite still reads `revoked` — the owner act outranks the clock', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({ project_id: 'p1', ttl_ms: 60_000, now: NOW })
    await store.revoke('p1', issued.token_hash, NOW + 5)

    expect(store.listByProject('p1', NOW + 999_999)[0]!.state).toBe('revoked')
  })
})
