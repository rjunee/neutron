/**
 * @neutronai/onboarding/telemetry — event-emitter (P2 S6).
 *
 * Per docs/plans/P2-onboarding.md § 5 (telemetry / observability hooks
 * lines 1754-1808) + § 9.5 Pass-2 deepening (telemetry data schema
 * lines 2482-2625).
 *
 * Wraps two sinks:
 *   1. Structured-JSON log line via the injectable `EventLogger`. Production
 *      wires the gateway logger (writes to stdout / journald). Tests inject
 *      a recorder that captures lines for round-trip assertions.
 *   2. `gateway_events` SQLite row for the per-instance `onboarding_metrics`
 *      view. Both sinks are exercised on every `emit(...)` call.
 *
 * Per-event payload schemas are typed via a discriminated union so
 * downstream consumers (action runners, integration tests, the metrics
 * view) get type narrowing for free. The schema is the single source of
 * truth for what fields each event carries.
 *
 * Drift policy: every event in `OnboardingEventName` MUST appear in
 * `ALL_ONBOARDING_EVENT_NAMES`; the m2-telemetry-roundtrip integration
 * test asserts there is no drift between (a) the emitted log lines /
 * gateway_events rows and (b) this enum.
 */

import { randomUUID } from 'node:crypto'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { parseJsonColumn } from '@neutronai/persistence/index.ts'
import { SqliteOnboardingStateStore } from '../interview/sqlite-state-store.ts'

/**
 * Locked enum of every onboarding-domain event name. Adding a new event
 * means: (a) add it here, (b) add a payload shape to OnboardingEvent,
 * (c) emit it from the relevant code path. Removing one is a breaking
 * change — bump the schema version + update m2-telemetry-roundtrip
 * before landing.
 */
export type OnboardingEventName =
  | 'signup.started'
  | 'signup.oauth_complete'
  | 'signup.instance_provisioned'
  | 'onboarding.phase_advanced'
  | 'onboarding.button_emitted'
  | 'onboarding.button_chosen'
  | 'onboarding.button_freeform'
  | 'onboarding.button_timeout'
  | 'onboarding.import_started'
  | 'onboarding.import_pass1_chunk_done'
  | 'onboarding.import_pass2_complete'
  | 'onboarding.pass2_sonnet_fallback_used'
  | 'onboarding.archetype_picked'
  | 'onboarding.archetype_llm_extension'
  | 'onboarding.persona_drafted'
  | 'onboarding.persona_cringe_flagged'
  | 'onboarding.persona_regen'
  | 'onboarding.persona_committed'
  | 'onboarding.profile_pic_generated'
  | 'onboarding.profile_pic_user_uploaded'
  | 'onboarding.profile_pic_fallback'
  | 'onboarding.wow_dispatched'
  | 'onboarding.wow_action_fired'
  | 'onboarding.wow_action_engaged'
  | 'onboarding.wow_action_skipped'
  | 'onboarding.completed'
  | 'onboarding.abandoned'
  | 'onboarding.failed'
  | 'onboarding.sean_ellis_prompt_emitted'
  | 'onboarding.sean_ellis_response'

export const ALL_ONBOARDING_EVENT_NAMES: ReadonlyArray<OnboardingEventName> = [
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
  'onboarding.pass2_sonnet_fallback_used',
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
]

export type OnboardingEventLevel = 'info' | 'warn' | 'error'
export type OnboardingEventModule = 'onboarding' | 'signup'

/**
 * Routing rule: every event name has exactly one module. `signup.*` events
 * route to module='signup'; everything else to module='onboarding'. The
 * `onboarding_metrics` view filters on `module IN ('onboarding','signup')`
 * so both surfaces feed the same aggregate.
 */
export function moduleForEventName(name: OnboardingEventName): OnboardingEventModule {
  return name.startsWith('signup.') ? 'signup' : 'onboarding'
}

// --- Per-event payload schemas (discriminated union per § 9.5 Pass-2) -------

export interface SignupStartedPayload {
  via: 'tg' | 'web'
  referrer?: string
}

export interface SignupOauthCompletePayload {
  provider: 'google' | 'apple'
  oauth_user_id: string
}

export interface SignupInstanceProvisionedPayload {
  slug: string
  tier: string
  durationMs: number
}

export interface PhaseAdvancedPayload {
  from: string
  to: string
}

export interface ButtonEmittedPayload {
  prompt_id: string
  idempotency_collapsed: boolean
  options_count: number
}

