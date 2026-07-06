/**
 * @neutronai/onboarding — per-phase interaction-mode classification.
 *
 * Sprint 2026-06-03 (onboarding-buttons-only-tweak-later). Sam walked
 * onboarding 2026-06-03 and hit the same gap M3 keeps surfacing: the
 * freeform LLM router (`llm-router.ts`) routes intent WITHIN the current
 * phase only. There is no "amend a prior phase" intent. So when he tapped
 * a button to advance, then typed an amendment ("rename Side Project,
 * merge Backlog, drop n8n"), the engine had already advanced; the text
 * was handed to the router at the NEXT phase, mis-classified as a
 * "looks good", and the amendment was silently dropped.
 *
 * Sam's call (verbatim): "lets try buttons only tweak later, but some
 * situations still need freeform like choosing personality types, agent
 * names/slugs etc."
 *
 * This module is the buttons-only/mixed/freeform classifier the engine
 * consults BEFORE the LLM router. It removes the freeform-router pretense
 * for the phases where freeform was only ever silently dropped, and
 * keeps targeted text-input alive for the three phases where a custom
 * answer is legitimately the point.
 *
 * Three modes:
 *
 *   - `'buttons-only'` — only a button tap advances. Any freeform text
 *     gets the canned `BUTTONS_ONLY_NUDGE_TEXT` nudge and does NOT advance
 *     and does NOT call the LLM router. The active keyboard stays live so
 *     the user can still tap.
 *   - `'mixed'` — buttons + targeted freeform. Each mixed phase declares
 *     a text-input field (see `TEXT_INPUT_FIELDS_BY_PHASE`) and a
 *     validator (`validateMixedTextInput`). Valid text flows through the
 *     engine's existing synthetic-`__freeform__` → `consumeChoice` path
 *     (the same path the no-router fallback already uses) so the value is
 *     captured and the phase advances. Text that fails validation gets the
 *     same canned nudge as buttons-only.
 *   - `'freeform'` — the legacy path. The engine's existing router /
 *     synthetic-freeform handling runs unchanged. Used by phases whose
 *     entire purpose is an open text answer (`signup`,
 *     `work_interview_gap_fill`, `import_analysis_presented` — whose
 *     "Anything important I missed?" reply legitimately routes through the
 *     LLM router: a typed FAQ deflects, a project edit amends, a correction
 *     advances into `consumeImportAnalysisPresentedChoice`) and by the
 *     terminal/transit phases the edited branch never reaches.
 *
 * The classifier is a TOTAL map over `OnboardingPhase` so adding a phase
 * to the enum without classifying it is a compile error, not a silent
 * "defaults to freeform" footgun.
 */

import type { OnboardingPhase } from './phase.ts'
import type { PhasePromptSpec } from './phase-prompts.ts'
import { validateAgentName } from './phase-prompts.ts'
import { isFormatLegal, sanitizeToSlug } from '../../runtime/slug-grammar.ts'

export type InteractionMode = 'buttons-only' | 'mixed' | 'freeform'

/**
 * Canonical per-phase interaction mode. Brief § 2 classification.
 *
 * `work_interview_gap_fill` is intentionally `'freeform'` (NOT
 * buttons-only) per the brief's own parenthetical exception — that phase
 * collects open text answers about the user's work (timezone, work
 * pattern, rituals). Making it buttons-only would re-introduce the exact
 * silent-drop bug this sprint exists to kill, just inverted. Documented
 * decision: keep it freeform so its text answers still get captured by
 * the existing gap-fill handler.
 *
 * `completed` / `failed` are terminal — `advance()` short-circuits them
 * to `noop_terminal` before the freeform branch this map gates, so their
 * value here is purely defensive. The final-handoff prompt on `completed`
 * has its own freeform routing (`routeFinalHandoffFreeform`).
 */
