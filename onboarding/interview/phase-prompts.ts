/**
 * @neutronai/onboarding — per-phase prompt types + dynamic builders.
 *
 * Sprint 2026-05-10: the hardcoded `PHASE_PROMPTS` constant was removed
 * and replaced by `llm-prompt-driver.ts:STATIC_PHASE_SPECS`. The driver
 * is the single entry point for prompt body generation; the static table
 * is the deterministic fallback used when the LLM call fails.
 *
 * This file now only ships:
 *   - The `PhasePromptSpec` type the engine emits to channels
 *   - Dynamic spec builders for the special-cased phases (slug picker
 *     + profile-pic gallery)
 *   - The resume-on-reconnect helpers
 */

import { readFileSync } from 'node:fs'
import { createLogger } from '@neutronai/logger'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { OnboardingPhase, OnboardingDeploymentMode } from './phase.ts'
import { VALUE_BYTE_CAP } from '@neutronai/channels/button-primitive.ts'
import type { BlendedArchetype } from '../archetypes/compose.ts'

/**
 * P2 v2 § 6.4 — verbatim ChatGPT / Claude download-instruction text
 * lives at `prompts/onboarding/_download-instructions-<source>.md`.
 *
 * Loaded eagerly at module-init so the static phase-spec table and the
 * dynamic builder can both read the same canonical text without
 * re-doing the filesystem walk on every prompt resolve. The files are
 * authored-and-maintained as markdown (verbatim per the spec) so a
 * quarterly re-verify against OpenAI / Anthropic help docs is a
 * one-line PR rather than an engine.ts edit.
 *
 * Resolution: `import.meta.url` → `onboarding/interview/` → walk up two
 * levels to repo root → `prompts/onboarding/_download-instructions-*.md`.
 * Tests that exercise this module run against the same on-disk files.
 */
const log = createLogger('onboarding-phase-prompts')

const HERE_DIR = dirname(fileURLToPath(import.meta.url))
const DOWNLOAD_INSTRUCTIONS_DIR = resolve(
  HERE_DIR,
  '..',
  '..',
  'prompts',
  'onboarding',
)

export type AiSubstrateSource = 'chatgpt' | 'claude'

const DOWNLOAD_INSTRUCTIONS_CACHE: Partial<Record<'chatgpt' | 'claude', string>> = {}

export function readDownloadInstructions(source: 'chatgpt' | 'claude'): string {
  const cached = DOWNLOAD_INSTRUCTIONS_CACHE[source]
  if (cached !== undefined) return cached
  const path = join(DOWNLOAD_INSTRUCTIONS_DIR, `_download-instructions-${source}.md`)
  const body = readFileSync(path, 'utf8').trimEnd()
  DOWNLOAD_INSTRUCTIONS_CACHE[source] = body
  return body
}

export interface PhasePromptSpec {
  phase: OnboardingPhase
  body: string
  options: ReadonlyArray<{
    label: string
    body: string
    value: string
    /** Sprint 28 — propagated to the underlying ButtonOption.image_url so
     *  image-gallery prompts (profile_pic_generating) can attach a per-
     *  candidate thumbnail without re-engineering the engine wiring. */
    image_url?: string
  }>
  allow_freeform: boolean
  next_phase_on_default: OnboardingPhase
  /** When the user picks an option whose value is in this set, the phase
   *  advances to this alternative target instead. */
  next_phase_overrides?: Record<string, OnboardingPhase>
  /** Sprint 28 — propagated to the underlying `ButtonPrompt.kind`. */
  kind?: 'buttons' | 'image-gallery'
  /**
   * P2 v2 § 6.2 (S4) — open-shape metadata bag forwarded onto
   * `ButtonPrompt.metadata`. The web bridge inspects this to render
   * prompt-level affordances (currently only the upload UI for the
   * `import_upload_pending` phase via `upload_affordance: { source }`).
   * Channel adapters that do not understand a key MUST ignore it.
   */
  metadata?: Record<string, unknown>
  /**
   * Sprint 2026-06-03 (onboarding-buttons-only-tweak-later) — per-phase
   * interaction mode. Optional spec-level override of the central
   * `INTERACTION_MODE_BY_PHASE` classification in `interaction-mode.ts`;
   * when absent the engine resolves the mode from that map. See
   * `resolveInteractionMode`. `'buttons-only'` rejects freeform with the
   * canned nudge; `'mixed'` accepts validated text-input fields (see
   * `text_input_fields`) and otherwise nudges; `'freeform'` keeps the
   * legacy LLM-router / synthetic-freeform path.
   */
  interaction_mode?: 'buttons-only' | 'mixed' | 'freeform'
  /**
   * Sprint 2026-06-03 — for a `'mixed'` phase, the declared text-input
   * field names a freeform reply may satisfy (validated per phase in
   * `validateMixedTextInput`). Defaults to `TEXT_INPUT_FIELDS_BY_PHASE`
   * when absent. Non-matching freeform falls through to the canned nudge.
   */
  text_input_fields?: ReadonlyArray<string>
}

/**
 * Deterministic, plain-language static fallback table — used by the LLM
 * prompt driver as the safety net, and by the engine when it needs to
 * read routing fields (next_phase_on_default, next_phase_overrides, kind)
 * without calling the LLM.
 *
 * Sprint 2026-05-10: REPLACES the old `PHASE_PROMPTS` table. Every entry
 * is a short plain-language question with NO menu options. The LLM
 * driver handles the conversational shape; this table only fires when
 * the driver opts out (unwired, phase not enabled, model error).
 *
 * Routing fields (`next_phase_on_default`, `next_phase_overrides`, `kind`)
 * are preserved so the engine state machine keeps working byte-for-byte.
 */
