/**
 * @neutronai/onboarding — interview engine persona seam.
 *
 * R5 / audit P2-4 — the 8 persona methods extracted from the
 * `InterviewEngine` god-class as free functions. Each takes the engine
 * instance as `self: EngineInternals` (its first parameter) and is a
 * VERBATIM copy of the original method body with `this.` rewritten to
 * `self.`. `engine.ts` keeps a one-line delegator method per function so
 * the class's public API + every call site is byte-for-byte unchanged.
 *
 * This is a PURE MOVE — no logic, control-flow, or comment changes.
 */

import { createLogger } from '@neutronai/logger'
import type { ButtonChoice } from '@neutronai/channels/button-primitive.ts'
import { isLegalTransition, type OnboardingPhase } from './phase.ts'
import {
  DEFAULT_PERSONALITY_SUGGESTIONS,
  parseCharacterChoiceIndex,
  parsePersonalitySuggestionIndex,
  PERSONA_MAX_RESTARTS,
  PERSONA_REVIEWED_EDIT_LINE,
  PERSONA_REVIEWED_LOOKS_GOOD,
  PERSONA_REVIEWED_RESTART,
  PERSONA_SYNTH_RETRY,
  PERSONA_SYNTH_SKIP,
  PERSONA_SYNTH_USE_BASIC,
  PERSONALITY_CHARACTER_PREFIX,
  PERSONALITY_SUGGESTION_PREFIX,
} from './phase-prompts.ts'
import {
  characterNamesInRenderOrder,
  readMemoizedCharacterSuggestions,
} from './personality-character-suggester.ts'
import { PersonaError, type PersonaDraft } from '../persona-gen/compose.ts'
import type { OnboardingState } from './state-store.ts'
import type { AdvanceInput, AdvanceResult } from './engine-internals.ts'
import {
  buildComposeInput,
  type EngineInternals,
  InterviewError,
  NON_ADVANCING_CHOICE_VALUES,
  parseBareOptionNumber,
  readNumber,
  readPersonaDraft,
  readPersonaReviewSubStep,
  readString,
  serializeDraft,
  stubDraft,
} from './engine-internals.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

const log = createLogger('onboarding-engine')

/**
 * P2 v2 § 0 locked decision #9 + § 3.9 + § 4.1 — sole handler for the
 * `personality_offered` phase.
 *
 * The user replies in natural language describing the desired agent
 * personality. Per spec § 2.6 (Sam-locked 2026-05-15) the engine does
 * NOT show a curated A/B/C/D archetype menu — the LLM may suggest
 * examples in the prompt body, but the user's reply is treated as
 * free-form text that lands on `phase_state.agent_personality`.
 *
 * Curated archetype blending (e.g. "Sherlock Holmes meets Marcus
 * Aurelius" → BlendedArchetype with the curated voice fragments)
 * happens later, at `persona_synthesizing` time, inside
 * `PersonaComposer.compose` via `composeFromFreeText`. The engine
 * carries NO ArchetypeLibrary dependency — see spec § 7.1 +
 * § 7.2.
 *
 * Advance gate (§ 3.9): extracted `agent_personality` must be ≥ 4
 * chars after trim. On failure, stay + re-emit with a rejection
 * reason. On success, persist locally + via `personaSync` and route
 * to `agent_name_chosen`.
 */
