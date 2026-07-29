/**
 * @neutronai/tools — long-running process registry.
 *
 * Lifts the survival-across-
 * restarts pattern from Hermes `tools/process_registry.py` (~57 KB) and
 * pairs with `gateway/orphan-adoption.ts`.
 *
 * Tools that spawn child subprocesses (shell exec, langlang server, codex
 * CLI etc.) register the PID + metadata here; the registry serves three
 * purposes:
 *
 *   1. Cleanup on graceful shutdown — `killAll()` SIGTERMs every live PID
 *      so the process tree drains cleanly under systemd `KillMode=process`.
 *   2. Cancellation — `kill(name)` lets a user / agent abort one running
 *      process by handle name.
 *   3. Observability — `list()` is what `/admin/processes` and the
 *      stuck-agent watchdog consume.
 *
 * State is in-memory; survival across restarts is delegated to the orphan-
 * adoption layer (which discovers child PIDs from the kernel). This module
 * is the within-process bookkeeping.
 */

import { createLogger } from '@neutronai/logger'

const log = createLogger('process-registry')

export interface ProcessRecord {
  /** Caller-chosen handle. Unique per registry. */
  name: string
  pid: number
  /** Wall-clock unix-ms at registration. */
  started_at: number
  /** Last activity timestamp. Updated by the owner via `touch(name)`. */
  last_activity_at: number
  /** Tool name that spawned this process (for grouping in observability). */
  tool_name: string
  /** Optional metadata for ad-hoc fields. */
  meta: Record<string, string>
  /**
   * Set to `'crashed'` by the spawn exit handler when a child exited ABNORMALLY
   * (non-zero code / an external signal we did not send). The crashed-agent
   * watchdog reports such a record once and reaps it on commit. A cleanly-exited
   * or intentionally-terminated child is unregistered outright, so it never
   * carries this. Absent while the process is live.
   */
  exit_status?: 'crashed'
  /**
   * Wall-clock unix-ms at which this process's CURRENTLY-OUTSTANDING dispatched
   * turn began, or `null` when the process has no outstanding work.
   *
   * THIS — not `last_activity_at` — is what "stuck" is measured against. A warm
   * pooled REPL exists precisely to sit QUIET between turns so the next message
   * skips a cold start, so silence is its normal RESTING state, not a symptom.
   * Judging it on output-age alerted forever on correct, healthy, by-design
   * behaviour (26 false `stuck_agent` alerts on Ryan's install against two
   * verified-alive `cc-repl` PTYs, 2026-07-18). A record with `busy_since ===
   * null` is NEVER stuck; a record whose TURN started longer ago than the
   * threshold is stuck even if the child has been chattering the whole time
   * (which is the genuine wedge this detector exists to catch).
   */
  busy_since: number | null
  /**
   * The `ActiveTurn.turnId` (`<incarnation>:<seq>`) owning {@link busy_since},
   * or `null` when idle. Settling is guarded on it so a late settle from a
   * superseded/cancelled turn cannot clear the marker of the turn that replaced
   * it (which would blind the detector to a real wedge).
   */
  busy_turn_id: string | null
}

export interface ProcessRegisterInput {
  name: string
  pid: number
  tool_name: string
  meta?: Record<string, string>
}

/**
 * How long a DISPATCHED TURN may stay outstanding before the stuck-agent
 * watchdog judges it stuck. Exposed so the watchdog can bind it directly.
 * Default matches Nova's 15-minute stuck-agent threshold
 * (`gateway/topic-process.ts` lifecycle).
 *
 * Measured from `busy_since` (turn start), NOT from `last_activity_at`
 * (output age) — see {@link ProcessRecord.busy_since} for why.
 */
export const STUCK_PROCESS_INACTIVITY_MS = 15 * 60_000

/** Composite identity key for a process — `(name, pid)`, never name alone. */
const procRegistryKey = (name: string, pid: number): string => `${name}#${pid}`