export const STATIC_PHASE_SPECS: Readonly<Record<string, PhasePromptSpec>> = {
  // P2 v2 § 3.1 — first user-visible phase, captures user_first_name.
  // Body is short + warm, single free-text question (no menu options).
  // The engine's `consumeChoice` freeform-text path will eventually
  // extract `user_first_name` from the reply (S3+ LLM driver); the
  // skeleton handler captures the raw reply.
  signup: {
    phase: 'signup',
    body: 'Hey, what should I call you?',
    options: [],
    allow_freeform: true,
    next_phase_on_default: 'instance_provisioned',
  },
  // § 3.3 — auto-skip transit. The walker chains
  // instance_provisioned → ai_substrate_offered before any emit fires;
  // this body is a defensive fallback for the unlikely "phase landed
  // via a non-walker path" recovery branch.
  instance_provisioned: {
    phase: 'instance_provisioned',
    body: 'Your instance is ready. One moment.',
    options: [],
    allow_freeform: true,
    next_phase_on_default: 'ai_substrate_offered',
  },
  // § 3.4 — ai_substrate_offered (renamed from v1 import_offered).
  // Asks whether the user uses ChatGPT or Claude so the import branch
  // can fire. Three-button + freeform so "just ChatGPT" shapes still
  // route correctly. (A "Both" option was removed 2026-06-06 — the
  // importer only ever processes a single source per job; see
  // remove-both-import-option.)
  ai_substrate_offered: {
    phase: 'ai_substrate_offered',
    body:
      "Quick one: do you use other AI services like ChatGPT or Claude? If you do, I can import your conversations and get up to speed in seconds.",
    options: [
      { label: 'A', body: 'Yes, ChatGPT', value: 'chatgpt' },
      { label: 'B', body: 'Yes, Claude', value: 'claude' },
      { label: 'C', body: 'Neither', value: 'neither' },
    ],
    allow_freeform: true,
    next_phase_on_default: 'import_upload_pending',
    next_phase_overrides: { neither: 'work_interview_gap_fill' },
  },
  // § 3.5 / § 6.4 — import_upload_pending. NEW v2 phase. The static
  // fallback below is the ChatGPT block; production resolves the body
  // dynamically off `phase_state.ai_substrate_used` via
  // `buildImportUploadPendingPromptSpec` (S4) so claude renders its
  // own verbatim instruction block. The user uploads a zip
  // (handler at POST /api/upload/<source>) OR types "skip" to bypass
  // the import branch entirely.
  import_upload_pending: {
    phase: 'import_upload_pending',
    body:
      `${readDownloadInstructions('chatgpt')}\n\n` +
      'When you have the ZIP, drag it into the chat or tap the upload button below.\n\n' +
      'If you would rather skip the import, tap "Skip the import" below.',
    options: [
      { label: 'A', body: 'Skip the import', value: 'skip' },
    ],
    allow_freeform: true,
    next_phase_on_default: 'import_running',
    next_phase_overrides: { skip: 'work_interview_gap_fill' },
    metadata: { upload_affordance: { source: 'chatgpt' } },
  },
  // § 3.6 — import_running. Status-bearing transit. Body is the
  // safety-net fallback; the engine builds a dynamic spec via
  // `buildImportRunningPromptSpec` once a job is queued. v2 advances
  // to `import_analysis_presented` on completion (v1 went to
  // `archetype_picked`).
  import_running: {
    phase: 'import_running',
    body:
      'Analyzing your conversations now — entities, topics, recurring threads. This may take a while if you have a large import.',
    options: [],
    allow_freeform: true,
    next_phase_on_default: 'import_analysis_presented',
  },
  // § 3.7 — import_analysis_presented. The wow moment: post the
  // bullets (projects + interests; themes DROPPED per § 2.3 Sam-lock
  // 2026-05-15) and ask "anything missed?". The dynamic body lives in
  // `buildImportAnalysisPresentedPromptSpec`; this static fallback is
  // the safety net used when the resolver opts out (no import_result
  // landed on phase_state). The advance handler in
  // `consumeImportAnalysisPresentedChoice` runs the required-fields
  // audit and overrides `next_phase_on_default` with `personality_offered`
  // when audit clean.
  import_analysis_presented: {
    phase: 'import_analysis_presented',
    body:
      "Here's what I gathered from your conversations. Anything important I missed?",
    options: [],
    allow_freeform: true,
    next_phase_on_default: 'work_interview_gap_fill',
  },
  // § 3.8 — work_interview_gap_fill. NEW v2 phase that absorbs v1's
  // time_style / work_pattern / rituals_captured phases. The LLM driver
  // (S6 wired here) picks the highest-priority missing required field
  // each turn off `bundle.required_fields_state.next_to_collect` and
  // rephrases per the phase goal. The static fallback below is a
  // generic single-question — used only when the driver is unwired or
  // a model call fails — kept VAGUE on purpose so it doesn't trap a
  // user in a single-field loop the static path cannot escape.
  work_interview_gap_fill: {
    phase: 'work_interview_gap_fill',
    body: "Tell me a bit more about what you're working on these days.",
    options: [],
    allow_freeform: true,
    next_phase_on_default: 'personality_offered',
  },
  // § 3.9 — personality_offered (renamed from v1 archetype_picked).
  // Asks "what kind of personality should I have?" with three
  // illustrative options. The LLM driver (S6) generates user-tuned
  // suggestions; the static fallback ships these three so the engine
  // walks end-to-end without LLM substrate.
  personality_offered: {
    phase: 'personality_offered',
    body:
      'What kind of personality should I have? A few options to spark ideas:\n' +
      '- A warm collaborator who explains the why\n' +
      '- A sharp strategist who pushes back when you are hand-waving\n' +
      '- A no-nonsense executor who skips the small talk\n\n' +
      'Pick one, mix two, or describe your own.',
    options: [],
    allow_freeform: true,
    next_phase_on_default: 'agent_name_chosen',
  },
  // § 3.10 — agent_name_chosen (renamed from v1 name_chosen). Asks
  // for the agent name with 3 illustrative suggestions; S7 wires LLM-
  // generated user-tuned names + the dynamic rejection-reason path.
  // Validators in the consumer enforce 2-32 chars + reserved-name guard.
  agent_name_chosen: {
    phase: 'agent_name_chosen',
    body:
      'What should I be called?\n\n' +
      'Some names that fit your style:\n' +
      '- Sage — calm, considered\n' +
      '- Vera — truthful, grounded\n' +
      '- Orin — clear-headed, patient\n\n' +
      'Or type your own — anything you want.',
    options: [],
    allow_freeform: true,
    next_phase_on_default: 'slug_chosen',
  },
  // § 3.11 — slug_chosen. Slug picker stays special-cased via
  // `buildSlugChosenPromptSpec`. The static body below is the safety
  // net; v2 advances to `projects_proposed` (v1 went to
  // `max_oauth_offered`).
  slug_chosen: {
    phase: 'slug_chosen',
    body:
      'Your personal URL — pick one or type your own. Lowercase letters, numbers, and dashes only; 2-30 chars.',
    options: [],
    allow_freeform: true,
    next_phase_on_default: 'projects_proposed',
  },
  // § 3.12 — projects_proposed. P2 v2 / S7 — user-visible: surfaces the
  // collected project list + a single "Good to go" CTA. The dynamic
  // builder `buildProjectsProposedPromptSpec` renders the actual list
  // from `phase_state.primary_projects[]`; this static spec is the
  // resume / unwired-resolver fallback (kept short so it never lies
  // about what the user is being asked). Option value matches the
  // `PROJECTS_PROPOSED_CONFIRM` export below — kept as a string literal
  // here so the const declaration doesn't have to hoist above the table.
  //
  // 2026-05-28 — the legacy `[B] Review each one` button is gone (Sam
  // 2026-05-28 walkthrough: "click 'review each one' and it didnt do
  // any kind of review, it just moved on immediately"). The freeform
  // path (`allow_freeform: true`) handles tweaks like "drop n8n" or
  // "rename Side Project to Apollo" via the LLM router's
  // amend-extraction pipeline (see `consumeProjectsProposedChoice`).
  // The `PROJECTS_PROPOSED_REVIEW` constant is kept for defensive
  // back-compat with any stale in-flight prompts that still submit
  // `value: 'review'` — the engine treats it as confirm-equivalent.
  projects_proposed: {
    phase: 'projects_proposed',
    body:
      "I'll set up shells for the projects we talked about so you can start working in them right away. Are these good to go, or want to tweak the list? Just say what to change — e.g. “ignore real estate investing” or “rename X to Y”. You can also rename or delete any project later.",
    options: [
      { label: 'A', body: 'Good to go', value: 'confirm' },
    ],
    allow_freeform: true,
    next_phase_on_default: 'persona_synthesizing',
  },
  // § 3.13 — persona_synthesizing transit (status post).
  //
  // Per docs/plans/P2-onboarding-v2.md § 3.13, on transition INTO
  // persona_synthesizing the agent posts a user-visible status body
  // while `PersonaComposer.compose(...)` runs synchronously (10-15
  // sec inline). The static body below is what reaches the user on
  // the happy path; the compose call itself is fired inline by
  // `synthesizePersona` (engine.ts), which advances state to
  // persona_reviewed on success or persists
  // `persona_compose_failure_reason` + emits the Try / Use-basic-
  // template / Skip-persona fallback prompt on PersonaError.
  //
  // The resolver (engine.ts `resolvePhasePromptSpec`) returns the
  // fallback prompt spec when the failure flag is set; otherwise it
  // falls through to this static body. The resume-path trigger in
  // `normalAdvance` + `emitCurrentPhasePrompt` re-fires compose when
  // an owner lands here with no draft AND no failure flag (gateway
  // restart mid-compose, or prior turn interrupted between
  // consumeChoice and compose() returning).
  //
  // `allow_freeform: false` — this body is a status post, not a
  // question. A user message arriving during compose re-triggers the
  // resolver (which re-emits this same status) instead of being
  // treated as a routable reply.
  persona_synthesizing: {
    phase: 'persona_synthesizing',
    body: 'Composing your persona — this takes about 10 sec.',
    options: [],
    allow_freeform: false,
    next_phase_on_default: 'persona_reviewed',
  },
  // § 3.14 — persona_reviewed transit. The post-persona Max-attach
  // (`max_oauth_offered`) and wow-dispatch (`wow_fired`) phases were
  // removed (walk dispatcher deleted in #243, handlers in #248/K11e), so
  // the forward default now advances straight to the live finalize
  // target, `completed`.
  persona_reviewed: {
    phase: 'persona_reviewed',
    body: 'Looks great. One more thing before we wrap up.',
    options: [],
    allow_freeform: true,
    next_phase_on_default: 'completed',
  },
}

/**
 * P2 v2 § 3.5 / § 6.4 — dynamic prompt spec for `import_upload_pending`.
 *
 * Body picks the verbatim download-instructions block off
 * `phase_state.ai_substrate_used`:
 *
 *   - `chatgpt`   → ChatGPT instructions
 *   - `claude`    → Claude instructions
 *
 * The body trails with a single warmth-up sentence ("When you have the
 * ZIP, drag it into the chat or tap the upload button below.") plus a
 * skip affordance. The step list itself is the verbatim text from
 * `prompts/onboarding/_download-instructions-<source>.md` per the
 * spec's "KEEP the step-list verbatim" rule — only the bookend text is
 * editorial.
 *
 * `ai_substrate_used` falls back to `'chatgpt'` when null / unknown so
 * an instance that lands at this phase via an unusual path (e.g. a manual
 * SQL flip during ops debugging) still sees actionable instructions
 * instead of a placeholder.
 *
 * `next_phase_on_default` stays `import_running` so the engine's
 * generic auto-skip / re-emit machinery still has a legal target; the
 * actual advance is driven by `engine.notifyImportUpload(...)` after
 * the upload handler writes the file. `next_phase_overrides.skip`
 * routes opt-outs to `work_interview_gap_fill`.
 */
export interface BuildImportUploadPendingPromptSpecInput {
  ai_substrate_used: AiSubstrateSource | null
}

const UPLOAD_AFFORDANCE_TRAILER =
  'When you have the ZIP, drag it into the chat or tap the upload button below.'

// Argus r3 IMPORTANT (2026-06-03): reference the button, NOT a typed
// "skip". import_upload_pending is buttons-only, so a typed "skip" hits the
// canned nudge instead of the skip handler — the body must not suggest it.
// The "Skip the import" button is the sole skip affordance (option A: keep
// copy and code in sync rather than special-casing "skip" through the
// buttons-only branch).
const SKIP_AFFORDANCE_TRAILER =
  'If you would rather skip the import, tap "Skip the import" below.'

export function buildImportUploadPendingPromptSpec(
  input: BuildImportUploadPendingPromptSpecInput,
): PhasePromptSpec {
  const source: AiSubstrateSource =
    input.ai_substrate_used === 'chatgpt' ||
    input.ai_substrate_used === 'claude'
      ? input.ai_substrate_used
      : 'chatgpt'

  const instructions = readDownloadInstructions(source)
  const body = `${instructions}\n\n${UPLOAD_AFFORDANCE_TRAILER}\n\n${SKIP_AFFORDANCE_TRAILER}`
  return {
    phase: 'import_upload_pending',
    body,
    options: [{ label: 'A', body: 'Skip the import', value: 'skip' }],
    allow_freeform: true,
    next_phase_on_default: 'import_running',
    next_phase_overrides: { skip: 'work_interview_gap_fill' },
    metadata: { upload_affordance: { source } },
  }
}

/**
 * P2 v2 § 2.3 + § 3.7 / S5 — dynamic prompt spec for
 * `import_analysis_presented`. The post-import "wow moment" body
 * renders the bullets the engine derived from the Pass-2 result:
 *
 *   Okay <user_first_name>, based on <N> conversations from your
 *   <source> export, here's what I see:
 *
 *   Projects you're working on:
 *   - <verbatim name> — <one-line rationale>
 *   ... (up to 5)
 *
 *   Outside work, I noticed:
 *   - <verbatim name> — <basis>
 *   ... (≥1; whole section omitted if Pass-2 inferred zero)
 *
 *   [low-confidence callout, if any]
 *   I'm less sure about <X> and <Y> — do those fit, or no?
 *
 *   Based on N conversations across M months.
 *
 *   Anything important I missed?
 *
 * § 2.3 LOCKED — themes section is dropped per Sam-lock 2026-05-15.
 * Project + interest names are passed VERBATIM (never rephrased) per
 * the "they're signals from the user's own data" rule.
 *
 * Failure path: when `import_failed=true` (Pass-1/Pass-2 errored OR
 * the engine's hard timeout fired), the body collapses to the
 * graceful "couldn't analyze, let's chat" framing per § 3.6.
 *
 * Partial-result path: when `import_partial=true` (e.g. Pass-2 hit a
 * non-retryable error after some Pass-1 chunks succeeded, OR the
 * runner's 429-backoff window exhausted and only the aggregated-only
 * synthesis exists), the body prepends a "I only got partway through,
 * here's what I have" framing without otherwise changing shape.
 *
 * The advance handler in `engine.consumeImportAnalysisPresentedChoice`
 * captures the user's freeform reply into
 * `phase_state.user_supplied_corrections[]` and runs the
 * required-fields audit to decide whether to route to
 * `personality_offered` (audit clean) or `work_interview_gap_fill`
 * (gaps remain).
 */