export async function consumePersonalityOfferedChoice(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const choice_value = choice.choice_value
    const freeform =
      choice.freeform_text !== undefined && choice.freeform_text.length > 0
        ? choice.freeform_text.trim()
        : null
    if (was_new) {
      self.deps.transcript.append({
        role: 'user',
        body: freeform ?? choice_value,
        phase: 'personality_offered',
        button_prompt_id: choice.prompt_id,
        button_choice: choice_value,
      })
    }

    // Synthetic timeout / cancel sentinels are non-answers. Pre-clean-
    // kill, the deleted archetype handler short-circuited here; this
    // guard preserves that contract — DON'T mutate phase_state, DON'T
    // write a rejection, DON'T re-emit a "too short" prompt at the
    // user. The session just stays at personality_offered; the next
    // real reply drives the advance.
    if (NON_ADVANCING_CHOICE_VALUES.has(choice_value)) {
      return { outcome: 'no_active_prompt', state }
    }

    // v0.1.80 (2026-05-22) — character-button tap. The 5 character
    // buttons emit `value = "character:<index>"` (index ∈ 0..4 in
    // render order: personalized first, then wild). A button tap
    // deterministically captures the character name by indexing into
    // the memoized `personality_character_suggestions`, regardless of
    // what the LLM extractor returns. This wins over both
    // `extracted_personality` and `freeform` because the user
    // explicitly picked from the menu.
    //
    // Codex r3 P1 (2026-05-22): wire format MUST be index, not name —
    // ButtonOption.value caps at 37 UTF-8 bytes and LLM-generated
    // names can exceed 27 bytes (e.g. "Albus Percival Wulfric Brian
    // Dumbledore" = 39). The index form (max `character:4` = 11 bytes)
    // is trivially safe.
    //
    // Kieran r1 (2026-05-22) BLOCKING: the validator MUST close — when
    // the memoized suggestions are missing (schema drift, persist-failure
    // race), DO NOT accept the choice_value. A tampered client could
    // otherwise drop a megabyte of text into `agent_personality`. When
    // the prefix is present but validation fails (missing memo,
    // out-of-range index, malformed shape), we fall through to the
    // standard `extracted_personality ?? freeform` cascade — the click
    // is treated like an unknown button tap.
    let character_button_pick: string | null = null
    if (choice_value.startsWith(PERSONALITY_CHARACTER_PREFIX)) {
      const idx = parseCharacterChoiceIndex(choice_value)
      const memoized = readMemoizedCharacterSuggestions(
        (state.phase_state as Record<string, unknown>)['personality_character_suggestions'],
      )
      // Kieran r1 BLOCKING (closed validator): map the index ONLY against
      // the memoized list that actually shipped. 2026-06-04: the render now
      // persists WHATEVER it shows (real picks OR the seeded fallback, with
      // its `source`), so a tap on a fallback render still finds a memoized
      // list here — there is no need to re-derive, and a `character:<n>`
      // callback with NO memoized list (unwired-legacy `personality:<index>`
      // render, or a persist failure) is rejected rather than mapped to a
      // never-rendered character. The resolved name comes from OUR bounded
      // constant set, never from client-supplied text.
      if (idx !== null && memoized !== null) {
        const names = characterNamesInRenderOrder(memoized)
        if (idx < names.length) {
          const resolved = names[idx]
          if (typeof resolved === 'string' && resolved.length > 0) {
            character_button_pick = resolved
          }
        }
      }
    }

    // v0.1.121 (2026-06-04) — LEGACY suggestion-button tap. When the
    // character-suggester dep is unwired the prompt renders the 3 static
    // defaults as `personality:<index>` buttons (phase-prompts.ts:
    // buildPersonalityOfferedPromptSpec legacy path). Resolve the index
    // against the SAME shared `DEFAULT_PERSONALITY_SUGGESTIONS` constant
    // the builder rendered. Like the character path, a malformed / out-of-
    // range index falls through to the `extracted_personality ?? freeform`
    // cascade rather than accepting an unvalidated value.
    let legacy_suggestion_pick: string | null = null
    if (
      character_button_pick === null &&
      choice_value.startsWith(PERSONALITY_SUGGESTION_PREFIX)
    ) {
      const idx = parsePersonalitySuggestionIndex(choice_value)
      if (idx !== null && idx < DEFAULT_PERSONALITY_SUGGESTIONS.length) {
        const resolved = DEFAULT_PERSONALITY_SUGGESTIONS[idx]
        if (typeof resolved === 'string' && resolved.length > 0) {
          legacy_suggestion_pick = resolved
        }
      }
    }

    // Item 3 (2026-06-19, owner live-dogfood) — NUMBERED pick. The owner
    // typed "3" to choose the 3rd character and got "I didn't catch what
    // you'd like" because a bare number is freeform text (len 1 < 4) → it
    // failed the ≥4-char advance gate and looped back with a DIFFERENT
    // suggestion set. A typed number N (1-based, matching the rendered
    // order) must select the SAME option a tap on `character:<N-1>` would,
    // resolved against the SAME memoized list so the options never change
    // between turns/reloads. We map ONLY against the memoized suggestions
    // (the closed-validator discipline the button path uses): a bare number
    // with no memoized list falls through to the freeform cascade.
    let numbered_pick: string | null = null
    if (
      character_button_pick === null &&
      legacy_suggestion_pick === null &&
      freeform !== null
    ) {
      const oneBased = parseBareOptionNumber(freeform)
      if (oneBased !== null) {
        const memoized = readMemoizedCharacterSuggestions(
          (state.phase_state as Record<string, unknown>)[
            'personality_character_suggestions'
          ],
        )
        if (memoized !== null) {
          const names = characterNamesInRenderOrder(memoized)
          const idx = oneBased - 1
          if (idx >= 0 && idx < names.length) {
            const resolved = names[idx]
            if (typeof resolved === 'string' && resolved.length > 0) {
              numbered_pick = resolved
            }
          }
        }
      }
    }

    const candidate =
      character_button_pick ??
      legacy_suggestion_pick ??
      numbered_pick ??
      freeform

    if (candidate === null || candidate.length < 4) {
      // Stay + re-emit with the rejection reason. Spec § 3.9 advance
      // criterion: "extracted_fields.agent_personality extracted and
      // ≥ 4 chars" — anything shorter loops back without persisting.
      self.invalidateResolvedSpec(input.project_slug, 'personality_offered')
      const reason =
        "I didn't catch what you'd like — tell me in a few words (or describe a style you have in mind)."
      const prior_attempts =
        readNumber(state.phase_state, 'personality_offered_attempt_count') ?? 0
      const next_attempts = prior_attempts + 1
      const stay_patch: Record<string, unknown> = {
        active_prompt_id: null,
        last_choice_value: choice_value,
        ...(freeform !== null ? { last_choice_freeform: freeform } : {}),
        personality_offered_rejection: reason,
        personality_offered_attempt_count: next_attempts,
      }
      const stayed = await self.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'personality_offered',
        phase_state_patch: stay_patch,
        advanced_at: observed_at,
      })
      let final_state: OnboardingState | null = null
      const emit = await self.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: 'personality_offered',
        observed_at,
        seed_suffix: `attempt=${next_attempts}`,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await self.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: 'personality_offered',
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      return {
        outcome: 'reemitted_current',
        state: final_state ?? stayed,
        prompt_id: emit.prompt_id,
      }
    }

    // Cap at 240 chars — defensive against runaway pasted text.
    const agent_personality = candidate.length > 240 ? candidate.slice(0, 240) : candidate

    // Persist to canonical registry row (best-effort; same pattern as
    // recordAgentName / recordUserFirstName).
    if (
      self.deps.personaSync !== undefined &&
      self.deps.personaSync.recordAgentPersonality !== undefined
    ) {
      try {
        await self.deps.personaSync.recordAgentPersonality({
          project_slug: input.project_slug,
          agent_personality,
        })
      } catch (err) {
        log.warn('persona_sync_record_agent_personality_failed', {
          project: input.project_slug,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (!isLegalTransition('personality_offered', 'agent_name_chosen')) {
      throw new InterviewError(
        'personality_offered',
        'illegal_transition',
        false,
        'personality_offered → agent_name_chosen is not legal',
      )
    }
    const advance_patch: Record<string, unknown> = {
      active_prompt_id: null,
      last_choice_value: choice_value,
      ...(freeform !== null ? { last_choice_freeform: freeform } : {}),
      agent_personality,
      personality_offered_rejection: null,
      personality_offered_attempt_count: null,
      // Kieran r1 I4 (2026-05-22) — clear the memoized suggestions on
      // forward-advance so the ~1 KB blob doesn't ride along on every
      // downstream phase's serialized state.
      personality_character_suggestions: null,
    }
    const advanced = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'agent_name_chosen',
      phase_state_patch: advance_patch,
      advanced_at: observed_at,
    })
    // 2026-06-04 — kick off the agent-name suggester the moment the
    // personality is captured (it conditions the names), so the
    // agent_name_chosen body-render below dedupe-awaits the SAME in-flight
    // promise instead of cold-spawning a second subprocess. Fire-and-
    // forget; persists only real picks. Names can't pre-compute earlier
    // than this turn because they depend on the just-chosen personality.
    fireAndForget('engine-persona.getOrStartAgentNameSuggestions', self.getOrStartAgentNameSuggestions(
      input.project_slug,
      input.user_id,
      (advanced.phase_state ?? {}) as Record<string, unknown>,
    ))
    let final_state: OnboardingState | null = null
    const emit = await self.emitPhasePrompt({
      project_slug: input.project_slug,
      user_id: input.user_id,
      topic_id: input.topic_id,
      phase: 'agent_name_chosen',
      observed_at,
      pre_send_state_upsert: async (prompt_id: string) => {
        final_state = await self.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: 'agent_name_chosen',
          phase_state_patch: { active_prompt_id: prompt_id },
          advanced_at: observed_at,
        })
      },
    })
    if (final_state === null) {
      final_state = (await self.deps.stateStore.get(input.project_slug, input.user_id)) ?? advanced
    }
    return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
  }

