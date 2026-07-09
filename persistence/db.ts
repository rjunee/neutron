import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import { PersistenceError } from './errors.ts'
import { BUSY_TIMEOUT_MS, withBusyRetry } from './retry.ts'

// PRAGMAs applied at every fresh connection. SQLite forbids `journal_mode` /
// `synchronous` / `foreign_keys` / `temp_store` PRAGMAs inside a transaction, so
// these run on the bare connection before any work — same pattern as
// `migrations/runner.ts:applyMigrations`.
//
// `cache_size` value is in pages by default; a negative value is bytes-per-KB
// (so -64000 = 64 MB cache). Per Hermes' tuning recipe + SQLite docs, this is a
// tradeoff sized for per-project workloads (one project ≈ tens of MB live working
// set in messages + sessions + FTS).
const STARTUP_PRAGMAS: ReadonlyArray<string> = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA cache_size = -64000',
  `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`,
]

export interface OpenOptions {
  /** Create the file if it doesn't exist. Default: true. */
  create?: boolean
  /** Open read-only. Default: false. */
  readonly?: boolean
}

/**
 * Result of a mutating statement — structurally the `bun:sqlite` `Changes`
 * shape. `lastInsertRowid` is a `bigint` only when the connection enables
 * `safeIntegers` (ProjectDb does not), so in practice it is a `number`.
 */
export interface RunSyncResult {
  /** Number of rows changed by the statement. */
  changes: number
  /** Rowid of the most recent successful INSERT on this connection. */
  lastInsertRowid: number | bigint
}

/**
 * Per-project SQLite wrapper. One ProjectDb instance per process; opening twice on
 * the same path within one process is allowed but leaves the busy-retry layer to
 * handle inter-connection lock contention.
 *
 * Algorithmic shape lifted from Hermes `hermes_state.py:SessionDB`. Dropped the
 * Hermes assumption that there's one DB per process tree (Neutron's process-per-
 * instance solves that) but kept the WAL + jittered-retry tuning verbatim — see
 * `retry.ts` for the rationale.
 *
 * Concurrency model: `bun:sqlite` exposes one shared connection per Database
 * handle, and SQLite's invariant is "one operation at a time per connection."
 * `run` / `exec` / `transaction` are async (the retry loop yields to the event
 * loop), so without serialization a concurrent `run` issued from another code
 * path could land between an in-flight `transaction`'s BEGIN and COMMIT and be
 * captured into that open transaction. The per-instance async mutex below
 * (`mutex` + `withLock`) serializes all writers on this connection so the
 * SQLite invariant holds across every async hand-off. Re-entry from inside a
 * `transaction` callback is detected via the per-instance AsyncLocalStorage so
 * `tx.run` / `tx.exec` calls inside the callback bypass the lock (otherwise
 * they would deadlock against the lock the transaction itself is holding).
 */
export class ProjectDb {
  private mutex: Promise<void> = Promise.resolve()
  private readonly inTransaction = new AsyncLocalStorage<boolean>()

  private constructor(
    readonly path: string,
    private readonly db: Database,
  ) {}

  static open(path: string, options: OpenOptions = {}): ProjectDb {
    const create = options.create ?? true
    const readonly = options.readonly ?? false
    let db: Database
    try {
      db = new Database(path, { create, readonly })
    } catch (err) {
      throw new PersistenceError(`failed to open SQLite at ${path}`, err)
    }
    if (!readonly) {
      for (const stmt of STARTUP_PRAGMAS) {
        db.exec(stmt)
      }
    } else {
      // Read-only connections can't change journal_mode (no write lock available),
      // but they still need foreign_keys and busy_timeout for safe concurrent reads
      // alongside a writer.
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    }
    return new ProjectDb(path, db)
  }

  /**
   * Escape hatch for callers that need the raw `bun:sqlite` Database — primarily
   * the migration runner (which expects a `Database` argument). Avoid in normal
   * code paths; prefer the `prepare` / `exec` / `run` / `transaction` wrappers so
   * busy-retry covers your write AND the per-instance mutex serializes you
   * against any in-flight transaction.
   */
  raw(): Database {
    return this.db
  }

  close(): void {
    this.db.close()
  }

  /**
   * Read a PRAGMA's current value. Returns the first column of the first row, or
   * `undefined` if the PRAGMA returned no rows (e.g. read-only PRAGMAs that don't
   * have a value to report). Useful for asserting connection state in tests.
   */
  pragma(name: string): unknown {
    const row = this.db.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get()
    if (row === null) return undefined
    const values = Object.values(row)
    return values[0]
  }

