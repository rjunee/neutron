/**
 * @neutronai/onboarding — interview engine agent-name seam.
 *
 * K11a5 — the LIVE open-mode `agent_name_chosen` half split out of
 * `engine-slug.ts`. These are the agent-name / character- and
 * agent-name-suggester / max-oauth-auto-skip / suggestion-cache-key
 * free functions extracted from the `InterviewEngine` god-class. Each
 * takes the engine instance as `self: EngineInternals` (its first
 * parameter) and is a VERBATIM copy of the original method body with
 * `this.` rewritten to `self.`. `engine.ts` keeps a one-line delegator
 * method per function so the class's public API + every call site is
 * byte-for-byte unchanged.
 *
 * NOTE: `consumeAgentNameChosenChoice` retains its managed `slug_chosen`
 * branch verbatim (the managed derive-suggested-slug + advance path).
 * That branch's fate is owned by a later unit (K4b/D-5); this split does
 * not prune it.
 *
 * This is a PURE MOVE — no logic, control-flow, or comment changes.
 */

import { type ButtonChoice } from '@neutronai/channels/button-primitive.ts'
import { isLegalTransition, TERMINAL_PHASES } from './phase.ts'
import { validateAgentName } from './phase-prompts.ts'
import { buildDiverseCharacterFallback, type CharacterSuggesterResult } from './personality-character-suggester.ts'
import {
  buildDiverseAgentNameFallback,
  readMemoizedAgentNameSuggestions,
  type AgentNameSuggesterResult,
} from './agent-name-suggester.ts'
import { suggestedSlugFromAgentName } from '@neutronai/runtime/slug-picker-types.ts'
import { extractAgentNameFromFreeform } from './extract-agent-name.ts'
import type { OnboardingState } from './state-store.ts'
import type { AdvanceInput, AdvanceResult } from './engine-internals.ts'
import {
  cloneAgentNameSuggestions,
  cloneCharacterSuggestions,
  type EngineInternals,
  InterviewError,
  parseBareOptionNumber,
  readNumber,
  readString,
  readStringArray,
} from './engine-internals.ts'
import { autoConfirmProjectsProposedAndAdvance } from './engine-projects-proposed.ts'

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
      return await autoConfirmProjectsProposedAndAdvance(
        self,
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
