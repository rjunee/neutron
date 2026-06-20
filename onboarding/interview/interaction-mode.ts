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

/**
 * Short reassurance line emitted right before the import-source SELECTION
 * buttons are re-rendered when a user types ANY non-upload freeform at
 * `import_upload_pending` (ISSUES #84). Worded for a general "bring back the
 * options" intent — the engine no longer distinguishes an explicit switch
 * from a bare clarification; both route here. Hyphen, not em-dash, per the
 * draft-as-Sam rule.
 */
export const IMPORT_SOURCE_SWITCH_ACK =
  'No problem - pick the service you would like to import from:'

/**
 * Surfaced when a ZIP finishes uploading AFTER the user typed freeform at
 * `import_upload_pending` (which reroutes to the source picker, phase
 * `ai_substrate_offered`) AND the uploaded source no longer matches the
 * source we have on record. We deliberately do NOT silently import the
 * stale file — but we also never drop it with a silent ok:true.
 *
 * COPY HONESTY (Argus r2 BLOCKER): tapping a service routes through
 * `advanceFromAiSubstrateOfferedToUpload`, which re-emits upload
 * instructions for the chosen service — it does NOT consume the ZIP that
 * just landed. So the copy must NOT promise auto-run ("I will run it");
 * the landed file is for the OTHER service and the user has to upload the
 * chosen service's export afresh. We set that expectation plainly.
 * Hyphen, not em-dash, per the draft-as-Sam rule.
 */
export const LATE_UPLOAD_SOURCE_MISMATCH_NOTICE = (
  source: 'chatgpt' | 'claude',
): string =>
  `Got your ${source === 'chatgpt' ? 'ChatGPT' : 'Claude'} upload - but it looks like you were switching services. Tap the service you want above to start its import, then upload that service's export again so I can run it.`

/**
 * Negation cues that turn a source MENTION into a NON-switch ("I don't have a
 * GPT export", "no claude export here"). Kept apostrophe-and-bare so both
 * "don't" and "dont" match after lowercasing.
 */
const NEGATION_TOKENS = new Set([
  "don't",
  'dont',
  'not',
  'no',
  'never',
  "haven't",
  'havent',
  "won't",
  'wont',
  "can't",
  'cant',
  'cannot',
  'without',
  "didn't",
  'didnt',
  "doesn't",
  'doesnt',
])

/**
 * Affirmative "keep / switch" verbs. When one of these follows a CLAUSE
 * BOUNDARY after a negation, the negation does NOT apply to the source — the
 * user opened a fresh clause that re-affirms it ("no, keep chatgpt" / "no,
 * switch to claude").
 *
 * Argus r2 BLOCKER: this set deliberately EXCLUDES direct-object verbs
 * (want / use / do / go / try / pick / choose / prefer / change / rather).
 * Those are exactly the verbs people put DIRECTLY AFTER a negation to DECLINE
 * a named source — "I don't want claude" / "don't use gpt" / "never use
 * chatgpt". Treating them as affirmations re-opened the ISSUES #98 dead-end:
 * the decline recorded a bogus switch-intent, which then REFUSED the user's
 * own legitimate upload of the staged source. Only evidence-backed
 * keep/switch verbs survive (Argus r2 MINOR: trim the speculative 14-entry
 * list).
 */
const AFFIRM_VERBS = new Set([
  'keep',
  'stick',
  'stay',
  'leave',
  'switch',
  'instead',
])

/**
 * Clause-boundary tokens (comma / "but" / "actually"). The negation override
 * fires ONLY when an {@link AFFIRM_VERBS} verb sits AFTER one of these between
 * the negation and the source mention — i.e. the affirm clearly begins a new
 * "keep the current one" clause ("no, keep X"), NOT a continuation of the
 * negation ("don't keep X", which still declines X). Conservative by design
 * (Argus r2 BLOCKER): a missed switch is harmless (the user just taps the
 * button); a false affirm refuses a real upload.
 */
const CLAUSE_BOUNDARIES = new Set([',', 'but', 'actually'])

/**
 * True when the source mention at `matchIndex` is governed by a leading
 * negation in the preceding text (so the user is NOT switching to it). The
 * nearest preceding negation cue wins, UNLESS a clause boundary followed by an
 * affirmative keep/switch verb sits between it and the mention — that opens a
 * new clause re-affirming the source ("no, keep X" / "no, switch to X"). A
 * bare affirm with no clause boundary ("don't keep X") stays negated.
 */
