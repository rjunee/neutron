/**
 * @neutronai/onboarding/interview — LLM-driven conversational onboarding driver.
 *
 * Sprint: M2 — onboarding goes conversational (2026-05-10). Replaces the
 * hardcoded multi-choice prompt table with a Haiku-4.5-driven driver that
 * lets the user reply in natural language and uses the LLM to extract the
 * structured fields the engine needs.
 *
 * Architecture roots: `docs/research/onboarding-llm-prompts-architecture-2026-05-09.md`
 * (Atlas designed exactly this seam — `PhaseSpecResolver` + fallback
 * contract — the day before this sprint).
 *
 * Public surface:
 *   - `generatePromptForPhase({...})` — single entry point. Returns the
 *     `PhasePromptSpec` the engine will emit, plus optional
 *     `extracted_fields` + `persona_acknowledgment` the engine writes
 *     back to `phase_state`.
 *   - `STATIC_PHASE_SPECS` — deterministic short-question fallback table.
 *     Used when the LLM call fails, the resolver is unwired, or the phase
 *     is not in the enabled set. NEVER ships A/B/C menus. All entries are
 *     free-text by default; the engine wins the routing argument.
 *   - `PHASE_GOALS` — eagerly-loaded markdown registry of per-phase goals.
 *     Drives the LLM system prompt. Edit `phase-goals.md` to change tone.
 *
 * Fallback contract (per task brief 2026-05-10): on ANY LLM error (timeout,
 * API error, malformed JSON, schema validation fail), the driver returns
 * the static fallback for that phase. The fallback copy is short, plain-
 * language, and has zero menu options. The user is never stranded.
 *
 * Model: the driver itself is model-agnostic — it takes an `llm: LlmCallFn`
 * dep and the concrete model is bound where that closure is constructed.
 * Production wires it via `buildPhaseSpecResolver` →
 * `buildAnthropicLlmCall({ model: BEST_MODEL })`, so every driven phase
 * (including `work_interview_gap_fill`) runs on `BEST_MODEL` (Opus 4.7 by
 * default; override via `NEUTRON_BEST_MODEL`) since the 2026-05-31
 * CC-substrate migration. Pre-migration this was `FAST_MODEL` (Haiku 4.5).
 * Per-call estimate (Atlas spec § 6.2): ~650 input + 200 output tokens; at
 * Opus 4.7 pricing ($15/$75/M) ≈ $0.025 per call (~$0.4 per full onboard).
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OnboardingPhase } from './phase.ts'
import { STATIC_PHASE_SPECS, type PhasePromptSpec } from './phase-prompts.ts'
import {
  buildLlmPhaseSpecResolver,
  parseLlmSpec,
  type LlmCallFn,
  type PhaseContextBundle,
  type PhaseIntent,
  type PhaseSpecResolver,
} from './phase-spec-resolver.ts'
import { RESERVED_OPTION_VALUES } from '../../channels/button-primitive.ts'
import { auditRequiredFields, type RequiredField } from './required-fields-audit.ts'
import { CONVERSATIONAL_TIMEOUT_MS_DEFAULT } from './llm-timeouts.ts'

// Re-export for callers that import everything from the driver module.
// Keeps the public surface focused on the driver while letting the
// canonical table live in `phase-prompts.ts` (avoids a circular import
// with `phase-spec-resolver.ts` which needs the table for routing
// fields).
export { STATIC_PHASE_SPECS }

// ---------------------------------------------------------------------------
// Phase goals — eagerly loaded markdown
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PHASE_GOALS_PATH = join(__dirname, 'phase-goals.md')

/**
 * Sprint A.1 — GBrain methodology integration v2 (2026-05-12).
 *
 * Per Garry's thin-harness / fat-skills split, the onboarding agent's
 * system-prompt envelope (the scaffolding around the per-phase
 * `goal`) is markdown loaded from `onboarding/interview/skills/_envelope.md`
 * rather than a TS string literal. Renderer below replaces the
 * `{{phase}}` / `{{goal}}` / `{{allowed_hint}}` / `{{max_body_chars}}` /
 * `{{static_next}}` placeholders.
 *
 * Routing tables (`PHASE_INTENTS`, `decideNextPhase`) stay in TS — they
 * are fat-code lookup tables, not judgment.
 */
const SYSTEM_PROMPT_ENVELOPE_PATH = join(__dirname, 'skills', '_envelope.md')

/**
 * Map of `OnboardingPhase` → markdown body of that phase's goal section.
 * Parsed once at process start from `phase-goals.md`. Used by the LLM
 * driver to seed the system prompt for each phase. If a phase is enabled
 * for LLM-rephrasing but has no entry here, `generatePromptForPhase`
 * throws at startup so the operator sees the misconfiguration immediately.
 *
 * Exported so the snapshot test can assert every active phase has a
 * goal entry without re-parsing the file.
 */
export const PHASE_GOALS: Readonly<Record<string, string>> = (() => {
  let raw: string
  try {
    raw = readFileSync(PHASE_GOALS_PATH, 'utf8')
  } catch (err) {
    // In tests we may run the driver without the markdown file present
    // (e.g. when only importing types). Failing the import would cascade
    // into every consumer; instead return an empty registry and let the
    // driver throw at call time when a specific phase is requested.
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
      return Object.freeze({}) as Readonly<Record<string, string>>
    }
    throw err
  }
  const out: Record<string, string> = {}
  // Parse `## <phase-name>` sections. Phase names are kebab-/snake-case
  // and may legitimately contain underscores; `_chosen` etc.
  const lines = raw.split('\n')
  let current_phase: string | null = null
  let buf: string[] = []
  for (const line of lines) {
    const match = line.match(/^##\s+([a-z_]+)\s*$/)
    if (match !== null) {
      if (current_phase !== null) {
        out[current_phase] = buf.join('\n').trim()
      }
      current_phase = match[1] ?? null
      buf = []
    } else if (current_phase !== null) {
      buf.push(line)
    }
  }
  if (current_phase !== null) {
    out[current_phase] = buf.join('\n').trim()
  }
  return Object.freeze(out)
})()

