/**
 * @neutronai/onboarding/wow-moment — action catalogue.
 *
 * P2 v2 § 5 (docs/plans/P2-onboarding-v2.md). v1's locked 7-action
 * dispatch order is replaced with:
 *
 *   - `ALWAYS_FIRE_FIRST` (07-overnight-pass) — first, so the cron lands
 *     even if the rest of dispatch fails.
 *   - `CANDIDATE_IDS` (02, 03, 04, 05, 06-interest-check-in) — the LLM
 *     picker chooses 2-3 of these per `llm-selector.ts`.
 *   - `ALWAYS_FIRE_LAST` (01-first-week-brief) — last, so it can
 *     summarize what fired.
 *
 * Each action exports a `WowActionModule` from its own file
 * (`actions/0N-<slug>.ts`); this module imports them all and exposes the
 * registry. Adding a candidate action: write the module, add it to the
 * imports, add to `CANDIDATE_IDS`, add to the `WowActionId` union in
 * telemetry.ts, update `prompts/onboarding/wow-action-picker.md`.
 */

import type {
  WowActionContext,
  WowActionModule,
  WowActionResult,
} from './action-types.ts'
import type { WowActionId } from './telemetry.ts'

import action01 from './actions/01-first-week-brief.ts'
import action02 from './actions/02-lifestyle-reminders.ts'
import action03 from './actions/03-project-shells.ts'
import action04 from './actions/04-overdue-task.ts'
import action05 from './actions/05-followup-email-draft.ts'
import action06 from './actions/06-interest-check-in.ts'
import action07 from './actions/07-overnight-pass.ts'

/** Always-fire baseline — runs FIRST so the overnight cron lands. */
export const ALWAYS_FIRE_FIRST: WowActionId = '07-overnight-pass'

/** Always-fire baseline — runs LAST so the brief can summarize. */
export const ALWAYS_FIRE_LAST: WowActionId = '01-first-week-brief'

/**
 * LLM-picker candidate set. The picker returns 2-3 of these between the
 * always-fire baselines.
 */
export const CANDIDATE_IDS: ReadonlyArray<WowActionId> = [
  '02-lifestyle-reminders',
  '03-project-shells',
  '04-overdue-task',
  '05-followup-email-draft',
  '06-interest-check-in',
]

const REGISTRY: Readonly<Record<WowActionId, WowActionModule>> = {
  '01-first-week-brief': action01,
  '02-lifestyle-reminders': action02,
  '03-project-shells': action03,
  '04-overdue-task': action04,
  '05-followup-email-draft': action05,
  '06-interest-check-in': action06,
  '07-overnight-pass': action07,
}

/** Return the module for a given action id; throws on unknown id. */
export function getActionModule(action_id: WowActionId): WowActionModule {
  const m = REGISTRY[action_id]
  if (m === undefined) {
    throw new Error(`unknown wow-action id: ${action_id}`)
  }
  return m
}

/**
 * P2 v2 § 5.4 — return the deterministic order the dispatcher walks
 * after the picker decides: ALWAYS_FIRE_FIRST → picked candidates →
 * ALWAYS_FIRE_LAST. Exposed for tests that want to assert the full walk
 * without driving the dispatcher.
 */
export function listDispatchOrder(picked: ReadonlyArray<WowActionId>): Array<{
  action_id: WowActionId
  module: WowActionModule
}> {
  const ordered: WowActionId[] = [ALWAYS_FIRE_FIRST, ...picked, ALWAYS_FIRE_LAST]
  return ordered.map((id) => ({ action_id: id, module: getActionModule(id) }))
}

export type { WowActionContext, WowActionModule, WowActionResult } from './action-types.ts'
