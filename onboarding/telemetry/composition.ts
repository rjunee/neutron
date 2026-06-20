/**
 * @neutronai/onboarding/telemetry — composition / wiring helpers (P2 S6).
 *
 * Per Codex r1 review (2026-05-03 — three P1 findings about runtime wiring
 * the telemetry surface). The unit + integration tests in this sprint
 * exercise `OnboardingTelemetry` directly; the runtime modules
 * (`WowTelemetry`, `InterviewEngine`, `ImportJobRunner`,
 * `PersonaComposer`, `ProfilePicPipeline`) need bridges so their existing
 * event surfaces feed `gateway_events` / the `onboarding_metrics` view in
 * production.
 *
 * The bridges here:
 *
 *   1. `bridgeWowEventLogger(...)` — wraps an `OnboardingTelemetry` so it
 *      satisfies the `WowTelemetry.EventLogger` contract. Maps the wow
 *      event names ('onboarding.wow_action_fired' /
 *      'onboarding.wow_action_engaged') onto the typed
 *      `OnboardingEventName` union. Production passes the result as
 *      `WowTelemetryDeps.eventLogger`; the existing WowTelemetry already
 *      invokes the hook on every recordFired / recordEngaged.
 *
 *   2. `bridgeInterviewTelemetry(...)` — returns an
 *      `InterviewTelemetrySink` the engine calls at advance / button
 *      emit / button choose / button timeout. Production composes the
 *      InterviewEngine with this sink wrapping its sendButtonPrompt; tests
 *      can swap a recorder.
 *
 *   3. `bridgeImportTelemetry(...)` — returns an `ImportTelemetrySink`
 *      with the four import-related emitters (started / pass1_chunk_done
 *      / pass2_complete). Production wires the runner's
 *      job-status callbacks into this; tests can swap a recorder.
 *
 *   4. `bridgePersonaTelemetry(...)` + `bridgeProfilePicTelemetry(...)` +
 *      `bridgeArchetypeTelemetry(...)` + `bridgeSignupTelemetry(...)` —
 *      thin sinks the persona-gen / profile-pic / archetype library /
 *      signup post-router call from their existing hook points so each
 *      surface emits the right event without re-implementing the
 *      OnboardingTelemetry payload shapes inline.
 *
 * The point is: production composition (when the per-instance gateway
 * boots) calls `composeOnboardingTelemetrySinks(...)` once with the
 * shared `OnboardingTelemetry` and gets back a single bag of typed
 * sinks ready to inject into each module. Tests can use the same
 * bag (the m2-casey-fixture integration test does).
 */

import type { EventLogger as WowEventLogger } from '../wow-moment/telemetry.ts'
import type {
  OnboardingEventName,
  OnboardingTelemetry,
  PhaseAdvancedPayload,
  WowActionEngagedKind,
} from './event-emitter.ts'

/**
 * Coerce a free-form event name from one of the existing module surfaces
 * (wow-moment, persona-gen, profile-pic, etc.) onto the typed
 * `OnboardingEventName` union. Throws if the name isn't in the schema —
 * the goal is to fail loudly during composition, not silently in
 * production.
 */
const KNOWN_EVENT_NAMES: ReadonlySet<OnboardingEventName> = new Set<OnboardingEventName>([
  'signup.started',
  'signup.oauth_complete',
  'signup.instance_provisioned',
  'onboarding.phase_advanced',
  'onboarding.button_emitted',
  'onboarding.button_chosen',
  'onboarding.button_freeform',
  'onboarding.button_timeout',
  'onboarding.import_started',
  'onboarding.import_pass1_chunk_done',
  'onboarding.import_pass2_complete',
  'onboarding.archetype_picked',
  'onboarding.archetype_llm_extension',
  'onboarding.persona_drafted',
  'onboarding.persona_cringe_flagged',
  'onboarding.persona_regen',
  'onboarding.persona_committed',
  'onboarding.profile_pic_generated',
  'onboarding.profile_pic_user_uploaded',
  'onboarding.profile_pic_fallback',
  'onboarding.wow_dispatched',
  'onboarding.wow_action_fired',
  'onboarding.wow_action_engaged',
  'onboarding.wow_action_skipped',
  'onboarding.completed',
  'onboarding.abandoned',
  'onboarding.failed',
  'onboarding.sean_ellis_prompt_emitted',
  'onboarding.sean_ellis_response',
])

