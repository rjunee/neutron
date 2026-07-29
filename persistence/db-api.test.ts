// Unit P1 — ProjectDb API widening (refactor plan § P1).
//
// Focused coverage for the typed convenience layer added so callers stop
// reaching for the `raw()` escape hatch: `get` / `all` (typed reads with
// today's semantics), `runSync` (sync mutation surfacing the driver's
// `{ changes, lastInsertRowid }`), and the opt-in transaction-open assertion
// (`isInTransaction` / `assertInTransaction`).
//
// Also carries the plan-mandated regression test pinning WHY the raw() escape
// hatch is dangerous: a raw() write issued while another caller's async
// transaction is open lands INSIDE that open BEGIN/COMMIT window and shares
// its fate. `runSync` (behavior-identical by contract) shares the pin.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from './db.ts'
import { PersistenceError } from './errors.ts'

let tmp: string
let db: ProjectDb

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-db-api-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)')
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('ProjectDb.get', () => {
  test('returns the first matching row with the full column shape', async () => {
    await db.run('INSERT INTO t (v) VALUES (?)', ['alpha'])
    await db.run('INSERT INTO t (v) VALUES (?)', ['beta'])
    const row = db.get<{ id: number; v: string }, [string]>(
      'SELECT id, v FROM t WHERE v = ?',
      ['beta'],
    )
    expect(row).toEqual({ id: 2, v: 'beta' })
  })

  test('returns null when no row matches', () => {
    const row = db.get<{ id: number }, [string]>('SELECT id FROM t WHERE v = ?', ['missing'])
    expect(row).toBeNull()
  })

  test('params default to none for parameterless SQL', async () => {
    await db.run('INSERT INTO t (v) VALUES (?)', ['only'])
    const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM t')
    expect(row?.n).toBe(1)
  })

  test('binds named parameters (driver semantics preserved)', async () => {
    await db.run('INSERT INTO t (v) VALUES (?)', ['named-target'])
    const row = db.get<{ v: string }>('SELECT v FROM t WHERE v = $v', [
      { $v: 'named-target' },
    ])
    expect(row?.v).toBe('named-target')
  })

  test('throws on invalid SQL', () => {
    expect(() => db.get('SELECT nope FROM does_not_exist')).toThrow()
  })

  test('inside a transaction callback, sees that transaction’s uncommitted writes (same-connection semantics, identical to raw())', async () => {
    await db.transaction((tx) => {
      tx.runSync('INSERT INTO t (v) VALUES (?)', ['uncommitted'])
      const row = tx.get<{ v: string }, [string]>('SELECT v FROM t WHERE v = ?', ['uncommitted'])
      expect(row?.v).toBe('uncommitted')
    })
  })
})

describe('ProjectDb.all', () => {
  test('returns every matching row in order', async () => {
    await db.run('INSERT INTO t (v) VALUES (?)', ['a'])
    await db.run('INSERT INTO t (v) VALUES (?)', ['b'])
    await db.run('INSERT INTO t (v) VALUES (?)', ['c'])
    const rows = db.all<{ id: number; v: string }>('SELECT id, v FROM t ORDER BY id')
    expect(rows).toEqual([
      { id: 1, v: 'a' },
      { id: 2, v: 'b' },
      { id: 3, v: 'c' },
    ])
  })

  test('returns an empty array (not null) when nothing matches', () => {
    const rows = db.all<{ id: number }, [string]>('SELECT id FROM t WHERE v = ?', ['missing'])
    expect(rows).toEqual([])
  })

  test('throws on invalid SQL', () => {
    expect(() => db.all('SELECT * FROM does_not_exist')).toThrow()
  })
})

describe('ProjectDb.runSync', () => {
  test('INSERT returns changes=1 and the new lastInsertRowid', () => {
    const first = db.runSync<[string]>('INSERT INTO t (v) VALUES (?)', ['one'])
    expect(first.changes).toBe(1)
    expect(Number(first.lastInsertRowid)).toBe(1)

    const second = db.runSync<[string]>('INSERT INTO t (v) VALUES (?)', ['two'])
    expect(second.changes).toBe(1)
    expect(Number(second.lastInsertRowid)).toBe(2)
  })

  test('UPDATE reports the number of affected rows — the exact value tx.raw() culture reached for', () => {
    db.runSync('INSERT INTO t (v) VALUES (?)', ['x'])
    db.runSync('INSERT INTO t (v) VALUES (?)', ['x'])
    db.runSync('INSERT INTO t (v) VALUES (?)', ['y'])
    const result = db.runSync<[string, string]>('UPDATE t SET v = ? WHERE v = ?', ['z', 'x'])
    expect(result.changes).toBe(2)
  })

  test('returns changes=0 when the WHERE clause matches nothing (compare-and-swap miss path)', () => {
    const result = db.runSync<[string, number]>('UPDATE t SET v = ? WHERE id = ?', ['nope', 999])
    expect(result.changes).toBe(0)
  })

  test('params default to none for parameterless SQL', () => {
    const result = db.runSync("INSERT INTO t (v) VALUES ('literal')")
    expect(result.changes).toBe(1)
  })

  test('propagates constraint violations (error path)', () => {
    expect(() => db.runSync('INSERT INTO t (v) VALUES (?)', [null as unknown as string])).toThrow(
      /NOT NULL/i,
    )
  })

  test('inside a transaction callback: commits with the transaction', async () => {
    await db.transaction((tx) => {
      const r = tx.runSync<[string]>('INSERT INTO t (v) VALUES (?)', ['tx-committed'])
      expect(r.changes).toBe(1)
    })
    const rows = db.all<{ v: string }>('SELECT v FROM t')
    expect(rows.map((r) => r.v)).toEqual(['tx-committed'])
  })

  test('inside a transaction callback: rolled back when the callback throws', async () => {
    await expect(
      db.transaction((tx) => {
        tx.runSync<[string]>('INSERT INTO t (v) VALUES (?)', ['tx-doomed'])
        throw new Error('forced rollback')
      }),
    ).rejects.toThrow('forced rollback')
    expect(db.all('SELECT v FROM t')).toEqual([])
  })
})

