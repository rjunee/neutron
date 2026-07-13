/**
 * @neutronai/loop — LoopRegistry (world-class refactor §F2).
 *
 * A tiny inventory of every long-lived in-process tick loop. Before F2 the only
 * boot-time visibility into the loop mesh was cron's ad-hoc
 * `[cron-scheduler] … N job(s) ticking` line (S15); the reminders tick loop, the
 * trident tick loop, the watchdog supervisor, and the chunked-upload sweeper all
 * started silently, and — worse — the audit (D-7) found TWO fully-built loops
 * (`ProjectBackupScheduler`, comments `AgentWatcher`) that never start in ANY
 * composition, with nothing surfacing that fact.
 *
 * `LoopRegistry` generalises cron's boot alarm to EVERY loop:
 *
 *   • each long-lived loop registers a {@link LoopDescriptor}
 *     — `(name, cadenceMs, startedAt, health() → { lastTickAt, lastError })` —
 *     the moment it is started in the composition;
 *   • ONE boot log line ({@link LoopRegistry.bootLine}) inventories the running
 *     loops (subsuming cron's ad-hoc line), plus the KNOWN-dormant set so a
 *     deferred-but-not-obsolete loop is EXPLICITLY dormant, never silently dead;
 *   • the exact set of registered loops is PINNED by a production-composer test
 *     (the ISSUE-#32 "assert the set, not archaeology" pattern applied to loops)
 *     — a future silently-added OR silently-removed loop fails that test, and a
 *     duplicate-name registration throws at boot.
 *
 * The registry owns ONLY the inventory. Each loop keeps its own driver
 * ({@link SupervisedLoop}, cron's per-job timers, the watchdog supervisor's
 * setInterval) and exposes a `describe()` that hands back a live descriptor.
 */

/** Live health snapshot for one loop. */
export interface LoopHealth {
  /** Epoch-ms of the most recent completed tick, or null before the first tick. */
  readonly lastTickAt: number | null
  /** The error thrown by the most recent failing tick (null when healthy). */
  readonly lastError: unknown
}

/**
 * A long-lived loop's inventory entry. `startedAt` + `cadenceMs` are captured at
 * registration; `health()` returns a LIVE snapshot each call so an observability
 * surface (or a future admin panel) reflects the loop's current state.
 */
export interface LoopDescriptor {
  /** Stable identifier, unique within a registry (dup → throw at register). */
  readonly name: string
  /**
   * Nominal interval between ticks (ms). `0` means "variable / per-job" (cron,
   * whose N jobs each carry their own interval / calendar cadence).
   */
  readonly cadenceMs: number
  /** Epoch-ms the loop was started (0 if it exposes no start clock). */
  readonly startedAt: number
  /** Live health snapshot (last tick / last error). */
  health(): LoopHealth
  /**
   * Optional one-line inventory detail appended in the boot line — cron uses it
   * to list its running job names so the S15 job-name observability survives the
   * generalisation.
   */
  detail?(): string
}

/**
 * A loop that is BUILT but deliberately NOT started in the current composition.
 * Per decision D-7 (2026-07-02 Decisions Log): the two dormant loops are
 * documented as dormant now and their real wiring is deferred to post-window
 * feature PRs (seeded into the SPEC roadmap). Enumerating them here makes the
 * dormancy EXPLICIT + boot-observable + test-pinned — the exact opposite of the
 * "silently never runs in ANY composition" anti-pattern F2 exists to kill.
 */
export interface DormantLoop {
  /** The dormant loop's stable name. */
  readonly name: string
  /** Why it is dormant (human-readable). */
  readonly reason: string
  /** The decision / follow-up that owns its real wiring. */
  readonly deferredTo: string
}

export class LoopRegistry {
  private readonly loops = new Map<string, LoopDescriptor>()

  /**
   * Register one running loop. Throws on a duplicate name — two loops claiming
   * the same identity is a wiring bug (a silently-added twin), caught at boot
   * rather than masked in the inventory.
   */
  register(descriptor: LoopDescriptor): void {
    if (this.loops.has(descriptor.name)) {
      throw new Error(
        `LoopRegistry: loop '${descriptor.name}' already registered — duplicate loop name`,
      )
    }
    this.loops.set(descriptor.name, descriptor)
  }

  /** Whether a loop of this name is registered. */
  has(name: string): boolean {
    return this.loops.has(name)
  }

  /** The descriptor for a loop, or undefined. */
  get(name: string): LoopDescriptor | undefined {
    return this.loops.get(name)
  }

  /** Every registered loop name, sorted — the SET a composer test pins. */
  names(): string[] {
    return [...this.loops.keys()].sort()
  }

  /** Every descriptor, sorted by name. */
  list(): LoopDescriptor[] {
    return this.names().map((n) => this.loops.get(n) as LoopDescriptor)
  }

  /** Number of registered loops. */
  size(): number {
    return this.loops.size
  }

  /**
   * The ONE boot inventory line. Lists every running loop (cron appends its job
   * names via `detail()`), and — when supplied — the known-dormant set so a
   * deferred loop is explicitly enumerated at boot instead of silently missing.
   * A `0 loop(s)` line flags a wiring regression the instant the gateway boots
   * (the S15 rationale, generalised).
   */
  bootLine(projectSlug: string, dormant: readonly DormantLoop[] = []): string {
    const running = this.list().map((d) => {
      const detail = d.detail?.()
      return detail !== undefined && detail.length > 0 ? `${d.name} (${detail})` : d.name
    })
    let line = `[loop-registry] project=${projectSlug} — ${this.size()} loop(s) running: [${running.join(', ')}]`
    if (dormant.length > 0) {
      const names = [...dormant].map((d) => d.name).sort()
      line += `; ${names.length} dormant (deferred): [${names.join(', ')}]`
    }
    return line
  }
}