function asOnboardingEventName(name: string): OnboardingEventName | null {
  return KNOWN_EVENT_NAMES.has(name as OnboardingEventName)
    ? (name as OnboardingEventName)
    : null
}

/**
 * `WowTelemetry`'s eventLogger fires with `{event, payload}`; the wow
 * module already includes `project_slug` + `user_engagement` /
 * `success_reason` / `action_id` etc. inside `payload`. The bridge pulls
 * those forward into the typed `OnboardingTelemetry.emit(...)` call.
 *
 * Wow tenancy → user_id mapping: WowTelemetry doesn't carry user_id; the
 * bridge takes it from the caller-supplied `defaults.user_id` (set when
 * the per-instance onboarding pipeline composes its WowDispatcher).
 */
export interface BridgeWowDefaults {
  user_id: string
}

export function bridgeWowEventLogger(
  telemetry: OnboardingTelemetry,
  defaults: BridgeWowDefaults,
): WowEventLogger {
  return async ({ event, payload }) => {
    const onboardingName = asOnboardingEventName(event)
    if (onboardingName === null) return
    const project_slug = typeof payload.project_slug === 'string' ? payload.project_slug : null
    if (project_slug === null) return
    if (onboardingName === 'onboarding.wow_action_fired') {
      const action_id = typeof payload.action_id === 'string' ? payload.action_id : '<unknown>'
      const success = typeof payload.success === 'boolean' ? payload.success : false
      await telemetry.emit({
        project_slug,
        user_id: defaults.user_id,
        event: 'onboarding.wow_action_fired',
        payload: { action_id, success },
      })
      return
    }
    if (onboardingName === 'onboarding.wow_action_engaged') {
      const action_id = typeof payload.action_id === 'string' ? payload.action_id : '<unknown>'
      // Codex r3 P2 fix (2026-05-03): pass the engagement value through
      // verbatim so the wider WowEngagement enum (`read`, `tweaked`,
      // `opened`, `discarded`, `will_handle`, etc.) round-trips through
      // the bridge without lossy projection. The
      // `OnboardingTelemetry.WowActionEngagedKind` enum mirrors the
      // wow side set verbatim.
      const engagement = typeof payload.engagement === 'string' ? payload.engagement : 'kept'
      await telemetry.emit({
        project_slug,
        user_id: defaults.user_id,
        event: 'onboarding.wow_action_engaged',
        payload: {
          action_id,
          engagement: engagement as WowActionEngagedKind,
        },
      })
      return
    }
    // Other wow events (skipped / dispatched) are emitted by the
    // dispatcher composition layer separately so they reflect the
    // dispatcher's view, not the runner's.
  }
}

// ---------- Per-surface sinks the existing modules call ----------------------

export interface InterviewTelemetrySink {
  phaseAdvanced(input: { project_slug: string; user_id: string; from: string; to: string }): Promise<void>
  buttonEmitted(input: {
    project_slug: string
    user_id: string
    prompt_id: string
    idempotency_collapsed: boolean
    options_count: number
  }): Promise<void>
  buttonChosen(input: {
    project_slug: string
    user_id: string
    prompt_id: string
    choice_value: string
    latency_ms: number
  }): Promise<void>
  buttonFreeform(input: {
    project_slug: string
    user_id: string
    prompt_id: string
    freeform_length: number
  }): Promise<void>
  buttonTimeout(input: { project_slug: string; user_id: string; prompt_id: string }): Promise<void>
}

export function bridgeInterviewTelemetry(telemetry: OnboardingTelemetry): InterviewTelemetrySink {
  return {
    phaseAdvanced: async ({ project_slug, user_id, from, to }) => {
      const payload: PhaseAdvancedPayload = { from, to }
      await telemetry.emit({
        project_slug,
        user_id,
        event: 'onboarding.phase_advanced',
        payload,
      })
    },
    buttonEmitted: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.button_emitted',
        payload: {
          prompt_id: input.prompt_id,
          idempotency_collapsed: input.idempotency_collapsed,
          options_count: input.options_count,
        },
      })
    },
    buttonChosen: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.button_chosen',
        payload: {
          prompt_id: input.prompt_id,
          choice_value: input.choice_value,
          latency_ms: input.latency_ms,
        },
      })
    },
    buttonFreeform: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.button_freeform',
        payload: {
          prompt_id: input.prompt_id,
          freeform_length: input.freeform_length,
        },
      })
    },
    buttonTimeout: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.button_timeout',
        payload: { prompt_id: input.prompt_id },
      })
    },
  }
}

