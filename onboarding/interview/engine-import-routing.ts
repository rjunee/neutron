/**
 * @neutronai/onboarding — interview engine import-routing seam.
 *
 * R5 / audit P2-4 — the 18 import-routing methods extracted from the
 * `InterviewEngine` god-class as free functions. Each takes the engine
 * instance as `self: EngineInternals` (its first parameter) and is a
 * VERBATIM copy of the original method body with `this.` rewritten to
 * `self.`. `engine.ts` keeps a one-line delegator method per function so
 * the class's public API + every call site is byte-for-byte unchanged.
 *
 * This is a PURE MOVE — no logic, control-flow, or comment changes.
 */

import {
  buildButtonPrompt,
  canonicalPromptSeed,
  deriveIdempotencyKey,
  type ButtonChoice,
} from '../../channels/button-primitive.ts'
import {
  isLegalTransition,
  TERMINAL_PHASES,
  type OnboardingPhase,
} from './phase.ts'
import {
  buildImportRunningPromptSpec,
  IMPORT_RESUME_CHOICE_VALUE,
  IMPORT_RUNNING_RETRY,
  IMPORT_RUNNING_SKIP,
  type ImportRunningSubStep,
} from './phase-prompts.ts'
import {
  IMPORT_SOURCE_SWITCH_ACK,
} from './interaction-mode.ts'
import { auditRequiredFields } from './required-fields-audit.ts'
import {
  MAX_OAUTH_CHUNK_TARGET_TOKENS,
  type ChunkerInput,
  type ImportJob,
  type ImportResult,
  type ImportSource,
} from '../history-import/types.ts'
import { STATIC_PHASE_SPECS } from './llm-prompt-driver.ts'
import type { OnboardingState } from './state-store.ts'
import type { AdvanceInput, AdvanceResult } from './engine-internals.ts'
import {
  AUTO_SKIP_PHASES,
  COOLDOWN_AFTER_PAUSED_MS,
  computeSwitchIntent,
  dedupeStringsCaseInsensitive,
  type EngineInternals,
  evaluateImportTimeout,
  IMPORT_PARTIAL_THRESHOLD,
  IMPORT_RUNNING_SOFT_TIMEOUT_MS,
  importResultHasSignal,
  InterviewError,
  isValidImportUrl,
  MAX_RATE_LIMIT_RESUME_CYCLES,
  NON_ADVANCING_CHOICE_VALUES,
  PASS2_EXPECTED_DURATION_MS,
  readImportSource,
  readNumber,
  readString,
  readStringArray,
} from './engine-internals.ts'

export async function reconcileSwitchIntentFromFreeform(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<OnboardingState> {
    const ps = state.phase_state as Record<string, unknown>
    const staged = readString(ps, 'ai_substrate_used')
    const computed = computeSwitchIntent(input.freeform_text, staged)
    // A freeform that names NO source (or both) leaves a genuine prior intent
    // untouched — "is it done?" must not silently clear a real switch.
    if (computed === undefined) return state
    const mentioned = computed.mentioned
    const priorIntent = readString(ps, 'source_switch_intent')
    const next_intent: 'chatgpt' | 'claude' | null = computed.intent
    if (next_intent === priorIntent) return state
    const updated = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: state.phase,
      phase_state_patch: {
        topic_id: input.topic_id,
        source_switch_intent: next_intent,
      },
      // Reconciling an intent is not forward motion — preserve the stall clock.
      advanced_at: state.last_advanced_at,
    })
    self.deps.transcript.append({
      role: 'system',
      body: `import: reconciled source_switch_intent ${priorIntent ?? 'none'} → ${next_intent ?? 'none'} from freeform at ai_substrate_offered (staged=${staged ?? 'unknown'}, named=${mentioned})`,
      phase: state.phase,
    })
    return updated
  }

export async function reEmitImportSourceSelection(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    if (input.freeform_text !== undefined && input.freeform_text.length > 0) {
      self.deps.transcript.append({
        role: 'user',
        body: input.freeform_text,
        phase: state.phase,
      })
    }
    await self.sendAgentText(input, state.phase, IMPORT_SOURCE_SWITCH_ACK, observed_at)
    // The cached import_upload_pending dynamic spec is now stale (the user
    // is leaving it); drop it so a later re-entry rebuilds against the new
    // source.
    self.invalidateResolvedSpec(input.project_slug, 'import_upload_pending')

    // ISSUES #98 — record explicit source-switch INTENT. The reroute fires on
    // ANY freeform (ISSUES #84), but when the user's text UNAMBIGUOUSLY names a
    // source DIFFERENT from the one we have staged (`ai_substrate_used`), they
    // are abandoning the staged source. A ZIP for the OLD source can still land
    // afterward (multi-GB uploads run for minutes; the composer isn't locked) —
    // and `notifyImportUpload`'s late-upload-tolerance branch would otherwise
    // auto-import that abandoned source because `ai_substrate_used` is preserved
    // here (non-destructive re-emit). Persisting `source_switch_intent` lets the
    // late-upload path refuse to auto-honor a source the user moved away from
    // and surface the visible re-pick notice instead. A bare clarification
    // (no source token, or one that matches the staged source) records NO
    // intent, so the legitimate concurrent-upload auto-honor (Argus r1) is
    // preserved. The intent is cleared on a real source tap
    // (`advanceFromAiSubstrateOfferedToUpload`).
    const priorSubstrate = readString(
      state.phase_state as Record<string, unknown>,
      'ai_substrate_used',
    )
    // Same set/clear rule as the reconcile path. The reroute is the FIRST hop
    // into ai_substrate_offered, so a no-source freeform records NO intent
    // (treat `undefined` as null here — there is no prior intent to preserve).
    const switch_intent: 'chatgpt' | 'claude' | null =
      computeSwitchIntent(input.freeform_text, priorSubstrate)?.intent ?? null

    let updated: OnboardingState | null = null
    const emit = await self.emitPhasePrompt({
      project_slug: input.project_slug,
      user_id: input.user_id,
      topic_id: input.topic_id,
      phase: 'ai_substrate_offered',
      observed_at,
      seed_suffix: `source-switch:${observed_at}`,
      pre_send_state_upsert: async (prompt_id: string) => {
        updated = await self.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: 'ai_substrate_offered',
          // NON-DESTRUCTIVE: deliberately does NOT touch `ai_substrate_used`
          // or `uploads_received` (Argus r2). Preserving them means a
          // detector false positive cannot lose a completed upload; the
          // consume handler resets them only when a DIFFERENT source is
          // actually tapped.
          phase_state_patch: {
            active_prompt_id: prompt_id,
            topic_id: input.topic_id,
            // ISSUES #98: record / clear switch-intent. Set ONLY when the user
            // named a different source than the staged one; otherwise null so a
            // bare clarification leaves the auto-honor path intact and a prior
            // intent doesn't go stale across re-displays.
            source_switch_intent: switch_intent,
          },
          advanced_at: observed_at,
        })
      },
    })
    if (updated === null) {
      updated = (await self.deps.stateStore.get(
        input.project_slug,
        input.user_id,
      )) as OnboardingState
    }
    return { outcome: 'reemitted_current', state: updated, prompt_id: emit.prompt_id }
  }

