/**
 * @neutronai/cores-sdk — reconciliation guard contract.
 *
 * Per the Cores dashboard-analytics reconciliation requirement
 * (design confirmed 2026-05-08): every Core that materializes derived
 * tables MUST register a guard that compares the headline metric
 * computed against the derived tables to the same metric direct-
 * queried against the source-of-truth table. If the relative drift
 * exceeds the threshold (default 1%), `runReconciliation` throws.
 * Silently producing wrong CM/MER is the failure mode the guard
 * exists to prevent.
 *
 * Guard shape:
 *   {
 *     metric: 'total_sales',
 *     threshold: 0.01,
 *     derived: () => SELECT SUM(total_sales) FROM cm_daily WHERE date BETWEEN ...
 *     source:  () => SELECT SUM(total_price) FROM shopify_orders WHERE created_at BETWEEN ...
 *   }
 *
 * SDK side: a Core registers its guards at install time + invokes
 * `runReconciliation` after every materialized-table refresh.
 *
 * P3 platform side: the Cores runtime fires `runReconciliation` after
 * every materialized-table refresh AND on a per-Core schedule
 * (default daily). Failures emit a structured event; the platform
 * surfaces them in the admin UI and (for opted-in Cores) blocks the
 * dashboard from rendering until reconciled.
 *
 * Cross-refs:
 * - internal design notes § 4
 *   (Reconciliation guard: 1% threshold, fail loud on drift)
 * - docs/engineering-plan.md § B.P3 (Cores runtime)
 */

export type ReconciliationOutcome = 'pass' | 'drift' | 'guard_error'

/**
 * Default threshold per CM-DASHBOARD-PLAN.md § 4 (1% drift).
 * A `ReconciliationGuard` registered without an explicit `threshold`
 * gets this value at `runReconciliation` time.
 */
export const DEFAULT_RECONCILIATION_THRESHOLD = 0.01

export interface ReconciliationGuard {
  /** Stable metric name — surfaces in error + log entries. */
  metric: string
  /**
   * Allowed |a-b|/|b| drift before throw. Optional; when omitted,
   * `runReconciliation` falls back to `DEFAULT_RECONCILIATION_THRESHOLD`
   * (0.01 / 1%).
   */
  threshold?: number
  /** Compute the metric over the materialized derived tables. */
  derived: () => Promise<number>
  /** Compute the metric over the source-of-truth table directly. */
  source: () => Promise<number>
}

export interface ReconciliationFailure {
  metric: string
  outcome: 'drift' | 'guard_error'
  /** Drift outcome: relative difference vs source. Guard-error: NaN. */
  drift: number
  threshold: number
  /** Drift outcome: derived metric value. Guard-error: NaN. */
  derived: number
  /** Drift outcome: source metric value. Guard-error: NaN. */
  source: number
  /** Guard-error outcome: thrown error from derived()/source(). */
  cause?: unknown
}

export class ReconciliationError extends Error {
  override readonly name = 'ReconciliationError'
  constructor(readonly failures: ReconciliationFailure[]) {
    super(reconciliationErrorMessage(failures))
  }
}

function reconciliationErrorMessage(failures: ReconciliationFailure[]): string {
  return failures
    .map((f) => {
      if (f.outcome === 'drift') {
        return `metric=${f.metric} drift=${(f.drift * 100).toFixed(3)}% threshold=${(f.threshold * 100).toFixed(3)}% derived=${f.derived} source=${f.source}`
      }
      const causeMsg =
        f.cause instanceof Error ? f.cause.message : String(f.cause ?? 'unknown')
      return `metric=${f.metric} guard_error: ${causeMsg}`
    })
    .join('; ')
}

/**
 * Run every guard. Computes drift as `|derived - source| / |source|`
 * (denominator floored at 1 to avoid divide-by-zero when the source
 * sums to 0 — in that case the guard passes iff `derived === 0`).
 *
 * On any drift > threshold OR exception thrown during a guard's
 * `derived()` / `source()`, throws `ReconciliationError` carrying
 * every failure (NOT just the first — Cores want the full picture).
 */
export async function runReconciliation(
  guards: ReadonlyArray<ReconciliationGuard>,
): Promise<void> {
  const failures: ReconciliationFailure[] = []
  for (const g of guards) {
    // Apply the documented default. A guard registered without an
    // explicit `threshold` (`{metric, derived, source}`) MUST still
    // enforce the 1% lock — otherwise drift > undefined collapses
    // to false and the guard becomes a silent no-op for exactly
    // the callers relying on the default.
    const threshold = g.threshold ?? DEFAULT_RECONCILIATION_THRESHOLD
    let derived: number
    let source: number
    try {
      ;[derived, source] = await Promise.all([g.derived(), g.source()])
    } catch (err) {
      failures.push({
        metric: g.metric,
        outcome: 'guard_error',
        drift: Number.NaN,
        threshold,
        derived: Number.NaN,
        source: Number.NaN,
        cause: err,
      })
      continue
    }
    if (!Number.isFinite(derived) || !Number.isFinite(source)) {
      failures.push({
        metric: g.metric,
        outcome: 'guard_error',
        drift: Number.NaN,
        threshold,
        derived,
        source,
        cause: new Error(
          `non-finite metric value (derived=${derived} source=${source})`,
        ),
      })
      continue
    }
    const denom = Math.abs(source) === 0 ? 1 : Math.abs(source)
    const drift =
      Math.abs(source) === 0
        ? derived === 0
          ? 0
          : Number.POSITIVE_INFINITY
        : Math.abs(derived - source) / denom
    if (drift > threshold) {
      failures.push({
        metric: g.metric,
        outcome: 'drift',
        drift,
        threshold,
        derived,
        source,
      })
    }
  }
  if (failures.length > 0) {
    throw new ReconciliationError(failures)
  }
}