export interface ImportTelemetrySink {
  started(input: {
    project_slug: string
    user_id: string
    source: string
    payload_size_bytes?: number
  }): Promise<void>
  pass1ChunkDone(input: {
    project_slug: string
    user_id: string
    source: string
    chunk_index: number
    chunk_dollars: number
  }): Promise<void>
  pass2Complete(input: {
    project_slug: string
    user_id: string
    source: string
    total_dollars: number
    entities: number
    projects: number
    tasks: number
  }): Promise<void>
}

export function bridgeImportTelemetry(telemetry: OnboardingTelemetry): ImportTelemetrySink {
  return {
    started: async ({ project_slug, user_id, source, payload_size_bytes }) => {
      await telemetry.emit({
        project_slug,
        user_id,
        event: 'onboarding.import_started',
        payload:
          payload_size_bytes !== undefined
            ? { source, payload_size_bytes }
            : { source },
      })
    },
    pass1ChunkDone: async ({ project_slug, user_id, source, chunk_index, chunk_dollars }) => {
      await telemetry.emit({
        project_slug,
        user_id,
        event: 'onboarding.import_pass1_chunk_done',
        payload: { source, chunk_index, chunk_dollars },
      })
    },
    pass2Complete: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.import_pass2_complete',
        payload: {
          source: input.source,
          total_dollars: input.total_dollars,
          entities: input.entities,
          projects: input.projects,
          tasks: input.tasks,
        },
      })
    },
  }
}

export interface PersonaTelemetrySink {
  drafted(input: {
    project_slug: string
    user_id: string
    draft_id: string
    files: ReadonlyArray<'soul' | 'user' | 'priority_map'>
  }): Promise<void>
  cringeFlagged(input: {
    project_slug: string
    user_id: string
    file: 'soul' | 'user' | 'priority_map'
    flags: number
    reasons: string[]
  }): Promise<void>
  regen(input: {
    project_slug: string
    user_id: string
    file: 'soul' | 'user' | 'priority_map'
    attempt: number
  }): Promise<void>
  committed(input: {
    project_slug: string
    user_id: string
    draft_id: string
    git_sha?: string
  }): Promise<void>
}

export function bridgePersonaTelemetry(telemetry: OnboardingTelemetry): PersonaTelemetrySink {
  return {
    drafted: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.persona_drafted',
        payload: { draft_id: input.draft_id, files: input.files },
      })
    },
    cringeFlagged: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.persona_cringe_flagged',
        payload: { file: input.file, flags: input.flags, reasons: input.reasons },
      })
    },
    regen: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.persona_regen',
        payload: { file: input.file, attempt: input.attempt },
      })
    },
    committed: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.persona_committed',
        payload:
          input.git_sha !== undefined
            ? { draft_id: input.draft_id, git_sha: input.git_sha }
            : { draft_id: input.draft_id },
      })
    },
  }
}

export interface ProfilePicTelemetrySink {
  generated(input: {
    project_slug: string
    user_id: string
    job_id: string
    candidate_count: number
  }): Promise<void>
  userUploaded(input: { project_slug: string; user_id: string; job_id: string }): Promise<void>
  fallback(input: {
    project_slug: string
    user_id: string
    job_id: string
    archetype_slug: string
  }): Promise<void>
}

export function bridgeProfilePicTelemetry(
  telemetry: OnboardingTelemetry,
): ProfilePicTelemetrySink {
  return {
    generated: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.profile_pic_generated',
        payload: { job_id: input.job_id, candidate_count: input.candidate_count },
      })
    },
    userUploaded: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.profile_pic_user_uploaded',
        payload: { job_id: input.job_id },
      })
    },
    fallback: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.profile_pic_fallback',
        payload: { job_id: input.job_id, archetype_slug: input.archetype_slug },
      })
    },
  }
}

export interface ArchetypeTelemetrySink {
  picked(input: {
    project_slug: string
    user_id: string
    archetype_slugs: string[]
    used_llm_extension: boolean
  }): Promise<void>
  llmExtension(input: {
    project_slug: string
    user_id: string
    archetype_name: string
    cache_hit: boolean
  }): Promise<void>
}

export function bridgeArchetypeTelemetry(telemetry: OnboardingTelemetry): ArchetypeTelemetrySink {
  return {
    picked: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.archetype_picked',
        payload: {
          archetype_slugs: input.archetype_slugs,
          used_llm_extension: input.used_llm_extension,
        },
      })
    },
    llmExtension: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.archetype_llm_extension',
        payload: { archetype_name: input.archetype_name, cache_hit: input.cache_hit },
      })
    },
  }
}

