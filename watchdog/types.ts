/**
 * @neutronai/watchdog — common types.
 *
 * The 6 logical watchdog types ported from Nova. The gateway-process
 * heartbeat watchdog from the old set is REPLACED by systemd's `WatchdogSec`
 * (the gateway-side ticker lives in `gateway/index.ts`); the 6 here are the
 * application-level conditions that can fire even when the gateway process
 * is alive.
 */

export type WatchdogKind =
  | 'gateway_heartbeat'
  | 'stuck_agent'
  | 'crashed_agent'
  | 'overrun_cron'
  | 'db_lock_contention'
  | 'substrate_cooldown_saturation'

export interface WatchdogAlert {
  id: string
  kind: WatchdogKind
  project_slug: string
  detected_at: number
  resolved_at: number | null
  payload: Record<string, unknown>
}

export interface WatchdogNotifier {
  /** Surface a fired alert (Telegram, admin channel, etc.). */
  notify(alert: WatchdogAlert): Promise<void>
}

/** A watchdog detector — pure function over current state → alerts to fire. */
export interface WatchdogDetector {
  kind: WatchdogKind
  /** Returns the alerts that should be fired now. Empty array = no fire. */
  detect(): Promise<WatchdogAlert[]>
}
