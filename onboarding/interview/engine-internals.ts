/**
 * @neutronai/onboarding — interview engine internals (leaf).
 *
 * R5 / audit P2-4 — dependency-free leaf extracted from `engine.ts` to
 * support the import-routing seam extraction without re-introducing an
 * import cycle. This module imports ONLY from sibling leaf/type modules;
 * it MUST NOT import from `engine.ts` or `engine-import-routing.ts`.
 *
 * Holds (all PURE MOVES from engine.ts — no logic changes):
 *   - `InterviewEngineDeps` + the DI hook interfaces it references, the
 *     `Start*` / `Advance*` public types, and
 *     `InterviewErrorCode` / `InterviewError` (relocated so the leaf can
 *     type `EngineInternals.deps` without an engine.ts edge). `engine.ts`
 *     re-exports every one of these for API compatibility.
 *   - The import-routing constants + module-private helper functions the
 *     extracted free functions in `engine-import-routing.ts` reference.
 *   - `EngineInternals` — the structural interface the extracted free
 *     functions consume as their `self` parameter (implemented by
 *     `InterviewEngine`).
 */

import type {
  ButtonChoice,
  ButtonPrompt,
  ChannelKindForButton,
} from '../../channels/button-primitive.ts'
import type { ButtonStore } from '../../channels/button-store.ts'
import type {
  PlatformAdapter,
  SlugAvailabilityProbe,
} from '../../runtime/platform-adapter.ts'
import type { SlugPickerOutcome } from '../../runtime/slug-picker-types.ts'
import type {
  ChunkerInput,
  ImportJob,
  ImportJobStatus,
  ImportResult,
  ImportSource,
} from '../history-import/types.ts'
// (K3, 2026-07-03) — the `ImportJobRunnerHook` contract now lives in its own
// module; imported here for local use (e.g. `importJobRunner?: …`) AND
// re-exported below so `engine.ts` + every consumer keep resolving.
import type { ImportJobRunnerHook } from './import-runner-hook.ts'
import { readEnvTimeoutMs } from './llm-timeouts.ts'
import type {
  ApplyEditInput as PersonaApplyEditInput,
  ComposeInput as PersonaComposeInput,
  PersonaDraft,
} from '../persona-gen/compose.ts'
import type { PersonaSummarizer } from '../persona-gen/summarize.ts'
import type {
  CapturedProject,
  GmailScopeState,
  RitualEntry,
  StalledEmailThread,
  WowInterviewState,
} from '../wow-moment/action-types.ts'
import type {
  AgentNameSuggester,
  AgentNameSuggesterResult,
  AgentNameSuggestions,
} from './agent-name-suggester.ts'
import { detectImportSourceMention } from './import-source-copy.ts'
import type { LlmRouter } from './llm-router.ts'
import type {
  CharacterSuggesterResult,
  PersonalityCharacterSuggester,
  PersonalityCharacterSuggestions,
} from './personality-character-suggester.ts'
import type { PhaseSpecResolver } from './phase-spec-resolver.ts'
import type {
  OnboardingDeploymentMode,
  OnboardingPhase,
} from './phase.ts'
import type { OnboardingState, OnboardingStateStore } from './state-store.ts'
import type { TranscriptWriter } from './transcript.ts'
import type { ImportRunningSubStep, PhasePromptSpec } from './phase-prompts.ts'
import {
  PERSONA_SYNTH_SKIP,
  PERSONA_SYNTH_USE_BASIC,
  type PersonaReviewSubStep,
} from './phase-prompts.ts'

/** Default 24h gap before resume-on-reconnect fires (§ 2.8). */
export const DEFAULT_RESUME_GAP_MS = 24 * 60 * 60 * 1_000

/**
 * P2 v2 S5 — `import_running` timeout backstops (per § 3.6 + sprint
 * brief). The "happy" Pass-1 / Pass-2 pipeline ships in ~30 s; these
 * caps are the engine-side guard that prevents a stuck runner from
 * leaving the instance pinned at `import_running` forever.
 *
 *   - SOFT (5 min): the status sub-prompt's body swaps to the
 *     "still working, hold tight" phrasing on subsequent re-emits so
 *     the user sees the engine is alive without us escalating.
 *   - HARD (15 min): the engine force-advances to
 *     `import_analysis_presented` with `import_failed=true`. The
 *     analysis-presentation body picks up the failure flag and shows
 *     "Couldn't analyze the export, but let's chat it through" — the
 *     same graceful framing the runner-`failed` branch uses (§ 3.6).
 */
export const IMPORT_RUNNING_SOFT_TIMEOUT_MS = 5 * 60 * 1_000
/**
 * 2026-06-18 (import-timeout-progress-aware sprint) — raised 15min → 30min.
 *
 * This is now the FLOOR of the progress-aware job timeout (see
 * `evaluateImportTimeout` below), NOT a flat wall-clock cap. It is the
 * minimum total runtime before a no-forward-progress job can be cancelled,
 * giving the import comfortable headroom for ~8-12 slow read passes +
 * consolidate even when the box is loaded. Env-overridable
 * (`NEUTRON_IMPORT_HARD_TIMEOUT_FLOOR_MS`) so prod can tune without a
 * redeploy.
 *
 * WHY this changed: on 2026-06-18 owner dogfood the flat 15-min cap fired
 * job=synth-a278944c96c78860 at exactly 15m with chunks_done=8/8
 * pass1_pct=100% — it guillotined a fully-read import the instant it
 * entered the consolidate pass, before the user-model was written
 * (`import timed out after 15 minutes` failure card). The PR #98 liveness
 * fix had just stopped the per-turn false-wedges, so each read pass now
 * runs its true (slow, ~2 min on a loaded box) duration and 8 passes +
 * consolidate legitimately exceeded the flat 15-min cap. Same class of bug
 * as the false-wedge, one level up: a magic timeout killing live,
 * progressing work. The fix makes the deadline RESET on forward progress.
 */
export const IMPORT_RUNNING_HARD_TIMEOUT_MS = readEnvTimeoutMs(
  'NEUTRON_IMPORT_HARD_TIMEOUT_FLOOR_MS',
  30 * 60 * 1_000,
)

/**
 * 2026-06-18 (import-timeout-progress-aware sprint) — the no-forward-progress
 * window for the Pass-1 READ phase. The job is cancelled only after this much
 * wall-clock with NO observable forward progress (`pass1_chunks_done` did not
 * advance, `status` did not change, `dollars_spent` did not increase) AND past
 * the 30-min floor. A slow-but-progressing export resets the deadline on every
 * read pass, so it is never guillotined. ~5 min ≈ 2.5× a slow per-pass budget
 * (~2 min on a loaded box). Env-overridable
 * (`NEUTRON_IMPORT_NO_PROGRESS_WINDOW_MS`).
 */
export const IMPORT_NO_PROGRESS_WINDOW_MS = readEnvTimeoutMs(
  'NEUTRON_IMPORT_NO_PROGRESS_WINDOW_MS',
  5 * 60 * 1_000,
)

/**
 * 2026-06-18 (import-timeout-progress-aware sprint) — the no-forward-progress
 * window for the CONSOLIDATE / synthesis phase.
 *
 * After Pass-1 reaches 100% (`pass1_chunks_done >= pass1_chunks_total`) the
 * single-session synthesis runner stays at `status='pass1-running'` and runs a
 * final consolidation turn that emits NO engine-observable progress signal:
 * `pass1_chunks_done` is frozen at 100% and `dollars_spent` stays $0 on a
 * Max-OAuth owner. The engine therefore CANNOT see this turn streaming. This
 * window is the generous allowance for that silent phase — it must comfortably
 * exceed a healthy consolidate's duration. A genuinely WEDGED consolidate is
 * caught FAST by the synthesis-session's own idle-heartbeat (120s, PR #98),
 * which abandons the turn and flips the job to `failed` (a terminal status the
 * engine already routes gracefully) — so this engine-level window is only a
 * generous backstop, not a tight wedge-detector. Reaching 100% counts as
 * forward progress, so the consolidate window starts FRESH at Pass-1
 * completion (this is exactly the owner's failure gap). Env-overridable
 * (`NEUTRON_IMPORT_CONSOLIDATE_WINDOW_MS`).
 */
export const IMPORT_CONSOLIDATE_NO_PROGRESS_WINDOW_MS = readEnvTimeoutMs(
  'NEUTRON_IMPORT_CONSOLIDATE_WINDOW_MS',
  30 * 60 * 1_000,
)

/**
 * 2026-05-25 (import-pipeline-resilience sprint) — dynamic hard-timeout
 * budget. The fixed 15-min `IMPORT_RUNNING_HARD_TIMEOUT_MS` constant was
 * unreachable for any export that produces more than ~180 Pass-1 chunks
 * under Anthropic Max-OAuth rate limits (5s minimum 429 backoff × N
 * chunks). Sam's 1.18 GB ChatGPT export on 2026-05-25 was 919 chunks →
 * 76+ min lower bound; the engine fired `import_failed=true` at 15 min
 * while Pass-1 was 40 % done, burning real money on an already-doomed
 * runner.
 *
 * Dynamic budget reads the job's `pass1_chunks_total` (stable once the
 * pre-count finishes per S12) and produces:
 *
 *   - 15 min floor when pre-count hasn't landed (chunks_total === 0).
 *     Same as legacy behaviour — no regression for tiny imports.
 *   - `chunks_total × 5_000 ms × 2` for any job with a known total.
 *     5s is `RATE_LIMIT_BACKOFF_MS_DEFAULT[1]`, the minimum non-zero
 *     backoff sleep. 2× margin covers per-chunk processing time +
 *     occasional higher backoffs.
 *   - 4 hr ceiling so a runaway / infinite-loop bug eventually bails.
 *
 * Keep `IMPORT_RUNNING_HARD_TIMEOUT_MS` exported as the floor for
 * backwards compatibility (other call sites + tests still reference it).
 */
export const IMPORT_RUNNING_HARD_TIMEOUT_CEILING_MS = 4 * 60 * 60 * 1_000
export const IMPORT_RUNNING_PER_CHUNK_FLOOR_MS = 5_000
export function computeImportHardTimeoutMs(job: {
  pass1_chunks_total: number
}): number {
  if (!Number.isFinite(job.pass1_chunks_total) || job.pass1_chunks_total <= 0) {
    return IMPORT_RUNNING_HARD_TIMEOUT_MS
  }
  const budgetMs =
    job.pass1_chunks_total * IMPORT_RUNNING_PER_CHUNK_FLOOR_MS * 2
  return Math.min(
    Math.max(budgetMs, IMPORT_RUNNING_HARD_TIMEOUT_MS),
    IMPORT_RUNNING_HARD_TIMEOUT_CEILING_MS,
  )
}

/**
 * 2026-06-18 (import-timeout-progress-aware sprint) — the PROGRESS-AWARE
 * job-level import timeout decision. Replaces the flat
 * `elapsed_from_start > computeImportHardTimeoutMs(job)` cap that
 * guillotined the owner's 100%-read import the instant it entered
 * consolidate (job=synth-a278944c96c78860, 2026-06-18). Mirrors the PR #98
 * synthesis-turn liveness philosophy at the JOB level: a live, progressing
 * import is NEVER cancelled.
 *
 * Decision order:
 *   1. Rate-limit states (`rate_limit_cooling_off` / `rate_limit_paused`)
 *      are NEVER timed out here — the auto-resume / degrade machinery
 *      (`attemptAutoResumeFromPaused` + `MAX_RATE_LIMIT_RESUME_CYCLES`)
 *      owns them. Preserves the "no automatic fallback during rate limit"
 *      decision (v0.1.78).
 *   2. The 4h CEILING (`ceiling_ms`) is the absolute backstop against a
 *      true livelock — it fires regardless of progress.
 *   3. The FLOOR (`floor_ms`, 30min) is a minimum total runtime: a young
 *      job is never guillotined even if it shows no progress yet.
 *   4. Otherwise, fire only after a no-FORWARD-progress window with no
 *      active phase to protect. The CONSOLIDATE phase
 *      (`pass1_chunks_done >= pass1_chunks_total`, the silent synthesis
 *      turn) gets a generous dedicated window; the Pass-1 READ phase gets
 *      the shorter read window. The CALLER resets `progress_anchor_at` to
 *      the observed time on every forward-progress tick (chunk advance,
 *      status change, dollars increase) so a slow-but-progressing export
 *      keeps extending its own deadline.
 */