export interface ButtonChosenPayload {
  prompt_id: string
  choice_value: string
  latency_ms: number
}

export interface ButtonFreeformPayload {
  prompt_id: string
  freeform_length: number
}

export interface ButtonTimeoutPayload {
  prompt_id: string
}

export interface ImportStartedPayload {
  source: string
  payload_size_bytes?: number
}

export interface ImportPass1ChunkDonePayload {
  source: string
  chunk_index: number
  chunk_dollars: number
}

export interface ImportPass2CompletePayload {
  source: string
  total_dollars: number
  entities: number
  projects: number
  tasks: number
}

/**
 * P2-v2 S21 (2026-05-17) — emitted exactly once per Pass-2 synthesis
 * call that fell back from the primary model (Opus 4.7) to the
 * secondary model (Sonnet 4.6) because the primary 429'd. Fires
 * BEFORE the Sonnet dispatch (so the event timestamp marks "noticed
 * the 429", not "Sonnet finished"). The `synthesizer_model` and
 * `primary_model` fields stamp the resolved model ids so the
 * metrics view can group by either dimension.
 *
 * Source: `buildPass2SubstrateCaller`'s 429 catch branch. NOT emitted
 * when the primary call succeeds first try (no fallback fired) nor
 * when both primary AND fallback fail (the runner's S13 retry loop
 * surfaces the failure as `onboarding.import_*` errors / `failed`
 * sub_step UX).
 */
export interface Pass2SonnetFallbackUsedPayload {
  reason: '429_exhausted_on_opus'
  source: string
  /** Model id that produced the synthesis (typically Sonnet 4.6). */
  synthesizer_model: string
  /** Primary model id that 429'd (typically Opus 4.7). */
  primary_model: string
  /** The original 429 message body for journald grep / debug. */
  primary_error_message: string
}

export interface ArchetypePickedPayload {
  archetype_slugs: string[]
  used_llm_extension: boolean
}

export interface ArchetypeLlmExtensionPayload {
  archetype_name: string
  cache_hit: boolean
}

export interface PersonaDraftedPayload {
  draft_id: string
  files: ReadonlyArray<'soul' | 'user' | 'priority_map'>
}

export interface PersonaCringeFlaggedPayload {
  file: 'soul' | 'user' | 'priority_map'
  flags: number
  reasons: string[]
}

export interface PersonaRegenPayload {
  file: 'soul' | 'user' | 'priority_map'
  attempt: number
}

export interface PersonaCommittedPayload {
  draft_id: string
  git_sha?: string
}

export interface ProfilePicGeneratedPayload {
  job_id: string
  candidate_count: number
}

export interface ProfilePicUserUploadedPayload {
  job_id: string
}

export interface ProfilePicFallbackPayload {
  job_id: string
  archetype_slug: string
}

export interface WowDispatchedPayload {
  fired_count: number
  total_actions: number
}

export interface WowActionFiredPayload {
  action_id: string
  success: boolean
  external_artifact_ids?: string[]
}

/**
 * Per Codex r3 P2 (2026-05-03): the WowTelemetry's `WowEngagement` enum
 * is the wider set ('read', 'scrolled', 'idle', 'kept', 'tweaked',
 * 'skipped', 'will_handle', 'snoozed', 'dropped', 'opened', 'sent',
 * 'discarded') — matching the per-action runner output. The
 * `OnboardingTelemetry` schema mirrors that set verbatim so the bridge
 * can pass values through without a lossy projection.
 */
export type WowActionEngagedKind =
  | 'read'
  | 'scrolled'
  | 'idle'
  | 'kept'
  | 'tweaked'
  | 'skipped'
  | 'will_handle'
  | 'snoozed'
  | 'dropped'
  | 'opened'
  | 'sent'
  | 'discarded'
  | 'tapped'
  | 'ignored'

export interface WowActionEngagedPayload {
  action_id: string
  engagement: WowActionEngagedKind
}

export interface WowActionSkippedPayload {
  action_id: string
  reason: string
}

export interface OnboardingCompletedPayload {
  time_to_wow_ms: number
  total_dollars: number
  wow_actions_fired: string[]
}

export interface OnboardingAbandonedPayload {
  last_phase: string
  gap_ms: number
}

export interface OnboardingFailedPayload {
  phase: string
  reason: string
}

export interface SeanEllisPromptEmittedPayload {
  prompt_id: string
  weeks_since_completed: number
}

export interface SeanEllisResponsePayload {
  response: 'very_disappointed' | 'somewhat_disappointed' | 'not_disappointed'
  freeform?: string
}

