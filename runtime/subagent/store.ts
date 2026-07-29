/**
 * @neutronai/runtime — SQLite persistence for the subagent registry.
 *
 * The S4 promise from `registry.ts`: "wires it to a SQLite-backed table so the
 * lifecycle watchdog can survive a gateway restart and reap orphaned children."
 * This is that table's typed wrapper (migration 0100 `code_subagent_registry`).
 *
 * Shape mirrors `trident/store.ts`: a thin typed wrapper over `ProjectDb`.
 * Writes route through the ASYNC, mutex-serialized `ProjectDb.run` /
 * `transaction` (NOT the synchronous `runSync`). This is a correctness
 * requirement, not a style choice: a `runSync` issued while another store has a
 * `transaction()` open on the same connection is absorbed into that transaction
 * and LOST on its rollback (pinned `persistence/db-api.test.ts` "runSync bypass
 * hazard"). The async `run` instead QUEUES on the per-instance mutex, so a
 * registry write always executes as its OWN statement AFTER any in-flight
 * transaction has committed or rolled back — never captured by it, and its
 * yielding busy-retry never stalls the event loop. Because these writes are
 * async, the registry's `SubagentPersistence` sink — and thus `create`/`update`/
 * `delete` — are async. `create`/`update` publish to the in-memory map
 * SYNCHRONOUSLY then `await` durability and roll back on rejection (so a
 * concurrent reader sees a mutation immediately, yet memory never diverges from
 * the store on failure — see `registry.ts`); `delete` removes after a
 * successful durable remove.
 *
 * The store is a faithful PROJECTION of the in-memory `SubagentRecord`: every
 * field round-trips (epoch-ms timestamps stay INTEGER, the two small structured
 * blobs go to JSON TEXT). It persists the REGISTRY only — it has NO column for
 * any "already fired / redispatched / reported" dedup marker, so it cannot
 * restore or replay the Trident orchestrator's volatile orphan-detection sets
 * (`trident/orchestrator.ts` `fired`/`redispatched`). See the migration header.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type {
  AgentKind,
  SubagentPersistence,
  SubagentRecord,
  SubagentStatus,
} from './registry.ts'
import { createLogger } from '@neutronai/logger'

const log = createLogger('subagent-store')

/** The persisted row (all columns; JSON blobs as TEXT, timestamps as INTEGER). */
interface SubagentRegistryDbRow {
  run_id: string
  instance_key: string
  agent_kind: AgentKind
  status: SubagentStatus
  spawn_depth: number
  parent_run_id: string | null
  parent_session_id: string | null
  child_session_id: string | null
  pid: number | null
  pid_starttime: number | null
  started_at: number
  ended_at: number | null
  last_event_at: number
  cleanup_after: number | null
  delivery_target: string | null
  delegation_claims: string | null
  spawn_key: string | null
  failure_reason: 'process_dead' | 'stuck' | null
}

type DeliveryTarget = NonNullable<SubagentRecord['delivery_target']>
type DelegationClaims = NonNullable<SubagentRecord['delegation_claims']>

const COLS =
  'run_id, instance_key, agent_kind, status, spawn_depth, parent_run_id, ' +
  'parent_session_id, child_session_id, pid, pid_starttime, started_at, ' +
  'ended_at, last_event_at, cleanup_after, delivery_target, delegation_claims, ' +
  'spawn_key, failure_reason'

/** Live (in-flight) statuses — the set the boot sweep reaps. */
const LIVE_STATUS_SQL = "('pending', 'running')"

/**
 * This process's boot id — minted ONCE at module load (process start) and never
 * regenerated. Stamped on every row this process creates (the `boot_id` column)
 * so the boot reap can tell rows THIS boot owns (live, MUST NOT reap) from rows a
 * PRIOR boot left behind (true orphans → reap). Same id shape as `run_id`
 * (`crypto.randomUUID`, with a non-crypto fallback), prefixed `boot-` so it is
 * self-describing in the table. A restart yields a fresh id — which is exactly
 * how a prior generation's in-flight rows become reapable.
 */
export const CURRENT_BOOT_ID: string = mintBootId()

