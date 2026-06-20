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
}

/**
 * In-memory registry. Construct one per-process; the gateway owns the only
 * live instance. Tests can construct fresh instances without polluting global
 * state.
 */
export class SubagentRegistry {
  private readonly byId = new Map<string, SubagentRecord>()

  create(input: CreateRecordInput): SubagentRecord {
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
    this.byId.set(input.run_id, rec)
    return rec
  }

  /**
   * Patch an existing record. Returns the new record. Throws if `run_id` is
   * unknown — callers should always have called `create` first.
   */
  update(run_id: string, patch: Partial<Omit<SubagentRecord, 'run_id'>>): SubagentRecord {
    const cur = this.byId.get(run_id)
    if (!cur) throw new Error(`subagent registry: unknown run_id ${JSON.stringify(run_id)}`)
    // If the caller explicitly sets last_event_at in the patch, honor it
    // (callers patching watchdog-driven staleness need to be able to set
    // it to a past timestamp). Otherwise default to now().
    const last_event_at = patch.last_event_at ?? Date.now()
    const next: SubagentRecord = { ...cur, ...patch, last_event_at }
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

  /** Records eligible for prune. Caller decides whether to actually delete. */
  pruneCandidates(now = Date.now()): SubagentRecord[] {
    return [...this.byId.values()].filter(
      (r) =>
        (r.status === 'finished' || r.status === 'crashed' || r.status === 'cancelled') &&
        r.cleanup_after !== undefined &&
        r.cleanup_after <= now,
    )
  }

  delete(run_id: string): void {
    this.byId.delete(run_id)
  }

  /** Snapshot — used for tests + observability. */
  snapshot(): SubagentRecord[] {
    return [...this.byId.values()]
  }
}
