/**
 * @neutronai/runtime — typed substrate/runtime error taxonomy (O3 leaf).
 *
 * O3 (2026-07, lane substrate) — replaces the ad-hoc "classify a substrate
 * failure by regexing its message PROSE" pattern with a typed error-code
 * taxonomy carried ON the failure itself. The `SubstrateErrorClass` union lives
 * with the locked `Event` in `./events.ts` (it is the type of the additive
 * `code?` field on the `error` event); this leaf holds the ERROR objects and the
 * registered code table that give producers a first-class way to STAMP a class
 * and consumers a first-class way to READ one.
 *
 * The migration is additive + fail-soft by design: every classifier reads the
 * stamped `code` FIRST and falls back to its existing message regex for one
 * release (the G6 conformance suite pins the regex fallbacks). Message prose is
 * therefore no longer the classification API — but it stays byte-identical so
 * nothing that still reads prose breaks mid-migration.
 */

import type { SubstrateErrorClass } from './events.ts'

/**
 * Base runtime error carrying a machine-readable `code`, a `retryable` hint, and
 * an optional `cause`. Every typed runtime/substrate error derives from this so
 * a consumer can `instanceof NeutronError` + switch on `.code` instead of
 * pattern-matching `.message`.
 *
 * `code` is deliberately widened to `string` on the base so this leaf can also
 * home non-substrate code namespaces (e.g. the gateway HTTP surface codes) as
 * they migrate; the substrate subclass below narrows it to `SubstrateErrorClass`.
 */
export class NeutronError<C extends string = string> extends Error {
  override readonly name: string = 'NeutronError'
  /** Machine-readable failure class. Consumers switch on this, not `.message`.
   *  Generic so subclasses narrow it (e.g. `SubstrateCallError` → the substrate
   *  taxonomy) without an incompatible property override. */
  readonly code: C
  /** Recovery hint: does retrying (same credential/path) plausibly help? */
  readonly retryable: boolean
  /** Underlying error, when this wraps a lower-level throw. */
  override readonly cause?: unknown

  constructor(
    code: C,
    message: string,
    opts?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message)
    this.code = code
    this.retryable = opts?.retryable ?? false
    if (opts?.cause !== undefined) this.cause = opts.cause
  }
}

/**
 * The typed error a substrate-stream drain (`collectTokensToString`) throws when
 * it observes a terminal `error` event — carrying the event's `code`,
 * `retryable`, and `retry_after_ms` verbatim. The `message` is preserved EXACTLY
 * (still the `cc-llm-call: <prose>` text) so the freeze-timeout / 429 / cooldown
 * classifiers that still read prose stay green while callers migrate to `.code`.
 */
export class SubstrateCallError extends NeutronError<SubstrateErrorClass | 'unknown'> {
  override readonly name = 'SubstrateCallError'
  /** Adapter recovery hint (ms) — mirrors the `error` event's `retry_after_ms`. */
  readonly retry_after_ms?: number

  constructor(
    message: string,
    opts: {
      code?: SubstrateErrorClass
      retryable: boolean
      retry_after_ms?: number
      cause?: unknown
    },
  ) {
    // `code` narrows to the substrate taxonomy; an unstamped (legacy) event maps
    // to the sentinel `'unknown'` so `.code` is always a defined discriminant.
    super(opts.code ?? 'unknown', message, {
      retryable: opts.retryable,
      ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
    })
    if (opts.retry_after_ms !== undefined) this.retry_after_ms = opts.retry_after_ms
  }
}

/** Metadata for one entry in the registered substrate-error code table. */
export interface SubstrateErrorCodeSpec {
  /** Default recovery disposition for the class (individual events may override
   *  via their own `retryable` flag; this is the taxonomy-level default). */
  readonly retryable: boolean
  /** One-line human description of the failure class. */
  readonly description: string
}

/**
 * The registered substrate-error code table. Every `SubstrateErrorClass` value
 * has exactly one entry, so `Object.keys(SUBSTRATE_ERROR_CODES)` is the runtime
 * enumeration of the taxonomy and the table is the single place the retryable
 * default + intent of each class is documented.
 *
 * `retryable` defaults MUST honour the O3 "Care" invariants:
 *   - `binary_not_found` stays NON-retryable (a missing binary never recovers by
 *     waiting — it must never launder into a 429 credential cooldown).
 *   - `all_cooldown` stays retryable (the window passes; the pool recovers).
 */
export const SUBSTRATE_ERROR_CODES: Readonly<Record<SubstrateErrorClass, SubstrateErrorCodeSpec>> = {
  binary_not_found: {
    retryable: false,
    description: 'The substrate binary (e.g. `claude`) is not on PATH — fatal, unreachable.',
  },
  channel_wedged: {
    retryable: false,
    description: 'The persistent-REPL substrate failed to spawn / bind its dev-channel.',
  },
  turn_timeout: {
    retryable: true,
    description: 'A warm REPL failed to settle a turn in time — the credential is fine.',
  },
  auth_invalid: {
    retryable: false,
    description:
      'The `claude` child reported an invalid/expired credential (auth-failure output-scan signature) — reconnect the token; retrying is pointless.',
  },
  http_status: {
    retryable: false,
    description: 'An upstream returned a non-ok HTTP status; the numeric status is in the message.',
  },
  rate_limited: {
    retryable: true,
    description: 'An upstream rate-limit (HTTP 429 / `rate_limit_error`) — back off and retry.',
  },
  aborted: {
    retryable: false,
    description: 'The turn was cancelled/aborted by the caller (signal) before completion.',
  },
  no_credentials: {
    retryable: false,
    description: 'No usable credential at dispatch time — configure one, then retry.',
  },
  all_cooldown: {
    retryable: true,
    description: 'Every credential is in cooldown (429/402/401) — retry once the window passes.',
  },
  oauth_refresh: {
    retryable: false,
    description: 'Max OAuth token refresh failed at dispatch — re-auth needed.',
  },
} as const