export async function consumeAiSubstrateOfferedChoice(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const choice_value = choice.choice_value
    if (was_new) {
      self.deps.transcript.append({
        role: 'user',
        body:
          choice_value === '__freeform__' && choice.freeform_text !== undefined
            ? choice.freeform_text
            : choice_value,
        phase: state.phase,
        button_prompt_id: choice.prompt_id,
        button_choice: choice_value,
      })
    }
    if (NON_ADVANCING_CHOICE_VALUES.has(choice_value)) {
      return { outcome: 'no_active_prompt', state }
    }
    // Codex r3 P1 (post-T4) — paste-URL sub-flow per the spec §
    // 2.3 v1 contract ("freeform paste of a presigned URL is
    // acceptable"). When `phase_state.import_pending_source` is set,
    // the user is mid-paste: a freeform reply is the URL.
    const pending_source = readImportSource(state.phase_state, 'import_pending_source')
    if (pending_source !== null) {
      if (choice_value === 'skip') {
        return await self.advanceFromAiSubstrateOffered(input, state, observed_at, {
          skipped: true,
          source: null,
          job_id: null,
        })
      }
      if (choice_value === '__freeform__' && choice.freeform_text !== undefined) {
        const url = choice.freeform_text.trim()
        if (!isValidImportUrl(url)) {
          return await self.reEmitImportOfferedPaste(
            input,
            state,
            observed_at,
            pending_source,
            "That doesn't look like a URL — paste a full https://... link, or tap Skip.",
          )
        }
        return await self.acceptPastedImportUrlAndStart(
          input,
          state,
          observed_at,
          pending_source,
          url,
        )
      }
      // Unknown button on the paste prompt — re-emit.
      return await self.reEmitImportOfferedPaste(input, state, observed_at, pending_source, null)
    }
    // P2 v2 § 3.4 — `neither` is the no-import branch; routes to the
    // gap-fill interview so the engine collects required fields via
    // conversation. Legacy v1 `skip` value is honoured for back-compat.
    if (choice_value === 'neither' || choice_value === 'skip') {
      return await self.advanceFromAiSubstrateOffered(input, state, observed_at, {
        skipped: true,
        source: null,
        job_id: null,
      })
    }
    // P2 v2 § 3.4 + § 3.5 — v2 substrate values (`chatgpt` / `claude`)
    // route through the new `import_upload_pending` phase so
    // the user sees download instructions + uploads their zip on the
    // chat surface (S3 wires the upload endpoint). The skeleton parks
    // the chosen substrate on `phase_state.ai_substrate_used` so S3 can
    // render the right download block (ChatGPT vs Claude). Legacy v1
    // button values (`chatgpt_zip` / `claude_zip`) — kept for back-compat
    // with the composer wiring tests that pre-date the upload UX — still
    // route into the runner.start path below.
    const v2SubstrateChoices = new Set(['chatgpt', 'claude'])
    if (v2SubstrateChoices.has(choice_value)) {
      return await self.advanceFromAiSubstrateOfferedToUpload(
        input,
        state,
        observed_at,
        choice_value as 'chatgpt' | 'claude',
      )
    }
    // Deploy-window robustness (remove-both-import-option, 2026-06-06): the
    // 'both' option was removed, but a user whose OLD 4-option prompt is
    // still open during the release can tap its persisted `value:'both'`.
    // That stale tap must NOT silently dead-end (the #383 "never dead-end"
    // invariant). Re-emit the current 3-option source picker with a fresh
    // prompt_id so the user simply re-picks ChatGPT / Claude / Neither.
    if (choice_value === 'both') {
      return await self.reEmitImportSourceSelection(input, state, observed_at)
    }
    const v1ToSource: Record<string, ImportSource | null> = {
      chatgpt_zip: 'chatgpt-zip',
      claude_zip: 'claude-zip',
    }
    const source = v1ToSource[choice_value] ?? null
    if (source === null) {
      // Unknown value — keep state at ai_substrate_offered so a follow-up
      // tap can route through this branch again. The engine's stay-at-
      // phase re-emit path is the standard recovery.
      return { outcome: 'no_active_prompt', state }
    }

    // Codex r3 P1 (post-T4) — try the resolver first (filesystem-based
    // for side-channel uploads). If the resolver returns null and the
    // engine has a `urlFetcher` wired (paste-URL flow), emit a paste
    // prompt; otherwise re-emit the "I don't see your export" body.
    // The paste prompt records `import_pending_source` so the next
    // freeform inbound is treated as the URL.

    // Codex r1 P2 — the brief lists `importJobRunner` as required for
    // the zip path. When unwired (test or legacy composer) we collapse
    // to the skip path rather than stranding the user. Production
    // composer ALWAYS wires the hook (see build-landing-stack.ts).
    if (self.deps.importJobRunner === undefined) {
      self.deps.transcript.append({
        role: 'system',
        body: `import: importJobRunner unwired; collapsing ${source} choice to skip`,
        phase: state.phase,
      })
      return await self.advanceFromAiSubstrateOffered(input, state, observed_at, {
        skipped: true,
        source: null,
        job_id: null,
      })
    }

    // Codex r1 P1 (post-T4) — resolve the payload via the optional
    // resolver. Production wires an upload-mechanism-backed resolver;
    // tests inject a buffer. When the resolver is UNWIRED OR returns
    // null (upload hasn't landed yet), do NOT call `runner.start` with
    // an empty buffer — that would fire a guaranteed parse_failed run
    // and burn budget. Instead, stay at `import_offered` and re-emit
    // a "drop your export then tap Continue" prompt so the user has an
    // actionable path. The fresh tap routes back through this handler;
    // when the resolver yields a real Buffer the runner kicks off
    // normally.
    let payload: ChunkerInput | null = null
    if (self.deps.importPayloadResolver !== undefined) {
      try {
        payload = await self.deps.importPayloadResolver.resolve({
          project_slug: input.project_slug,
          user_id: input.user_id,
          source,
        })
      } catch (err) {
        self.deps.transcript.append({
          role: 'system',
          body: `import: payload resolve threw: ${err instanceof Error ? err.message : String(err)}`,
          phase: state.phase,
        })
        payload = null
      }
    }
    if (payload === null) {
      // Codex r3 P1 (post-T4) — emit a paste-URL prompt per the spec's
      // v1 contract. The user pastes a URL; the next freeform inbound
      // is treated as the URL, stashed on phase_state, and the
      // resolver (UrlPasteImportPayloadResolver chain) fetches it on
      // the retry. Stash `import_pending_source` so the paste sub-flow
      // recognizes the next reply.
      return await self.emitImportOfferedPastePrompt(
        input,
        state,
        observed_at,
        source,
      )
    }

    // Kick off the runner. The hook's `start` is synchronous on the
    // engine's clock (returns job_id immediately); the actual import
    // runs in the background. We stash the job_id in phase_state for
    // later polls + crash-resume re-entry.
    let job_id: string
    try {
      const r = await self.deps.importJobRunner.start({
        project_slug: self.secretsIdentity(input.project_slug),
        user_id: input.user_id,
        source,
        payload,
      })
      job_id = r.job_id
    } catch (err) {
      // Argus r2 (fix-pass) — a sync throw out of `runner.start` (parser
      // unwired, DB error, fatal config gap, etc.) used to silently
      // route through `advanceFromAiSubstrateOffered({ skipped: true })`,
      // collapsing into archetype_picked with no user-visible signal.
      // Same UX gap as the per-chunk `llm_unwired` swallow in
      // job-runner.ts. We now (1) advance phase_state to
      // `import_running` so the failed sub_step is emittable, then
      // (2) emit the `failed` prompt with retry/skip + paste-fresh-URL
      // affordances per the existing `failed` PhasePromptSpec.
      const failure_reason = err instanceof Error ? err.message : String(err)
      self.deps.transcript.append({
        role: 'system',
        body: `import: runner.start threw: ${failure_reason}`,
        phase: state.phase,
      })
      const advancedToRunning = await self.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'import_running',
        phase_state_patch: {
          active_prompt_id: null,
          last_choice_value: choice_value,
          import_job_id: null,
          import_source: source,
          import_result: null,
          import_skip_reason: null,
          import_failure_reason: failure_reason,
        },
        advanced_at: observed_at,
      })
      return await self.emitImportRunningPromptSpec(
        input,
        advancedToRunning,
        observed_at,
        { sub_step: 'failed', source, failure_reason },
      )
    }

    self.deps.transcript.append({
      role: 'system',
      body: `import: started job=${job_id} source=${source}`,
      phase: state.phase,
    })

    // Advance to import_running. The runner is in the queued/pass1-running
    // state by this point; we poll once below so a fast-completing
    // import (cached chunks, empty export, immediate failure) lands on
    // archetype_picked without forcing the user to re-tap.
    const advanced = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'import_running',
      phase_state_patch: {
        active_prompt_id: null,
        last_choice_value: choice_value,
        import_job_id: job_id,
        import_source: source,
        import_result: null,
        import_skip_reason: null,
        import_failure_reason: null,
      },
      advanced_at: observed_at,
    })
    return await self.pollImportRunningAndAdvance(input, advanced, observed_at)
  }

export async function emitImportOfferedPastePrompt(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
  ): Promise<AdvanceResult> {
    return await self.reEmitImportOfferedPaste(
      input,
      state,
      observed_at,
      source,
      null,
    )
  }

export async function reEmitImportOfferedPaste(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
    rejection: string | null,
  ): Promise<AdvanceResult> {
    const sourceLabel =
      source === 'chatgpt-zip' ? 'ChatGPT export' : 'Claude.ai export'
    const baseBody =
      `Paste a link to your ${sourceLabel} zip (e.g. a presigned S3 URL or any https:// link), and I'll start analyzing it. ` +
      `Or tap Skip to move on without an import.`
    const body =
      rejection !== null && rejection.length > 0
        ? `${rejection}\n\n${baseBody}`
        : baseBody
    const options = [{ label: 'A', body: 'Skip for now', value: 'skip' }]
    const prior_attempts = readNumber(state.phase_state, 'import_offered_retry_count') ?? 0
    const next_attempts = prior_attempts + 1
    await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'ai_substrate_offered',
      phase_state_patch: {
        active_prompt_id: null,
        import_offered_retry_count: next_attempts,
        import_pending_source: source,
      },
      advanced_at: observed_at,
    })
    const seed = canonicalPromptSeed({
      body,
      options: options.map((o) => ({ value: o.value })),
    })
    const idempotency_key = deriveIdempotencyKey({
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      seed: `import_offered_paste:${next_attempts}:${seed}`,
    })
    const prompt = buildButtonPrompt({
      body,
      options,
      allow_freeform: true,
      idempotency_key,
      uuid: self.uuid,
    })
    const emit = await self.deps.buttonStore.emit(prompt, { topic_id: input.topic_id })
    const final_state = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'ai_substrate_offered',
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
          'ai_substrate_offered',
          'send_failed',
          true,
          `failed to emit import_offered paste prompt`,
          err,
        )
      }
      self.deps.transcript.append({
        role: 'agent',
        body,
        phase: 'ai_substrate_offered',
        button_prompt_id: emit.prompt_id,
      })
    }
    return { outcome: 'reemitted_current', state: final_state, prompt_id: emit.prompt_id }
  }

