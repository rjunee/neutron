/**
 * heartbeat-watchdog.ts — 100ms liveness signal + event-loop-block detector.
 *
 * LIFTED from Nova `gateway/heartbeat-watchdog.ts` (substrate-lift S2 § 2 row
 * #14 / § 6 acceptance #5, ◆ ADAPTED-AT-BOUNDARY). The tick body, the
 * `utimesSync`-FIRST ordering, and the DI surface are kept verbatim. ONLY
 * delta: Nova's `onBlock` default routed through `event-loop-monitor.ts`'s
 * call-site-attribution ring buffer (`recordBlock`/`formatBlockLogLine`); that
 * module is Nova-gateway-specific and is NOT lifted, so the default `onBlock`
 * here logs the elapsed block directly to stderr. Callers that want richer
 * attribution inject their own `onBlock`.
 *
 * Under prod systemd the external supervisor is `Type=notify` /
 * `WatchdogSec=10` → `sd_notify(WATCHDOG=1)`; the gateway wires `onBlock`/the
 * tick to ALSO ping sd_notify (see `gateway/sd-notify.ts`). Here we own the
 * mtime-touch path that an external `health-check` (or systemd `WatchdogSec`)
 * reads to decide the process is alive.
 *
 * Why a sub-ms `utimesSync` at 10×/s instead of a 10s HTTP probe: filesystem
 * metadata updates don't race with TCP accept-queue drain and reflect actual
 * event-loop liveness — if `setInterval(..., 100)` fires at all the mtime
 * advances. A dead process stops writing; the supervisor notices within its
 * window. The `utimesSync` runs FIRST so a costly block-warning never delays
 * the freshness signal — the load-bearing ordering invariant the test pins.
 */

import { createLogger } from '@neutronai/logger'
import { closeSync, openSync, utimesSync } from 'node:fs'

export interface HeartbeatWatchdogDeps {
  /** Absolute path to the heartbeat file. */
  heartbeatFile: string
  /** Cadence for heartbeat writes (ms). Defaults to 100. */
  intervalMs?: number
  /** Threshold above which a tick is logged as an event-loop block (ms). */
  blockWarnMs?: number
  /** DI: setInterval shim so tests can advance the clock manually. */
  setIntervalFn?: (cb: () => void, ms: number) => unknown
  /** DI: clearInterval shim; must accept whatever setIntervalFn returned. */
  clearIntervalFn?: (handle: unknown) => void
  /** DI: monotonic time source (ns). Defaults to Bun.nanoseconds(). */
  nowNs?: () => bigint
  /** Called when tick-to-tick elapsed exceeds blockWarnMs. Default logs to
   *  stderr. */
  onBlock?: (elapsedMs: number) => void
  /** Called on the first heartbeat write failure per instance. Subsequent
   *  failures are swallowed so a persistent FS error doesn't spam at 10×/s. */
  onWriteError?: (err: unknown) => void
  /** Called by touchHeartbeatFile when the file is absent and must be created.
   *  DI so tests don't write a real path. */
  createIfMissing?: (path: string) => void
  /** DI: actual utimesSync. Default is fs.utimesSync. */
  utimes?: (path: string, atime: Date, mtime: Date) => void
}

export interface HeartbeatWatchdog {
  /** Stop the tick. Idempotent. */
  stop(): void
}

const log = createLogger('heartbeat-watchdog')

const DEFAULT_INTERVAL_MS = 100
const DEFAULT_BLOCK_WARN_MS = 500

function defaultCreateIfMissing(path: string): void {
  const fd = openSync(path, 'w', 0o600)
  closeSync(fd)
}

/**
 * Touch the heartbeat file synchronously, creating it if absent. Called once at
 * boot BEFORE the watchdog tick starts so the supervisor sees a fresh mtime
 * during the gateway's own boot window and doesn't fire a restart on top of the
 * one in progress.
 */
export function touchHeartbeatFile(
  path: string,
  opts?: {
    createIfMissing?: (path: string) => void
    utimes?: (p: string, a: Date, m: Date) => void
  },
): void {
  const utimes = opts?.utimes ?? utimesSync
  const createIfMissing = opts?.createIfMissing ?? defaultCreateIfMissing
  try {
    const now = new Date()
    utimes(path, now, now)
  } catch (e: unknown) {
    const code = (e as { code?: string } | null)?.code
    if (code === 'ENOENT') {
      createIfMissing(path)
      const now = new Date()
      utimes(path, now, now)
      return
    }
    throw e
  }
}

export function startHeartbeatWatchdog(deps: HeartbeatWatchdogDeps): HeartbeatWatchdog {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const blockWarnMs = deps.blockWarnMs ?? DEFAULT_BLOCK_WARN_MS
  const setIntervalFn =
    deps.setIntervalFn ?? ((cb: () => void, ms: number) => globalThis.setInterval(cb, ms))
  const clearIntervalFn =
    deps.clearIntervalFn ??
    ((handle: unknown) =>
      globalThis.clearInterval(handle as Parameters<typeof globalThis.clearInterval>[0]))
  const nowNs: () => bigint = deps.nowNs ?? (() => BigInt(Bun.nanoseconds()))
  const utimes = deps.utimes ?? utimesSync
  const createIfMissing = deps.createIfMissing ?? defaultCreateIfMissing
  const onBlock =
    deps.onBlock ??
    ((elapsedMs: number) => {
      log.error('event_loop_block_detected', { elapsed_ms: Math.round(elapsedMs) })
    })
  const onWriteError =
    deps.onWriteError ??
    ((err: unknown) => {
      log.error('heartbeat_write_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })

  // Prime the file so the supervisor sees a fresh mtime before the first tick.
  try {
    touchHeartbeatFile(deps.heartbeatFile, { utimes, createIfMissing })
  } catch (e) {
    onWriteError(e)
  }

  let lastTickNs = nowNs()
  let writeErrorLogged = false

  const tick = (): void => {
    // utimesSync FIRST, before any block detection. A slow detector tick (e.g.
    // console.error flushing a long stack trace) must not starve the freshness
    // signal — that's what the whole mtime-based watchdog exists to catch.
    try {
      const now = new Date()
      utimes(deps.heartbeatFile, now, now)
    } catch (e) {
      if (!writeErrorLogged) {
        onWriteError(e)
        writeErrorLogged = true
      }
    }

    const nowTs = nowNs()
    const elapsedMs = Number(nowTs - lastTickNs) / 1_000_000
    if (elapsedMs > blockWarnMs) {
      try {
        onBlock(elapsedMs)
      } catch {
        // Never let a block handler throw out of the interval.
      }
    }
    lastTickNs = nowTs
  }

  const handle = setIntervalFn(tick, intervalMs)

  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      clearIntervalFn(handle)
    },
  }
}