// Static fallback table is canonical in `phase-prompts.ts` and re-
// exported above. Documented here so callers searching for the table
// land on the right symbol.

// ---------------------------------------------------------------------------
// Driver input / output types
// ---------------------------------------------------------------------------

/**
 * Fields the LLM may extract from the user's most recent free-text reply.
 * The engine reads these out and writes them to `phase_state` so downstream
 * phases (slug suggestion, persona seed) can reference them without re-
 * deriving from the raw transcript.
 *
 * All fields are optional. The LLM only includes a field when it has high
 * confidence the user supplied a value.
 */
export interface ExtractedFields {
  /**
   * Agent's name as chosen by the user. v1 also reused this field for the
   * USER's first name at signup (the v1 signup prompt was ambiguous —
   * "What should I call you?" could be parsed either way). v2 introduces
   * the dedicated `user_first_name` field below and shifts agent-naming
   * to `agent_name_chosen` per § 3.10. Both shapes are still accepted by
   * the engine's signup advance gate so the v2 LLM rephrase doesn't
   * regress v1-pattern responses.
   */
  agent_name?: string
  /** Slug the user wants for their personal URL. Raw — engine sanitizes. */
  slug?: string
  /** Character/persona archetype names the user named. */
  archetypes?: ReadonlyArray<string>
  /** One-line description of the user's primary goal/use-case. */
  goal_one_liner?: string
  /**
   * P2 v2 § 3.1 (S3, 2026-05-16) — the user's first name, captured at
   * `signup`. Engine writes this to `phase_state.user_first_name` AND
   * mirrors to the owner record via the `personaSync.recordUserFirstName`
   * hook. The dual-store write is intentional: `phase_state` is the
   * working state during onboarding; the owner table is the indexed lookup
   * downstream services (slug suggestion seed, USER.md generator,
   * persona-gen) read from.
   *
   * Extraction rules (from the system prompt at signup): if the user
   * gave a full name, take the first whitespace-separated token. Reject
   * stop-words ("yes", "ok", "what", "idk"); reject anything that
   * doesn't match `/^\p{L}[\p{L}' -]{0,31}$/u` after first-token slice.
   * Validation happens in the engine — the LLM is encouraged to emit
   * what it heard; the engine has the final say.
   */
  user_first_name?: string
  /**
   * P2 v2 § 3.8 / § 9.3 (S6, 2026-05-16) — gap-fill extraction surface.
   *
   * The `work_interview_gap_fill` phase asks one conversational question
   * per turn. The user's reply may legitimately carry MULTIPLE fields
   * ("Building Topline and Acme, also writing a book; outside work I
   * climb"). The driver pulls each one out into the corresponding key
   * below and the engine merges (NOT overwrites) into `phase_state`.
   *
   * Extraction rules:
   *   - Names land VERBATIM (the spec's "they're signals from the user's
   *     own data, don't rephrase" rule). The driver only trims + drops
   *     empty entries.
   *   - For optional fields the LLM is conservative: only include when
   *     the user clearly volunteered the value; omit otherwise.
   *   - Plain-string arrays cap at 8 entries; objects (non_work_interests)
   *     cap at 6. The engine's audit only needs ≥3 / ≥1 — the cap is
   *     defense-in-depth against a runaway extraction.
   *
   * S5+ phases (import_analysis_presented, work_interview_gap_fill) read
   * these keys back via the engine's `consumePendingExtractedFields` drain.
   */
  primary_projects?: ReadonlyArray<string>
  /**
   * GAP1 (onboarding-wow-handoff-fix, 2026-06-09) — explicit project
   * removals. The `projects_proposed` / `import_analysis_presented`
   * confirm-merge is ADDITIVE: `primary_projects` is unioned with the
   * already-seeded list so a confirm reply can never silently SHRINK the
   * list (Sam's 7→3 regression). Omitting a project from
   * `primary_projects` therefore does NOT remove it. When the user
   * EXPLICITLY asks to drop / skip / remove a project ("drop the personal
   * one", "skip Biohacking"), the LLM names it here; the engine subtracts
   * `removed_projects` from the union (case-insensitive). This is the
   * brief's "union(presented, extracted) minus explicit removals" — and
   * resolves the self-contradiction Argus r1 flagged (the extraction
   * contract used to tell the LLM to OMIT removed projects, which the
   * additive union then re-added). Conservative: only populate on a clear
   * removal request.
   */
  removed_projects?: ReadonlyArray<string>
  non_work_interests?: ReadonlyArray<{
    name: string
    cadence_hint?: 'weekly' | 'monthly' | 'occasional'
  }>
  agent_personality?: string
  time_style?: string
  work_pattern?: string
  rituals?: ReadonlyArray<string>
  inner_circle?: ReadonlyArray<string>
  companies?: ReadonlyArray<string>
  user_supplied_corrections?: ReadonlyArray<string>
}