export async function acceptPastedImportUrlAndStart(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
    url: string,
  ): Promise<AdvanceResult> {
    if (self.deps.importJobRunner === undefined) {
      // Defensive — runner not wired, fall back to skip.
      return await self.advanceFromAiSubstrateOffered(input, state, observed_at, {
        skipped: true,
        source: null,
        job_id: null,
      })
    }
    // Stash the URL where the resolver can find it.
    const url_key = `import_paste_url_${source}`
    const updated = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'ai_substrate_offered',
      phase_state_patch: {
        active_prompt_id: null,
        import_pending_source: null,
        [url_key]: url,
      },
      advanced_at: observed_at,
    })
    // Resolve via the wired resolver. The production composer chains
    // `UrlPasteImportPayloadResolver` (reads the stashed URL +
    // fetches) with `FilesystemImportPayloadResolver` (side-channel
    // uploads). Either path produces a Buffer.
    let payload: ChunkerInput | null = null
    if (self.deps.importPayloadResolver !== undefined) {
      try {
        payload = await self.deps.importPayloadResolver.resolve({
          project_slug: input.project_slug,
          user_id: input.user_id,
          source,
        })
      } catch (err) {
        self.deps.transcript.append({
          role: 'system',
          body: `import: payload resolve threw on paste: ${err instanceof Error ? err.message : String(err)}`,
          phase: state.phase,
        })
        payload = null
      }
    }
    if (payload === null) {
      // The URL fetch failed (404, network error, oversize). Re-emit
      // the paste prompt with a rejection reason.
      return await self.reEmitImportOfferedPaste(
        input,
        updated,
        observed_at,
        source,
        "Couldn't fetch that URL — make sure it's publicly accessible (or a working presigned link).",
      )
    }
    // Kick off the runner.
    let job_id: string
    try {
      const r = await self.deps.importJobRunner.start({
        project_slug: self.secretsIdentity(input.project_slug),
        user_id: input.user_id,
        source,
        payload,
      })
      job_id = r.job_id
    } catch (err) {
      self.deps.transcript.append({
        role: 'system',
        body: `import: runner.start threw on paste: ${err instanceof Error ? err.message : String(err)}`,
        phase: state.phase,
      })
      return await self.reEmitImportOfferedPaste(
        input,
        updated,
        observed_at,
        source,
        'Could not start the import. Try a different URL or skip.',
      )
    }
    self.deps.transcript.append({
      role: 'system',
      body: `import: started job=${job_id} source=${source} (from paste URL)`,
      phase: state.phase,
    })
    const advanced = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'import_running',
      phase_state_patch: {
        active_prompt_id: null,
        import_job_id: job_id,
        import_source: source,
        import_result: null,
        import_skip_reason: null,
        import_failure_reason: null,
      },
      advanced_at: observed_at,
    })
    return await self.pollImportRunningAndAdvance(input, advanced, observed_at)
  }

export async function advanceFromAiSubstrateOfferedToUpload(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    ai_substrate_used: 'chatgpt' | 'claude',
  ): Promise<AdvanceResult> {
    const next_phase: OnboardingPhase = 'import_upload_pending'
    if (!isLegalTransition(state.phase, next_phase)) {
      throw new InterviewError(
        state.phase,
        'illegal_transition',
        false,
        `import: illegal transition ${state.phase} → ${next_phase}`,
      )
    }
    // Argus r2 (remove-both-import-option, 2026-06-06) — fulfil the
    // documented invariant at the source-switch re-emit (~:4515-4519):
    // "the consume handler resets [uploads_received] only when a DIFFERENT
    // source is actually tapped". A real re-pick of a DIFFERENT substrate
    // means any zip staged under the OLD source (stale `uploads_received`,
    // including from the removed two-upload 'both' flow) is no longer the
    // user's choice. Clearing it here is the PRIMARY root fix for the
    // re-pick → Skip deploy-window hole: without it, the
    // import_upload_pending SKIP recovery would import the stale source's
    // zip, ignoring both the Skip AND the just-switched source. We compare
    // against the FIRST staged source (the SKIP recovery's `effectiveSource`);
    // if it differs from the new pick, drop the staged uploads. A re-pick of
    // the SAME source is a detector false-positive round-trip and keeps the
    // completed upload (no data loss).
    const prior_state = state.phase_state as Record<string, unknown>
    const staged = (readStringArray(prior_state, 'uploads_received') ?? []).filter(
      (s): s is 'chatgpt' | 'claude' => s === 'chatgpt' || s === 'claude',
    )
    const re_pick_clears_staged = staged.length >= 1 && staged[0] !== ai_substrate_used
    const advanced = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: next_phase,
      phase_state_patch: {
        active_prompt_id: null,
        ai_substrate_used,
        // Clear stale staged uploads when the re-picked source differs, so
        // the SKIP recovery never imports a source the user moved away from.
        ...(re_pick_clears_staged ? { uploads_received: [] } : {}),
        // ISSUES #98: a real source tap RESOLVES any recorded switch-intent —
        // `ai_substrate_used` is now authoritative again, so a subsequent late
        // upload should be honored/refused against the freshly chosen source,
        // not a stale intent from before the tap.
        source_switch_intent: null,
      },
      advanced_at: observed_at,
    })
    if (re_pick_clears_staged) {
      self.deps.transcript.append({
        role: 'system',
        body: `import: re-pick switched source ${staged[0]} → ${ai_substrate_used}; cleared stale staged upload(s) [${staged.join(',')}] so a later skip/recovery cannot import the abandoned source`,
        phase: next_phase,
      })
    }
    const next_spec = STATIC_PHASE_SPECS[next_phase]
    if (next_spec === undefined || TERMINAL_PHASES.has(next_phase)) {
      return { outcome: 'advanced', state: advanced }
    }
    let final_state: OnboardingState | null = null
    const emit = await self.emitPhasePrompt({
      project_slug: input.project_slug,
      user_id: input.user_id,
      topic_id: input.topic_id,
      phase: next_phase,
      observed_at,
      pre_send_state_upsert: async (prompt_id: string) => {
        final_state = await self.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: next_phase,
          phase_state_patch: { active_prompt_id: prompt_id },
          advanced_at: observed_at,
        })
      },
    })
    if (final_state === null) {
      final_state = (await self.deps.stateStore.get(input.project_slug, input.user_id)) as OnboardingState
    }
    return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
  }

export async function advanceFromAiSubstrateOffered(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    opts: { skipped: boolean; source: ImportSource | null; job_id: string | null },
  ): Promise<AdvanceResult> {
    const next_phase: OnboardingPhase = 'work_interview_gap_fill'
    if (!isLegalTransition(state.phase, next_phase)) {
      throw new InterviewError(
        state.phase,
        'illegal_transition',
        false,
        `import: illegal transition ${state.phase} → ${next_phase}`,
      )
    }
    const advanced = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: next_phase,
      phase_state_patch: {
        active_prompt_id: null,
        import_result: null,
        import_job_id: opts.job_id,
        import_source: opts.source,
        import_skip_reason: opts.skipped ? 'user_skipped' : null,
        import_failure_reason: null,
        // Clear any archetype_hint inheriting from the legacy import_offered
        // body. T5 will wire archetype capture properly; for now null is
        // honest about not having captured anything.
        archetype_hint: null,
      },
      advanced_at: observed_at,
    })
    // Auto-skip past gateless phases (e.g. name_chosen) just like the
    // generic consumeChoice tail does, plus emit the next phase's
    // prompt so the user sees the archetype-picked body.
    let advanced_final = AUTO_SKIP_PHASES.has(next_phase)
      ? await self.walkAutoSkip(input.project_slug, advanced, observed_at)
      : advanced
    const next_spec = STATIC_PHASE_SPECS[advanced_final.phase]
    if (next_spec !== undefined && !TERMINAL_PHASES.has(advanced_final.phase)) {
      let final_state: OnboardingState | null = null
      const emit = await self.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: advanced_final.phase,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await self.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: advanced_final.phase,
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state = (await self.deps.stateStore.get(input.project_slug, input.user_id)) ?? advanced_final
      }
      return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
    }
    return { outcome: 'advanced', state: advanced_final }
  }