export interface SignupTelemetrySink {
  started(input: {
    project_slug: string
    user_id: string
    via: 'tg' | 'web'
    referrer?: string
  }): Promise<void>
  oauthComplete(input: {
    project_slug: string
    user_id: string
    provider: 'google' | 'apple'
    oauth_user_id: string
  }): Promise<void>
  instanceProvisioned(input: {
    project_slug: string
    user_id: string
    slug: string
    tier: string
    durationMs: number
  }): Promise<void>
}

export function bridgeSignupTelemetry(telemetry: OnboardingTelemetry): SignupTelemetrySink {
  return {
    started: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'signup.started',
        payload:
          input.referrer !== undefined
            ? { via: input.via, referrer: input.referrer }
            : { via: input.via },
      })
    },
    oauthComplete: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'signup.oauth_complete',
        payload: { provider: input.provider, oauth_user_id: input.oauth_user_id },
      })
    },
    instanceProvisioned: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'signup.instance_provisioned',
        payload: { slug: input.slug, tier: input.tier, durationMs: input.durationMs },
      })
    },
  }
}

export interface CompletionTelemetrySink {
  wowDispatched(input: {
    project_slug: string
    user_id: string
    fired_count: number
    total_actions: number
  }): Promise<void>
  completed(input: {
    project_slug: string
    user_id: string
    time_to_wow_ms: number
    total_dollars: number
    wow_actions_fired: string[]
  }): Promise<void>
  abandoned(input: {
    project_slug: string
    user_id: string
    last_phase: string
    gap_ms: number
  }): Promise<void>
  failed(input: {
    project_slug: string
    user_id: string
    phase: string
    reason: string
  }): Promise<void>
}

export function bridgeCompletionTelemetry(telemetry: OnboardingTelemetry): CompletionTelemetrySink {
  return {
    wowDispatched: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.wow_dispatched',
        payload: { fired_count: input.fired_count, total_actions: input.total_actions },
      })
    },
    completed: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.completed',
        payload: {
          time_to_wow_ms: input.time_to_wow_ms,
          total_dollars: input.total_dollars,
          wow_actions_fired: input.wow_actions_fired,
        },
      })
    },
    abandoned: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.abandoned',
        payload: { last_phase: input.last_phase, gap_ms: input.gap_ms },
      })
    },
    failed: async (input) => {
      await telemetry.emit({
        project_slug: input.project_slug,
        user_id: input.user_id,
        event: 'onboarding.failed',
        payload: { phase: input.phase, reason: input.reason },
      })
    },
  }
}

/**
 * `composeOnboardingTelemetrySinks` — single composition seam the per-
 * instance gateway boot calls when wiring the onboarding pipeline. Returns
 * a bag of typed sinks; each sink targets one of the existing onboarding
 * modules' natural hook points.
 *
 * Production wiring is a follow-up sprint (S6.1) per the same deferred-
 * route pattern as P2 S2/S3/S4/S5: the surfaces are locked, the bridges
 * compose cleanly, and the actual `gateway/composition.ts` integration
 * lands alongside the P8 admin UI (which consumes the same telemetry).
 */
export interface ComposedTelemetrySinks {
  signup: SignupTelemetrySink
  interview: InterviewTelemetrySink
  archetype: ArchetypeTelemetrySink
  import: ImportTelemetrySink
  persona: PersonaTelemetrySink
  profile_pic: ProfilePicTelemetrySink
  completion: CompletionTelemetrySink
  /** Wow event-logger bound to the per-instance onboarding flow's `user_id`. */
  wowEventLogger: (defaults: BridgeWowDefaults) => WowEventLogger
}

export function composeOnboardingTelemetrySinks(
  telemetry: OnboardingTelemetry,
): ComposedTelemetrySinks {
  return {
    signup: bridgeSignupTelemetry(telemetry),
    interview: bridgeInterviewTelemetry(telemetry),
    archetype: bridgeArchetypeTelemetry(telemetry),
    import: bridgeImportTelemetry(telemetry),
    persona: bridgePersonaTelemetry(telemetry),
    profile_pic: bridgeProfilePicTelemetry(telemetry),
    completion: bridgeCompletionTelemetry(telemetry),
    wowEventLogger: (defaults) => bridgeWowEventLogger(telemetry, defaults),
  }
}