export type OnboardingEventPayloadByName = {
  'signup.started': SignupStartedPayload
  'signup.oauth_complete': SignupOauthCompletePayload
  'signup.instance_provisioned': SignupInstanceProvisionedPayload
  'onboarding.phase_advanced': PhaseAdvancedPayload
  'onboarding.button_emitted': ButtonEmittedPayload
  'onboarding.button_chosen': ButtonChosenPayload
  'onboarding.button_freeform': ButtonFreeformPayload
  'onboarding.button_timeout': ButtonTimeoutPayload
  'onboarding.import_started': ImportStartedPayload
  'onboarding.import_pass1_chunk_done': ImportPass1ChunkDonePayload
  'onboarding.import_pass2_complete': ImportPass2CompletePayload
  'onboarding.pass2_sonnet_fallback_used': Pass2SonnetFallbackUsedPayload
  'onboarding.archetype_picked': ArchetypePickedPayload
  'onboarding.archetype_llm_extension': ArchetypeLlmExtensionPayload
  'onboarding.persona_drafted': PersonaDraftedPayload
  'onboarding.persona_cringe_flagged': PersonaCringeFlaggedPayload
  'onboarding.persona_regen': PersonaRegenPayload
  'onboarding.persona_committed': PersonaCommittedPayload
  'onboarding.profile_pic_generated': ProfilePicGeneratedPayload
  'onboarding.profile_pic_user_uploaded': ProfilePicUserUploadedPayload
  'onboarding.profile_pic_fallback': ProfilePicFallbackPayload
  'onboarding.wow_dispatched': WowDispatchedPayload
  'onboarding.wow_action_fired': WowActionFiredPayload
  'onboarding.wow_action_engaged': WowActionEngagedPayload
  'onboarding.wow_action_skipped': WowActionSkippedPayload
  'onboarding.completed': OnboardingCompletedPayload
  'onboarding.abandoned': OnboardingAbandonedPayload
  'onboarding.failed': OnboardingFailedPayload
  'onboarding.sean_ellis_prompt_emitted': SeanEllisPromptEmittedPayload
  'onboarding.sean_ellis_response': SeanEllisResponsePayload
}

/**
 * The fully-typed event shape callers pass to `emit(...)`. The discriminator
 * is `event` (the name); per-event payload narrows automatically.
 *
 * Sprint 30 — `attempt_id` is the per-onboarding-attempt id surfaced from
 * `onboarding_state.attempt_id`. Optional on the event because most
 * call-sites resolve it from the per-instance store via the
 * `OnboardingTelemetryDeps.resolveAttemptId` hook. When neither is set,
 * the column defaults to `LEGACY_ATTEMPT_ID` (matches the migration's
 * NOT NULL DEFAULT). Tests that want to assert per-attempt grouping pass
 * it explicitly; production threads it via the resolver.
 */
export type OnboardingEvent = {
  [K in OnboardingEventName]: {
    ts?: number
    level?: OnboardingEventLevel
    project_slug: string
    user_id: string
    /** Sprint 30 — onboarding attempt correlator (groups view rows). */
    attempt_id?: string
    event: K
    payload: OnboardingEventPayloadByName[K]
    duration_ms?: number
  }
}[OnboardingEventName]

/**
 * Backfill default for events emitted before Sprint 30's per-attempt
 * tracking landed. Mirrors the migration's `attempt_id NOT NULL DEFAULT
 * 'legacy-pre-S30'` so historical rows + any callsite that hasn't been
 * threaded yet collapse to one stable bucket.
 */
export const LEGACY_ATTEMPT_ID = 'legacy-pre-S30'

/**
 * Persisted shape — what `gateway_events` rows look like + what the
 * structured-JSON sink writes. `module` is derived from `event` via
 * `moduleForEventName`; callers do not pass it.
 */
export interface PersistedOnboardingEvent {
  id: string
  ts: number
  level: OnboardingEventLevel
  project_slug: string
  user_id: string
  /** Sprint 30 — per-attempt correlator. Always populated on persist. */
  attempt_id: string
  module: OnboardingEventModule
  event: OnboardingEventName
  payload: Record<string, unknown>
  duration_ms?: number
}

/**
 * Hook for the structured-JSON log sink. Production wires a writer that
 * appends one JSON line to stdout (journald scrapes); tests inject a
 * recorder. The sink receives the same persisted shape that lands in
 * `gateway_events`.
 */
export interface EventLogger {
  (event: PersistedOnboardingEvent): void
}

