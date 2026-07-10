/**
 * @neutronai/runtime — substrate-agnostic subagent registry.
 *
 * In-memory registry of running subagents. Lifted from OpenClaw's
 * `subagent-registry.ts` (TIER-0 lift target). At S3 the registry is in-process
 * only; S4 wires it to a SQLite-backed table so the lifecycle watchdog can
 * survive a gateway restart and reap orphaned children.
 *
 * Lifecycle states are limited to: pending → running → finished | crashed | cancelled.
 * MAX_DEPTH is baked in (Hermes constraint) and signed-delegation tokens are
 * mandatory — see `spawn.ts` for the policy enforcement.
 */

export const MAX_SPAWN_DEPTH = 1
export const MAX_CHILDREN_PER_AGENT = 5
export const MAX_CONCURRENT_SUBAGENTS = 8

export type SubagentStatus = 'pending' | 'running' | 'finished' | 'crashed' | 'cancelled'

export type AgentKind = 'forge' | 'atlas' | 'sentinel' | 'argus' | 'core'

export interface SubagentRecord {
  run_id: string
  parent_run_id?: string
  instance_key: string
  agent_kind: AgentKind
  spawn_depth: number
  status: SubagentStatus
  started_at: number
  ended_at?: number
  parent_session_id?: string
  child_session_id?: string
  pid?: number
  pid_starttime?: number
  cleanup_after?: number
  delivery_target?: { channel: string; binding_id: string }
  last_event_at: number
  /** Signed delegation token claims — see spawn.ts. */
  delegation_claims?: { instance: string; depth: number; scope: string[]; jti: string }
  /**
   * Logical de-dup key for the double-spawn guard. Two spawn attempts that
   * carry the same `spawn_key` describe the SAME logical task (e.g.
   * `code-gen:<task_id>:forge`); the guard coalesces/refuses the second while
   * the first is still live. See `spawn.ts` + `registry.liveByKey`.
   */
  spawn_key?: string
  /**
   * Why a record reached a terminal-failed state. Set by the agent-aware
   * watchdog (`watchdog.ts`) when it reaps a dead/stuck dispatch:
   * `'process_dead'` (pid gone before a terminal event) or `'stuck'` (no
   * progress past the per-kind timeout). Undefined for clean finishes.
   */
  failure_reason?: 'process_dead' | 'stuck'
}

export interface CreateRecordInput {
  run_id: string
  instance_key: string
  agent_kind: AgentKind
  spawn_depth: number
  parent_run_id?: string
  parent_session_id?: string
  delivery_target?: { channel: string; binding_id: string }
  delegation_claims?: { instance: string; depth: number; scope: string[]; jti: string }
  /** Logical de-dup key for the double-spawn guard — see SubagentRecord. */
  spawn_key?: string
}

/**
 * Optional write-through mirror for the registry (S4 — plan §P7). When a
 * persistence sink is supplied, every record mutation is projected to a durable
 * store so a gateway restart can reap orphaned dispatches instead of vanishing
 * them (`store.ts` / `boot-sweep.ts`). Absent → the registry is pure in-memory,
 * byte-identical to its S3 behaviour (every existing hermetic test path).
 *
 * ASYNC by design — the durable write must go through the mutex-serialized
 * `ProjectDb.run`/`transaction` (not `runSync`), or a write could be absorbed
 * into a foreign open transaction and lost on its rollback (`store.ts` header).
 * So the sink is async, and `create`/`update`/`delete` `await` it BEFORE
 * mutating the in-memory map (persist-first). The spawn/watchdog/control call
 * graph is already async, so this adds no new async surface at the call sites.
 */
export interface SubagentPersistence {
  /** Insert-or-replace the latest snapshot of a record. */
  persist(rec: SubagentRecord): void | Promise<void>
  /** Remove a record (lifecycle prune). */
  remove(run_id: string): void | Promise<void>
}

/**
 * In-memory registry. Construct one per-process; the gateway owns the only
 * live instance. Tests can construct fresh instances without polluting global
 * state. An optional `persistence` sink write-throughs every mutation to a
 * durable store (S4 — see `SubagentPersistence`); omit it for pure in-memory.
 */
export class SubagentRegistry {
  private readonly byId = new Map<string, SubagentRecord>()

  constructor(private readonly persistence?: SubagentPersistence) {}