export type ImportTimeoutReason = 'no_progress' | 'ceiling' | null

export interface ImportTimeoutDecision {
  fire: boolean
  reason: ImportTimeoutReason
  /** True iff the job is in the silent consolidate/synthesis phase. */
  in_consolidate: boolean
  /** The window applied this evaluation (consolidate vs read), for logs. */
  window_ms: number
}

export function evaluateImportTimeout(input: {
  observed_at: number
  started_at: number
  /** Wall-clock ms of the last observed forward progress (anchor). */
  progress_anchor_at: number
  pass1_chunks_done: number
  pass1_chunks_total: number
  status: ImportJobStatus
  floor_ms?: number
  no_progress_window_ms?: number
  consolidate_window_ms?: number
  ceiling_ms?: number
}): ImportTimeoutDecision {
  const floorMs = input.floor_ms ?? IMPORT_RUNNING_HARD_TIMEOUT_MS
  const readWindowMs =
    input.no_progress_window_ms ?? IMPORT_NO_PROGRESS_WINDOW_MS
  const consolidateWindowMs =
    input.consolidate_window_ms ?? IMPORT_CONSOLIDATE_NO_PROGRESS_WINDOW_MS
  const ceilingMs = input.ceiling_ms ?? IMPORT_RUNNING_HARD_TIMEOUT_CEILING_MS

  const inConsolidate =
    input.pass1_chunks_total > 0 &&
    input.pass1_chunks_done >= input.pass1_chunks_total
  const windowMs = inConsolidate ? consolidateWindowMs : readWindowMs

  // (1) Rate-limit states are owned by the resume/degrade machinery.
  const isRateLimitState =
    input.status === 'rate_limit_cooling_off' ||
    input.status === 'rate_limit_paused'
  if (isRateLimitState) {
    return { fire: false, reason: null, in_consolidate: inConsolidate, window_ms: windowMs }
  }

  // Guard against clock skew / unset started_at (mirrors the legacy guard).
  const elapsedFromStart =
    input.started_at > 0 && input.observed_at > input.started_at
      ? input.observed_at - input.started_at
      : 0

  // (2) Absolute livelock backstop — fires regardless of progress.
  if (elapsedFromStart > ceilingMs) {
    return { fire: true, reason: 'ceiling', in_consolidate: inConsolidate, window_ms: windowMs }
  }

  // (3) Floor — never guillotine a young job.
  if (elapsedFromStart <= floorMs) {
    return { fire: false, reason: null, in_consolidate: inConsolidate, window_ms: windowMs }
  }

  // (4) No-forward-progress window (read vs consolidate).
  const noProgressElapsed =
    input.observed_at > input.progress_anchor_at
      ? input.observed_at - input.progress_anchor_at
      : 0
  if (noProgressElapsed > windowMs) {
    return { fire: true, reason: 'no_progress', in_consolidate: inConsolidate, window_ms: windowMs }
  }
  return { fire: false, reason: null, in_consolidate: inConsolidate, window_ms: windowMs }
}

/**
 * Partial-result threshold for the engine's hard-timeout branch
 * (2026-05-25 sprint). When the runner has finalised at least this
 * fraction of `pass1_chunks_total` before the dynamic-budget deadline
 * fires, the engine synthesises a partial `ImportResult` from cached
 * Pass-1 rows and advances with `import_partial=true` instead of
 * declaring total failure. Tuned so:
 *
 *   - A 1-shard 50-chunk export that lost the last 30 chunks still
 *     surfaces the partial signal (>= 25 %).
 *   - A 1-chunk-out-of-919 abort doesn't pretend to be useful.
 */
export const IMPORT_PARTIAL_THRESHOLD = 0.25

/**
 * ISSUES #91 (2026-06-09) — ceiling on the `rate_limit_paused` → auto-resume
 * loop. The engine auto-resumes a paused import every `COOLDOWN_AFTER_PAUSED_MS`
 * (see below) by dispatching a fresh `runner.start(...)` that picks up cached
 * Pass-1 chunks at $0. Under GENUINE sustained 429 exhaustion (the owner's Max
 * account saturated, or a huge export the rate limit can't keep up with) each
 * resumed job immediately re-exhausts and re-pauses — an UNBOUNDED loop that
 * either strands the user in the "still waiting on rate limit" body forever OR,
 * when a transient non-429 eventually flips the job to `failed`, surfaces
 * "couldn't analyze your export" while discarding the cached Pass-1 signal.
 *
 * This ceiling bounds the loop: only CONSECUTIVE resume cycles that make NO
 * forward Pass-1 progress (`pass1_chunks_done` does not advance) count toward
 * it — a slowly-but-genuinely-progressing large export keeps resuming. Once the
 * ceiling is hit the engine stops looping and degrades gracefully via
 * `degradeRateLimitExhausted` (salvages cached Pass-1 signal as a partial
 * result; only surfaces the bare "couldn't analyze" when there is genuinely
 * nothing to salvage).
 *
 * 4 cycles ≈ 4 × (~27 min backoff + 5 min cooldown) ≈ ~2 h of trying with no
 * progress before we conclude the rate limit is genuinely saturated.
 */
export const MAX_RATE_LIMIT_RESUME_CYCLES = 4

/**
 * Argus r1 fix (PR #271, 2026-05-22) — cool-off interval the engine
 * waits AFTER a `rate_limit_paused` row lands before dispatching a fresh
 * `runner.start(...)` to auto-resume. The runner's own backoff schedule
 * already burns ~27 min of cooling-off between Anthropic 429s before
 * flipping to paused, so this is the SECOND cooldown layered on top:
 *
 *   1. `retryWith429` exhausts (~27 min of 5s → 60s sleeps) → row flips
 *      to `rate_limit_paused`, `last_paused_at = now`.
 *   2. Engine cron tick observes paused row. If `now - last_paused_at <
 *      COOLDOWN_AFTER_PAUSED_MS`, hold (emit truthful "auto-resume in a
 *      few minutes" body). Otherwise, dispatch `runner.start(...)`.
 *   3. New runner picks up cached Pass-1 chunks at $0 via per-chunk
 *      dedup; if 429s continue, the cycle repeats.
 *
 * 5 minutes is the spec target ("5 min suggested" in the Argus brief).
 * If the user's rate limit is genuinely saturated this means we'll
 * retry every ~35 min (27 backoff + 5 cooldown + however long the
 * fresh attempt's 429-or-success takes) — the right call vs spamming
 * the API right after the backoff already gave up.
 */
export const COOLDOWN_AFTER_PAUSED_MS = 5 * 60 * 1_000

/**
 * P1.5 / Sprint 21 — slug-picker hook. Constructed by the chat-bridge
 * (production) or the test harness; the engine treats it as opaque and
 * just calls `processReply` when the user resolves the `slug_chosen`
 * phase. The hook is responsible for:
 *
 *   - sanitising the input + checking availability (delegates to
 *     `processSlugPickerReply`)
 *   - driving `renameUrlSlug` end-to-end
 *   - emitting the WS `redirect` envelope BEFORE the per-instance gateway
 *     restart kills the live socket (production wires a wrapped
 *     `GatewayRestartDriver` that emits the envelope first)
 *
 * The engine receives the typed outcome and dispatches:
 *   - `renamed` / `skipped` → advance to `profile_pic_generating`
 *   - `rejected`            → keep `slug_chosen`, re-prompt with reason
 */
export interface SlugPickerEngineHook {
  processReply(input: SlugPickerEngineHookInput): Promise<SlugPickerOutcome>
}

/**
 * 2026-05-13 — T3 max-oauth handoff hook. Production wires this in
 * `gateway/realmode-composer/build-landing-stack.ts` to a closure over
 * `auth/max-oauth.ts:MaxOAuthClient`. Tests inject an in-process stub.
 *
 * The hook is fire-and-forget on the engine's side: the engine calls
 * `startHandoff` when the user taps Attach my Max, surfaces the
 * returned URL to the user via a follow-up re-emit, and then verifies
 * the secret landed on the next tap. The hook itself owns whatever
 * out-of-band exchange happens after the URL is opened.
 *
 * Per spec § 2.4 fallback (locked 2026-04-29), the underlying flow is
 * the paste-token path documented in `auth/max-oauth.ts` — the URL
 * `startHandoff` returns is a one-time-use link to a small gate page
 * that asks the user to paste their `claude setup-token` output and
 * persist it via `MaxOAuthClient.persistPasteToken`. The engine does
 * not know or care which exact shape the upstream flow uses; it just
 * asks the hook for a URL and verifies the SecretsStore row after.
 */
export interface MaxOAuthEngineHook {
  startHandoff(input: {
    project_slug: string
    user_id: string
  }): Promise<{ url: string }>
}

/**
 * 2026-05-13 — T3 minimal SecretsStore surface used by the engine. The
 * full `auth/secrets-store.ts:SecretsStore` satisfies this contract; we
 * pin a narrow shape here so tests can inject a mock without dragging
 * in the whole SQLite-backed store. The two methods cover:
 *
 *   - `put`  — persist the BYO API key the user pastes on Branch B,
 *               OR verify post-handoff that the Max-OAuth flow landed
 *               a row (the engine reads via `list` then upserts via
 *               `put` for tests; production wires the real store).
 *   - `list` — used at the Done-tap to check whether a max_oauth_refresh
 *               row landed for the instance.
 */
export interface MaxOauthSecretsStore {
  put(input: {
    internal_handle: string
    kind: 'byo_api_key' | 'max_oauth_refresh' | 'max_oauth_access'
    label: string
    plaintext: string
    expires_at?: number
  }): Promise<{ id: string }>
  list(input: {
    internal_handle: string
    kind?: 'byo_api_key' | 'max_oauth_refresh' | 'max_oauth_access'
  }): Promise<ReadonlyArray<{ id: string; label: string; kind: string }>>
}

/**
 * Sprint 28 — profile-pic hook. The engine treats it as opaque and
 * calls:
 *
 *   1. `ensureCandidates` at phase entry — runs the Gemini Imagen
 *      pipeline (or hits the fallback gallery) + returns the candidate
 *      set the dynamic prompt builder consumes. Idempotent: re-calling
 *      with the same job_id returns the same candidates.
 *
 *   2. `commitPick` when the user taps a candidate — copies bytes to
 *      the canonical avatar path, updates the registry pointer + the
 *      per-instance Telegram bot avatar, and returns the durable result.
 *
 *   3. `regenerate` when the user taps Regenerate — kicks off a fresh
 *      pipeline run + returns the next candidate set.
 *
 * The hook is responsible for everything image-related; the engine
 * just dispatches choices + walks the phase machine. Production wires
 * the hook in `gateway/realmode-composer/build-landing-stack.ts`; tests
 * inject an in-process stub.
 */
