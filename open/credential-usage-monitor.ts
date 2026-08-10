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
 *
 * SECOND READING, SAME PROBE: IS THE CREDENTIAL STILL VALID AT ALL. Utilization
 * and validity are different questions and only one of them was ever answered
 * here. A tick that comes back 401 used to do nothing but blank a bar — while a
 * 401 means every PROACTIVE surface on the box (the morning brief, rituals,
 * nudges, reminders) is already dead and will stay dead until the token is
 * replaced. The reactive notice cannot cover this: it lives in the failure
 * handler of a real user TURN (`gateway/wiring/build-live-agent-turn.ts`), so it
 * only ever fires for someone who is already typing — and a proactive surface
 * dying produces no turn to fail. So the owner learns hours late, by typing.
 * {@link CredentialStanding} is that second reading, reported to an injected
 * observer; the notice itself is built in `credential-lapse-notice.ts`, which
 * owns the once-per-lapse latch and the durable delivery.
 */

import { createLogger } from '@neutronai/logger'
import { SupervisedLoop } from '@neutronai/loop/index.ts'
import type {
  CredentialUsagePayload,
  CredentialUsageReading,
} from '@neutronai/contracts/credential-usage.ts'
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

const moduleLog = createLogger('credential-usage')

/**
 * What one measurement says about whether the credential is still ACCEPTED —
 * deliberately three-valued, because the middle value is what protects the owner
 * from alarm fatigue.
 *
 *   • `lapsed`        — upstream REJECTED the credential we hold (401/403). This
 *                       is a property of the credential, not of the network, and
 *                       it does not fix itself.
 *   • `healthy`       — upstream accepted it. Includes the windowless API-key
 *                       answer: `no-windows` means "authenticated, nothing to
 *                       meter", which is a perfectly valid credential.
 *   • `indeterminate` — we did not learn anything. A dropped packet, a timeout, a
 *                       5xx, or a box with no measurable credential to ask about.
 *
 * The distinction between `lapsed` and `indeterminate` is the whole safety
 * property. Telling the owner to reconnect his account because a packet dropped
 * teaches him to ignore the message, and then the real one lands on a reader who
 * has already learned it means nothing. `indeterminate` is silence — it neither
 * alerts nor counts as recovery, so a lapse that flickers behind a network blip
 * stays one lapse rather than becoming two notices.
 */
export type CredentialStanding = 'healthy' | 'lapsed' | 'indeterminate'

/**
 * Where a standing goes. Called once per tick with the reading that tick
 * produced; may be async. Whatever it does with the reading (latch, notify,
 * ignore) is not this module's business — see `credential-lapse-notice.ts`.
 */
export type CredentialStandingObserver = (
  standing: CredentialStanding,
) => void | Promise<void>

export interface CredentialUsageMonitorDeps {
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Injected in tests; production uses the real probe. */
  probe?: (token: string) => Promise<CredentialUsageProbeOutcome>
  probeDeps?: UsageProbeDeps
  credentialDeps?: ActiveCredentialDeps
  /**
   * Told what each tick learned about the credential's VALIDITY. Optional so the
   * monitor stays usable as a pure meter; the production composer always wires
   * it (`open/composer.ts`) because an unwatched lapse is the defect.
   */
  onStanding?: CredentialStandingObserver
  /**
   * Told every reading, so the series outlives the 60-second tick.
   *
   * Optional for the same reason `onStanding` is: the monitor stays usable as a pure
   * meter. The production composer wires it, because a measurement taken and discarded
   * is the reason the product could say how full a window was and never whether that
   * was climbing.
   *
   * Called ONLY for a successful measurement. An unauthorized or failed probe learned
   * nothing about utilisation, and writing a row for it would put a gap in the series
   * indistinguishable from a genuine zero.
   */
  onSample?: (reading: CredentialUsageReading) => void | Promise<void>
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
  private readonly onStanding: CredentialStandingObserver | undefined
  private readonly onSample:
    | ((reading: CredentialUsageReading) => void | Promise<void>)
    | undefined

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
    this.onStanding = deps.onStanding
    this.onSample = deps.onSample
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
      // No network call: there is nothing to ask about. Nothing was learned about
      // any credential's validity either — an API-key box and a fresh pre-auth
      // install both land here, and neither has a subscription token that could
      // have lapsed. Silence, not an alarm.
      this.cached = null
      this.unavailable = { available: false, reason: credential.reason }
      await this.report('indeterminate')
      return
    }
    const outcome = await this.probe(credential.token)
    switch (outcome.kind) {
      case 'ok':
        this.cached = {
          payload: { available: true, measured_at: this.now(), ...outcome.reading },
        }
        await this.persist(outcome.reading)
        await this.report('healthy')
        return
      case 'no-windows':
        this.cached = null
        this.unavailable = { available: false, reason: 'unsupported_credential' }
        // No meter, but the credential ANSWERED — it is alive. Reporting this as
        // anything but healthy would leave a latch stuck open across a swap from
        // a subscription token to an API key.
        await this.report('healthy')
        return
      case 'unauthorized':
        // The credential we hold is dead. Whatever we last measured described a
        // credential that no longer answers, so it is dropped outright.
        this.cached = null
        this.unavailable = { available: false, reason: 'no_credential' }
        await this.report('lapsed')
        return
      case 'error':
        // Transient. Keep the last good reading — `snapshot()` ages it out on its
        // own if the outage outlasts the staleness ceiling — and, for the same
        // reason, claim nothing about the credential itself.
        this.unavailable = { available: false, reason: 'probe_failed' }
        await this.report('indeterminate')
        return
    }
  }

  /**
   * Hand the tick's validity reading to the observer, fail-soft.
   *
   * The observer posts to chat, which means it touches a DB and a socket, which
   * means it can throw. A throw here must not become a tick failure: the meter is
   * the monitor's contract and it has already been updated by the time this runs,
   * and repeated tick failures escalate the loop. So the throw is logged and
   * swallowed. The observer's own retry story is its own (the notice latch does
   * not commit until delivery succeeds, so a swallowed throw is re-attempted on
   * the next tick rather than lost).
   */
  /**
   * Hand the reading to the sample sink, fail-soft.
   *
   * Same posture as {@link report} and for the same reason: the sink touches a database
   * and can throw, the METER is this monitor's contract and has already been updated by
   * the time this runs, and repeated tick failures escalate the loop. Losing one row
   * from a 60-second series costs nothing; losing the meter costs the feature.
   */
  private async persist(reading: CredentialUsageReading): Promise<void> {
    const sink = this.onSample
    if (sink === undefined) return
    try {
      await sink(reading)
    } catch (err) {
      moduleLog.warn('usage_sample_persist_threw', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async report(standing: CredentialStanding): Promise<void> {
    const observer = this.onStanding
    if (observer === undefined) return
    try {
      await observer(standing)
    } catch (err) {
      moduleLog.warn('standing_observer_failed', {
        standing,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