export interface BuildImportAnalysisPresentedPromptSpecInput {
  /** First name from signup. Used in the warmth-up sentence. */
  user_first_name: string | null
  /** Substrate that produced the import (chatgpt / claude). */
  import_source: 'chatgpt-zip' | 'claude-zip' | null
  /** Pass-2 ImportResult; null when import_failed=true. */
  import_result: ImportResultForAnalysisBuilder | null
  /** True when Pass-1/Pass-2 errored or the engine hard-timeout fired. */
  import_failed: boolean
  /**
   * True when the budget cap fired mid-Pass-2; the body acknowledges
   * we only got partway through.
   */
  import_partial: boolean
  /**
   * Spanning months of the import (max recency_at - min recency_at,
   * normalized to months). Surfaced in the confidence one-liner.
   * Engine derives from `import_result.topics[*].recency_score` when
   * available; null falls back to "from your import".
   */
  import_months_span: number | null
  /**
   * 2026-05-25 (import-pipeline-resilience sprint, Part G.2) — when
   * true, append a `resume_import` button option to the prompt so the
   * user can re-arm the analysis without re-uploading their ZIP. The
   * engine sets this only when ALL of:
   *
   *   - The prior `import_jobs` row landed in a resumable terminal
   *     state (`cancelled`, `rate_limit_paused`, `failed`).
   *   - The source ZIP is still on disk at
   *     `<owner_home>/imports/<source>.zip` (for *-zip sources).
   *   - The cached `import_pass1_chunks` rows are reusable (per-chunk
   *     hash dedup keyed by `(project_slug, source, chunk_hash)`).
   *
   * Idempotent: once a resumed run lands `completed`, the engine
   * suppresses this flag on subsequent re-emits so the user doesn't
   * see a stale Resume affordance pointing at a finished job.
   */
  can_resume_import?: boolean
}

/**
 * 2026-05-25 — choice value emitted when the user taps the retry-the-scan button
 * surfaced by `can_resume_import`. The engine's
 * `consumeImportAnalysisPresentedChoice` handler routes this value
 * back into `attemptAutoResumeFromPaused(...)` so the resume happens
 * without an HTTP round-trip (the HTTP `/api/import/<id>/resume`
 * endpoint exists for client-side flows that want to drive the resume
 * directly rather than through a button tap). The button RE-RUNS the import
 * (creates a fresh `import_jobs` row + re-reads the still-on-disk source ZIP at
 * `<owner_home>/imports/<source>.zip` from Pass 1), it does NOT restart onboarding.
 *
 * 2026-06-18 (owner-dogfood relabel): the label was "Resume analysis" / body
 * "Picking back up where we left off." — the owner read it as a vague
 * conversational continue, not "retry the scan that just failed." Relabelled to
 * "Continue scanning the export" so the affordance reads as the actual retry of
 * the import scan. The `value` is UNCHANGED (`resume_import`) — only the copy
 * changed, so the engine routing is untouched. */
export const IMPORT_RESUME_CHOICE_VALUE = 'resume_import'
export const IMPORT_RESUME_CHOICE_LABEL = 'Continue scanning the export'

/**
 * P2 v2 S5 — minimal slice of `ImportResult` the analysis-presentation
 * builder reads. Decoupled from the full `ImportResult` type so this
 * file doesn't import from `onboarding/history-import` (keeps the
 * dependency direction clean: phase-prompts knows nothing about the
 * import pipeline's internals).
 */
export interface ImportResultForAnalysisBuilder {
  proposed_projects: ReadonlyArray<{ name: string; rationale: string }>
  inferred_interests?: ReadonlyArray<{ name: string; basis?: string }>
  confidence_by_inference?: ReadonlyArray<{ field: string; score: number; basis?: string }>
  /** Total conversation count from Pass-1 aggregation. */
  conversation_count?: number
}

/** § 2.5 — items whose Pass-2 confidence < this surface in the callout. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5

/**
 * GAP1 (onboarding-wow-handoff-fix, 2026-06-09) — present ALL proposed
 * projects, not a sub-slice. Pass-2 (`import-analyzer-pass2.md`) already
 * hard-caps `proposed_projects` at 7, so 7 is the single intentional bound;
 * this ceiling MUST be ≥ that cap so the presentation never silently drops a
 * project the user could have confirmed. Pre-fix this was 5, which dropped
 * imported projects 6-7 BEFORE the user ever saw them — Sam's 2026-06-09
 * signup proposed 7 (Topline, Northwind, Acme Studio, Acme, Info
 * Product Playbooks, Functional Chocolate, Home Finances) but only 5 were
 * shown. Any overflow beyond this ceiling is `log()`-ed (never silently
 * dropped) at the slice site below.
 */
export const MAX_ANALYSIS_PROJECTS = 7

/**
 * The single source of truth for "the proposed projects the user is shown".
 *
 * The presentation (`buildImportAnalysisPresentedPromptSpec` below) caps the
 * proposal at `MAX_ANALYSIS_PROJECTS`. That same cap is the reconciliation
 * boundary for EVERYTHING downstream — the persisted `phase_state.import_result`
 * + merged `primary_projects` (engine-import-routing), the per-turn onboarding
 * context seam (composer `onboardingContext`), and the finalizer
 * (build-onboarding-finalize). Pass-2 / Pass-2-synthesis is supposed to
 * hard-cap `proposed_projects` at 7 but does NOT enforce it in code (only as a
 * prompt instruction), so a >7 synthesis would persist + lock in projects the
 * user never saw and could not drop (M1 verify, 2026-06-30). Apply this cap at
 * every persistence/finalize boundary so the locked-in set always equals the
 * displayed set (minus drops, plus explicit adds).
 */
export function capProposedProjects<T>(proposed: readonly T[]): T[] {
  return proposed.slice(0, MAX_ANALYSIS_PROJECTS)
}

export function buildImportAnalysisPresentedPromptSpec(
  input: BuildImportAnalysisPresentedPromptSpecInput,
): PhasePromptSpec {
  // `humanizeImportSource` returns "ChatGPT export" / "Claude.ai export"
  // / "export" — the substrate brand. We use the brand-only variant for
  // intro / partial / failure clauses because the surrounding copy
  // already supplies the noun ("from your X export"), and we use the
  // full "export" variant in the bare failure prefix.
  const friendly_brand = humanizeImportBrand(input.import_source)
  const friendly_source = humanizeImportSource(input.import_source)

  // FAILURE PATH — § 3.6 graceful framing. Don't try to render
  // bullets we don't have. The next user reply routes through
  // consumeImportAnalysisPresentedChoice → work_interview_gap_fill so
  // the conversation continues without an imported wow moment.
  if (input.import_failed || input.import_result === null) {
    const name_prefix = input.user_first_name !== null ? `${input.user_first_name}, ` : ''
    const body =
      `${name_prefix}I couldn't analyze your ${friendly_source}. No big deal, ` +
      "we'll just talk it through. What are you working on these days, " +
      "and what's something you do outside of work?"
    const options = buildResumeOption(input.can_resume_import === true)
    return {
      phase: 'import_analysis_presented',
      body,
      options,
      allow_freeform: true,
      next_phase_on_default: 'work_interview_gap_fill',
    }
  }

  const result = input.import_result
  // GAP1 — present every proposed project up to the ceiling. If Pass-2 ever
  // overshoots its own 7-cap, surface the drop in logs rather than silently
  // narrowing what the user can confirm (the exact failure class behind
  // Sam's 3-of-7 shells on 2026-06-09).
  if (result.proposed_projects.length > MAX_ANALYSIS_PROJECTS) {
    log.warn('import_analysis_presented_overflow', {
      proposed: result.proposed_projects.length,
      max: MAX_ANALYSIS_PROJECTS,
      overflow: result.proposed_projects
        .slice(MAX_ANALYSIS_PROJECTS)
        .map((p) => p.name)
        .join(', '),
    })
  }
  const projects = capProposedProjects(result.proposed_projects)
  const interests = result.inferred_interests ?? []
  const confidence = result.confidence_by_inference ?? []

  // Pair confidence scores back to bullet names. The Pass-2 prompt
  // emits `field: "project:<name>" | "interest:<name>"`; here we
  // pull scores out so we can decorate the low-confidence callout.
  const project_scores = new Map<string, number>()
  const interest_scores = new Map<string, number>()
  for (const c of confidence) {
    if (typeof c.field !== 'string') continue
    if (c.field.startsWith('project:')) {
      project_scores.set(c.field.slice('project:'.length).toLowerCase(), c.score)
    } else if (c.field.startsWith('interest:')) {
      interest_scores.set(c.field.slice('interest:'.length).toLowerCase(), c.score)
    }
  }

  // Bucket low-confidence items (score < 0.5) into the callout list.
  // High-confidence + uncalibrated items (score absent) stay in the
  // main bullets; the spec is "surface honestly" — pre-v2 imports
  // without confidence scores should NOT pile into the "less sure"
  // callout just because the field is missing.
  const low_confidence_items: Array<{ name: string; kind: 'project' | 'interest' }> = []
  for (const p of projects) {
    const s = project_scores.get(p.name.trim().toLowerCase())
    if (s !== undefined && s < LOW_CONFIDENCE_THRESHOLD) {
      low_confidence_items.push({ name: p.name, kind: 'project' })
    }
  }
  for (const i of interests) {
    const s = interest_scores.get(i.name.trim().toLowerCase())
    if (s !== undefined && s < LOW_CONFIDENCE_THRESHOLD) {
      low_confidence_items.push({ name: i.name, kind: 'interest' })
    }
  }

  // Body construction. Per § 2.3 lock: NO themes section.
  const lines: string[] = []
  const name_prefix = input.user_first_name !== null ? `Okay ${input.user_first_name}, ` : ''
  const partial_prefix = input.import_partial
    ? "I only got partway through your import, but here's what I have so far: "
    : ''
  const intro_count = result.conversation_count
  const intro_count_clause =
    typeof intro_count === 'number' && intro_count > 0
      ? `based on ${intro_count} conversations from your ${friendly_brand} export, `
      : `based on your ${friendly_brand} export, `
  lines.push(`${name_prefix}${partial_prefix}${intro_count_clause}here's what I see:`)
  lines.push('')

  // Projects section. Per § 2.3, this is the primary signal — never
  // omit even when empty; the gap_fill route handles the empty case.
  if (projects.length > 0) {
    lines.push("Projects you're working on:")
    for (const p of projects) {
      const rationale = (p.rationale ?? '').trim()
      if (rationale.length > 0) {
        lines.push(`- ${p.name} — ${rationale}`)
      } else {
        lines.push(`- ${p.name}`)
      }
    }
    lines.push('')
  }

  // Interests section — § 2.3 says ">=1 non-work interest if Pass-2
  // found any; omit section if none". Don't render an empty "Outside
  // work" header.
  if (interests.length > 0) {
    lines.push('Outside work, I noticed:')
    for (const i of interests) {
      const basis = (i.basis ?? '').trim()
      if (basis.length > 0) {
        lines.push(`- ${i.name} — ${basis}`)
      } else {
        lines.push(`- ${i.name}`)
      }
    }
    lines.push('')
  }

  // Low-confidence callout — only if at least one item to surface.
  if (low_confidence_items.length > 0) {
    const names = low_confidence_items.map((i) => i.name)
    lines.push(`I'm less sure about ${formatList(names)} — do those fit, or no?`)
    lines.push('')
  }

  // Confidence one-liner (§ 2.3 — "Based on N conversations across M
  // months"). The months clause is optional — we render it only when
  // the engine could derive a non-null span.
  const months_span = input.import_months_span
  if (typeof intro_count === 'number' && intro_count > 0) {
    if (months_span !== null && months_span > 0) {
      lines.push(`(Based on ${intro_count} conversations across ${months_span} months.)`)
    } else {
      lines.push(`(Based on ${intro_count} conversations.)`)
    }
    lines.push('')
  }

  // Closer free-text question. Verbatim per § 3.7 example.
  lines.push('Anything important I missed?')

  return {
    phase: 'import_analysis_presented',
    body: lines.join('\n').trimEnd(),
    options: buildResumeOption(input.can_resume_import === true),
    allow_freeform: true,
    // § 2.4 routing: the engine's consumeImportAnalysisPresentedChoice
    // handler runs the required-fields audit and overrides this default
    // with `personality_offered` when the audit is clean. Keeping the
    // default as `work_interview_gap_fill` is the safe fallback when
    // (a) the audit identifies missing required fields OR (b) the
    // bespoke handler is unwired.
    next_phase_on_default: 'work_interview_gap_fill',
  }
}