  /**
   * Type-typed prepared statement. Wraps `Database.query<R, P>`. The cast at
   * return is needed because `bun:sqlite`'s query() return type is the
   * conditional `Statement<R, P extends any[] ? P : [P]>`, which TS cannot
   * resolve to the bare `Statement<R, P>` shape we want to expose without an
   * explicit narrowing.
   *
   * NOT mutex-serialized: `prepare` only compiles a statement; the `.get()` /
   * `.all()` / `.run()` calls on the returned Statement are read-only or
   * caller-owned. If you need a mutating `Statement.run()` to be serialized
   * against in-flight transactions, route the SQL through `ProjectDb.run`
   * instead of holding the prepared statement directly.
   */
  prepare<R, P extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<R, P> {
    return this.db.query<R, P>(sql) as Statement<R, P>
  }

  /**
   * Typed single-row read. Behavior-identical to
   * `raw().query<R, P>(sql).get(...params)` — named and greppable so read
   * call sites stop reaching for the `raw()` escape hatch. Returns the first
   * matching row or `null`.
   *
   * NOT mutex-serialized (same as `prepare` — `bun:sqlite` calls are
   * synchronous, so a read can never interleave into an in-flight statement).
   * Note that a read issued while THIS instance has an open `transaction()`
   * runs on the same shared connection and therefore sees that transaction's
   * uncommitted writes — identical to today's `raw()` read semantics.
   */
  get<R, P extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string, params: P | [] = []): R | null {
    return this.db.query<R, SQLQueryBindings[]>(sql).get(...params)
  }

  /**
   * Typed multi-row read. Behavior-identical to
   * `raw().query<R, P>(sql).all(...params)`. Returns every matching row
   * (empty array when none match). Same serialization notes as `get`.
   */
  all<R, P extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string, params: P | [] = []): R[] {
    return this.db.query<R, SQLQueryBindings[]>(sql).all(...params)
  }

  /**
   * Synchronous parameterised mutation returning the driver's
   * `{ changes, lastInsertRowid }` — the missing return values that pushed
   * callers into `tx.raw().run(...)` / `tx.raw().prepare(...).run(...)`.
   * Behavior-identical to `raw().run(sql, params)`.
   *
   * Two blessed contexts:
   *  1. Inside a `transaction(fn)` callback — the write is covered by the
   *     transaction's mutex hold, and BEGIN/COMMIT carry the busy-retry.
   *  2. Genuinely synchronous call sites that cannot `await` (e.g. a sync
   *     progress-counter UPDATE on a hot path).
   *
   * NOT busy-retry-wrapped: the retry layer sleeps with `await Bun.sleep`
   * BY DESIGN (a sync sleep would pin the event loop and starve the systemd
   * watchdog tick — see retry.ts), so a sync API cannot participate. Only the
   * C-level `busy_timeout` (100 ms) applies. NOT mutex-serialized either
   * (sync code cannot await the lock): called outside a transaction callback
   * while another caller's async `transaction()` is open on this instance,
   * the write lands INSIDE that open BEGIN/COMMIT window and shares its fate
   * (pinned by regression test). Prefer `await run(...)` whenever the call
   * site can be async and doesn't need the returned counts.
   */
  runSync<P extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string, params: P | [] = []): RunSyncResult {
    return this.db.run<P | []>(sql, params)
  }

  /**
   * Execute one or more statements. Routed through the per-instance mutex so a
   * concurrent `exec` from elsewhere can't land between a live transaction's
   * BEGIN and COMMIT. NOT busy-retry-wrapped: `exec` is for one-off DDL /
   * schema bootstraps where the caller wants a single-shot semantic — callers
   * that want retry semantics should route through `transaction()` or call
   * `withBusyRetry` themselves.
   */
  async exec(sql: string): Promise<void> {
    await this.withLock(async () => {
      this.db.exec(sql)
    })
  }

  /**
   * Run a parameterised mutation with jittered busy-retry. Use for INSERT /
   * UPDATE / DELETE statements that may contend with another connection's
   * write lock. Async because the retry loop yields to the event loop between
   * attempts (so the gateway watchdog tick keeps firing during contention) —
   * see `retry.ts` for the rationale.
   *
   * Routed through the per-instance mutex so a concurrent `run` cannot land
   * inside an in-flight `transaction`'s open BEGIN/COMMIT window.
   */
  async run<P extends SQLQueryBindings[]>(sql: string, params: P): Promise<void> {
    await this.withLock(async () => {
      await withBusyRetry(() => {
        this.db.run<P>(sql, params)
      })
    })
  }

  /**
   * Run `fn` inside a `BEGIN` / `COMMIT` block. Rolls back on throw and
   * rethrows. The per-instance mutex is held for the full BEGIN → fn → COMMIT
   * window so concurrent `run` / `exec` / `transaction` calls from elsewhere
   * cannot interleave into the open transaction. Callbacks may be sync or
   * async; inside the callback the same `ProjectDb` instance is passed as
   * `tx`, and `tx.run` / `tx.exec` skip the mutex (re-entry is detected via
   * the per-instance AsyncLocalStorage) so they don't deadlock against the
   * lock the transaction is holding.
   *
   * BEGIN and COMMIT are each independently busy-retry-wrapped; if BEGIN
   * succeeds but COMMIT then fails (e.g. SQLITE_BUSY exhausted, SQLITE_FULL,
   * a deferred-constraint violation), ROLLBACK is issued before the COMMIT
   * error is rethrown so the connection is not left stuck in an open
   * transaction. `isBusyError` explicitly rejects `BusyRetryExhaustedError`,
   * so a write inside `fn` that exhausts its own retries does NOT cause the
   * outer BEGIN/COMMIT to replay another 15 times — it surfaces as a single
   * thrown exhaustion wrapper.
   */
  async transaction<R>(fn: (tx: ProjectDb) => R | Promise<R>): Promise<R> {
    return this.withLock(async () => {
      return this.inTransaction.run(true, async () => {
        await withBusyRetry(() => {
          this.db.exec('BEGIN')
        })

        let result: R
        try {
          result = await fn(this)
        } catch (err) {
          this.safeRollback()
          throw err
        }

        try {
          await withBusyRetry(() => {
            this.db.exec('COMMIT')
          })
        } catch (commitErr) {
          this.safeRollback()
          throw commitErr
        }

        return result
      })
    })
  }

  /**
   * True while the calling async context is inside THIS instance's
   * `transaction(fn)` callback (detected via the same per-instance
   * AsyncLocalStorage that powers `withLock` re-entry, so it survives
   * `await`s and propagates into helper functions called from the callback).
   *
   * Scope note: this answers "is MY current call stack inside the
   * transaction callback", NOT "does the connection have an open BEGIN" — a
   * concurrent caller outside the callback sees `false` even while another
   * caller's transaction is mid-flight.
   */
  isInTransaction(): boolean {
    return this.inTransaction.getStore() === true
  }

  /**
   * Opt-in transaction-open assertion. Store methods whose correctness
   * depends on running inside a caller-held transaction (e.g. "MUST be
   * called from within `db.transaction(...)` so writes share the tx"
   * contracts) call this at entry so a bare invocation fails loudly instead
   * of silently writing outside the transaction. Throws `PersistenceError`;
   * `what` names the operation in the error message.
   */
  assertInTransaction(what = 'this operation'): void {
    if (!this.isInTransaction()) {
      throw new PersistenceError(
        `transaction required: ${what} must run inside ProjectDb.transaction()`,
      )
    }
  }

  /**
   * Acquire the per-instance mutex, run `fn`, release. Re-entrant for callers
   * already inside a `transaction(fn)` callback on this instance — they skip
   * the lock to avoid deadlocking against the lock `transaction` is holding.
   * The mutex chain is rebuilt with a swallowing `.catch` so a single
   * caller's failure does NOT propagate as a rejection into queued callers.
   */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTransaction.getStore() === true) {
      return fn()
    }
    const next = this.mutex.then(fn)
    this.mutex = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * Best-effort ROLLBACK on the bare connection. Used by `transaction` after
   * a callback throw or a COMMIT failure. A throw here is swallowed: ROLLBACK
   * after a failed COMMIT (or after the connection has already auto-rolled
   * back) can itself raise, but the caller should see the ORIGINAL error, not
   * the rollback secondary.
   */
  private safeRollback(): void {
    try {
      this.db.exec('ROLLBACK')
    } catch (_rollbackErr) {
      // intentional: surface the original error, not a rollback secondary.
    }
  }
}