export const INTERACTION_MODE_BY_PHASE: Readonly<Record<OnboardingPhase, InteractionMode>> = {
  signup: 'freeform',
  identity_oauth: 'freeform',
  instance_provisioned: 'buttons-only',
  ai_substrate_offered: 'buttons-only',
  import_upload_pending: 'buttons-only',
  import_running: 'buttons-only',
  // Argus r3 BLOCKER (2026-06-03): 'freeform', NOT buttons-only. The
  // "Anything important I missed?" prompt renders `options:[]` on the
  // normal completed-import success path (a Resume button appears only
  // when `can_resume_import`), so a buttons-only classification stranded
  // any typed correction with "Tap one of the buttons above" — and no
  // button exists on the happy path. 'freeform' restores the legacy
  // router / synthetic-freeform handling: a typed FAQ deflects (`answer`),
  // a project edit amends (`amend`), and a correction / "looks good"
  // advances (`advance`) into `consumeImportAnalysisPresentedChoice`. The
  // router is INTENTIONAL here (unlike persona_reviewed's freeform
  // sub_steps, whose dedicated recompose handler needs the r2 bypass).
  import_analysis_presented: 'freeform',
  work_interview_gap_fill: 'freeform',
  personality_offered: 'mixed',
  agent_name_chosen: 'mixed',
  slug_chosen: 'mixed',
  projects_proposed: 'buttons-only',
  persona_synthesizing: 'buttons-only',
  persona_reviewed: 'buttons-only',
  max_oauth_offered: 'buttons-only',
  wow_fired: 'buttons-only',
  completed: 'freeform',
  failed: 'freeform',
}

/**
 * Sub_steps that legitimately need freeform input even though their parent
 * phase is classified `'buttons-only'` above. When the active sub_step is
 * in the set for its phase, `resolveInteractionMode` returns `'freeform'`
 * so the engine runs its legacy synthetic-`__freeform__` path (and the
 * phase's dedicated freeform handler) instead of stranding the user with
 * the canned buttons-only nudge.
 *
 * Argus r1 BLOCKER 1 + 2 (2026-06-03): the classifier was phase-level
 * only, so these sub_steps inherited buttons-only and intercepted text the
 * prompt body explicitly asks for.
 *
 *   - `persona_reviewed` — `idle` / `pick_line` / `pick_replacement` /
 *     `pending_regen_hint` all advertise a typed reply. Gate-collapse
 *     (#93, 2026-06-05): the `idle` main review screen now carries a
 *     SINGLE "Looks good" button (the "Tweak one line" / "Restart"
 *     buttons were removed per Sam), so a typed reply on it IS the tweak
 *     request — it must reach `consumePersonaReviewedChoice`'s recompose
 *     handler, NOT the router (whose `amend` verdict would stay-and-strand
 *     the r2 way) and NOT the buttons-only nudge. So `idle` is now a
 *     freeform sub_step alongside the legacy recompose sub_steps.
 *   - `import_running` — `rate_limit_paused` (any text re-polls the runner,
 *     `options:[]`) and `failed` (the body says "Paste a fresh URL below to
 *     retry") both advertise a freeform reply
 *     (phase-prompts.ts:1949-1992). The `status` sub_step stays
 *     buttons-only (it's a transit status post, not a question).
 *
 * Argus r4 BLOCKER (2026-06-03): the SAME strand class — a buttons-only
 * phase soliciting typed input from a sub_step — was found in two more
 * places. UNLIKE `import_running` (null knowledge pack, so the router
 * never fired anyway), BOTH of these phases have a NON-NULL pack
 * (`PACK_PROJECTS_PROPOSED`, `PACK_MAX_OAUTH_OFFERED`), so they were LIVE
 * router-stranding bugs (the persona_reviewed r2 mechanism), not just
 * canned-nudge stalls:
 *
 *   - `projects_proposed` — `share_freeform`: tapping "Share what I'm
 *     working on" flips `projects_proposed_share_freeform=true` and
 *     re-emits "Tell me what you're working on" with `options:[]` +
 *     `allow_freeform:true` (phase-prompts.ts:1323-1336). The typed
 *     project list must reach `consumeProjectsProposedChoice`'s dedicated
 *     `awaiting_share_freeform` branch, not the router or the nudge. The
 *     list-review screen (projects.length>0 / zero-projects) stays
 *     buttons-only: its "want to tweak?" freeform is the deferred
 *     "tweak later" case, and it carries real buttons.
 *     [SUPERSEDED IN PART — 2026-06-10, ISSUES #117] The "defer edits to
 *     post-onboarding tools" deferral above no longer governs the POPULATED
 *     list-review screen. The classification HERE is unchanged (this map
 *     still returns 'buttons-only'), but `normalAdvance` (engine.ts, see
 *     the "ISSUES #117" override) flips it to 'freeform' when the
 *     prod-wired router is actually consultable (`shouldConsultRouter` +
 *     non-null knowledge pack + `llmRouter` wired), so a typed
 *     "drop X / add Y / rename Z" routes through the router amend/advance
 *     branches and applies the additive `(seeded ∪ adds) minus
 *     removed_projects` union instead of being nudged away. The historical
 *     rationale stays accurate for the cases it still governs: the
 *     ZERO-projects screen, the `share_freeform` sub_step (dedicated
 *     handler below), and non-router deployments (Codex r1 P2 guard) all
 *     keep the buttons-only handling described above.
 *   - `max_oauth_offered` — `awaiting_byo_paste`: tapping the BYO path
 *     flips `awaiting_byo_paste=true` and re-emits "Paste your Anthropic
 *     API key" with only a "Skip for now" button + `allow_freeform:true`
 *     (phase-prompts.ts:1801-1818). The pasted key must reach
 *     `persistByoApiKeyAndAdvance`, not the router or the nudge.
 *
 * Keyed by the canonical sub_step strings `deriveActiveSubStep` returns.
 * For `persona_reviewed` / `import_running` those are the string values the
 * engine persists directly (`persona_review_sub_step` /
 * `import_running_sub_step`). For `projects_proposed` / `max_oauth_offered`
 * the engine persists a BOOLEAN flag, which `deriveActiveSubStep` maps to
 * the canonical strings below — see that function.
 */