/**
 * 2026-05-25 — emit the `resume_import` button option iff allowed. The
 * shape mirrors every other `PhasePromptSpec.options` entry: distinct
 * `value` (used as the choice_value the engine routes on), short
 * `label` (button copy), and a `body` short-message the user sees as
 * their own bubble when the button is tapped. Empty array when
 * resume isn't allowed (current call sites pass `false` whenever the
 * job is not resumable, the source ZIP is missing, or this is a
 * fresh post-completion re-emit).
 */
function buildResumeOption(
  can_resume: boolean,
): Array<{ label: string; body: string; value: string }> {
  if (!can_resume) return []
  return [
    {
      label: IMPORT_RESUME_CHOICE_LABEL,
      body: 'Re-running the scan of your export.',
      value: IMPORT_RESUME_CHOICE_VALUE,
    },
  ]
}

/** Format a list of names as "a", "a and b", "a, b, and c". */
function formatList(names: ReadonlyArray<string>): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0] as string
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  const head = names.slice(0, -1).join(', ')
  return `${head}, and ${names[names.length - 1]}`
}

/**
 * P1.5 / Sprint 21 — dynamic prompt spec for the `slug_chosen` phase.
 * Bakes the user's pre-populated suggestion into option A's body so the
 * client can render `Use nova` rather than the
 * placeholder "Use suggested" copy. Surfaces the rejection reason from a
 * prior attempt in the body so re-prompts are actionable.
 *
 * 2026-05-09 chat-UX (Issue 2): the slug-picker phase now exposes ONE
 * click-button — `Use <suggested>`. The freeform composer is the
 * affordance for "Type a different one" (button removed: redundant
 * with the textbox).
 *
 * 2026-05-13: post-slug we now advance to `max_oauth_offered` (the
 * slug step moved to after persona_reviewed in the linear flow).
 *
 * When `slug_picker_configured` is false (composer drift / dev mode),
 * the spec collapses to skip-only — the user can advance without
 * renaming but cannot drive the picker.
 *
 * When `suggested_slug` is null (the user typed a name that did not
 * sanitize to a valid slug seed) AND the picker is configured, the
 * spec emits zero options — `allow_freeform=true` so the composer
 * still works.
 */
export interface BuildSlugChosenPromptSpecInput {
  suggested_slug: string | null
  rejection_reason: string | null
  slug_picker_configured: boolean
  /**
   * P2 v2 § 2.8 / S7 — additional pre-computed slug candidates surfaced
   * alongside the primary `suggested_slug`. Per Sam-lock 2026-05-15
   * (agent-name-primary algorithm), the resolver pre-computes up to three
   * candidates:
   *   1. `<agent_name>-<first_name>` — primary suggestion (`suggested_slug`)
   *   2. `<agent_name>` alone — shorter alternate (when available)
   *   3. `<agent_name>-<first_name>-NNN` — collision fallback (when primary
   *      is taken)
   *
   * The first item is always `suggested_slug` so existing single-suggestion
   * callers stay byte-for-byte identical. Pass the additional candidates
   * here so the body lists them and an extra button (`use-slug:<value>`)
   * is rendered per option. Empty / undefined preserves legacy behaviour
   * (single `use-suggested` button only).
   */
  alt_suggestions?: ReadonlyArray<string>
}

/** § 2.8 Sam-lock — option value emitted for the primary
 *  `Use <slug>` button. Existing engine handler keys
 *  off this literal. */
export const SLUG_USE_SUGGESTED = 'use-suggested'

/** § 2.8 / S7 — option-value prefix for the additional pre-computed slug
 *  buttons. Engine routes `use-slug:<value>` exactly like `use-suggested`
 *  with `raw_input = <value>`. */
export const SLUG_USE_ALT_PREFIX = 'use-slug:'

export function buildSlugChosenPromptSpec(
  input: BuildSlugChosenPromptSpecInput,
): PhasePromptSpec {
  // Argus r1 fix: when slug_picker_configured === false, allow_freeform
  // is also false (typed input is ignored on this path). Don't ask the
  // user to type — Skip is the only real action.
  const altsRaw = input.alt_suggestions ?? []
  const seen = new Set<string>()
  if (input.suggested_slug !== null && input.suggested_slug.length > 0) {
    seen.add(input.suggested_slug)
  }
  const alts: string[] = []
  for (const s of altsRaw) {
    if (typeof s !== 'string' || s.length === 0) continue
    if (seen.has(s)) continue
    seen.add(s)
    alts.push(s)
  }
  const hasAlts = alts.length > 0 && input.slug_picker_configured

  const baseBody = !input.slug_picker_configured
    ? input.suggested_slug !== null && input.suggested_slug.length > 0
      ? `Pick a short name for your instance. Default: ${input.suggested_slug}. We'll suggest one when ready.`
      : "Pick a short name for your instance. We'll suggest one when ready."
    : input.suggested_slug !== null && input.suggested_slug.length > 0
      ? hasAlts
        ? buildSlugMultiSuggestionBody(input.suggested_slug, alts)
        : `Pick a short name for your instance. Default: ${input.suggested_slug}. Type the name you want, or send "${input.suggested_slug}" to keep the default.`
      : 'Pick a short name for your instance — it becomes part of your instance\'s address and your Telegram bot handle. Type a short name.'
  const body =
    input.rejection_reason !== null && input.rejection_reason.length > 0
      ? `${input.rejection_reason}\n\n${baseBody}`
      : baseBody
  const options: Array<{ label: string; body: string; value: string }> = []
  if (input.slug_picker_configured) {
    if (input.suggested_slug !== null && input.suggested_slug.length > 0) {
      options.push({
        label: 'A',
        body: `Use ${input.suggested_slug}`,
        value: SLUG_USE_SUGGESTED,
      })
      // § 2.8 / S7 — additional candidate buttons. Labels B/C; values
      // namespaced via `use-slug:<value>` so the engine can route them
      // through the same picker bridge as `use-suggested` with the
      // chosen slug as raw_input.
      const labels = ['B', 'C', 'D', 'E']
      for (let i = 0; i < alts.length && i < labels.length; i++) {
        const candidate = alts[i] as string
        options.push({
          label: labels[i] as string,
          body: `Use ${candidate}`,
          value: `${SLUG_USE_ALT_PREFIX}${candidate}`,
        })
      }
    }
  } else {
    options.push({ label: 'A', body: 'Skip for now', value: 'skip-slug' })
  }
  return {
    phase: 'slug_chosen',
    body,
    options,
    allow_freeform: input.slug_picker_configured,
    // P2 v2 § 2.8 — post-slug advances to projects_proposed; the v1
    // post-persona Max-attach now lives one hop further down the chain.
    next_phase_on_default: 'projects_proposed',
  }
}

function buildSlugMultiSuggestionBody(
  primary: string,
  alts: ReadonlyArray<string>,
): string {
  const lines: string[] = []
  lines.push(
    `Almost done — pick a short name for your instance. A few options:`,
  )
  lines.push('')
  lines.push(`A. ${primary}   (the default)`)
  const letters = ['B', 'C', 'D', 'E']
  for (let i = 0; i < alts.length && i < letters.length; i++) {
    const a = alts[i] as string
    lines.push(`${letters[i] as string}. ${a}`)
  }
  lines.push('')
  lines.push('Or type your own.')
  lines.push('')
  lines.push('(Lowercase, letters / numbers / dashes only; 2-30 chars.)')
  return lines.join('\n')
}

/**
 * P2 v2 § 3.9 / S7 — dynamic prompt spec for the `personality_offered`
 * phase. Per spec § 2.6 (Sam-lock 2026-05-15), the phase is FREE TEXT
 * with three LLM-suggested examples — NEVER an A/B/C menu of curated
 * archetypes. This builder is the static-fallback shape; the LLM driver
 * produces user-tuned suggestions but the body shape is preserved.
 *
 * Optional `rejection_reason` is prepended when a prior reply failed the
 * ≥4-char minimum (per § 3.9 advance criterion). Optional
 * `personality_suggestions` overrides the default 3 examples when the
 * LLM (or a future caller) wants to seed personality flavors tuned to
 * the user's collected data (Sam-lock 2026-05-15: "evoke a clear flavor
 * (warm / sharp / playful / quiet) and connect to the user's themes
 * when possible").
 */
export interface BuildPersonalityOfferedPromptSpecInput {
  /** Optional rejection reason from a prior reply (e.g. too short). */
  rejection_reason?: string | null
  /** Override the default 3 illustrative examples. Each entry is a
   *  one-line description of a personality flavor. Ignored when
   *  `character_suggestions` is provided. */
  personality_suggestions?: ReadonlyArray<string>
  /**
   * v0.1.80 (2026-05-22) — LLM-generated character anchors. When
   *  provided, the builder renders a 5-character body + 5 buttons (A-E)
   *  whose `value` is `character:<name>`. Tapping a button captures the
   *  character name as `agent_personality`. Freeform is still allowed.
   */
  character_suggestions?: PersonalityCharacterSuggestionsBuilderInput
}

/**
 * v0.1.80 — structural mirror of `PersonalityCharacterSuggestions` from
 * `personality-character-suggester.ts`, declared here so this prompt-
 * shape module stays free of LLM-substrate imports (the resolver in
 * `engine.ts` is the binding seam).
 */
export interface PersonalityCharacterSuggestionsBuilderInput {
  personalized: ReadonlyArray<{ name: string; why: string }>
  wild: ReadonlyArray<{ name: string; why: string }>
}

/** v0.1.80 — value-prefix used on the 5 character buttons. The wire
 *  format is `character:<index>` where index ∈ 0..4 is the position in
 *  render order (personalized first, then wild). The engine's choice
 *  handler resolves the index against `phase_state.personality_character_suggestions`
 *  to recover the actual character name.
 *
 *  Codex r3 P1 (2026-05-22) — wire format MUST stay short. Telegram /
 *  Bot API + our internal ButtonOption.value cap is 37 UTF-8 bytes.
 *  LLM-generated character names can exceed 27 bytes (e.g. "Albus
 *  Percival Wulfric Brian Dumbledore" = 39 bytes), which previously
 *  blew past the cap and crashed `personality_offered` emission. The
 *  index form (max `character:4` = 11 bytes) is trivially safe. */