/**
 * ISSUES #1 (2026-05-19) — resume-path guard for `synthesizePersona`.
 * Returns `true` iff the engine should fire `synthesizePersona` for a
 * instance that is sitting at `persona_synthesizing` WITHOUT a freshly
 * arriving inbound choice (i.e. a reconnect / re-emit / normalAdvance
 * landing on the phase from a prior interrupted run, OR a gateway
 * restart mid-compose).
 *
 * Returns `false` when:
 *   - the phase is not `persona_synthesizing` (defensive),
 *   - no composer is wired (the unwired skeleton path advances
 *     directly to `persona_reviewed` from inside `synthesizePersona`;
 *     we don't run that branch on resume because there is no draft
 *     to publish — the resume just re-emits the static body),
 *   - a prior compose failure persisted `persona_compose_failure_reason`
 *     (the fallback prompt is the right user-facing artefact; the
 *     auto-retry is the user's call via the Try-again button), OR
 *   - a `persona_draft` is already on phase_state (rare race: compose
 *     succeeded but the advance upsert never completed in the prior
 *     turn — don't re-compose, let the caller advance through).
 *
 * Idempotency: at most one in-flight compose per (project_slug,
 * observed_at) window. Both call-sites (`normalAdvance` and
 * `emitCurrentPhasePrompt`) run inside `advance()` which holds the
 * per-instance ordering via `clearResolvedSpecCache` + sequential
 * awaits; a second concurrent advance() would read `persona_draft`
 * (or `persona_compose_failure_reason`) from the now-updated state
 * and short-circuit here.
 */