export async function pollImportRunningAndAdvance(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    /**
     * S12 (2026-05-16) — when true, the in-progress branch (queued /
     * pass1-running / pass2-running / rate_limit_cooling_off /
     * rate_limit_paused pre-hard-timeout) returns without re-emitting
     * the live status body. Used by the cron-tick caller
     * (`pollImportRunningTick`) so periodic polling does not spam the
     * channel with a fresh "Reading through your export…" body every
     * 5 s. Terminal branches (completed / failed / cancelled /
     * hard-timeout) still fire normally so the user sees the advance +
     * analysis prompt the moment Pass-1+Pass-2 finishes.
     */
    opts?: { suppress_in_progress_status_emit?: boolean },
  ): Promise<AdvanceResult> {
    const job_id = readString(state.phase_state, 'import_job_id')
    const source = readImportSource(state.phase_state, 'import_source')
    if (self.deps.importJobRunner === undefined || job_id === null) {
      // Defensive — caller should already have routed unwired instances
      // into `advanceFromAiSubstrateOffered`. If we land here anyway, do the
      // safe thing: collapse to the skip path.
      return await self.advanceFromAiSubstrateOffered(input, state, observed_at, {
        skipped: true,
        source: null,
        job_id: null,
      })
    }
    let job: ImportJob | null
    try {
      job = await self.deps.importJobRunner.status(job_id)
    } catch (err) {
      self.deps.transcript.append({
        role: 'system',
        body: `import: runner.status threw for job=${job_id}: ${err instanceof Error ? err.message : String(err)}`,
        phase: state.phase,
      })
      return await self.emitImportRunningPromptSpec(input, state, observed_at, {
        sub_step: 'failed',
        source,
        failure_reason: err instanceof Error ? err.message : 'unknown',
      })
    }
    if (job === null) {
      // The runner has no record of this job — treat as a hard failure
      // so the user can retry or skip.
      return await self.emitImportRunningPromptSpec(input, state, observed_at, {
        sub_step: 'failed',
        source,
        failure_reason: 'job not found',
      })
    }

    // Argus r1 fix (PR #271, 2026-05-22) — auto-resume from
    // rate_limit_paused once the COOLDOWN_AFTER_PAUSED_MS window elapses.
    // Without this hook the runner's "I'll keep checking and resume as
    // soon as the limit lifts" body is a lie: nothing else checks. With
    // it, the engine's existing cron tick (5 s cadence) doubles as the
    // resume trigger and the user stays in import_running with a moving
    // progress bubble instead of getting stranded forever.
    //
    // Best-effort: any failure (missing resolver, runner.start throws,
    // resolver returns null) falls through to the paused-body branch
    // below. The cron will retry on the next tick — same behavior as a
    // transient resolver failure on first kickoff.
    if (job.status === 'rate_limit_paused' && source !== null) {
      const last_paused_at = job.last_paused_at ?? 0
      const since_pause = observed_at - last_paused_at
      // A row with no `last_paused_at` (pre-migration-0041) collapses to
      // since_pause === observed_at, which is always >> cooldown — the
      // intended "resume legacy paused rows on the next tick" semantics.
      if (since_pause >= COOLDOWN_AFTER_PAUSED_MS) {
        // ISSUES #91 — ceiling on the auto-resume loop. Without this the
        // engine resumes a perpetually-rate-limited import every cooldown
        // window forever (unbounded `runner.start` dispatches), stranding
        // the user in the "still waiting" body indefinitely. The counter is
        // incremented (or reset on forward Pass-1 progress) inside
        // `attemptAutoResumeFromPaused`. Once we've burned
        // MAX_RATE_LIMIT_RESUME_CYCLES consecutive no-progress cycles the
        // rate limit is genuinely saturated → stop looping and degrade
        // gracefully, salvaging whatever Pass-1 signal reached the cache.
        const resume_count =
          readNumber(state.phase_state, 'import_rate_limit_resume_count') ?? 0
        if (resume_count >= MAX_RATE_LIMIT_RESUME_CYCLES) {
          return await self.degradeRateLimitExhausted(
            input,
            state,
            observed_at,
            job_id,
            job,
            resume_count,
          )
        }
        const resumed = await self.attemptAutoResumeFromPaused(
          input,
          state,
          observed_at,
          source,
          job_id,
          job,
        )
        if (resumed !== null) {
          return await self.pollImportRunningAndAdvance(
            input,
            resumed.state,
            observed_at,
            opts,
          )
        }
      }
    }

    if (job.status === 'completed') {
      return await self.advanceFromImportRunningOnComplete(
        input,
        state,
        observed_at,
        job.result ?? null,
        /*partial*/ job.partial === true,
      )
    }
    if (job.status === 'cancelled') {
      // 2026-05-27 — cancelled is a terminal status with no synthesis
      // result, same shape as `failed`. Pre-fix this branch advanced via
      // `advanceFromAiSubstrateOffered` whose target is
      // `work_interview_gap_fill`, which is NOT a legal transition from
      // `import_running` (see phase.ts:LEGAL_TRANSITIONS — only
      // `import_analysis_presented` and `failed` are reachable). The
      // cron tick threw `illegal_transition` every 5 s, stranding the
      // user. Route through the SAME helper as the `failed` branch so
      // the user lands on `import_analysis_presented` with the graceful
      // "couldn't analyze" framing; the user's first reply then routes
      // into `work_interview_gap_fill` via the legal
      // `import_analysis_presented → work_interview_gap_fill` edge.
      return await self.advanceFromImportRunningOnComplete(
        input,
        state,
        observed_at,
        /*import_result*/ null,
        /*partial*/ false,
        /*failure_reason*/ job.error_message ?? job.error_code ?? 'cancelled',
      )
    }
    if (job.status === 'failed') {
      // S14 (2026-05-17) — Pass-1/Pass-2 errored. Per § 3.6 the failed
      // status MUST advance to `import_analysis_presented` with
      // `import_failed=true` so the body emits the graceful "couldn't
      // analyze" framing and the user's reply routes into
      // `work_interview_gap_fill`. Mirrors the hard-timeout backstop
      // below: same handler, same partial=false, failure_reason carries
      // the runner's error string for telemetry. The legacy retry/skip
      // button UX has been retired — stranding the user on
      // `import_running` waiting for a button tap blocked the live
      // walkthrough whenever Opus rate-limited Pass-2 (Bug C from S13).
      return await self.advanceFromImportRunningOnComplete(
        input,
        state,
        observed_at,
        /*import_result*/ null,
        /*partial*/ false,
        /*failure_reason*/ job.error_message ?? job.error_code ?? 'unknown',
      )
    }
    // P2 v2 S5 — hard timeout backstop. The runner is `queued` /
    // `pass1-running` / `pass2-running` but the job has been running
    // longer than its computed budget. Force-advance to
    // `import_analysis_presented` with either `import_partial=true`
    // (when Pass-1 progress >= IMPORT_PARTIAL_THRESHOLD) or
    // `import_failed=true` (the graceful "couldn't analyze" framing)
    // so the user's reply routes into `work_interview_gap_fill`.
    //
    // v0.1.78 (2026-05-22) — SKIP the hard-timeout for rate_limit_*
    // statuses. Per Sam-decisions: "No automatic fallback to gap_fill"
    // when the runner is sitting in the 429-backoff window. The user
    // sees the quieter "still waiting on rate limit" body and the
    // engine keeps polling until the runner resumes (cooling_off →
    // pass*-running on retry success) OR the user manually skips by
    // typing freeform.
    //
    // 2026-06-18 (import-timeout-progress-aware sprint) — the firing
    // condition is now PROGRESS-AWARE (`evaluateImportTimeout`), NOT a flat
    // wall-clock cap. The deadline RESETS on forward progress (anchor below);
    // the silent consolidate phase gets a generous window; a 30-min floor +
    // 4h ceiling bound it. Replaces the 2026-05-25 dynamic
    // `computeImportHardTimeoutMs(job)` budget (which still guillotined the
    // owner's 100%-read import the instant it entered consolidate). When the
    // timeout DOES fire:
    //   - attempt partial synthesis from
    //     cached Pass-1 rows BEFORE declaring total failure. Surfaces
    //     real signal to the user on long imports that completed >25 %
    //     of Pass-1 before the deadline.
    //   - Call `runner.cancel(job_id)` so the runner's per-chunk
    //     `isCancelled` poll observes the cancel and stops launching
    //     fresh LLM calls. Pre-sprint the runner kept burning money
    //     for minutes after the engine had already declared failure
    //     (Sam's 2026-05-25 export: $0.27 wasted post-timeout).
    //
    // Guard: only fire when `started_at` is a real wall-clock timestamp.
    const elapsed =
      job.started_at > 0 && observed_at > job.started_at
        ? observed_at - job.started_at
        : 0
    const isRateLimitState =
      job.status === 'rate_limit_cooling_off' || job.status === 'rate_limit_paused'

    // 2026-06-18 (import-timeout-progress-aware) — PROGRESS-AWARE deadline.
    // Track the last forward-progress wall-clock as an anchor in phase_state
    // and RESET it whenever the job advances: `pass1_chunks_done` increased,
    // `status` changed (queued→pass1-running, entering/leaving rate-limit, or
    // reaching consolidate), or `dollars_spent` rose (API-key path). A slow-
    // but-progressing import keeps extending its own deadline, so a real
    // export is never guillotined mid-flight (the owner's 2026-06-18 failure:
    // pass1 100% then consolidate, killed by the flat 15-min cap). Mirrors the
    // existing `import_rate_limit_progress_mark` pattern.
    const priorProgressMark = readNumber(state.phase_state, 'import_progress_mark')
    const priorStatusMark = readString(state.phase_state, 'import_progress_status_mark')
    const priorDollarsMark = readNumber(state.phase_state, 'import_progress_dollars_mark')
    const priorAnchorAt = readNumber(state.phase_state, 'import_progress_anchor_at')
    const madeForwardProgress =
      (priorProgressMark !== null && job.pass1_chunks_done > priorProgressMark) ||
      (priorStatusMark !== null && job.status !== priorStatusMark) ||
      (priorDollarsMark !== null && job.dollars_spent > priorDollarsMark)
    const anchorUninitialized = priorAnchorAt === null
    const progressAnchorAt =
      anchorUninitialized || madeForwardProgress ? observed_at : priorAnchorAt
    if (anchorUninitialized || madeForwardProgress) {
      // Persist the refreshed anchor + monotonic marks. Bounded writes: only
      // on genuine progress events (read-pass completion, ~every 30-120s) or
      // the first poll — never on every silent 5s cron tick. Mirrors
      // `attemptAutoResumeFromPaused`'s phase_state_patch upsert shape.
      state = await self.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'import_running',
        phase_state_patch: {
          import_progress_mark: Math.max(priorProgressMark ?? -1, job.pass1_chunks_done),
          import_progress_status_mark: job.status,
          import_progress_dollars_mark: Math.max(priorDollarsMark ?? -1, job.dollars_spent),
          import_progress_anchor_at: progressAnchorAt,
        },
        advanced_at: observed_at,
      })
    }

    const timeoutDecision = evaluateImportTimeout({
      observed_at,
      started_at: job.started_at,
      progress_anchor_at: progressAnchorAt,
      pass1_chunks_done: job.pass1_chunks_done,
      pass1_chunks_total: job.pass1_chunks_total,
      status: job.status,
    })
    if (timeoutDecision.fire) {
      const pass1_pct =
        job.pass1_chunks_total > 0
          ? job.pass1_chunks_done / job.pass1_chunks_total
          : 0
      const elapsed_min = Math.round(elapsed / 60_000)
      const window_min = Math.round(timeoutDecision.window_ms / 60_000)
      const no_progress_min = Math.round(
        Math.max(0, observed_at - progressAnchorAt) / 60_000,
      )
      let partialResult: ImportResult | null = null
      // 2026-06-01 (Codex r2 P2) — capture the pre-cancel status. If the
      // job was already in `pass2-running`, the original runner's Pass-2
      // call is in flight (and its spend is unavoidable; cancel() can't
      // abort the subprocess). In that state we must NOT fire a SECOND
      // real Pass-2 over the same cached rows — synthesizeOnDemand is
      // told to prefer the cheap degraded-from-cache path instead.
      const wasPass2Running = job.status === 'pass2-running'
      // 2026-06-01 (Codex r1 P1) — cancel the runner FIRST, BEFORE the
      // on-demand synthesis. `synthesizeOnDemand` now runs a real Pass-2
      // LLM call; if we synthesized first, the original runner's
      // still-live Pass-1 workers would keep launching fresh LLM calls
      // for the whole duration of that Pass-2 round-trip — reintroducing
      // exactly the post-timeout money-burn this backstop exists to stop
      // (Sam's 2026-05-25 $0.27 incident). Cancelling first flips
      // `import_jobs.status='cancelled'` so the per-chunk isCancelled()
      // poll halts the drain within one chunk; the finalized Pass-1
      // chunks stay in cache for `synthesizeOnDemand` to read. We do NOT
      // await the runner's `run()` promise; the row update is enough to
      // break the loop. `synthesizeOnDemand` is intentionally cancel-
      // tolerant (a single direct Pass-2 attempt, no `retryWith429`
      // short-circuit) so it still salvages the cache after the cancel.
      if (self.deps.importJobRunner !== undefined) {
        try {
          await self.deps.importJobRunner.cancel(job_id)
        } catch (err) {
          self.deps.transcript.append({
            role: 'system',
            body:
              `import: hard-timeout cancel threw for job=${job_id}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
            phase: state.phase,
          })
        }
      }
      if (
        pass1_pct >= IMPORT_PARTIAL_THRESHOLD &&
        self.deps.importJobRunner !== undefined
      ) {
        try {
          partialResult = await self.deps.importJobRunner.synthesizeOnDemand(
            job_id,
            { preferDegraded: wasPass2Running },
          )
        } catch (err) {
          self.deps.transcript.append({
            role: 'system',
            body:
              `import: hard-timeout synthesizeOnDemand threw for job=${job_id}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
            phase: state.phase,
          })
        }
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[engine] hard-timeout fired job=${job_id} reason=${timeoutDecision.reason} ` +
          `elapsed=${elapsed_min}m no_progress=${no_progress_min}m window=${window_min}m ` +
          `in_consolidate=${timeoutDecision.in_consolidate} ` +
          `chunks_done=${job.pass1_chunks_done}/${job.pass1_chunks_total} ` +
          `pass1_pct=${(pass1_pct * 100).toFixed(0)}% ` +
          `dollars_spent=$${job.dollars_spent.toFixed(2)}; ` +
          `partial=${partialResult !== null ? 'yes' : 'no'}; cancelling runner.`,
      )
      if (partialResult !== null) {
        return await self.advanceFromImportRunningOnComplete(
          input,
          state,
          observed_at,
          partialResult,
          /*partial*/ true,
          /*failure_reason*/ null,
        )
      }
      return await self.advanceFromImportRunningOnComplete(
        input,
        state,
        observed_at,
        /*import_result*/ null,
        /*partial*/ false,
        /*failure_reason*/ `import timed out after ${elapsed_min} minutes (${timeoutDecision.reason})`,
      )
    }
    // S12 (2026-05-16) — cron-tick callers ask for a silent in-progress
    // poll. The terminal branches above (completed / failed /
    // cancelled / hard-timeout) have already returned; we only reach
    // this point with the runner still in flight (including
    // rate_limit_cooling_off / rate_limit_paused). Skip the prompt
    // re-emit so the periodic cron does not spam a fresh "Reading
    // through your export…" body every tick.
    //
    // 2026-05-21 (Bug 1, v0.1.75) — emit a UI-only `import_progress`
    // envelope on each cron tick so the client renders a live progress
    // indicator below the import_running prompt. The envelope is fire-
    // and-forget — it does NOT touch `button_prompts.delivered_at`,
    // `transcript.jsonl`, or any audit state (preserving S16 invariants).
    // When `sendImportProgress` is unwired (legacy composer / unit tests
    // without progress assertions), the emit silently no-ops.
    if (opts?.suppress_in_progress_status_emit === true) {
      if (self.deps.sendImportProgress !== undefined) {
        // v0.1.78 (2026-05-22) — derive pass + body from job.status,
        // expanding to cover the new rate_limit_cooling_off and
        // rate_limit_paused branches. Pass 1 covers queued + pass1-running;
        // anything beyond Pass-1 (pass2-running) is "pass 2". The rate-
        // limit statuses carry forward whichever pass last persisted
        // (we can't tell without an explicit column, so default to the
        // pass we'd otherwise be in based on chunks_done).
        const isPass2Phase =
          job.status === 'pass2-running' ||
          (isRateLimitState &&
            job.chunks_total_known &&
            job.pass1_chunks_total > 0 &&
            job.pass1_chunks_done >= job.pass1_chunks_total)
        const pass: 1 | 2 = isPass2Phase ? 2 : 1
        const knownTotal = job.chunks_total_known
        const pass1_pct = knownTotal
          ? job.pass1_chunks_done / Math.max(job.pass1_chunks_total, 1)
          : 0
        const pass2_pct = (() => {
          const since_start = elapsed
          return Math.min(0.95, Math.max(0, since_start / PASS2_EXPECTED_DURATION_MS))
        })()
        const pct = pass === 2 ? pass2_pct : pass1_pct
        const sourceLabel =
          source === 'chatgpt-zip'
            ? 'ChatGPT'
            : source === 'claude-zip'
              ? 'Claude'
              : source === 'gmail-oauth'
                ? 'Gmail'
                : source === 'calendar-oauth'
                  ? 'Calendar'
                  : source ?? 'your history'
        // v0.1.78 — three body shapes overlay the normal pass1/pass2 bubble:
        //   1. rate_limit_cooling_off — "rate limit cooling off, resuming"
        //   2. rate_limit_paused — "still waiting on rate limit"
        //   3. default (running) — pass1/pass2 progress as before
        //
        // 2026-05-31 — Pass 1 default body gets an ETA suffix once we
        // have >=3 chunks done AND chunks_total_known is true. Below
        // 3 chunks the per-chunk time estimate is too noisy (cold-start
        // CC subprocess spin-up dominates); above that the linear
        // extrapolation `(elapsed / done) * remaining` lands within
        // ~20% of reality on the parallel pool. Edge bodies:
        //   - eta_remaining_min <= 1 && chunks_remaining <= 1 → "almost done"
        //   - eta_remaining_min === 1 → "~1 min remaining"
        //   - eta_remaining_min >= 2 → "~N min remaining"
        //
        // Argus r1 (2026-05-31) — pre-fix the `<= 0` gate only fired
        // when `elapsedMs === 0` (clock skew / same-tick poll) because
        // `Math.ceil` of any positive number is `>= 1`. The realistic
        // last-mile "almost done" case (1 chunk left + sub-minute
        // remaining) was therefore dead code. The widened gate fires
        // when we're genuinely on the last chunk AND expect under a
        // minute of wall-clock so the UX is honest.
        // No ETA at all when chunks_done < 3 OR knownTotal=false OR
        // (rate_limit_cooling_off / rate_limit_paused) — those statuses
        // already carry their own time-context language.
        let body: string
        if (job.status === 'rate_limit_cooling_off') {
          body =
            `Pass ${pass}: Claude rate limit cooling off on your ${sourceLabel} — resuming shortly.`
        } else if (job.status === 'rate_limit_paused') {
          body =
            `Pass ${pass}: Claude rate limit on your ${sourceLabel} — auto-resuming shortly. ` +
            `Cached work is safe.`
        } else {
          const baseBody =
            pass === 1
              ? knownTotal
                ? `Pass 1: ${job.pass1_chunks_done}/${job.pass1_chunks_total} batches`
                : job.pass1_chunks_done > 0
                  ? `Pass 1: ${job.pass1_chunks_done} batches processed`
                  : `Pass 1: scanning ${sourceLabel}`
              : knownTotal
                ? `Pass 2: synthesizing from ${Math.max(job.pass1_chunks_total, job.pass1_chunks_done)} batches`
                : `Pass 2: synthesizing your personality`
          let etaSuffix = ''
          if (
            pass === 1 &&
            knownTotal &&
            job.pass1_chunks_done >= 3 &&
            job.pass1_chunks_total > job.pass1_chunks_done
          ) {
            const chunksDone = job.pass1_chunks_done
            const chunksRemaining = job.pass1_chunks_total - chunksDone
            const elapsedMs = Math.max(0, Date.now() - job.started_at)
            const minutesPerChunk = elapsedMs / chunksDone / 60_000
            const etaRemainingMin = Math.ceil(minutesPerChunk * chunksRemaining)
            if (etaRemainingMin <= 1 && chunksRemaining <= 1) {
              etaSuffix = ' · almost done'
            } else if (etaRemainingMin === 1) {
              etaSuffix = ' · ~1 min remaining'
            } else {
              etaSuffix = ` · ~${etaRemainingMin} min remaining`
            }
          }
          body = baseBody + etaSuffix
        }
        // 2026-05-26 (Sam-specced) — the v0.1.85 one-time "Running on
        // Max subscription — chunking smaller …" notice was removed:
        // chunk-size strategy is backend infrastructure, not something
        // the user needs to see. The `chunk_target_tokens` field is
        // still read elsewhere (e.g. to gate hard-timeout budgets), so
        // we don't strip the underlying flag — just stop surfacing
        // body copy from it.
        try {
          await self.deps.sendImportProgress({
            project_slug: input.project_slug,
            topic_id: input.topic_id,
            event: {
              type: 'import_progress',
              job_id,
              status: job.status,
              pass,
              pct,
              chunks_total_known: knownTotal,
              body,
            },
          })
        } catch (err) {
          // Best-effort — the next 5 s tick will retry. Don't bubble.
          console.warn(
            `[engine.import-progress] event=send-failed project=${input.project_slug} topic=${input.topic_id} job=${job_id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
      return {
        outcome: 'no_active_prompt',
        state,
        ...(readString(state.phase_state, 'active_prompt_id') !== null
          ? { prompt_id: readString(state.phase_state, 'active_prompt_id') as string }
          : {}),
      }
    }
    // queued / pass1-running / pass2-running / rate_limit_* — emit live
    // status body. The builder selects between status (cooling-off or
    // long-running variant) and rate_limit_paused based on the supplied
    // flags. Only `pass1_chunks_total` is surfaced when chunks_total_known
    // is true so streaming-fallback mode doesn't render a "5/5" denominator
    // that grows alongside the numerator.
    const soft_elapsed_breached = elapsed > IMPORT_RUNNING_SOFT_TIMEOUT_MS
    if (job.status === 'rate_limit_paused') {
      const pausedOpts: {
        sub_step: 'rate_limit_paused'
        source: ImportSource | null
        pass1_chunks_done: number
        pass1_chunks_total?: number
      } = {
        sub_step: 'rate_limit_paused',
        source,
        pass1_chunks_done: job.pass1_chunks_done,
      }
      if (job.chunks_total_known) {
        pausedOpts.pass1_chunks_total = job.pass1_chunks_total
      }
      return await self.emitImportRunningPromptSpec(input, state, observed_at, pausedOpts)
    }
    const specOpts: {
      sub_step: 'status'
      source: ImportSource | null
      pass1_chunks_done: number
      pass1_chunks_total?: number
      is_long_running: boolean
      is_rate_limit_cooling_off?: boolean
      using_max_oauth_chunking?: boolean
    } = {
      sub_step: 'status',
      source,
      pass1_chunks_done: job.pass1_chunks_done,
      is_long_running: soft_elapsed_breached,
    }
    if (job.status === 'rate_limit_cooling_off') {
      specOpts.is_rate_limit_cooling_off = true
    }
    if (job.chunks_total_known) {
      specOpts.pass1_chunks_total = job.pass1_chunks_total
    }
    if (job.chunk_target_tokens === MAX_OAUTH_CHUNK_TARGET_TOKENS) {
      specOpts.using_max_oauth_chunking = true
    }
    return await self.emitImportRunningPromptSpec(input, state, observed_at, specOpts)
  }

export async function attemptAutoResumeFromPaused(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
    prior_job_id: string,
    prior_job: ImportJob | null,
    opts: { reset_cycle_counter?: boolean } = {},
  ): Promise<{ state: OnboardingState } | null> {
    if (
      self.deps.importJobRunner === undefined ||
      self.deps.importPayloadResolver === undefined
    ) {
      return null
    }
    let payload: ChunkerInput | null = null
    try {
      payload = await self.deps.importPayloadResolver.resolve({
        project_slug: input.project_slug,
        user_id: input.user_id,
        source,
      })
    } catch (err) {
      self.deps.transcript.append({
        role: 'system',
        body: `import: auto-resume resolver threw for prior_job=${prior_job_id} source=${source}: ${err instanceof Error ? err.message : String(err)}`,
        phase: state.phase,
      })
      return null
    }
    if (payload === null) {
      self.deps.transcript.append({
        role: 'system',
        body: `import: auto-resume resolver returned null for prior_job=${prior_job_id} source=${source}; cron will retry next tick`,
        phase: state.phase,
      })
      return null
    }
    let new_job_id: string
    try {
      const r = await self.deps.importJobRunner.start({
        project_slug: self.secretsIdentity(input.project_slug),
        user_id: input.user_id,
        source,
        payload,
      })
      new_job_id = r.job_id
    } catch (err) {
      self.deps.transcript.append({
        role: 'system',
        body: `import: auto-resume runner.start threw for prior_job=${prior_job_id} source=${source}: ${err instanceof Error ? err.message : String(err)}`,
        phase: state.phase,
      })
      return null
    }
    // ISSUES #91 — progress-aware resume-cycle accounting. Track how many
    // CONSECUTIVE resume cycles made no forward Pass-1 progress. The mark is
    // the highest `pass1_chunks_done` we've observed across cycles; a cycle
    // that advanced past the mark resets the counter (a genuinely-progressing
    // large export must never be capped). Only when the same cache plateau
    // persists across MAX_RATE_LIMIT_RESUME_CYCLES cycles do we conclude the
    // rate limit is saturated and stop looping (the ceiling check in
    // `pollImportRunningAndAdvance` reads `import_rate_limit_resume_count`).
    //
    // A user-initiated manual resume (the "Resume analysis" button) passes
    // `reset_cycle_counter` so the explicit retry gets a fresh budget rather
    // than immediately re-degrading against a counter the cron loop ran up.
    const prior_count =
      readNumber(state.phase_state, 'import_rate_limit_resume_count') ?? 0
    const prior_mark =
      readNumber(state.phase_state, 'import_rate_limit_progress_mark') ?? -1
    const chunks_done = prior_job?.pass1_chunks_done ?? prior_mark
    const made_progress = chunks_done > prior_mark
    const next_count = opts.reset_cycle_counter === true
      ? 0
      : made_progress
        ? 0
        : prior_count + 1
    const next_mark = Math.max(prior_mark, chunks_done)
    self.deps.transcript.append({
      role: 'system',
      body: `import: auto-resume started new_job=${new_job_id} (prior_job=${prior_job_id}) source=${source} resume_cycle=${next_count}/${MAX_RATE_LIMIT_RESUME_CYCLES} progress_mark=${next_mark}`,
      phase: state.phase,
    })
    const next_state = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'import_running',
      phase_state_patch: {
        import_job_id: new_job_id,
        import_rate_limit_resume_count: next_count,
        import_rate_limit_progress_mark: next_mark,
      },
      advanced_at: observed_at,
    })
    return { state: next_state }
  }

