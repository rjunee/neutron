/**
 * @neutronai/tasks — deterministic focus-score formula (P6).
 *
 * Pure function of (priority, due_date, updated_at, now). NO LLM in this
 * code path — the score is the data; the LLM nudge engine (P6.x) sits
 * on top and picks "one most important thing" with context-aware
 * reasoning.
 *
 * Formula (locked, equivalent to internal design notes
 *
 *   urgency       = priorityToFocusScale(priority)
 *   importance    = priorityToFocusScale(priority)
 *   if due_date set:
 *     days_left = floor((due_date - now) / DAY_MS)
 *     if days_left <= 0:   urgency = 5            // overdue
 *     elif days_left <= 2: urgency = max(urgency, 4)
 *     elif days_left <= 7: urgency = max(urgency, 3)
 *   days_stale   = floor((now - updated_at) / DAY_MS)
 *   staleness    = days_stale > 5 ? min(days_stale - 5, 5) * 0.5 : 0
 *   focus_score  = round1((urgency * 3) + (importance * 2) + staleness)
 *
 * `priorityToFocusScale(p)` maps the P6.0 storage scale (0..3 with 3 =
 * most urgent) into Nova's 2..5 scale (P0 → 5, P3 → 2; null → 2 so
 * an unpriortized task is "P3-equivalent"). The wrapper inverts so the
 * Nova ranking semantics stay intact.
 *
 * Score range: roughly 4 (P3, no due, fresh) to ~27 (P0, overdue,
 * 10+ days stale). The Focus aggregator and projection sort
 * `focus_score DESC NULLS LAST`.
 *
 * Determinism contract: same `(priority, due_date, updated_at, now)`
 * input → same numeric output. The cross-validation test set in
 * `tasks/__tests__/focus-score.test.ts` locks the exact numeric
 * outputs Forge ships with — a future tweak to the formula MUST update
 * the fixture set with intent.
 */

/** Bump when the formula changes in a backwards-incompatible way. */
export const FOCUS_SCORE_VERSION = 1 as const

const DAY_MS = 24 * 60 * 60 * 1000

const STALENESS_THRESHOLD_DAYS = 5
const STALENESS_CAP_DAYS = 5
const STALENESS_PER_DAY = 0.5

const URGENCY_OVERDUE = 5
const URGENCY_DUE_SOON = 4 // ≤2 days
const URGENCY_DUE_THIS_WEEK = 3 // ≤7 days

const URGENCY_WEIGHT = 3
const IMPORTANCE_WEIGHT = 2

export interface ComputeFocusScoreInput {
  /** 0-3 storage value (3 = most urgent) or null when unpriortized. */
  priority: number | null
  /** ISO-8601 string or null when no deadline. */
  due_date: string | null
  /** ISO-8601 string — the row's last mutation time. */
  updated_at: string
  /** Reference "now" — caller-injected for determinism + tests. */
  now: Date
}

/**
 * Nova's task scanner ranks P0..P3 as 5..2 (P0 = most urgent). The
 * P6.0 storage scale uses 0..3 (3 = most urgent) for compact integer
 * sorting; this wrapper maps the storage scale to the Nova scale.
 * Mapping (storage → Nova): 3 → 5, 2 → 4, 1 → 3, 0 → 2. A null
 * priority maps to 2 — the P3-equivalent floor — so an unpriortized
 * task is treated as "least urgent" rather than scoring above the
 * priority floor.
 */
export function priorityToFocusScale(priority: number | null): number {
  if (priority === null) return 2
  if (priority < 0) return 2
  if (priority > 3) return 5
  return 2 + priority
}

/**
 * Compute the focus score for one task. Pure function — returns a
 * single number rounded to one decimal place.
 */
export function computeFocusScore(input: ComputeFocusScoreInput): number {
  const nowMs = input.now.getTime()
  const importance = priorityToFocusScale(input.priority)
  let urgency = priorityToFocusScale(input.priority)

  if (input.due_date !== null) {
    const dueMs = Date.parse(input.due_date)
    if (Number.isFinite(dueMs)) {
      const daysLeft = Math.floor((dueMs - nowMs) / DAY_MS)
      if (daysLeft <= 0) {
        urgency = URGENCY_OVERDUE
      } else if (daysLeft <= 2) {
        urgency = Math.max(urgency, URGENCY_DUE_SOON)
      } else if (daysLeft <= 7) {
        urgency = Math.max(urgency, URGENCY_DUE_THIS_WEEK)
      }
    }
  }

  let stalenessBonus = 0
  const updatedMs = Date.parse(input.updated_at)
  if (Number.isFinite(updatedMs)) {
    const daysStale = Math.floor((nowMs - updatedMs) / DAY_MS)
    if (daysStale > STALENESS_THRESHOLD_DAYS) {
      const capped = Math.min(daysStale - STALENESS_THRESHOLD_DAYS, STALENESS_CAP_DAYS)
      stalenessBonus = capped * STALENESS_PER_DAY
    }
  }

  const raw =
    urgency * URGENCY_WEIGHT + importance * IMPORTANCE_WEIGHT + stalenessBonus
  return Math.round(raw * 10) / 10
}
