/**
 * @neutronai/onboarding — interview engine `ProjectsProposedFlow` seam.
 *
 * D9c — the `projects_proposed` phase handlers carved out of the
 * `InterviewEngine` god-class. These free functions decide what happens
 * when the interview lands on / leaves `projects_proposed`:
 *
 *   - `consumeProjectsProposedChoice` — the button/freeform handler for the
 *     phase (share-work sub-state, share-freeform capture, zero-state
 *     skip-ahead, and the additive confirm → `persona_synthesizing`
 *     advance). RETAINED INTACT for the defensive case where a freeform
 *     "drop X / add Y" reply reaches the phase; its live dispatcher (the
 *     conversational-drive `consumeChoice`) was deleted in K11b1 (954779c),
 *     so it currently has no production caller — it is preserved verbatim
 *     against a future re-wire, not resurrected here.
 *   - `autoConfirmProjectsProposedAndAdvance` — the gate-collapse (#93)
 *     auto-confirm invoked at the slug-rename / skip-slug inline-advance
 *     points (via `engine-slug.ts` + `engine-agent-name.ts`) so the user
 *     is not shown the already-reviewed project list behind a redundant
 *     "Good to go" gate. Includes the Argus-r2 zero-state guard.
 *
 * Each takes the engine instance as `self: EngineInternals` (its first
 * parameter) and is a VERBATIM copy of the original method body with
 * `this.` rewritten to `self.` — no logic, control-flow, or comment
 * changes. The private funnel-telemetry helpers (`importProposedCount`,
 * `logProjectFunnel`) and the share-freeform fallback splitter
 * (`splitFreeformProjectList`, kept exported for its unit test) travel
 * with the flow.
 *
 * The `was_new` guard (transcript append), the `walkAutoSkip` +
 * `AUTO_SKIP_PHASES` advance pairing, and the invalidate-then-resolve
 * cache-drop ordering (Codex PR #270 carry-over) all move verbatim.
 *
 * This module imports ONLY from sibling leaf/type modules; it MUST NOT
 * import from `engine.ts`. This is a PURE MOVE.
 */

import { createLogger } from '@neutronai/logger'
import type { ButtonChoice } from '@neutronai/channels/button-primitive.ts'
import { isLegalTransition, TERMINAL_PHASES } from './phase.ts'
import {
  MAX_ANALYSIS_PROJECTS,
  PROJECTS_PROPOSED_CONFIRM,
  PROJECTS_PROPOSED_REVIEW,
  PROJECTS_PROPOSED_SHARE_WORK,
  PROJECTS_PROPOSED_SKIP_AHEAD,
  STATIC_PHASE_SPECS,
} from './phase-prompts.ts'
import type { OnboardingState } from './state-store.ts'
import {
  AUTO_SKIP_PHASES,
  InterviewError,
  readStringArray,
  type AdvanceInput,
  type AdvanceResult,
  type EngineInternals,
} from './engine-internals.ts'

const log = createLogger('onboarding-engine')

/**
 * GAP1 (onboarding-wow-handoff-fix, 2026-06-09) — count of projects the
 * import proposed for this instance, read defensively off `phase_state`.
 * Feeds the project-funnel telemetry so a future proposed→shelled
 * divergence is observable instead of silent (Sam's 7-proposed→3-shelled
 * regression shipped with zero counters to catch it).
 */
function importProposedCount(phase_state: Record<string, unknown>): number {
  const ir = phase_state['import_result']
  if (ir === null || typeof ir !== 'object') return 0
  const proposed = (ir as Record<string, unknown>)['proposed_projects']
  return Array.isArray(proposed) ? proposed.length : 0
}

/**
 * GAP1 — emit the project funnel counter as a single structured log line.
 * `proposed` (import) → `presented` (capped at MAX_ANALYSIS_PROJECTS) →
 * `confirmed` (what we will shell). A drop at any hop is now grep-able
 * (`grep 'project_funnel'`) rather than invisible. Kept to a log line (no
 * new table) per the brief's "make divergence observable" scope.
 */