export const PERSONALITY_CHARACTER_PREFIX = 'character:'

/** v0.1.121 — wire-format prefix for the LEGACY (no-character-suggester)
 *  personality suggestions. Like the character path, the button `value` is
 *  the index — the phrases themselves exceed the 37-byte callback_data
 *  cap. The engine resolves `personality:<index>` against the shared
 *  `DEFAULT_PERSONALITY_SUGGESTIONS` constant. */
export const PERSONALITY_SUGGESTION_PREFIX = 'personality:'

/** Strict matcher for `personality:<index>` (index 0..4). Returns the
 *  parsed index or null on shape mismatch. */
export function parsePersonalitySuggestionIndex(value: string): number | null {
  const m = /^personality:([0-4])$/.exec(value)
  if (m === null) return null
  return Number(m[1])
}

/** v0.1.80 — strict matcher for the wire-format `character:<index>`
 *  values. Index is single-digit 0..4 (we render at most 5 buttons).
 *  Returns the parsed index or null on shape mismatch. */
export function parseCharacterChoiceIndex(value: string): number | null {
  const m = /^character:([0-4])$/.exec(value)
  if (m === null) return null
  return Number(m[1])
}

export const DEFAULT_PERSONALITY_SUGGESTIONS: ReadonlyArray<string> = [
  'A warm collaborator who explains the why',
  'A sharp strategist who pushes back when you are hand-waving',
  'A no-nonsense executor who skips the small talk',
]

const BUTTON_LABELS_5 = ['A', 'B', 'C', 'D', 'E'] as const

export function buildPersonalityOfferedPromptSpec(
  input: BuildPersonalityOfferedPromptSpecInput = {},
): PhasePromptSpec {
  // v0.1.80 — character-anchored shape. Renders the 5-character body
  // + 5 buttons labelled A..E whose `value` is `character:<name>`.
  if (
    input.character_suggestions !== undefined &&
    isValidCharacterSuggestionsShape(input.character_suggestions)
  ) {
    const all = [
      ...input.character_suggestions.personalized,
      ...input.character_suggestions.wild,
    ]
    const personalized_count = input.character_suggestions.personalized.length
    const lines: string[] = []
    lines.push(
      "What kind of voice should your agent have? Pick a character that captures the vibe, or describe in your own words. Some thoughts based on what I've learned:",
    )
    lines.push('')
    for (let i = 0; i < personalized_count; i++) {
      const c = all[i]
      if (c === undefined) continue
      lines.push(`- **${c.name}** - ${c.why}`)
    }
    if (all.length > personalized_count) {
      lines.push('')
      lines.push('Or something more unexpected:')
      lines.push('')
      for (let i = personalized_count; i < all.length; i++) {
        const c = all[i]
        if (c === undefined) continue
        lines.push(`- **${c.name}** - ${c.why}`)
      }
    }
    lines.push('')
    lines.push('Or tell me in your own words.')
    const baseBody = lines.join('\n')
    const body = stitchRejection(baseBody, input.rejection_reason ?? undefined)
    // Codex r3 P1 — wire-format is `character:<index>` (not
    // `character:<name>`) so a long LLM-generated name can't blow past
    // the ButtonOption.value 37-byte cap. The engine resolves the
    // index back onto the memoized name in `phase_state.personality_character_suggestions`.
    // Render order (this `all` array: personalized then wild) MUST
    // match the memoized order — both flow through this same `[...personalized, ...wild]`
    // composition.
    const options = all.map((c, i) => ({
      label: BUTTON_LABELS_5[i] ?? String.fromCharCode(65 + i),
      body: c.name,
      value: `${PERSONALITY_CHARACTER_PREFIX}${i}`,
    }))
    return {
      phase: 'personality_offered',
      body,
      options,
      allow_freeform: true,
      next_phase_on_default: 'agent_name_chosen',
    }
  }

  // Legacy freeform shape — preserved for back-compat (deterministic
  // walks, env where the character-suggester dep is unwired).
  //
  // v0.1.121 (2026-06-04) — render the canonical default suggestions as
  // TAPPABLE index-buttons (the phrases exceed the 37-byte callback_data
  // cap, so the value is `personality:<i>` like the character path). The
  // engine resolves the index against the SAME shared
  // `DEFAULT_PERSONALITY_SUGGESTIONS` constant. We only button-ise the
  // DEFAULT list — a caller passing custom phrases (no production caller
  // does) keeps the legacy bullets so builder/engine can never disagree on
  // what an index means.
  const hasCustom =
    Array.isArray(input.personality_suggestions) &&
    input.personality_suggestions.length > 0
  const options = hasCustom
    ? []
    : DEFAULT_PERSONALITY_SUGGESTIONS.map((phrase, i) => ({
        label: BUTTON_LABELS_5[i] ?? String.fromCharCode(65 + i),
        body: phrase,
        value: `${PERSONALITY_SUGGESTION_PREFIX}${i}`,
      }))
  const lines: string[] = ['What kind of personality should I have?']
  if (options.length === 0) {
    lines.push('A few options to spark ideas:')
    const suggestions = hasCustom
      ? input.personality_suggestions!.slice(0, 5)
      : DEFAULT_PERSONALITY_SUGGESTIONS
    for (const s of suggestions) {
      if (typeof s !== 'string' || s.trim().length === 0) continue
      lines.push(`- ${s.trim()}`)
    }
    lines.push('')
    lines.push('Pick one, mix two, or describe your own.')
  } else {
    lines.push('')
    lines.push('Tap one that fits — or describe your own.')
  }
  const baseBody = lines.join('\n')
  const body = stitchRejection(baseBody, input.rejection_reason ?? undefined)
  return {
    phase: 'personality_offered',
    body,
    options,
    allow_freeform: true,
    next_phase_on_default: 'agent_name_chosen',
  }
}

function isValidCharacterSuggestionsShape(
  s: PersonalityCharacterSuggestionsBuilderInput,
): boolean {
  if (
    !Array.isArray(s.personalized) ||
    !Array.isArray(s.wild) ||
    s.personalized.length === 0
  ) {
    return false
  }
  if (s.personalized.length + s.wild.length > 5) return false
  for (const c of [...s.personalized, ...s.wild]) {
    if (
      c === null ||
      typeof c !== 'object' ||
      typeof c.name !== 'string' ||
      typeof c.why !== 'string' ||
      c.name.trim().length === 0 ||
      c.why.trim().length === 0
    ) {
      return false
    }
  }
  return true
}

/**
 * P2 v2 § 3.10 / S7 — dynamic prompt spec for `agent_name_chosen`.
 * Body invites a free-text agent name with 3-5 illustrative suggestions
 * the LLM (or static fallback) seeds. Per § 2.7 the names should ECHO
 * the personality phrase + project themes; the static defaults stay
 * generic (Sage / Vera / Orin) so the phase still walks end-to-end
 * without an LLM substrate.
 *
 * The advance handler validates length + reserved-name list + a light
 * charset check. On rejection the builder is re-invoked with
 * `rejection_reason` so the next emit explains why.
 */
export interface BuildAgentNameChosenPromptSpecInput {
  rejection_reason?: string | null
  /** Optional 3-5 LLM-tuned suggestions. Each entry is either a bare
   *  name ("Sage") or "name — rationale" ("Sage — calm, considered").
   *  The builder renders bullets as-is. */
  name_suggestions?: ReadonlyArray<string>
}

const DEFAULT_AGENT_NAME_SUGGESTIONS: ReadonlyArray<string> = [
  'Sage — calm, considered',
  'Vera — truthful, grounded',
  'Orin — clear-headed, patient',
]

/**
 * Strip the "— rationale" tail off a suggestion so the bare name remains
 * (`"Sage — calm, considered"` → `"Sage"`). Splits on the FIRST dash that
 * is surrounded by whitespace, so hyphenated names ("Jean-Luc") survive.
 */
function extractSuggestionName(raw: string): string {
  const trimmed = raw.trim()
  const m = /\s+[—–-]\s+/.exec(trimmed)
  return (m !== null ? trimmed.slice(0, m.index) : trimmed).trim()
}

export function buildAgentNameChosenPromptSpec(
  input: BuildAgentNameChosenPromptSpecInput = {},
): PhasePromptSpec {
  const suggestions =
    Array.isArray(input.name_suggestions) && input.name_suggestions.length > 0
      ? input.name_suggestions.slice(0, 5)
      : DEFAULT_AGENT_NAME_SUGGESTIONS
  // v0.1.121 (2026-06-04) — render the suggestions as TAPPABLE buttons,
  // not body-text bullets. The button `value` is the bare canonical name
  // (e.g. "Sage"), so a tap routes through the SAME `validateAgentName`
  // path as a typed reply (`consumeAgentNameChosenChoice` adds the tapped
  // value to its candidate chain). We only surface a suggestion as a
  // button when its extracted name PASSES `validateAgentName` AND fits the
  // 37-byte callback_data cap. `validateAgentName` enforces ≤32 CHARACTERS,
  // not bytes — a 13-char CJK name is valid but 39 bytes UTF-8, which would
  // blow past `VALUE_BYTE_CAP` and make `validateButtonPrompt` reject the
  // whole prompt (Codex r1). Over-cap names stay typeable via freeform;
  // they're just not surfaced as buttons.
  const seen = new Set<string>()
  const buttonNames: string[] = []
  for (const s of suggestions) {
    if (typeof s !== 'string' || s.trim().length === 0) continue
    const name = extractSuggestionName(s)
    const v = validateAgentName(name)
    if (!v.ok) continue
    if (Buffer.byteLength(v.value, 'utf8') > VALUE_BYTE_CAP) continue
    const key = v.value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    buttonNames.push(v.value)
    if (buttonNames.length >= 5) break
  }
  const options = buttonNames.map((name, i) => ({
    label: BUTTON_LABELS_5[i] ?? String.fromCharCode(65 + i),
    body: name,
    value: name,
  }))
  const lines: string[] = ['What should I be called?']
  lines.push('')
  lines.push(
    options.length > 0
      ? 'Tap a name that fits — or type your own.'
      : 'Type any name you want.',
  )
  const baseBody = lines.join('\n')
  const body = stitchRejection(baseBody, input.rejection_reason ?? undefined)
  return {
    phase: 'agent_name_chosen',
    body,
    options,
    allow_freeform: true,
    next_phase_on_default: 'slug_chosen',
  }
}

/**
 * P2 v2 § 3.10 / § 2.7 / S7 — reserved agent-name list. Stops users from
 * naming the agent something that collides with platform identifiers
 * or generic AI-vendor names. Case-insensitive lookup.
 */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
  'neutron',
  'nova',
  'agent',
  'assistant',
  'bot',
  'claude',
  'gpt',
  'chatgpt',
  'openai',
  'anthropic',
  'system',
  'admin',
  'root',
])

export type AgentNameValidation =
  | { ok: true; value: string }
  | { ok: false; reason: string }