function mintBootId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return `boot-${c.randomUUID()}`
  return `boot-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

/**
 * Typed CRUD over `code_subagent_registry`. Constructed once per process and
 * handed to `SubagentRegistry` as its write-through mirror; the boot sweep reads
 * `loadReapable()` directly and drives orphaned rows terminal via `markCrashed`.
 *
 * The store carries this process's `bootId` (defaults to the module-level
 * `CURRENT_BOOT_ID`; tests inject distinct ids to simulate separate process
 * generations). `persist` stamps it on every row; `loadReapable` returns only
 * rows owned by a DIFFERENT boot — so the reap can never crash a dispatch the
 * current boot created and is legitimately still running.
 */
export class SubagentRegistryStore implements SubagentPersistence {
  constructor(
    private readonly db: ProjectDb,
    private readonly bootId: string = CURRENT_BOOT_ID,
  ) {}

  /**
   * Insert-or-replace the row for `rec` (`SubagentPersistence.persist`). Called
   * by `SubagentRegistry` on every `create` and `update`, so the persisted row
   * is always the latest snapshot. Async, mutex-serialized (`db.run`) so the
   * write is never absorbed into a foreign open transaction.
   */
  async persist(rec: SubagentRecord): Promise<void> {
    await this.db.run(
      // `boot_id` is stamped on INSERT and DELIBERATELY absent from the
      // ON CONFLICT SET: it records the OWNING process generation and must stay
      // immutable across this process's own updates (the row is only ever updated
      // by the boot that created it, so `excluded.boot_id` would equal it anyway
      // — omitting it makes ownership provably write-once).
      `INSERT INTO code_subagent_registry (${COLS}, boot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         instance_key      = excluded.instance_key,
         agent_kind        = excluded.agent_kind,
         status            = excluded.status,
         spawn_depth       = excluded.spawn_depth,
         parent_run_id     = excluded.parent_run_id,
         parent_session_id = excluded.parent_session_id,
         child_session_id  = excluded.child_session_id,
         pid               = excluded.pid,
         pid_starttime     = excluded.pid_starttime,
         started_at        = excluded.started_at,
         ended_at          = excluded.ended_at,
         last_event_at     = excluded.last_event_at,
         cleanup_after     = excluded.cleanup_after,
         delivery_target   = excluded.delivery_target,
         delegation_claims = excluded.delegation_claims,
         spawn_key         = excluded.spawn_key,
         failure_reason    = excluded.failure_reason`,
      [
        rec.run_id,
        rec.instance_key,
        rec.agent_kind,
        rec.status,
        rec.spawn_depth,
        rec.parent_run_id ?? null,
        rec.parent_session_id ?? null,
        rec.child_session_id ?? null,
        rec.pid ?? null,
        rec.pid_starttime ?? null,
        rec.started_at,
        rec.ended_at ?? null,
        rec.last_event_at,
        rec.cleanup_after ?? null,
        rec.delivery_target !== undefined ? JSON.stringify(rec.delivery_target) : null,
        rec.delegation_claims !== undefined ? JSON.stringify(rec.delegation_claims) : null,
        rec.spawn_key ?? null,
        rec.failure_reason ?? null,
        this.bootId,
      ],
    )
  }

  /** Delete a row by run id (the lifecycle prune path). Async, mutex-serialized. */
  async remove(run_id: string): Promise<void> {
    await this.db.run(`DELETE FROM code_subagent_registry WHERE run_id = ?`, [run_id])
  }

  /** Read a single row, or null. */
  get(run_id: string): SubagentRecord | null {
    const row = this.db
      .prepare<SubagentRegistryDbRow, [string]>(
        `SELECT ${COLS} FROM code_subagent_registry WHERE run_id = ?`,
      )
      .get(run_id)
    return row === null ? null : rowToRecord(row)
  }

  /** Every persisted row (tests + observability). */
  loadAll(): SubagentRecord[] {
    return this.db
      .prepare<SubagentRegistryDbRow, []>(`SELECT ${COLS} FROM code_subagent_registry`)
      .all()
      .map(rowToRecord)
  }

  /**
   * The REAPABLE orphans: every LIVE (`pending`|`running`) row owned by a
   * DIFFERENT process boot (`boot_id <> this.bootId`). These are the in-flight
   * dispatches a PRIOR process left behind; rows the CURRENT boot created and is
   * legitimately still running carry this process's `boot_id` and are excluded —
   * so a repeat composer build / second boot-sweep in the same process can never
   * crash a live current-boot dispatch. (The predicate is correct for sequential
   * process generations, the real deployment model; concurrently-live processes
   * sharing one DB are out of scope — see the migration header.)
   */
  loadReapable(): SubagentRecord[] {
    return this.db
      .prepare<SubagentRegistryDbRow, [string]>(
        `SELECT ${COLS} FROM code_subagent_registry
          WHERE status IN ${LIVE_STATUS_SQL} AND boot_id <> ?`,
      )
      .all(this.bootId)
      .map(rowToRecord)
  }

  /**
   * Drive a row terminal-`crashed` in the store (boot sweep). Sets `ended_at`
   * and the `failure_reason`, guarded on the row still being LIVE
   * (`WHERE status IN (pending, running)`). Returns true IFF THIS call performed
   * the transition — the sole authority is the guarded UPDATE's affected-row
   * COUNT, not a prior read.
   *
   * This is the exactly-once claim, correct even ACROSS separate connections /
   * processes (the real multi-process boot-reap scenario). A single guarded
   * UPDATE re-evaluates its `WHERE` against the current committed state at write
   * time, so of N racers exactly ONE sees a matching row (changes === 1) and the
   * rest match zero (changes === 0) — the row is already `crashed`. A prior
   * guard-READ would be wrong here: two connections could each read `running`
   * (on their own snapshot) and then both believe they won; the affected-row
   * count is the only signal that reflects who actually committed the change.
   *
   * Wrapped in `db.transaction` so the write is mutex-serialized (never absorbed
   * into a foreign transaction — `store.ts` header). The UPDATE goes through the
   * ASYNC, busy-retrying `tx.run` (NOT `runSync`): under cross-connection write
   * contention its retry YIELDS the event loop, so the lock-holder's COMMIT can
   * land and the loser's UPDATE then re-evaluates against the committed state
   * (matching zero rows) instead of dead-locking on a synchronous busy-wait. The
   * UPDATE is the FIRST statement in the transaction (no prior read) so it never
   * hits `SQLITE_BUSY_SNAPSHOT` — a fresh write always sees the latest committed
   * state. `changes()` — read on the SAME connection, inside the SAME transaction,
   * with no intervening statement — reports the guarded UPDATE's affected-row
   * count. Only the winner (`changes > 0`) returns true, so the boot sweep fires
   * the report sink exactly once; every loser returns false and does NOT report.
   */
  async markCrashed(
    run_id: string,
    reason: 'process_dead' | 'stuck',
    ended_at: number,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.run(
        `UPDATE code_subagent_registry
            SET status = 'crashed', failure_reason = ?, ended_at = ?, last_event_at = ?
          WHERE run_id = ? AND status IN ${LIVE_STATUS_SQL}`,
        [reason, ended_at, ended_at, run_id],
      )
      const row = tx.get<{ affected: number }, []>(`SELECT changes() AS affected`)
      return (row?.affected ?? 0) > 0
    })
  }
}

/**
 * Parse a persisted JSON blob, ISOLATING a malformed value: a single corrupt
 * row (e.g. external tampering — the store's own writes always `JSON.stringify`,
 * so valid) must not throw out of `rowToRecord` and abort the WHOLE
 * `loadReapable()` scan, which would block reaping every other orphan. On a parse failure the
 * optional field is dropped (logged) and the row is still returned + reaped.
 */
function parseBlob<T>(text: string, run_id: string, field: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    log.warn('dropping_malformed_json', { field, run_id })
    return undefined
  }
}

function rowToRecord(row: SubagentRegistryDbRow): SubagentRecord {
  const rec: SubagentRecord = {
    run_id: row.run_id,
    instance_key: row.instance_key,
    agent_kind: row.agent_kind,
    spawn_depth: row.spawn_depth,
    status: row.status,
    started_at: row.started_at,
    last_event_at: row.last_event_at,
  }
  if (row.parent_run_id !== null) rec.parent_run_id = row.parent_run_id
  if (row.parent_session_id !== null) rec.parent_session_id = row.parent_session_id
  if (row.child_session_id !== null) rec.child_session_id = row.child_session_id
  if (row.pid !== null) rec.pid = row.pid
  if (row.pid_starttime !== null) rec.pid_starttime = row.pid_starttime
  if (row.ended_at !== null) rec.ended_at = row.ended_at
  if (row.cleanup_after !== null) rec.cleanup_after = row.cleanup_after
  if (row.delivery_target !== null) {
    const parsed = parseBlob<DeliveryTarget>(row.delivery_target, row.run_id, 'delivery_target')
    if (parsed !== undefined) rec.delivery_target = parsed
  }
  if (row.delegation_claims !== null) {
    const parsed = parseBlob<DelegationClaims>(row.delegation_claims, row.run_id, 'delegation_claims')
    if (parsed !== undefined) rec.delegation_claims = parsed
  }
  if (row.spawn_key !== null) rec.spawn_key = row.spawn_key
  if (row.failure_reason !== null) rec.failure_reason = row.failure_reason
  return rec
}