export interface ProfilePicEngineHook {
  ensureCandidates(input: ProfilePicHookEnsureInput): Promise<ProfilePicHookEnsureOutcome>
  commitPick(input: ProfilePicHookCommitInput): Promise<ProfilePicHookCommitOutcome>
  regenerate(input: ProfilePicHookRegenInput): Promise<ProfilePicHookEnsureOutcome>
}

export interface ProfilePicHookEnsureInput {
  project_slug: string
  topic_id: string
  user_id: string
  /** The chosen agent name (captured at the name_chosen transition). May
   *  be null when the user typed nothing — production passes the slug as
   *  a fallback prompt seed. */
  agent_name: string | null
  /** Free-form archetype hint propagated from `import_offered`. May be
   *  null. The pipeline normalizes it to a fallback gallery slug. */
  archetype_hint: string | null
  /**
   * Sprint 28 Codex r2 P1 — when set, the hook should re-check the
   * status of the prior job rather than starting a new one. Used by
   * the engine when the user taps Wait on the pending placeholder
   * (the job is already running; we just need to peek its status).
   * When unset, the hook starts a fresh pipeline run.
   */
  prior_job_id?: string
}

export type ProfilePicHookEnsureOutcome =
  | {
      kind: 'ready'
      job_id: string
      candidates: ReadonlyArray<{ candidate_id: string; image_url: string }>
      /** True when the pipeline served from the curated 12-PNG gallery
       *  (Gemini failed N times or was unavailable). The engine surfaces
       *  this as a soft hint above the picker body. */
      from_fallback: boolean
    }
  | {
      /**
       * Codex r1 P1 — pipeline is generating in the background but
       * hasn't landed candidates yet. The engine MUST NOT block the
       * inbound turn waiting for the job; instead it persists the
       * job_id, emits the placeholder "generating" prompt (the user
       * can tap Skip to advance), and lets a follow-up tick re-call
       * `ensureCandidates` to pick up the now-`'ready'` status.
       *
       * The outcome carries the job_id so the engine can stash it
       * against this attempt — when the user's next inbound arrives
       * (or the optional poll re-emits), `ensureCandidates` returns
       * `kind: 'ready'` and the picker materialises.
       */
      kind: 'pending'
      job_id: string
    }
  | {
      kind: 'failed'
      reason: string
    }

export interface ProfilePicHookCommitInput {
  project_slug: string
  topic_id: string
  user_id: string
  /** The pipeline's job id (returned from a prior `ensureCandidates`). */
  job_id: string
  candidate_id: string
}

export type ProfilePicHookCommitOutcome =
  | {
      kind: 'committed'
      canonical_path: string
      registry_updated: boolean
      bot_avatar_pushed: boolean
    }
  | {
      kind: 'failed'
      reason: string
    }

export interface ProfilePicHookRegenInput {
  project_slug: string
  topic_id: string
  user_id: string
  agent_name: string | null
  archetype_hint: string | null
  prior_job_id: string
}

/**
 * T2 (2026-05-13) — wow-moment dispatcher hook. The engine treats it as
 * opaque and calls `dispatch(...)` when the interview advances into
 * `wow_fired`. Production wraps the real `WowDispatcher` in a closure
 * over the heavyweight fixtures (channel adapter, gmail client,
 * reminders store, cron registry, db, telemetry); tests inject a
 * recorder.
 *
 * Per docs/plans/P2-onboarding.md § 2.5 + § 4.10:
 *   - The dispatcher fires the 7 Day-1 actions (catalogue order
 *     7 → 2 → 6 → 3 → 4 → 5 → 1).
 *   - Actions 1 (first-week brief) + 7 (overnight pass) always fire.
 *   - Actions 2-6 fire conditionally on signals (rituals, import
 *     result, captured projects, contemplative keywords, stalled
 *     threads + gmail scopes).
 *   - The dispatcher resolves with a `DispatchOutcome` listing fired /
 *     skipped / failed action ids; the engine persists this to
 *     `phase_state.wow_report` and advances to `completed`.
 *
 * When the hook is absent (deps.wowDispatcher === undefined), the
 * engine emits the wow_fired entry body and leaves state at
 * `wow_fired` — the production composer is responsible for wiring
 * the hook before users reach the phase. Tests that don't exercise
 * the dispatch path simply omit it.
 */
export interface WowDispatcherHook {
  dispatch(input: WowDispatcherHookInput): Promise<WowDispatcherHookOutcome>
}

export interface WowDispatcherHookInput {
  project_slug: string
  topic_id: string
  /** Per-instance home dir (where persona files + cron state live). The
   *  engine doesn't itself know this — the production composer's hook
   *  closes over the value, but tests can read this from the input for
   *  assertion. Optional so tests that don't care can omit it via the
   *  composer wiring. */
  owner_home?: string
  signals: WowDispatcherSignals
}

export interface WowDispatcherSignals {
  interview: WowInterviewState
  import_result: ImportResult | null
  rituals: ReadonlyArray<RitualEntry>
  captured_projects: ReadonlyArray<CapturedProject>
  /**
   * 2026-05-28 sprint — true iff the user reached `projects_proposed`
   * confirmation (any value of `primary_projects_confirmed` was written
   * by `consumeProjectsProposedChoice`, including the deliberate empty
   * `[]` from the zero-state skip-ahead path). Distinguishes "user
   * confirmed zero" from "user never reached confirmation." Codex
   * pickup on PR review: pre-fix `captured_projects.length === 0`
   * conflated the two, so an owner who skip-ahead-with-imports
   * would silently get shells created for the imported candidate set
   * the user had just declined.
   */
  projects_confirmed: boolean
  contemplative_keywords: ReadonlyArray<string>
  stalled_threads: ReadonlyArray<StalledEmailThread>
  gmail_scopes: GmailScopeState | null
}

export interface WowDispatcherHookOutcome {
  /** Action ids that fired successfully. */
  fired: ReadonlyArray<string>
  /** Action ids whose trigger predicate was false. */
  skipped_no_trigger: ReadonlyArray<string>
  /** Action ids that errored mid-run. */
  failed: ReadonlyArray<{ action_id: string; reason: string }>
  /** True iff the dispatcher rescheduled due to a freeform inbound mid-run. */
  rescheduled?: boolean
  /**
   * 2026-05-28 Argus r2 — the brief affordance prompt_id (action 01).
   * Set when the brief emitted its [A] Start overnight pass button;
   * the engine stamps this as `phase_state.active_prompt_id` and stays
   * at `wow_fired` so the user's tap routes back through
   * `consumeWowFallbackChoice` (instead of dispatch auto-advancing to
   * `completed`, which left the affordance buttons returning
   * noop_terminal — the BLOCKER Argus called out r1). Absent → engine
   * preserves the legacy auto-advance-to-completed shape for callers
   * that haven't migrated.
   */
  brief_prompt_id?: string
}

/**
 * 2026-05-22 (push-deeplink-wow sprint) — wow-moment push trigger.
 *
 * Fired AT MOST ONCE per (instance, user) onboarding row by
 * `dispatchWowAndAdvance`, gated on
 * `onboarding_state.wow_pushed_at === null`. The production composer
 * wires a closure over the per-instance `PushDispatcher` +
 * `DevicePushTokenStore` (see `gateway/wow-push-emitter.ts:emitWowPush`);
 * tests inject a recorder.
 *
 * Failure semantics: the engine wraps the call in try/catch + always
 * marks `wow_pushed_at` to the observed time, even on failure, so a
 * Expo outage during the push doesn't cause an infinite retry storm
 * on crash-resume of the `wow_fired` phase.
 *
 * `topic_id` is forwarded verbatim — derivation of the deep-link route
 * param `project_id` happens INSIDE the emitter, not here. The engine
 * sees three topic_id shapes in production today (see
 * `channels/topic-id.ts:parseAnyTopicId`):
 *   - `app-project:<project_id>` — app-reminders surface; the prefix
 *     literally encodes the canonical project_id.
 *   - `app:<user_id>` / `web:<user_id>` — chat surfaces; carry NO
 *     project_id at all.
 *   - `tg:<chat_id>[:<thread_id>]` / bare `<digits>` — Telegram.
 *
 * Argus r1 BLOCKER (2026-05-22 round 2): the previous implementation
 * stripped a hardcoded `app-project:` prefix from `topic_id` and
 * surfaced the raw remainder as `project_id`. In production the
 * chat-bridge path drives `wow_fired` with `topic_id = 'web:<user_id>'`
 * — stripping yields the unchanged string and the push deep-links to
 * `/projects/web%3Au-XXX/chat` (a nonexistent route). The engine no
 * longer derives anything; the production emitter resolves project_id
 * via the canonical projects-store + a `'neutron'` fallback.
 */
export type WowPushEmitter = (input: WowPushEmitterInput) => Promise<void>

export interface WowPushEmitterInput {
  project_slug: string
  user_id: string
  topic_id: string
}

/**
 * T4 (2026-05-13) — history-import job-runner hook. The contract now lives in
 * its own dedicated module (`./import-runner-hook.ts`) so it survives the K3
 * per-chunk import-pipeline evacuation independent of these engine internals;
 * re-exported here so `engine.ts` and every existing consumer keep resolving
 * unchanged.
 */
export type { ImportJobRunnerHook } from './import-runner-hook.ts'

/**
 * T4 (2026-05-13) — payload resolver for the history-import upload
 * mechanism. The actual zip ingestion (presigned URL, file upload
 * widget, etc.) lives outside the engine surface; this hook is the
 * narrow seam the engine calls when the user picks ChatGPT zip /
 * Claude.ai zip at `import_offered`.
 *
 * `resolve` returns a Buffer (or OAuthRefs for the OAuth sources P2
 * surfaces deferred) when the payload is available, or `null` when
 * nothing has been uploaded yet. A null return routes the engine into
 * the "I don't see your export yet" re-emit branch with a retry button;
 * the user uploads via the side-channel and taps retry.
 *
 * Production wires this against the per-instance landing-page upload
 * pipeline; tests inject a buffer.
 */
export interface ImportPayloadResolver {
  resolve(input: {
    project_slug: string
    /** ISSUES #2 (2026-05-19) — second PK component on the onboarding-state row. */
    user_id: string
    source: ImportSource
  }): Promise<ChunkerInput | null>
}

/**
 * 2026-05-25 (import-pipeline-resilience sprint, Part G.2) — probe
 * that the engine consults to decide whether to surface the
 * `resume_import` button on the analysis-presented prompt. When the
 * dep is unwired the engine defaults to `false` (no Resume button) —
 * the chat-bridge HTTP endpoint at
 * `POST /api/import/<job_id>/resume` still works for clients that want
 * to drive the resume directly. Production wires the probe to:
 *
 *   1. Read `import_jobs.status` and confirm it's one of
 *      `cancelled` / `rate_limit_paused` / `failed`.
 *   2. For *-zip sources, verify the source ZIP exists on disk at
 *      `<owner_home>/imports/<source>.zip`. OAuth sources skip the
 *      file check (the payload resolver is the credential gate).
 *
 * Tests pass a recording fake so the button-injection assertions are
 * deterministic without touching the filesystem.
 */
export interface ImportResumeReadinessProbe {
  isResumable(input: {
    project_slug: string
    user_id: string
    source: ImportSource
    job_id: string
  }): Promise<boolean>
}

export interface SlugPickerEngineHookInput {
  /**
   * Current url_slug at engine call time. The hook resolves the
   * canonical current url_slug via its own internal_handle lookup so
   * a stale `project_slug` post-rename (pre-redirect) does not trip
   * `renameUrlSlug`'s optimistic-lock check.
   */
  project_slug: string
  topic_id: string
  user_id: string
  raw_input: string
  agent_name: string | null
  /** When undefined, the hook treats the reply as freeform (the user
   *  typed text without tapping a button). */
  picker_choice?: 'use-suggested' | 'type-different' | 'skip-slug'
}