/**
 * P2 v2 § 3.10 + § 2.7 — validator for an extracted agent name. Returns
 * the trimmed canonical name on success. On failure, returns a
 * user-facing reason the caller can thread into the next prompt.
 *
 * Rules (Sam-locked):
 *   - 2..32 chars after trim
 *   - charset: letters, digits, space, hyphen, apostrophe (Unicode-aware)
 *   - first character is a letter (Unicode-aware)
 *   - case-insensitive match against `RESERVED_AGENT_NAMES` rejected
 */
export function validateAgentName(raw: string): AgentNameValidation {
  const trimmed = raw.trim()
  if (trimmed.length < 2) {
    return { ok: false, reason: 'A name needs to be at least 2 characters — try another?' }
  }
  if (trimmed.length > 32) {
    return { ok: false, reason: 'Keep the name to 32 characters or fewer — try another?' }
  }
  // Unicode letter-first + letters / digits / spaces / hyphen / apostrophe.
  if (!/^\p{L}[\p{L}\p{N} '\-]{0,31}$/u.test(trimmed)) {
    return {
      ok: false,
      reason: "Names can use letters, numbers, spaces, hyphens and apostrophes only — try another?",
    }
  }
  if (RESERVED_AGENT_NAMES.has(trimmed.toLowerCase())) {
    return { ok: false, reason: `"${trimmed}" is reserved — try another?` }
  }
  return { ok: true, value: trimmed }
}

/**
 * P2 v2 § 3.12 / S7 — dynamic prompt spec for `projects_proposed`.
 * Surfaces the projects collected via import + work_interview_gap_fill
 * and asks the user to confirm or step through edits.
 *
 * Body shape (per § 3.12):
 *
 *   I'll set up shells for these projects so you can start working in
 *   them right away:
 *
 *   1. <project 1>
 *   2. <project 2>
 *   3. <project 3>
 *   [+ more if volunteered]
 *
 *   Want to tweak the list, or are these good to go?
 *
 * Buttons: [A] Good to go (`confirm`). Freeform is the tweak path —
 * "drop #2, add Studio Sessions"-style replies route through the LLM
 * router's amend-extraction pipeline, which mutates
 * `phase_state.primary_projects[]` and re-emits the list. A reply that
 * doesn't parse as an amend collapses to confirm + advance.
 *
 * 2026-05-28 — the legacy `[B] Review each one` button is gone (Sam
 * 2026-05-28 walkthrough). The constant `PROJECTS_PROPOSED_REVIEW` is
 * retained for defensive back-compat with any stale in-flight prompts
 * that still submit `value: 'review'` — the engine handler treats it
 * as confirm-equivalent (see `consumeProjectsProposedChoice`).
 */
export interface BuildProjectsProposedPromptSpecInput {
  /** The projects collected via import + gap-fill. Empty list collapses
   *  to a graceful "I didn't pin down concrete projects yet" framing
   *  with the same two buttons. */
  primary_projects: ReadonlyArray<string>
  rejection_reason?: string | null
}

export const PROJECTS_PROPOSED_CONFIRM = 'confirm'
export const PROJECTS_PROPOSED_REVIEW = 'review'
/**
 * v0.1.80 (2026-05-22) — zero-state-only choices. Emitted when the audit
 * gate let the user through `projects_proposed` with `primary_projects = []`.
 * `share_work` flips `projects_proposed_share_freeform` so the next emit
 * asks for a freeform project list. `skip_ahead` advances to
 * `persona_synthesizing` with `primary_projects_confirmed = []`, same
 * `next_phase_on_default` as `confirm`.
 */
export const PROJECTS_PROPOSED_SHARE_WORK = 'share_work'
export const PROJECTS_PROPOSED_SKIP_AHEAD = 'skip_ahead'

export interface BuildProjectsProposedPromptSpecInputExtended
  extends BuildProjectsProposedPromptSpecInput {
  /** v0.1.80 — when true, the previous turn the user tapped
   *  `share_work` from the zero-state buttons. The body morphs to a
   *  freeform-only "tell me what you're working on" framing with no
   *  buttons. Cleared on the next freeform reply. */
  awaiting_share_freeform?: boolean
}

export function buildProjectsProposedPromptSpec(
  input: BuildProjectsProposedPromptSpecInputExtended,
): PhasePromptSpec {
  const projects = input.primary_projects
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim())
  const lines: string[] = []

  // v0.1.80 — share-freeform sub-state. User tapped "Share what I'm
  // working on" and we're waiting for their reply.
  if (input.awaiting_share_freeform === true) {
    lines.push(
      "Tell me what you're working on — a few projects in your own words is plenty. I'll turn each one into a shell you can drop into right away.",
    )
    const baseBody = lines.join('\n')
    const body = stitchRejection(baseBody, input.rejection_reason ?? undefined)
    return {
      phase: 'projects_proposed',
      body,
      options: [],
      allow_freeform: true,
      next_phase_on_default: 'persona_synthesizing',
    }
  }

  if (projects.length > 0) {
    lines.push(
      "I'll set up shells for these projects so you can start working in them right away:",
    )
    lines.push('')
    projects.forEach((p, i) => {
      lines.push(`${i + 1}. ${p}`)
    })
    lines.push('')
    lines.push('Want to tweak the list, or are these good to go?')
    const baseBody = lines.join('\n')
    const body = stitchRejection(baseBody, input.rejection_reason ?? undefined)
    return {
      phase: 'projects_proposed',
      body,
      options: [
        { label: 'A', body: 'Good to go', value: PROJECTS_PROPOSED_CONFIRM },
      ],
      allow_freeform: true,
      next_phase_on_default: 'persona_synthesizing',
    }
  }

  // v0.1.80 — zero-projects branch. Buttons match the body: share OR skip.
  // The legacy "Good to go / Review each one" pair was nonsensical here.
  lines.push(
    "I didn't pin down concrete projects from what we talked about. Want to share what you're working on, or skip ahead and we'll set things up as we go?",
  )
  const baseBody = lines.join('\n')
  const body = stitchRejection(baseBody, input.rejection_reason ?? undefined)
  return {
    phase: 'projects_proposed',
    body,
    options: [
      {
        label: 'A',
        body: "Share what I'm working on",
        value: PROJECTS_PROPOSED_SHARE_WORK,
      },
      {
        label: 'B',
        body: "Skip — set things up as we go",
        value: PROJECTS_PROPOSED_SKIP_AHEAD,
      },
    ],
    allow_freeform: true,
    next_phase_on_default: 'persona_synthesizing',
  }
}

/**
 * P2 v2 § 2.8 / S7 — pre-LLM slug candidate algorithm (agent-name-primary,
 * Sam-locked 2026-05-15). Returns up to three candidates in the order the
 * user sees them:
 *
 *   1. `<agent_name>-<first_name>`          — primary (default)
 *   2. `<agent_name>` alone                  — shorter alternate (when free)
 *   3. `<agent_name>-<first_name>-NNN`       — collision fallback (always free
 *                                              by construction; 3-digit random)
 *
 * `isAvailable` runs the registry / history / reserved check the slug
 * picker uses (`checkSlugAvailability`). When it's unwired or every
 * candidate sanitizes to null, returns `{ primary: null, alts: [] }`
 * so the caller can fall back to the legacy single-suggestion path.
 *
 * Pure function modulo `isAvailable` + `random3Digit` so it's trivially
 * unit-testable.
 */
export interface ComputeSlugSuggestionsInput {
  agent_name: string | null
  user_first_name: string | null
  isAvailable: (slug: string) => boolean
  random3Digit?: () => number
}

export interface SlugSuggestionResult {
  primary: string | null
  alts: ReadonlyArray<string>
}

export function computeSlugSuggestionsForAgentName(
  input: ComputeSlugSuggestionsInput,
  sanitize: (raw: string) => string | null,
): SlugSuggestionResult {
  const agentSlug =
    typeof input.agent_name === 'string' && input.agent_name.length > 0
      ? sanitize(input.agent_name)
      : null
  const firstSlug =
    typeof input.user_first_name === 'string' && input.user_first_name.length > 0
      ? sanitize(input.user_first_name)
      : null
  const combo =
    agentSlug !== null && firstSlug !== null ? sanitize(`${agentSlug}-${firstSlug}`) : null
  const random =
    input.random3Digit ??
    (() => Math.floor(Math.random() * 900) + 100) // 100..999
  let primary: string | null = null
  const alts: string[] = []
  if (combo !== null && input.isAvailable(combo)) {
    primary = combo
  }
  if (agentSlug !== null && agentSlug !== primary && input.isAvailable(agentSlug)) {
    if (primary === null) {
      primary = agentSlug
    } else {
      alts.push(agentSlug)
    }
  }
  if (combo !== null) {
    // Collision-fallback: NNN-suffix is "always free" by construction.
    // We attempt up to 5 random digits before giving up; in practice the
    // first one is free.
    for (let attempt = 0; attempt < 5; attempt++) {
      const nnn = random()
      const candidate = sanitize(`${combo}-${nnn}`)
      if (candidate === null) continue
      if (candidate === primary) continue
      if (alts.includes(candidate)) continue
      if (input.isAvailable(candidate)) {
        if (primary === null) {
          primary = candidate
        } else {
          alts.push(candidate)
        }
        break
      }
    }
  }
  // If the primary is still null AND we have at least an agentSlug,
  // surface it even when isAvailable hesitates (e.g., registry is empty
  // but we want a sane default). This preserves the legacy single-
  // suggestion path's behaviour as a safety net.
  if (primary === null && agentSlug !== null) {
    primary = agentSlug
  }
  return { primary, alts }
}

/**
 * T1 (2026-05-13) — dynamic prompt spec for `persona_reviewed` per
 * docs/plans/P2-onboarding.md § 2.6 + § 4.8.
 *
 * Renders the first 30 lines of each generated persona file as a single
 * review prompt with [A] Looks good, [B] Edit one line, [C] Restart.
 *
 * The internal file names (SOUL.md / USER.md / priority-map.md) are NOT
 * surfaced to the user — the body uses human-friendly section headers
 * "Voice + style", "About you", "What matters" per the spec.
 *
 * Sub-step affordances: when `sub_step` is `'pick_line'` the body asks
 * the user which line they want to change; when `'pick_replacement'` it
 * asks what the line should say instead; when `'pending_regen_hint'` it
 * asks what should be different on the restart. The button options drop
 * away in sub-step mode so freeform is the only affordance until the
 * sub-flow resolves.
 */
export type PersonaReviewSubStep =
  | 'idle'
  | 'pick_line'
  | 'pick_replacement'
  | 'pending_regen_hint'

