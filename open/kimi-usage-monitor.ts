/**
 * The Kimi subscription's standing, on a timer — the second pool's gauge.
 *
 * THE SHAPE IS THE ANTHROPIC MONITOR'S, deliberately: a supervised tick, an
 * injected sample sink, fail-soft persistence, and a tagged outcome per failure
 * mode (`credential-usage-monitor.ts`). Two gauges that age, refuse and persist
 * differently would be two different honesty stories on one screen.
 *
 * WHAT IS DIFFERENT, AND WHY:
 *
 *   - **Ten minutes, not sixty seconds.** Kimi serves one review lane, so its
 *     windows move slowly, and the endpoint is a real request rather than a
 *     one-token probe. The card renders the sample's age, so a slower cadence
 *     costs legibility nothing — `POOL_CADENCE_MS.kimi` is what turns that
 *     interval into the staleness rule, and a wiring test pins the two together.
 *   - **The key is read PER TICK from the credential store**, never captured at
 *     boot: the owner enters it in Settings, and a key that only took effect on
 *     the next restart would look broken in exactly the way this product keeps
 *     re-learning. No key is a quiet no-op — no request, no row, no error.
 *   - **The account is whatever the endpoint names**, and null otherwise. The
 *     endpoint is account-wide; per-key attribution is not obtainable from it and
 *     is never invented.
 *
 * A FAILED READ IS LOUD AND EMPTY. Every non-`ok` outcome writes NO row and logs
 * with its reason — an unrecognised payload logs the KEY NAMES it saw, which is
 * how the parser's alias list gets corrected from a real response instead of a
 * guess. The card then ages visibly, which is the whole point: a killed poller
 * must show an ageing number, never a confident zero.
 */

import { createLogger } from '@neutronai/logger'
import { SupervisedLoop } from '@neutronai/loop/index.ts'
import {
  probeKimiUsage,
  type KimiUsageProbeDeps,
  type KimiUsageProbeOutcome,
} from '@neutronai/trident/kimi-usage-probe.ts'

/**
 * How often to re-read. Kimi's windows are hours and days long and one review
 * lane draws on them, so a ten-minute lag is invisible; a tighter loop would buy
 * nothing and spend a real HTTP request every time.
 *
 * `POOL_CADENCE_MS.kimi` in `persistence/usage-samples-store.ts` MUST match this
 * — that constant is what decides when a Kimi reading starts rendering as stale.
 */
export const KIMI_USAGE_POLL_INTERVAL_MS = 10 * 60_000

const moduleLog = createLogger('kimi-usage')

/** One reading, in the store's own vocabulary. */
export interface KimiPersistedSample {
  account_label: string | null
  session: number | null
  weekly: number | null
  session_reset_at: number | null
  weekly_reset_at: number | null
  session_window_ms: number | null
  weekly_window_ms: number | null
}

export interface KimiUsageMonitorDeps {
  /**
   * The stored key, resolved fresh on every tick. Null = not configured, which is
   * a no-op rather than an error: an install without Kimi is an ordinary install.
   */
  key: () => string | null
  /** Told every SUCCESSFUL reading. Never called for a failure. */
  onSample?: (sample: KimiPersistedSample) => void | Promise<void>
  probe?: (key: string) => Promise<KimiUsageProbeOutcome>
  probeDeps?: KimiUsageProbeDeps
  /** `SupervisedLoop` timer seams, threaded straight through for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class KimiUsageMonitor {
  readonly loop: SupervisedLoop

  private readonly key: () => string | null
  private readonly onSample: ((s: KimiPersistedSample) => void | Promise<void>) | undefined
  private readonly probe: (key: string) => Promise<KimiUsageProbeOutcome>

  constructor(deps: KimiUsageMonitorDeps) {
    this.key = deps.key
    this.onSample = deps.onSample
    const probeDeps = deps.probeDeps
    this.probe =
      deps.probe ??
      ((key: string): Promise<KimiUsageProbeOutcome> => probeKimiUsage(key, probeDeps ?? {}))
    this.loop = new SupervisedLoop({
      name: 'kimi-usage',
      intervalMs: KIMI_USAGE_POLL_INTERVAL_MS,
      // Read at boot rather than ten minutes in: a restart must not blank the
      // card for the length of a poll interval.
      immediate: true,
      tick: async (): Promise<void> => {
        await this.measureOnce()
      },
      ...(deps.setTimer !== undefined ? { setTimer: deps.setTimer } : {}),
      ...(deps.clearTimer !== undefined ? { clearTimer: deps.clearTimer } : {}),
    })
  }

  /** One read. Exposed so tests drive ticks deterministically. */
  async measureOnce(): Promise<void> {
    let key: string | null
    try {
      key = this.key()
    } catch (err) {
      // An unreadable credential store is not a Kimi failure. Same posture as
      // `resolveKimiApiKey`: it resolves to "not configured", the graceful path.
      moduleLog.warn('kimi_key_lookup_threw', {
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (key === null || key.trim().length === 0) return
    const outcome = await this.probe(key)
    switch (outcome.kind) {
      case 'ok': {
        const { session, weekly, account_label } = outcome.sample
        await this.persist({
          account_label,
          session: session?.fraction ?? null,
          weekly: weekly?.fraction ?? null,
          session_reset_at: session?.reset_at ?? null,
          weekly_reset_at: weekly?.reset_at ?? null,
          // The lengths the response reported, carried per sample. Never a
          // constant: the two slots and the pace both depend on them, and the
          // series has to stay readable across a regime change.
          session_window_ms: session?.window_ms ?? null,
          weekly_window_ms: weekly?.window_ms ?? null,
        })
        return
      }
      case 'unauthorized':
        moduleLog.warn('kimi_usage_unauthorized', { status: outcome.httpStatus })
        return
      case 'unrecognised':
        // The key names, never the values. This line IS the "print a real value
        // before keying logic on it" step: one occurrence is enough to correct
        // the parser's alias list against the real endpoint.
        moduleLog.warn('kimi_usage_shape_unrecognised', { observed: outcome.observed.join(',') })
        return
      case 'error':
        moduleLog.warn('kimi_usage_probe_failed', { error: outcome.message })
        return
    }
  }

  /**
   * Hand the reading to the sink, fail-soft — the same posture as the Anthropic
   * monitor's, and for the same reason: the sink touches a database and can
   * throw, while repeated tick failures escalate the loop. Losing one row from a
   * ten-minute series costs an age chip a few minutes of accuracy; taking the
   * loop down costs the card.
   */
  private async persist(sample: KimiPersistedSample): Promise<void> {
    const sink = this.onSample
    if (sink === undefined) return
    try {
      await sink(sample)
    } catch (err) {
      moduleLog.warn('kimi_usage_sample_persist_threw', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