export async function degradeRateLimitExhausted(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    job_id: string,
    job: ImportJob,
    resume_count: number,
  ): Promise<AdvanceResult> {
    let partialResult: ImportResult | null = null
    if (self.deps.importJobRunner !== undefined) {
      try {
        await self.deps.importJobRunner.cancel(job_id)
      } catch (err) {
        self.deps.transcript.append({
          role: 'system',
          body: `import: rate-limit-exhausted cancel threw for job=${job_id}: ${err instanceof Error ? err.message : String(err)}`,
          phase: state.phase,
        })
      }
      try {
        partialResult = await self.deps.importJobRunner.synthesizeOnDemand(
          job_id,
          { preferDegraded: true },
        )
      } catch (err) {
        self.deps.transcript.append({
          role: 'system',
          body: `import: rate-limit-exhausted synthesizeOnDemand threw for job=${job_id}: ${err instanceof Error ? err.message : String(err)}`,
          phase: state.phase,
        })
      }
    }
    const has_signal = partialResult !== null && importResultHasSignal(partialResult)
    // eslint-disable-next-line no-console
    console.warn(
      `[engine] rate-limit-exhausted give-up job=${job_id} ` +
        `resume_cycles=${resume_count} ` +
        `chunks_done=${job.pass1_chunks_done}/${job.pass1_chunks_total} ` +
        `dollars_spent=$${job.dollars_spent.toFixed(2)}; ` +
        `salvaged=${has_signal ? 'partial' : 'none'}.`,
    )
    if (has_signal) {
      return await self.advanceFromImportRunningOnComplete(
        input,
        state,
        observed_at,
        partialResult,
        /*partial*/ true,
        /*failure_reason*/ null,
      )
    }
    return await self.advanceFromImportRunningOnComplete(
      input,
      state,
      observed_at,
      /*import_result*/ null,
      /*partial*/ false,
      /*failure_reason*/ `rate_limit_exhausted: ${resume_count} resume cycles made no Pass-1 progress ` +
        `(chunks_done=${job.pass1_chunks_done}/${job.pass1_chunks_total})`,
    )
  }