export const FREEFORM_SUB_STEPS_BY_PHASE: Readonly<
  Partial<Record<OnboardingPhase, ReadonlySet<string>>>
> = {
  persona_reviewed: new Set(['idle', 'pick_line', 'pick_replacement', 'pending_regen_hint']),
  import_running: new Set(['rate_limit_paused', 'failed']),
  projects_proposed: new Set(['share_freeform']),
  max_oauth_offered: new Set(['awaiting_byo_paste']),
}

/**
 * Map a phase + its persisted `phase_state` to the active sub_step string
 * the interaction-mode resolver keys on. Centralizes the per-phase
 * `phase_state`-key knowledge in ONE place (next to
 * `FREEFORM_SUB_STEPS_BY_PHASE`) so a new freeform sub_step is a two-line
 * change — an entry here + an entry in the map above — and the engine call
 * site stays generic. This is the "fixable by construction" closure for the
 * recurring buttons-only strand class (Argus r1→r4): the door is shut once
 * every solicited-input sub_step is enumerated in these two structures.
 *
 * Returns `null` for phases with no active sub_step (the common case).
 *
 * Two encodings, because the engine historically chose different shapes:
 *   - `persona_reviewed` / `import_running` persist a STRING sub_step key
 *     (`persona_review_sub_step` / `import_running_sub_step`) — returned
 *     verbatim.
 *   - `projects_proposed` / `max_oauth_offered` persist a BOOLEAN flag
 *     (`projects_proposed_share_freeform` / `awaiting_byo_paste`); the
 *     truthy flag maps to a canonical sub_step string that MUST match the
 *     value listed in `FREEFORM_SUB_STEPS_BY_PHASE` for that phase.
 */
export function deriveActiveSubStep(
  phase: OnboardingPhase,
  phaseState: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  if (phaseState === null || phaseState === undefined) return null
  switch (phase) {
    case 'persona_reviewed': {
      const v = phaseState['persona_review_sub_step']
      return typeof v === 'string' ? v : null
    }
    case 'import_running': {
      const v = phaseState['import_running_sub_step']
      return typeof v === 'string' ? v : null
    }
    case 'projects_proposed':
      return phaseState['projects_proposed_share_freeform'] === true
        ? 'share_freeform'
        : null
    case 'max_oauth_offered':
      return phaseState['awaiting_byo_paste'] === true ? 'awaiting_byo_paste' : null
    default:
      return null
  }
}

/**
 * Per-mixed-phase declared text-input field name(s). The brief requires a
 * mixed phase to declare WHICH text-input fields are valid; non-matching
 * freeform falls through to the canned nudge. Each phase here has exactly
 * one field today; the array shape leaves room for future multi-field
 * phases without a signature change.
 */
export const TEXT_INPUT_FIELDS_BY_PHASE: Readonly<
  Partial<Record<OnboardingPhase, readonly string[]>>
> = {
  agent_name_chosen: ['custom_name'],
  slug_chosen: ['custom_slug'],
  personality_offered: ['custom_description'],
}

/**
 * Exact canned response for buttons-only rejection AND mixed-phase
 * validation failure. Brief § 4 — VERBATIM, do not paraphrase. The
 * em-dash is intentional (this is a product string the brief specifies
 * literally, not a message drafted as Sam).
 */
export const BUTTONS_ONLY_NUDGE_TEXT =
  'Tap one of the buttons above to continue. You can tweak any of this later — just ask me after setup.'