export class ProcessRegistry {
  private readonly records = new Map<string, ProcessRecord>()
  /**
   * Un-reported crashes, keyed by `(name, pid)` — INDEPENDENT of the single mutable
   * live `records` slot (round-12). An abnormal exit ENQUEUES its crash here rather
   * than marking the live record in place, so a fast respawn that reuses the same
   * `name` (upsert → delete+register) can no longer erase a crash before the 30 s
   * crashed-agent detector drains it. The detector reports each entry once and
   * reaps it on commit ({@link reapCrash}); multiple rapid respawns each enqueue a
   * distinct `(name, pid)` crash.
   */
  private readonly pendingCrashes = new Map<string, ProcessRecord>()
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  /**
   * Register a child process under `name`. Throws if `name` is taken — same
   * loud-on-collision philosophy as `ToolRegistry`.
   */
  register(input: ProcessRegisterInput): ProcessRecord {
    if (this.records.has(input.name)) {
      throw new Error(`process '${input.name}' is already registered`)
    }
    const t = this.now()
    const record: ProcessRecord = {
      name: input.name,
      pid: input.pid,
      tool_name: input.tool_name,
      started_at: t,
      last_activity_at: t,
      meta: { ...(input.meta ?? {}) },
      busy_since: null,
      busy_turn_id: null,
    }
    this.records.set(input.name, record)
    return record
  }

  /** Update last-activity timestamp. Called by the process owner on every event. */
  touch(name: string): void {
    const r = this.records.get(name)
    if (!r) return
    r.last_activity_at = this.now()
  }

  /**
   * Bump activity ONLY when the entry STILL points at `pid` — identity-guarded so
   * a late event from an OLD child cannot refresh the NEW child a respawn
   * installed under the same `name`. Returns true only when the matching entry was
   * touched.
   */
  touchIfPid(name: string, pid: number): boolean {
    const r = this.records.get(name)
    if (r === undefined || r.pid !== pid) return false
    r.last_activity_at = this.now()
    return true
  }

  /**
   * Mark the entry as having an OUTSTANDING dispatched turn, stamping
   * `busy_since` at now. Identity-guarded on `pid` (same contract as
   * {@link touchIfPid}) so a late start from an OLD child cannot mark the NEW
   * child a respawn installed under the same `name`. Re-marking an already-busy
   * entry with a DIFFERENT turn re-stamps it — the newer turn is the one now
   * outstanding, and its age is what matters. Returns true only when the
   * matching entry was marked.
   */
  markTurnStarted(name: string, pid: number, turn_id: string): boolean {
    const r = this.records.get(name)
    if (r === undefined || r.pid !== pid) return false
    r.busy_since = this.now()
    r.busy_turn_id = turn_id
    return true
  }

  /**
   * Clear the outstanding-turn marker. Identity-guarded on BOTH `pid` AND
   * `turn_id`: a settle from a superseded turn (a cancelled/timed-out
   * predecessor whose driver unwinds after the next turn already started) must
   * NOT clear the successor's marker, or a genuinely wedged turn would go
   * unreported. Returns true only when the exact `(pid, turn_id)` was cleared.
   */
  markTurnSettled(name: string, pid: number, turn_id: string): boolean {
    const r = this.records.get(name)
    if (r === undefined || r.pid !== pid || r.busy_turn_id !== turn_id) return false
    r.busy_since = null
    r.busy_turn_id = null
    return true
  }