export async function advanceFromImportRunningOnComplete(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    import_result: ImportResult | null,
    partial: boolean,
    failure_reason: string | null = null,
  ): Promise<AdvanceResult> {
    const next_phase: OnboardingPhase = 'import_analysis_presented'
    if (!isLegalTransition(state.phase, next_phase)) {
      throw new InterviewError(
        state.phase,
        'illegal_transition',
        false,
        `import: illegal transition ${state.phase} → ${next_phase}`,
      )
    }
    // P2 v2 S5 — populate the required-fields-audit slots verbatim
    // from the import result so the audit at the next advance turn
    // sees what we collected. We only seed these when the import
    // surfaced something — if the LLM proposed zero projects /
    // interests, the audit reports them missing and the engine routes
    // into `work_interview_gap_fill` to ask for them.
    //
    // 2026-05-25 (import-pipeline-resilience sprint, Part G.2) — preserve
    // `last_import_job_id` on the advance so the readiness probe can
    // later ask "is this job resumable?" even after `import_job_id`
    // is nulled by the failed/timeout path. The probe needs a job_id
    // to query `import_jobs.status` + `import_pass1_chunks`.
    const prior_import_job_id =
      typeof state.phase_state['import_job_id'] === 'string'
        ? (state.phase_state['import_job_id'] as string)
        : null
    const phase_state_patch: Record<string, unknown> = {
      active_prompt_id: null,
      import_result,
      import_partial: partial,
      import_failure_reason: failure_reason,
      import_failed: failure_reason !== null,
      archetype_hint: null,
      ...(prior_import_job_id !== null
        ? { last_import_job_id: prior_import_job_id }
        : {}),
    }
    if (import_result !== null) {
      const project_names = import_result.proposed_projects
        .map((p) => p.name)
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      if (project_names.length > 0) {
        // Merge with anything signup might have left here (always
        // empty at this point in v2, but defensive — gap_fill might
        // later seed entries we don't want to clobber on a re-import).
        const prior = Array.isArray(state.phase_state['primary_projects'])
          ? (state.phase_state['primary_projects'] as ReadonlyArray<unknown>).filter(
              (s): s is string => typeof s === 'string' && s.trim().length > 0,
            )
          : []
        const merged = dedupeStringsCaseInsensitive([...prior, ...project_names])
        phase_state_patch['primary_projects'] = merged
      }
      const interests = (import_result.inferred_interests ?? []).filter(
        (i): i is { name: string; basis?: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' } =>
          typeof i === 'object' && i !== null && typeof i.name === 'string' && i.name.trim().length > 0,
      )
      if (interests.length > 0) {
        phase_state_patch['non_work_interests'] = interests
      }
    }
    const advanced = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: next_phase,
      phase_state_patch,
      advanced_at: observed_at,
    })
    let advanced_final = AUTO_SKIP_PHASES.has(next_phase)
      ? await self.walkAutoSkip(input.project_slug, advanced, observed_at)
      : advanced
    const next_spec = STATIC_PHASE_SPECS[advanced_final.phase]
    if (next_spec !== undefined && !TERMINAL_PHASES.has(advanced_final.phase)) {
      let final_state: OnboardingState | null = null
      const emit = await self.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: advanced_final.phase,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await self.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: advanced_final.phase,
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state = (await self.deps.stateStore.get(input.project_slug, input.user_id)) ?? advanced_final
      }
      return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
    }
    return { outcome: 'advanced', state: advanced_final }
  }

