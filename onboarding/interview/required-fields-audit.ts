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
 * 2026-07-01 (Neutron Open — DROP the agent-NAME step): `agent_name` is no
 * longer a required field. Neutron Open is an agent ORCHESTRATOR, not a
 * personal agent, so onboarding never asks the owner to name it — only its
 * personality (→ SOUL.md). The audit therefore drops to 4 required fields.
 *
 * NB (corrected 2026-07-18): this comment used to say finalize
 * (`next_to_collect === null`) "triggers once personality is settled". That was
 * FALSE and it masked a live deadlock. Personality sits at priority 5 — LAST —
 * so it is the last field ASKED, but `next_to_collect` is the highest-priority
 * MISSING field, and `non_work_interests` (priority 4) is audited BEFORE it. A
 * run can therefore have personality settled and still be blocked on interests,
 * which is exactly the state Ryan's fresh install wedged in on 2026-07-18.
 * Finalize triggers when EVERY in-scope field is filled — never off any one of
 * them.
 *
 * The legacy phase-machine engine still writes `phase_state.agent_name` at its
 * `agent_name_chosen` phase (untouched, kept for Managed), but the shared audit
 * no longer HARD-REQUIRES a name.
 *
 * 2026-07-18 (IMPORT STEP GUARD): the history-import DECISION becomes a tracked
 * required step. The import offer previously existed only as PROSE in
 * `onboarding-preamble.ts` with ZERO capture, so the live agent routinely
 * narrated a decision the owner never made ("Got it, we'll skip the import for
 * now…" after the owner had only typed their name). Making it an audited field
 * lets the SAME deterministic per-turn guard that made the personality step
 * reliable (`buildOnboardingStepGuardFragment`, built 2026-06-30 for the
 * identical prose-only failure) also force the import step.
 *
 * It is CONDITIONAL, not unconditional: it is audited only when the caller says
 * an import is actually offered on this box (`options.import_offered`, which the
 * composer derives from `importSubstrate !== null` — the same expression that
 * decides whether the preamble renders the offer at all). The default is
 * `false`, so every pre-existing caller — including the legacy phase-machine
 * engine — audits exactly the 4 Sam-locked fields it always did.
 *
 * Priority order (Sam-locked, with the import decision slotted where the
 * preamble already places the ask — RIGHT AFTER the name and BEFORE the work
 * questions, so the box can analyse real history before the interview probes):
 *   1. user_first_name       (collected at signup, S3)
 *   2. import_decision       (chatgpt | claude | neither; only when offered)
 *   3. primary_projects      (≥3 entries, collected via import + gap_fill)
 *   4. non_work_interests    (≥1 entry,   collected via import + gap_fill)
 *   5. agent_personality     (collected at personality_offered)
 *
 * The auditor's `next_to_collect` returns the highest-priority missing
 * field. The work_interview_gap_fill handler asks for that field; on the
 * next reply the audit runs again until the lowest-leverage required
 * fields are filled (`non_work_interests` per § 4.4) and the engine
 * advances to `personality_offered`.
 */

/** The required fields, in Sam-locked priority order. */
export type RequiredField =
  | 'user_first_name'
  | 'import_decision'
  | 'primary_projects'
  | 'non_work_interests'
  | 'agent_personality'

/**
 * The owner's answer to the history-import offer. Locked vocabulary — the guard
 * renders exactly these three choices and the deterministic capture normalizes
 * every tap/free-text answer into one of them.
 */
export type ImportDecision = 'chatgpt' | 'claude' | 'neither'

/** Options that decide which required fields are IN SCOPE for this audit. */
export interface RequiredFieldsAuditOptions {
  /**
   * Whether a history import is genuinely offerable on this box (composer:
   * `importSubstrate !== null`). When false/omitted, `import_decision` is not
   * audited at all — it appears in neither `filled` nor `missing` — so a box
   * with no import substrate can still finalize, and every legacy caller keeps
   * its exact pre-2026-07-18 4-field partition.
   */
  import_offered?: boolean
}

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
 *
 * NB: `agent_name` remains a member of this shape (the legacy phase-machine
 * engine + its `llm-router` still amend it at `agent_name_chosen`, and it is a
 * valid `phase_state` key), but it is NO LONGER an audited required field — see
 * `RequiredField` / `PRIORITY` (2026-07-01, DROP the agent-NAME step). The audit
 * never reads it, so it can never gate finalize; it is kept here only so the
 * shared amend/capture types keep type-checking.
 */
export interface RequiredFieldsState {
  readonly user_first_name?: string | null
  /**
   * The history-import decision (2026-07-18). Written by the deterministic
   * turn-start capture (`button-backed-answer.ts`) and, as a fallback for a
   * volunteered answer with no button context, by the post-turn LLM extractor.
   * Only audited when `options.import_offered` is true.
   */
  readonly import_decision?: ImportDecision | string | null
  readonly primary_projects?: ReadonlyArray<unknown>
  readonly non_work_interests?: ReadonlyArray<unknown>
  readonly agent_personality?: string | null
  /** Legacy-engine phase_state field (see NB above); NOT audited/required. */
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

/**
 * § 4.4 priority order — locked.
 *
 * EXPORTED (2026-07-18, audit-driven step guard) so the guard's anti-recurrence
 * test can iterate the REAL required set rather than a hand-copied list: a field
 * added here but given no guard copy fails that test, and the guard's
 * `Record<RequiredField, …>` copy table fails TYPE-CHECK. Between them, no
 * required field can be unaskable.
 */
export const REQUIRED_FIELDS_IN_PRIORITY_ORDER: ReadonlyArray<RequiredField> = [
  'user_first_name',
  'import_decision',
  'primary_projects',
  'non_work_interests',
  'agent_personality',
]

/** Internal alias kept for readability at the audit's use-sites. */
const PRIORITY = REQUIRED_FIELDS_IN_PRIORITY_ORDER

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
 *   - `import_decision` with `options.import_offered` unset/false → SKIPPED
 *     entirely (neither filled nor missing)
 */
export function auditRequiredFields(
  state: Readonly<RequiredFieldsState> | Readonly<Record<string, unknown>>,
  options?: Readonly<RequiredFieldsAuditOptions>,
): RequiredFieldsAudit {
  const filled: RequiredField[] = []
  const missing: RequiredField[] = []
  const importOffered = options?.import_offered === true
  for (const field of PRIORITY) {
    // Out-of-scope field: not audited, so it can neither gate finalize nor show
    // up in the partition (keeps every legacy 4-field caller byte-identical).
    if (field === 'import_decision' && !importOffered) continue
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
    case 'import_decision':
      // An explicitly captured answer settles it — and so does an import that
      // ACTUALLY happened: uploading an export IS the decision, so a run that
      // reached the upload/analysis path must never be re-asked. `import_job_id`
      // is (re)stamped by every upload; `import_result` is stamped by the engine
      // once the analysis lands. Derived from state alone, so no phase-machine
      // coupling is introduced here.
      return (
        isNonEmptyString(state['import_decision']) ||
        isNonEmptyString(state['import_job_id']) ||
        isNonNullObject(state['import_result'])
      )
    case 'primary_projects':
      return isArrayOfMinLength(state['primary_projects'], 3)
    case 'non_work_interests':
      return isArrayOfMinLength(state['non_work_interests'], 1)
    case 'agent_personality':
      return isNonEmptyString(state['agent_personality'])
  }
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonNullObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null
}

function isArrayOfMinLength(value: unknown, min: number): boolean {
  return Array.isArray(value) && value.length >= min
}
