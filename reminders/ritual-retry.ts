/**
 * @neutronai/reminders — bounded transient RECOVERY for the ritual background
 * path (ISSUES #489).
 *
 * THE GAP THIS CLOSES. An interactive turn that meets a rate-limit or an
 * overload degrades VISIBLY: the owner gets a bubble and retries by hand. A
 * ritual has nobody watching. Before this module a transient upstream failure on
 * a fired ritual ended the occurrence — one `failed` run row, one failure notice,
 * and the morning brief simply did not happen until the next day. Worse, a
 * transient failure during fire STARTUP (before any durable row landed) reverted
 * the occurrence claim and re-fired it on EVERY tick, forever, leaving zero rows
 * in `code_ritual_runs` and telling the owner nothing at all. Two opposite bugs,
 * one cause: nothing behind the failure ever DECIDED whether the cause could
 * recover.
 *
 * THE DECISION IS THREE-VALUED, NOT A BOOLEAN — deliberately the same shape as
 * `open/credential-usage-monitor.ts`'s {@link CredentialStanding}, because the
 * middle value is the safety property in both places:
 *
 *   • `transient`     — the upstream said it was busy (429 / overload / a warm
 *                       REPL that missed its settle window). Waiting genuinely
 *                       helps, so back off and re-attempt.
 *   • `permanent`     — the cause does not fix itself by waiting (an invalid
 *                       credential, a missing binary, no credential at all, a
 *                       ritual that blew its 45-minute budget). Retrying burns
 *                       the schedule and BURIES the real reason; fail loudly and
 *                       record it.
 *   • `indeterminate` — we did not learn what happened. It neither retries nor
 *                       claims success: it records ONE visible terminal failure
 *                       and stops. Retrying an unclassified fault is how a
 *                       programming error turns into an infinite loop, and
 *                       swallowing it is how a morning brief disappears.
 *
 * WHERE THE CLASSIFICATION COMES FROM. Nothing here invents a second error
 * vocabulary or regexes message prose — that is exactly the pattern O3 removed.
 * The single source is the typed taxonomy in `runtime/errors.ts`: a
 * {@link NeutronError} (of which `SubstrateCallError` is one) carries a machine
 * -readable `code` and the `retryable` disposition registered for it in
 * `SUBSTRATE_ERROR_CODES`. A stamped error classifies; an unstamped throw is
 * `indeterminate` by construction. The practical consequence is worth stating
 * plainly: an error only earns a retry by carrying a class, so widening recovery
 * means stamping more producers, never loosening the matcher here.
 *
 * THE BACKOFF IS A PURE FUNCTION OF THE ATTEMPT NUMBER. It returns a DELAY, and
 * the caller adds it to its own injected clock — so nothing in this subsystem
 * ever measures elapsed wall-clock time, and its tests cannot regrow a timing
 * assertion (the ISSUES #438 lint).
 */

import { NeutronError } from '@neutronai/runtime/errors.ts'
import type { SubstrateErrorClass } from '@neutronai/runtime/events.ts'

/**
 * What ONE observed failure says about whether re-attempting it can work.
 * See the module header — the middle value is load-bearing.
 */
export type RitualFailureDisposition = 'transient' | 'permanent' | 'indeterminate'

/**
 * TOTAL attempts allowed for one occurrence — the first fire plus at most three
 * re-attempts. Bounded because a permanently-broken ritual that retries on every
 * 30 s tick is the failure mode this module exists to remove: it spends the
 * schedule, spams the substrate, and hides the cause behind its own noise.
 *
 * Four is chosen against the shape of the delay curve below: the last re-attempt
 * lands ~42 minutes after the first failure, so a 7 a.m. brief that meets a busy
 * upstream still arrives in the MORNING, and a ritual that is genuinely broken
 * has said so, once and visibly, well before the owner is awake.
 */
export const RITUAL_MAX_ATTEMPTS = 4

/** First re-attempt delay; each subsequent one is 4× the previous. */
export const RITUAL_RETRY_BASE_DELAY_MS = 2 * 60_000

/**
 * Ceiling on a single backoff step. Set exactly at the third step of the curve
 * below, so within {@link RITUAL_MAX_ATTEMPTS} it never bites: it is a guard
 * against the delay running away if the cap is ever raised, not a shaper of the
 * schedule anyone reads here.
 */
export const RITUAL_RETRY_MAX_DELAY_MS = 32 * 60_000

/**
 * How long to wait before re-attempt number `attempt` (1 = the first
 * re-attempt, i.e. after the first failure). Exponential, base 4: 2 min → 8 min
 * → 32 min, clamped by {@link RITUAL_RETRY_MAX_DELAY_MS}.
 *
 * PURE: it returns a duration and reads no clock. The caller adds it to its own
 * injected `now`, which is why every test of the recovery path is a comparison
 * of two logical instants rather than a measurement of the machine.
 */