export async function consumeImportAnalysisPresentedChoice(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    // 2026-05-25 (import-pipeline-resilience sprint, Part G.2) —
    // intercept the `resume_import` button BEFORE the correction-
    // capture / required-fields-audit path. The button re-arms the
    // import pipeline via the same `attemptAutoResumeFromPaused`
    // helper the cron-driven auto-resume uses (creates a fresh
    // `import_jobs` row, flips state back to `import_running`, the
    // existing cron tick re-advances on completion). When the
    // resume succeeds the engine emits the import_running progress
    // body so the user sees an immediate "picking back up" frame.
    // On any failure (probe says not resumable, payload resolver
    // returns null, runner.start throws) the handler falls through
    // to the legacy correction path so the user keeps progressing.
    if (
      choice.choice_value === IMPORT_RESUME_CHOICE_VALUE &&
      self.deps.importJobRunner !== undefined
    ) {
      const source = readImportSource(state.phase_state, 'import_source')
      const prior_job_id =
        readString(state.phase_state, 'import_job_id') ??
        readString(state.phase_state, 'last_import_job_id')
      if (source !== null && prior_job_id !== null) {
        if (was_new) {
          self.deps.transcript.append({
            role: 'user',
            body: 'Resume analysis',
            phase: state.phase,
            button_prompt_id: choice.prompt_id,
            button_choice: choice.choice_value,
          })
        }
        // ISSUES #91 — fetch the prior job (best-effort) so the resume-cycle
        // accounting has the latest Pass-1 progress, and reset the counter:
        // this is an explicit user retry, which deserves a fresh budget
        // rather than inheriting the cron loop's exhaustion count.
        let prior_job: ImportJob | null = null
        try {
          prior_job = await self.deps.importJobRunner.status(prior_job_id)
        } catch {
          /* best-effort — resume proceeds without progress accounting */
        }
        const resumed = await self.attemptAutoResumeFromPaused(
          input,
          state,
          observed_at,
          source,
          prior_job_id,
          prior_job,
          { reset_cycle_counter: true },
        )
        if (resumed !== null) {
          // The auto-resume helper has already stitched the new
          // `import_job_id` onto the upserted state with
          // `phase = import_running`. Hand off to the running-poll
          // so the user immediately sees a fresh progress bubble.
          return await self.pollImportRunningAndAdvance(
            input,
            resumed.state,
            observed_at,
          )
        }
        // Best-effort fallthrough — auto-resume failed (e.g. probe
        // returned true at render time but the resolver disagreed),
        // continue into the correction path so the user keeps moving.
      }
    }
    // Pull the user's reply text. Freeform replies carry the body in
    // `freeform_text`; tapped buttons surface their `choice_value`.
    const reply_text =
      choice.choice_value === '__freeform__' &&
      typeof choice.freeform_text === 'string' &&
      choice.freeform_text.trim().length > 0
        ? choice.freeform_text.trim()
        : choice.choice_value
    // Append to transcript on first observation so the gap-fill phase
    // sees the user's reply when it builds its LLM bundle.
    if (was_new) {
      self.deps.transcript.append({
        role: 'user',
        body: reply_text,
        phase: state.phase,
        button_prompt_id: choice.prompt_id,
        button_choice: choice.choice_value,
      })
    }
    // Append (don't replace) — the user may iterate corrections over
    // multiple turns if the engine ever re-emits the body (e.g. on a
    // failed-send retry). Idempotency: we only append on `was_new`.
    const prior_corrections: ReadonlyArray<unknown> = Array.isArray(
      state.phase_state['user_supplied_corrections'],
    )
      ? (state.phase_state['user_supplied_corrections'] as ReadonlyArray<unknown>)
      : []
    const prior_strings = prior_corrections.filter(
      (s): s is string => typeof s === 'string' && s.trim().length > 0,
    )
    const corrections: ReadonlyArray<string> = was_new
      ? [...prior_strings, reply_text]
      : prior_strings

    // Audit. The phase_state hasn't been re-fetched after the
    // upsert below, so we run the audit against a synthetic merged
    // view: persisted phase_state + the pending update we'd apply.
    const audit_state: Record<string, unknown> = {
      ...state.phase_state,
      user_supplied_corrections: corrections,
    }
    const audit = auditRequiredFields(audit_state)
    // Per spec § 2.4: advance to personality_offered when the first
    // three required fields (user_first_name, primary_projects,
    // non_work_interests) are all filled. Those three are the only
    // ones the import + this gap-fill step can produce; the remaining
    // two (agent_personality, agent_name) get collected at later
    // phases. So the "audit clean for the first three" test is
    // "next_to_collect is null OR one of the downstream-collected
    // fields".
    const DOWNSTREAM_FIELDS: ReadonlySet<string> = new Set([
      'agent_personality',
      'agent_name',
    ])
    const required_clean =
      audit.next_to_collect === null || DOWNSTREAM_FIELDS.has(audit.next_to_collect)
    const next_phase: OnboardingPhase = required_clean
      ? 'personality_offered'
      : 'work_interview_gap_fill'

    if (!isLegalTransition(state.phase, next_phase)) {
      throw new InterviewError(
        state.phase,
        'illegal_transition',
        false,
        `import_analysis_presented: illegal transition → ${next_phase}`,
      )
    }
    const phase_state_patch: Record<string, unknown> = {
      active_prompt_id: null,
      user_supplied_corrections: corrections,
      last_choice_value: choice.choice_value,
    }
    if (choice.choice_value === '__freeform__' && typeof choice.freeform_text === 'string') {
      phase_state_patch['last_choice_freeform'] = choice.freeform_text
    }
    const advanced = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: next_phase,
      phase_state_patch,
      advanced_at: observed_at,
    })

    // Emit the next phase's prompt so the user sees the conversation
    // continue. Mirror the standard advance-tail in consumeChoice.
    let advanced_final = AUTO_SKIP_PHASES.has(next_phase)
      ? await self.walkAutoSkip(input.project_slug, advanced, observed_at)
      : advanced
    const next_spec = STATIC_PHASE_SPECS[advanced_final.phase]
    if (next_spec !== undefined && !TERMINAL_PHASES.has(advanced_final.phase)) {
      let final_state: OnboardingState | null = null
      const emit = await self.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: advanced_final.phase,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await self.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: advanced_final.phase,
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state = (await self.deps.stateStore.get(input.project_slug, input.user_id)) ?? advanced_final
      }
      return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
    }
    return { outcome: 'advanced', state: advanced_final }
  }

export async function emitImportRunningPromptSpec(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    opts: {
      sub_step: ImportRunningSubStep
      source: ImportSource | null
      pass1_chunks_done?: number
      pass1_chunks_total?: number
      failure_reason?: string
      is_long_running?: boolean
      is_rate_limit_cooling_off?: boolean
      using_max_oauth_chunking?: boolean
    },
  ): Promise<AdvanceResult> {
    const builderSource: 'chatgpt-zip' | 'claude-zip' | null =
      opts.source === 'chatgpt-zip' || opts.source === 'claude-zip'
        ? opts.source
        : null
    const specInput: Parameters<typeof buildImportRunningPromptSpec>[0] = {
      sub_step: opts.sub_step,
      source: builderSource,
    }
    if (opts.pass1_chunks_done !== undefined) specInput.pass1_chunks_done = opts.pass1_chunks_done
    if (opts.pass1_chunks_total !== undefined) specInput.pass1_chunks_total = opts.pass1_chunks_total
    if (opts.failure_reason !== undefined) specInput.failure_reason = opts.failure_reason
    if (opts.is_long_running === true) specInput.is_long_running = true
    if (opts.is_rate_limit_cooling_off === true) {
      specInput.is_rate_limit_cooling_off = true
    }
    if (opts.using_max_oauth_chunking === true) {
      specInput.using_max_oauth_chunking = true
    }
    const spec = buildImportRunningPromptSpec(specInput)
    const prior_attempts = readNumber(state.phase_state, 'import_running_attempt_count') ?? 0
    const next_attempts = prior_attempts + 1
    const pre_emit_state = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'import_running',
      phase_state_patch: {
        active_prompt_id: null,
        import_running_attempt_count: next_attempts,
        import_running_sub_step: opts.sub_step,
        ...(opts.failure_reason !== undefined ? { import_failure_reason: opts.failure_reason } : {}),
      },
      advanced_at: observed_at,
    })
    const seed = canonicalPromptSeed({
      body: spec.body,
      options: spec.options.map((o) => ({ value: o.value })),
    })
    const idempotency_key = deriveIdempotencyKey({
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      seed: `import_running:${opts.sub_step}:${next_attempts}:${seed}`,
    })
    const prompt = buildButtonPrompt({
      body: spec.body,
      options: spec.options.map((o) => ({ label: o.label, body: o.body, value: o.value })),
      allow_freeform: spec.allow_freeform,
      idempotency_key,
      uuid: self.uuid,
    })
    const emit = await self.deps.buttonStore.emit(prompt, { topic_id: input.topic_id })
    const updated = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'import_running',
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
          'import_running',
          'send_failed',
          true,
          `failed to send import_running ${opts.sub_step} prompt for project=${input.project_slug}`,
          err,
        )
      }
      self.deps.transcript.append({
        role: 'agent',
        body: spec.body,
        phase: 'import_running',
        button_prompt_id: emit.prompt_id,
      })
    }
    return {
      outcome: opts.sub_step === 'status' ? 'reemitted_current' : 'reemitted_current',
      state: updated,
      prompt_id: emit.prompt_id,
    }
  }

