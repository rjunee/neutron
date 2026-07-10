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
})
