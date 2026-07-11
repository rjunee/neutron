/**
 * P9 — `createGbrainSyncStateStore` (the sole `gbrain_sync_state` writer).
 *
 * Against a real migrated ProjectDb: a publish UPSERTs the one per-scope row; a
 * second publish updates it in place (not a second row); and — the fail-soft
 * guarantee — a publish against a torn-down DB swallows its error rather than
 * throwing back into the sync hook.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { GbrainSyncStateSnapshot } from '@neutronai/gbrain-memory/index.ts'
import { createGbrainSyncStateStore, readGbrainSyncState } from '../gbrain-sync-state-store.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-gbrain-sync-state-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // may already be closed by a test
  }
  rmSync(tmp, { recursive: true, force: true })
})

interface Row {
  scope: string
  status: string
  latch_reason: string | null
  latched_at: string | null
  last_success_at: string | null
  deferred_count: number
  updated_at: string
}

function readRow(scope: string): Row | null {
  return (
    db
      .prepare<Row, [string]>(`SELECT * FROM gbrain_sync_state WHERE scope = ?`)
      .get(scope) ?? null
  )
}

const OK: GbrainSyncStateSnapshot = {
  status: 'ok',
  latchReason: null,
  latchedAt: null,
  lastSuccessAt: '2026-07-09T00:00:00.000Z',
  deferredCount: 2,
}

describe('createGbrainSyncStateStore', () => {
  test('first publish INSERTs the per-scope row verbatim', () => {
    const store = createGbrainSyncStateStore({ db, scope: 'acme' })
    store.publish(OK)
    const row = readRow('acme')
    expect(row).not.toBeNull()
    expect(row!.status).toBe('ok')
    expect(row!.latch_reason).toBeNull()
    expect(row!.last_success_at).toBe('2026-07-09T00:00:00.000Z')
    expect(row!.deferred_count).toBe(2)
    expect(Number.isNaN(Date.parse(row!.updated_at))).toBe(false)
  })

  test('second publish UPSERTs in place (one row per scope, latch fields land)', () => {
    const store = createGbrainSyncStateStore({ db, scope: 'acme' })
    store.publish(OK)
    store.publish({
      status: 'unavailable',
      latchReason: 'gbrain missing',
      latchedAt: '2026-07-09T01:00:00.000Z',
      lastSuccessAt: '2026-07-09T00:00:00.000Z',
      deferredCount: 5,
    })
    const count = db
      .prepare<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM gbrain_sync_state WHERE scope = ?`)
      .get('acme')
    expect(count!.n).toBe(1)
    const row = readRow('acme')!
    expect(row.status).toBe('unavailable')
    expect(row.latch_reason).toBe('gbrain missing')
    expect(row.latched_at).toBe('2026-07-09T01:00:00.000Z')
    expect(row.deferred_count).toBe(5)
  })

  test('distinct scopes get distinct rows', () => {
    createGbrainSyncStateStore({ db, scope: 'acme' }).publish(OK)
    createGbrainSyncStateStore({ db, scope: 'northwind' }).publish(OK)
    const n = db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM gbrain_sync_state`).get()
    expect(n!.n).toBe(2)
  })

  test('readGbrainSyncState round-trips the published row (the diagnostics reader)', () => {
    createGbrainSyncStateStore({ db, scope: 'acme' }).publish({
      status: 'unavailable',
      latchReason: 'gbrain missing',
      latchedAt: '2026-07-09T01:00:00.000Z',
      lastSuccessAt: '2026-07-09T00:00:00.000Z',
      deferredCount: 3,
    })
    const row = readGbrainSyncState({ db, scope: 'acme' })
    expect(row).not.toBeNull()
    expect(row!.status).toBe('unavailable')
    expect(row!.latchReason).toBe('gbrain missing')
    expect(row!.latchedAt).toBe('2026-07-09T01:00:00.000Z')
    expect(row!.lastSuccessAt).toBe('2026-07-09T00:00:00.000Z')
    expect(row!.deferredCount).toBe(3)
    expect(Number.isNaN(Date.parse(row!.updatedAt))).toBe(false)
  })

  test('readGbrainSyncState returns null for a scope never written', () => {
    expect(readGbrainSyncState({ db, scope: 'never' })).toBeNull()
  })

  test('FAIL-SOFT: a publish against a closed DB swallows the error', () => {
    const store = createGbrainSyncStateStore({ db, scope: 'acme' })
    db.close()
    // Must NOT throw — the store is a best-effort diagnostic.
    expect(() => store.publish(OK)).not.toThrow()
  })

  test('MONOTONIC-KEEP: a null lastSuccessAt in a later publish must not clobber a recorded one', () => {
    // Regression for the P9 data-integrity bug: GBrainSyncHook's in-RAM
    // lastSuccessAt starts null on every process restart, so a publish before
    // the first post-restart success (the unavailable-latch trip, or the
    // end-of-write publish after a failed put_page) would otherwise UPSERT
    // last_success_at back to NULL — destroying the durable "worked until
    // <ts>" record in exactly the failure scenario the row exists to
    // diagnose.
    const store = createGbrainSyncStateStore({ db, scope: 'acme' })
    store.publish(OK) // last_success_at = '2026-07-09T00:00:00.000Z'
    store.publish({
      status: 'unavailable',
      latchReason: 'gbrain binary missing',
      latchedAt: '2026-07-10T00:00:00.000Z',
      lastSuccessAt: null, // simulates a fresh-restart hook that never re-succeeded
      deferredCount: 0,
    })
    const row = readRow('acme')!
    // The durable last-known-good timestamp must survive the null publish.
    expect(row.last_success_at).toBe('2026-07-09T00:00:00.000Z')
    // Non-monotonic fields DO reflect the latest snapshot verbatim (per-incident
    // fields are correctly overwritten, not preserved).
    expect(row.status).toBe('unavailable')
    expect(row.latch_reason).toBe('gbrain binary missing')
    expect(row.latched_at).toBe('2026-07-10T00:00:00.000Z')

    // A REAL new success (non-null lastSuccessAt) still supersedes the old one.
    store.publish({
      status: 'ok',
      latchReason: null,
      latchedAt: null,
      lastSuccessAt: '2026-07-10T01:00:00.000Z',
      deferredCount: 0,
    })
    const row2 = readRow('acme')!
    expect(row2.last_success_at).toBe('2026-07-10T01:00:00.000Z')
  })

  test('MONOTONIC-KEEP: an OLDER non-null publish must not regress a NEWER durable timestamp', () => {
    // Inverse boundary of the null case: last_success_at only ever moves
    // forward. Even if some code path published an older non-null timestamp
    // (a stale in-RAM value, clock skew, a re-derived guess), it must NOT
    // overwrite a newer durable one — the sink keeps the LATER of the two.
    const store = createGbrainSyncStateStore({ db, scope: 'acme' })
    store.publish({
      status: 'ok',
      latchReason: null,
      latchedAt: null,
      lastSuccessAt: '2026-07-10T12:00:00.000Z', // newer, durable
      deferredCount: 0,
    })
    store.publish({
      status: 'ok',
      latchReason: null,
      latchedAt: null,
      lastSuccessAt: '2026-07-10T06:00:00.000Z', // OLDER — must be ignored
      deferredCount: 1,
    })
    const row = readRow('acme')!
    // The newer timestamp survives the older publish.
    expect(row.last_success_at).toBe('2026-07-10T12:00:00.000Z')
    // Other fields still reflect the latest snapshot verbatim.
    expect(row.deferred_count).toBe(1)
  })

  test('MONOTONIC-KEEP: a first-ever publish with null lastSuccessAt persists null (valid pre-success state)', () => {
    // Before any success has ever happened (e.g. gbrain missing from the very
    // first entity write on a fresh host), the row must record null — the
    // honest "never succeeded" state — not spuriously invent a timestamp. Both
    // sides of the merge are null → the result is null.
    const store = createGbrainSyncStateStore({ db, scope: 'acme' })
    store.publish({
      status: 'unavailable',
      latchReason: 'gbrain binary missing',
      latchedAt: '2026-07-10T00:00:00.000Z',
      lastSuccessAt: null,
      deferredCount: 0,
    })
    const row = readRow('acme')!
    expect(row.last_success_at).toBeNull()
    expect(row.status).toBe('unavailable')
    expect(row.latch_reason).toBe('gbrain binary missing')
  })
})