function mentionIsNegated(lowerText: string, matchIndex: number): boolean {
  const before = lowerText
    .slice(0, matchIndex)
    // Isolate commas as their own tokens so a clause boundary survives the
    // punctuation strip below (otherwise "waiting," tokenizes as one word).
    .replace(/,/g, ' , ')
    .replace(/[^a-z0-9',\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
  let negIdx = -1
  for (let i = 0; i < before.length; i++) {
    if (NEGATION_TOKENS.has(before[i] as string)) negIdx = i
  }
  if (negIdx === -1) return false
  let sawBoundary = false
  for (let i = negIdx + 1; i < before.length; i++) {
    const w = before[i] as string
    if (CLAUSE_BOUNDARIES.has(w)) {
      sawBoundary = true
      continue
    }
    if (sawBoundary && AFFIRM_VERBS.has(w)) return false
  }
  return true
}

/**
 * Deterministic (no-LLM) source-token detector for the import freeform
 * reroute. Returns the single AI substrate UNAMBIGUOUSLY named in the
 * user's freeform text, or `null` when the text names neither source,
 * BOTH (ambiguous), or names one only under a leading negation.
 *
 * Used to record "switch-intent" when a user types an explicit switch at
 * `import_upload_pending` (ISSUES #98). The reroute to the source picker
 * fires on ANY freeform (ISSUES #84 — the verb-gated detector was retired),
 * so this detector does NOT gate the reroute; it only annotates WHICH source
 * the user named, so a late upload of the ABANDONED source is not
 * auto-honored after the user signalled a move to the other one.
 *
 * Word-boundary matching keeps `gpt` from matching inside other words and
 * `claude` from matching substrings; `openai` / `anthropic` are accepted as
 * the vendor synonyms users actually type.
 *
 * Negation-aware (Argus r1b IMPORTANT): a bare word-boundary match recorded a
 * false switch-intent on incidental/negated mentions ("I don't have a GPT
 * export" while mid-Claude-upload), which then REFUSED the user's own
 * legitimate Claude upload. A source mention governed by a leading negation
 * (don't / no / not / haven't …) is ignored UNLESS a clause boundary + an
 * affirmative keep/switch verb re-affirms it ("no, keep chatgpt"). The override
 * is deliberately CONSERVATIVE (Argus r2 BLOCKER): a negation followed by a
 * direct-object verb ("I don't want claude" / "don't use gpt" / "never use
 * chatgpt") stays negated → null, so a decline of the other service never
 * records a bogus switch-intent that refuses the user's real upload. See
 * {@link mentionIsNegated}.
 */
export function detectImportSourceMention(
  text: string,
): 'chatgpt' | 'claude' | null {
  const t = text.toLowerCase()
  // Scan ALL occurrences of each source, not just the first (Argus r3 +
  // Codex). A source is MENTIONED if ANY of its occurrences is non-negated,
  // so "I dont have the claude export yet, but switch to claude" (the first
  // `claude` is negated, the second affirmed) still records a claude switch.
  // A source whose ONLY occurrence is negated ("I dont want claude") stays
  // unmentioned → null, preserving the r2 conservative-decline behavior.
  const mentionsChatgpt = anyMatchAffirmed(
    t,
    /\bchat\s?gpt\b|\bopenai\b|\bgpt\b/g,
  )
  const mentionsClaude = anyMatchAffirmed(t, /\bclaude\b|\banthropic\b/g)
  if (mentionsChatgpt && !mentionsClaude) return 'chatgpt'
  if (mentionsClaude && !mentionsChatgpt) return 'claude'
  return null
}

/**
 * True when `pattern` (a global regex) has at least one match in `lowerText`
 * that is NOT governed by a leading negation. A source is treated as named
 * when any single occurrence stands un-negated, even if other occurrences of
 * the same source are negated. Returns false when the source is absent or
 * every occurrence is negated. See {@link detectImportSourceMention}.
 */
function anyMatchAffirmed(lowerText: string, pattern: RegExp): boolean {
  for (const m of lowerText.matchAll(pattern)) {
    if (!mentionIsNegated(lowerText, m.index)) return true
  }
  return false
}

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
