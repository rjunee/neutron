/**
 * @neutronai/cron — handler registry.
 *
 * Maps a `CronJobDef.handler`
 * string to an executable function. Registered at boot by the modules that
 * own the work (vault-backup → backup module, etc.). The scheduler resolves
 * via `get(name)` at fire time.
 *
 * Handlers receive a per-fire context and return a result tag (mostly for
 * structured logging — `cron_state` records the last status keyed off this).
 */

export type CronHandlerStatus = 'ok' | 'skipped' | 'error'

export interface CronHandlerContext {
  job_name: string
  owner_slug: string
  /** Wall-clock unix-ms when this fire began. */
  fired_at: number
}

export interface CronHandlerResult {
  status: CronHandlerStatus
  /** Optional human-readable detail for logs / observability. */
  detail?: string
}

export interface CronHandler {
  (ctx: CronHandlerContext): Promise<CronHandlerResult>
}

export class CronHandlerRegistry {
  private readonly handlers = new Map<string, CronHandler>()

  register(name: string, handler: CronHandler): void {
    if (this.handlers.has(name)) {
      throw new Error(`cron handler '${name}' is already registered`)
    }
    this.handlers.set(name, handler)
  }

  get(name: string): CronHandler | undefined {
    return this.handlers.get(name)
  }

  list(): string[] {
    return [...this.handlers.keys()].sort()
  }
}