/**
 * The engine-facing return shape: the existing `PhasePromptSpec` plus the
 * extracted fields and (optional) human-readable acknowledgment of what
 * the agent heard.
 *
 * The `body` field already includes the acknowledgment when present (the
 * driver prepends it). `persona_acknowledgment` is exposed separately
 * for observability + downstream callers that want to display the
 * acknowledgment differently.
 */
export interface DrivenPhasePromptSpec extends PhasePromptSpec {
  /** Optional extracted fields from the user's prior reply. */
  extracted_fields?: ExtractedFields
  /** Human-readable echo of what the agent heard. Already prepended to
   *  body when present. */
  persona_acknowledgment?: string
  /** True when the static fallback was used (LLM unwired, phase not
   *  enabled, model error). The engine logs this for observability. */
  is_fallback: boolean
}

export interface GeneratePromptInput {
  /** Phase about to emit. */
  phase: OnboardingPhase
  /** Resolved channel: tells the LLM whether to suggest using the user's
   *  Telegram display name in the opening question. */
  signup_via: 'telegram' | 'web'
  /** `phase_state` blob from the persisted onboarding state row. Fields
   *  the driver reads: `agent_name`, `archetype_hint`, `suggested_slug`,
   *  `chosen_slug`, `tg_first_name`, `attempt_count`, `rejection_reason`. */
  phase_state: Record<string, unknown>
  /** Recent transcript turns (agent + user lines only). Default 6 turns. */
  transcript_so_far: ReadonlyArray<{
    role: 'agent' | 'user'
    body: string
    phase: OnboardingPhase
  }>
  /** `web:<user_id>` or `tg:<chat_id>:<thread_id>`. Pass-through for
   *  typing-indicator callbacks. */
  topic_id?: string
  user_id?: string
  /** When the channel adapter passed `tg_first_name` on `engine.start(...)`
   *  but the engine has not yet written it into `phase_state`, the caller
   *  threads it here so the very first emit picks it up. */
  tg_first_name_override?: string | null
}

export interface GeneratePromptDeps {
  /** When omitted, the driver returns the static fallback. */
  llm?: LlmCallFn
  /**
   * Phases enabled for LLM rephrasing. When the requested phase is NOT in
   * this set, the driver returns the static fallback. Empty by default.
   */
  enabled_phases?: ReadonlySet<OnboardingPhase>
  timeout_ms?: number
  log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    meta?: Record<string, unknown>,
  ) => void
  onLlmStart?: (bundle: PhaseContextBundle) => void
  onLlmEnd?: (
    bundle: PhaseContextBundle,
    outcome: { ok: boolean; reason?: string },
  ) => void
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Single entry point the engine calls at every prompt-emit. Asks the LLM
 * to generate a natural-language prompt body for the requested phase, with
 * the user's recent transcript turns + captured fields fed in as context.
 *
 * Returns the static fallback spec for this phase whenever:
 *   - `deps.llm` is unwired
 *   - `deps.enabled_phases` is empty or doesn't include this phase
 *   - the LLM call times out, errors, returns malformed JSON, or violates
 *     the option-allow-list contract
 *
 * The static fallback is a short plain-language question with zero menu
 * options. The user is never stranded.
 */
export async function generatePromptForPhase(
  input: GeneratePromptInput,
  deps: GeneratePromptDeps,
): Promise<DrivenPhasePromptSpec> {
  const fallback = STATIC_PHASE_SPECS[input.phase] ?? null
  if (fallback === null) {
    throw new Error(
      `generatePromptForPhase: no static fallback for phase=${input.phase} ` +
      `(engine should not invoke driver for externally-driven phases)`,
    )
  }

  // LLM unwired OR phase not enabled → use static fallback directly.
  const enabled = deps.enabled_phases
  if (deps.llm === undefined || enabled === undefined || enabled.size === 0 || !enabled.has(input.phase)) {
    return staticSpec(fallback)
  }

  // Build the resolver lazily so we don't pay setup cost when fallback-only.
  const resolverDeps: Parameters<typeof buildLlmPhaseSpecResolver>[0] = {
    llm: deps.llm,
    enabled_phases: enabled,
  }
  if (deps.timeout_ms !== undefined) resolverDeps.timeout_ms = deps.timeout_ms
  if (deps.log !== undefined) resolverDeps.log = deps.log
  if (deps.onLlmStart !== undefined) resolverDeps.onLlmStart = deps.onLlmStart
  if (deps.onLlmEnd !== undefined) resolverDeps.onLlmEnd = deps.onLlmEnd
  const resolver = buildLlmPhaseSpecResolver(resolverDeps)

  const bundle = buildBundle(input, fallback)
  if (bundle === null) {
    // Phase intent missing (externally driven or not yet implemented) —
    // fall back deterministically.
    return staticSpec(fallback)
  }

  const goal = PHASE_GOALS[input.phase] ?? ''
  if (goal.length === 0) {
    deps.log?.('warn', 'phase-goals.md missing entry; using static fallback', {
      phase: input.phase,
    })
    return staticSpec(fallback)
  }

  // Wrap the resolver call so any extraction work the LLM did lands on
  // the returned spec. The resolver itself swallows LLM errors and returns
  // null; we layer extracted_fields on a second parse over the same JSON
  // envelope.
  const enriched = await resolveWithExtraction(resolver, bundle, deps, input.phase, goal)
  if (enriched === null) {
    return staticSpec(fallback)
  }
  return enriched
}

// ---------------------------------------------------------------------------
// Bundle builder
// ---------------------------------------------------------------------------