/**
 * Button-FREE fallback nudge — emitted in place of `BUTTONS_ONLY_NUDGE_TEXT`
 * when a buttons-only phase resolves with NO rendered buttons (the LLM
 * resolver returned an option-stripped spec). The original copy promises
 * "tap one of the buttons above"; on an option-less resolution there are
 * no buttons to tap, so the canned line is a dead-end (the
 * BUTTONS_ONLY_NUDGE_TEXT-with-no-buttons repro). This line invites the
 * user to keep going by typing instead, so the conversation never strands.
 * Hyphen, not em-dash, per the draft-as-Sam rule (this is a recovery line,
 * not a product string the brief pins verbatim).
 */
export const NO_BUTTONS_FALLBACK_NUDGE_TEXT = 'Just reply here to continue.'

// K11a3 — the import-source copy consts and the deterministic source-token
// detector (plus its private negation helpers) moved to the zero-import
// leaf `./import-source-copy.ts` (LIVE across the import upload-race seam;
// most of the rest of THIS module dies in K11b1). Transition re-export so
// every existing importer keeps compiling mid-repoint.
export {
  IMPORT_SOURCE_SWITCH_ACK,
  LATE_UPLOAD_SOURCE_MISMATCH_NOTICE,
  detectImportSourceMention,
} from './import-source-copy.ts'

/**
 * Resolve the effective interaction mode for a phase + (optional) active
 * sub_step.
 *
 * Precedence:
 *   1. An explicit `spec.interaction_mode` (per-emit override) — wins
 *      unconditionally so a dynamically-built spec can opt a single emit
 *      into a different mode.
 *   2. A sub_step override (`FREEFORM_SUB_STEPS_BY_PHASE`) — a buttons-only
 *      phase whose active sub_step legitimately needs freeform input
 *      resolves to `'freeform'` so the engine does NOT intercept that
 *      input with the canned nudge (Argus r1 BLOCKER 1 + 2).
 *   3. The central per-phase classification (`INTERACTION_MODE_BY_PHASE`).
 *
 * `activeSubStep` is the value the engine reads off `phase_state` for the
 * phase (`persona_review_sub_step` / `import_running_sub_step`); pass
 * `null`/`undefined` for phases without sub_steps.
 */
export function resolveInteractionMode(
  spec: Pick<PhasePromptSpec, 'interaction_mode'> | null | undefined,
  phase: OnboardingPhase,
  activeSubStep?: string | null,
): InteractionMode {
  if (spec && spec.interaction_mode !== undefined) return spec.interaction_mode
  if (activeSubStep !== null && activeSubStep !== undefined) {
    const freeformSteps = FREEFORM_SUB_STEPS_BY_PHASE[phase]
    if (freeformSteps !== undefined && freeformSteps.has(activeSubStep)) {
      return 'freeform'
    }
  }
  return INTERACTION_MODE_BY_PHASE[phase]
}

/**
 * True when `activeSubStep` is a freeform sub_step of `phase` (i.e. it is
 * listed in `FREEFORM_SUB_STEPS_BY_PHASE`).
 *
 * Argus r2 BLOCKER (2026-06-03): `resolveInteractionMode` already returns
 * `'freeform'` for these sub_steps, but the engine's freeform branch then
 * still consults the LLM router (`shouldConsultRouter`) before falling
 * through to the synthetic-`__freeform__` path. For a phase with a
 * non-null knowledge pack (`persona_reviewed`), the router fires and a
 * misclassification (`answer` / `amend` instead of `advance`) re-emits the
 * keyboard and NEVER reaches the sub_step's dedicated handler
 * (recompose / retry / re-poll) — the same stranding symptom as r1, a
 * different mechanism.
 *
 * The engine uses this predicate to BYPASS the router for freeform
 * sub_steps: the typed text IS the answer to that sub_step, not an intent
 * to classify — exactly the rationale the `'mixed'` branch already
 * documents. Distinct from `resolveInteractionMode === 'freeform'`, which
 * is ALSO true for the genuinely-freeform phases (`signup`,
 * `work_interview_gap_fill`) where the router SHOULD still run.
 */
export function isFreeformSubStep(
  phase: OnboardingPhase,
  activeSubStep?: string | null,
): boolean {
  if (activeSubStep === null || activeSubStep === undefined) return false
  const freeformSteps = FREEFORM_SUB_STEPS_BY_PHASE[phase]
  return freeformSteps !== undefined && freeformSteps.has(activeSubStep)
}

