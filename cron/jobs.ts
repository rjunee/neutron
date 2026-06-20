/**
 * @neutronai/cron — declarative cron job definitions.
 *
 * Replaces Nova's
 * `cron/jobs.yaml` with a TS-native registry. The locked Linux-only
 * deployment means systemd timers underneath; this module is the input.
 *
 * The 6 infrastructure crons documented in the master Nova brief
 * (health-check, vault-backup, cc-update-doctor, task-scanner,
 * vault-hygiene, overnight-sync-issues) are the model — but Neutron
 * trims health-check (replaced by systemd's WatchdogSec) and re-shapes
 * the rest to be instance-scoped.
 *
 * Job authoring:
 *   - `name` is the declarative id, ASCII alnum + dashes.
 *   - `schedule` is a systemd OnCalendar expression OR an interval shape.
 *   - `handler` is the module-relative entry point name; the handler
 *     registry resolves it at fire time via `cron/handlers.ts`.
 *   - `expected_duration_ms` feeds the overrun-cron watchdog (cron mode).
 */

export type CronSchedule =
  | { kind: 'oncalendar'; expression: string }
  | { kind: 'interval_ms'; interval_ms: number }

export interface CronJobDef {
  name: string
  description: string
  schedule: CronSchedule
  /** Module-relative entry point name, registered via handlers.ts. */
  handler: string
  /** Watchdog overrun threshold (ms). Default 10 minutes. */
  expected_duration_ms?: number
  /** Whether to skip the next run if the previous one is still in-flight. */
  skip_if_running?: boolean
}

/** ASCII alnum + dash, 1-64 chars. Mirrors systemd unit-name validation. */
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/

export function validateJobName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`cron job name '${name}' is invalid (must match ${NAME_RE.source})`)
  }
}

/**
 * Listener invoked by `CronJobRegistry.register(...)` immediately after a
 * new job lands in the map. Used by `CronScheduler` to bind a setInterval
 * for jobs registered AFTER the scheduler's initial `start()` snapshot.
 *
 * S15 (2026-05-17) follow-up — Codex r1 P1: without this hook, runtime
 * registrations (notably `wow-overnight-<slug>` from
 * `onboarding/wow-moment/actions/07-overnight-pass.ts`) silently land in
 * the registry but never bind a timer. The scheduler's one-shot
 * `start()` only iterates the registry once at boot; a post-boot
 * register would otherwise be invisible until the next gateway restart.
 */
export type CronJobRegisterListener = (def: CronJobDef) => void

export class CronJobRegistry {
  private readonly jobs = new Map<string, CronJobDef>()
  private readonly onRegisterListeners: CronJobRegisterListener[] = []

  register(def: CronJobDef): void {
    validateJobName(def.name)
    if (this.jobs.has(def.name)) {
      throw new Error(`cron job '${def.name}' is already registered`)
    }
    this.jobs.set(def.name, def)
    for (const listener of this.onRegisterListeners) {
      try {
        listener(def)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[cron-jobs] register-listener threw for job '${def.name}': ${msg}`,
        )
      }
    }
  }

  /**
   * Subscribe to subsequent `register(...)` calls. The listener fires
   * AFTER the job is added to the map so handlers can read the registry
   * mid-callback. Listener exceptions are caught + logged; one bad
   * subscriber does NOT block other subscribers.
   *
   * Idempotent w.r.t. duplicate listeners: passing the same function
   * twice will fire it twice on each register. Callers that want to
   * deduplicate should keep their own bookkeeping.
   *
   * Registration order is "subscriber wins" — listeners attached AFTER
   * a job has already been registered do NOT receive a retroactive
   * call. The scheduler attaches its listener in its constructor (before
   * any registrations) so this is the right semantics for the wow-
   * overnight case.
   */
  onRegister(listener: CronJobRegisterListener): void {
    this.onRegisterListeners.push(listener)
  }

  get(name: string): CronJobDef | undefined {
    return this.jobs.get(name)
  }

  list(): CronJobDef[] {
    return [...this.jobs.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  size(): number {
    return this.jobs.size
  }
}