export interface OnboardingTelemetryDeps {
  db: ProjectDb
  /** Optional structured-log sink. */
  eventLogger?: EventLogger
  /** Test seam for ids. */
  uuid?: () => string
  /** Test seam for clock. */
  now?: () => number
  /**
   * Sprint 30 — per-instance attempt-id resolver. When an event is emitted
   * without an explicit `attempt_id`, the telemetry awaits this resolver
   * (passing the event's project_slug + user_id) and stamps the result
   * onto the row. When the resolver is absent OR returns null, the
   * column falls back to `LEGACY_ATTEMPT_ID`.
   *
   * Production wires this via `gateway/wiring/build-landing-stack.ts`
   * to read `onboarding_state.attempt_id`. Tests may inject any pure
   * function (the m2-telemetry-roundtrip test asserts the resolver
   * stamps each event's attempt_id verbatim).
   */
  resolveAttemptId?: (input: {
    project_slug: string
    user_id: string
  }) => Promise<string | null> | string | null
}

/**
 * `OnboardingTelemetry` is the single seam for emitting onboarding-domain
 * events. Every code path that wants to record signup / onboarding /
 * import / wow / sean-ellis activity routes through this class.
 *
 * `emit` is async because the SQL write is async; callers should await
 * but the structured-JSON sink runs synchronously inside the call so the
 * stdout line is flushed before await resolves.
 */
export class OnboardingTelemetry {
  private readonly db: ProjectDb
  private readonly eventLogger?: EventLogger
  private readonly uuid: () => string
  private readonly now: () => number
  private readonly resolveAttemptId?: (input: {
    project_slug: string
    user_id: string
  }) => Promise<string | null> | string | null

  constructor(deps: OnboardingTelemetryDeps) {
    this.db = deps.db
    if (deps.eventLogger !== undefined) this.eventLogger = deps.eventLogger
    this.uuid = deps.uuid ?? randomUUID
    this.now = deps.now ?? ((): number => Date.now())
    if (deps.resolveAttemptId !== undefined) this.resolveAttemptId = deps.resolveAttemptId
  }