function logProjectFunnel(args: {
  owner_slug: string
  stage: string
  proposed: number
  presented: number
  confirmed: number
}): void {
  log.info('project_funnel', {
    project: args.owner_slug,
    stage: args.stage,
    proposed: args.proposed,
    presented: args.presented,
    confirmed: args.confirmed,
  })
}

/**
 * v0.1.80 (2026-05-22) — fallback splitter for the
 * `projects_proposed.share_work` path. Used only when the LLM driver
 * extracts nothing from a freeform reply. The user-facing rejection
 * hint advertises both "one per line" and "comma-separated", so this
 * splits on newlines, semicolons, AND a comma followed by whitespace +
 * a capital letter or digit. Plain mid-sentence commas like "Topline, Inc."
 * stay glued (Kieran r1 I2 — original splitter contradicted the hint).
 * Strips leading numeric / bullet markers, dedupes case-insensitively,
 * caps at 10 entries.
 */
export function splitFreeformProjectList(raw: string): string[] {
  const candidates = raw
    .split(/[\n;]+|,\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .map((s) => s.replace(/^(?:\d+[.)]\s+|[-*•]\s+)/, '').trim())
    .filter((s) => s.length > 0 && s.length <= 120)
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    const key = c.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
    if (out.length >= 10) break
  }
  return out
}

/**
 * P2 v2 § 3.12 / S7 — `projects_proposed` handler. The user is
 * confirming the project list. 2026-05-28 the [B] Review each one
 * button is gone from the surface (Sam walkthrough — clicking it
 * did nothing, just advanced); the engine still defensively accepts
 * a stale `value: 'review'` submission and treats it as a
 * confirm-equivalent (marker preserved as `review-deferred` for
 * downstream analytics). Freeform tweaks ("drop n8n", "rename A to
 * B") arrive via `__freeform__` + the LLM-router amend pipeline,
 * which mutates `phase_state.primary_projects[]` before this handler
 * lands. Confirm writes `primary_projects_confirmed[]` so persona-gen
 * + wow-action 03-project-shells consume a stable confirmed list.
 */
