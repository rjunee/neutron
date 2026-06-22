/**
 * @neutronai/onboarding — interview engine slug seam.
 *
 * R5 / audit P2-4 — the 11 slug / agent-name / suggester methods
 * extracted from the `InterviewEngine` god-class as free functions. Each
 * takes the engine instance as `self: EngineInternals` (its first
 * parameter) and is a VERBATIM copy of the original method body with
 * `this.` rewritten to `self.`. `engine.ts` keeps a one-line delegator
 * method per function so the class's public API + every call site is
 * byte-for-byte unchanged.
 *
 * This is a PURE MOVE — no logic, control-flow, or comment changes.
 */

import { buildButtonPrompt, canonicalPromptSeed, deriveIdempotencyKey, type ButtonChoice } from '../../channels/button-primitive.ts'
import { isLegalTransition, TERMINAL_PHASES, type OnboardingPhase } from './phase.ts'
import {
  computeSlugSuggestionsForAgentName,
  SLUG_USE_ALT_PREFIX,
  SLUG_USE_SUGGESTED,
  validateAgentName,
} from './phase-prompts.ts'
import { buildDiverseCharacterFallback, type CharacterSuggesterResult } from './personality-character-suggester.ts'
import {
  buildDiverseAgentNameFallback,
  readMemoizedAgentNameSuggestions,
  type AgentNameSuggesterResult,
} from './agent-name-suggester.ts'
import { suggestedSlugFromAgentName, type SlugPickerOutcome } from '../../runtime/slug-picker-types.ts'
import { extractAgentNameFromFreeform } from './extract-agent-name.ts'
import { STATIC_PHASE_SPECS } from './phase-prompts.ts'
import type { OnboardingState } from './state-store.ts'
import type { AdvanceInput, AdvanceResult, SlugPickerEngineHookInput } from './engine-internals.ts'
import {
  cloneAgentNameSuggestions,
  cloneCharacterSuggestions,
  describeRejection,
  type EngineInternals,
  InterviewError,
  parseBareOptionNumber,
  readNumber,
  readString,
  readStringArray,
} from './engine-internals.ts'

/**
 * P2 v2 § 3.10 / S7 — `agent_name_chosen` handler. Captures the
 * user's chosen agent name (LLM-extracted OR freeform), runs the
 * locked validators (length / charset / reserved-name set), and on
 * success derives `suggested_slug` + advances to `slug_chosen`. On
 * failure, stays + re-emits with a rejection reason that surfaces
 * the failure mode (too short / reserved / bad chars).
 */
