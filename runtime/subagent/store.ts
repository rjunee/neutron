/**
 * @neutronai/runtime — SQLite persistence for the subagent registry.
 *
 * The S4 promise from `registry.ts`: "wires it to a SQLite-backed table so the
 * lifecycle watchdog can survive a gateway restart and reap orphaned children."
 * This is that table's typed wrapper (migration 0099 `code_subagent_registry`).
 *
 * Shape mirrors `trident/store.ts`: a thin typed wrapper over `ProjectDb`. One
 * difference — the registry mutates SYNCHRONOUSLY (`SubagentRegistry.create` /
 * `update` / `delete` are sync so the spawn/watchdog/control call graph stays
 * sync), so writes here route through `ProjectDb.runSync` rather than the async
 * `run`. That keeps the registry a pure in-memory structure with an optional
 * write-through mirror, no async ripple through its callers.
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
 * Typed CRUD over `code_subagent_registry`. Constructed once per process and
 * handed to `SubagentRegistry` as its write-through mirror; the boot sweep reads
 * `loadLive()` directly and drives orphaned rows terminal via `markCrashed`.
 */
export class SubagentRegistryStore implements SubagentPersistence {
  constructor(private readonly db: ProjectDb) {}

  /**
   * Insert-or-replace the row for `rec` (`SubagentPersistence.persist`). Called
   * by `SubagentRegistry` on every `create` and `update`, so the persisted row
   * is always the latest snapshot. Synchronous (`runSync`) — the registry write
   * path is sync.
   */
  persist(rec: SubagentRecord): void {
    this.db.runSync(
      `INSERT INTO code_subagent_registry (${COLS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      ],
    )
  }

  /** Delete a row by run id (the lifecycle prune path). */
  remove(run_id: string): void {
    this.db.runSync(`DELETE FROM code_subagent_registry WHERE run_id = ?`, [run_id])
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
   * Every LIVE (`pending`|`running`) row. On boot these are the in-flight
   * dispatches left by a prior process — the orphans the boot sweep reaps.
   */
  loadLive(): SubagentRecord[] {
    return this.db
      .prepare<SubagentRegistryDbRow, []>(
        `SELECT ${COLS} FROM code_subagent_registry WHERE status IN ${LIVE_STATUS_SQL}`,
      )
      .all()
      .map(rowToRecord)
  }

  /**
   * Drive a row terminal-`crashed` in the store (boot sweep). Sets `ended_at`
   * and the `failure_reason`, and — critically — guards on the row still being
   * LIVE (`WHERE status IN (pending, running)`) so the transition is idempotent:
   * a re-run over an already-crashed row is a no-op (0 changes), which is how the
   * sweep guarantees it fires the report sink EXACTLY ONCE per orphan across
   * repeated boots. Returns true iff this call performed the transition.
   */
  markCrashed(run_id: string, reason: 'process_dead' | 'stuck', ended_at: number): boolean {
    const res = this.db.runSync(
      `UPDATE code_subagent_registry
          SET status = 'crashed', failure_reason = ?, ended_at = ?, last_event_at = ?
        WHERE run_id = ? AND status IN ${LIVE_STATUS_SQL}`,
      [reason, ended_at, ended_at, run_id],
    )
    return res.changes > 0
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
    rec.delivery_target = JSON.parse(row.delivery_target) as DeliveryTarget
  }
  if (row.delegation_claims !== null) {
    rec.delegation_claims = JSON.parse(row.delegation_claims) as DelegationClaims
  }
  if (row.spawn_key !== null) rec.spawn_key = row.spawn_key
  if (row.failure_reason !== null) rec.failure_reason = row.failure_reason
  return rec
}