export interface MixedTextInputResult {
  /** True when the text is a legitimate answer to this mixed phase. */
  valid: boolean
  /** The declared field the text satisfied, when valid. */
  field: string | null
  /** Cleaned value to forward downstream (trimmed / control-char-stripped). */
  sanitized: string
  /**
   * Canonical validator reason when the text was rejected, or `null`.
   *
   * Argus r5 BLOCKER (2026-06-03): a mixed phase that owns a canonical
   * validator (`agent_name_chosen` → `validateAgentName`) surfaces THAT
   * reason here so the engine can show the real error instead of the
   * generic buttons-only nudge. The nudge ("Tap one of the buttons
   * above") is a hard stall on `agent_name_chosen`, which emits
   * `options:[]` — there are no buttons to tap. `null` keeps the legacy
   * generic-nudge behavior for phases that DO carry buttons on the
   * rejection screen (`slug_chosen`) or have no specific reason
   * (`personality_offered`).
   */
  error: string | null
}

// Matches a single ASCII C0 control char, DEL, or a C1 control char.
// Split out as a named constant so the literal regex never carries raw
// control bytes inline (which mangle on copy/paste).
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g

/** Strip control chars + collapse runs of whitespace; trim. */
function sanitizePlainText(text: string): string {
  return text.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Validate a freeform reply on a `'mixed'` phase against that phase's
 * declared text-input field. Returns `valid:false` for any phase that is
 * not mixed, or any text that doesn't satisfy the field's rule — the
 * engine renders the canned nudge (or, when `error` is non-null, the
 * canonical validator reason) in that case.
 *
 * Per-phase rules (brief § 2):
 *   - agent_name_chosen → `custom_name`: DELEGATES to the Sam-locked
 *     canonical `validateAgentName` (phase-prompts.ts) — see the case
 *     comment. NOT a local copy (Argus r5 BLOCKER).
 *   - slug_chosen → `custom_slug`: the existing slug grammar
 *     (`runtime/slug-grammar.ts`). The user's raw text is sanitized to a
 *     candidate slug; valid when that candidate passes `isFormatLegal`.
 *     This is the SAME `sanitizeToSlug` the downstream slug-picker bridge
 *     (`provisioning/onboarding-api/slug-picker-bridge.ts`)
 *     applies to `raw_input`, so the pre-gate and the canonical path are
 *     aligned by construction — no divergence (Argus r5 slug audit).
 *   - personality_offered → `custom_description`: free text, sanitized;
 *     valid when non-empty after sanitize and within a sane length cap.
 */
export function validateMixedTextInput(
  phase: OnboardingPhase,
  rawText: string,
): MixedTextInputResult {
  const text = sanitizePlainText(rawText)
  if (text.length === 0) {
    return { valid: false, field: null, sanitized: '', error: null }
  }

  switch (phase) {
    case 'agent_name_chosen': {
      // Argus r5 BLOCKER (2026-06-03): DELEGATE to the Sam-locked
      // canonical validator instead of a duplicated-and-diverging local
      // rule. The previous local regex (`/^[\p{L}\p{N} -]{2,30}$/u`)
      // forbade apostrophes and capped at 30 chars; the canonical
      // `validateAgentName` allows apostrophes, caps at 32, and adds the
      // letter-first + reserved-name checks. The narrower pre-gate
      // stranded valid names ("O'Neill", 31-32 char names) on the
      // buttonless nudge (agent_name_chosen emits `options:[]`) — the
      // exact strand class this sprint exists to kill, re-introduced by
      // the branch's own gate. On failure we carry the canonical `reason`
      // so the engine surfaces the real, recoverable error rather than
      // the generic "tap a button" nudge.
      const validation = validateAgentName(text)
      return validation.ok
        ? { valid: true, field: 'custom_name', sanitized: validation.value, error: null }
        : { valid: false, field: null, sanitized: text, error: validation.reason }
    }
    case 'slug_chosen': {
      // `sanitizeToSlug` returns `null` (not '') when the text has no
      // slug-able characters; guard before the format check.
      const candidate = sanitizeToSlug(text)
      return typeof candidate === 'string' && isFormatLegal(candidate)
        ? { valid: true, field: 'custom_slug', sanitized: text, error: null }
        : { valid: false, field: null, sanitized: text, error: null }
    }
    case 'personality_offered':
      // Free text — accept anything non-empty up to a generous cap so the
      // user can describe a personality "in their own words". The persona
      // synthesis downstream consumes it; we only guard against absurd
      // lengths here.
      return text.length <= 2000
        ? { valid: true, field: 'custom_description', sanitized: text, error: null }
        : { valid: false, field: null, sanitized: text.slice(0, 2000), error: null }
    default:
      return { valid: false, field: null, sanitized: text, error: null }
  }
}