  async emit(event: OnboardingEvent): Promise<{ id: string }> {
    const id = this.uuid()
    const ts = event.ts ?? this.now()
    const level: OnboardingEventLevel = event.level ?? 'info'
    const module = moduleForEventName(event.event)
    const payload = event.payload as unknown as Record<string, unknown>
    let attempt_id: string
    if (typeof event.attempt_id === 'string' && event.attempt_id.length > 0) {
      attempt_id = event.attempt_id
    } else if (this.resolveAttemptId !== undefined) {
      const resolved = await this.resolveAttemptId({
        project_slug: event.project_slug,
        user_id: event.user_id,
      })
      attempt_id = resolved !== null && resolved !== undefined && resolved.length > 0
        ? resolved
        : LEGACY_ATTEMPT_ID
    } else {
      attempt_id = LEGACY_ATTEMPT_ID
    }
    const persisted: PersistedOnboardingEvent = {
      id,
      ts,
      level,
      project_slug: event.project_slug,
      user_id: event.user_id,
      attempt_id,
      module,
      event: event.event,
      payload,
    }
    if (event.duration_ms !== undefined) persisted.duration_ms = event.duration_ms

    await this.db.run(
      `INSERT INTO gateway_events
         (id, ts, level, project_slug, user_id, attempt_id, module, event_name, payload_json, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        ts,
        level,
        event.project_slug,
        event.user_id,
        attempt_id,
        module,
        event.event,
        JSON.stringify(payload),
        event.duration_ms ?? null,
      ],
    )
    if (this.eventLogger !== undefined) {
      try {
        this.eventLogger(persisted)
      } catch (_err) {
        // The SQL row already landed; a sink failure must not propagate.
        // Production wires a stdout writer that cannot fail; tests can
        // throw deliberately to assert the row is still recorded.
      }
    }
    return { id }
  }

  /**
   * Read-only convenience: list every event for an instance in ts ASC order.
   * Used by the m2-telemetry-roundtrip test + observability endpoint.
   */
  list(project_slug: string): PersistedOnboardingEvent[] {
    const rows = this.db.all<GatewayEventRow, [string]>(
      `SELECT id, ts, level, project_slug, user_id, attempt_id, module, event_name,
              payload_json, duration_ms
         FROM gateway_events
        WHERE project_slug = ?
        ORDER BY ts ASC, id ASC`,
      [project_slug],
    )
    return rows.map((r) => rowToPersistedEvent(r))
  }

  /**
   * Read-only convenience: the most-recent `limit` events for an instance,
   * NEWEST FIRST. Unlike `list()` (which reads the ENTIRE unbounded history and
   * is fine for the roundtrip test), this pushes `ORDER BY … DESC LIMIT ?` into
   * the DB so a long-lived instance's diagnostics hit reads + parses at most
   * `limit` rows. `limit <= 0` returns `[]`.
   */
  listRecent(project_slug: string, limit: number): PersistedOnboardingEvent[] {
    if (!Number.isFinite(limit) || limit <= 0) return []
    const rows = this.db.all<GatewayEventRow, [string, number]>(
      `SELECT id, ts, level, project_slug, user_id, attempt_id, module, event_name,
              payload_json, duration_ms
         FROM gateway_events
        WHERE project_slug = ?
        ORDER BY ts DESC, id DESC
        LIMIT ?`,
      [project_slug, Math.floor(limit)],
    )
    return rows.map((r) => rowToPersistedEvent(r))
  }
}

interface GatewayEventRow {
  id: string
  ts: number
  level: OnboardingEventLevel
  project_slug: string
  user_id: string
  attempt_id: string
  module: OnboardingEventModule
  event_name: OnboardingEventName
  payload_json: string
  duration_ms: number | null
}

function rowToPersistedEvent(r: GatewayEventRow): PersistedOnboardingEvent {
  const out: PersistedOnboardingEvent = {
    id: r.id,
    ts: r.ts,
    level: r.level,
    project_slug: r.project_slug,
    user_id: r.user_id,
    attempt_id: r.attempt_id,
    module: r.module,
    event: r.event_name,
    payload: parseJsonColumn(r.payload_json, { onCorrupt: 'throw' }) as Record<string, unknown>,
  }
  if (r.duration_ms !== null) out.duration_ms = r.duration_ms
  return out
}

/**
 * Production-shaped JSON-line writer for stdout. journald collects every
 * line and the m2-telemetry-roundtrip test in test-mode redirects via a
 * recording sink.
 */
export function buildStdoutEventLogger(write: (s: string) => void = (s) => {
  process.stdout.write(s)
}): EventLogger {
  return (event) => {
    write(JSON.stringify(event) + '\n')
  }
}

/**
 * P2-v2 S22 (2026-05-17) — production-shaped `OnboardingTelemetry`
 * factory the realmode composer + module graph share.
 *
 * Builds a telemetry with the standard `resolveAttemptId` hook (reads
 * `onboarding_state.attempt_id` for the instance; INSERT-OR-IGNOREs a
 * fresh row with a new UUID when none exists, so signup.* events that
 * fire BEFORE the engine's first upsert share the same attempt_id
 * bucket as the later interview events).
 *
 * Two consumers:
 *   1. Managed realmode composer (`buildDefaultRealModeComposer`) — constructs the
 *      telemetry early so it can thread the `importOnSonnetFallback`
 *      callback into `buildLandingStack`. The same instance is then
 *      passed to `composeProductionGraph` via
 *      `CompositionInput.onboarding_telemetry.instance` so the module
 *      graph reuses it (single source of truth).
 *   2. `gateway/composition.ts:onboardingTelemetryModule` — default-
 *      builds when no pre-built instance is supplied (backward-compat
 *      with tests + legacy callers).
 *
 * Both call sites previously inlined the `resolveAttemptId` transaction
 * — extracting it here keeps the two call sites in sync if the resolver
 * shape evolves (e.g. adding user_id to the keying scheme later).
 */
export function buildProductionOnboardingTelemetry(input: {
  db: import('@neutronai/persistence/index.ts').ProjectDb
  eventLogger?: EventLogger
}): OnboardingTelemetry {
  const deps: OnboardingTelemetryDeps = { db: input.db }
  if (input.eventLogger !== undefined) deps.eventLogger = input.eventLogger
  // P4 (table-ownership, 2026-07) — the mint-on-miss transaction moved
  // VERBATIM into the owning `onboarding_state` store
  // (SqliteOnboardingStateStore.resolveOrMintAttemptId); this factory no
  // longer writes the table directly (migrations/table-ownership.json).
  const stateStore = new SqliteOnboardingStateStore({ db: input.db })
  deps.resolveAttemptId = async ({ project_slug, user_id }) => {
    return stateStore.resolveOrMintAttemptId(project_slug, user_id)
  }
  return new OnboardingTelemetry(deps)
}
