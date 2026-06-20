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