/**
 * 2026-05-28 sidebar sprint — onboarding-to-General-and-per-project-topics
 * handoff hook. Fired once on the engine's `wow_fired` → `completed`
 * transition (SUCCESS branch only — wow-dispatch failures stay at
 * `wow_fired` so the user can retry without re-emitting seeds). The
 * hook is best-effort: the engine catches and logs throws so a seed
 * hiccup never blocks the user's onboarding completion.
 *
 * Production implementation lives in `gateway/realmode-composer/build-onboarding-handoff.ts`
 * and walks `phase_state.primary_projects_confirmed` (falling back to
 * `phase_state.captured_projects`) to emit one button_prompts row per
 * project under `web:<user_id>:<project_id>` via the shared ButtonStore.
 */
export interface OnboardingHandoffHook {
  emitProjectSeeds(input: {
    project_slug: string
    user_id: string
    /**
     * Projects pulled from `phase_state.primary_projects_confirmed`
     * (`string[]`). The implementation derives a per-project `project_id`
     * from each name (sanitised slug) and writes a seed prompt to the
     * matching `web:<user_id>:<project_id>` topic.
     */
    primary_projects: ReadonlyArray<string>
    /**
     * 2026-05-29 content-aware seeds sprint — `phase_state.import_result`
     * when present (post-history-import), or null when the user skipped
     * the import. The handoff implementation reads
     * `import_result.proposed_projects` to look up each primary project's
     * `rationale` + `suggested_topics` so the seed body has real content
     * to summarise. Projects added freeform (no import match) fall back
     * to a short "I don't have history on it yet" body.
     */
    import_result: ImportResult | null
    observed_at: number
  }): Promise<void>
}

export interface InterviewEngineDeps {
  buttonStore: ButtonStore
  stateStore: OnboardingStateStore
  transcript: TranscriptWriter
  /** Sends the rendered button prompt to the channel (Telegram adapter,
   *  app-socket adapter, etc). The skeleton does NOT know which channel —
   *  the caller injects the right sender. */
  sendButtonPrompt: SendButtonPromptFn
  /**
   * 2026-05-21 (Bug 1, v0.1.75) — optional `import_progress` envelope
   * sender. When wired AND the engine is mid-`import_running`-poll with
   * `suppress_in_progress_status_emit: true` (the cron-tick caller),
   * `pollImportRunningAndAdvance` emits a UI-only progress frame on the
   * live channel every tick. When absent, the engine silently no-ops the
   * progress emit (preserves pre-v0.1.75 behaviour — used by unit tests
   * that don't need to assert progress wire shape). Production composer
   * wires this in `gateway/realmode-composer/build-landing-stack.ts`.
   */
  sendImportProgress?: SendImportProgressFn
  /**
   * P1.5 / Sprint 21 — slug-picker hook. When provided, the engine
   * drives the slug_chosen phase through the picker bridge. When
   * absent, the engine emits the prompt + treats every choice (other
   * than `skip-slug`) as a re-prompt with a "slug picker not
   * configured" reason. Production wires this in
   * `gateway/realmode-composer/build-landing-stack.ts`; tests pass an
   * in-process stub.
   */
  slugPicker?: SlugPickerEngineHook
  /**
   * Sprint B (2026-05-17) — PlatformAdapter refactor. When supplied,
   * `slugAvailability.check(...)` + `.sanitize(...)` compute the
   * agent-name-primary candidate slugs inside
   * `computeSlugSuggestionsForPhase`. Production wires this via the
   * `ManagedPlatformAdapter`; tests + Open self-hosted boxes wire the
   * `LocalPlatformAdapter` (which returns always-available for
   * grammar-legal slugs since there are no other instances to conflict
   * against on a single-owner box).
   *
   * When absent, the resolver falls back to the single-suggestion path
   * (agent-name-derived primary, no alts).
   */
  slugAvailability?: SlugAvailabilityProbe
  /**
   * Sprint 28 — profile-pic hook. Production wires this in
   * `gateway/realmode-composer/build-landing-stack.ts`; tests inject an
   * in-process stub. When absent, the engine collapses the
   * profile_pic_generating phase to skip-only (per the static
   * PHASE_PROMPTS spec) and the user advances without a portrait. The
   * static spec stays small + ergonomic — operator-time disablement
   * never strands the interview.
   */
  profilePic?: ProfilePicEngineHook
  /**
   * Sprint 30 — persona-sync hook. Called at the transition INTO
   * `name_chosen` so the chosen `agent_name` lands on the canonical
   * `agent_name` registry row. The column was
   * shipped in Sprint 20 but population was deferred to "post-agent-
   * naming P2 work" — this is now. Production wires this in
   * `gateway/realmode-composer/build-landing-stack.ts` to the
   * registry's `setAgentName(internal_handle, agent_name)`; tests
   * inject a recorder.
   *
   * Failures are caught + logged inside the engine — a registry write
   * failure must not block the user from advancing through the
   * interview (they can still chat with their agent; the registry
   * row's null agent_name is repaired on the next attempt or via an
   * admin reconciliation).
   */
  personaSync?: PersonaSyncHook
  /**
   * T1 (2026-05-13) — persona composer hook. Called at the transition
   * INTO `persona_synthesizing` so the captured interview signals are
   * turned into SOUL.md / USER.md / priority-map.md drafts and the
   * cringe-check loop runs. Production wires this in
   * `gateway/realmode-composer/build-landing-stack.ts` against a
   * `PersonaComposer` instance; tests inject an in-process stub.
   *
   * When absent, the engine leaves `persona_synthesizing` as a no-op
   * transit phase (the pre-T1 behaviour) and the user's review prompt
   * collapses to the static `Looks great, let's pick your URL` body.
   * This is the operator-time off switch — every production wiring path
   * MUST supply the hook so the spec contract is honoured.
   */
  personaComposer?: PersonaComposerHook
  /**
   * T1 (2026-05-13) — instance home dir resolver. Surfaced into the engine
   * so a future surface (e.g., admin UI showing the on-disk persona
   * files) can resolve the canonical path without re-implementing the
   * convention. The composer hook receives this on `commit` so the
   * engine never needs to know the absolute path itself.
   */
  ownerHomeFor?: (project_slug: string) => string
  /**
   * LLM-driven phase-spec resolver (sprint: LLM-driven onboarding prompts,
   * 2026-05-09). When provided AND the phase is in the resolver's
   * enabled-phase set, `resolvePhasePromptSpec` builds a context bundle
   * (signup_via, telegram first_name, captured fields, last 6 transcript
   * turns, attempt_count, rejection_reason) and asks the resolver to
   * generate the body + curated options. When `null` is returned (phase
   * not enabled OR LLM error), the engine falls through to the existing
   * static `PHASE_PROMPTS` lookup so a model outage stays user-invisible.
   *
   * Production wires `buildLlmPhaseSpecResolver` via
   * `gateway/realmode-composer/build-phase-spec-resolver.ts`; tests
   * inject a deterministic stub (or omit entirely → static fallback,
   * which preserves every existing test assertion).
   */
  phaseSpecResolver?: PhaseSpecResolver
  /**
   * 2026-05-13 — T3 max-oauth handoff hook. When wired AND the user taps
   * Attach my Max at `max_oauth_offered`, the engine calls
   * `startHandoff(project_slug, user_id)` to begin the upstream exchange.
   * Production wires this in `gateway/realmode-composer/build-landing-stack.ts`;
   * tests inject a deterministic stub. When unwired, the user-facing
   * options collapse to BYO / Skip — the engine surfaces a soft
   * "max attach unavailable" inline reason and re-emits.
   */
  maxOauth?: MaxOAuthEngineHook
  /**
   * 2026-05-13 — T3 SecretsStore for the BYO API key path. When wired
   * AND the user taps Use my own API key at `max_oauth_offered` and
   * pastes a valid `sk-ant-...` string on the next turn, the engine
   * persists it via `secrets.put({ kind: 'byo_api_key', ... })`. The
   * engine also calls `secrets.list` to verify the Max-OAuth refresh
   * row landed when the user taps Done on the handoff prompt.
   * Production wires the per-instance SecretsStore; tests inject a mock.
   */
  secrets?: MaxOauthSecretsStore
  /**
   * T2 (2026-05-13) — wow-moment dispatcher hook. When provided, the
   * engine invokes `dispatch(...)` on entry into `wow_fired` and
   * advances to `completed` once the dispatcher resolves (per § 2.5 +
   * § 4.10). When absent (legacy / unwired composer), the engine
   * emits the wow_fired entry body and leaves state at `wow_fired` —
   * onboarding visibly stalls there, which the composer's wiring
   * audit catches in QA. Production wires this in
   * `gateway/realmode-composer/build-landing-stack.ts`; tests inject
   * a recorder or omit entirely.
   */
  wowDispatcher?: WowDispatcherHook
  /**
   * 2026-05-22 (push-deeplink-wow sprint) — wow-moment push trigger.
   * When provided AND `state.wow_pushed_at === null`,
   * `dispatchWowAndAdvance` fires the emitter exactly once before
   * delegating to `wowDispatcher.dispatch(...)`. The engine wraps the
   * call in try/catch and stamps `wow_pushed_at` regardless of
   * success/failure so a downstream Expo outage cannot re-fire on
   * crash-resume. Production composer wires this in
   * `gateway/realmode-composer/build-landing-stack.ts`; tests inject
   * a recorder via this field directly.
   */
  wowPushEmitter?: WowPushEmitter
  /**
   * T4 (2026-05-13) — history-import job-runner hook. When provided,
   * the engine invokes `start(...)` on the `import_offered` →
   * `import_running` transition (after the user picks `chatgpt_zip` /
   * `claude_zip`) and polls `status(...)` on each subsequent inbound
   * + on `start()` re-entry. The hook is the only surface the engine
   * touches; production composer wires a real `ImportJobRunner` with
   * parsers + LLM calls behind it (see
   * `gateway/realmode-composer/build-import-job-runner.ts`). Tests
   * inject a recorder.
   *
   * When absent, `chatgpt_zip` / `claude_zip` choices collapse to the
   * skip path (per § 2.3 the user is always offered a graceful out).
   * Per docs/plans/P2-onboarding.md § 4.7.
   */
  importJobRunner?: ImportJobRunnerHook
  /**
   * T4 (2026-05-13) — history-import payload resolver. Called when
   * the user picks a zip source at `import_offered`; the resolver
   * returns the Buffer (or OAuthRefs) to hand the runner. A `null`
   * return tells the engine the upload hasn't landed yet → re-emit
   * with a retry button. Optional: when unwired the engine assumes
   * the payload arrives via a side-channel and kicks off the runner
   * with an empty placeholder buffer (the runner will then complete
   * with zero results, which is a benign no-op for the user).
   */
  importPayloadResolver?: ImportPayloadResolver
  /**
   * 2026-05-25 (import-pipeline-resilience sprint, Part G.2) — probe
   * the engine consults when rendering
   * `import_analysis_presented` to decide whether to surface the
   * `resume_import` button. See `ImportResumeReadinessProbe` for the
   * full contract. Optional — when omitted the engine never surfaces
   * the button, which is the safe default for surfaces (tests / open-
   * tier composers) that don't run the production resume pipeline.
   */
  importResumeReadiness?: ImportResumeReadinessProbe
  /**
   * 2026-05-13 — slug-history lookup wired in for the no-restart-rename
   * lazy-rekey path in `start()`. When provided alongside `internal_handle`,
   * the engine looks up old slugs for this instance and lazily rekeys an
   * in-progress onboarding row to the requested new slug on the first
   * `start()` call after a rename + restart. When either is omitted, the
   * fallback never fires and `start()` behaves exactly as before. See
   * `SlugHistoryLookup` for cross-project safety notes.
   */
  slugHistory?: SlugHistoryLookup
  /**
   * 2026-05-13 — this gateway's frozen `internal_handle`. Scopes the
   * `slugHistory` lookup so the lazy-rekey path can never pull state
   * from a different instance's history. Optional for back-compat; tests
   * that don't exercise rename-recovery can omit it and the fallback
   * stays inert.
   */
  internal_handle?: string
  now?: () => number
  /** UUID factory; injected for test determinism. */
  uuid?: () => string
  /** Override the resume-on-reconnect window (24h default). */
  resume_gap_ms?: number
  /**
   * P2-v3 S2 (2026-05-18) — LLM router. When wired AND the env flag is
   * on AND the phase has a non-null `PHASE_KNOWLEDGE` pack, the
   * engine's freeform fall-through (normalAdvance, ~line 2710) routes
   * the inbound text through `route(...)` BEFORE the existing
   * synthetic-`__freeform__` consumeChoice cascade. The router's
   * decision (advance / answer / amend) drives the next step per
   * design § 2.3. When the dep is absent OR the flag is off OR
   * `PHASE_KNOWLEDGE[phase]` is null, the engine takes the v2 path
   * unchanged. Production composer wires this via
   * `gateway/realmode-composer/build-llm-router.ts`; tests inject a
   * deterministic stub.
   */
  llmRouter?: LlmRouter
  /**
   * P2-v3 S2 (2026-05-18) — PlatformAdapter. Provides the
   * `getOnboardingConversational()` / `getOnboardingConversationalPhases()`
   * accessors the engine consults at the router branch. Optional for
   * backward compat with the existing test surface that constructs an
   * engine without the adapter — the router branch then simply
   * doesn't fire (same as flag-off).
   */
  platform?: PlatformAdapter
  /**
   * v0.1.80 (2026-05-22) — character suggester for the
   * `personality_offered` phase. When wired, the resolver fires
   * `generate(...)` on phase entry and memoizes the 5 picks in
   * `phase_state.personality_character_suggestions` so reloads don't
   * re-roll. On ANY failure the suggester returns its own static
   * fallback constant so the user still sees a 5-character body. When
   * absent, the legacy 3-suggestion freeform body renders.
   */
  personalityCharacterSuggester?: PersonalityCharacterSuggester
  /**
   * 2026-05-27 — agent-name suggester for the `agent_name_chosen` phase.
   * When wired, the resolver fires `generate(...)` on phase entry and
   * memoizes 3-5 picks in `phase_state.agent_name_suggestions` so reloads
   * don't re-roll. On ANY failure the suggester returns its own static
   * fallback (Sage / Vera / Orin) so the user still sees a name list.
   * Production wiring (gateway/index.ts) builds this via
   * `buildAgentNameSuggester({ anthropicClient })` using the same
   * anthropicClient as the llmRouter + personalityCharacterSuggester.
   *
   * Without this dep the engine falls through to the LLM driver path
   * which has its own post-resolve bullet validator
   * (`phase-spec-resolver.ts:agentNameBodyLooksValid`) that backstops a
   * missing-bullets body by returning null and forcing the static
   * `STATIC_PHASE_SPECS.agent_name_chosen` body.
   */
  agentNameSuggester?: AgentNameSuggester
  /**
   * v0.1.80 (2026-05-22) — persona summarizer for the
   * `persona_reviewed` phase. When wired, the resolver fires
   * `summarize(...)` on phase entry and memoizes the 3-4 sentence
   * summary in `phase_state.persona_reviewed_summary`. On ANY failure
   * the resolver falls back to `staticPersonaSummary(...)` so the body
   * is never empty.
   */
  personaSummarizer?: PersonaSummarizer
  /**
   * 2026-05-28 final-handoff sprint — Telegram-bind token minter. Called
   * when the user taps `[B] Connect a Telegram bot` on the post-completion
   * handoff prompt. Production composer wires this to an `issueStartToken`-
   * style helper with `aud: 'neutron-telegram-bind'` + 1-hour TTL; tests
   * inject a deterministic stub. When unwired the engine falls back to a
   * per-(instance, user) opaque nonce so the deep link still renders — the
   * bot-side `/start bind:<token>` handler is a follow-up sprint (see
   * ISSUES.md), so a non-verifiable nonce is functionally identical for
   * now.
   */
  mintTelegramBindToken?: (input: {
    project_slug: string
    user_id: string
  }) => Promise<string | null>
  /**
   * 2026-05-28 final-handoff sprint — Telegram bot username override.
   * When unset, the engine reads `NEUTRON_TELEGRAM_BOT_USERNAME` from env
   * via `resolveTelegramBotUsername(env)` and falls back to the canonical
   * default. Tests inject a literal so the rendered `t.me/<bot>` URL is
   * deterministic.
   */
  telegramBotUsername?: string
  /**
   * Open-surface honesty fix (Argus PR #15, 2026-06-13) — mobile-app
   * page URL override. When unset, the engine reads the env-derived
   * `MOBILE_APP_URL` (from `NEUTRON_WEB_APP_BASE`). On a self-hosted Open
   * install that hasn't configured the web-app host the resolved value is
   * the empty string and the mobile-app follow-up is suppressed entirely.
   * Tests inject a literal to exercise the populated branch (since
   * `MOBILE_APP_URL` is frozen at module load and is '' under the test
   * harness).
   */
  mobileAppUrl?: string
  /**
   * 2026-05-28 sidebar + per-project chat topology sprint —
   * onboarding-to-General-and-per-project-topics handoff. Called from
   * `dispatchWowAndAdvance`'s SUCCESS branch (just before the upsert
   * to `phase=completed`) with the captured-project list pulled from
   * `phase_state`. Production wires this against `ButtonStore.emit(...)`
   * to seed one chat row per project under `web:<user_id>:<project_id>`
   * so the sidebar's per-project topics already have content when the
   * user first taps them.
   *
   * Failures inside the hook are caught + logged inside the engine —
   * a seed-emit hiccup must not block the user from completing
   * onboarding (the sidebar still renders General + the project topics
   * that DID land; the unlisted ones get re-emitted on the next
   * onboarding attempt's resume path). Per the brief's spec:
   *
   *   "When onboarding completes (phase transitions to a terminal state
   *    like wow_fired), the current onboarding topic_id web:<user_id>
   *    becomes the General topic. For each row in
   *    primary_projects_confirmed, create a new project record (if not
   *    already) AND emit an initial seed prompt to that project's topic."
   */
  onboardingHandoff?: OnboardingHandoffHook
  /**
   * Open-mode-gated phase sequence (2026-06-13 — onboarding Open-mode
   * sprint). Per docs/plans/onboarding-open-vs-managed-framing-2026-06-11.md
   * + docs/NEUTRON.md § 1 deployment tiers. `'managed'` (the default when
   * unset) runs the full hosted sequence unchanged. `'open'` (self-host)
   * cuts the managed-only `identity_oauth` / `instance_provisioned` /
   * `slug_chosen` phases (routing `signup → ai_substrate_offered` and
   * `agent_name_chosen → projects_proposed`) and adapts
   * `max_oauth_offered` to a local "paste your claude setup-token" step
   * instead of the hosted Claude-Max OAuth handoff.
   *
   * Production wires this from `resolveDeploymentMode(process.env)` in the
   * gateway composer; tests inject it directly. Unset → managed so every
   * pre-existing managed caller/test is byte-identical.
   */
  deploymentMode?: OnboardingDeploymentMode
  /**
   * ND2 (2026-06-28) — true when the Path-1 conversational onboarding upload
   * affordance is actually being offered to the user. The live-agent onboarding
   * seam attaches the zip-import affordance to every onboarding agent_message
   * iff an import SUBSTRATE exists (`LiveAgentOnboardingSeam.uploadAffordance()`
   * returns non-null ⟺ `importSubstrate !== null`; see open/composer.ts). This
   * is the signal `notifyImportUpload` keys on to honor a SOLICITED upload that
   * lands at a conversational phase (`work_interview_gap_fill`, …) instead of
   * no-op'ing it.
   *
   * It must NOT be inferred from `importJobRunner` presence: the Open composer
   * always wires a synthesis `importJobRunner` (built over `importSubstrate ??
   * null`), so the runner is present even when NO substrate exists and the
   * affordance is hidden — keying on the runner would start (then fail) a job
   * for a genuinely stray upload (Codex review, PR #94). Production wires this
   * from `importSubstrate !== null` in `build-landing-stack.ts`; unset → false
   * so managed callers / tests without an affordance never take the path.
   */
  importAffordanceOffered?: boolean
}