export async function consumeProjectsProposedChoice(
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
        phase: 'projects_proposed',
        button_prompt_id: choice.prompt_id,
        button_choice: choice_value,
      })
    }

    // v0.1.80 — zero-state share-work button. Flip the share-freeform
    // sub-state and re-emit; the resolver morphs the body into a
    // "tell me what you're working on" freeform prompt.
    const phase_state_pre = state.phase_state as Record<string, unknown>
    const awaiting_share_freeform =
      phase_state_pre['projects_proposed_share_freeform'] === true

    // v0.1.80 — share-freeform sub-state. User previously tapped
    // "Share what I'm working on" and is now sending the project list.
    // Split the freeform reply on newline/semicolon/comma so the user is
    // never stuck. After persisting, re-emit `projects_proposed` (do NOT
    // advance) so they see the populated body + standard confirm/review
    // buttons. (When the conversational router is active it handles the
    // share-freeform reply upstream; this is the deterministic capture.)
    if (awaiting_share_freeform && choice_value === '__freeform__') {
      self.invalidateResolvedSpec(input.owner_slug, 'projects_proposed')
      await self.resolvePhasePromptSpec(
        input.owner_slug,
        input.user_id,
        'projects_proposed',
      )
      const final_projects =
        freeform !== null ? splitFreeformProjectList(freeform) : []
      if (final_projects.length === 0) {
        // Couldn't pick anything out. Re-emit with a rejection that
        // hints at the expected format.
        const stay_patch: Record<string, unknown> = {
          active_prompt_id: null,
          last_choice_value: choice_value,
          ...(freeform !== null ? { last_choice_freeform: freeform } : {}),
          projects_proposed_rejection:
            "I couldn't pick out specific projects from that. Try listing one per line, or comma-separated.",
        }
        const stayed = await self.deps.stateStore.upsert({
          owner_slug: input.owner_slug,
          user_id: input.user_id,
          phase: 'projects_proposed',
          phase_state_patch: stay_patch,
          advanced_at: observed_at,
        })
        // Codex r1 (PR #270 carry-over) — drop the resolved-spec cache
        // that the pre-resolve at the top of this branch warmed with
        // the PRE-rejection phase_state (no `projects_proposed_rejection`
        // text). Without this, `emitPhasePrompt` re-uses the cached
        // spec and never renders the rejection guidance into the body
        // — the user sees the same "share your projects" body they
        // tapped through to land here.
        self.invalidateResolvedSpec(input.owner_slug, 'projects_proposed')
        let final_state: OnboardingState | null = null
        const emit = await self.emitPhasePrompt({
          owner_slug: input.owner_slug,
          user_id: input.user_id,
          topic_id: input.topic_id,
          phase: 'projects_proposed',
          observed_at,
          pre_send_state_upsert: async (prompt_id: string) => {
            final_state = await self.deps.stateStore.upsert({
              owner_slug: input.owner_slug,
              user_id: input.user_id,
              phase: 'projects_proposed',
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
      const stay_patch: Record<string, unknown> = {
        active_prompt_id: null,
        last_choice_value: choice_value,
        ...(freeform !== null ? { last_choice_freeform: freeform } : {}),
        primary_projects: [...final_projects],
        projects_proposed_share_freeform: null,
        projects_proposed_rejection: null,
      }
      const stayed = await self.deps.stateStore.upsert({
        owner_slug: input.owner_slug,
        user_id: input.user_id,
        phase: 'projects_proposed',
        phase_state_patch: stay_patch,
        advanced_at: observed_at,
      })
      // Codex r1 (PR #270 carry-over) — drop the resolved-spec cache
      // that the pre-resolve at the top of this branch warmed BEFORE
      // `primary_projects` was persisted. Without this, the cached
      // spec snapshots the pre-share zero-state projects and
      // `emitPhasePrompt` re-emits the empty "share what you're
      // working on" body even though the user just listed real
      // projects.
      self.invalidateResolvedSpec(input.owner_slug, 'projects_proposed')
      let final_state: OnboardingState | null = null
      const emit = await self.emitPhasePrompt({
        owner_slug: input.owner_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: 'projects_proposed',
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await self.deps.stateStore.upsert({
            owner_slug: input.owner_slug,
            user_id: input.user_id,
            phase: 'projects_proposed',
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

    if (choice_value === PROJECTS_PROPOSED_SHARE_WORK && !awaiting_share_freeform) {
      self.invalidateResolvedSpec(input.owner_slug, 'projects_proposed')
      const stay_patch: Record<string, unknown> = {
        active_prompt_id: null,
        last_choice_value: choice_value,
        projects_proposed_share_freeform: true,
        projects_proposed_rejection: null,
      }
      const stayed = await self.deps.stateStore.upsert({
        owner_slug: input.owner_slug,
        user_id: input.user_id,
        phase: 'projects_proposed',
        phase_state_patch: stay_patch,
        advanced_at: observed_at,
      })
      let final_state: OnboardingState | null = null
      const emit = await self.emitPhasePrompt({
        owner_slug: input.owner_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: 'projects_proposed',
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await self.deps.stateStore.upsert({
            owner_slug: input.owner_slug,
            user_id: input.user_id,
            phase: 'projects_proposed',
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

    // v0.1.80 — zero-state skip-ahead button. Advance directly with
    // empty primary_projects_confirmed[]; the user opted to set things
    // up as they go.
    if (choice_value === PROJECTS_PROPOSED_SKIP_AHEAD) {
      if (!isLegalTransition('projects_proposed', 'persona_synthesizing')) {
        throw new InterviewError(
          'projects_proposed',
          'illegal_transition',
          false,
          'projects_proposed → persona_synthesizing is not legal',
        )
      }
      const advance_patch: Record<string, unknown> = {
        active_prompt_id: null,
        last_choice_value: choice_value,
        primary_projects_confirmed: [],
        projects_proposed_confirm_kind: 'skip-ahead-zero-state',
        projects_proposed_rejection: null,
        projects_proposed_share_freeform: null,
      }
      const advanced = await self.deps.stateStore.upsert({
        owner_slug: input.owner_slug,
        user_id: input.user_id,
        phase: 'persona_synthesizing',
        phase_state_patch: advance_patch,
        advanced_at: observed_at,
      })
      let advanced_final = AUTO_SKIP_PHASES.has(advanced.phase)
        ? await self.walkAutoSkip(input.owner_slug, advanced, observed_at)
        : advanced
      if (advanced_final.phase === 'persona_synthesizing') {
        advanced_final = await self.synthesizePersona(input, advanced_final, observed_at)
      }
      const next_phase_final = advanced_final.phase
      const next_spec = STATIC_PHASE_SPECS[next_phase_final]
      if (next_spec !== undefined && !TERMINAL_PHASES.has(next_phase_final)) {
        let final_state: OnboardingState | null = null
        const emit = await self.emitPhasePrompt({
          owner_slug: input.owner_slug,
          user_id: input.user_id,
          topic_id: input.topic_id,
          phase: next_phase_final,
          observed_at,
          pre_send_state_upsert: async (prompt_id: string) => {
            final_state = await self.deps.stateStore.upsert({
              owner_slug: input.owner_slug,
              user_id: input.user_id,
              phase: next_phase_final,
              phase_state_patch: { active_prompt_id: prompt_id },
              advanced_at: observed_at,
            })
          },
        })
        if (final_state === null) {
          final_state =
            (await self.deps.stateStore.get(input.owner_slug, input.user_id)) ??
            advanced_final
        }
        return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
      }
      return { outcome: 'advanced', state: advanced_final }
    }

    // The confirmed list is the projects already seeded on `phase_state`.
    // GAP1 (onboarding-wow-handoff-fix, 2026-06-09) — confirm is ADDITIVE:
    // freeform edits ("drop #2, add Studio Sessions") are extracted +
    // unioned-minus-removals upstream on the live CC session
    // (`post-turn-extractor.ts`) before this handler runs, so the persisted
    // `primary_projects` is already the post-edit view. Confirm it here;
    // never silently shrink it.
    const merged_projects =
      readStringArray(state.phase_state as Record<string, unknown>, 'primary_projects') ?? []
    const review_requested = choice_value === PROJECTS_PROPOSED_REVIEW
    // GAP1 — project funnel telemetry: make proposed → confirmed divergence
    // observable instead of silent. `presented` is what the user could see
    // (capped at MAX_ANALYSIS_PROJECTS); `confirmed` is what we shell.
    logProjectFunnel({
      owner_slug: input.owner_slug,
      stage: 'projects_proposed_confirm',
      proposed: importProposedCount(state.phase_state as Record<string, unknown>),
      presented: Math.min(
        importProposedCount(state.phase_state as Record<string, unknown>),
        MAX_ANALYSIS_PROJECTS,
      ),
      confirmed: merged_projects.length,
    })

    if (!isLegalTransition('projects_proposed', 'persona_synthesizing')) {
      throw new InterviewError(
        'projects_proposed',
        'illegal_transition',
        false,
        'projects_proposed → persona_synthesizing is not legal',
      )
    }
    const advance_patch: Record<string, unknown> = {
      active_prompt_id: null,
      last_choice_value: choice_value,
      ...(freeform !== null ? { last_choice_freeform: freeform } : {}),
      primary_projects_confirmed: [...merged_projects],
      projects_proposed_confirm_kind:
        choice_value === PROJECTS_PROPOSED_CONFIRM
          ? 'auto-create'
          : review_requested
            ? 'review-deferred'
            : 'freeform',
      projects_proposed_rejection: null,
    }
    const advanced = await self.deps.stateStore.upsert({
      owner_slug: input.owner_slug,
      user_id: input.user_id,
      phase: 'persona_synthesizing',
      phase_state_patch: advance_patch,
      advanced_at: observed_at,
    })
    let advanced_final = AUTO_SKIP_PHASES.has(advanced.phase)
      ? await self.walkAutoSkip(input.owner_slug, advanced, observed_at)
      : advanced
    if (advanced_final.phase === 'persona_synthesizing') {
      advanced_final = await self.synthesizePersona(input, advanced_final, observed_at)
    }
    const next_phase_final = advanced_final.phase
    const next_spec = STATIC_PHASE_SPECS[next_phase_final]
    if (next_spec !== undefined && !TERMINAL_PHASES.has(next_phase_final)) {
      let final_state: OnboardingState | null = null
      const emit = await self.emitPhasePrompt({
        owner_slug: input.owner_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: next_phase_final,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await self.deps.stateStore.upsert({
            owner_slug: input.owner_slug,
            user_id: input.user_id,
            phase: next_phase_final,
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state = (await self.deps.stateStore.get(input.owner_slug, input.user_id)) ?? advanced_final
      }
      return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
    }
    return { outcome: 'advanced', state: advanced_final }
}

/**
 * Gate-collapse (#93, 2026-06-05) — auto-confirm `projects_proposed`.
 *
 * Sam's 2026-06-05 signup hit a redundant second approval gate: after
 * reviewing the project list at `import_analysis_presented` (the single
 * content-review gate), he was shown the SAME list again at
 * `projects_proposed` behind a "Good to go" button — "Why do I have to
 * approve them twice." This helper collapses that gate: on landing on
 * `projects_proposed` we auto-confirm the already-reviewed list
 * (`primary_projects`, falling back to `import_result.proposed_projects`)
 * by writing `primary_projects_confirmed[]` and advancing straight to
 * `persona_synthesizing` → `synthesizePersona`. No button is emitted.
 *
 * `projects_proposed` is DELIBERATELY kept in the enum and as the
 * slug-rename redirect anchor (v0.1.133): `advanceFromSlugChosen` still
 * lands the rekeyed row here so the renamed gateway finds it on
 * reconnect. This helper is invoked at the THREE points where the gate
 * button would otherwise be shown — the skip-slug inline advance, the
 * no-restart slug-rename inline advance, and the renamed gateway's
 * post-redirect `start()` — so the phase is traversed but never
 * surfaced. `consumeProjectsProposedChoice` is retained intact for the
 * defensive case where a freeform "drop X / add Y" reply still reaches
 * the phase (e.g. a stale in-flight prompt).
 *
 * Shell creation is unaffected: project shells are built later in the
 * wow-moment from `primary_projects_confirmed[]` (fallback
 * `import_result.proposed_projects`, MIN 2 — `wow-moment/actions/
 * 03-project-shells.ts`), so writing the confirmed list here preserves
 * the wow-moment's inputs.
 *
 * Argus r2 zero-state guard — the auto-confirm ONLY fires when there is a
 * reviewed list to collapse the redundant gate on. If BOTH `primary_projects`
 * and `import_result.proposed_projects` are empty, auto-confirming would
 * write `primary_projects_confirmed: []` and commit the user to an empty
 * workspace (confirmed+empty reads as "explicitly declined" downstream → 0
 * shells). In that case we re-emit the zero-state `projects_proposed` prompt
 * ("Share what I'm working on" / "Skip for now") and leave the row parked so
 * the user chooses, rather than silently advancing.
 */
export async function autoConfirmProjectsProposedAndAdvance(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const phase_state = state.phase_state as Record<string, unknown>
    const reviewed = readStringArray(phase_state, 'primary_projects') ?? []
    const import_result = phase_state['import_result']
    const proposed_from_import: ReadonlyArray<string> =
      import_result !== null &&
      typeof import_result === 'object' &&
      Array.isArray((import_result as Record<string, unknown>)['proposed_projects'])
        ? ((import_result as Record<string, unknown>)['proposed_projects'] as unknown[]).filter(
            (p): p is string => typeof p === 'string' && p.trim().length > 0,
          )
        : []
    const confirmed = reviewed.length > 0 ? reviewed : proposed_from_import

    // Argus r2 — zero-state guard. When BOTH the reviewed list
    // (`primary_projects`) and the import-proposed list
    // (`import_result.proposed_projects`) are empty there is NO
    // already-reviewed content to silently auto-confirm. Writing
    // `primary_projects_confirmed: []` here and advancing would commit the
    // user to an empty workspace: `buildWowSignalsFromState` flips
    // `projects_confirmed: true` on the present-but-empty array, and
    // `wow-moment/actions/03-project-shells.ts` reads confirmed+empty as
    // "user explicitly declined" → ZERO shells created. The user would
    // never see the retained zero-state prompt ("Share what I'm working
    // on" / "Skip for now"). So do NOT auto-confirm: re-emit the zero-state
    // `projects_proposed` prompt and leave the row parked there so the user
    // makes the call (share work → shells, or skip → explicit decline).
    // The auto-confirm gate-collapse only applies when there IS a reviewed
    // list to collapse the redundant second approval on.
    if (confirmed.length === 0) {
      self.invalidateResolvedSpec(input.owner_slug, 'projects_proposed')
      let final_state: OnboardingState | null = null
      const emit = await self.emitPhasePrompt({
        owner_slug: input.owner_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: 'projects_proposed',
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await self.deps.stateStore.upsert({
            owner_slug: input.owner_slug,
            user_id: input.user_id,
            phase: 'projects_proposed',
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state =
          (await self.deps.stateStore.get(input.owner_slug, input.user_id)) ?? state
      }
      return {
        outcome: 'reemitted_current',
        state: final_state,
        prompt_id: emit.prompt_id,
      }
    }

    if (!isLegalTransition('projects_proposed', 'persona_synthesizing')) {
      throw new InterviewError(
        'projects_proposed',
        'illegal_transition',
        false,
        'projects_proposed → persona_synthesizing is not legal',
      )
    }
    // GAP1 — funnel telemetry on the gate-collapse (the live auto-confirm
    // path Sam hit on 2026-06-09). `confirmed` here is the reviewed
    // `primary_projects`; with the additive-merge + extraction-prompt fixes
    // upstream it should equal the user's full named set (picks + additions).
    logProjectFunnel({
      owner_slug: input.owner_slug,
      stage: 'gate_collapse_auto_confirm',
      proposed: importProposedCount(phase_state),
      presented: Math.min(importProposedCount(phase_state), MAX_ANALYSIS_PROJECTS),
      confirmed: confirmed.length,
    })
    const advance_patch: Record<string, unknown> = {
      active_prompt_id: null,
      primary_projects_confirmed: [...confirmed],
      projects_proposed_confirm_kind: 'auto-confirm-post-review',
      projects_proposed_rejection: null,
      projects_proposed_share_freeform: null,
    }
    const advanced = await self.deps.stateStore.upsert({
      owner_slug: input.owner_slug,
      user_id: input.user_id,
      phase: 'persona_synthesizing',
      phase_state_patch: advance_patch,
      advanced_at: observed_at,
    })
    let advanced_final = AUTO_SKIP_PHASES.has(advanced.phase)
      ? await self.walkAutoSkip(input.owner_slug, advanced, observed_at)
      : advanced
    if (advanced_final.phase === 'persona_synthesizing') {
      advanced_final = await self.synthesizePersona(input, advanced_final, observed_at)
    }
    const next_phase_final = advanced_final.phase
    const next_spec = STATIC_PHASE_SPECS[next_phase_final]
    if (next_spec !== undefined && !TERMINAL_PHASES.has(next_phase_final)) {
      let final_state: OnboardingState | null = null
      const emit = await self.emitPhasePrompt({
        owner_slug: input.owner_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: next_phase_final,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await self.deps.stateStore.upsert({
            owner_slug: input.owner_slug,
            user_id: input.user_id,
            phase: next_phase_final,
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state = (await self.deps.stateStore.get(input.owner_slug, input.user_id)) ?? advanced_final
      }
      return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
    }
    return { outcome: 'advanced', state: advanced_final }
}