export interface BuildPersonaReviewedPromptSpecInput {
  /** First-30-lines slices keyed by section. Empty strings collapse to
   *  "(no content)" so the body never renders blank.
   *
   *  Optional from v0.1.80 — when `summary` is supplied, the excerpts
   *  are ignored. Kept here for back-compat with the legacy raw-excerpt
   *  body shape (deprecated 2026-05-22). */
  voice_excerpt?: string
  about_excerpt?: string
  what_matters_excerpt?: string
  /**
   * v0.1.80 (2026-05-22) — 3-4 sentence conversational summary that
   * REPLACES the raw voice/about/what-matters excerpts when provided.
   * Generated via `onboarding/persona-gen/summarize.ts` and memoized on
   * `phase_state.persona_reviewed_summary`.
   */
  summary?: string | null
  /** Current sub-step in the review sub-flow. */
  sub_step?: PersonaReviewSubStep
  /** When `sub_step === 'pick_replacement'`, the targeted file + line
   *  surfaced in the body so the user knows what they are replacing.
   *  Deprecated 2026-05-22 — the new "Tweak one line" path bypasses
   *  `pick_line` / `pick_replacement` and routes to `pending_regen_hint`. */
  edit_target_section?: 'voice' | 'about' | 'what-matters'
  edit_target_line?: number
  /** Optional rejection reason for an invalid edit / parse failure. */
  rejection_reason?: string
}

export const PERSONA_REVIEWED_LOOKS_GOOD = 'looks_good'
export const PERSONA_REVIEWED_EDIT_LINE = 'edit_line'
export const PERSONA_REVIEWED_RESTART = 'restart'

export function buildPersonaReviewedPromptSpec(
  input: BuildPersonaReviewedPromptSpecInput,
): PhasePromptSpec {
  const sub_step: PersonaReviewSubStep = input.sub_step ?? 'idle'

  // Legacy `pick_line` / `pick_replacement` sub-steps kept as defensive
  // dead code so a pre-v0.1.80 state-file resumed mid-flow renders
  // something sensible. v0.1.80 routes Tweak-one-line directly to
  // `pending_regen_hint`, so these branches are never re-entered by the
  // current handler — but a stale state file could still surface them.
  if (sub_step === 'pick_line') {
    const baseBody =
      'Tell me what you would like to change. Say it in your own words and I will update.'
    return {
      phase: 'persona_reviewed',
      body: stitchRejection(baseBody, input.rejection_reason),
      options: [],
      allow_freeform: true,
      next_phase_on_default: 'persona_reviewed',
    }
  }

  if (sub_step === 'pick_replacement') {
    const baseBody =
      'Tell me what you would like to change. Say it in your own words and I will update.'
    return {
      phase: 'persona_reviewed',
      body: stitchRejection(baseBody, input.rejection_reason),
      options: [],
      allow_freeform: true,
      next_phase_on_default: 'persona_reviewed',
    }
  }

  if (sub_step === 'pending_regen_hint') {
    const baseBody =
      'What should I change? Say it in your own words and I will update.'
    return {
      phase: 'persona_reviewed',
      body: stitchRejection(baseBody, input.rejection_reason),
      options: [],
      allow_freeform: true,
      next_phase_on_default: 'persona_reviewed',
    }
  }

  // v0.1.80 — conversational summary body. When `summary` is provided,
  // render just the summary + the standard 3 buttons. Skips the raw
  // voice/about/what-matters excerpt dump entirely.
  if (typeof input.summary === 'string' && input.summary.trim().length > 0) {
    const baseBody = input.summary.trim()
    return {
      phase: 'persona_reviewed',
      body: stitchRejection(baseBody, input.rejection_reason),
      // Gate-collapse (#93, 2026-06-05) — single "Looks good" CTA only.
      // Sam's verbatim 2026-06-05 signup: "I REALLY do not want a
      // 'restart button'. WTF is that. And what does a 'tweak one line'
      // button do. If I want to tweak something I should just type. The
      // only really button needed here is 'looks good'." The freeform
      // tweak path is now the typed-reply path: any non-empty reply on
      // this screen recomposes the persona (engine
      // consumePersonaReviewedChoice idle-freeform branch), so the
      // "Tweak one line" / "Restart" buttons are redundant. The
      // PERSONA_REVIEWED_EDIT_LINE / _RESTART handlers + constants are
      // kept as defensive dead code for any stale in-flight prompt.
      options: [
        { label: 'A', body: 'Looks good', value: PERSONA_REVIEWED_LOOKS_GOOD },
      ],
      allow_freeform: true,
      next_phase_on_default: 'slug_chosen',
    }
  }

  // Legacy raw-excerpt body shape. Preserved so existing tests + dev
  // environments without a wired summarizer keep working. Deprecated
  // 2026-05-22 — new production wiring always supplies `summary`.
  const voice =
    typeof input.voice_excerpt === 'string' && input.voice_excerpt.length > 0
      ? input.voice_excerpt
      : '(no content)'
  const about =
    typeof input.about_excerpt === 'string' && input.about_excerpt.length > 0
      ? input.about_excerpt
      : '(no content)'
  const what_matters =
    typeof input.what_matters_excerpt === 'string' && input.what_matters_excerpt.length > 0
      ? input.what_matters_excerpt
      : '(no content)'
  const baseBody =
    "Here's what I've put together — your voice and style, what I know about you, and what matters most:\n\n" +
    `**Voice + style**\n${voice}\n\n` +
    `**About you**\n${about}\n\n` +
    `**What matters**\n${what_matters}\n\n` +
    "Anything you'd like to tweak before we keep going?"
  return {
    phase: 'persona_reviewed',
    body: stitchRejection(baseBody, input.rejection_reason),
    // Gate-collapse (#93, 2026-06-05) — single "Looks good" CTA, same as the
    // summary shape above. The legacy raw-excerpt fallback (unwired
    // summarizer / dev env) must NOT resurrect the "Tweak one line" /
    // "Restart" approval-wall buttons this sprint removed — typing is the
    // tweak path (idle freeform sub_step → recompose) on every render path.
    options: [
      { label: 'A', body: 'Looks good', value: PERSONA_REVIEWED_LOOKS_GOOD },
    ],
    allow_freeform: true,
    next_phase_on_default: 'slug_chosen',
  }
}

function stitchRejection(body: string, rejection?: string): string {
  if (typeof rejection !== 'string' || rejection.length === 0) return body
  return `${rejection}\n\n${body}`
}

export function humanizePersonaSection(
  s: 'voice' | 'about' | 'what-matters',
): string {
  if (s === 'voice') return 'Voice + style'
  if (s === 'about') return 'About you'
  return 'What matters'
}

/**
 * Extract the first `n` lines of a generated persona file so the review
 * body shows real substance without dumping the whole document.
 */
export function firstNLines(content: string, n: number): string {
  const lines = content.split('\n')
  if (lines.length <= n) return content.trimEnd()
  return lines.slice(0, n).join('\n').trimEnd()
}

/**
 * T11 (2026-05-15) — strip the canonical `# SOUL.md` / `# USER.md` /
 * `# priority-map.md` H1 header from a persona-file excerpt so the
 * user-visible review bubble never echoes the internal filename.
 *
 * The on-disk files keep the H1 (internal consumers — `@-import` resolution,
 * downstream tooling, the resolver in `entities/RESOLVER.md` — assume
 * each file opens with its canonical header). This helper only runs at
 * the excerpt-render boundary inside the engine before passing
 * `voice_excerpt` / `about_excerpt` / `what_matters_excerpt` into
 * `buildPersonaReviewedPromptSpec`.
 *
 * Strips exactly ONE leading H1 that names a persona artifact, plus the
 * blank line that typically follows. Non-matching H1s (e.g. a future
 * regen redrafts with a different opener) pass through unchanged so we
 * never accidentally eat content.
 */
export function stripPersonaFileH1(content: string): string {
  const lines = content.split('\n')
  const from = personaFileH1OffsetLines(content)
  if (from === 0) return content
  return lines.slice(from).join('\n')
}

/**
 * T11 (2026-05-15) — sibling of `stripPersonaFileH1`. Returns the number
 * of leading lines that the stripper would consume (0 / 1 / 2). The
 * persona_reviewed edit sub-flow uses this to translate the user-typed
 * 1-based line number — counted off the rendered bubble, where the
 * H1 has been stripped — back to a 1-based line number on the
 * underlying full draft that `PersonaComposer.applyEdit` mutates.
 * Without this translation an `applyEdit({line: N})` call would edit
 * the line two rows above the one the user is looking at (Codex r5 P1).
 */
export function personaFileH1OffsetLines(content: string): number {
  const lines = content.split('\n')
  if (lines.length === 0) return 0
  const first = lines[0] ?? ''
  const head = first.trimEnd()
  if (head !== '# SOUL.md' && head !== '# USER.md' && head !== '# priority-map.md') {
    return 0
  }
  if (lines[1] !== undefined && lines[1].trim().length === 0) return 2
  return 1
}

/**
 * T1 (2026-05-13) — fallback prompt spec emitted at `persona_synthesizing`
 * only when a prior compose attempt failed (`persona_compose_failure_reason`
 * set on phase_state). Per § 2.6 quality-gate fallback: "Use a basic
 * template / Try again / Skip persona".
 */
export const PERSONA_SYNTH_RETRY = 'persona_retry'
export const PERSONA_SYNTH_USE_BASIC = 'persona_use_basic'
export const PERSONA_SYNTH_SKIP = 'persona_skip'

export interface BuildPersonaSynthFallbackPromptSpecInput {
  failure_reason: string
}

export function buildPersonaSynthesizingFallbackPromptSpec(
  input: BuildPersonaSynthFallbackPromptSpecInput,
): PhasePromptSpec {
  const reasonClause =
    input.failure_reason.length > 0 ? ` (${input.failure_reason})` : ''
  const body = `I couldn't put together a clean draft${reasonClause}. Want me to try once more, fall back to a basic template, or skip the persona files for now?`
  return {
    phase: 'persona_synthesizing',
    body,
    options: [
      { label: 'A', body: 'Try again', value: PERSONA_SYNTH_RETRY },
      { label: 'B', body: 'Use a basic template', value: PERSONA_SYNTH_USE_BASIC },
      { label: 'C', body: 'Skip persona', value: PERSONA_SYNTH_SKIP },
    ],
    allow_freeform: false,
    next_phase_on_default: 'persona_reviewed',
  }
}

/**
 * Hard cap on user-initiated restarts of the persona compose loop. Per
 * the T1 brief: "Hard cap at 3 restarts before falling back to manual."
 */
export const PERSONA_MAX_RESTARTS = 3

/**
 * Minimal placeholder `BlendedArchetype` used by the engine when no
 * archetype blend has been resolved yet (T5 wires the real archetype
 * library lookup off `phase_state.archetype_hint`; until then the
 * compose pipeline still needs a non-null blend to render SOUL.md).
 */
export const PERSONA_FALLBACK_BLEND: BlendedArchetype = {
  slugs: ['default'],
  display_label: 'Default',
  voice_md: '_Voice profile to be refined as we learn more about you._',
  comm_md: '_Communication style to be refined as we learn more about you._',
  decision_md: '_Decision style to be refined as we learn more about you._',
}

/* K11e (2026-07-07): the `max_oauth_offered` dynamic builder
 * (`buildMaxOauthOfferedPromptSpec`) + its `BuildMaxOauthOfferedPromptSpecInput`
 * input type were deleted here. The phase is no longer walked (engine phase-walk
 * removed in #243, handler methods in #248/K11e), so nothing resolves this
 * builder. Legacy stranded rows are handled purely by the creds gate in
 * gateway/realmode-composer/resolve-onboarding-phase.ts.
 */

