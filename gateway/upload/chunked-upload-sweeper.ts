/**
 * @neutronai/gateway/upload — chunked-upload session sweeper.
 *
 * Long-lived `setInterval` that scans `upload_sessions` for rows whose
 * `expires_at` has passed AND status is still 'uploading'. For each one
 * the sweeper:
 *
 *   1. Unlinks the partial file at `<owner_home>/imports/<upload_id>.part`
 *      (best-effort — the file may already be gone if the row was
 *      half-cleaned-up).
 *   2. UPDATEs the row's status to 'expired' so subsequent HEAD / PATCH
 *      requests return 404 / 410 instead of operating on a missing file.
 *
 * Default tick is 5 minutes — far below the 24h session TTL so an
 * expired row never lingers more than `tick + ε` before its partial
 * file is gone. Tick is idempotent; missed ticks (gateway restart,
 * watchdog respawn) just process the backlog on the next tick.
 *
 * Mirrors the long-lived scheduler shape established by
 * `gateway/git/project-backup-scheduler.ts` — process-local setInterval,
 * `start()` is idempotent, `stop()` clears the timer and any in-flight
 * tick promise is allowed to drain. The per-instance boot registers
 * `stop()` in `realmode_cleanups` so SIGTERM tears it down cleanly.
 */

import { join } from 'node:path'

import { SupervisedLoop } from '@neutronai/loop'

import type { UploadSessionStore } from './upload-session-store.ts'

/** Default sweeper tick interval — 5 minutes. */
export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/** Default per-tick batch ceiling. Caps the work the sweeper does on
 *  any single tick so a large backlog (boot after a long downtime)
 *  drains over multiple ticks instead of pinning the loop. */
export const DEFAULT_SWEEP_BATCH_LIMIT = 100

export interface ChunkedUploadSweeperFs {
  unlink(path: string): Promise<void>
}

export interface ChunkedUploadSweeperDeps {
  store: UploadSessionStore
  owner_home: string
  project_slug: string
  fs?: ChunkedUploadSweeperFs
  intervalMs?: number
  batchLimit?: number
  now?: () => number
  /** Tick seam: when set, the sweeper calls this instead of `setInterval`.
   *  Tests use it to invoke `runOnce()` directly without real timers. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Sweeper instance — one per instance gateway. Construct + `start()`
 * at boot; register `stop()` in `realmode_cleanups` so SIGTERM clears
 * the interval.
 */
export class ChunkedUploadSweeper {
  private readonly deps: ChunkedUploadSweeperDeps
  private inflight: Promise<void> | null = null
  /** Loop scaffolding — single-flight interval, per-tick catch-all, and the
   *  quiescing `stop()` (§F1). The sweep body + its own re-entrant coalesce
   *  (below) are unchanged. */
  private readonly loop: SupervisedLoop

  constructor(deps: ChunkedUploadSweeperDeps) {
    this.deps = deps
    const setTimer = deps.setTimer
    const clearTimer = deps.clearTimer
    this.loop = new SupervisedLoop({
      name: 'chunked-upload-sweeper',
      intervalMs: deps.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
      // Drive the coalescing `runOnce()` — the loop's single-flight prevents
      // overlapping loop-driven ticks, and `runOnce`'s own coalesce keeps a
      // direct caller from double-processing a still-in-flight sweep.
      tick: () => this.runOnce(),
      ...(setTimer !== undefined ? { setTimer } : {}),
      ...(clearTimer !== undefined ? { clearTimer } : {}),
    })
  }

  start(): void {
    this.loop.start()
  }

  /** Stop + quiesce: awaits the in-flight sweep so a SIGTERM teardown can run
   *  after `await stop()` without a half-processed batch. Drains BOTH the
   *  loop-driven tick (`loop.stop()`) AND any sweep started directly through the
   *  public `runOnce()` — those coalesce on `this.inflight`, which the loop does
   *  not track, so a manually-triggered sweep must be awaited here too. */
  async stop(): Promise<void> {
    await this.loop.stop()
    const sweep = this.inflight
    if (sweep !== null) {
      // `runOnceInner` swallows its own row-level errors and never rejects; the
      // catch is defensive so quiesce can't throw.
      try {
        await sweep
      } catch {
        /* unreachable — the sweep body contains its own errors */
      }
    }
  }

  /**
   * Run a single sweep tick. Returns a promise that resolves when the
   * scan + cleanup batch is complete. Re-entrant ticks (a slow disk
   * unlink straddling the next interval) are coalesced: a tick that
   * fires while one is already in flight is a no-op so we don't
   * double-process the same expired rows.
   */
  async runOnce(): Promise<void> {
    if (this.inflight !== null) return await this.inflight
    this.inflight = this.runOnceInner()
    try {
      await this.inflight
    } finally {
      this.inflight = null
    }
  }

  private async runOnceInner(): Promise<void> {
    const now = (this.deps.now ?? Date.now)()
    const batchLimit = this.deps.batchLimit ?? DEFAULT_SWEEP_BATCH_LIMIT
    let rows
    try {
      rows = await this.deps.store.listExpiredUploading(now, batchLimit)
    } catch (err) {
      console.warn(
        `[chunked-upload-sweeper] project=${this.deps.project_slug} listExpiredUploading failed (will retry next tick): ${errMsg(err)}`,
      )
      return
    }
    if (rows.length === 0) return
    const fsImpl = this.deps.fs ?? (await resolveDefaultSweeperFs())
    for (const row of rows) {
      const partial = join(this.deps.owner_home, 'imports', `${row.upload_id}.part`)
      try {
        await fsImpl.unlink(partial)
      } catch (err) {
        // ENOENT is the expected case when the row was created but the
        // file write never landed (e.g. crash between store.create and
        // the first PATCH). Anything else gets logged but doesn't block
        // the markExpired — leaving the row uploading would have the
        // next tick re-try forever.
        const msg = errMsg(err)
        if (!/ENOENT|no such file/i.test(msg)) {
          console.warn(
            `[chunked-upload-sweeper] project=${this.deps.project_slug} unlink(${partial}) failed (non-fatal): ${msg}`,
          )
        }
      }
      try {
        await this.deps.store.markExpired(row.upload_id)
      } catch (err) {
        console.warn(
          `[chunked-upload-sweeper] project=${this.deps.project_slug} markExpired(${row.upload_id}) failed (will retry next tick): ${errMsg(err)}`,
        )
      }
    }
    console.info(
      `[chunked-upload-sweeper] project=${this.deps.project_slug} swept count=${rows.length}`,
    )
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

let _defaultSweeperFsPromise: Promise<ChunkedUploadSweeperFs> | null = null
async function resolveDefaultSweeperFs(): Promise<ChunkedUploadSweeperFs> {
  if (_defaultSweeperFsPromise === null) {
    _defaultSweeperFsPromise = (async () => {
      const mod = await import('node:fs/promises')
      return { unlink: (path) => mod.unlink(path) }
    })()
  }
  return _defaultSweeperFsPromise
}
