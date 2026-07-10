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
 * So the sink is async. `create`/`update` PUBLISH to the in-memory map
 * SYNCHRONOUSLY (reserve-first), then `await` the durable write and roll the
 * in-memory change back if it rejects — so a mutation is visible to concurrent
 * readers immediately (the double-spawn guard + the watchdog's `failRun`
 * re-read both depend on zero-await visibility) yet memory never diverges from
 * the store on a write failure. `delete` removes AFTER a successful durable
 * remove (a rejected remove leaves the row in BOTH, still in sync). The
 * spawn/watchdog/control call graph is already async, so this adds no new async
 * surface at the call sites.
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
  /**
   * In-flight `create` durable-write promises, keyed by run_id. A record is
   * reserved in `byId` synchronously but its durable persist resolves later; a
   * coalescing caller (the double-spawn guard) that hands back a still-reserved
   * record must await THIS promise so it shares the create's durable outcome —
   * never returning a run whose persist ultimately rejected (`awaitCreate`).
   */
  private readonly pendingCreate = new Map<string, Promise<void>>()
  /**
   * The last snapshot of each record whose durable write SUCCEEDED — the store's
   * committed truth as this process last observed it. A failed `update` rolls
   * `byId` back to THIS (not to its own captured predecessor, which may itself be
   * another in-flight update's UNPERSISTED optimistic value): with two
   * overlapping failing updates, restoring the optimistic predecessor would leave
   * memory on a value neither update ever committed. Populated on every
   * successful create/update persist; cleared on delete.
   */
  private readonly lastPersisted = new Map<string, SubagentRecord>()
  /**
   * Per-`run_id` in-flight mutation count + FIFO tail. Every create/update/delete
   * for a given run_id is serialized through `runSerial`: it runs to COMPLETION
   * (publish → await persist → advance `lastPersisted` or roll back) before the
   * next SAME-run mutation begins. That is what makes the optimistic-publish
   * model race-free at the root: memory and storage advance in submission order,
   * so no rollback can strand memory behind a later-committed success, and there
   * is never an "older A / newer B" interleaving. Cross-run mutations stay fully
   * concurrent — the key is the run_id, not a global lock.
   */
  private readonly mutationPending = new Map<string, number>()
  private readonly mutationTail = new Map<string, Promise<void>>()

  constructor(private readonly persistence?: SubagentPersistence) {}

  /**
   * Serialize `fn` behind any in-flight mutation for `run_id` (FIFO), then run it
   * to completion before the next same-run mutation starts. UNCONTENDED FAST PATH:
   * when nothing is in flight for this run_id, `fn` is invoked SYNCHRONOUSLY, so
   * its in-memory publish lands before the first `await` — preserving the S3
   * zero-await visibility the double-spawn guard (`create` reserving `byId`) and
   * the watchdog's `failRun` re-read (`control.ts`) depend on for the normal
   * sequential lifecycle (create → running → finished, each awaited). Only
   * genuinely-concurrent same-run mutations defer their publish, which is correct
   * — they are strictly ordered.
   */
  private runSerial<T>(run_id: string, fn: () => Promise<T>): Promise<T> {
    const inflight = this.mutationPending.get(run_id) ?? 0
    this.mutationPending.set(run_id, inflight + 1)
    const run = async (): Promise<T> => {
      try {
        return await fn()
      } finally {
        const n = (this.mutationPending.get(run_id) ?? 1) - 1
        if (n <= 0) {
          this.mutationPending.delete(run_id)
          this.mutationTail.delete(run_id)
        } else {
          this.mutationPending.set(run_id, n)
        }
      }
    }
    // Uncontended → run NOW (synchronous publish). Contended → defer the WHOLE
    // mutation (including its publish) behind the current tail, regardless of
    // whether the predecessor settled fulfilled or rejected.
    const result =
      inflight === 0
        ? run()
        : (this.mutationTail.get(run_id) ?? Promise.resolve()).then(run, run)
    // The next same-run mutation waits for THIS one to settle (either way).
    this.mutationTail.set(
      run_id,
      result.then(
        () => {},
        () => {},
      ),
    )
    return result
  }

  create(input: CreateRecordInput): Promise<SubagentRecord> {
    // Serialized per run_id (uncontended → runs synchronously, so the byId
    // reservation below still lands before the first await — the double-spawn
    // guard's atomicity is preserved).
    return this.runSerial(input.run_id, async () => {
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
      // RESERVE the in-memory slot SYNCHRONOUSLY — before the (async) persist —
      // so the record is immediately visible to `liveByKey`. The double-spawn
      // guard (`spawn.ts`) depends on there being NO `await` between its
      // `liveByKey` read and this record becoming visible: a synchronous reserve
      // keeps check-then-create atomic against a concurrent same-`spawn_key`
      // dispatch (the durable persist runs entirely AFTER the reservation, so it
      // can never open a window for a duplicate to slip through). If the durable
      // write then REJECTS, roll the reservation back so the net effect is no
      // in-memory mutation — memory never diverges from the store on failure.
      this.byId.set(input.run_id, rec)
      if (this.persistence !== undefined) {
        // Publish the durable-write promise so a coalescing caller shares this
        // create's outcome (see `pendingCreate` / `awaitCreate`). Wrapped in an
        // IIFE so both this method AND `awaitCreate` await the same settled result.
        const durable = (async () => {
          await this.persistence!.persist(rec)
        })()
        this.pendingCreate.set(input.run_id, durable)
        try {
          await durable
          // Record the committed snapshot — the roll-back target for later updates.
          this.lastPersisted.set(input.run_id, rec)
        } catch (err) {
          this.byId.delete(input.run_id)
          throw err
        } finally {
          this.pendingCreate.delete(input.run_id)
        }
      }
      return rec
    })
  }

  /**
   * Await the in-flight durable `create` for `run_id`, if any. The double-spawn
   * guard calls this before returning a coalesced record so the coalescing
   * caller shares the winner's durable-create outcome: it resolves once the
   * create's persist succeeded (the record is durable) and REJECTS if it failed
   * (the record was rolled back) — so a coalesced caller never receives a run
   * the winner failed to create. Resolves immediately when the create already
   * settled or the registry has no persistence.
   */
  awaitCreate(run_id: string): Promise<void> {
    return this.pendingCreate.get(run_id) ?? Promise.resolve()
  }

  /**
   * Patch an existing record. Returns the new record. Throws if `run_id` is
   * unknown — callers should always have called `create` first.
   */
  update(
    run_id: string,
    patch: Partial<Omit<SubagentRecord, 'run_id'>>,
  ): Promise<SubagentRecord> {
    // Serialized per run_id: this runs to completion (publish → persist →
    // advance/rollback) before the next same-run mutation, and `cur` is read
    // AFTER any predecessor settled — so `next` always builds on the last
    // committed (or rolled-back) state, never on another update's UNPERSISTED
    // optimistic value. Uncontended → runs synchronously (below), preserving the
    // S3 zero-await visibility the failRun re-read (`control.ts`) relies on.
    return this.runSerial(run_id, async () => {
      const cur = this.byId.get(run_id)
      if (!cur) throw new Error(`subagent registry: unknown run_id ${JSON.stringify(run_id)}`)
      // If the caller explicitly sets last_event_at in the patch, honor it
      // (callers patching watchdog-driven staleness need to be able to set
      // it to a past timestamp). Otherwise default to now().
      const last_event_at = patch.last_event_at ?? Date.now()
      const next: SubagentRecord = { ...cur, ...patch, last_event_at }
      // PUBLISH synchronously — before the (async) persist. In the uncontended
      // case this makes the mutation immediately visible: a persist-FIRST update
      // would leave memory on the PRIOR status for the whole durable write, so a
      // completion landing `finished` would stay INVISIBLE while its persist is
      // in flight, and the watchdog's `failRun` (which re-reads AFTER awaiting
      // its canceller) would clobber a legitimate `finished` with `crashed`.
      this.byId.set(run_id, next)
      if (this.persistence !== undefined) {
        try {
          await this.persistence.persist(next)
          this.lastPersisted.set(run_id, next)
        } catch (err) {
          // Roll back to the last DURABLE snapshot (`lastPersisted`) — the store's
          // committed truth. Per-run serialization guarantees no concurrent
          // same-run mutation touched `byId` between our publish and here, so the
          // identity guard is defensively-true; the `lastPersisted` target (never
          // the optimistic `cur`) is what keeps memory === storage across any
          // failure ordering.
          if (this.byId.get(run_id) === next) {
            const durable = this.lastPersisted.get(run_id)
            if (durable !== undefined) this.byId.set(run_id, durable)
          }
          throw err
        }
      }
      return next
    })
  }

  /**
   * Force the in-memory record to `patch` WITHOUT a durable write — the LIVE-flow
   * fix-up the dispatch/cancel/fail paths apply after a best-effort `update`
   * persist FAILED. `update` rolls memory back to the last durable snapshot on a
   * persist failure (correct for the general overlapping-update case), but the
   * in-memory registry is the process's OPERATIONAL source of truth and must
   * reflect reality even when the durable store is now stale:
   *   - a running-flip whose persist failed must still read `running` (else the
   *     concurrency caps under-count and `statusOf` shows a phantom `pending`
   *     while the subprocess runs);
   *   - a COMPLETED / CANCELLED / CRASHED run must not linger `running` (else
   *     `waitForCompletion` hangs forever, the caps retain a finished run, and the
   *     watchdog re-reaps it into a SECOND, contradictory crash report).
   * The durable store stays stale (the failure was logged; a restart reaps the
   * still-live row as an orphan — the correct surfacing). NEVER clobbers an
   * already-terminal record (a concurrent completion/cancel/fail wins); a no-op if
   * the run is unknown. Serialized per run_id like every other mutation. Does NOT
   * touch `lastPersisted` (that tracks DURABLE truth, which did not change).
   */
  reconcileInMemory(
    run_id: string,
    patch: Partial<Omit<SubagentRecord, 'run_id'>>,
  ): Promise<SubagentRecord | undefined> {
    return this.runSerial(run_id, async () => {
      const cur = this.byId.get(run_id)
      if (cur === undefined) return undefined
      if (cur.status === 'finished' || cur.status === 'crashed' || cur.status === 'cancelled') {
        return cur // already terminal — a concurrent completion/cancel/fail won
      }
      const next = { ...cur, ...patch }
      this.byId.set(run_id, next)
      return next
    })
  }

  /**
   * Drive a run TERMINAL with a durable write that CONVERGES. Retries the durable
   * `update` up to `attempts` times — a TRANSIENT store failure (a brief I/O blip,
   * a momentary lock the async busy-retry didn't outlast) may clear, so a retry
   * lands and memory + store agree. On success a restart's boot sweep skips the
   * now-terminal row. If EVERY attempt fails, forces the live record terminal in
   * memory anyway (`reconcileInMemory`) so the process's operational state is still
   * correct, and returns `durable: false` — the durable row stays stale (a
   * permanently-broken store is a degraded process, out of scope; the boot sweep
   * may then re-surface the row). This convergence is the live terminal paths'
   * (completion / cancelRun / failRun) durability guarantee: a CONVERGED terminal
   * row is what stops a restart from re-reporting an already-surfaced
   * finished/cancelled run as a contradictory crash. NEVER rejects.
   */
  async updateTerminal(
    run_id: string,
    patch: Partial<Omit<SubagentRecord, 'run_id'>>,
    attempts = 4,
  ): Promise<{ record: SubagentRecord | undefined; durable: boolean }> {
    // The ENTIRE transition — the "first terminal wins" check, the publish, AND the
    // durable convergence — runs inside ONE serialized step. Holding the per-run
    // lock across the persist (and its retry backoffs) is what makes it atomic
    // against a concurrent `delete` (the lifecycle prune): a delete for this run
    // queues BEHIND us, so it can never interleave between our publish and our
    // persist and let a delayed upsert resurrect the durable row after the row was
    // deleted. Cross-run mutations are unaffected (the lock is per run_id).
    return this.runSerial(run_id, async () => {
      const cur = this.byId.get(run_id)
      if (cur === undefined) return { record: undefined, durable: false }
      // Already terminal → that outcome WINS (a cancellation must never overwrite a
      // concurrent completion, nor vice-versa). No clobber, no re-persist.
      if (cur.status === 'finished' || cur.status === 'crashed' || cur.status === 'cancelled') {
        return { record: cur, durable: true }
      }
      // Publish the terminal patch synchronously. NOT via `update` — a terminal
      // live record must stay terminal even if the durable write later fails
      // (round 14), so there is no rollback here.
      const last_event_at = patch.last_event_at ?? Date.now()
      const next: SubagentRecord = { ...cur, ...patch, last_event_at }
      this.byId.set(run_id, next)

      // CONVERGE the durable write. Retry a TRANSIENT store failure (a brief I/O
      // blip / a lock the async busy-retry didn't outlast) so memory + store agree
      // and a restart's boot sweep skips the now-terminal row. NEVER roll memory
      // back (it is terminal + authoritative); if every retry fails return
      // `durable:false` (store stale, degraded process).
      if (this.persistence === undefined) {
        this.lastPersisted.set(run_id, next)
        return { record: next, durable: true }
      }
      for (let i = 0; i < attempts; i++) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await this.persistence.persist(next)
          this.lastPersisted.set(run_id, next)
          return { record: next, durable: true }
        } catch {
          if (i < attempts - 1) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 5 * (i + 1)))
          }
        }
      }
      return { record: next, durable: false }
    })
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

  delete(run_id: string): Promise<void> {
    // Serialized per run_id (ordered behind any in-flight create/update).
    return this.runSerial(run_id, async () => {
      // Remove FIRST: if the durable delete rejects, the record stays in BOTH the
      // store and the in-memory map (still in sync) rather than only the store.
      if (this.persistence !== undefined) await this.persistence.remove(run_id)
      this.byId.delete(run_id)
      this.lastPersisted.delete(run_id)
    })
  }

  /** Snapshot — used for tests + observability. */
  snapshot(): SubagentRecord[] {
    return [...this.byId.values()]
  }
}
