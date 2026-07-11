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
}

export interface ProcessRegisterInput {
  name: string
  pid: number
  tool_name: string
  meta?: Record<string, string>
}

/**
 * Inactivity threshold for the stuck-agent watchdog. Exposed so the
 * watchdog can bind it directly. Default matches Nova's 15-minute
 * stuck-agent threshold (`gateway/topic-process.ts` lifecycle).
 */
export const STUCK_PROCESS_INACTIVITY_MS = 15 * 60_000

export class ProcessRegistry {
  private readonly records = new Map<string, ProcessRecord>()
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
        console.error(`process-registry kill(${name}, pid=${r.pid}) failed:`, err)
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

  /** Snapshot of records whose last_activity_at is older than threshold_ms ago. */
  listStuck(threshold_ms: number = STUCK_PROCESS_INACTIVITY_MS): ProcessRecord[] {
    const cutoff = this.now() - threshold_ms
    return this.list().filter((r) => r.last_activity_at < cutoff)
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
  /** Drop the owned entry (natural exit) — no-op unless `(registry, name, pid)` is still current. */
  unregister(): void
}

/** Handle returned when there is no ambient registry to write into. */
const NOOP_LIVE_PROCESS_HANDLE: LiveProcessHandle = {
  touch(): void {},
  unregister(): void {},
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
    reg.register(input)
    // Capture the OWNING registry + identity now, so touch/unregister below bind
    // to THIS registry — not whatever is top-of-stack when they later fire.
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
    }
  } catch {
    // Observability write — must never perturb the spawn it observes.
    return NOOP_LIVE_PROCESS_HANDLE
  }
}