/**
 * Sprint 30 — persona-sync hook. Engine calls `recordAgentName(...)` on
 * the `signup` → `name_chosen` transition. Implementations write the
 * value to the platform registry. Idempotent; nullable
 * agent_name clears the column.
 *
 * P2 v2 S3 (2026-05-16) — extended with `recordUserFirstName(...)`,
 * fired when the user's first name is captured at `signup` (extracted
 * via the LLM prompt driver or the static-fallback heuristic). Mirrors
 * `recordAgentName`'s contract: idempotent, nullable, best-effort
 * (failures logged, not thrown). Optional so existing test fixtures
 * built before S3 keep compiling — production wiring in
 * `gateway/realmode-composer/resolve-persona-sync.ts` populates both
 * methods.
 */
export interface PersonaSyncHook {
  recordAgentName(input: {
    project_slug: string
    agent_name: string | null
  }): Promise<void>
  /**
   * P2 v2 § 3.1 — write the captured `user_first_name` to the canonical
   * `user_first_name` registry row at the same transition the
   * engine writes it locally to `phase_state.user_first_name`. The
   * dual-store pattern keeps onboarding's working state in sync with
   * the indexed lookup downstream services read.
   */
  recordUserFirstName?(input: {
    project_slug: string
    user_first_name: string | null
  }): Promise<void>
  /**
   * P2 v2 § 3.9 / S7 — write the captured `agent_personality` string to
   * the canonical `agent_personality` registry row at the same transition
   * the engine writes it locally to `phase_state.agent_personality`. The
   * dual-store pattern matches `recordAgentName` /
   * `recordUserFirstName`. Optional so legacy fixtures keep compiling;
   * production composer wires it alongside the other two methods.
   */
  recordAgentPersonality?(input: {
    project_slug: string
    agent_personality: string | null
  }): Promise<void>
}

/**
 * T1 (2026-05-13) — persona composer hook. Mirrors the surface area of
 * `onboarding/persona-gen/compose.ts:PersonaComposer` so the production
 * composition wires a `PersonaComposer` instance directly and tests can
 * inject a recorder without spinning up the cringe-check loop.
 *
 * The hook is the only place the engine touches persona-gen — every
 * file write, cringe-check pass, and git commit happens behind this
 * surface. The engine's job is to feed `compose` the captured signals
 * from `phase_state`, persist the returned draft, drive the review
 * sub-flows (edit / restart / commit), and route to `slug_chosen` on
 * success.
 */