function buildBundle(
  input: GeneratePromptInput,
  fallback: PhasePromptSpec,
): PhaseContextBundle | null {
  // Build a PhaseIntent on the fly from the fallback spec. This keeps the
  // contract narrow: the LLM's allow-listed option values are precisely
  // whatever the fallback lists, which is always [] in the new world
  // (free-text default). For phases that retain options (slug_chosen,
  // profile_pic_generating), the engine builds the spec via a dedicated
  // builder + skips this driver entirely.
  //
  // Argus r1 (2026-05-10): the shape is derived from the fallback's
  // `allow_freeform` AND option set, not just from option count. A
  // static-fallback phase that ships options + `allow_freeform: false`
  // is structurally pick-only — typed replies must NOT route via the
  // default branch. Without this, max_oauth_offered's typed "later" hit
  // `next_phase_on_default: wow_fired` instead of the skip-max override.
  const shape: PhaseIntent['shape'] =
    fallback.allow_freeform === false
      ? 'pick-only'
      : fallback.options.length === 0
        ? 'free-text'
        : 'pick-or-text'
  const intent: PhaseIntent = {
    goal: input.phase,
    shape,
    allowed_option_values: fallback.options.map((o) => o.value),
    max_body_chars: 600,
  }

  const phase_state = input.phase_state
  const tg_first_name =
    input.tg_first_name_override ??
    readString(phase_state, 'tg_first_name')
  const captured: PhaseContextBundle['captured'] = {
    agent_name: readString(phase_state, 'agent_name'),
    archetype_hint: readString(phase_state, 'archetype_hint'),
    suggested_slug: readString(phase_state, 'suggested_slug'),
    chosen_slug: readString(phase_state, 'chosen_slug'),
    last_choice_value: readString(phase_state, 'last_choice_value'),
    last_choice_freeform: readString(phase_state, 'last_choice_freeform'),
  }
  const attempt_count = readNumber(phase_state, 'attempt_count') ?? 0
  const rejection_reason = readString(phase_state, 'rejection_reason')

  const bundle: PhaseContextBundle = {
    project_slug: readString(phase_state, 'project_slug') ?? '',
    topic_id: input.topic_id ?? '',
    user_id: input.user_id ?? '',
    signup_via: input.signup_via,
    telegram_display_name: tg_first_name,
    phase: input.phase,
    intent,
    captured,
    recent_turns: input.transcript_so_far,
    attempt_count,
    rejection_reason,
  }
  // #306 (2026-06-19) — surface the auto-detected timezone (stamped onto
  // `phase_state.timezone` from the `?tz=` WS param) so the LLM knows it is
  // already captured and the envelope's never-ask rule has something to
  // reference. Null when the client never reported one.
  const known_timezone = readString(phase_state, 'timezone')
  if (known_timezone !== null) {
    bundle.known_timezone = known_timezone
  }
  // P2 v2 § 9.3 (S6) — populate `required_fields_state` for the gap-fill
  // phase so the LLM can target the next missing required field.
  if (input.phase === 'work_interview_gap_fill') {
    const audit = auditRequiredFields(phase_state)
    bundle.required_fields_state = {
      filled: audit.filled,
      missing: audit.missing,
      next_to_collect: audit.next_to_collect,
    }
  }
  return bundle
}

// ---------------------------------------------------------------------------
// Resolver + extraction layer
// ---------------------------------------------------------------------------

/**
 * Call the resolver and, in parallel, extract structured fields the LLM
 * inferred from the user's recent reply. Returns null when the LLM call
 * failed at any layer (timeout, parse, validation) — the caller substitutes
 * the static fallback.
 *
 * Two-output JSON envelope: the same model call that produces `body` +
 * `options` ALSO emits `extracted_fields` and `persona_acknowledgment`.
 * The resolver only knows about body/options; we re-parse the raw text
 * here for the richer payload. This is cheaper than a second LLM call
 * (Atlas spec § 4) and avoids drift between the two outputs.
 */
