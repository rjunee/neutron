/**
 * @neutronai/onboarding — interview engine spec-resolution seam.
 *
 * D9a — the `SpecResolutionFlow` (the phase-prompt spec-resolution path)
 * extracted from the `InterviewEngine` god-class. These free functions
 * resolve the body + curated options a phase's prompt ships with:
 *
 *   - `resolvePhasePromptSpecUncached` — the per-phase dynamic-builder /
 *     LLM-driver / static-fallback resolution ladder.
 *   - `resolveLlmSpec` — the LLM-driven resolver path (builds a
 *     `PhaseContextBundle` + asks the wired `phaseSpecResolver`).
 *   - `readRecentTurns` — the transcript slice the LLM bundle carries.
 *   - `coerceImportResultForBuilder` / `deriveImportMonthsSpan` /
 *     `readPersonaEditTargetSection` — the module-private helpers the
 *     resolution ladder owns.
 *
 * Each takes the engine instance as `self: EngineInternals` (its first
 * parameter) and is a VERBATIM copy of the original method / function body
 * with `this.` rewritten to `self.` (and the two internal cross-calls
 * `this.resolveLlmSpec` / `this.readRecentTurns` rewritten to the sibling
 * free-function calls `resolveLlmSpec(self, …)` / `readRecentTurns(self, …)`).
 * `engine.ts` keeps the same-turn cache field + accessors + the public
 * `resolvePhasePromptSpec` cache-wrapper, which now calls
 * `resolvePhasePromptSpecUncached(this, …)` — so the cache semantics
 * (what's cached, keyed on `${project_slug}:${phase}`, cleared at the top
 * of every public entry point, invalidated per-entry by the advance path)
 * are byte-for-byte unchanged.
 *
 * This module imports ONLY from sibling leaf/type modules; it MUST NOT
 * import from `engine.ts`. This is a PURE MOVE — no logic, control-flow,
 * or comment changes.
 */

import {
  buildAgentNameChosenPromptSpec,
  buildImportAnalysisPresentedPromptSpec,
  buildImportUploadPendingPromptSpec,
  buildPersonaReviewedPromptSpec,
  buildPersonaSynthesizingFallbackPromptSpec,
  buildPersonalityOfferedPromptSpec,
  buildProjectsProposedPromptSpec,
  buildSlugChosenPromptSpec,
  firstNLines,
  STATIC_PHASE_SPECS,
  stripPersonaFileH1,
  type AiSubstrateSource,
  type BuildPersonaReviewedPromptSpecInput,
  type ImportResultForAnalysisBuilder,
  type PhasePromptSpec,
} from './phase-prompts.ts'
import {
  readMemoizedCharacterSuggestions,
  type PersonalityCharacterSuggestions,
} from './personality-character-suggester.ts'
import {
  readMemoizedAgentNameSuggestions,
  renderAgentNameBullets,
  type AgentNameSuggestions,
} from './agent-name-suggester.ts'
import { staticPersonaSummary } from '../persona-gen/summarize.ts'
import {
  PHASE_INTENTS,
  type PhaseContextBundle,
  type PhaseRecentTurn,
} from './phase-spec-resolver.ts'
import type { OnboardingPhase } from './phase.ts'
import type { OnboardingState } from './state-store.ts'
import type { TranscriptWriter } from './transcript.ts'
import {
  AUTO_SKIP_PHASES,
  readImportSource,
  readNumber,
  readPersonaDraft,
  readPersonaReviewSubStep,
  readString,
  readStringArray,
  type EngineInternals,
} from './engine-internals.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