export async function consumeAgentNameChosenChoice(
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
        phase: 'agent_name_chosen',
        button_prompt_id: choice.prompt_id,
        button_choice: choice_value,
      })
    }

    // The freeform reply (verbatim, then the legacy heuristic for
    // "call me X" patterns). A router-extracted name on the conversational
    // path is already persisted to `phase_state.agent_name` upstream and
    // read back via `persisted_*` below.
    const heuristic_name =
      freeform !== null ? extractAgentNameFromFreeform(freeform) : null
    // v0.1.121 (2026-06-04) — agent_name_chosen now renders the suggested
    // names as tappable buttons (phase-prompts.ts:buildAgentNameChosenPromptSpec).
    // A button tap arrives with `choice_value = "<name>"` and no freeform
    // text, so it must be a name candidate too — without this the tap fell
    // through to `freeform` (null) and the user saw "I need a name". The
    // button value is `validateAgentName`-clean by construction, but we
    // still run it through the validator below like any other candidate.
    const button_name =
      choice_value.length > 0 && choice_value !== '__freeform__'
        ? choice_value
        : null
    // Item 3 (2026-06-19, owner live-dogfood) — NUMBERED pick on the name
    // step. A typed "3" (1-based, matching the rendered button order) must
    // select the SAME memoized name a tap on that button would, instead of
    // falling through to `freeform = "3"` → validateAgentName rejection.
    // Resolved ONLY against the memoized `agent_name_suggestions` so the
    // options never change between turns; a bare number with no memo falls
    // through to the normal cascade. Sits AFTER the heuristic (so a real
    // "call me 3" never collides) and BEFORE freeform.
    let numbered_name_pick: string | null = null
    if (heuristic_name === null && freeform !== null) {
      const oneBased = parseBareOptionNumber(freeform)
      if (oneBased !== null) {
        const memoized = readMemoizedAgentNameSuggestions(
          (state.phase_state as Record<string, unknown>)['agent_name_suggestions'],
        )
        const picks = memoized?.picks ?? []
        const idx = oneBased - 1
        if (idx >= 0 && idx < picks.length) {
          const resolved = picks[idx]?.name
          if (typeof resolved === 'string' && resolved.length > 0) {
            numbered_name_pick = resolved
          }
        }
      }
    }
    const candidate =
      heuristic_name ?? numbered_name_pick ?? freeform ?? button_name

    const validation = candidate === null ? null : validateAgentName(candidate)

    if (validation === null || !validation.ok) {
      self.invalidateResolvedSpec(input.project_slug, 'agent_name_chosen')
      const reason =
        validation === null
          ? "I need a name — try something like Sage, Vera, or Atlas."
          : validation.reason
      const prior_attempts =
        readNumber(state.phase_state, 'agent_name_chosen_attempt_count') ?? 0
      const next_attempts = prior_attempts + 1
      const stay_patch: Record<string, unknown> = {
        active_prompt_id: null,
        last_choice_value: choice_value,
        ...(freeform !== null ? { last_choice_freeform: freeform } : {}),
        agent_name_chosen_rejection: reason,
        agent_name_chosen_attempt_count: next_attempts,
      }
      const stayed = await self.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'agent_name_chosen',
        phase_state_patch: stay_patch,
        advanced_at: observed_at,
      })
      let final_state: OnboardingState | null = null
      const emit = await self.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: 'agent_name_chosen',
        observed_at,
        seed_suffix: `attempt=${next_attempts}`,
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
      return {
        outcome: 'reemitted_current',
        state: final_state ?? stayed,
        prompt_id: emit.prompt_id,
      }
    }

    const agent_name = validation.value

    // Open self-host (2026-06-13) — `slug_chosen` is cut (no subdomain to
    // pick locally), so agent_name_chosen routes straight to
    // `projects_proposed`. Critically we do NOT derive a `suggested_slug`
    // here: the managed path's `computeSlugSuggestionsForPhase` /
    // `suggestedSlugFromAgentName` calls below are skipped entirely, so no
    // dangling slug is seeded off the agent name. `personaSync.recordAgentName`
    // still fires (the name still names the assistant for the runtime
    // system prompt) before the advance.
    if (self.deploymentMode === 'open') {
      if (self.deps.personaSync !== undefined) {
        try {
          await self.deps.personaSync.recordAgentName({
            project_slug: input.project_slug,
            agent_name,
          })
        } catch (err) {
          console.warn(
            `[engine] personaSync.recordAgentName failed for project=${input.project_slug}:`,
            err instanceof Error ? err.message : err,
          )
        }
      }
      if (!isLegalTransition('agent_name_chosen', 'projects_proposed', 'open')) {
        throw new InterviewError(
          'agent_name_chosen',
          'illegal_transition',
          false,
          'agent_name_chosen → projects_proposed is not legal in open mode',
        )
      }
      const open_advance_patch: Record<string, unknown> = {
        active_prompt_id: null,
        last_choice_value: choice_value,
        ...(freeform !== null ? { last_choice_freeform: freeform } : {}),
        agent_name,
        agent_name_chosen_rejection: null,
        agent_name_chosen_attempt_count: null,
        // No `suggested_slug` / `slug_picker_rejection` — slug_chosen is
        // not in the open sequence.
      }
      const open_advanced = await self.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'projects_proposed',
        phase_state_patch: open_advance_patch,
        advanced_at: observed_at,
      })
      // Gate-collapse (#93) — mirror managed's slug_chosen handler:
      // auto-confirm the already-reviewed project list and walk
      // projects_proposed → persona_synthesizing → persona_reviewed in one
      // step. slug_chosen (the managed collapse trigger) is cut in open, so
      // running the collapse here keeps open from REINTRODUCING the
      // redundant projects_proposed approval gate that #93 removed. The
      // zero-state guard inside the helper re-emits the "share your work"
      // prompt when there is no reviewed list to collapse.
      return await self.autoConfirmProjectsProposedAndAdvance(
        input,
        open_advanced,
        observed_at,
      )
    }

    // P2 v2 § 2.8 / S7 — derive `suggested_slug` via the agent-name-primary
    // algorithm so the slug_chosen body + the picker bridge BOTH key off
    // the same value. Codex r1 P1 (2026-05-16): pre-fix `suggested_slug`
    // was `slugify(agent_name)` alone (e.g. `mimir`), but the resolver
    // surfaced `<agent_name>-<first_name>` (e.g. `mimir-casey`) as the
    // primary button. The bridge then renamed the instance to `mimir`
    // — the URL the user did NOT tap. Compute the primary candidate here
    // and persist it so resolver + handler agree.
    const user_first_name_for_slug = readString(state.phase_state, 'user_first_name')
    const computed = self.computeSlugSuggestionsForPhase({
      project_slug: input.project_slug,
      agent_name,
      user_first_name: user_first_name_for_slug,
    })
    const suggested_slug =
      computed.primary ?? suggestedSlugFromAgentName(agent_name)

    if (self.deps.personaSync !== undefined) {
      try {
        await self.deps.personaSync.recordAgentName({
          project_slug: input.project_slug,
          agent_name,
        })
      } catch (err) {
        console.warn(
          `[engine] personaSync.recordAgentName failed for project=${input.project_slug}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    if (!isLegalTransition('agent_name_chosen', 'slug_chosen')) {
      throw new InterviewError(
        'agent_name_chosen',
        'illegal_transition',
        false,
        'agent_name_chosen → slug_chosen is not legal',
      )
    }
    const advance_patch: Record<string, unknown> = {
      active_prompt_id: null,
      last_choice_value: choice_value,
      ...(freeform !== null ? { last_choice_freeform: freeform } : {}),
      agent_name,
      suggested_slug,
      agent_name_chosen_rejection: null,
      agent_name_chosen_attempt_count: null,
      slug_picker_rejection: null,
    }
    const advanced = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'slug_chosen',
      phase_state_patch: advance_patch,
      advanced_at: observed_at,
    })
    let final_state: OnboardingState | null = null
    const emit = await self.emitPhasePrompt({
      project_slug: input.project_slug,
      user_id: input.user_id,
      topic_id: input.topic_id,
      phase: 'slug_chosen',
      observed_at,
      pre_send_state_upsert: async (prompt_id: string) => {
        final_state = await self.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: 'slug_chosen',
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
 * Return the in-flight character-suggester promise for this instance/user,
 * starting one if none is running. Returns null only when no suggester
 * dep is wired (test/dev). Fire-and-forget callers (pre-compute) ignore
 * the returned promise; the body-render path awaits it.
 *
 * IMPORTANT (Codex P1, 2026-06-04): this NEVER writes to the state store.
 * A background pre-compute can resolve at any time — including AFTER a
 * foreground handler has advanced the user's phase — so a write here that
 * replays a previously-read `phase` would regress `onboarding_state.phase`
 * and could strand the flow. Persistence happens EXCLUSIVELY in the
 * foreground body-render path (`resolvePhasePromptSpecUncached`), which is
 * always executing on the correct consuming phase. This map is a pure
 * latency-hiding warm cache.
 */
export function getOrStartCharacterSuggestions(
  self: EngineInternals,
    project_slug: string,
    user_id: string,
    phase_state: Record<string, unknown>,
  ): Promise<CharacterSuggesterResult> | null {
    const suggester = self.deps.personalityCharacterSuggester
    if (suggester === undefined) return null
    const input = {
      user_first_name: readString(phase_state, 'user_first_name'),
      primary_projects: readStringArray(phase_state, 'primary_projects') ?? [],
      non_work_interests: readStringArray(phase_state, 'non_work_interests') ?? [],
      user_supplied_corrections:
        readStringArray(phase_state, 'user_supplied_corrections') ?? [],
      // Per-instance seed diversifies the static fallback deterministically.
      seed: project_slug,
    }
    // Fingerprint the SIGNAL fields so a later work-interview turn that adds
    // a signal supersedes an earlier partial-signal pre-compute (Codex P2)
    // — the render always reflects the current collected answers.
    const fp = self.suggestionFingerprint([
      input.user_first_name ?? '',
      input.primary_projects,
      input.non_work_interests,
      input.user_supplied_corrections,
    ])
    const key = self.suggestionKeyPrefix(project_slug, user_id) + fp
    const existing = self.pendingCharacterSuggestions.get(key)
    if (existing !== undefined) return existing
    // Signals changed → evict the superseded-fingerprint entry(ies) for this
    // instance/user so the warm cache holds at most one (the latest).
    self.clearPendingSuggestions(
      self.pendingCharacterSuggestions as Map<string, Promise<unknown>>,
      project_slug,
      user_id,
    )
    const p = (async (): Promise<CharacterSuggesterResult> => {
      try {
        return await suggester.generate(input)
      } catch (err) {
        console.warn(
          `[engine] personalityCharacterSuggester.generate failed for project=${project_slug}: ${err instanceof Error ? err.message : err}`,
        )
        return {
          suggestions: cloneCharacterSuggestions(
            buildDiverseCharacterFallback(project_slug),
          ),
          source: 'fallback',
        }
      }
    })()
    self.pendingCharacterSuggestions.set(key, p)
    self.capPendingSuggestions(
      self.pendingCharacterSuggestions as Map<string, Promise<unknown>>,
    )
    // Drop the cached promise once it settles to a FALLBACK so a later
    // interview turn retries the LLM after a transient failure. A real
    // ('llm') result stays cached for the foreground render to reuse (and
    // the render deletes it once consumed + persisted).
    void p
      .then((r) => {
        if (r.source === 'fallback' && self.pendingCharacterSuggestions.get(key) === p) {
          self.pendingCharacterSuggestions.delete(key)
        }
      })
      .catch(() => {
        if (self.pendingCharacterSuggestions.get(key) === p) {
          self.pendingCharacterSuggestions.delete(key)
        }
      })
    return p
  }

/** Agent-name mirror of `getOrStartCharacterSuggestions` (same no-DB-write
 *  contract — persistence is foreground-only). */
export function getOrStartAgentNameSuggestions(
  self: EngineInternals,
    project_slug: string,
    user_id: string,
    phase_state: Record<string, unknown>,
  ): Promise<AgentNameSuggesterResult> | null {
    const suggester = self.deps.agentNameSuggester
    if (suggester === undefined) return null
    const input = {
      user_first_name: readString(phase_state, 'user_first_name'),
      primary_projects: readStringArray(phase_state, 'primary_projects') ?? [],
      non_work_interests: readStringArray(phase_state, 'non_work_interests') ?? [],
      agent_personality: readString(phase_state, 'agent_personality'),
      archetypes: readStringArray(phase_state, 'archetypes') ?? [],
      seed: project_slug,
    }
    // Fingerprint includes the chosen personality + work signals so a
    // re-pick (or added signal) supersedes a stale pre-compute (Codex P2).
    const fp = self.suggestionFingerprint([
      input.user_first_name ?? '',
      input.agent_personality ?? '',
      input.primary_projects,
      input.non_work_interests,
      input.archetypes,
    ])
    const key = self.suggestionKeyPrefix(project_slug, user_id) + fp
    const existing = self.pendingAgentNameSuggestions.get(key)
    if (existing !== undefined) return existing
    self.clearPendingSuggestions(
      self.pendingAgentNameSuggestions as Map<string, Promise<unknown>>,
      project_slug,
      user_id,
    )
    const p = (async (): Promise<AgentNameSuggesterResult> => {
      try {
        return await suggester.generate(input)
      } catch (err) {
        console.warn(
          `[engine] agentNameSuggester.generate failed for project=${project_slug}: ${err instanceof Error ? err.message : err}`,
        )
        return {
          suggestions: cloneAgentNameSuggestions(
            buildDiverseAgentNameFallback(project_slug),
          ),
          source: 'fallback',
        }
      }
    })()
    self.pendingAgentNameSuggestions.set(key, p)
    self.capPendingSuggestions(
      self.pendingAgentNameSuggestions as Map<string, Promise<unknown>>,
    )
    void p
      .then((r) => {
        if (r.source === 'fallback' && self.pendingAgentNameSuggestions.get(key) === p) {
          self.pendingAgentNameSuggestions.delete(key)
        }
      })
      .catch(() => {
        if (self.pendingAgentNameSuggestions.get(key) === p) {
          self.pendingAgentNameSuggestions.delete(key)
        }
      })
    return p
  }

/**
 * P2 v2 § 2.8 / S7 — pre-LLM slug candidate computation for the
 * `slug_chosen` resolver. Wraps `computeSlugSuggestionsForAgentName`
 * with the `slugAvailability` probe so the resolver can pass a pure
 * `isAvailable` predicate without re-implementing the availability
 * check at the call site.
 *
 * Returns `{ primary: null, alts: [] }` when `agent_name` is null /
 * empty (no signal to derive a candidate from). When no
 * `slugAvailability` probe is wired (the single-owner Open production
 * path), falls back to the single-suggestion path (agent-name-derived
 * primary, no alts).
 *
 * `selfInternalHandle` is intentionally omitted — the picker computes
 * suggestions BEFORE the user accepts; the active instance's `url_slug`
 * is included in the availability check exactly once (when the user
 * actually picks the slug, via `processSlugPickerReply`).
 */
export function computeSlugSuggestionsForPhase(
  self: EngineInternals,
  input: {
    project_slug: string
    agent_name: string | null
    user_first_name: string | null
  }): { primary: string | null; alts: ReadonlyArray<string> } {
    if (input.agent_name === null || input.agent_name.length === 0) {
      return { primary: null, alts: [] }
    }

    // PlatformAdapter `slugAvailability` probe — encapsulates the
    // registry + history + reserved-set checks behind a single seam so
    // this Open-classified module no longer reaches down into Managed
    // types. Production wires this via the Managed adapter; tests + Open
    // self-hosted boxes wire the Local adapter.
    const probe = self.deps.slugAvailability
    if (probe !== undefined) {
      const isAvailable = (slug: string): boolean =>
        probe.check({ slug }).available
      return computeSlugSuggestionsForAgentName(
        {
          agent_name: input.agent_name,
          user_first_name: input.user_first_name,
          isAvailable,
        },
        probe.sanitize,
      )
    }

    // No availability probe wired (single-owner Open production path):
    // derive the primary off the agent name only. The resolver falls
    // through to `suggested_slug` from phase_state for the actual value;
    // we just surface the agent-name-derived primary so the body example
    // renders something.
    const seed = suggestedSlugFromAgentName(input.agent_name)
    return { primary: seed, alts: [] }
  }

/**
 * P1.5 / Sprint 21 — slug_chosen branch of consumeChoice. Routes the
 * resolved choice through the slug-picker hook so:
 *
 *   - `skip-slug` → advance to profile_pic_generating (current url_slug
 *     stays as the t-handle; user can rename later via settings).
 *   - `use-suggested` → call hook with the previously persisted
 *     `suggested_slug` as raw_input.
 *   - `type-different` (button tap) → re-emit the prompt asking the
 *     user to type their slug; no rename attempted yet.
 *   - `__freeform__` (typed text on the prompt) → call hook with the
 *     typed text as raw_input.
 *
 * On `renamed`/`skipped` outcomes we advance to profile_pic_generating
 * + emit its prompt. On `rejected` outcomes we keep state at
 * slug_chosen + persist the typed reason into phase_state so the
 * dynamic prompt builder surfaces it.
 *
 * Telemetry: every outcome lands a role='system' transcript line
 * tagged with the old/new slug + outcome kind so the per-instance
 * onboarding-transcript.jsonl captures the rename history.
 */
export async function consumeSlugChosenChoice(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const choice_value = choice.choice_value
    const phase_state = state.phase_state
    const suggested_slug = readString(phase_state as Record<string, unknown>, 'suggested_slug')
    const agent_name = readString(phase_state as Record<string, unknown>, 'agent_name')

    // Always append the resolved transcript line on first resolution so
    // the onboarding history shows what the user actually said.
    if (was_new) {
      const body =
        choice_value === '__freeform__' && choice.freeform_text !== undefined
          ? choice.freeform_text
          : choice_value
      self.deps.transcript.append({
        role: 'user',
        body,
        phase: state.phase,
        button_prompt_id: choice.prompt_id,
        button_choice: choice_value,
      })
    }

    // Branch 1: explicit "type a different one" button — DO NOT call
    // the hook. Codex r5 [P1]: bump the attempt counter + clear
    // active_prompt_id BEFORE re-emit so `reEmitSlugChosen`'s
    // idempotency seed (which mixes `slug_picker_attempt_count`)
    // generates a FRESH ButtonStore row instead of collapsing onto the
    // already-resolved row. Without this, the keyboard disabled by the
    // tap stays disabled and no follow-up prompt arrives.
    if (choice_value === 'type-different') {
      const prior_attempts =
        readNumber(state.phase_state, 'slug_picker_attempt_count') ?? 0
      const stateNext = await self.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'slug_chosen',
        phase_state_patch: {
          active_prompt_id: null,
          slug_picker_attempt_count: prior_attempts + 1,
        },
        advanced_at: observed_at,
      })
      return await self.reEmitSlugChosen(input, stateNext, observed_at, 'type-different')
    }

    // Branch 2: "skip for now" — advance without renaming.
    if (choice_value === 'skip-slug') {
      self.deps.transcript.append({
        role: 'system',
        body: `slug-picker: skipped (current url_slug=${input.project_slug} kept)`,
        phase: state.phase,
        button_prompt_id: choice.prompt_id,
        button_choice: choice_value,
      })
      return await self.advanceFromSlugChosen(input, state, observed_at, /*kept*/ true)
    }

    // Branch 3: hook not configured — surface a soft error so the user
    // can skip + continue. (Production composer wires the hook;
    // configuration drift gets a visible prompt rather than a silent
    // rename-attempt that no-ops.)
    if (self.deps.slugPicker === undefined) {
      self.deps.transcript.append({
        role: 'system',
        body: `slug-picker: hook not configured; offering skip`,
        phase: state.phase,
      })
      return await self.persistRejectionAndReEmit(
        input,
        state,
        observed_at,
        'Slug picker is not configured. Tap "Skip for now" to continue.',
      )
    }

    // Branch 4: "use suggested" or freeform typed text → call the hook.
    let raw_input: string
    let picker_choice: 'use-suggested' | 'type-different' | 'skip-slug' | undefined
    if (choice_value === SLUG_USE_SUGGESTED) {
      if (suggested_slug === null || suggested_slug.length === 0) {
        return await self.persistRejectionAndReEmit(
          input,
          state,
          observed_at,
          'No suggested slug available. Type the URL you want.',
        )
      }
      raw_input = suggested_slug
      picker_choice = 'use-suggested'
    } else if (choice_value.startsWith(SLUG_USE_ALT_PREFIX)) {
      // P2 v2 § 2.8 / S7 — additional pre-computed candidate. The button
      // value is `use-slug:<value>`; treat the trailing slug exactly like
      // the primary `use-suggested` button (rename via the bridge with
      // the chosen slug as raw_input).
      const alt = choice_value.slice(SLUG_USE_ALT_PREFIX.length)
      if (alt.length === 0) {
        return await self.reEmitSlugChosen(input, state, observed_at, null)
      }
      raw_input = alt
      picker_choice = 'use-suggested'
    } else if (choice_value === '__freeform__' && choice.freeform_text !== undefined && choice.freeform_text.length > 0) {
      raw_input = choice.freeform_text
      picker_choice = 'type-different'
    } else {
      // Unknown / empty choice — re-prompt.
      return await self.reEmitSlugChosen(input, state, observed_at, null)
    }

    // Drive the hook.
    const hookInput: SlugPickerEngineHookInput = {
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      user_id: input.user_id,
      raw_input,
      agent_name,
    }
    if (picker_choice !== undefined) hookInput.picker_choice = picker_choice
    let outcome: SlugPickerOutcome
    try {
      outcome = await self.deps.slugPicker.processReply(hookInput)
    } catch (err) {
      self.deps.transcript.append({
        role: 'system',
        body: `slug-picker: hook threw: ${err instanceof Error ? err.message : String(err)}`,
        phase: state.phase,
      })
      return await self.persistRejectionAndReEmit(
        input,
        state,
        observed_at,
        'The rename service is temporarily unavailable. Try again or tap "Skip for now".',
      )
    }

    if (outcome.kind === 'renamed') {
      const new_slug = outcome.new_slug
      // Codex r8/r9 — inspect the rename result's gateway-refresh
      // step. Three sub-cases:
      //
      //   - success: systemd restart fired; redirect was delivered.
      //              Production happy path. The OLD process is being
      //              torn down; the NEW gateway will boot on new_slug.
      //              REKEY state to new_slug so the new gateway's
      //              engine.start(new_slug) finds the in-progress row
      //              and re-emits the prompt.
      //   - skipped: no innerGatewayRestart driver (test/no-restart
      //              deploy). The same gateway keeps serving the OLD
      //              slug → state must STAY on old_slug or the user's
      //              next refresh hits engine.start(old_slug) with
      //              nothing and restarts from signup. Codex r9 [P1].
      //              Emit the next prompt on the live socket since the
      //              WS is still alive.
      //   - partial: inner restart returned 'failed' — Codex r7 P1's
      //              WS-closed-mid-rename branch. Old gateway is still
      //              alive on old_slug; the rename-recovery sweeper
      //              will retry the gateway-restart later. State must
      //              STAY on old_slug for the same reason as skipped.
      //              No prompt emit (no live socket).
      //
      // Implication: when the reconciler eventually succeeds at the
      // gateway-restart step, the engine state will still be keyed
      // under old_slug. Future enhancement (out of scope for this
      // PR): the reconciler can call `stateStore.rekey(old, new)` as
      // part of its recovery path.
      const gatewayStep = outcome.result.steps.find((s) => s.step === 'gateway-refreshed')
      const restartCommitted = gatewayStep?.status === 'success'
      const restartSkipped = gatewayStep?.status === 'skipped'
      self.deps.transcript.append({
        role: 'system',
        body: `slug-picker: renamed ${input.project_slug} → ${new_slug} (gateway-refresh=${gatewayStep?.status ?? 'unknown'})`,
        phase: state.phase,
      })
      if (restartCommitted) {
        try {
          await self.deps.stateStore.rekey(input.project_slug, new_slug, input.user_id)
        } catch (err) {
          self.deps.transcript.append({
            role: 'system',
            body: `slug-picker: rekey failed after rename: ${err instanceof Error ? err.message : String(err)}`,
            phase: state.phase,
          })
          return await self.persistRejectionAndReEmit(
            input,
            state,
            observed_at,
            'Rename committed but onboarding state rekey failed. Refresh the page to continue.',
          )
        }
      }
      return await self.advanceFromSlugChosen(
        input,
        state,
        observed_at,
        /*kept*/ false,
        new_slug,
        /*emitNextPromptOnLiveSocket*/ restartSkipped,
        /*restartCommitted*/ restartCommitted,
      )
    }
    if (outcome.kind === 'skipped') {
      // The bridge already short-circuited (defensive — the engine's
      // skip-slug branch should have handled this above). Treat as
      // skip + advance.
      self.deps.transcript.append({
        role: 'system',
        body: `slug-picker: bridge returned skipped (defensive path)`,
        phase: state.phase,
      })
      return await self.advanceFromSlugChosen(input, state, observed_at, /*kept*/ true)
    }
    // outcome.kind === 'rejected'
    const reason = describeRejection(outcome)
    self.deps.transcript.append({
      role: 'system',
      body: `slug-picker: rejected (${outcome.reason}): ${reason}`,
      phase: state.phase,
    })
    return await self.persistRejectionAndReEmit(input, state, observed_at, reason)
  }

/**
 * Advance from slug_chosen → profile_pic_generating. `kept` records
 * whether the user kept the existing url_slug (skip path) vs. rename
 * succeeded; surfaced via phase_state for downstream consumers.
 *
 * Codex P1 #2 + P1 #3: when `new_slug` is set (rename succeeded), the
 * onboarding_state row has already been rekeyed by the caller from
 * `input.project_slug` (OLD) to `new_slug`. The advance writes under
 * `new_slug` so the renamed gateway can find the row on reconnect.
 * The next-phase prompt is intentionally NOT emitted on the live
 * socket because the redirect envelope has already fired and the WS
 * is being torn down by the systemd restart — the renamed gateway's
 * `engine.start()` re-emits the profile_pic_generating prompt on the
 * fresh WS via the `active_prompt_id == null` branch (see
 * `start()`'s post-existing path).
 */
export async function advanceFromSlugChosen(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    kept: boolean,
    new_slug?: string,
    emitNextPromptOnLiveSocket?: boolean,
    restartCommitted?: boolean,
  ): Promise<AdvanceResult> {
    // P2 v2 § 2.8 — slug pick now sits BEFORE projects_proposed in
    // the linear flow, so post-slug advances to `projects_proposed`.
    // The v1 post-persona Max-attach is one hop further down the chain.
    const next_phase: OnboardingPhase = 'projects_proposed'
    if (!isLegalTransition(state.phase, next_phase)) {
      throw new InterviewError(
        state.phase,
        'illegal_transition',
        false,
        `slug-chosen: illegal transition ${state.phase} → ${next_phase}`,
      )
    }
    const slug_outcome_patch: Record<string, unknown> = {
      active_prompt_id: null,
      slug_picker_rejection: null,
      slug_picker_outcome: kept ? 'kept' : 'renamed',
    }
    if (new_slug !== undefined) {
      slug_outcome_patch['url_slug_renamed_to'] = new_slug
    }
    if (restartCommitted !== undefined) {
      slug_outcome_patch['slug_picker_restart_committed'] = restartCommitted
    }
    // Effective key for the upsert: when the rename succeeded AND the
    // gateway-restart was committed (Codex r8 'success' branch) the
    // caller rekey'd the row to the new slug, so we upsert under the
    // new slug. Otherwise (skipped/partial gateway-restart, or skip
    // path) the row is still under the original project_slug so we
    // upsert under that — Codex r9 [P1] keeps state recoverable on
    // refresh against the still-running OLD gateway.
    const effective_project_slug =
      new_slug !== undefined && restartCommitted === true ? new_slug : input.project_slug
    const advanced = await self.deps.stateStore.upsert({
      project_slug: effective_project_slug,
      user_id: input.user_id,
      phase: next_phase,
      phase_state_patch: slug_outcome_patch,
      advanced_at: observed_at,
    })
    const next_spec = STATIC_PHASE_SPECS[next_phase]
    if (next_spec === undefined || TERMINAL_PHASES.has(next_phase)) {
      return { outcome: 'advanced', state: advanced }
    }
    // Codex P1 #3 + r8 — emit decision matrix for the rename-success
    // path:
    //   - kept (skip-slug): WS is alive, advance normally.
    //   - renamed + restartCommitted: WS is dying, suppress; the renamed
    //     gateway's engine.start() picks up the row at `projects_proposed`
    //     and auto-confirms there (start()'s projects_proposed guard).
    //   - renamed + skipped restart (no-restart mode): WS is alive AND
    //     not being torn down; auto-confirm inline so the user sees the
    //     next prompt (persona_reviewed) on the live socket.
    //   - renamed + partial restart (WS-closed-mid-rename): no live
    //     socket to receive an emit; suppress.
    const shouldEmit =
      new_slug === undefined
        ? /*skip-slug*/ true
        : (emitNextPromptOnLiveSocket === true)
    if (!shouldEmit) {
      // Restart-redirect / WS-closed paths: leave the row parked on
      // `projects_proposed` (the v0.1.133 redirect anchor). The renamed
      // gateway's start() auto-confirms it post-reconnect — see the
      // projects_proposed guard in start().
      return { outcome: 'advanced', state: advanced }
    }
    // Gate-collapse (#93) — live-socket paths (skip-slug + no-restart
    // rename). The row already passed THROUGH `projects_proposed` (the
    // upsert above keeps it as the redirect anchor), but instead of
    // emitting the redundant "Good to go" gate for a list the user
    // already reviewed at import_analysis_presented, auto-confirm and
    // advance straight to persona_synthesizing on the live socket.
    const advance_input: AdvanceInput =
      effective_project_slug === input.project_slug
        ? input
        : { ...input, project_slug: effective_project_slug }
    return await self.autoConfirmProjectsProposedAndAdvance(
      advance_input,
      advanced,
      observed_at,
    )
  }

/**
 * Persist a rejection reason into phase_state and re-emit the
 * slug_chosen prompt with a fresh idempotency key (the rejection
 * counter advances so ButtonStore.emit returns a new row instead of
 * collapsing onto the prior resolved one).
 */
export async function persistRejectionAndReEmit(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    reason: string,
  ): Promise<AdvanceResult> {
    const prior_attempts = readNumber(state.phase_state, 'slug_picker_attempt_count') ?? 0
    const next_attempts = prior_attempts + 1
    const updated = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'slug_chosen',
      phase_state_patch: {
        active_prompt_id: null,
        slug_picker_rejection: reason,
        slug_picker_attempt_count: next_attempts,
      },
      advanced_at: observed_at,
    })
    return await self.reEmitSlugChosen(input, updated, observed_at, reason)
  }

/**
 * Re-emit the slug_chosen prompt, threading an attempt-counter into
 * the idempotency seed so a prior resolved-rejected row in
 * ButtonStore doesn't shadow the new keyboard.
 */
export async function reEmitSlugChosen(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    reason: string | null,
  ): Promise<AdvanceResult> {
    const spec = await self.resolvePhasePromptSpec(input.project_slug, input.user_id, 'slug_chosen')
    if (spec === null) {
      return { outcome: 'no_active_prompt', state }
    }
    const attempt_count = readNumber(state.phase_state, 'slug_picker_attempt_count') ?? 0
    const seed = canonicalPromptSeed({
      body: spec.body,
      options: spec.options.map((o) => ({ value: o.value })),
    })
    const idempotency_key = deriveIdempotencyKey({
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      seed: `slug_chosen:${attempt_count}:${seed}`,
    })
    const prompt = buildButtonPrompt({
      body: spec.body,
      options: spec.options.map((o) => ({ ...o })),
      allow_freeform: spec.allow_freeform,
      idempotency_key,
      uuid: self.uuid,
    })
    const emit = await self.deps.buttonStore.emit(prompt, { topic_id: input.topic_id })
    const updated = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'slug_chosen',
      phase_state_patch: { active_prompt_id: emit.prompt_id, topic_id: input.topic_id },
      advanced_at: observed_at,
    })
    if (emit.was_new || !emit.was_delivered) {
      try {
        await self.deps.sendButtonPrompt({
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          prompt: emit.prompt,
        })
        await self.deps.buttonStore.markDelivered(emit.prompt_id, self.now())
      } catch (err) {
        throw new InterviewError(
          'slug_chosen',
          'send_failed',
          true,
          `failed to re-emit slug_chosen prompt`,
          err,
        )
      }
      self.deps.transcript.append({
        role: 'agent',
        body: spec.body,
        phase: 'slug_chosen',
        button_prompt_id: emit.prompt_id,
      })
    }
    void reason
    return { outcome: 'reemitted_current', state: updated, prompt_id: emit.prompt_id }
  }

/**
 * 2026-05-28 — auto-skip past `max_oauth_offered` when the instance
 * already has a Max-OAuth refresh secret persisted (e.g. the import
 * phase attached Max upstream, or the user completed the connect on a
 * prior session). Returns the post-advance state when auto-skip
 * fires, or the input state unchanged when there's nothing to skip /
 * detection isn't possible.
 *
 * Detection order:
 *   1. `secrets.list({ kind: 'max_oauth_refresh', ... })` — the
 *      canonical store the Max-OAuth handoff writes into.
 *   2. Process env `CLAUDE_CODE_OAUTH_TOKEN` (stop-gap per Sam's
 *      2026-05-28 brief): when secrets is unwired or returns no rows,
 *      a non-empty env token is treated as "Max attached" because the
 *      pre-2026-05-28 substrate refactor wired the CLI subprocess
 *      transport off the env, not the SecretsStore. This keeps the
 *      auto-skip working for self-hosted / dev instances whose
 *      substrate is env-driven.
 *
 * Any thrown error (secrets.list throws, env read fails, etc.) is
 * swallowed — we return the input state and let the regular prompt
 * fire. Auto-skip is best-effort; a flaky detection MUST NEVER
 * strand an instance on a phase with a non-functional CTA.
 *
 * On a positive detection we reuse `advanceFromMaxOauthOffered(...,
 * 'max_oauth')` so the wow_fired dispatcher fires inline (when
 * wired), exactly mirroring the post-Done-tap success path.
 */
export async function maybeAutoAdvancePastMaxOauthOffered(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<OnboardingState> {
    if (state.phase !== 'max_oauth_offered') return state
    if (TERMINAL_PHASES.has(state.phase)) return state
    let max_already_attached = false
    if (self.deps.secrets !== undefined) {
      try {
        const rows = await self.deps.secrets.list({
          internal_handle: self.secretsIdentity(input.project_slug),
          kind: 'max_oauth_refresh',
        })
        if (rows.length > 0) max_already_attached = true
      } catch (err) {
        console.warn(
          `[engine] max_oauth_offered auto-skip: secrets.list threw for project=${input.project_slug}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    // Stop-gap (Sam 2026-05-28 brief): when secrets is unwired or
    // returned no rows, fall back to the process env token. This
    // covers self-hosted / dev / single-owner deployments whose
    // substrate stack reads `CLAUDE_CODE_OAUTH_TOKEN` directly without
    // round-tripping the per-instance SecretsStore.
    if (!max_already_attached) {
      const env_token = process.env['CLAUDE_CODE_OAUTH_TOKEN']
      if (typeof env_token === 'string' && env_token.length > 0) {
        max_already_attached = true
      }
    }
    if (!max_already_attached) return state
    const advanced = await self.advanceFromMaxOauthOffered(
      input,
      state,
      observed_at,
      'max_oauth',
    )
    // `advanceFromMaxOauthOffered` returns an AdvanceResult; the caller
    // here wants the post-advance state to chain into the next emit /
    // dispatcher cycle. The dispatcher (when wired) advances further
    // to `completed` inline; the unwired path stops at `wow_fired`.
    return advanced.state ?? state
  }

/**
 * Deterministic compact fingerprint of the SIGNAL fields a suggester
 * input depends on (Codex P2, 2026-06-04). The warm cache is keyed by
 * `instance::user::<fingerprint>` so that when a later work-interview turn
 * adds `non_work_interests` / `user_supplied_corrections` / etc., the key
 * changes — a stale partial-signal pre-compute is never reused for the
 * `personality_offered` render, which always reflects the CURRENT
 * (final) collected answers. Stable fields only; FNV-1a → base36.
 */
export function suggestionFingerprint(
  self: EngineInternals,
    parts: ReadonlyArray<string | ReadonlyArray<string>>,
  ): string {
    const s = JSON.stringify(parts)
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(36)
  }

export function suggestionKeyPrefix(
  self: EngineInternals,
  project_slug: string,
  user_id: string,
): string {
    return `${project_slug}::${user_id}::`
  }