export async function shouldRetrySynthesizePersonaOnResume(
  self: EngineInternals,
    state: OnboardingState,
  ): Promise<boolean> {
    if (state.phase !== 'persona_synthesizing') return false
    if (self.deps.personaComposer === undefined) return false
    const phase_state = state.phase_state as Record<string, unknown>
    if (
      readString(phase_state, 'persona_compose_failure_reason') !== null
    ) {
      return false
    }
    if (readPersonaDraft(phase_state) !== null) return false
    return true
  }

/**
 * T1 (2026-05-13) — fire `PersonaComposer.compose()` on the transition
 * INTO `persona_synthesizing` per docs/plans/P2-onboarding.md § 2.6 +
 * § 4.8. The caller has already advanced state to `persona_synthesizing`
 * and persisted the captured signals on phase_state. This method:
 *
 *   1. Builds a `ComposeInput` from the persisted signals + fallback
 *      blend (T5 wires the real archetype lookup; until then a
 *      `PERSONA_FALLBACK_BLEND` keeps the pipeline runnable so
 *      downstream wiring lands in front of every archetype + import
 *      branch).
 *   2. Calls `personaComposer.compose(...)` which runs the cringe-
 *      check loop internally and throws `PersonaError` on cap
 *      exceeded.
 *   3. On success: stashes the returned `PersonaDraft` into
 *      phase_state (so the dynamic `persona_reviewed` body can render
 *      first-30-line slices) and advances the state to
 *      `persona_reviewed` so the caller's emit branch fires the
 *      review prompt.
 *   4. On failure: stays at `persona_synthesizing`, persists
 *      `persona_compose_failure_reason`, and directly emits the
 *      Try-again / Use-basic-template / Skip-persona fallback prompt.
 */