/**
 * T4 (2026-05-13), rewritten v0.1.78 (2026-05-22) — dynamic prompt spec
 * for `import_running` per docs/plans/P2-onboarding.md § 4.7
 * (ImportJobRunner contract).
 *
 * The phase has FOUR user-visible shapes (down from six pre-v0.1.78,
 * which had `budget_warning` + `budget_exceeded` removed by the
 * import-resilience sprint):
 *
 *   1. STATUS — the runner is still in `queued` / `pass1-running` /
 *      `pass2-running` / `rate_limit_cooling_off`. Body shows live
 *      progress (chunks done / total). `allow_freeform: true`, zero
 *      options — the user typing a message re-emits the status body
 *      but does not advance.
 *
 *   2. RATE_LIMIT_PAUSED — runner exhausted the ~30-min 429-backoff
 *      window. Body shows the quieter "still waiting on Claude's rate
 *      limit" framing. `allow_freeform: true`, zero options; the bubble
 *      keeps animating and the runner can be resumed (cached Pass-1
 *      work survives).
 *
 *   3. FAILED — runner status is `failed`. Body offers retry/skip.
 *
 *   4. COMPLETED — engine never re-emits this shape (the post-completed
 *      branch advances to `archetype_picked` before emitting). Included
 *      defensively so a stray re-emit at `completed` is non-destructive.
 *
 * The builder selects the shape from the supplied `sub_step`. The
 * engine sets the sub_step from a fresh `ImportJobRunner.status(...)`
 * call.
 *
 * Sam-decisions 2026-05-22 (v0.1.78): no `30 seconds` text, no
 * dollar-cost mention, no budget continue/stop/skip prompt — every
 * Max-OAuth owner gets the same backoff + pause UX regardless of how
 * many chunks burned.
 */
export type ImportRunningSubStep =
  | 'status'
  | 'rate_limit_paused'
  | 'failed'
  | 'completed'

export const IMPORT_RUNNING_RETRY = 'import_retry'
export const IMPORT_RUNNING_SKIP = 'import_skip'

export interface BuildImportRunningPromptSpecInput {
  sub_step: ImportRunningSubStep
  /** Source picked at `import_offered` (chatgpt-zip / claude-zip). */
  source: 'chatgpt-zip' | 'claude-zip' | null
  /** Chunks completed so far in Pass-1; surfaced as progress. */
  pass1_chunks_done?: number
  /** Chunks discovered so far in Pass-1 (may grow as the parser walks). */
  pass1_chunks_total?: number
  /** Optional human-readable failure reason for the `failed` shape. */
  failure_reason?: string
  /**
   * v0.1.78 (2026-05-22) — set when the runner is currently inside an
   * HTTP 429 backoff window (`import_jobs.status === 'rate_limit_cooling_off'`).
   * The status sub-prompt body swaps to the "Claude rate limit cooling
   * off, resuming shortly" framing so the user understands the wait is
   * upstream-rate-limit, not a stuck import. Only affects the `status`
   * sub-step.
   */
  is_rate_limit_cooling_off?: boolean
  /**
   * P2 v2 S5 — set when the soft timeout
   * (`IMPORT_RUNNING_SOFT_TIMEOUT_MS`, 5 min) has been crossed and the
   * job is still pending. The status sub-prompt body acknowledges the
   * wait without escalating to the failed prompt's retry/skip buttons.
   * Only affects the `status` sub-step.
   *
   * v0.1.78 — the prior body referenced an arbitrary "30 seconds"
   * estimate that proved misleading for typical Max-OAuth imports;
   * the rewritten body just says "still working" + the chunk-count
   * tail.
   */
  is_long_running?: boolean
  /**
   * v0.1.85 (2026-05-23) — set when the runner picked the smaller
   * Max-OAuth chunk size (4096 tokens) for this job.
   *
   * 2026-05-26 (Sam-specced) — this field used to gate a user-facing
   * "Running on Max subscription — chunking smaller (slower but stays
   * under Anthropic's per-call cap)" body line; that line was an
   * infra-leak and was removed. The field is preserved on the input
   * type so the engine call site doesn't need a coordinated change,
   * but `buildImportRunningPromptSpec` no longer reads it.
   */
  using_max_oauth_chunking?: boolean
}

export function buildImportRunningPromptSpec(
  input: BuildImportRunningPromptSpecInput,
): PhasePromptSpec {
  const sourceLabel = humanizeImportSource(input.source)

  if (input.sub_step === 'rate_limit_paused') {
    // v0.1.78 — backoff-exhausted state. Quieter body than the failed
    // prompt; no retry/skip buttons because the runner is still
    // recoverable (cached Pass-1 work survives across runner.start
    // calls). The user can wait; the engine keeps polling.
    //
    // Argus r1 fix (PR #271, 2026-05-22) — body now matches reality:
    // the engine's import-running cron tick auto-resumes from paused
    // after `COOLDOWN_AFTER_PAUSED_MS` (5 min). The prior copy promised
    // "I'll keep checking and resume as soon as the limit lifts" but
    // nothing actually checked — the user was stranded forever.
    const progressTail = formatProgressTail(
      input.pass1_chunks_done,
      input.pass1_chunks_total,
    )
    const body =
      `Your import is paused while Claude's rate limit recovers on your ${sourceLabel}.${progressTail} ` +
      `I'll auto-resume in a few minutes — no action needed.`
    return {
      phase: 'import_running',
      body,
      options: [],
      allow_freeform: true,
      next_phase_on_default: 'import_analysis_presented',
    }
  }

  if (input.sub_step === 'failed') {
    const reason = input.failure_reason ?? ''
    const reasonClause = reason.length > 0 ? `\n\n(${reason})` : ''
    const body =
      `Something went wrong while analyzing your ${sourceLabel}.${reasonClause} ` +
      `Paste a fresh URL below to retry with a new export, or tap a button.`
    return {
      phase: 'import_running',
      body,
      options: [
        { label: 'A', body: 'Try again', value: IMPORT_RUNNING_RETRY },
        { label: 'B', body: 'Skip the import', value: IMPORT_RUNNING_SKIP },
      ],
      allow_freeform: true,
      next_phase_on_default: 'import_analysis_presented',
    }
  }

  // Default `status` shape — runner is still running. Body surfaces
  // progress; the engine re-emits on poll ticks / user inbounds.
  const progressTail = formatProgressTail(
    input.pass1_chunks_done,
    input.pass1_chunks_total,
  )
  // v0.1.78 — three status-body shapes (in priority order):
  //   1. rate_limit_cooling_off (Claude 429 mid-flight) — most specific
  //   2. is_long_running (soft-timeout breached, >5 min elapsed)
  //   3. default (recent start)
  // None of these reference an arbitrary "30 seconds" duration anymore
  // — the prior body's hardcoded number was misleading for typical
  // Max-OAuth imports that take much longer.
  let body: string
  if (input.is_rate_limit_cooling_off === true) {
    body =
      `Taking a little longer than usual. Claude rate limit cooling off on your ${sourceLabel}.${progressTail} ` +
      `Resuming shortly.`
  } else if (input.is_long_running === true) {
    body =
      `Still working on your ${sourceLabel}.${progressTail} ` +
      `I'll surface results as soon as they land.`
  } else {
    body =
      `Reading through your ${sourceLabel} now: entities, topics, recurring threads.${progressTail} This may take a while if you have a large import.`
  }
  // 2026-05-26 (Sam-specced) — the previous Max-OAuth one-time notice
  // ("Running on Max subscription — chunking smaller (slower but stays
  // under Anthropic's per-call cap)") was an infra leak; the user
  // doesn't need to see backend chunking strategy. The
  // `using_max_oauth_chunking` input flag is still accepted on the
  // input type for back-compat with the engine call site but no
  // longer affects the rendered body.
  return {
    phase: 'import_running',
    body,
    options: [],
    allow_freeform: true,
    next_phase_on_default: 'import_analysis_presented',
  }
}

function humanizeImportSource(
  source: 'chatgpt-zip' | 'claude-zip' | null,
): string {
  if (source === 'chatgpt-zip') return 'ChatGPT export'
  if (source === 'claude-zip') return 'Claude.ai export'
  return 'export'
}

/**
 * P2 v2 S5 — brand-only variant for sentences where "export" is
 * supplied by the surrounding copy. Avoids the "ChatGPT export
 * export" duplication the analysis-presentation body would otherwise
 * emit.
 */
function humanizeImportBrand(
  source: 'chatgpt-zip' | 'claude-zip' | null,
): string {
  if (source === 'chatgpt-zip') return 'ChatGPT'
  if (source === 'claude-zip') return 'Claude.ai'
  return 'AI'
}

function formatProgressTail(done?: number, total?: number): string {
  if (typeof done !== 'number' || typeof total !== 'number' || total <= 0) {
    return ''
  }
  return ` (${done}/${total} chunks)`
}

/**
 * Body for the resume-on-reconnect prompt fired when `last_advanced_at` is
 * older than 24h. The user picks "Continue" → engine advances out of the
 * stuck phase into its normal next-phase target.
 */
export const RESUME_PROMPT_BODY_PREFIX =
  'Welcome back, we left off at'

export interface ResumePromptOptions {
  current_phase: OnboardingPhase
}

export function buildResumePromptBody(opts: ResumePromptOptions): string {
  const human = humanizePhase(opts.current_phase)
  return `${RESUME_PROMPT_BODY_PREFIX} ${human}. Should we keep going?`
}

export const RESUME_PROMPT_OPTIONS: ReadonlyArray<{
  label: string
  body: string
  value: string
}> = [
  { label: 'A', body: 'Continue', value: 'resume-continue' },
  { label: 'B', body: 'Restart this step', value: 'resume-restart' },
  { label: 'C', body: 'Pause for now', value: 'resume-pause' },
]

/**
 * Translates an internal phase enum into a short human descriptor for
 * the resume-on-reconnect prompt. Kept inline rather than i18n because
 * this is operator-facing English; localization is a P5 concern.
 */
export function humanizePhase(phase: OnboardingPhase): string {
  const map: Partial<Record<OnboardingPhase, string>> = {
    signup: 'starting onboarding',
    instance_provisioned: 'choosing whether to import history',
    ai_substrate_offered: 'choosing your history import',
    import_upload_pending: 'uploading your history export',
    import_running: 'running your history import',
    import_analysis_presented: 'reviewing what I found',
    work_interview_gap_fill: 'filling in the gaps',
    personality_offered: 'picking your personality',
    agent_name_chosen: 'naming your agent',
    slug_chosen: 'picking your personal URL',
    projects_proposed: 'reviewing proposed projects',
    persona_synthesizing: 'synthesizing your persona files',
    persona_reviewed: 'reviewing your persona files',
  }
  return map[phase] ?? phase
}