describe('raw()/runSync bypass hazard (plan § P1 regression: unserialized write lands inside a foreign open transaction)', () => {
  // These two tests PIN today's semantics rather than assert desirable ones:
  // a synchronous write issued outside any transaction callback, while
  // another caller's async `transaction()` holds an open BEGIN on this
  // instance, is captured INTO that transaction and dies with its ROLLBACK.
  // `db.run(...)` survives the same scenario (see persistence.test.ts
  // "per-instance mutex" suite) because it queues on the mutex. This is the
  // motivating hazard for the P2 raw() call-site sweep; if either test ever
  // flips, the runSync/raw() contract changed and P2's migration notes must
  // be revisited.

  async function openTxThenSyncWrite(write: () => void): Promise<void> {
    let entered = false
    const txDone = db.transaction(async (tx) => {
      await tx.run('INSERT INTO t (v) VALUES (?)', ['inside-tx-doomed'])
      entered = true
      // Hold the transaction open across event-loop yields so the sync write
      // below demonstrably lands inside the open BEGIN/COMMIT window.
      await Bun.sleep(30)
      throw new Error('forced rollback')
    })
    while (!entered) {
      await Bun.sleep(1)
    }
    write()
    await expect(txDone).rejects.toThrow('forced rollback')
  }

  test('a raw() write during another caller’s open async transaction is wiped by its ROLLBACK', async () => {
    await openTxThenSyncWrite(() => {
      db.raw().run('INSERT INTO t (v) VALUES (?)', ['raw-bypass'])
    })
    // Captured into the rolled-back transaction: nothing survives.
    expect(db.all('SELECT v FROM t')).toEqual([])
  })

  test('runSync shares the hazard (behavior-identical to raw().run by contract)', async () => {
    await openTxThenSyncWrite(() => {
      db.runSync<[string]>('INSERT INTO t (v) VALUES (?)', ['runsync-bypass'])
    })
    expect(db.all('SELECT v FROM t')).toEqual([])
  })
})

describe('ProjectDb.isInTransaction / assertInTransaction', () => {
  test('outside any transaction: isInTransaction is false and the assertion throws PersistenceError naming the operation', () => {
    expect(db.isInTransaction()).toBe(false)
    expect(() => db.assertInTransaction('guest-invite consume')).toThrow(PersistenceError)
    expect(() => db.assertInTransaction('guest-invite consume')).toThrow(
      /guest-invite consume must run inside ProjectDb\.transaction\(\)/,
    )
  })

  test('assertion default message names "this operation"', () => {
    expect(() => db.assertInTransaction()).toThrow(
      /this operation must run inside ProjectDb\.transaction\(\)/,
    )
  })

  test('inside a sync transaction callback: assertion passes', async () => {
    await db.transaction((tx) => {
      expect(tx.isInTransaction()).toBe(true)
      expect(() => tx.assertInTransaction('sync write')).not.toThrow()
    })
  })

  test('inside an async callback the context survives awaits and propagates into helper functions', async () => {
    const helperThatRequiresTx = (): void => {
      db.assertInTransaction('helper write')
    }
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t (v) VALUES (?)', ['before-await'])
      // Post-await: the AsyncLocalStorage context must still be live.
      expect(tx.isInTransaction()).toBe(true)
      expect(helperThatRequiresTx).not.toThrow()
    })
  })

  test('scoped to the callback’s async context, NOT connection-global: a concurrent outside caller still fails the assertion while a transaction is open', async () => {
    let entered = false
    const txDone = db.transaction(async () => {
      entered = true
      await Bun.sleep(30)
    })
    while (!entered) {
      await Bun.sleep(1)
    }
    // The connection has an open BEGIN right now, but THIS call stack is not
    // inside the transaction callback — the assertion must still throw.
    expect(db.isInTransaction()).toBe(false)
    expect(() => db.assertInTransaction('outsider write')).toThrow(PersistenceError)
    await txDone
  })

  test('false again after the transaction resolves', async () => {
    await db.transaction(() => {})
    expect(db.isInTransaction()).toBe(false)
    expect(() => db.assertInTransaction()).toThrow(PersistenceError)
  })
})