export async function synthesizePersona(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<OnboardingState> {
    const hook = self.deps.personaComposer
    if (hook === undefined) {
      // P2 v2 — when the composer is unwired, persona_synthesizing is a
      // pure transit phase. Advance state to persona_reviewed so the
      // walker (which no longer has persona_synthesizing in its
      // AUTO_SKIP set per § 3.13) can move past on its own. The post-
      // advance emit at the caller fires the persona_reviewed body.
      if (!isLegalTransition('persona_synthesizing', 'persona_reviewed')) {
        return state
      }
      return await self.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'persona_reviewed',
        phase_state_patch: { active_prompt_id: null },
        advanced_at: observed_at,
      })
    }
    const compose_input = buildComposeInput(input.project_slug, state)
    let draft: PersonaDraft
    try {
      draft = await hook.compose(compose_input)
    } catch (err) {
      const reason =
        err instanceof PersonaError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      self.deps.transcript.append({
        role: 'system',
        body: `persona-gen: compose failed: ${reason}`,
        phase: 'persona_synthesizing',
      })
      const failed = await self.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'persona_synthesizing',
        phase_state_patch: {
          active_prompt_id: null,
          persona_compose_failure_reason: reason,
        },
        advanced_at: observed_at,
      })
      // Emit the fallback prompt directly so the user has a way
      // forward. The caller's post-advance emit branch checks
      // `STATIC_PHASE_SPECS[persona_synthesizing]` which is undefined,
      // so without this direct emit the user would be stranded with no
      // prompt body at all.
      let final_state: OnboardingState | null = null
      await self.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: 'persona_synthesizing',
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await self.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: 'persona_synthesizing',
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      return final_state ?? failed
    }
    self.deps.transcript.append({
      role: 'system',
      body: `persona-gen: drafted soul=${draft.regen_attempts.soul}, user=${draft.regen_attempts.user}, priority_map=${draft.regen_attempts.priority_map} regen attempts`,
      phase: 'persona_synthesizing',
    })
    if (!isLegalTransition('persona_synthesizing', 'persona_reviewed')) {
      throw new InterviewError(
        'persona_synthesizing',
        'illegal_transition',
        false,
        'persona-gen: illegal transition persona_synthesizing → persona_reviewed',
      )
    }
    return await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'persona_reviewed',
      phase_state_patch: {
        active_prompt_id: null,
        persona_draft: serializeDraft(draft),
        persona_review_sub_step: 'idle',
        persona_review_rejection: null,
        persona_compose_failure_reason: null,
      },
      advanced_at: observed_at,
    })
  }