  async create(input: CreateRecordInput): Promise<SubagentRecord> {
    if (this.byId.has(input.run_id)) {
      throw new Error(`subagent registry: duplicate run_id ${JSON.stringify(input.run_id)}`)
    }
    const now = Date.now()
    const rec: SubagentRecord = {
      run_id: input.run_id,
      instance_key: input.instance_key,
      agent_kind: input.agent_kind,
      spawn_depth: input.spawn_depth,
      status: 'pending',
      started_at: now,
      last_event_at: now,
    }
    if (input.parent_run_id !== undefined) rec.parent_run_id = input.parent_run_id
    if (input.parent_session_id !== undefined) rec.parent_session_id = input.parent_session_id
    if (input.delivery_target !== undefined) rec.delivery_target = input.delivery_target
    if (input.delegation_claims !== undefined) rec.delegation_claims = input.delegation_claims
    if (input.spawn_key !== undefined) rec.spawn_key = input.spawn_key
    // Persist FIRST: if the durable write rejects, the in-memory map is left
    // untouched so the two never diverge (the caller gets the exception and the
    // record does not exist in either). A duplicate run_id was already rejected
    // above, so this never fights an in-memory dup.
    if (this.persistence !== undefined) await this.persistence.persist(rec)
    this.byId.set(input.run_id, rec)
    return rec
  }

  /**
   * Patch an existing record. Returns the new record. Throws if `run_id` is
   * unknown — callers should always have called `create` first.
   */
  async update(
    run_id: string,
    patch: Partial<Omit<SubagentRecord, 'run_id'>>,
  ): Promise<SubagentRecord> {
    const cur = this.byId.get(run_id)
    if (!cur) throw new Error(`subagent registry: unknown run_id ${JSON.stringify(run_id)}`)
    // If the caller explicitly sets last_event_at in the patch, honor it
    // (callers patching watchdog-driven staleness need to be able to set
    // it to a past timestamp). Otherwise default to now().
    const last_event_at = patch.last_event_at ?? Date.now()
    const next: SubagentRecord = { ...cur, ...patch, last_event_at }
    // Persist FIRST: a durable-write rejection leaves the in-memory record on its
    // prior value rather than exposing an unpersisted new state.
    if (this.persistence !== undefined) await this.persistence.persist(next)
    this.byId.set(run_id, next)
    return next
  }

  byRunId(run_id: string): SubagentRecord | undefined {
    return this.byId.get(run_id)
  }

  byParent(parent_run_id: string): SubagentRecord[] {
    return [...this.byId.values()].filter((r) => r.parent_run_id === parent_run_id)
  }

  byOwner(instance_key: string): SubagentRecord[] {
    return [...this.byId.values()].filter((r) => r.instance_key === instance_key)
  }

  /** Live records — `pending` or `running`. Used by spawn caps + watchdog. */
  live(): SubagentRecord[] {
    return [...this.byId.values()].filter((r) => r.status === 'pending' || r.status === 'running')
  }

  /**
   * The single LIVE (`pending`|`running`) record holding `spawn_key`, if any.
   * The double-spawn guard (`spawn.ts`) consults this before minting a new
   * run: a hit means an in-flight dispatch already owns this logical task, so
   * the second attempt is coalesced/refused. A terminal record (finished /
   * crashed / cancelled) with the same key does NOT match — once the prior run
   * is done (or the watchdog has reaped it), a fresh spawn is allowed through.
   *
   * When `instance_key` is given the match is scoped to that instance, so a
   * cross-instance key collision can never hide a same-instance duplicate (nor
   * leak another instance's record). The guard always passes it.
   */
  liveByKey(spawn_key: string, instance_key?: string): SubagentRecord | undefined {
    return [...this.byId.values()].find(
      (r) =>
        r.spawn_key === spawn_key &&
        (instance_key === undefined || r.instance_key === instance_key) &&
        (r.status === 'pending' || r.status === 'running'),
    )
  }

  /** Records eligible for prune. Caller decides whether to actually delete. */
  pruneCandidates(now = Date.now()): SubagentRecord[] {
    return [...this.byId.values()].filter(
      (r) =>
        (r.status === 'finished' || r.status === 'crashed' || r.status === 'cancelled') &&
        r.cleanup_after !== undefined &&
        r.cleanup_after <= now,
    )
  }

  async delete(run_id: string): Promise<void> {
    // Remove FIRST: if the durable delete rejects, the record stays in BOTH the
    // store and the in-memory map (still in sync) rather than only the store.
    if (this.persistence !== undefined) await this.persistence.remove(run_id)
    this.byId.delete(run_id)
  }

  /** Snapshot — used for tests + observability. */
  snapshot(): SubagentRecord[] {
    return [...this.byId.values()]
  }
}
