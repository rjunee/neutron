/**
 * @neutronai/runtime — the ONE shared feature flag for the perfect-recall lane.
 *
 * The perfect-recall uplift (docs/plans/2026-07-02-world-class-refactor-plan.md
 * §RB1–RB4) ships behind a SINGLE opt-in flag so the whole behavior block can be
 * turned on/off as a unit:
 *
 *   - RB1 — dynamic memory-index manifest (this unit, the base)
 *   - RB2 — reflection warm-turn re-splice + broadened readers
 *   - RB3 — consolidation / reflect cron
 *   - RB4 — temporal invalidation
 *
 * Default OFF. Enabled only when `NEUTRON_PERFECT_RECALL` is an explicit opt-in
 * token (`1`/`true`/`yes`/`on`/`enabled`/`all`), reusing the shared opt-in/opt-out
 * vocabulary so the parse can never drift from the other env-flag parsers.
 */

import { isOptInToken } from './env-flag-tokens.ts'

/** The single env var that gates the entire perfect-recall behavior block. */
export const PERFECT_RECALL_FLAG = 'NEUTRON_PERFECT_RECALL'

/**
 * True iff the perfect-recall lane is opted in via `NEUTRON_PERFECT_RECALL`.
 * Absent / empty / any opt-out token → false (the default-off contract).
 */
export function isPerfectRecallEnabled(
  env: { readonly [key: string]: string | undefined } = process.env,
): boolean {
  const raw = env[PERFECT_RECALL_FLAG]
  // Trim surrounding whitespace before matching (a `" true "` env value is still
  // opt-in); `isOptInToken` handles case-folding.
  return typeof raw === 'string' && isOptInToken(raw.trim())
}
