/**
 * @neutronai/onboarding/interview — required-fields audit.
 *
 * P2 v2 § 2.1 + § 4.1 + § 4.4 — the structural-drift contract. Every
 * advance through the gap-fill chain consults this audit; the engine
 * refuses to advance past the user-visible required-data milestones
 * (`personality_offered` for `user_first_name`, etc.) when a required
 * field is missing.
 *
 * Sam-locked 2026-05-15: 5 required fields. `work_themes` / `time_style`
 * / `work_pattern` are demoted to optional ("feels like a fake taxonomy")
 * and are NOT audited. `slug` is collected at `slug_chosen` and is also
 * not audited here (it's the URL, not a user-data point; the slug picker
 * has its own validator).
 *
 * Priority order (Sam-locked):
 *   1. user_first_name       (collected at signup, S3)
 *   2. primary_projects      (≥3 entries, collected via import + gap_fill)
 *   3. non_work_interests    (≥1 entry,   collected via import + gap_fill)
 *   4. agent_personality     (collected at personality_offered)
 *   5. agent_name            (collected at agent_name_chosen)
 *
 * The auditor's `next_to_collect` returns the highest-priority missing
 * field. The work_interview_gap_fill handler asks for that field; on the
 * next reply the audit runs again until the lowest-leverage required
 * fields are filled (`non_work_interests` per § 4.4) and the engine
 * advances to `personality_offered`.
 */

/** The five required fields, in Sam-locked priority order. */
export type RequiredField =
  | 'user_first_name'
  | 'primary_projects'
  | 'non_work_interests'
  | 'agent_personality'
  | 'agent_name'

/**
 * Required-field-collected partition. The phase machine reads
 * `next_to_collect` at every checkpoint and refuses to advance past the
 * point that field gates.
 */
export interface RequiredFieldsAudit {
  /** Filled fields, in priority order. */
  filled: ReadonlyArray<RequiredField>
  /** Missing fields, in priority order. */
  missing: ReadonlyArray<RequiredField>
  /** Highest-priority missing field, or null when all filled. */
  next_to_collect: RequiredField | null
}

/**
 * Minimal slice of `phase_state` the audit reads. Caller may pass the
 * full `phase_state_json` blob — extra keys are ignored.
 *
 * Each predicate is keyed off the canonical write location:
 *   - `user_first_name`   — signup writes here AND to the owner record
 *   - `primary_projects`  — import + gap_fill write here (array of strings)
 *   - `non_work_interests`— import + gap_fill write here (array; per spec
 *                            entries may be plain strings OR objects with
 *                            `name` + optional `cadence_hint`)
 *   - `agent_personality` — personality_offered writes here AND to the owner record
 *   - `agent_name`        — agent_name_chosen writes here AND to the owner record
 */
export interface RequiredFieldsState {
  readonly user_first_name?: string | null
  readonly primary_projects?: ReadonlyArray<unknown>
  readonly non_work_interests?: ReadonlyArray<unknown>
  readonly agent_personality?: string | null
  readonly agent_name?: string | null
  /**
   * TRANSIENT advance-path removal signal — NOT a persisted required field.
   * The audit ignores it (`isFilled` only consults the 5 fields above). The
   * LLM router populates it on a REVIEW-completing *removal* ("drop the Marina
   * screenplay, the rest are good, go ahead") that it legitimately classifies
   * as an `advance` (per llm-router.ts § REVIEW/CORRECTION). The advance-path
   * merge (`mergeAdvanceProjectsAdditively`) subtracts these from the
   * `(prior ∪ adds)` union so an explicitly-dropped project is NOT silently
   * re-added by the additive union — then STRIPS the key so it never persists
   * to `phase_state`. (Argus r3 BLOCKER, onboarding-wow-handoff-fix r4.)
   */
  readonly removed_projects?: ReadonlyArray<unknown>
}

/** § 4.4 priority order — locked. */
const PRIORITY: ReadonlyArray<RequiredField> = [
  'user_first_name',
  'primary_projects',
  'non_work_interests',
  'agent_personality',
  'agent_name',
]

/**
 * Audit which required fields are filled.
 *
 * `filled` / `missing` partition `PRIORITY` and preserve its order
 * (NOT insertion order on the input state). `next_to_collect` is the
 * first element of `missing`, or null.
 *
 * Edge cases (callers depend on these):
 *   - missing key on the input state          → missing
 *   - empty string / whitespace-only string   → missing (treated as null)
 *   - empty array                              → missing
 *   - primary_projects with length < 3         → missing (≥3 floor)
 *   - non_work_interests with length < 1       → missing (≥1 floor; trivial)
 *   - primary_projects at length 3             → filled  (boundary)
 *   - non_work_interests entry that's an empty string or empty object
 *     → still counted toward length (callers sanitize at extract time;
 *     the audit's job is structural presence, not content validation)
 */
export function auditRequiredFields(
  state: Readonly<RequiredFieldsState> | Readonly<Record<string, unknown>>,
): RequiredFieldsAudit {
  const filled: RequiredField[] = []
  const missing: RequiredField[] = []
  for (const field of PRIORITY) {
    if (isFilled(field, state as Record<string, unknown>)) {
      filled.push(field)
    } else {
      missing.push(field)
    }
  }
  return {
    filled,
    missing,
    next_to_collect: missing.length === 0 ? null : (missing[0] as RequiredField),
  }
}

function isFilled(
  field: RequiredField,
  state: Readonly<Record<string, unknown>>,
): boolean {
  switch (field) {
    case 'user_first_name':
      return isNonEmptyString(state['user_first_name'])
    case 'primary_projects':
      return isArrayOfMinLength(state['primary_projects'], 3)
    case 'non_work_interests':
      return isArrayOfMinLength(state['non_work_interests'], 1)
    case 'agent_personality':
      return isNonEmptyString(state['agent_personality'])
    case 'agent_name':
      return isNonEmptyString(state['agent_name'])
  }
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function isArrayOfMinLength(value: unknown, min: number): boolean {
  return Array.isArray(value) && value.length >= min
}