/**
 * T1 (2026-05-13) — handle the fallback prompt on `persona_synthesizing`
 * when a prior compose attempt failed. Three options:
 *
 *   - Try again → re-invoke `compose()` with the same inputs
 *   - Use basic template → commit a stub draft + advance to
 *     persona_reviewed
 *   - Skip persona → commit a stub draft tagged `skipped` + advance
 */
export async function consumePersonaSynthesizingChoice(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const hook = self.deps.personaComposer
    if (hook === undefined) {
      return { outcome: 'no_active_prompt', state }
    }
    const phase_state = state.phase_state as Record<string, unknown>
    const choice_value = choice.choice_value
    if (was_new) {
      self.deps.transcript.append({
        role: 'user',
        body: choice_value,
        phase: state.phase,
        button_prompt_id: choice.prompt_id,
        button_choice: choice_value,
      })
    }

    if (choice_value === PERSONA_SYNTH_RETRY) {
      const compose_input = buildComposeInput(input.project_slug, state)
      let draft: PersonaDraft
      try {
        draft = await hook.compose(compose_input)
      } catch (err) {
        const reason =
          err instanceof PersonaError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err)
        const retry_count =
          (readNumber(phase_state, 'persona_synth_retry_count') ?? 0) + 1
        const updated = await self.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: 'persona_synthesizing',
          phase_state_patch: {
            active_prompt_id: null,
            persona_compose_failure_reason: reason,
            persona_synth_retry_count: retry_count,
          },
          advanced_at: observed_at,
        })
        let final_state: OnboardingState | null = null
        const emit = await self.emitPhasePrompt({
          project_slug: input.project_slug,
          user_id: input.user_id,
          topic_id: input.topic_id,
          phase: 'persona_synthesizing',
          observed_at,
          seed_suffix: `retry=${retry_count}`,
          pre_send_state_upsert: async (prompt_id: string) => {
            final_state = await self.deps.stateStore.upsert({
              project_slug: input.project_slug,
              user_id: input.user_id,
              phase: 'persona_synthesizing',
              phase_state_patch: { active_prompt_id: prompt_id },
              advanced_at: observed_at,
            })
          },
        })
        if (final_state === null) final_state = updated
        return {
          outcome: 'reemitted_current',
          state: final_state,
          prompt_id: emit.prompt_id,
        }
      }
      // Retry succeeded — stash + advance.
      return await self.advancePersonaSynthToReviewed(
        input,
        observed_at,
        serializeDraft(draft),
      )
    }

    if (
      choice_value === PERSONA_SYNTH_USE_BASIC ||
      choice_value === PERSONA_SYNTH_SKIP
    ) {
      const compose_input = buildComposeInput(input.project_slug, state)
      const stub = stubDraft(input.project_slug, compose_input, choice_value)
      self.deps.transcript.append({
        role: 'system',
        body:
          choice_value === PERSONA_SYNTH_USE_BASIC
            ? 'persona-gen: used basic template fallback'
            : 'persona-gen: skipped persona files',
        phase: state.phase,
      })
      return await self.advancePersonaSynthToReviewed(
        input,
        observed_at,
        serializeDraft(stub),
      )
    }

    // Codex r1 P2 — unknown choice_value (stale app client, tampered
    // app-socket request, or a future option that this build doesn't
    // recognize). Do NOT auto-advance to persona_reviewed: that would
    // bypass the user's retry/basic/skip decision and ship a no-op
    // draft. Re-emit the fallback prompt so the user is forced through
    // one of the three legitimate paths.
    self.deps.transcript.append({
      role: 'system',
      body: `persona-gen: rejected unknown fallback choice "${choice_value}"; re-emitting`,
      phase: state.phase,
    })
    const retry_count =
      (readNumber(phase_state, 'persona_synth_retry_count') ?? 0) + 1
    await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'persona_synthesizing',
      phase_state_patch: {
        active_prompt_id: null,
        persona_synth_retry_count: retry_count,
      },
      advanced_at: observed_at,
    })
    self.invalidateResolvedSpec(input.project_slug, 'persona_synthesizing')
    let final_state: OnboardingState | null = null
    const emit = await self.emitPhasePrompt({
      project_slug: input.project_slug,
      user_id: input.user_id,
      topic_id: input.topic_id,
      phase: 'persona_synthesizing',
      observed_at,
      seed_suffix: `retry=${retry_count}`,
      pre_send_state_upsert: async (prompt_id: string) => {
        final_state = await self.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: 'persona_synthesizing',
          phase_state_patch: { active_prompt_id: prompt_id },
          advanced_at: observed_at,
        })
      },
    })
    if (final_state === null) {
      final_state = (await self.deps.stateStore.get(input.project_slug, input.user_id)) as OnboardingState
    }
    return {
      outcome: 'reemitted_current',
      state: final_state,
      prompt_id: emit.prompt_id,
    }
  }

