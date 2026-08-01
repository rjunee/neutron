/**
 * The box's live answer to "how close is my subscription to being cut off?".
 *
 * One credential, measured on a timer, cached in memory, served to whoever asks.
 * Every surface that draws the usage meter reads THIS — there is no second place
 * a utilization number comes from, so the web bar and the phone bar cannot
 * disagree.
 *
 * WHY POLL AT ALL rather than measure on demand. The probe is a network call to
 * Anthropic. Doing it inside the HTTP handler would put a foreign round-trip in
 * front of a UI element that two clients refresh on their own schedules, and a
 * slow or wedged upstream would then be visible as a hanging request. A tick
 * loop decouples the two: the handler always answers instantly from memory, and
 * the worst an upstream outage can do is let the cached reading go stale — which
 * the staleness ceiling below turns into an honest "unknown" rather than a lie.
 *
 * WHAT MAKES A READING STOP BEING TRUE. A utilization figure describes a rolling
 * window, so it decays on its own: a reading taken an hour ago is not merely old,
 * it is WRONG, and drawing it would tell the owner they are near a ceiling they
 * have since fallen away from (or, worse, far from one they have since hit).
 * {@link USAGE_MAX_AGE_MS} is the point past which the monitor stops claiming to
 * know. Inside that window a stale-but-recent reading survives a failed probe on
 * purpose — a dropped packet should not blank the meter — and beyond it the
 * monitor reports `probe_failed` and the surfaces draw a plain divider again.
 *
 * A PERMANENT NEGATIVE IS NOT RETRIED FOREVER at the network level: a box with an
 * API key or no credential at all resolves to an unavailable answer WITHOUT
 * touching the network, so an unauthenticated install never generates upstream
 * traffic it has no business generating.
 */

import { SupervisedLoop } from '@neutronai/loop/index.ts'
import type { CredentialUsagePayload } from '@neutronai/contracts/credential-usage.ts'
import {
  probeCredentialUsage,
  type CredentialUsageProbeOutcome,
  type UsageProbeDeps,
} from '@neutronai/auth/credential-usage-probe.ts'
import { resolveActiveCredential, type ActiveCredentialDeps } from './active-credential.ts'

/**
 * How often to re-measure. The windows this tracks are five hours and seven days
 * long, so a minute of lag is invisible to the owner; the cost of a tighter loop
 * is upstream traffic that buys nothing.
 */
export const USAGE_POLL_INTERVAL_MS = 60_000

/**
 * How long a reading stays quotable. Five minutes is a few failed ticks' worth of
 * slack — enough to ride out a blip without ever showing a number old enough to
 * have drifted meaningfully against a five-hour window.
 */
export const USAGE_MAX_AGE_MS = 5 * 60_000

export interface CredentialUsageMonitorDeps {
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Injected in tests; production uses the real probe. */
  probe?: (token: string) => Promise<CredentialUsageProbeOutcome>
  probeDeps?: UsageProbeDeps
  credentialDeps?: ActiveCredentialDeps
  /** `SupervisedLoop` timer seams, threaded straight through for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface CachedReading {
  payload: Extract<CredentialUsagePayload, { available: true }>
}

export class CredentialUsageMonitor {
  readonly loop: SupervisedLoop

  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly probe: (token: string) => Promise<CredentialUsageProbeOutcome>
  private readonly credentialDeps: ActiveCredentialDeps

  /** Last SUCCESSFUL measurement, if there has ever been one. */
  private cached: CachedReading | null = null
  /** Why there is currently nothing to show, when there is nothing to show. */
  private unavailable: Extract<CredentialUsagePayload, { available: false }> = {
    available: false,
    reason: 'not_measured_yet',
  }

  constructor(deps: CredentialUsageMonitorDeps = {}) {
    this.env = deps.env ?? process.env
    this.now = deps.now ?? ((): number => Date.now())
    const probeDeps = deps.probeDeps
    this.probe =
      deps.probe ??
      ((token: string): Promise<CredentialUsageProbeOutcome> =>
        probeCredentialUsage(token, probeDeps ?? {}))
    this.credentialDeps = deps.credentialDeps ?? {}
    this.loop = new SupervisedLoop({
      name: 'credential-usage',
      intervalMs: USAGE_POLL_INTERVAL_MS,
      // Measure at boot rather than one minute in — otherwise the meter is
      // absent for the first minute of every restart, which is exactly when the
      // owner is most likely to be looking at the screen.
      immediate: true,
      tick: async (): Promise<void> => {
        await this.measureOnce()
      },
      ...(deps.setTimer !== undefined ? { setTimer: deps.setTimer } : {}),
      ...(deps.clearTimer !== undefined ? { clearTimer: deps.clearTimer } : {}),
    })
  }

  /**
   * What the HTTP surface serves. Synchronous and allocation-cheap — it is read
   * once per client poll and must never block on anything.
   */
  snapshot(): CredentialUsagePayload {
    const cached = this.cached
    if (cached !== null && this.now() - cached.payload.measured_at <= USAGE_MAX_AGE_MS) {
      return cached.payload
    }
    // A cached reading that has aged out is not evidence of anything any more.
    if (cached !== null) return { available: false, reason: 'probe_failed' }
    return this.unavailable
  }

  /** One measurement. Exposed so tests can drive ticks deterministically. */
  async measureOnce(): Promise<void> {
    const credential = resolveActiveCredential(this.env, this.credentialDeps)
    if (credential.kind === 'unmeasurable') {
      // No network call: there is nothing to ask about.
      this.cached = null
      this.unavailable = { available: false, reason: credential.reason }
      return
    }
    const outcome = await this.probe(credential.token)
    switch (outcome.kind) {
      case 'ok':
        this.cached = {
          payload: { available: true, measured_at: this.now(), ...outcome.reading },
        }
        return
      case 'no-windows':
        this.cached = null
        this.unavailable = { available: false, reason: 'unsupported_credential' }
        return
      case 'unauthorized':
        // The credential we hold is dead. Whatever we last measured described a
        // credential that no longer answers, so it is dropped outright.
        this.cached = null
        this.unavailable = { available: false, reason: 'no_credential' }
        return
      case 'error':
        // Transient. Keep the last good reading — `snapshot()` ages it out on its
        // own if the outage outlasts the staleness ceiling.
        this.unavailable = { available: false, reason: 'probe_failed' }
        return
    }
  }
}