  /**
   * Send SIGTERM and forget. Returns true if the process was registered,
   * false otherwise. Idempotent (SIGTERM to a dead PID is a no-op kill(2)
   * EAGAIN/ESRCH which we swallow).
   */
  kill(name: string): boolean {
    const r = this.records.get(name)
    if (!r) return false
    try {
      process.kill(r.pid, 'SIGTERM')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ESRCH' && code !== 'EPERM') {
        log.error('kill_failed', {
          name,
          pid: r.pid,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        })
      }
    }
    this.records.delete(name)
    return true
  }

  /** Drop a record without sending a signal. Used after natural exit. */
  unregister(name: string): boolean {
    return this.records.delete(name)
  }

  /**
   * Drop a record ONLY when it STILL points at `pid` — identity-guarded so a
   * concurrently-respawned entry that re-used the same `name` under a NEW pid is
   * never clobbered. Mirrors the spawn.ts exit-path `childByKey` identity guard
   * (`if (childByKey.get(key) === child) …`) but keys on pid, which is all the
   * crashed-agent detector carries across its detect→persist→deliver→commit gap.
   * Returns true only when the exact detected entry was removed.
   */
  unregisterIfPid(name: string, pid: number): boolean {
    const r = this.records.get(name)
    if (r === undefined || r.pid !== pid) return false
    return this.records.delete(name)
  }

  /**
   * ENQUEUE a crash (round-12). Records an abnormally-exited child in the durable
   * {@link pendingCrashes} queue — keyed by `(name, pid)`, INDEPENDENT of the live
   * `records` slot — so a respawn that overwrites the slot cannot erase it before
   * the detector's next tick. Idempotent per `(name, pid)`. Also drops the matching
   * live record if it is STILL this exact `(name, pid)` (identity-guarded), so the
   * detector's defensive dead-pid pass can't ALSO report it (no double-report); a
   * respawn that already replaced the slot is left untouched. `record` is the
   * child's captured registration (see `registerLiveProcessSafe`), so this works
   * even when the live slot was already overwritten by a fast respawn.
   */
  enqueueCrash(record: ProcessRecord): void {
    this.pendingCrashes.set(procRegistryKey(record.name, record.pid), {
      ...record,
      exit_status: 'crashed',
    })
    const live = this.records.get(record.name)
    if (live !== undefined && live.pid === record.pid) this.records.delete(record.name)
  }

  /** Snapshot of the un-reported crashes the crashed-agent detector drains. */
  listPendingCrashes(): ProcessRecord[] {
    return [...this.pendingCrashes.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Reap a reported crash from the pending queue, identity-guarded on `(name, pid)`
   * — called by the detector's commit-after-delivery. Returns true only when the
   * exact entry was removed.
   */
  reapCrash(name: string, pid: number): boolean {
    return this.pendingCrashes.delete(procRegistryKey(name, pid))
  }

  /** SIGTERM every registered process. Returns the count signalled. */
  killAll(): number {
    const names = [...this.records.keys()]
    for (const n of names) this.kill(n)
    return names.length
  }

  /** Snapshot. Sorted by name for deterministic output. */
  list(): ProcessRecord[] {
    return [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Snapshot of records with an OUTSTANDING dispatched turn that started longer
   * than `threshold_ms` ago — i.e. a turn that stopped progressing.
   *
   * Deliberately NOT an age filter over `last_activity_at`: that field answers
   * "when did this process last EMIT OUTPUT", and for a request/response REPL
   * silence is the normal resting state between turns, so filtering on it
   * reported every healthy idle warm session as stuck, forever. A record with
   * `busy_since === null` has no outstanding work and is never stuck.
   */
  listStuck(threshold_ms: number = STUCK_PROCESS_INACTIVITY_MS): ProcessRecord[] {
    const cutoff = this.now() - threshold_ms
    return this.list().filter((r) => r.busy_since !== null && r.busy_since < cutoff)
  }

  size(): number {
    return this.records.size
  }
}

// ── Ambient live-process registry (F4) ──────────────────────────────────────
//
// The subprocess spawn sites that should feed child PIDs into the watchdog's
// live-process view (`runtime/adapters/claude-code/persistent/spawn.ts` — the
// single PTY chokepoint serving BOTH the pooled REPL and the ephemeral/dispatch
// children) are deep in the runtime-adapter band and have NO dependency-injection
// seam to the gateway module that owns the `ProcessRegistry`. So they reach it
// through this process-wide ambient accessor — the SAME ambient-registry pattern
// O4's `system_events` sink established (`persistence/system-events.ts`) for its
// equally-scattered degrade sites.
//
// CONSISTENCY, NOT A SECOND TRUTH. The `ProcessRegistry` is a pure OS-process
// LIVENESS PROJECTION the stuck/crashed detectors READ (+ the crashed detector
// reaps dead entries as bookkeeping). It NEVER drives a dispatch's lifecycle —
// that authority is P7's persisted `SubagentRegistry`. Entries are registered on
// the real subprocess spawn and unregistered on its real exit, so this view
// cannot diverge from the OS reality it observes.
//
// SINGLE-OWNER: neutron-open runs one gateway boot per OS process, so the stack
// normally holds exactly one registry. It is a STACK (mirroring the O4 sink) only
// so overlapping test boots tear down in any order without orphaning a live older
// boot; production pushes once at boot and clears on shutdown.

const ambientRegistryStack: ProcessRegistry[] = []

/**
 * Publish `registry` as the ambient live-process registry and return an
 * idempotent deregister that removes THIS registry (by identity, from any stack
 * position). The gateway's `process-registry` module pushes once at boot and
 * clears on shutdown.
 */
export function pushAmbientProcessRegistry(registry: ProcessRegistry): () => void {
  ambientRegistryStack.push(registry)
  let removed = false
  return (): void => {
    if (removed) return
    removed = true
    const i = ambientRegistryStack.lastIndexOf(registry)
    if (i !== -1) ambientRegistryStack.splice(i, 1)
  }
}

/** The top (most-recently-pushed still-live) ambient registry, or null when none. */
export function resolveAmbientProcessRegistry(): ProcessRegistry | null {
  return ambientRegistryStack.length > 0
    ? (ambientRegistryStack[ambientRegistryStack.length - 1] ?? null)
    : null
}

/**
 * A handle bound to the SPECIFIC registry + `(name, pid)` a child was registered
 * into. Its `touch`/`unregister` operate on THAT registry and THAT entry — never
 * the current top-of-stack — so an old child's late touch or exit cannot mutate a
 * DIFFERENT registry that a newer gateway boot pushed after this child registered
 * (the ambient-stack clobber, High 2). Both operations identity-guard on the
 * captured pid, so even within the same registry a respawn that replaced `name`
 * with a new pid is never touched or dropped by the old child's handle.
 */
export interface LiveProcessHandle {
  /** Refresh last-activity — no-op unless the owned `(registry, name, pid)` is still current. */
  touch(): void
  /** Drop the owned entry (clean/expected exit) — no-op unless `(registry, name, pid)` is still current. */
  unregister(): void
  /**
   * Mark the owned entry crashed (abnormal exit) and LEAVE it registered so the
   * crashed-agent watchdog can report it once — no-op unless `(registry, name,
   * pid)` is still current (a respawn that replaced it is untouched).
   */
  markCrashed(): void
  /**
   * Declare a dispatched turn OUTSTANDING on the owned entry — the clock the
   * stuck-agent detector actually measures. No-op unless `(registry, name, pid)`
   * is still current.
   */
  markTurnStarted(turnId: string): void
  /**
   * Clear the outstanding-turn marker for `turnId`. MUST be called from a
   * `finally` at the dispatch site so an exception, cancellation, or timeout
   * cannot latch `busy_since` forever — a latched marker would recreate this bug
   * in mirror image (permanent alerts instead of permanent silence). The
   * child-exit paths drop the record wholesale, which covers process death.
   * No-op unless `(registry, name, pid)` is current AND `turnId` is the turn
   * currently marked.
   */
  markTurnSettled(turnId: string): void
}

/** Handle returned when there is no ambient registry to write into. */
const NOOP_LIVE_PROCESS_HANDLE: LiveProcessHandle = {
  touch(): void {},
  unregister(): void {},
  markCrashed(): void {},
  markTurnStarted(): void {},
  markTurnSettled(): void {},
}

/**
 * Register a live child process into the ambient registry — GUARDED so it can
 * NEVER throw into a spawn path — and return a {@link LiveProcessHandle} bound to
 * the registry this write landed in plus the child's `(name, pid)`. UPSERT
 * semantics: an existing entry under `name` (e.g. a respawn re-using the same
 * session key while the old child's exit handler hasn't fired yet) is replaced
 * rather than colliding, so the live-process view tracks the newest child. Returns
 * a no-op handle when no ambient registry is registered (unit tests, sidecar
 * tools, an LLM-less box).
 */
export function registerLiveProcessSafe(input: ProcessRegisterInput): LiveProcessHandle {
  try {
    const reg = resolveAmbientProcessRegistry()
    if (reg === null) return NOOP_LIVE_PROCESS_HANDLE
    reg.unregister(input.name)
    // Capture the OWNING registry + the child's OWN registered record, so
    // touch/unregister/markCrashed below bind to THIS registry and THIS child —
    // not whatever is top-of-stack, nor whatever record a later respawn installed
    // under the same name. `record` is retained by this closure, so markCrashed can
    // enqueue the crash even after a fast respawn overwrote the live slot (round-12).
    const record = reg.register(input)
    const owner = reg
    const name = input.name
    const pid = input.pid
    return {
      touch(): void {
        try {
          owner.touchIfPid(name, pid)
        } catch {
          // Observability write — must never perturb the spawn it observes.
        }
      },
      unregister(): void {
        try {
          owner.unregisterIfPid(name, pid)
        } catch {
          // swallow
        }
      },
      markCrashed(): void {
        try {
          owner.enqueueCrash(record)
        } catch {
          // swallow
        }
      },
      markTurnStarted(turnId: string): void {
        try {
          owner.markTurnStarted(name, pid, turnId)
        } catch {
          // Observability write — must never perturb the turn it observes.
        }
      },
      markTurnSettled(turnId: string): void {
        try {
          owner.markTurnSettled(name, pid, turnId)
        } catch {
          // swallow
        }
      },
    }
  } catch {
    // Observability write — must never perturb the spawn it observes.
    return NOOP_LIVE_PROCESS_HANDLE
  }
}