export async function advancePersonaSynthToReviewed(
  self: EngineInternals,
    input: AdvanceInput,
    observed_at: number,
    serialized_draft: ReturnType<typeof serializeDraft> | null,
  ): Promise<AdvanceResult> {
    if (!isLegalTransition('persona_synthesizing', 'persona_reviewed')) {
      throw new InterviewError(
        'persona_synthesizing',
        'illegal_transition',
        false,
        'persona-gen: illegal transition persona_synthesizing → persona_reviewed',
      )
    }
    const advanced = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'persona_reviewed',
      phase_state_patch: {
        active_prompt_id: null,
        ...(serialized_draft !== null ? { persona_draft: serialized_draft } : {}),
        persona_review_sub_step: 'idle',
        persona_review_rejection: null,
        persona_compose_failure_reason: null,
      },
      advanced_at: observed_at,
    })
    let final_state: OnboardingState | null = null
    const emit = await self.emitPhasePrompt({
      project_slug: input.project_slug,
      user_id: input.user_id,
      topic_id: input.topic_id,
      phase: 'persona_reviewed',
      observed_at,
      pre_send_state_upsert: async (prompt_id: string) => {
        final_state = await self.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: 'persona_reviewed',
          phase_state_patch: { active_prompt_id: prompt_id },
          advanced_at: observed_at,
        })
      },
    })
    if (final_state === null) final_state = advanced
    return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
  }


export async function reEmitPersonaReviewed(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    patch: Record<string, unknown>,
  ): Promise<AdvanceResult> {
    const phase_state = state.phase_state as Record<string, unknown>
    const attempt = readNumber(phase_state, 'persona_review_attempt_count') ?? 0
    const next_attempt = attempt + 1
    await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'persona_reviewed',
      phase_state_patch: {
        ...patch,
        active_prompt_id: null,
        persona_review_attempt_count: next_attempt,
      },
      advanced_at: observed_at,
    })
    // Invalidate the cached spec — the sub_step / rejection_reason
    // change must surface in the next emit.
    self.invalidateResolvedSpec(input.project_slug, 'persona_reviewed')
    let final_state: OnboardingState | null = null
    const emit = await self.emitPhasePrompt({
      project_slug: input.project_slug,
      user_id: input.user_id,
      topic_id: input.topic_id,
      phase: 'persona_reviewed',
      observed_at,
      seed_suffix: `attempt=${next_attempt}`,
      pre_send_state_upsert: async (prompt_id: string) => {
        final_state = await self.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: 'persona_reviewed',
          phase_state_patch: { active_prompt_id: prompt_id },
          advanced_at: observed_at,
        })
      },
    })
    if (final_state === null) {
      final_state = (await self.deps.stateStore.get(input.project_slug, input.user_id)) as OnboardingState
    }
    return {
      outcome: 'reemitted_current',
      state: final_state,
      prompt_id: emit.prompt_id,
    }
  }
