import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from './db.ts'
import { BusyRetryExhaustedError, PersistenceError } from './errors.ts'
import {
  WRITE_MAX_RETRIES,
  WRITE_RETRY_MAX_MS,
  WRITE_RETRY_MIN_MS,
  isBusyError,
  withBusyRetry,
} from './retry.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-persistence-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('ProjectDb open + close', () => {
  test('open creates the file when create=true (default) and round-trips a write', async () => {
    const path = join(tmp, 'owner.db')
    expect(existsSync(path)).toBe(false)
    const db = ProjectDb.open(path)
    try {
      await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      await db.run('INSERT INTO t (v) VALUES (?)', ['hello'])
      const row = db.prepare<{ v: string }, []>('SELECT v FROM t LIMIT 1').get()
      expect(row?.v).toBe('hello')
    } finally {
      db.close()
    }
    expect(existsSync(path)).toBe(true)
  })

  test('open throws PersistenceError when path is unreachable', () => {
    expect(() => ProjectDb.open('/nonexistent-dir/owner.db', { create: false })).toThrow(
      PersistenceError,
    )
  })

  test('close + re-open returns a working connection on the same file', async () => {
    const path = join(tmp, 'owner.db')
    const a = ProjectDb.open(path)
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    await a.run('INSERT INTO t (v) VALUES (?)', ['first'])
    a.close()

    const b = ProjectDb.open(path)
    try {
      const row = b.prepare<{ v: string }, []>('SELECT v FROM t LIMIT 1').get()
      expect(row?.v).toBe('first')
    } finally {
      b.close()
    }
  })
})

describe('ProjectDb startup PRAGMAs', () => {
  test('journal_mode is wal', () => {
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      expect(String(db.pragma('journal_mode'))).toBe('wal')
    } finally {
      db.close()
    }
  })

  test('foreign_keys is enabled', () => {
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      expect(db.pragma('foreign_keys')).toBe(1)
    } finally {
      db.close()
    }
  })

  test('synchronous is NORMAL (1)', () => {
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      expect(db.pragma('synchronous')).toBe(1)
    } finally {
      db.close()
    }
  })

  test('busy_timeout is 100ms (tightened from Hermes 1000ms — see retry.ts comment)', () => {
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      expect(db.pragma('busy_timeout')).toBe(100)
    } finally {
      db.close()
    }
  })

  test('FK enforcement actually rejects orphan rows', async () => {
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      await db.exec(`
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE
        );
      `)
      await expect(db.run('INSERT INTO children (parent_id) VALUES (?)', [42])).rejects.toThrow(
        /FOREIGN KEY/i,
      )
    } finally {
      db.close()
    }
  })
})

describe('ProjectDb transaction', () => {
  test('commits on success (sync callback)', async () => {
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      const result = await db.transaction((tx) => {
        // Use the raw connection for sync writes inside the sync callback;
        // the busy-retry layer is owned by the outer transaction wrapper here.
        tx.raw().run('INSERT INTO t (v) VALUES (?)', ['a'])
        tx.raw().run('INSERT INTO t (v) VALUES (?)', ['b'])
        return 42
      })
      expect(result).toBe(42)
      const rows = db.prepare<{ v: string }, []>('SELECT v FROM t ORDER BY id').all()
      expect(rows.map((r) => r.v)).toEqual(['a', 'b'])
    } finally {
      db.close()
    }
  })

  test('commits on success (async callback)', async () => {
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      const result = await db.transaction(async (tx) => {
        await tx.run('INSERT INTO t (v) VALUES (?)', ['async-a'])
        await tx.run('INSERT INTO t (v) VALUES (?)', ['async-b'])
        return 'done'
      })
      expect(result).toBe('done')
      const rows = db.prepare<{ v: string }, []>('SELECT v FROM t ORDER BY id').all()
      expect(rows.map((r) => r.v)).toEqual(['async-a', 'async-b'])
    } finally {
      db.close()
    }
  })

  test('rolls back on throw', async () => {
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      await db.run('INSERT INTO t (v) VALUES (?)', ['pre'])

      await expect(
        db.transaction((tx) => {
          tx.raw().run('INSERT INTO t (v) VALUES (?)', ['mid'])
          throw new Error('fail')
        }),
      ).rejects.toThrow('fail')

      const rows = db.prepare<{ v: string }, []>('SELECT v FROM t ORDER BY id').all()
      expect(rows.map((r) => r.v)).toEqual(['pre'])
    } finally {
      db.close()
    }
  })
})

