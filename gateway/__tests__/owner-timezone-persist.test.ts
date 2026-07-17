/**
 * ISSUES #40 (owner-timezone WRITE path) — unit coverage for the server-side
 * validate + de-dupe + persist chokepoint the app-ws surface calls when a client
 * reports its IANA zone on connect.
 *
 * Mutation-kill contract:
 *   (a) a real IANA zone is validated + persisted; garbage is REJECTED and never
 *       written (fail-closed — the stored zone is left untouched).
 *   (b) an unchanged zone is a no-op — NO redundant write (a reconnecting client
 *       reporting the same zone every open must not churn the row).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  isValidIanaTimezone,
  persistOwnerTimezoneIfChanged,
  readOwnerTimezone,
} from '../storage/owner-metadata.ts'

interface Harness {
  db: ProjectDb
  /** Count of underlying `db.run` (write) calls since the spy was installed. */
  writeCount: () => number
  close(): void
}

function openHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-owner-tz-persist-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  // Count only WRITES — `readOwnerTimezone` goes through `db.prepare`, so this
  // isolates the upsert path for the "no redundant write" assertion.
  let writes = 0
  const origRun = db.run.bind(db)
  ;(db as unknown as { run: ProjectDb['run'] }).run = (async (
    ...args: Parameters<ProjectDb['run']>
  ) => {
    writes += 1
    return origRun(...args)
  }) as ProjectDb['run']
  return {
    db,
    writeCount: () => writes,
    close: () => {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

describe('isValidIanaTimezone', () => {
  test('accepts real IANA identifiers', () => {
    expect(isValidIanaTimezone('America/New_York')).toBe(true)
    expect(isValidIanaTimezone('America/Los_Angeles')).toBe(true)
    expect(isValidIanaTimezone('Asia/Singapore')).toBe(true)
    expect(isValidIanaTimezone('UTC')).toBe(true)
    expect(isValidIanaTimezone('Etc/GMT+5')).toBe(true)
  })

  test('rejects garbage / unknown / non-string', () => {
    expect(isValidIanaTimezone('Not/AZone')).toBe(false)
    expect(isValidIanaTimezone('America/Fake_City')).toBe(false)
    expect(isValidIanaTimezone('UTC; DROP TABLE instance_metadata')).toBe(false)
    expect(isValidIanaTimezone('')).toBe(false)
    expect(isValidIanaTimezone('x'.repeat(65))).toBe(false)
    expect(isValidIanaTimezone(null)).toBe(false)
    expect(isValidIanaTimezone(undefined)).toBe(false)
    expect(isValidIanaTimezone(42)).toBe(false)
  })
})

describe('persistOwnerTimezoneIfChanged', () => {
  let h: Harness
  beforeEach(() => {
    h = openHarness()
  })
  afterEach(() => {
    h.close()
  })

  test('(a) a valid IANA zone is validated + persisted', async () => {
    expect(await persistOwnerTimezoneIfChanged(h.db, 'owner', 'America/New_York')).toBe(
      'written',
    )
    expect(readOwnerTimezone(h.db, 'owner')).toBe('America/New_York')
    expect(h.writeCount()).toBe(1)
  })

  test('(a) garbage is REJECTED and never written', async () => {
    expect(await persistOwnerTimezoneIfChanged(h.db, 'owner', 'Not/AZone')).toBe('invalid')
    // Fail-closed: nothing was written, so the read still resolves to null (→ the
    // nudge keeps its LA default rather than a poison zone).
    expect(readOwnerTimezone(h.db, 'owner')).toBeNull()
    expect(h.writeCount()).toBe(0)
  })

  test('(a) garbage does NOT clobber an already-persisted zone', async () => {
    await persistOwnerTimezoneIfChanged(h.db, 'owner', 'America/New_York')
    expect(await persistOwnerTimezoneIfChanged(h.db, 'owner', 'Bogus/Zone')).toBe('invalid')
    // The valid zone survives — a broken client can't corrupt it.
    expect(readOwnerTimezone(h.db, 'owner')).toBe('America/New_York')
  })

  test('(b) an unchanged zone is a no-op — NO redundant write', async () => {
    expect(await persistOwnerTimezoneIfChanged(h.db, 'owner', 'America/New_York')).toBe(
      'written',
    )
    expect(h.writeCount()).toBe(1)
    // Same zone reported again (reconnect) → deduped, no second upsert.
    expect(await persistOwnerTimezoneIfChanged(h.db, 'owner', 'America/New_York')).toBe(
      'unchanged',
    )
    expect(await persistOwnerTimezoneIfChanged(h.db, 'owner', 'America/New_York')).toBe(
      'unchanged',
    )
    expect(h.writeCount()).toBe(1)
  })

  test('a genuinely changed zone DOES write again', async () => {
    await persistOwnerTimezoneIfChanged(h.db, 'owner', 'America/New_York')
    expect(await persistOwnerTimezoneIfChanged(h.db, 'owner', 'Asia/Singapore')).toBe(
      'written',
    )
    expect(readOwnerTimezone(h.db, 'owner')).toBe('Asia/Singapore')
    expect(h.writeCount()).toBe(2)
  })

  test('the write keys on the passed owner slug (per-owner isolation)', async () => {
    await persistOwnerTimezoneIfChanged(h.db, 'owner-a', 'America/New_York')
    await persistOwnerTimezoneIfChanged(h.db, 'owner-b', 'Asia/Singapore')
    expect(readOwnerTimezone(h.db, 'owner-a')).toBe('America/New_York')
    expect(readOwnerTimezone(h.db, 'owner-b')).toBe('Asia/Singapore')
  })
})