export function ritualRetryDelayMs(attempt: number): number {
  const step = attempt < 1 ? 1 : Math.floor(attempt)
  const raw = RITUAL_RETRY_BASE_DELAY_MS * Math.pow(4, step - 1)
  return raw > RITUAL_RETRY_MAX_DELAY_MS ? RITUAL_RETRY_MAX_DELAY_MS : raw
}

/**
 * Classify a THROWN failure (the fire-startup path).
 *
 * Reads the O3 stamp and nothing else. A `NeutronError` whose `code` is the
 * `'unknown'` sentinel was never actually classified by its producer, so it is
 * reported as `indeterminate` rather than being laundered into the taxonomy's
 * `retryable` default for a class it does not really belong to.
 */
export function classifyRitualFailure(err: unknown): RitualFailureDisposition {
  if (err instanceof NeutronError) {
    if (err.code === 'unknown') return 'indeterminate'
    return err.retryable ? 'transient' : 'permanent'
  }
  return 'indeterminate'
}

/**
 * The O3 class of a settled turn's failure, as carried on the turn result.
 * Structurally identical to `agent-dispatch`'s `DispatchTurnFailure` on purpose:
 * the two modules deliberately do not import each other (the
 * `DispatchService`↔`TridentDispatch` structural-match precedent), so the shape
 * is declared twice and matched, never shared through an import.
 */
export interface RitualTurnFailureClass {
  code: SubstrateErrorClass | 'unknown'
  retryable: boolean
  retry_after_ms?: number
}

/**
 * Classify a SETTLED turn (the detached-run path), from the terminal status plus
 * whatever class the substrate stamped on it.
 *
 * `timed_out` is `permanent` regardless of what the taxonomy says about
 * `turn_timeout` in general. A ritual's budget is 45 minutes: a run that reached
 * it has already spent three quarters of an hour, and re-attempting buys another
 * three quarters of an hour of the same. That is a policy the ritual lane owns,
 * so it is stated here rather than by widening the shared taxonomy for everyone.
 */
export function classifyRitualTurnFailure(input: {
  status: 'failed' | 'timed_out' | 'crashed'
  failure?: RitualTurnFailureClass | undefined
}): RitualFailureDisposition {
  if (input.status === 'timed_out') return 'permanent'
  const cls = input.failure
  if (cls === undefined) return 'indeterminate'
  if (cls.code === 'unknown') return 'indeterminate'
  return cls.retryable ? 'transient' : 'permanent'
}

/**
 * How many times one occurrence has failed, held IN MEMORY and keyed by
 * `reminder_id`.
 *
 * WHY IN MEMORY when this subsystem is otherwise durable. The single case the
 * bound has to survive is the one where the durable store is the thing that
 * failed: a fire-startup loss leaves NO `code_ritual_runs` row by definition, so
 * a counter derived from that table reads zero on every attempt and bounds
 * nothing. An in-process counter is the only thing available at exactly the
 * moment it is needed, and its weakness is acceptable and honest — a restart
 * resets it, and a restart is a legitimate fresh attempt.
 *
 * Bounded so a long-lived process cannot accumulate an entry per occurrence
 * forever: the map is trimmed oldest-first past {@link RitualAttemptLedger.LIMIT}.
 * Trimming can only ever LOSE a count, which costs at most one extra attempt —
 * never a double delivery, which is guarded separately.
 */
export class RitualAttemptLedger {
  static readonly LIMIT = 512
  private readonly counts = new Map<string, number>()

  /** Record one more failure for `key` and return the running total (1-based). */
  bump(key: string): number {
    const next = (this.counts.get(key) ?? 0) + 1
    // Re-insert so Map iteration order is least-recently-bumped first.
    this.counts.delete(key)
    this.counts.set(key, next)
    while (this.counts.size > RitualAttemptLedger.LIMIT) {
      const oldest = this.counts.keys().next()
      if (oldest.done === true) break
      this.counts.delete(oldest.value)
    }
    return next
  }

  /** Failures recorded for `key` so far (0 when never bumped). */
  peek(key: string): number {
    return this.counts.get(key) ?? 0
  }

  /** Drop `key` — called when an occurrence reaches ANY terminal state. */
  forget(key: string): void {
    this.counts.delete(key)
  }
}

/**
 * A bounded set of occurrence ids that have already had their ritual OUTPUT
 * delivered. Consulted before any re-attempt is scheduled, so a retry can never
 * produce a second morning brief.
 *
 * Bounded FIFO rather than an unbounded Set for the same reason as the ledger.
 * Eviction is safe here because it is the SECOND of two guards: the durable
 * check (a `finished` run row for the occurrence) is the one that survives a
 * restart, and this one closes the window where that row could not be written.
 */
export class RitualDeliveryLatch {
  static readonly LIMIT = 512
  private readonly ids = new Set<string>()

  mark(id: string): void {
    this.ids.delete(id)
    this.ids.add(id)
    while (this.ids.size > RitualDeliveryLatch.LIMIT) {
      const oldest = this.ids.keys().next()
      if (oldest.done === true) break
      this.ids.delete(oldest.value)
    }
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }
}