export interface PersonaComposerHook {
  /** Generate fresh SOUL.md / USER.md / priority-map.md from the
   *  captured interview state. Runs the cringe-check loop internally and
   *  throws `PersonaError{code:'cringe_cap_exceeded'}` when the regen
   *  cap is hit. */
  compose(input: PersonaComposeInput): Promise<PersonaDraft>
  /** Apply a single user-supplied line edit to one file in the draft
   *  + re-run the cringe-check on the edited file. */
  applyEdit(input: PersonaApplyEditInput): Promise<PersonaDraft>
  /** Persist the draft to `<owner_home>/persona/SOUL.md` etc. and (if
   *  wired) record a git commit. */
  commit(draft: PersonaDraft): Promise<{
    committed_at: number
    git_sha: string | null
    paths: string[]
  }>
}

/**
 * 2026-05-13 — slug-history lookup for the no-restart-rename lazy-rekey
 * path in `start()`. After a slug rename, the per-instance gateway's
 * onboarding-state row is still keyed under the OLD slug. When the
 * gateway restarts and starts identifying itself with the NEW slug
 * (`.url_slug` file is the new source of truth — see
 * `rename-url-slug.ts` in the Managed provisioning layer), `engine.start(NEW)` would
 * find no row and reset the user to S1.
 *
 * This hook lets the engine, scoped to its own `internal_handle`, find
 * old slugs that historically mapped to this instance, look up the row
 * under the old slug, and lazily rekey it to the requested new slug —
 * preserving in-progress onboarding state across the rename/restart
 * boundary.
 *
 * Cross-instance safety: the lookup is scoped by `internal_handle` (the
 * gateway's frozen identifier) so a malicious or misrouted caller
 * cannot pull state from a different instance's history.
 */
export interface SlugHistoryLookup {
  /**
   * Return all old_slugs in slug_history for the given internal_handle.
   * Empty list (or unknown internal_handle) → no fallback fires.
   */
  listOldSlugsForInternalHandle(internal_handle: string): Promise<string[]>
}

/**
 * Channel-agnostic sender. The caller wraps the channel adapter (Telegram
 * webhook, app-socket emit) so the engine doesn't need to know which one
 * is wired. The sender returns the channel-native message id (or the
 * empty string when the prompt was a noop because of idempotency).
 */
export interface SendButtonPromptFn {
  (input: {
    project_slug: string
    topic_id: string
    prompt: ButtonPrompt
  }): Promise<{ message_id: string; was_new: boolean }>
}

/**
 * 2026-05-21 — periodic import-progress sender. The per-instance
 * `import-running` cron tick calls this via the engine to push a UI-only
 * status envelope to the live channel while the ImportJobRunner is mid-
 * flight. The sender is channel-agnostic (web today, Telegram TBD); the
 * routed implementation lives in `gateway/http/chat-bridge.ts`.
 *
 * The shape mirrors `ImportProgressOutbound` from `landing/server.ts` —
 * the engine speaks the wire shape so the routed sender is a thin
 * registry lookup with no envelope rendering. The sender returns true iff
 * the live channel accepted the frame; the engine ignores the return
 * value (next 5s tick will re-emit on transient drops).
 *
 * Bug 1, v0.1.75. See `docs/plans/P2-onboarding-v2.md` § 3.6 + § 9.5.
 */
export interface SendImportProgressFn {
  (input: {
    project_slug: string
    topic_id: string
    event: {
      type: 'import_progress'
      job_id: string
      status:
        | 'queued'
        | 'pass1-running'
        | 'pass2-running'
        | 'rate_limit_cooling_off'
        | 'rate_limit_paused'
        | 'completed'
        | 'failed'
        | 'cancelled'
      pass: 1 | 2
      pct: number
      /**
       * 2026-05-22 — pre-count fix follow-up to PR #264.
       *
       * `true`  → the bubble renders "Pass 1: ${done}/${total} batches"
       *           against a stable denominator (runner pre-counted the
       *           whole chunk list before pass1 started).
       * `false` → the bubble renders "Pass 1: ${done} batches processed"
       *           (no fake denominator) because the runner is in the
       *           streaming-fallback path and still discovering chunks.
       *
       * Mirrors `ImportJob.chunks_total_known`; the engine reads it from
       * the job row and threads it into the envelope.
       */
      chunks_total_known: boolean
      body?: string
    }
  }): Promise<{ delivered: boolean }>
}

export interface StartInput {
  project_slug: string
  topic_id: string
  user_id: string
  signup_via: 'telegram' | 'web'
  /**
   * LLM-driven prompts sprint (2026-05-09) — Telegram first_name captured
   * by the channel adapter at deeplink time. When provided, the engine
   * stashes it in `phase_state.tg_first_name` so the LLM phase-spec
   * resolver can reference it by name in the opening prompt
   * ("Want me to call you Anna, or something else?"). Optional: web
   * signups never carry it; pre-Sprint Telegram bootstraps don't either,
   * and the resolver gracefully falls through to a generic ask.
   */
  tg_first_name?: string | null
  /**
   * #306 (2026-06-19) — auto-detected browser timezone (IANA, e.g.
   * "America/Los_Angeles"). The web client derives it from
   * `Intl.DateTimeFormat().resolvedOptions().timeZone` and sends it as the
   * `?tz=` WS-upgrade param; the chat-bridge threads it here. The engine
   * stamps a VALIDATED value onto `phase_state.timezone` on the first
   * `start()` so persona-gen renders it into USER.md and the interview
   * NEVER has to ask for it (the LLM envelope is instructed to treat a
   * known timezone as already captured). Optional: Telegram signups +
   * older clients omit it; an invalid / oversize value is dropped (the
   * agent then falls back to its prior behaviour).
   */
  timezone?: string | null
}

export interface StartResult {
  prompt_id: string
  was_new: boolean
  state: OnboardingState
}

/**
 * Inbound shape for `advance(...)`— either the user tapped a button (the
 * channel layer has already routed it into a `ButtonChoice`) or they
 * typed a freeform message that did not correspond to an active prompt.
 */
export interface AdvanceInput {
  project_slug: string
  topic_id: string
  user_id: string
  channel_kind: ChannelKindForButton
  /** When set, the inbound is a button tap routed for the current active
   *  prompt. The engine resolves it via ButtonStore + advances. */
  choice?: ButtonChoice
  /** When set, the inbound is freeform text that did not resolve a
   *  ButtonChoice. The engine treats it as a freeform answer to the
   *  active prompt when `allow_freeform=true`, otherwise records it in
   *  the transcript as a `user` line and re-emits the active prompt. */
  freeform_text?: string
  /** Defaults to `now()`. */
  observed_at?: number
}

export type AdvanceOutcome =
  | 'advanced'
  | 'reemitted_current'
  | 'resume_prompt_emitted'
  | 'resume_handled'
  | 'no_active_prompt'
  | 'noop_terminal'
  | 'noop_no_state'

export interface AdvanceResult {
  outcome: AdvanceOutcome
  state: OnboardingState | null
  /** When the engine emitted (or re-emitted) a prompt during this call. */
  prompt_id?: string
}

export type InterviewErrorCode =
  | 'illegal_transition'
  | 'owner_state_missing'
  | 'prompt_emit_failed'
  | 'send_failed'
  | 'unknown_prompt'

export class InterviewError extends Error {
  override readonly name = 'InterviewError'
  constructor(
    readonly phase: OnboardingPhase,
    readonly code: InterviewErrorCode,
    /** True when the engine should retry the same phase next tick. */
    readonly recoverable: boolean,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

/**
 * Synthetic choice values that mean "not an answer." `__timeout__`
 * comes from the sweepExpired tick; `__cancel__` is the app-socket
 * cancel primitive. The engine records both in the transcript but
 * does NOT advance phase — these aren't successful interview turns.
 *
 * `__freeform__` is intentionally NOT in this set — a user who typed
 * their name freeform IS answering the prompt; the engine routes
 * `freeform_text` into the transcript body and advances normally.
 */
export const NON_ADVANCING_CHOICE_VALUES: ReadonlySet<string> = new Set([
  '__timeout__',
  '__cancel__',
])

/**
 * Phases whose PHASE_PROMPTS body is intentionally suppressed. The engine
 * transparently advances past each one via its legal default-route target,
 * so the user never sees the gate prompt. The walk happens at three call
 * sites — `normalAdvance` (resumed state), `consumeChoice` tail (state
 * computed from a choice), and `emitCurrentPhasePrompt` (post-signin
 * landing) — so every emit-time path skips uniformly.
 *
 * v2 entries (P2-onboarding-v2 § 2.8 + § 3.2 / § 3.3):
 *   - `identity_oauth` — OAuth callback handled outside the chat
 *     surface; the engine just records the transit.
 *   - `instance_provisioned` — back-stage provisioning step; user never
 *     sees a body, only the landing chat once their instance exists.
 *
 * NB: `agent_name_chosen` (v2 rename of v1 `name_chosen`) is NOT auto-
 * skipped — it's the dedicated user-visible "what should I be called?"
 * phase per § 3.10.
 *
 * NB: `persona_synthesizing` (§ 3.13) is NOT in the auto-skip set even
 * though the spec describes it as a back-stage transit. The
 * `synthesizePersona` helper runs inline in `consumeChoice` and is what
 * advances state to `persona_reviewed`; adding the phase to AUTO_SKIP
 * would bypass that helper (the walker fires BEFORE `synthesizePersona`
 * and uses the static spec's `next_phase_on_default` to chain forward),
 * leaving `compose()` never invoked.
 */
export const AUTO_SKIP_PHASES: ReadonlySet<OnboardingPhase> = new Set([
  'identity_oauth',
  'instance_provisioned',
])

/**
 * 2026-05-21 (Bug 1, v0.1.75) — heuristic Pass-2 expected duration for
 * progress-pct estimation. Pass 2 is a single-shot Opus synthesis with
 * no granular signal — we estimate progress as
 * `(now - pass2_started_at) / PASS2_EXPECTED_DURATION_MS` clamped to
 * [0, 0.95] so the indicator never claims to be done before the runner
 * actually terminates. Real Pass-2 typical: 30-60 s; budget cap 120 s.
 */
export const PASS2_EXPECTED_DURATION_MS = 60_000

export function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  if (typeof v !== 'string' || v.length === 0) return null
  return v
}

/**
 * #306 (2026-06-19) — server-side re-validation of the auto-detected
 * browser timezone before it is stamped onto `phase_state.timezone`. The
 * client already trims + length-bounds the value (`detectBrowserTimezone`
 * in `landing/chat.ts`), but the engine is the trust boundary: a crafted
 * `?tz=` query param could carry anything. Accepts IANA-shaped zone names
 * (`Area/Location`, `Etc/GMT+5`, `UTC`) — a leading letter then letters,
 * digits, `+`, `-`, `_`, `/`, capped at 64 chars — and returns the trimmed
 * value, or null for anything empty / oversize / wrong-shape. Null means
 * "don't stamp" (the agent falls back to its prior, ask-nothing behaviour).
 */
export function sanitizeBrowserTimezone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 64) return null
  if (!/^[A-Za-z][A-Za-z0-9+\-_/]*$/.test(trimmed)) return null
  return trimmed
}

/**
 * ISSUES #98 — the single source_switch_intent set/clear rule shared by the
 * import-source reroute (`reEmitImportSourceSelection`) and the
 * ai_substrate_offered freeform reconcile (`reconcileSwitchIntentFromFreeform`).
 * Previously the two sites mirrored this logic by hand and risked drifting
 * apart (Argus r2 MINOR); now there is exactly one.
 *
 * Given the user's freeform and the staged source, returns:
 *   - `undefined` — the freeform names NO source (or names both ambiguously).
 *     Callers decide: the reconcile path leaves a prior intent untouched (a
 *     bare "is it done?" must not clear a genuine switch); the reroute path
 *     treats it as no-switch (`?.intent ?? null`).
 *   - `{ mentioned, intent }` — the freeform UNAMBIGUOUSLY names a source.
 *     `intent` is that source when it DIFFERS from staged (a switch), else
 *     `null` (the user re-affirmed the staged source → clear any stale intent).
 */