async function resolveWithExtraction(
  _resolver: PhaseSpecResolver,
  bundle: PhaseContextBundle,
  deps: GeneratePromptDeps,
  phase: OnboardingPhase,
  goal: string,
): Promise<DrivenPhasePromptSpec | null> {
  if (deps.llm === undefined) return null
  const system = buildSystemPrompt(goal, bundle.intent, phase)
  const user = buildUserPrompt(bundle)

  if (deps.onLlmStart !== undefined) {
    try {
      deps.onLlmStart(bundle)
    } catch {}
  }
  let raw: string
  try {
    raw = await withTimeout(
      deps.llm({ system, user, max_tokens: 600 }),
      deps.timeout_ms ?? CONVERSATIONAL_TIMEOUT_MS_DEFAULT,
    )
  } catch (err) {
    if (deps.onLlmEnd !== undefined) {
      try {
        deps.onLlmEnd(bundle, { ok: false, reason: err instanceof Error ? err.message : String(err) })
      } catch {}
    }
    deps.log?.('warn', 'llm-prompt-driver: llm call failed; falling back', {
      phase,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  if (deps.onLlmEnd !== undefined) {
    try {
      deps.onLlmEnd(bundle, { ok: true })
    } catch {}
  }

  // First pass: parse body+options via the resolver's strict parser so
  // option allow-listing + max_body_chars still applies.
  const parsed = parseLlmSpec(raw, bundle.intent)
  if (parsed === null) {
    deps.log?.('warn', 'llm-prompt-driver: malformed body/options; falling back', {
      phase,
      raw_head: raw.slice(0, 200),
    })
    return null
  }

  // 2026-05-27 — Part C bullet validator. Phases whose `goal` mandates
  // a bullet-list output (currently only `agent_name_chosen`) must
  // actually contain >=3 bullets in the rendered body. The LLM can
  // otherwise satisfy the resolver's max_body_chars / JSON-shape
  // contract with a bullet-less intro that strands the user (Sam-
  // incident 2026-05-27). On validation fail, return null so the
  // caller substitutes the static spec — which DOES carry the bullet
  // list — instead of emitting the half-rendered LLM body.
  if (!phaseBodyShapeValid(phase, parsed.body)) {
    deps.log?.('warn', 'llm-prompt-driver: body failed phase shape check; falling back', {
      phase,
      raw_head: raw.slice(0, 200),
    })
    return null
  }

  // Second pass: pull out extracted_fields + persona_acknowledgment if
  // the LLM included them. Validation is permissive — missing/malformed
  // extraction just produces an empty result, not a fallback.
  const richer = parseRicherEnvelope(raw)

  // Argus r1 (2026-05-10) — route the LLM's stay-or-advance decision.
  // The static fallback path is single-turn (default next_phase reached
  // after one user reply); the LLM-driven path is multi-turn. The LLM
  // signals "stay" by either emitting `next_phase: <current phase>` in
  // the envelope OR by NOT extracting an `agent_name` yet (the signup
  // phase advances when we have a name; until then we stay and keep
  // gathering archetype/personality context). Engine respects this
  // value via `consumeChoice`'s spec-routing path.
  const staticNext = (STATIC_PHASE_SPECS[phase]?.next_phase_on_default ?? phase) as OnboardingPhase
  const decided_next_phase: OnboardingPhase = decideNextPhase({
    phase,
    static_next: staticNext,
    llm_next: richer.next_phase,
    extracted_fields: richer.extracted_fields,
  })

  const spec: DrivenPhasePromptSpec = {
    phase,
    body: parsed.body,
    options: parsed.options,
    allow_freeform: bundle.intent.shape !== 'pick-only',
    next_phase_on_default: decided_next_phase,
    is_fallback: false,
  }
  const fallback = STATIC_PHASE_SPECS[phase]
  if (fallback?.next_phase_overrides !== undefined) {
    spec.next_phase_overrides = fallback.next_phase_overrides
  }
  if (fallback?.kind !== undefined) spec.kind = fallback.kind
  if (richer.extracted_fields !== undefined) {
    spec.extracted_fields = richer.extracted_fields
  }
  if (typeof richer.persona_acknowledgment === 'string' && richer.persona_acknowledgment.length > 0) {
    spec.persona_acknowledgment = richer.persona_acknowledgment
  }
  return spec
}

/**
 * Argus r1 (2026-05-10) — pick the next phase from one of:
 *
 *   1. the LLM's explicit `next_phase` field, when it equals either the
 *      current phase (stay) or the static spec's advance target;
 *   2. the static target IF the LLM extracted enough structured data
 *      to safely advance — for signup that's an `agent_name`;
 *   3. the current phase (stay) — default for the multi-turn case
 *      where the LLM neither signalled advance nor extracted a name.
 *
 * Non-signup phases default to the static spec's `next_phase_on_default`
 * because they're not multi-turn today; the LLM driver is only a body
 * generator for them. Adding multi-turn shape to other phases means
 * extending this function with the equivalent extraction signal.
 */
function decideNextPhase(input: {
  phase: OnboardingPhase
  static_next: OnboardingPhase
  llm_next: OnboardingPhase | null
  extracted_fields: ExtractedFields | undefined
}): OnboardingPhase {
  if (input.llm_next !== null) {
    // Allow either "stay" or "advance to the static target". Any other
    // value is rejected — the LLM does not get to invent new transitions.
    if (input.llm_next === input.phase) return input.phase
    if (input.llm_next === input.static_next) return input.static_next
  }
  if (input.phase === 'signup') {
    // P2 v2 § 3.1 — the spec'd extraction key at signup is
    // `user_first_name` (the USER's name, not the AGENT's name; the
    // agent name is collected later at `agent_name_chosen`). Pre-v2 the
    // LLM emitted `agent_name` here because the v1 prompt was
    // ambiguous; we still honour it as a fallback signal so a model
    // running the v1 envelope can advance.
    const hasName =
      input.extracted_fields?.user_first_name !== undefined ||
      input.extracted_fields?.agent_name !== undefined
    return hasName ? input.static_next : input.phase
  }
  return input.static_next
}

/**
 * P2 v2 § 3.1 — sanitize a raw `user_first_name` string off the LLM
 * envelope. Returns null when the input cannot plausibly be a first name.
 *
 * Rules:
 *   1. Trim whitespace.
 *   2. Take the FIRST whitespace-separated token (a reply of "Sam Doe"
 *      lands as "Sam"). The engine derives slugs from this token.
 *   3. Strip trailing punctuation (".", ",", etc.).
 *   4. Reject obvious stop-words (yes/no/ok/idk/etc).
 *   5. Reject anything that doesn't match `/^\p{L}[\p{L}' -]{0,31}$/u`.
 *   6. Cap at 32 characters total.
 *
 * Visible from the test suite (signup-asks-name.test.ts).
 */
export function sanitizeUserFirstName(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const firstToken = trimmed.split(/\s+/)[0] ?? ''
  // Strip trailing punctuation: "Sam." → "Sam", "Sam," → "Sam".
  const stripped = firstToken.replace(/[.,;:!?]+$/u, '')
  if (stripped.length === 0) return null
  if (stripped.length > 32) return null
  if (USER_FIRST_NAME_STOP_WORDS.has(stripped.toLowerCase())) return null
  // Unicode-aware letter + optional hyphen / apostrophe / space.
  if (!/^\p{L}[\p{L}' -]{0,31}$/u.test(stripped)) return null
  return stripped
}

/**
 * Stop-list of replies the LLM might mistakenly echo back as a name when
 * the user types a non-name response. The engine's signup re-prompt
 * branch fires when the audit shows `user_first_name` still missing, so
 * these must NOT pass the sanitizer.
 */
const USER_FIRST_NAME_STOP_WORDS: ReadonlySet<string> = new Set([
  'yes',
  'no',
  'what',
  'sure',
  'ok',
  'okay',
  'hi',
  'hello',
  'hey',
  'idk',
  'maybe',
  'nope',
  'yeah',
  'yep',
  'nah',
])

interface RicherEnvelope {
  extracted_fields?: ExtractedFields
  persona_acknowledgment?: string
  /** Argus r1 (2026-05-10) — LLM-emitted stay/advance signal. The
   *  envelope's `next_phase` field; null when the LLM didn't supply
   *  one (engine falls back to extraction-based heuristic). */
  next_phase: OnboardingPhase | null
}

function parseRicherEnvelope(raw: string): RicherEnvelope {
  let stripped = raw.trim()
  const fenceStart = stripped.match(/^```(?:json)?\s*\n/i)
  if (fenceStart !== null) stripped = stripped.slice(fenceStart[0].length)
  const fenceEnd = stripped.match(/\n```\s*$/)
  if (fenceEnd !== null) stripped = stripped.slice(0, stripped.length - fenceEnd[0].length)

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return { next_phase: null }
  }
  if (typeof parsed !== 'object' || parsed === null) return { next_phase: null }
  const obj = parsed as Record<string, unknown>

  const out: RicherEnvelope = { next_phase: null }
  const ef = obj['extracted_fields']
  if (typeof ef === 'object' && ef !== null) {
    const efObj = ef as Record<string, unknown>
    const extracted: ExtractedFields = {}
    const agent_name = efObj['agent_name']
    if (typeof agent_name === 'string' && agent_name.trim().length > 0) {
      extracted.agent_name = agent_name.trim()
    }
    const slug = efObj['slug']
    if (typeof slug === 'string' && slug.trim().length > 0) {
      extracted.slug = slug.trim()
    }
    const archetypes = efObj['archetypes']
    if (Array.isArray(archetypes)) {
      const cleaned = archetypes
        .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
        .map((a) => a.trim())
        .slice(0, 4)
      if (cleaned.length > 0) extracted.archetypes = cleaned
    }
    const goal_one_liner = efObj['goal_one_liner']
    if (typeof goal_one_liner === 'string' && goal_one_liner.trim().length > 0) {
      extracted.goal_one_liner = goal_one_liner.trim()
    }
    // P2 v2 § 3.1 (S3) — user_first_name. Sanitized at extract time:
    // trim, take FIRST whitespace token, reject obvious stop-words +
    // anything that doesn't match the name-shape regex. The engine
    // double-validates before persisting; this layer keeps obvious
    // garbage out of phase_state.
    const user_first_name = efObj['user_first_name']
    if (typeof user_first_name === 'string') {
      const sanitized = sanitizeUserFirstName(user_first_name)
      if (sanitized !== null) extracted.user_first_name = sanitized
    }
    // P2 v2 S6 (2026-05-16) — gap-fill extraction surface. Pull each
    // structured field out if the LLM included it. Sanitization is
    // intentionally permissive — names land verbatim (drop empty + cap
    // length); audit-shape validation (≥3 projects etc.) is the
    // engine's job, NOT the driver's.
    const primary_projects = sanitizeStringArray(efObj['primary_projects'], 8, 200)
    if (primary_projects !== null) extracted.primary_projects = primary_projects
    // GAP1 (2026-06-09) — explicit removals (see ExtractedFields.removed_projects).
    const removed_projects = sanitizeStringArray(efObj['removed_projects'], 8, 200)
    if (removed_projects !== null) extracted.removed_projects = removed_projects
    const non_work_interests = sanitizeNonWorkInterests(efObj['non_work_interests'])
    if (non_work_interests !== null) extracted.non_work_interests = non_work_interests
    const agent_personality = sanitizeFreeText(efObj['agent_personality'], 240)
    if (agent_personality !== null) extracted.agent_personality = agent_personality
    const time_style = sanitizeFreeText(efObj['time_style'], 200)
    if (time_style !== null) extracted.time_style = time_style
    const work_pattern = sanitizeFreeText(efObj['work_pattern'], 200)
    if (work_pattern !== null) extracted.work_pattern = work_pattern
    const rituals = sanitizeStringArray(efObj['rituals'], 8, 200)
    if (rituals !== null) extracted.rituals = rituals
    const inner_circle = sanitizeStringArray(efObj['inner_circle'], 8, 80)
    if (inner_circle !== null) extracted.inner_circle = inner_circle
    const companies = sanitizeStringArray(efObj['companies'], 8, 80)
    if (companies !== null) extracted.companies = companies
    const user_supplied_corrections = sanitizeStringArray(
      efObj['user_supplied_corrections'],
      8,
      400,
    )
    if (user_supplied_corrections !== null) {
      extracted.user_supplied_corrections = user_supplied_corrections
    }
    if (Object.keys(extracted).length > 0) out.extracted_fields = extracted
  }
  const ack = obj['persona_acknowledgment']
  if (typeof ack === 'string' && ack.trim().length > 0) {
    out.persona_acknowledgment = ack.trim()
  }
  const next_phase = obj['next_phase']
  if (typeof next_phase === 'string' && next_phase.trim().length > 0) {
    out.next_phase = next_phase.trim() as OnboardingPhase
  }
  return out
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Sprint A.1 — eagerly-loaded envelope body. Loaded once at module
 * import. Rendered per-call by `buildSystemPrompt`.
 *
 * Falls back to an empty string when the file is missing — same defensive
 * pattern as `PHASE_GOALS`. In production the orchestrator ships the
 * `skills/_envelope.md` file alongside `llm-prompt-driver.ts`, so the
 * file is always present.
 */
const SYSTEM_PROMPT_ENVELOPE: string = (() => {
  try {
    return readFileSync(SYSTEM_PROMPT_ENVELOPE_PATH, 'utf8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
      return ''
    }
    throw err
  }
})()

export function buildSystemPrompt(goal: string, intent: PhaseIntent, phase: OnboardingPhase): string {
  const allowedHint =
    intent.allowed_option_values.length === 0
      ? '(no options — free-text only)'
      : intent.allowed_option_values.map((v) => `"${v}"`).join(', ')
  const staticNext =
    STATIC_PHASE_SPECS[phase]?.next_phase_on_default ?? phase
  // Sprint A.1 — envelope is loaded from skills/_envelope.md; render
  // the placeholders. Replace order matters only insofar as no
  // substitution value contains a `{{...}}` token (none do — `goal`
  // comes from `phase-goals.md`, the others are alphanumeric).
  return SYSTEM_PROMPT_ENVELOPE
    .replace(/\{\{phase\}\}/g, phase)
    .replace(/\{\{goal\}\}/g, goal)
    .replace(/\{\{allowed_hint\}\}/g, allowedHint)
    .replace(/\{\{max_body_chars\}\}/g, String(intent.max_body_chars))
    .replace(/\{\{static_next\}\}/g, staticNext)
}

function buildUserPrompt(bundle: PhaseContextBundle): string {
  const lines: string[] = []
  lines.push(`channel=${bundle.signup_via}`)
  if (bundle.telegram_display_name !== null) {
    lines.push(`telegram_first_name=${sanitize(bundle.telegram_display_name)}`)
  }
  if (bundle.captured.agent_name !== undefined && bundle.captured.agent_name !== null) {
    lines.push(`captured.agent_name=${sanitize(bundle.captured.agent_name)}`)
  }
  if (
    bundle.captured.archetype_hint !== undefined &&
    bundle.captured.archetype_hint !== null
  ) {
    lines.push(`captured.archetype_hint=${sanitize(bundle.captured.archetype_hint)}`)
  }
  if (
    bundle.captured.suggested_slug !== undefined &&
    bundle.captured.suggested_slug !== null
  ) {
    lines.push(`captured.suggested_slug=${sanitize(bundle.captured.suggested_slug)}`)
  }
  if (bundle.attempt_count > 0) {
    lines.push(`attempt_count=${bundle.attempt_count} (the prior reply did not extract — rephrase, don't repeat)`)
  }
  if (bundle.rejection_reason !== null) {
    lines.push(`rejection_reason=${sanitize(bundle.rejection_reason)}`)
  }
  // #306 — the timezone is already known; the envelope forbids asking for
  // it. Surface it so the LLM can use it directly without re-asking.
  if (typeof bundle.known_timezone === 'string' && bundle.known_timezone.length > 0) {
    lines.push(`known_timezone=${sanitize(bundle.known_timezone)}`)
  }
  if (bundle.required_fields_state !== undefined) {
    // P2 v2 § 9.3 (S6) — surface the audit snapshot so the LLM picks
    // the next-most-important missing field rather than re-asking
    // something we already have. `filled` / `missing` are in audit
    // priority order; `next_to_collect` is the highest-priority
    // missing field (or `(none — audit clean)` when everything is
    // filled, which the gap-fill handler treats as "advance").
    const rfs = bundle.required_fields_state
    lines.push(
      `required_fields_state.filled=${rfs.filled.length === 0 ? '(none)' : rfs.filled.join(',')}`,
    )
    lines.push(
      `required_fields_state.missing=${rfs.missing.length === 0 ? '(none)' : rfs.missing.join(',')}`,
    )
    lines.push(
      `required_fields_state.next_to_collect=${rfs.next_to_collect ?? '(none — audit clean)'}`,
    )
  }
  if (bundle.recent_turns.length > 0) {
    lines.push('recent_turns (oldest first):')
    for (const t of bundle.recent_turns) {
      const head = t.body.length > 240 ? `${t.body.slice(0, 237)}...` : t.body
      lines.push(`  ${t.role}: ${sanitize(head)}`)
    }
  }
  if (bundle.signup_via === 'web') {
    lines.push('note: web signup — DO NOT suggest using a Telegram display name')
  }
  return lines.join('\n')
}

function sanitize(raw: string): string {
  const escaped = raw.replace(/\r/g, '').replace(/\n/g, '\\n')
  return escaped.length > 240 ? `${escaped.slice(0, 237)}...` : escaped
}

// ---------------------------------------------------------------------------
// Static spec helper
// ---------------------------------------------------------------------------

function staticSpec(fallback: PhasePromptSpec): DrivenPhasePromptSpec {
  const out: DrivenPhasePromptSpec = {
    phase: fallback.phase,
    body: fallback.body,
    options: fallback.options.map((o) => ({ ...o })),
    allow_freeform: fallback.allow_freeform,
    next_phase_on_default: fallback.next_phase_on_default,
    is_fallback: true,
  }
  if (fallback.next_phase_overrides !== undefined) {
    out.next_phase_overrides = fallback.next_phase_overrides
  }
  if (fallback.kind !== undefined) out.kind = fallback.kind
  return out
}

// ---------------------------------------------------------------------------
// Phase-specific body-shape validators (2026-05-27 — Part C)
// ---------------------------------------------------------------------------

/**
 * 2026-05-27 — agent-name-chosen body shape check.
 *
 * The `agent_name_chosen` phase's `goal` mandates a bullet list of 3-5
 * names + taglines (`- <Name> — <one-line tagline>`). The resolver's
 * generic `parseLlmSpec` only checks max_body_chars + JSON shape; it
 * has no way to know a free-text phase's body is supposed to carry a
 * bullet list. Without this check, an LLM that returns a polite intro
 * ("Here are some options that fit your style:") and stops — exactly
 * what Sam hit 2026-05-27 — passes the resolver and ships an empty
 * prompt to the user.
 *
 * Rule: at least `AGENT_NAME_MIN_BULLETS` lines must match
 * `/^- \S+/m`. We deliberately don't require the em-dash separator
 * because some valid models render `- Atlas: calm, clear-headed` or
 * `- Atlas - calm and clear`; the meaningful failure mode is "no
 * bullets at all", not "wrong separator". The em-dash hint lives in
 * the prompt instead.
 */
export const AGENT_NAME_MIN_BULLETS = 3

export function agentNameBodyLooksValid(body: string): boolean {
  if (typeof body !== 'string' || body.length === 0) return false
  let count = 0
  for (const line of body.split('\n')) {
    if (/^- \S+/.test(line.trim())) count += 1
  }
  return count >= AGENT_NAME_MIN_BULLETS
}

/**
 * Dispatcher: returns false ONLY when a phase has a shape requirement
 * AND the body fails it. Unknown / unconstrained phases always pass.
 * Add new entries here when a phase's `goal` requires a specific body
 * shape the JSON-envelope parser cannot enforce.
 */
function phaseBodyShapeValid(phase: OnboardingPhase, body: string): boolean {
  if (phase === 'agent_name_chosen') {
    return agentNameBodyLooksValid(body)
  }
  return true
}

// ---------------------------------------------------------------------------
// withTimeout (re-implemented locally so the driver has zero non-stdlib
// runtime imports beyond the resolver).
// ---------------------------------------------------------------------------

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`llm-prompt-driver: timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeoutP])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function readNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * P2 v2 S6 — sanitize a string-array extracted_field value off the LLM
 * envelope. Returns null when the value is not an array OR every entry
 * is empty after trim. Otherwise returns the trimmed, capped, deduped
 * (case-insensitive) list. `max_entries` caps the array length;
 * `max_chars` caps each entry's length.
 */
function sanitizeStringArray(
  value: unknown,
  max_entries: number,
  max_chars: number,
): ReadonlyArray<string> | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    const capped = trimmed.length > max_chars ? trimmed.slice(0, max_chars) : trimmed
    const key = capped.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(capped)
    if (out.length >= max_entries) break
  }
  return out.length > 0 ? out : null
}

/**
 * P2 v2 S6 — sanitize a non_work_interests extracted_field value. Each
 * entry per § 9.3 is `{ name, cadence_hint? }`. The LLM is also
 * permitted to emit bare strings (back-compat with v1-shaped imports);
 * we coerce those into `{ name: <string> }`. Returns null when the
 * value isn't an array or every entry is empty.
 */
function sanitizeNonWorkInterests(
  value: unknown,
): ReadonlyArray<{ name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' }> | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const out: Array<{ name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' }> = []
  for (const raw of value) {
    let name: string | null = null
    let cadence_hint: 'weekly' | 'monthly' | 'occasional' | undefined
    if (typeof raw === 'string') {
      name = raw.trim()
    } else if (typeof raw === 'object' && raw !== null) {
      const r = raw as Record<string, unknown>
      const n = r['name']
      if (typeof n === 'string') name = n.trim()
      const c = r['cadence_hint']
      if (c === 'weekly' || c === 'monthly' || c === 'occasional') cadence_hint = c
    }
    if (name === null || name.length === 0) continue
    const capped = name.length > 80 ? name.slice(0, 80) : name
    const key = capped.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const entry: { name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' } = {
      name: capped,
    }
    if (cadence_hint !== undefined) entry.cadence_hint = cadence_hint
    out.push(entry)
    if (out.length >= 6) break
  }
  return out.length > 0 ? out : null
}

/**
 * P2 v2 S6 — sanitize a free-text extracted_field value (single string).
 * Trims, caps at `max_chars`, returns null when empty.
 */
function sanitizeFreeText(value: unknown, max_chars: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > max_chars ? trimmed.slice(0, max_chars) : trimmed
}

// Re-export the resolver primitives so callers can build a custom resolver
// (e.g. tests) without re-importing from the resolver module.
export {
  buildLlmPhaseSpecResolver,
  RESERVED_OPTION_VALUES,
}
export type {
  LlmCallFn,
  PhaseContextBundle,
  PhaseSpecResolver,
}