describe('isBusyError', () => {
  test('matches SQLITE_BUSY messages', () => {
    expect(isBusyError(new Error('SQLITE_BUSY: database is locked'))).toBe(true)
    expect(isBusyError(new Error('database is locked'))).toBe(true)
    expect(isBusyError(new Error('disk full'))).toBe(false)
    expect(isBusyError(null)).toBe(false)
    expect(isBusyError(undefined)).toBe(false)
    expect(isBusyError({})).toBe(false)
  })

  test('explicitly rejects BusyRetryExhaustedError so transactions do not double-retry', () => {
    // The exhaustion wrapper's `.message` contains "SQLITE_BUSY: exhausted N
    // retries" — without the instanceof guard the outer withBusyRetry around a
    // transaction would re-run the body up to 15 more times. See retry.ts
    // `isBusyError` comment for the bug Codex flagged.
    const exhausted = new BusyRetryExhaustedError(15, new Error('SQLITE_BUSY: locked'))
    expect(exhausted.message.includes('SQLITE_BUSY')).toBe(true)
    expect(isBusyError(exhausted)).toBe(false)
  })
})

describe('withBusyRetry jitter', () => {
  test('returns immediately on first success', async () => {
    let calls = 0
    const result = await withBusyRetry(() => {
      calls++
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  test('retries on busy then succeeds', async () => {
    let calls = 0
    const result = await withBusyRetry(() => {
      calls++
      if (calls < 3) {
        throw new Error('SQLITE_BUSY: database is locked')
      }
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  test('non-busy errors propagate immediately', async () => {
    let calls = 0
    await expect(
      withBusyRetry(() => {
        calls++
        throw new Error('disk full')
      }),
    ).rejects.toThrow('disk full')
    expect(calls).toBe(1)
  })

  test('throws BusyRetryExhaustedError after WRITE_MAX_RETRIES', async () => {
    let calls = 0
    let caught: unknown = undefined
    try {
      await withBusyRetry(() => {
        calls++
        throw new Error('SQLITE_BUSY: database is locked')
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BusyRetryExhaustedError)
    expect(calls).toBe(WRITE_MAX_RETRIES + 1)
  })

  test('yields to the event loop between retries (timer can fire during a contention window)', async () => {
    // Watchdog-starvation regression: with `Bun.sleepSync` the event loop is
    // blocked during the entire retry, so a setInterval-driven watchdog tick
    // cannot fire. With `await Bun.sleep` (the current implementation), the
    // tick lands during one of the awaits between attempts.
    let tickCount = 0
    const ticker = setInterval(() => {
      tickCount++
    }, 10)
    try {
      let calls = 0
      const result = await withBusyRetry(() => {
        calls++
        if (calls < 5) {
          throw new Error('SQLITE_BUSY: database is locked')
        }
        return 'ok'
      })
      expect(result).toBe('ok')
      expect(calls).toBe(5)
      // 4 sleeps × ≥20 ms minimum = ≥80 ms wall time → ≥8 ticker fires of 10 ms.
      // Looser bound to absorb scheduler jitter on busy CI hosts.
      expect(tickCount).toBeGreaterThanOrEqual(2)
    } finally {
      clearInterval(ticker)
    }
  })

  test('constants reflect the watchdog-aware tuning', () => {
    expect(WRITE_RETRY_MIN_MS).toBe(20)
    expect(WRITE_RETRY_MAX_MS).toBe(100)
    expect(WRITE_MAX_RETRIES).toBe(15)
  })
})

describe('cross-process lock contention', () => {
  test('busy-retry succeeds when a contender process holds then releases an EXCLUSIVE lock', async () => {
    // Real cross-process contention drives the jittered-retry design: while the
    // child process holds BEGIN EXCLUSIVE, a write from the parent's ProjectDb hits
    // SQLITE_BUSY; the parent's app-level retry loop kicks in, the child commits
    // ~120 ms later, the next retry succeeds. The contender lives in a separate
    // OS process so it makes progress even while the parent's loop calls
    // `Bun.sleepSync` between attempts (an in-process setTimeout would not — that
    // blocks the event loop and never fires until the retry loop ends).
    //
    // Notes on the contender's PRAGMAs: WAL mode is required because the parent's
    // ProjectDb opens with WAL and SQLite returns SQLITE_BUSY to writers when the
    // file's journal_mode mismatches between connections. The child's busy_timeout
    // is set high (5000 ms) so the child itself tolerates parent-side contention
    // without aborting before its scheduled COMMIT.
    const path = join(tmp, 'owner.db')
    const setup = ProjectDb.open(path)
    await setup.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    setup.close()

    const childScript = `
import { Database } from 'bun:sqlite'
const db = new Database(${JSON.stringify(path)})
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 5000')
db.exec('BEGIN EXCLUSIVE')
db.run('INSERT INTO t (v) VALUES (?)', ['from-child'])
process.stdout.write('locked\\n')
await Bun.sleep(120)
db.exec('COMMIT')
db.close()
`
    const child = Bun.spawn({
      cmd: ['bun', '-e', childScript],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    // Read until we see "locked\n" so we know the child has the EXCLUSIVE lock
    // before the parent attempts to write.
    const reader = child.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (!buf.includes('locked\n')) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value)
    }
    expect(buf.includes('locked\n')).toBe(true)
    void reader.cancel()

    const parent = ProjectDb.open(path)
    let attempts = 0
    try {
      await withBusyRetry(() => {
        attempts++
        // Use the raw connection directly so the busy-throw bubbles into the
        // outer withBusyRetry — ProjectDb.run wraps with its own retry layer.
        parent.raw().run('INSERT INTO t (v) VALUES (?)', ['from-parent'])
      })
    } finally {
      parent.close()
    }

    expect(attempts).toBeGreaterThanOrEqual(1)
    await child.exited
    expect(child.exitCode).toBe(0)

    const verify = ProjectDb.open(path, { readonly: true })
    try {
      const rows = verify
        .prepare<{ v: string }, []>('SELECT v FROM t ORDER BY id')
        .all()
        .map((r) => r.v)
      expect(rows).toEqual(['from-child', 'from-parent'])
    } finally {
      verify.close()
    }
  }, 30_000)
})

describe('per-instance mutex (transaction isolation)', () => {
  test('async transaction holds the lock — a concurrent run does not leak into the open BEGIN/COMMIT window', async () => {
    // BLOCKING #1 regression test (Argus r1, 2026-04-27): without a per-instance
    // mutex, a `db.run` issued while an async `transaction` is mid-flight would
    // run on the shared `bun:sqlite` connection between the transaction's BEGIN
    // and COMMIT — i.e. it would be captured INTO the transaction. Proof
    // strategy: start a transaction that awaits, then ROLLBACKs (via a throw);
    // a concurrent `run` issued during the await must SURVIVE the rollback.
    // Without the mutex, the concurrent INSERT lands inside the open BEGIN and
    // is wiped out by the ROLLBACK; with the mutex, it queues until after the
    // ROLLBACK completes and survives.
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')

      const txDone = db.transaction(async (tx) => {
        await tx.run('INSERT INTO t (v) VALUES (?)', ['inside-tx-doomed'])
        // 50 ms gives the queued concurrent run plenty of opportunity to land
        // INSIDE the open transaction if the mutex isn't holding.
        await Bun.sleep(50)
        throw new Error('forced rollback')
      })

      const concurrentDone = db.run('INSERT INTO t (v) VALUES (?)', ['concurrent-survivor'])

      await expect(txDone).rejects.toThrow('forced rollback')
      await concurrentDone

      const rows = db.prepare<{ v: string }, []>('SELECT v FROM t ORDER BY id').all()
      // Mutex held: only the survivor remains; the rolled-back tx insert is gone.
      // Mutex absent: both inserts get rolled back together → empty rows → fail.
      expect(rows.map((r) => r.v)).toEqual(['concurrent-survivor'])
    } finally {
      db.close()
    }
  })

  test('async transaction holds the lock — a concurrent exec does not leak into the open BEGIN/COMMIT window', async () => {
    // Same proof strategy as the run() variant above, but the concurrent caller
    // uses `exec` (DDL-shaped path) rather than `run`. Both methods route
    // through the same mutex; this test pins exec's serialization separately
    // so a future change that splits the lock between the two methods is
    // caught.
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')

      const txDone = db.transaction(async (tx) => {
        await tx.run('INSERT INTO t (v) VALUES (?)', ['inside-tx-doomed'])
        await Bun.sleep(50)
        throw new Error('forced rollback')
      })

      const concurrentDone = db.exec("INSERT INTO t (v) VALUES ('concurrent-via-exec')")

      await expect(txDone).rejects.toThrow('forced rollback')
      await concurrentDone

      const rows = db.prepare<{ v: string }, []>('SELECT v FROM t ORDER BY id').all()
      expect(rows.map((r) => r.v)).toEqual(['concurrent-via-exec'])
    } finally {
      db.close()
    }
  })

  test('a queued caller does not lose its rejection when an earlier caller fails', async () => {
    // Mutex chain hygiene: if call A throws, call B (queued behind A) must
    // still resolve normally. The mutex tail uses a swallowing `.catch` so A's
    // rejection does NOT cascade as B's rejection.
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      const failingTx = db.transaction(async () => {
        throw new Error('A failed')
      })
      const queuedRun = db.run('INSERT INTO t (v) VALUES (?)', ['B-after-A'])

      await expect(failingTx).rejects.toThrow('A failed')
      await queuedRun
      const rows = db.prepare<{ v: string }, []>('SELECT v FROM t').all()
      expect(rows.map((r) => r.v)).toEqual(['B-after-A'])
    } finally {
      db.close()
    }
  })
})

describe('transaction COMMIT-failure rollback', () => {
  test('COMMIT failure runs ROLLBACK and rethrows the COMMIT error — connection is not stuck in an open tx', async () => {
    // IMPORTANT #2 regression test (Argus r1, 2026-04-27): the prior
    // implementation's async branch ran COMMIT outside the try/catch, so a
    // COMMIT throw rejected the promise without ROLLBACK — leaving the shared
    // bun:sqlite connection stuck in an open transaction. The fix wraps COMMIT
    // in its own try/catch + withBusyRetry, calling ROLLBACK on failure before
    // rethrowing.
    //
    // Test strategy: monkey-patch `Database.exec` for one call to throw on
    // COMMIT, observe ROLLBACK fires, then prove the connection is usable
    // again (a follow-up `run` would itself fail with "cannot start a
    // transaction within a transaction" if we hadn't rolled back).
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')

      const raw = db.raw()
      const realExec = raw.exec.bind(raw)
      let rollbackFired = false
      let commitAttempts = 0
      raw.exec = ((sql: string) => {
        if (sql === 'COMMIT') {
          commitAttempts++
          // Throw a non-busy error so withBusyRetry surfaces it on the first
          // attempt rather than burning the retry budget; we want to assert
          // that the rollback runs even on a hard failure.
          throw new Error('SQLITE_FULL: simulated disk-full at COMMIT')
        }
        if (sql === 'ROLLBACK') {
          rollbackFired = true
        }
        return realExec(sql)
      }) as typeof raw.exec

      try {
        await expect(
          db.transaction(async (tx) => {
            await tx.run('INSERT INTO t (v) VALUES (?)', ['mid-tx'])
            return 'unused'
          }),
        ).rejects.toThrow(/SQLITE_FULL/)

        expect(commitAttempts).toBe(1)
        expect(rollbackFired).toBe(true)
      } finally {
        // Restore the bare exec before the next assertion so the rollback /
        // follow-up writes use the real implementation.
        raw.exec = realExec
      }

      // Connection is not stuck — a subsequent run must succeed cleanly. With
      // the bug, this would fail with "cannot start a transaction within a
      // transaction" (BEGIN throws because the first BEGIN never closed) or
      // hang under the retry loop.
      await db.run('INSERT INTO t (v) VALUES (?)', ['after-commit-failure'])
      const rows = db.prepare<{ v: string }, []>('SELECT v FROM t ORDER BY id').all()
      // The mid-tx insert was rolled back; only the post-recovery insert remains.
      expect(rows.map((r) => r.v)).toEqual(['after-commit-failure'])
    } finally {
      db.close()
    }
  })
})