export function computeSwitchIntent(
  freeform: string | undefined,
  staged: string | null,
):
  | { mentioned: 'chatgpt' | 'claude'; intent: 'chatgpt' | 'claude' | null }
  | undefined {
  if (freeform === undefined || freeform.length === 0) return undefined
  const mentioned = detectImportSourceMention(freeform)
  if (mentioned === null) return undefined
  return { mentioned, intent: mentioned !== staged ? mentioned : null }
}

export function readNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v
}

/**
 * Item 3 (2026-06-19, owner live-dogfood) — parse a freeform reply that is
 * JUST an option number ("3", "#3", "3.", "3)", "option 3", "number 2")
 * into its 1-based integer. Returns null for anything that carries OTHER
 * content (so a genuine personality description like "3 parts sarcasm, 1
 * part warmth" or a name like "Iris" is never mis-read as a pick). Bounded
 * to 1..99 — option lists are tiny, and the bound keeps a pasted phone
 * number / year from resolving to a pick. Shared by the personality_offered
 * (engine-persona) + agent_name_chosen (engine-agent-name) handlers so a typed
 * number selects the SAME memoized option a button tap would.
 */
export function parseBareOptionNumber(text: string): number | null {
  const m = /^\s*(?:option\s+|number\s+|no\.?\s*|#)?(\d{1,2})\s*[.)]?\s*$/i.exec(
    text,
  )
  if (m === null) return null
  const n = Number.parseInt(m[1]!, 10)
  if (!Number.isFinite(n) || n < 1 || n > 99) return null
  return n
}

/**
 * ISSUES #91 — true when a salvaged `ImportResult` carries any analyzable
 * signal worth presenting as a partial import (entities / topics / proposed
 * projects / proposed tasks). An empty result (e.g. `synthesizeOnDemand`
 * found zero cached Pass-1 rows) returns false so the give-up path surfaces
 * the graceful "couldn't analyze" framing instead of a blank analysis card.
 */
export function importResultHasSignal(result: ImportResult): boolean {
  return (
    (result.entities?.length ?? 0) > 0 ||
    (result.topics?.length ?? 0) > 0 ||
    (result.proposed_projects?.length ?? 0) > 0 ||
    (result.proposed_tasks?.length ?? 0) > 0
  )
}

/**
 * P2 v2 S5 — small helper used when merging project name lists pulled
 * from `import_result.proposed_projects` with anything that was already
 * on `phase_state.primary_projects`. Case-insensitive dedup preserves
 * the canonical (first-seen) casing.
 */
export function dedupeStringsCaseInsensitive(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const trimmed = v.trim()
    if (trimmed.length === 0) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

/**
 * T4 / Codex r3 (post-T4) — validate a user-pasted import URL. Accept
 * http/https only; reject non-URL text, file://, data:, etc. so the
 * fetcher never tries to resolve something dangerous.
 */
export function isValidImportUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * T4 (2026-05-13) — defensive read for the import_source enum stashed
 * on `phase_state`. Returns null when absent or when the value is not
 * one of the known ImportSource constants.
 */
export function readImportSource(
  obj: Record<string, unknown>,
  key: string,
): ImportSource | null {
  const v = obj[key]
  if (typeof v !== 'string') return null
  switch (v) {
    case 'chatgpt-zip':
    case 'claude-zip':
    case 'gmail-oauth':
    case 'calendar-oauth':
    case 'drive-oauth':
    case 'notion-oauth':
    case 'slack-oauth':
      return v
    default:
      return null
  }
}

export function readStringArray(
  phase_state: Record<string, unknown>,
  key: string,
): string[] | null {
  const v = phase_state[key]
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0) out.push(item)
  }
  return out.length > 0 ? out : null
}

/**
 * R5 / audit P2-4 — persona-seam helpers relocated from `engine.ts` to
 * this dependency-free leaf so the extracted persona free functions in
 * `engine-persona.ts` can consume them without an engine.ts import cycle.
 * `engine.ts` re-imports the ones it still references directly
 * (`readNonWorkInterests`, `readPersonaDraft`, `readPersonaReviewSubStep`,
 * `serializeDraft`) for its non-persona call sites. PURE MOVE — no logic
 * changes.
 */
export function readNonWorkInterests(
  obj: Record<string, unknown>,
): ReadonlyArray<{ name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' }> {
  const v = obj['non_work_interests']
  if (!Array.isArray(v)) return []
  const out: Array<{ name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' }> = []
  for (const raw of v) {
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed.length > 0) out.push({ name: trimmed })
      continue
    }
    if (typeof raw === 'object' && raw !== null) {
      const r = raw as Record<string, unknown>
      const name = typeof r['name'] === 'string' ? (r['name'] as string).trim() : ''
      if (name.length === 0) continue
      const cadence = r['cadence_hint']
      const entry: { name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' } = {
        name,
      }
      if (cadence === 'weekly' || cadence === 'monthly' || cadence === 'occasional') {
        entry.cadence_hint = cadence
      }
      out.push(entry)
    }
  }
  return out
}

/**
 * P2 v2 S8 — read non_work_interests off phase_state, normalizing to a
 * plain-string array of human-readable labels for the persona
 * generators. Per § 9.3 entries may be plain strings OR objects with
 * `{ name, cadence_hint? }`; the persona files only need the name. The
 * canonical structured reader is `readNonWorkInterests` above (used by
 * gap-fill merging); this thin wrapper picks the `name` out of each
 * structured entry and drops the cadence hint.
 */
export function readNonWorkInterestNames(
  phase_state: Record<string, unknown>,
): string[] | null {
  const structured = readNonWorkInterests(phase_state)
  if (structured.length === 0) return null
  const out: string[] = []
  for (const entry of structured) {
    const name = entry.name.trim()
    if (name.length > 0) out.push(name)
  }
  return out.length > 0 ? out : null
}

/**
 * T1 (2026-05-13) — persona helpers. Serialize / deserialize a
 * `PersonaDraft` into the JSON-typed `phase_state` so the dynamic
 * review prompt + sub-flow handlers can read it back across turns.
 */
export function serializeDraft(draft: PersonaDraft): Record<string, unknown> {
  return {
    project_slug: draft.project_slug,
    draft_id: draft.draft_id,
    soul_md: draft.soul_md,
    user_md: draft.user_md,
    priority_map_md: draft.priority_map_md,
    cringe_check_flags: draft.cringe_check_flags,
    regen_attempts: draft.regen_attempts,
    status: draft.status,
  }
}

export function readPersonaDraft(
  phase_state: Record<string, unknown>,
): PersonaDraft | null {
  const v = phase_state['persona_draft']
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (
    typeof o['project_slug'] !== 'string' ||
    typeof o['draft_id'] !== 'string' ||
    typeof o['soul_md'] !== 'string' ||
    typeof o['user_md'] !== 'string' ||
    typeof o['priority_map_md'] !== 'string'
  ) {
    return null
  }
  const flags = (o['cringe_check_flags'] ?? {}) as {
    soul?: number
    user?: number
    priority_map?: number
  }
  const attempts = (o['regen_attempts'] ?? {}) as {
    soul?: number
    user?: number
    priority_map?: number
  }
  const status = o['status']
  return {
    project_slug: o['project_slug'],
    draft_id: o['draft_id'],
    soul_md: o['soul_md'],
    user_md: o['user_md'],
    priority_map_md: o['priority_map_md'],
    cringe_check_flags: {
      soul: typeof flags.soul === 'number' ? flags.soul : 0,
      user: typeof flags.user === 'number' ? flags.user : 0,
      priority_map: typeof flags.priority_map === 'number' ? flags.priority_map : 0,
    },
    regen_attempts: {
      soul: typeof attempts.soul === 'number' ? attempts.soul : 0,
      user: typeof attempts.user === 'number' ? attempts.user : 0,
      priority_map: typeof attempts.priority_map === 'number' ? attempts.priority_map : 0,
    },
    status: status === 'committed' || status === 'manual_review' ? status : 'draft',
  }
}

export function readPersonaReviewSubStep(
  phase_state: Record<string, unknown>,
): PersonaReviewSubStep {
  const v = phase_state['persona_review_sub_step']
  if (
    v === 'pick_line' ||
    v === 'pick_replacement' ||
    v === 'pending_regen_hint'
  ) {
    return v
  }
  return 'idle'
}

/**
 * Build a `ComposeInput` from the captured interview state.
 *
 * P2 v2 § 7 + S8 — reads the v2 phase_state shape: `user_first_name`,
 * `agent_name`, `agent_personality`, `primary_projects[]`,
 * `non_work_interests[]`, `inner_circle[]`, `companies[]`,
 * `work_themes[]`, plus optional legacy fields (`rituals`,
 * `work_pattern`, `time_style`, `contemplative_phrases`).
 *
 * P2 v2 § 0 locked decision #9 + § 7.1 — `archetype_blend` derivation
 * is the responsibility of `PersonaComposer.compose`, NOT the engine.
 * The engine emits a `ComposeInput` that carries `signals.agent_personality`
 * (the free-text personality captured at `personality_offered`) and
 * leaves `archetype_blend` undefined; `PersonaComposer.deriveArchetypeBlend`
 * then runs `composeFromFreeText` against its own ArchetypeLibrary to
 * land curated voice fragments at synthesis time.
 */
export function buildComposeInput(
  project_slug: string,
  state: OnboardingState,
): PersonaComposeInput {
  const phase_state = state.phase_state as Record<string, unknown>
  // P2 v2 § 4.1 — the agent name comes from `agent_name`. The user's
  // first name is `user_first_name`. Display_name is the agent's voice
  // subject ("You are <agent>..."); for the v2 USER.md the user_first_name
  // anchors the document.
  const agent_name =
    readString(phase_state, 'agent_name') ?? readString(phase_state, 'tg_first_name') ?? ''
  const user_first_name = readString(phase_state, 'user_first_name')
  const agent_personality = readString(phase_state, 'agent_personality')
  const primary_projects = readStringArray(phase_state, 'primary_projects')
  const non_work_interests = readNonWorkInterestNames(phase_state)
  const work_themes = readStringArray(phase_state, 'work_themes')
  const companies = readStringArray(phase_state, 'companies')
  const inner_circle = readStringArray(phase_state, 'inner_circle')
  const rituals =
    readStringArray(phase_state, 'rituals_captured') ?? readStringArray(phase_state, 'rituals')
  const work_pattern = readString(phase_state, 'work_pattern')
  const time_style = readString(phase_state, 'time_style')
  // Item 5 (2026-06-19) — auto-detected browser timezone. Stamped onto
  // `phase_state.timezone` from the `?tz=` WS-upgrade param (client sends
  // `Intl.DateTimeFormat().resolvedOptions().timeZone`); rendered into
  // USER.md by persona-gen so the agent knows the user's timezone WITHOUT
  // ever asking. Null when the browser didn't report one / pre-stamp boots.
  const timezone = readString(phase_state, 'timezone')
  const contemplative_phrases = readStringArray(phase_state, 'contemplative_phrases')
  const regen_hint = readString(phase_state, 'persona_regen_hint')
  return {
    project_slug,
    signals: {
      display_name: agent_name,
      ...(user_first_name !== null ? { user_first_name } : {}),
      ...(agent_name.length > 0 ? { agent_name } : {}),
      ...(agent_personality !== null ? { agent_personality } : {}),
      ...(primary_projects !== null ? { primary_projects } : {}),
      ...(non_work_interests !== null ? { non_work_interests } : {}),
      ...(work_themes !== null ? { work_themes } : {}),
      ...(companies !== null ? { companies } : {}),
      ...(rituals !== null ? { rituals } : {}),
      ...(work_pattern !== null ? { work_pattern } : {}),
      ...(time_style !== null ? { time_style } : {}),
      ...(contemplative_phrases !== null ? { contemplative_phrases } : {}),
      ...(inner_circle !== null ? { inner_circle } : {}),
      ...(regen_hint !== null ? { regen_hint } : {}),
    },
    user_facts: {
      display_name: user_first_name ?? (agent_name.length > 0 ? agent_name : 'You'),
      ...(companies !== null ? { companies } : {}),
      ...(primary_projects !== null ? { primary_projects } : {}),
      ...(non_work_interests !== null ? { non_work_interests } : {}),
      ...(inner_circle !== null ? { inner_circle } : {}),
      ...(timezone !== null ? { timezone } : {}),
      ...(time_style !== null ? { preferences: [{ key: 'time_style', value: time_style }] } : {}),
    },
    priority_map: {
      programs: [],
      ...(primary_projects !== null ? { primary_projects } : {}),
      ...(work_themes !== null ? { work_themes } : {}),
      ...(inner_circle !== null ? { tier_1_people: inner_circle } : {}),
    },
    ...(regen_hint !== null ? { regen_hint } : {}),
  }
}