export async function consumeImportRunningChoice(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const choice_value = choice.choice_value
    if (was_new) {
      self.deps.transcript.append({
        role: 'user',
        body:
          choice_value === '__freeform__' && choice.freeform_text !== undefined
            ? choice.freeform_text
            : choice_value,
        phase: state.phase,
        button_prompt_id: choice.prompt_id,
        button_choice: choice_value,
      })
    }
    if (NON_ADVANCING_CHOICE_VALUES.has(choice_value)) {
      return { outcome: 'no_active_prompt', state }
    }
    const source = readImportSource(state.phase_state, 'import_source')
    const job_id = readString(state.phase_state, 'import_job_id')
    const sub_step = readString(state.phase_state, 'import_running_sub_step')

    // Freeform text routing depends on sub_step:
    //   - `failed`: treat the freeform as a fresh URL paste, stash it
    //     on phase_state, kick off a new runner.start. This is the
    //     recovery path the failed prompt body advertises.
    //   - status / rate_limit_paused / others: re-poll the runner so
    //     the user sees fresh progress without burning a button row.
    if (choice_value === '__freeform__') {
      if (
        sub_step === 'failed' &&
        source !== null &&
        choice.freeform_text !== undefined &&
        choice.freeform_text.length > 0
      ) {
        const url = choice.freeform_text.trim()
        if (!isValidImportUrl(url)) {
          return await self.emitImportRunningPromptSpec(
            input,
            state,
            observed_at,
            {
              sub_step: 'failed',
              source,
              failure_reason:
                "That doesn't look like a URL — paste a full https://... link, or tap Skip.",
            },
          )
        }
        const url_key = `import_paste_url_${source}`
        const updated = await self.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: 'import_running',
          phase_state_patch: { [url_key]: url, import_failure_reason: null },
          advanced_at: observed_at,
        })
        return await self.retryImportRunning(input, updated, observed_at)
      }
      return await self.pollImportRunningAndAdvance(input, state, observed_at)
    }

    // `failed` shape — retry + skip.
    if (choice_value === IMPORT_RUNNING_RETRY) {
      return await self.retryImportRunning(input, state, observed_at)
    }
    if (choice_value === IMPORT_RUNNING_SKIP) {
      return await self.advanceFromAiSubstrateOffered(input, state, observed_at, {
        skipped: true,
        source,
        job_id,
      })
    }

    // Unknown — keep state at import_running so a follow-up tap can
    // route through this branch again.
    return { outcome: 'no_active_prompt', state }
  }

export async function retryImportRunning(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const source = readImportSource(state.phase_state, 'import_source')
    if (self.deps.importJobRunner === undefined || source === null) {
      return await self.advanceFromAiSubstrateOffered(input, state, observed_at, {
        skipped: true,
        source: null,
        job_id: null,
      })
    }
    // Codex r4 P2 (post-T4) — DO NOT substitute Buffer.alloc(0) when
    // the resolver throws or returns null. That guarantees a parse-
    // failed run and burns budget for no value. Instead, emit a
    // failed-with-clear-reason prompt so the user can paste a fresh
    // URL (freeform reply lands on `phase_state.import_paste_url_*`
    // and the next retry succeeds) OR tap Skip to advance.
    let payload: ChunkerInput | null = null
    if (self.deps.importPayloadResolver !== undefined) {
      try {
        payload = await self.deps.importPayloadResolver.resolve({
          project_slug: input.project_slug,
          user_id: input.user_id,
          source,
        })
      } catch (err) {
        self.deps.transcript.append({
          role: 'system',
          body: `import: payload resolve threw on retry: ${err instanceof Error ? err.message : String(err)}`,
          phase: state.phase,
        })
        payload = null
      }
    }
    if (payload === null) {
      // Codex r4 + r5 P2 (post-T4) — stay at import_running with a
      // failed prompt that accepts a fresh URL paste inline (the
      // prompt's `allow_freeform: true` lets the user paste a new
      // presigned URL; consumeImportRunningChoice's __freeform__
      // branch persists it as `import_paste_url_<source>` and
      // re-attempts).
      return await self.emitImportRunningPromptSpec(
        input,
        state,
        observed_at,
        {
          sub_step: 'failed',
          source,
          failure_reason:
            'I need a fresh export. Paste a new URL below to retry, or tap Skip.',
        },
      )
    }
    let job_id: string
    try {
      const r = await self.deps.importJobRunner.start({
        project_slug: self.secretsIdentity(input.project_slug),
        user_id: input.user_id,
        source,
        payload,
      })
      job_id = r.job_id
    } catch (err) {
      self.deps.transcript.append({
        role: 'system',
        body: `import: runner.start threw on retry: ${err instanceof Error ? err.message : String(err)}`,
        phase: state.phase,
      })
      return await self.emitImportRunningPromptSpec(input, state, observed_at, {
        sub_step: 'failed',
        source,
        failure_reason: err instanceof Error ? err.message : 'unknown',
      })
    }
    const updated = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'import_running',
      phase_state_patch: {
        active_prompt_id: null,
        import_job_id: job_id,
        import_result: null,
        import_partial: null,
        import_failure_reason: null,
        import_running_sub_step: 'status',
      },
      advanced_at: observed_at,
    })
    return await self.pollImportRunningAndAdvance(input, updated, observed_at)
  }

export async function startImportAndAdvanceToRunning(
  self: EngineInternals,
    advanceInput: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    effectiveSource: 'chatgpt' | 'claude',
  ): Promise<AdvanceResult> {
    const runnerSource: ImportSource =
      effectiveSource === 'chatgpt' ? 'chatgpt-zip' : 'claude-zip'

    if (self.deps.importJobRunner === undefined) {
      self.deps.transcript.append({
        role: 'system',
        body: `import: notifyImportUpload received source=${effectiveSource} but importJobRunner is unwired; surfacing failed sub_step`,
        phase: state.phase,
      })
      return await self.advanceToImportRunningFailed(
        advanceInput,
        state,
        observed_at,
        runnerSource,
        'import-runner unavailable',
      )
    }

    let payload: ChunkerInput | null = null
    if (self.deps.importPayloadResolver !== undefined) {
      try {
        payload = await self.deps.importPayloadResolver.resolve({
          project_slug: advanceInput.project_slug,
          user_id: advanceInput.user_id,
          source: runnerSource,
        })
      } catch (err) {
        self.deps.transcript.append({
          role: 'system',
          body: `import: notifyImportUpload resolver threw: ${err instanceof Error ? err.message : String(err)}`,
          phase: state.phase,
        })
        payload = null
      }
    }
    if (payload === null) {
      self.deps.transcript.append({
        role: 'system',
        body: `import: notifyImportUpload could not resolve payload for source=${effectiveSource}; surfacing failed sub_step`,
        phase: state.phase,
      })
      return await self.advanceToImportRunningFailed(
        advanceInput,
        state,
        observed_at,
        runnerSource,
        'upload payload not found on disk',
      )
    }

    let job_id: string
    try {
      const r = await self.deps.importJobRunner.start({
        project_slug: self.secretsIdentity(advanceInput.project_slug),
        user_id: advanceInput.user_id,
        source: runnerSource,
        payload,
      })
      job_id = r.job_id
    } catch (err) {
      const failure_reason = err instanceof Error ? err.message : String(err)
      self.deps.transcript.append({
        role: 'system',
        body: `import: notifyImportUpload runner.start threw: ${failure_reason}`,
        phase: state.phase,
      })
      return await self.advanceToImportRunningFailed(
        advanceInput,
        state,
        observed_at,
        runnerSource,
        failure_reason,
      )
    }

    self.deps.transcript.append({
      role: 'system',
      body: `import: notifyImportUpload started job=${job_id} source=${runnerSource}`,
      phase: state.phase,
    })

    const advanced = await self.deps.stateStore.upsert({
      project_slug: advanceInput.project_slug,
      user_id: advanceInput.user_id,
      phase: 'import_running',
      phase_state_patch: {
        active_prompt_id: null,
        import_job_id: job_id,
        import_source: runnerSource,
        import_result: null,
        import_skip_reason: null,
        import_failure_reason: null,
      },
      advanced_at: observed_at,
    })
    return await self.pollImportRunningAndAdvance(advanceInput, advanced, observed_at)
  }

export async function advanceToImportRunningFailed(
  self: EngineInternals,
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
    failure_reason: string,
  ): Promise<AdvanceResult> {
    const advanced = await self.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'import_running',
      phase_state_patch: {
        active_prompt_id: null,
        import_job_id: null,
        import_source: source,
        import_result: null,
        import_skip_reason: null,
        import_failure_reason: failure_reason,
      },
      advanced_at: observed_at,
    })
    return await self.emitImportRunningPromptSpec(input, advanced, observed_at, {
      sub_step: 'failed',
      source,
      failure_reason,
    })
  }