export async function resolvePhasePromptSpecUncached(
  self: EngineInternals,
    project_slug: string,
    user_id: string,
    phase: OnboardingPhase,
  ): Promise<PhasePromptSpec | null> {
    // 2026-05-12 belt-and-braces — auto-skip phases must never have their
    // prompt body resolved. walkAutoSkip walks past auto-skip phases
    // before any emit path runs, so reaching this point with phase ∈
    // AUTO_SKIP_PHASES would mean a caller bypassed the walker (or a
    // future code path landed here without going through normalAdvance /
    // emitCurrentPhasePrompt). Returning null forces the caller to no-op
    // rather than ship a redundant gate body to the user.
    if (AUTO_SKIP_PHASES.has(phase)) return null
    // 2026-06-04 (onboarding-suggester-llm-timeout) — background pre-compute
    // of the character suggestions WHILE the user is still in the work-
    // interview / import-analysis phase. The interview spans several
    // human-time turns, so the ~15-30s CC-spawn generation (Opus is
    // slower than the legacy Haiku path) completes and memoizes before
    // personality_offered renders → that phase reads the
    // memoized picks instantly instead of blocking on a cold spawn (or, in
    // the legacy 6s-timeout world, always shipping the monotone fallback).
    // Fire-and-forget + in-flight deduped; only fires once there is real
    // signal so we never spend a spawn on empty input; failures swallowed.
    if (
      phase === 'work_interview_gap_fill' ||
      phase === 'import_analysis_presented'
    ) {
      try {
        const s = await self.deps.stateStore.get(project_slug, user_id)
        const ps = (s?.phase_state ?? {}) as Record<string, unknown>
        const already = readMemoizedCharacterSuggestions(
          ps['personality_character_suggestions'],
        )
        const hasSignal =
          (readStringArray(ps, 'primary_projects') ?? []).length > 0 ||
          (readStringArray(ps, 'non_work_interests') ?? []).length > 0 ||
          (readStringArray(ps, 'user_supplied_corrections') ?? []).length > 0
        if (already === null && hasSignal) {
          fireAndForget('engine-spec-resolution.getOrStartCharacterSuggestions', self.getOrStartCharacterSuggestions(project_slug, user_id, ps))
        }
      } catch {
        // Non-fatal — the personality_offered render falls back to its own
        // bounded await if the pre-compute didn't run.
      }
    }
    if (phase === 'signup') {
      // 2026-05-12 (Bug C) — when the engine flipped
      // `phase_state.clarify_name_reprompt = true` on the prior turn,
      // emit a clarifying body INSTEAD of the persona-discovery prompt.
      // This is the recovery path after extractAgentNameFromFreeform
      // returned null and the engine stayed at signup rather than
      // advancing with garbage `agent_name`.
      const state = await self.deps.stateStore.get(project_slug, user_id)
      if (
        state !== null &&
        (state.phase_state as Record<string, unknown>)['clarify_name_reprompt'] === true
      ) {
        const fallback = STATIC_PHASE_SPECS['signup']
        if (fallback !== undefined) {
          return {
            ...fallback,
            body: 'Got it. What should I call you?',
          }
        }
      }
      const llmSpec = await resolveLlmSpec(self, {
        project_slug,
        topic_id: null,
        user_id,
        phase,
        signup_via: null,
        state: null,
      })
      if (llmSpec !== null) return llmSpec
      return STATIC_PHASE_SPECS[phase] ?? null
    }
    if (phase === 'slug_chosen') {
      const state = await self.deps.stateStore.get(project_slug, user_id)
      const phase_state = state?.phase_state ?? {}
      const ps = phase_state as Record<string, unknown>
      const rejection = readString(ps, 'slug_picker_rejection')
      const agent_name = readString(ps, 'agent_name')
      const user_first_name = readString(ps, 'user_first_name')
      const persisted_suggested = readString(ps, 'suggested_slug')
      // P2 v2 § 2.8 / S7 — agent-name-primary slug suggestions. When the
      // registry + history + reserved-set deps are wired, compute up to
      // three candidates per the locked algorithm. Otherwise fall back to
      // the legacy single-suggestion path (`suggested_slug` derived from
      // the agent name) so existing tests + the slug-picker bridge keep
      // working byte-for-byte.
      const computed = self.computeSlugSuggestionsForPhase({
        project_slug,
        agent_name,
        user_first_name,
      })
      const primary = computed.primary ?? persisted_suggested
      return buildSlugChosenPromptSpec({
        suggested_slug: primary,
        rejection_reason: rejection,
        slug_picker_configured: self.deps.slugPicker !== undefined,
        alt_suggestions: computed.alts,
      })
    }
    // P2 v2 § 3.12 / S7 — projects_proposed dynamic body. Renders the
    // collected `phase_state.primary_projects[]` as a numbered list +
    // confirm/review buttons. Fallback bodies for the empty case live in
    // the builder.
    if (phase === 'projects_proposed') {
      // Edits in the user's most-recent transcript turn (e.g. "drop #2, add
      // Studio Sessions") are extracted + merged into `phase_state` upstream
      // on the live CC session (`post-turn-extractor.ts`); this body builder
      // just renders the persisted `primary_projects` via
      // `buildProjectsProposedPromptSpec`.
      const state = await self.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const rejection = readString(phase_state, 'projects_proposed_rejection')
      const projects = readStringArray(phase_state, 'primary_projects') ?? []
      const awaiting_share_freeform =
        phase_state['projects_proposed_share_freeform'] === true
      const builderInput: Parameters<typeof buildProjectsProposedPromptSpec>[0] = {
        primary_projects: projects,
      }
      if (rejection !== null) builderInput.rejection_reason = rejection
      if (awaiting_share_freeform) builderInput.awaiting_share_freeform = true
      return buildProjectsProposedPromptSpec(builderInput)
    }
    // P2 v2 § 3.5 / § 6.4 — import_upload_pending dynamic builder.
    // Renders the verbatim ChatGPT / Claude download-instructions
    // off `phase_state.ai_substrate_used` (set by
    // `advanceFromAiSubstrateOfferedToUpload` at the prior phase).
    if (phase === 'import_upload_pending') {
      const state = await self.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const raw = phase_state['ai_substrate_used']
      const ai_substrate_used: AiSubstrateSource | null =
        raw === 'chatgpt' || raw === 'claude' ? raw : null
      return buildImportUploadPendingPromptSpec({ ai_substrate_used })
    }
    // P2 v2 § 2.3 + § 3.7 / S5 — import_analysis_presented dynamic
    // builder. Renders the wow-moment bullets (projects + interests +
    // low-confidence callout) off `phase_state.import_result`. The
    // failure branch (`import_failed=true`) emits the graceful
    // "couldn't analyze" framing instead. The builder NEVER paraphrases
    // project / interest names — they pass through verbatim because
    // they're signals from the user's own data.
    if (phase === 'import_analysis_presented') {
      const state = await self.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const user_first_name = readString(phase_state, 'user_first_name')
      const import_source = readImportSource(phase_state, 'import_source')
      const builder_source: 'chatgpt-zip' | 'claude-zip' | null =
        import_source === 'chatgpt-zip' || import_source === 'claude-zip'
          ? import_source
          : null
      const import_failed = phase_state['import_failed'] === true
      const import_partial = phase_state['import_partial'] === true
      const import_result_raw = phase_state['import_result'] as unknown
      const import_result = coerceImportResultForBuilder(import_result_raw)
      // Derive month span from topic recency timestamps when the
      // Pass-2 result carried them; otherwise pass null and let the
      // builder fall back to the no-months clause. Defensive parse —
      // the JSON blob may carry any shape.
      const import_months_span = deriveImportMonthsSpan(import_result_raw)
      // 2026-05-25 (import-pipeline-resilience sprint, Part G.2) —
      // surface the `resume_import` button ONLY when (a) the last
      // import landed in a failed/partial terminal state AND (b) the
      // readiness probe confirms the job is resumable (status in
      // {cancelled, rate_limit_paused, failed} AND, for *-zip
      // sources, the source ZIP is still on disk). Once a resumed
      // run lands `completed` the engine clears `import_failed` +
      // `import_partial`, so the button auto-disappears on the
      // next re-emit.
      const last_import_job_id = readString(phase_state, 'last_import_job_id')
      const probe_job_id =
        readString(phase_state, 'import_job_id') ?? last_import_job_id
      let can_resume_import = false
      if (
        (import_failed || import_partial) &&
        import_source !== null &&
        probe_job_id !== null &&
        self.deps.importResumeReadiness !== undefined
      ) {
        try {
          can_resume_import = await self.deps.importResumeReadiness.isResumable({
            project_slug,
            user_id,
            source: import_source,
            job_id: probe_job_id,
          })
        } catch (err) {
          // Best-effort — a probe failure leaves the button hidden
          // (the safe default). Log to stderr for ops debugging but
          // do NOT bubble; the analysis-presented body still ships.
          // eslint-disable-next-line no-console
          console.warn(
            `[engine] importResumeReadiness.isResumable threw for ` +
              `project=${project_slug} job=${probe_job_id}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      return buildImportAnalysisPresentedPromptSpec({
        user_first_name,
        import_source: builder_source,
        import_result,
        import_failed,
        import_partial,
        import_months_span,
        can_resume_import,
      })
    }
    // K11e (2026-07-07) — the `max_oauth_offered` dynamic-builder resolve
    // branch was removed here. The phase is no longer walked (engine phase-
    // walk deleted in #243, handler methods in #248/K11e), so it can never be
    // the resolver's `phase`. Legacy stranded rows are handled purely by the
    // creds gate in gateway/realmode-composer/resolve-onboarding-phase.ts.
    // P2 v2 § 0 #9 + § 3.9 — personality_offered dynamic rejection
    // path. Short-circuits the resolver ONLY when the dedicated handler
    // wrote a `personality_offered_rejection` (too short / unparseable
    // free-text reply). The happy path falls through to the LLM driver /
    // static fallback so the body can be user-tuned.
    //
    // v0.1.80 (2026-05-22) — character suggester. When the suggester
    // dep is wired AND no memoized picks live on phase_state yet, fire
    // the LLM call to generate 5 character anchors and persist into
    // `phase_state.personality_character_suggestions`. On reload the
    // memoized picks are read back; the suggester is never re-rolled.
    // On suggester failure the static fallback constant ships — the
    // user always sees a 5-character body.
    if (phase === 'personality_offered') {
      const state = await self.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const v2_rejection = readString(phase_state, 'personality_offered_rejection')

      // Read the memoized picks (set by the foreground persist on a prior
      // render, or warmed by the pre-compute then persisted here). We
      // memoize WHAT WE RENDER together with its `source` so the consume
      // handler can map a `character:<index>` tap against the exact list
      // that shipped (closed validation — Codex P2) WITHOUT trusting the
      // client. A real ('llm') memo short-circuits instantly; a memoized
      // FALLBACK is re-attempted below so a transient failure re-rolls.
      const memoized = readMemoizedCharacterSuggestions(
        phase_state['personality_character_suggestions'],
      )
      const memoized_source = readString(
        phase_state,
        'personality_character_suggestions_source',
      )
      let character_suggestions: PersonalityCharacterSuggestions | null =
        memoized !== null && memoized_source === 'llm' ? memoized : null
      if (character_suggestions === null && self.deps.personalityCharacterSuggester !== undefined) {
        // No real memo yet — await the in-flight generation (dedupes with
        // the pre-compute promise; starts one if none is running). Bounded
        // by the suggester's 45s timeout (raised for cold Opus spawns when
        // the suggester moved to BEST_MODEL). 2026-06-04: replaces the old
        // 6s-timeout inline call that fell back to the monotone static list
        // 100% of the time (suggester-timeout incident).
        const pending = self.getOrStartCharacterSuggestions(
          project_slug,
          user_id,
          phase_state,
        )
        if (pending !== null) {
          const result = await pending
          character_suggestions = result.suggestions
          // Persist WHAT WE RENDER (+ source) on the CURRENT consuming
          // phase — so this upsert never writes a stale phase from a
          // background read (Codex P1) AND the consume handler can map the
          // index against the exact memoized list (Codex P2). Memoizing the
          // fallback does NOT freeze the user on it: the short-circuit above
          // only fires for `source==='llm'`, so a memoized fallback is
          // re-attempted on the next render until the LLM lands. Preserve
          // `last_advanced_at` so the memoization upsert doesn't reset the
          // resume-window timer. Best-effort.
          try {
            await self.deps.stateStore.upsert({
              project_slug,
              user_id,
              phase: 'personality_offered',
              phase_state_patch: {
                personality_character_suggestions: result.suggestions,
                personality_character_suggestions_source: result.source,
              },
              advanced_at: state?.last_advanced_at ?? self.now(),
            })
          } catch (err) {
            console.warn(
              `[engine] persist personality_character_suggestions failed for project=${project_slug}: ${err instanceof Error ? err.message : err}`,
            )
          }
          if (result.source === 'llm') {
            self.clearPendingSuggestions(
              self.pendingCharacterSuggestions as Map<string, Promise<unknown>>,
              project_slug,
              user_id,
            )
          }
        }
      }
      // Last resort: suggester unwired but a prior fallback is memoized —
      // render it rather than dropping to the legacy freeform body.
      if (character_suggestions === null && memoized !== null) {
        character_suggestions = memoized
      }

      if (character_suggestions !== null) {
        const builderInput: Parameters<typeof buildPersonalityOfferedPromptSpec>[0] = {
          character_suggestions,
        }
        if (v2_rejection !== null && v2_rejection.length > 0) {
          builderInput.rejection_reason = v2_rejection
        }
        return buildPersonalityOfferedPromptSpec(builderInput)
      }

      if (v2_rejection !== null && v2_rejection.length > 0) {
        return buildPersonalityOfferedPromptSpec({ rejection_reason: v2_rejection })
      }
      // No suggester, no memoized picks, no rejection — fall through to
      // the LLM driver / static fallback. The legacy 3-example freeform
      // body keeps the deterministic walk valid.
    }
    // P2 v2 § 3.10 / S7 — agent_name_chosen dynamic rejection path.
    // Short-circuits the resolver ONLY when a prior reply failed the
    // validators (length / charset / reserved-name list). The happy
    // path used to fall through to the LLM driver / static fallback —
    // 2026-05-27 it now ALWAYS routes through the AgentNameSuggester
    // (mirrors the personality_offered character-suggester wiring just
    // above) so the bullet list is built deterministically off a
    // memoized BEST_MODEL (Opus 4.7) call instead of an LLM driver that
    // can silently drop the bullets (Sam-incident 2026-05-27).
    //
    // When the suggester dep is absent (test harnesses, dev environments
    // without an Anthropic client), the engine still falls through to
    // the LLM driver / static spec — and Part C's
    // `agentNameBodyLooksValid` post-resolve validator backstops the
    // missing-bullets case by returning null to force the static
    // bullet-bearing fallback.
    if (phase === 'agent_name_chosen') {
      const state = await self.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const rejection = readString(phase_state, 'agent_name_chosen_rejection')

      // Read the memoized picks first (set by the foreground persist on a
      // prior render, or warmed by the pre-compute then persisted here). We
      // memoize WHAT WE RENDER together with its `source` (mirrors the
      // character path above) so a stale FALLBACK memo never freezes the
      // user. A real ('llm') memo short-circuits instantly; a memoized
      // fallback — including a legacy provenance-less memo persisted by
      // pre-patch code — is re-attempted below so a transient failure (or
      // an old Sage/Vera/Orin freeze) re-rolls until the LLM lands.
      const memoized = readMemoizedAgentNameSuggestions(
        phase_state['agent_name_suggestions'],
      )
      const memoized_source = readString(
        phase_state,
        'agent_name_suggestions_source',
      )
      let name_suggestions: AgentNameSuggestions | null =
        memoized !== null && memoized_source === 'llm' ? memoized : null
      if (name_suggestions === null && self.deps.agentNameSuggester !== undefined) {
        // No real memo yet — await the in-flight generation (dedupes with
        // the pre-compute promise). Bounded by the suggester's 45s timeout
        // (raised for cold Opus spawns when the suggester moved to
        // BEST_MODEL). 2026-06-04: replaces the old 6s-timeout inline call
        // that fell back to Sage/Vera/Orin 100% of the time.
        const pending = self.getOrStartAgentNameSuggestions(
          project_slug,
          user_id,
          phase_state,
        )
        if (pending !== null) {
          const result = await pending
          name_suggestions = result.suggestions
          // Foreground-only persist on the CURRENT consuming phase (Codex
          // P1 — never a stale background phase). We persist WHAT WE RENDER
          // together with its `source`. Memoizing the fallback does NOT
          // freeze the user on it: the short-circuit above only fires for
          // `source==='llm'`, so a memoized fallback is re-attempted on the
          // next render until the LLM lands. Preserve `last_advanced_at` so
          // the upsert doesn't reset the resume-window timer. Best-effort.
          try {
            await self.deps.stateStore.upsert({
              project_slug,
              user_id,
              phase: 'agent_name_chosen',
              phase_state_patch: {
                agent_name_suggestions: result.suggestions,
                agent_name_suggestions_source: result.source,
              },
              advanced_at: state?.last_advanced_at ?? self.now(),
            })
          } catch (err) {
            console.warn(
              `[engine] persist agent_name_suggestions failed for project=${project_slug}: ${err instanceof Error ? err.message : err}`,
            )
          }
          if (result.source === 'llm') {
            self.clearPendingSuggestions(
              self.pendingAgentNameSuggestions as Map<string, Promise<unknown>>,
              project_slug,
              user_id,
            )
          }
        }
      }
      // Last resort: suggester unwired but a prior fallback is memoized —
      // render it rather than dropping to the legacy freeform body.
      if (name_suggestions === null && memoized !== null) {
        name_suggestions = memoized
      }

      if (name_suggestions !== null) {
        const builderInput: Parameters<typeof buildAgentNameChosenPromptSpec>[0] = {
          name_suggestions: renderAgentNameBullets(name_suggestions),
        }
        if (rejection !== null && rejection.length > 0) {
          builderInput.rejection_reason = rejection
        }
        return buildAgentNameChosenPromptSpec(builderInput)
      }

      // No suggester wired AND no memoized picks. Honour the legacy
      // rejection short-circuit so a prior-attempt's rejection still
      // surfaces; otherwise fall through to the LLM driver / static
      // fallback (which Part C's validator backstops).
      if (rejection !== null && rejection.length > 0) {
        return buildAgentNameChosenPromptSpec({ rejection_reason: rejection })
      }
    }
    // P2 v2 — profile_pic_generating dynamic spec removed (phase
    // dropped from the v2 enum per § 2.10). Re-add when the Cores
    // image-gen substrate ships.
    // T1 (2026-05-13) — dynamic persona_reviewed body. Renders the
    // first 30 lines of each generated persona file (SOUL.md / USER.md
    // / priority-map.md) as the review prompt body. Sub-flow states
    // (`pick_line`, `pick_replacement`, `pending_regen_hint`) emit
    // their own bodies so the user always knows what they're being
    // asked.
    //
    // When `personaComposer` is unwired OR no draft has been
    // persisted yet, fall through to the static placeholder spec so
    // a misconfigured environment still advances the user instead of
    // stalling on an empty body.
    if (phase === 'persona_reviewed' && self.deps.personaComposer !== undefined) {
      const state = await self.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const draft = readPersonaDraft(phase_state)
      const sub_step = readPersonaReviewSubStep(phase_state)
      const rejection = readString(phase_state, 'persona_review_rejection')
      if (draft === null && sub_step === 'idle') {
        // Composer is wired but no draft on file — e.g. operator-time
        // drift where the engine was upgraded mid-onboarding and the
        // user resumed after the synthesis side-effect failed silently.
        // Fall through to the static spec so they advance forward.
        return STATIC_PHASE_SPECS[phase] ?? null
      }

      // v0.1.80 (2026-05-22) — conversational summary body. When the
      // user is on the idle (top-level) review screen, render a 3-4
      // sentence plain-English summary instead of the raw .md dump.
      // Memoized in `phase_state.persona_reviewed_summary` so reloads
      // don't re-roll; cleared by the re-emit-after-regen path so a
      // tweaked draft gets a fresh summary.
      let summary: string | null = readString(phase_state, 'persona_reviewed_summary')
      if (summary === null && draft !== null && sub_step === 'idle') {
        const summarizer_input = {
          user_first_name: readString(phase_state, 'user_first_name'),
          agent_personality: readString(phase_state, 'agent_personality'),
          soul_md: draft.soul_md,
          user_md: draft.user_md,
          priority_map_md: draft.priority_map_md,
        }
        if (self.deps.personaSummarizer !== undefined) {
          try {
            summary = await self.deps.personaSummarizer.summarize(summarizer_input)
          } catch (err) {
            console.warn(
              `[engine] personaSummarizer.summarize failed for project=${project_slug}: ${err instanceof Error ? err.message : err}`,
            )
            summary = staticPersonaSummary(summarizer_input)
          }
        } else {
          summary = staticPersonaSummary(summarizer_input)
        }
        // Persist memoized summary so reload doesn't re-roll. Best-effort.
        // Kieran r1 I3 — preserve `last_advanced_at` so the body-render
        // memoization upsert doesn't reset the resume-window timer.
        try {
          await self.deps.stateStore.upsert({
            project_slug,
            user_id,
            phase: 'persona_reviewed',
            phase_state_patch: { persona_reviewed_summary: summary },
            advanced_at: state?.last_advanced_at ?? Date.now(),
          })
        } catch (err) {
          console.warn(
            `[engine] persist persona_reviewed_summary failed for project=${project_slug}: ${err instanceof Error ? err.message : err}`,
          )
        }
      }

      const builderInput: BuildPersonaReviewedPromptSpecInput = {
        sub_step,
      }
      if (summary !== null && sub_step === 'idle') {
        builderInput.summary = summary
      } else if (draft !== null) {
        // Legacy raw-excerpt body. Reached only on sub-step screens
        // (where summary doesn't apply) — or, defensively, when the
        // summarizer path persisted nothing. T11 (2026-05-15) — strip
        // the canonical persona-file H1 from each excerpt before
        // rendering so the user-visible bubble shows friendly section
        // titles ("Voice + style", "About you", "What matters")
        // instead of the internal filename.
        builderInput.voice_excerpt = firstNLines(
          stripPersonaFileH1(draft.soul_md),
          30,
        )
        builderInput.about_excerpt = firstNLines(
          stripPersonaFileH1(draft.user_md),
          30,
        )
        builderInput.what_matters_excerpt = firstNLines(
          stripPersonaFileH1(draft.priority_map_md),
          30,
        )
      }
      const target_section = readPersonaEditTargetSection(phase_state)
      const target_line = readNumber(phase_state, 'persona_edit_target_line')
      if (target_section !== null) builderInput.edit_target_section = target_section
      if (target_line !== null) builderInput.edit_target_line = target_line
      if (rejection !== null) builderInput.rejection_reason = rejection
      return buildPersonaReviewedPromptSpec(builderInput)
    }
    // T1 (2026-05-13) — dynamic persona_synthesizing fallback body.
    // Only emitted when a prior compose attempt failed and the engine
    // persisted `persona_compose_failure_reason`. ISSUES #1 fix
    // (2026-05-19): when no failure flag is set, fall through to the
    // STATIC_PHASE_SPECS entry at the bottom of this function so the
    // user sees the spec § 3.13 status body ("Composing your persona
    // — this takes about 10 sec.") while the inline synthesizePersona
    // hook (consumeChoice + normalAdvance + emitCurrentPhasePrompt
    // resume-trigger) runs in the same turn / re-runs on resume.
    // Pre-fix the branch returned `null`, which made emitPhasePrompt
    // throw `prompt_emit_failed` and the literal error string surfaced
    // to the user as a chat bubble — the exact "placeholder phase-
    // prompt bodies that ship as no-ops" anti-pattern CLAUDE.md
    // forbids (root § "Spec is the source of truth — HARD RULE").
    if (phase === 'persona_synthesizing' && self.deps.personaComposer !== undefined) {
      const state = await self.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const failure = readString(phase_state, 'persona_compose_failure_reason')
      if (failure !== null) {
        return buildPersonaSynthesizingFallbackPromptSpec({
          failure_reason: failure,
        })
      }
      // No failure flag → fall through to STATIC_PHASE_SPECS at the
      // bottom of this function (NOT into the LLM-driven resolver:
      // PHASE_INTENTS['persona_synthesizing'] === null, so the
      // resolveLlmSpec call below opts out for this phase).
    }
    // LLM-driven resolver (sprint: 2026-05-09). When wired AND the phase
    // is in the resolver's enabled set, ask it to generate the body +
    // curated options. Returns null if the resolver opted out (phase not
    // enabled, LLM error) — fall through to the static `PHASE_PROMPTS`
    // table so a partial rollout / model outage stays user-invisible.
    const llmSpec = await resolveLlmSpec(self, {
      project_slug,
      topic_id: null,
      user_id,
      phase,
      signup_via: null,
      state: null,
    })
    if (llmSpec !== null) return llmSpec
    const spec = STATIC_PHASE_SPECS[phase]
    return spec ?? null
  }

  /**
   * LLM-driven resolver path. Builds a `PhaseContextBundle` from the
   * engine's existing state + transcript, then asks the resolver. Returns
   * `null` when the resolver is unwired, the phase is not enabled, OR
   * the LLM call failed — caller falls through to the static spec.
   *
   * `topic_id` / `user_id` / `signup_via` come from the start() input
   * directly when the engine is mid-start; otherwise (advance / re-emit
   * paths) they are read from the persisted phase_state.
   */
export async function resolveLlmSpec(
  self: EngineInternals,
  input: {
    project_slug: string
    topic_id: string | null
    user_id: string | null
    phase: OnboardingPhase
    signup_via: 'telegram' | 'web' | null
    state: OnboardingState | null
    /**
     * `start()` can pass `StartInput.tg_first_name` here so the resolver
     * sees it on the very first emit (before the upsert that persists it
     * into `phase_state` lands). Subsequent emits read it from
     * `phase_state.tg_first_name` directly.
     */
    tg_first_name_override?: string | null
  }): Promise<PhasePromptSpec | null> {
    // 2026-06-21 (onboarding-engine consolidation) — the warm conversational
    // body copy is produced solely by `phaseSpecResolver`. The older
    // `promptDriver` extraction-envelope seam (which also returned
    // `extracted_fields`) was never wired in production and has been removed;
    // freeform-field extraction now flows exclusively through the live CC
    // session (`post-turn-extractor.ts`).
    if (self.deps.phaseSpecResolver === undefined) {
      return null
    }
    // ISSUES #2 (2026-05-19) — when `input.user_id` is null (legacy
    // pre-fix call-site), the state-store lookup is impossible (the row
    // PK is composite). Skip the state preload; the resolver's own
    // fallbacks (phase_state-recovered topic_id / signup_via) only run
    // when we have a state row anyway.
    const state =
      input.state ??
      (input.user_id !== null && input.user_id.length > 0
        ? await self.deps.stateStore.get(input.project_slug, input.user_id)
        : null)
    const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
    const signup_via =
      input.signup_via ??
      (readString(phase_state, 'signup_via') === 'web'
        ? 'web'
        : readString(phase_state, 'signup_via') === 'telegram'
          ? 'telegram'
          : 'web')
    const topic_id = input.topic_id ?? readString(phase_state, 'topic_id') ?? ''
    const user_id = input.user_id ?? readString(phase_state, 'user_id') ?? ''
    const tg_first_name =
      input.tg_first_name_override ?? readString(phase_state, 'tg_first_name')

    const intent = PHASE_INTENTS[input.phase]
    if (intent === null || intent === undefined) return null
    const attempt_count = readNumber(phase_state, 'attempt_count') ?? 0
    const rejection_reason = readString(phase_state, 'rejection_reason')
    const captured: PhaseContextBundle['captured'] = {
      agent_name: readString(phase_state, 'agent_name'),
      archetype_hint: readString(phase_state, 'archetype_hint'),
      suggested_slug: readString(phase_state, 'suggested_slug'),
      chosen_slug: readString(phase_state, 'chosen_slug'),
      last_choice_value: readString(phase_state, 'last_choice_value'),
      last_choice_freeform: readString(phase_state, 'last_choice_freeform'),
    }
    const recent_turns = readRecentTurns(self, 6)
    const bundle: PhaseContextBundle = {
      project_slug: input.project_slug,
      topic_id,
      user_id,
      signup_via,
      telegram_display_name: tg_first_name,
      phase: input.phase,
      intent,
      captured,
      recent_turns,
      attempt_count,
      rejection_reason,
    }
    try {
      return await self.deps.phaseSpecResolver.resolve(bundle)
    } catch (err) {
      console.warn(
        `[engine] phaseSpecResolver.resolve threw for phase=${input.phase} project=${input.project_slug}:`,
        err instanceof Error ? err.message : err,
      )
      return null
    }
  }

  /**
   * Read the last N agent+user lines from the transcript, dropping
   * system entries (recovery / sentinel notes the LLM does not need).
   * Truncates each body to ~80 chars at the bundle boundary so the
   * upstream prompt stays under the per-call token budget.
   */
export function readRecentTurns(
  self: EngineInternals,
  n: number,
): ReadonlyArray<PhaseRecentTurn> {
    let entries: ReturnType<TranscriptWriter['readAll']>
    try {
      entries = self.deps.transcript.readAll()
    } catch {
      return []
    }
    const out: PhaseRecentTurn[] = []
    for (let i = entries.length - 1; i >= 0 && out.length < n; i--) {
      const e = entries[i]!
      if (e.role !== 'agent' && e.role !== 'user') continue
      const phase = (e.phase ?? 'signup') as OnboardingPhase
      out.unshift({ role: e.role, body: e.body, phase })
    }
    return out
  }

/**
 * P2 v2 S5 — narrows the persisted `phase_state.import_result` blob
 * into the slim shape the analysis-presentation builder consumes.
 * Tolerant: returns null on missing / malformed input so the failure
 * path collapses to the graceful "couldn't analyze" body instead of
 * crashing in the prompt resolver.
 */
export function coerceImportResultForBuilder(
  raw: unknown,
): ImportResultForAnalysisBuilder | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const proposed_raw = r['proposed_projects']
  if (!Array.isArray(proposed_raw)) return null
  const proposed_projects: Array<{ name: string; rationale: string }> = []
  for (const p of proposed_raw) {
    if (typeof p !== 'object' || p === null) continue
    const pp = p as Record<string, unknown>
    if (typeof pp['name'] !== 'string') continue
    if (pp['name'].trim().length === 0) continue
    proposed_projects.push({
      name: pp['name'],
      rationale: typeof pp['rationale'] === 'string' ? pp['rationale'] : '',
    })
  }
  const out: ImportResultForAnalysisBuilder = { proposed_projects }
  const interests_raw = r['inferred_interests']
  if (Array.isArray(interests_raw)) {
    const interests: Array<{ name: string; basis?: string }> = []
    for (const i of interests_raw) {
      if (typeof i === 'string' && i.trim().length > 0) {
        interests.push({ name: i.trim() })
        continue
      }
      if (typeof i !== 'object' || i === null) continue
      const ii = i as Record<string, unknown>
      if (typeof ii['name'] !== 'string' || ii['name'].trim().length === 0) continue
      const entry: { name: string; basis?: string } = { name: ii['name'].trim() }
      if (typeof ii['basis'] === 'string' && ii['basis'].length > 0) entry.basis = ii['basis']
      interests.push(entry)
    }
    if (interests.length > 0) out.inferred_interests = interests
  }
  const confidence_raw = r['confidence_by_inference']
  if (Array.isArray(confidence_raw)) {
    const confidence: Array<{ field: string; score: number; basis?: string }> = []
    for (const c of confidence_raw) {
      if (typeof c !== 'object' || c === null) continue
      const cc = c as Record<string, unknown>
      if (typeof cc['field'] !== 'string') continue
      if (typeof cc['score'] !== 'number' || !Number.isFinite(cc['score'])) continue
      const entry: { field: string; score: number; basis?: string } = {
        field: cc['field'],
        score: cc['score'],
      }
      if (typeof cc['basis'] === 'string' && cc['basis'].length > 0) entry.basis = cc['basis']
      confidence.push(entry)
    }
    if (confidence.length > 0) out.confidence_by_inference = confidence
  }
  // Conversation count — the bullet body's intro clause uses it as
  // the "Based on N conversations" anchor. Honest grounding: ONLY
  // accept the explicit `conversation_count` set by the runner from
  // `aggregated.totals.chunks`. The earlier draft fell back to
  // `entities.length`, but `entities` is the deduped top-50 list
  // (NOT one row per conversation), so the body would systematically
  // misreport ("Based on 2 conversations") for normal imports — Codex
  // r1 P2 flagged this on the S5 PR. When the count is absent
  // (legacy result row pre-`0026_p2_v2_import_results_interests_confidence`),
  // the body collapses to the no-count clause via the builder's
  // `intro_count` check.
  const cc = r['conversation_count']
  if (typeof cc === 'number' && Number.isFinite(cc) && cc > 0) {
    out.conversation_count = cc
  }
  return out
}

/**
 * P2 v2 S5 — derive the rough month span of the Pass-2 result from the
 * topic recency timestamps. Returns null when no usable timestamp is
 * present so the builder falls back to the "(Based on N conversations.)"
 * clause without a months tail.
 *
 * The recency_score field in `import_result.topics` is normalized to
 * [0..1] (per `aggregatePass1`), so we can't derive months from it
 * directly. The engine relies on the post-aggregation persistence
 * layer to also stash the raw min/max timestamps under
 * `import_result.timespan_ms` when available; absent that, return
 * null (current shipped Pass-2 doesn't yet populate that field, so
 * the bullet body simply omits the months clause — see § 2.3 "Based
 * on N conversations" as the minimum honest grounding).
 */
export function deriveImportMonthsSpan(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const ts = r['timespan_ms']
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null
  const months = ts / (30 * 24 * 60 * 60 * 1_000)
  if (months < 1) return Math.max(1, Math.round(months))
  return Math.round(months)
}

export function readPersonaEditTargetSection(
  phase_state: Record<string, unknown>,
): 'voice' | 'about' | 'what-matters' | null {
  const v = phase_state['persona_edit_target_section']
  if (v === 'voice' || v === 'about' || v === 'what-matters') return v
  return null
}