/**
 * Build a stub `PersonaDraft` used by the "Use a basic template" /
 * "Skip persona" fallback choices in `consumePersonaSynthesizingChoice`.
 * The stub has empty cringe-check flags + zero regen attempts; the
 * status records whether the user picked the template or the skip
 * path so downstream consumers can distinguish.
 */
export function stubDraft(
  project_slug: string,
  compose_input: PersonaComposeInput,
  picked:
    | typeof PERSONA_SYNTH_USE_BASIC
    | typeof PERSONA_SYNTH_SKIP,
): PersonaDraft {
  const display_name =
    compose_input.signals.display_name.length > 0
      ? compose_input.signals.display_name
      : 'You'
  const tag = picked === PERSONA_SYNTH_USE_BASIC ? 'basic-template' : 'skipped'
  const soul = `# SOUL.md\n\n_${tag}_\n\nVoice profile will be refined as you keep working with me.\n`
  const user = `# USER.md\n\n_${tag}_\n\n- **Name:** ${display_name}\n`
  const priority_map = `# priority-map.md\n\n_${tag}_\n\nPrograms will be ranked as you keep working with me.\n`
  return {
    project_slug,
    draft_id: `stub-${Date.now()}-${tag}`,
    soul_md: soul,
    user_md: user,
    priority_map_md: priority_map,
    cringe_check_flags: { soul: 0, user: 0, priority_map: 0 },
    regen_attempts: { soul: 0, user: 0, priority_map: 0 },
    status: 'draft',
  }
}

/**
 * 2026-05-27 — defensive clone for the character suggester static
 * fallback. `structuredClone` deep-copies the JSON-shaped static
 * fallback constant into the engine's state-store patch so a
 * future mutation of the assigned value can't corrupt the shared
 * module-level constant. `structuredClone` is sufficient — the shape
 * is pure JSON (no functions, no refs).
 */
export function cloneCharacterSuggestions(
  s: PersonalityCharacterSuggestions,
): PersonalityCharacterSuggestions {
  return structuredClone(s) as PersonalityCharacterSuggestions
}

/**
 * 2026-05-27 — defensive clone for the agent-name suggester static
 * fallback. Mirrors `cloneCharacterSuggestions` exactly so a downstream
 * mutation (e.g. a future caller pushing into `picks`) can't corrupt
 * the shared `STATIC_AGENT_NAME_FALLBACK` constant.
 */
export function cloneAgentNameSuggestions(
  s: AgentNameSuggestions,
): AgentNameSuggestions {
  return structuredClone(s) as AgentNameSuggestions
}

/**
 * Translate a typed `SlugPickerOutcome` rejection into a short,
 * user-facing reason string suitable for the re-prompt body.
 */
export function describeRejection(
  outcome: Extract<SlugPickerOutcome, { kind: 'rejected' }>,
): string {
  if (outcome.reason === 'sanitize_failed') {
    return 'That format is not valid. URLs are 3-30 chars, lowercase a-z 0-9 -.'
  }
  if (outcome.reason === 'unavailable') {
    const why = outcome.availability.reason
    if (why === 'taken') return "Someone's already using that one. Try another."
    if (why === 'reserved') return "That's reserved. Pick something else."
    if (why === 'in_history') return 'That URL was used recently and is in a 30-day cool-down.'
    if (why === 'invalid_format') {
      return 'That format is not valid. URLs are 3-30 chars, lowercase a-z 0-9 -.'
    }
    return 'That URL is not available. Try another.'
  }
  // rename_failed
  return `Rename failed (${outcome.code}). Try again or tap "Skip for now".`
}

/**
 * Structural surface of `InterviewEngine` consumed by the extracted
 * free functions in `engine-import-routing.ts` via their `self`
 * parameter. `InterviewEngine implements EngineInternals`. Declares
 * every field + cross-called method the extracted import-routing bodies
 * access through `this.` (now `self.`). PURE structural move — no new
 * behavior.
 */
export interface EngineInternals {
  readonly deps: InterviewEngineDeps
  now(): number
  uuid(): string

  // --- non-extracted cross-called methods ---
  emitPhasePrompt(input: {
    project_slug: string
    user_id: string
    topic_id: string
    phase: OnboardingPhase
    observed_at: number
    pre_send_state_upsert?: (prompt_id: string) => Promise<void>
    seed_suffix?: string
  }): Promise<{ prompt_id: string }>
  invalidateResolvedSpec(project_slug: string, phase: OnboardingPhase): void
  secretsIdentity(project_slug: string): string
  sendAgentText(
    input: AdvanceInput,
    phase: OnboardingPhase,
    body: string,
    observed_at: number,
  ): Promise<void>
  walkAutoSkip(
    project_slug: string,
    state: OnboardingState,
    observed_at: number,
  ): Promise<OnboardingState>

  // --- the 18 extracted import-routing methods (so free functions can
  //     cross-call each other via self.* identically to the originals) ---
  reconcileSwitchIntentFromFreeform(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<OnboardingState>
  reEmitImportSourceSelection(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult>
  consumeAiSubstrateOfferedChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult>
  emitImportOfferedPastePrompt(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
  ): Promise<AdvanceResult>
  reEmitImportOfferedPaste(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
    rejection: string | null,
  ): Promise<AdvanceResult>
  acceptPastedImportUrlAndStart(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
    url: string,
  ): Promise<AdvanceResult>
  advanceFromAiSubstrateOfferedToUpload(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    ai_substrate_used: 'chatgpt' | 'claude',
  ): Promise<AdvanceResult>
  advanceFromAiSubstrateOffered(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    opts: { skipped: boolean; source: ImportSource | null; job_id: string | null },
  ): Promise<AdvanceResult>
  pollImportRunningAndAdvance(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    opts?: { suppress_in_progress_status_emit?: boolean },
  ): Promise<AdvanceResult>
  attemptAutoResumeFromPaused(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
    prior_job_id: string,
    prior_job: ImportJob | null,
    opts?: { reset_cycle_counter?: boolean },
  ): Promise<{ state: OnboardingState } | null>
  degradeRateLimitExhausted(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    job_id: string,
    job: ImportJob,
    resume_count: number,
  ): Promise<AdvanceResult>
  advanceFromImportRunningOnComplete(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    import_result: ImportResult | null,
    partial: boolean,
    failure_reason?: string | null,
  ): Promise<AdvanceResult>
  consumeImportAnalysisPresentedChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult>
  emitImportRunningPromptSpec(
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
  ): Promise<AdvanceResult>
  consumeImportRunningChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult>
  retryImportRunning(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult>
  startImportAndAdvanceToRunning(
    advanceInput: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    effectiveSource: 'chatgpt' | 'claude',
  ): Promise<AdvanceResult>
  advanceToImportRunningFailed(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
    failure_reason: string,
  ): Promise<AdvanceResult>

  // --- R5 / audit P2-4 — non-extracted methods cross-called by the
  //     extracted persona free functions in `engine-persona.ts` ---
  getOrStartAgentNameSuggestions(
    project_slug: string,
    user_id: string,
    phase_state: Record<string, unknown>,
  ): Promise<AgentNameSuggesterResult> | null
  maybeAutoAdvancePastMaxOauthOffered(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<OnboardingState>

  // --- the 8 extracted persona methods (so the persona free functions
  //     can cross-call each other via self.* identically to the originals,
  //     and so non-persona engine code can reach them through the class) ---
  synthesizePersona(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<OnboardingState>
  consumePersonaReviewedChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult>
  consumePersonaSynthesizingChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult>
  advancePersonaSynthToReviewed(
    input: AdvanceInput,
    observed_at: number,
    serialized_draft: ReturnType<typeof serializeDraft> | null,
  ): Promise<AdvanceResult>
  advanceFromPersonaReviewed(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult>
  reEmitPersonaReviewed(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    patch: Record<string, unknown>,
  ): Promise<AdvanceResult>
  shouldRetrySynthesizePersonaOnResume(
    state: OnboardingState,
  ): Promise<boolean>
  consumePersonalityOfferedChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult>

  // --- R5 / audit P2-4 — fields + non-extracted methods cross-called by
  //     the extracted slug free functions in `engine-slug.ts` +
  //     `engine-agent-name.ts` (K11a5 split) ---
  readonly deploymentMode: OnboardingDeploymentMode
  readonly pendingCharacterSuggestions: Map<string, Promise<CharacterSuggesterResult>>
  readonly pendingAgentNameSuggestions: Map<string, Promise<AgentNameSuggesterResult>>
  clearPendingSuggestions(
    map: Map<string, Promise<unknown>>,
    project_slug: string,
    user_id: string,
    except?: string,
  ): void
  capPendingSuggestions(map: Map<string, Promise<unknown>>): void
  resolvePhasePromptSpec(
    project_slug: string,
    user_id: string,
    phase: OnboardingPhase,
  ): Promise<PhasePromptSpec | null>
  autoConfirmProjectsProposedAndAdvance(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult>
  advanceFromMaxOauthOffered(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    substrate: 'free' | 'byo_api_key' | 'max_oauth',
  ): Promise<AdvanceResult>

  // --- the 11 extracted slug methods (so the slug free functions can
  //     cross-call each other via self.* identically to the originals,
  //     and so non-slug engine code can reach them through the class) ---
  consumeAgentNameChosenChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult>
  getOrStartCharacterSuggestions(
    project_slug: string,
    user_id: string,
    phase_state: Record<string, unknown>,
  ): Promise<CharacterSuggesterResult> | null
  computeSlugSuggestionsForPhase(input: {
    project_slug: string
    agent_name: string | null
    user_first_name: string | null
  }): { primary: string | null; alts: ReadonlyArray<string> }
  consumeSlugChosenChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult>
  advanceFromSlugChosen(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    kept: boolean,
    new_slug?: string,
    emitNextPromptOnLiveSocket?: boolean,
    restartCommitted?: boolean,
  ): Promise<AdvanceResult>
  persistRejectionAndReEmit(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    reason: string,
  ): Promise<AdvanceResult>
  reEmitSlugChosen(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    reason: string | null,
  ): Promise<AdvanceResult>
  suggestionKeyPrefix(project_slug: string, user_id: string): string
  suggestionFingerprint(
    parts: ReadonlyArray<string | ReadonlyArray<string>>,
  ): string
}
