/**
 * @neutronai/gateway/realmode-composer — post-onboarding live-agent chat turn.
 *
 * ISSUES #204 / docs/plans/post-onboarding-experience-spec-2026-06-10.md
 * § ITEM 1 — the usability floor everything else stands on. Before this
 * module existed, a `user_message` at `phase==completed` dead-ended in the
 * onboarding engine's `noop_terminal` (engine.ts handleFinalHandoffOnCompleted)
 * and project topics shipped a hardcoded "coming online soon" stub: live-agent
 * chat was UNBUILT for every topic.
 *
 * `buildLiveAgentTurn` returns the `runLiveAgentTurn` closure the chat bridge
 * invokes for completed-phase user messages. One turn:
 *
 *   1. PERSIST THE USER TURN — resolve the topic's latest unresolved
 *      `button_prompts` row (the previous agent reply, or a project seed)
 *      with the typed text as a synthetic `__freeform__` choice. This is the
 *      SAME persistence model onboarding uses: the user bubble is the
 *      resolution of the preceding agent row, so chat-history hydration
 *      renders [agent][user] pairs in order. Best-effort — a missing
 *      previous row only costs the durable record of THIS user line (the
 *      live bubble still rendered client-side).
 *   2. ASSEMBLE THE SYSTEM CONTEXT (first turn per (instance, topic) per
 *      process) — `personaLoader.load()` (the owner's Kairos
 *      SOUL/USER/priority-map written by persona-gen compose.ts) spliced
 *      through `assembleSystemPrompt` (which also reads owner workspace
 *      files + appends the owner-settings tool fragment), the owner-agnostic
 *      `<operating_doctrine>` layer (gap-audit item 10 — the lived "how you
 *      act every turn" doctrine, per-context weighted General vs project),
 *      plus a compact <recent_conversation> block from
 *      `buttonStore.listHistoryByTopic`.
 *      Missing persona files → generic Neutron-assistant fallback (never
 *      hard-fail). Subsequent turns on the same topic send ONLY the user
 *      text — the warm REPL's own transcript carries the conversation.
 *   3. DISPATCH OVER THE SUBSTRATE — `substrate.start(spec)` on the
 *      DEDICATED conversational substrate the boot shell builds (warm
 *      persistent CC REPL, NOT the ephemeral one-shot `cc-llm-*` instance).
 *      Per-(instance, topic) session keying rides `spec.metering_context
 *      .project_id` (`'general'` for General, the project id for project
 *      topics) — the persistent substrate folds it into its warm-pool key,
 *      so General and each project topic get their own resumable CC
 *      session. Credentials resolve per dispatch through the substrate's
 *      `resolveLlmCredentials` pool (owner Max OAuth first) — NO direct
 *      api.anthropic.com (HARD RULE).
 *   4. REPLY — collect the turn's tokens, parse any onboarding `[[OPTIONS]]`
 *      choice block out of the text (`extractAgentOptions`), persist the reply
 *      as a `button_prompts` row (the parsed options, allow_freeform: true, long
 *      TTL so history never ghosts it; the `messages` table is unwired by design
 *      — do NOT target it), THEN send the live `agent_message` envelope.
 *      Persist-before-send: if the socket died mid-turn the row is durable
 *      and the existing reconnect re-emit (`reEmitActiveSeedPromptIfAny`)
 *      recovers it.
 *
 * Failure shape: the runner NEVER throws to the bridge. Substrate errors /
 * timeouts log + ship a friendly failure bubble — the one thing this sprint
 * exists to kill is the silent no-op.
 */

import { randomUUID } from 'node:crypto'

import type { ButtonStore } from '../../channels/button-store.ts'
import {
  buildButtonPrompt,
  MAX_OPTIONS_TELEGRAM,
  RESERVED_OPTION_VALUES,
  VALUE_BYTE_CAP,
} from '../../channels/button-primitive.ts'
import type { ChatOutbound } from '../../landing/server.ts'
import { getBestModel } from '../../runtime/models.ts'
import { assembleSystemPrompt } from '../../runtime/system-prompt.ts'
import type { AgentSpec, Substrate } from '../../runtime/substrate.ts'
import type { ToolDef } from '../../core-sdk/types.ts'
import { collectTokensToString } from './build-llm-call-substrate.ts'
import { buildOperatingDoctrineFragment } from './operating-doctrine.ts'
import type { LiveAgentTurnRequest } from '../http/chat-bridge.ts'

const LOG_TAG = '[live-agent-turn]'

/** Per-turn wall-clock budget before the substrate handle is cancelled. */
const DEFAULT_TIMEOUT_MS = 240_000

/**
 * Cold-spawn / onboarding-turn wall-clock budget (2026-06-30). A COLD first turn
 * into a topic — and EVERY onboarding turn (the welcome seed + per-project
 * opening + each interview answer) — pays a one-time heavy load: a fresh CC REPL
 * spawn, MCP/dev-channel bind, plugin load, and a large onboarding system prompt.
 * Under machine load that routinely runs past the persistent REPL's snappy
 * steady-state `DEFAULT_TURN_TIMEOUT_MS` (180s), which hard-failed a
 * slow-but-would-succeed cold turn into the `FAILURE_BODY` bubble. Give those
 * turns a generous budget so the cold spawn completes; warm steady-state turns
 * keep the tight default (a genuinely wedged warm turn still fails fast). Wired
 * BOTH to the composer's own AbortController AND to the substrate's per-turn
 * timer via `AgentSpec.turn_timeout_ms`, so neither layer kills the turn early.
 *
 * 2026-06-30 (fresh-install verify follow-up) — raised 360s → 600s. #138 set 360s
 * but a real onboarding work-question turn STILL hard-failed at ~5.5min under
 * fleet/dogfood load (the cold CC spawn + dev-channel bind + large onboarding
 * prompt is genuinely slow when the machine is busy). 10 minutes leaves
 * comfortable headroom over the observed worst case so a slow-but-completing
 * onboarding turn finishes instead of erroring; the seed-failure self-heal +
 * reload regeneration still cover the rare turn that exceeds even this.
 */
const COLD_TURN_TIMEOUT_MS = 600_000

/**
 * Reply rows are HISTORY, not pending questions — they must never hit the
 * `expires_at` ghost filter in `listHistoryByTopic` (an expired unresolved
 * row vanishes from hydration AND gets sweep-resolved `__timeout__`).
 * Ten years ≈ never, without a schema change.
 */
const REPLY_ROW_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1_000

/**
 * Path 1 onboarding option buttons (2026-06-30). The live onboarding agent
 * conducts a free-form interview, but choice steps (personality archetype, agent
 * name, yes/no confirmations) read far better as TAPPABLE buttons than as a wall
 * of prose the owner must re-type. The React client already renders an
 * `agent_message`'s `options[]` as buttons (ChatApp.tsx) and routes a tap back
 * as the owner's next turn (`on_button_choice` → `user_text = option.value`), so
 * the ONLY missing piece was the live turn EMITTING options — it hardcoded
 * `options: []`.
 *
 * The mechanism is server-side structured-choice detection (NOT a tool-surface
 * change — the warm REPL's `--tools` allow-list must stay constant per the reuse
 * guard): the onboarding preamble instructs the agent to append a machine-
 * readable block AFTER its prose question when offering choices:
 *
 *     [[OPTIONS]]
 *     - Marcus Aurelius
 *     - Hermione Granger
 *     - Something else (I'll describe it)
 *     [[/OPTIONS]]
 *
 * `extractAgentOptions` parses that block out of the collected reply, STRIPS it
 * from the rendered body, and turns each line into a render-ready `ButtonOption`
 * (label legend + display body + a routing `value` that is the line text itself,
 * so a tap feeds the agent the owner's choice verbatim). `allow_freeform` stays
 * true — a typed reply always works. Onboarding-only (gated on `onboardingActive`)
 * so a steady-state reply that happens to contain the literal sentinel never
 * sprouts buttons.
 */
const OPTIONS_BLOCK_RE = /\n*\[\[OPTIONS\]\]\s*\n([\s\S]*?)\n?\s*\[\[\/OPTIONS\]\]\s*/i

/** Option legend faces (Telegram text-render parity; the web client shows the
 *  option's `body`, not this letter). Capped to the inline-keyboard limit. */
const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const

/** Upper bound on an option's rendered display text — a runaway line is clamped
 *  so the keyboard stays readable; the routing value is independently byte-capped. */
const OPTION_DISPLAY_MAX_CHARS = 80

export interface ParsedAgentOptions {
  /** The reply body with the `[[OPTIONS]]` block removed. */
  body: string
  /** Sanitized, render-ready options — guaranteed to pass `validateButtonPrompt`
   *  (non-empty unique labels, unique non-reserved ≤VALUE_BYTE_CAP values). May
   *  be empty when there was no block or nothing survived sanitisation. */
  options: Array<{ label: string; body: string; value: string }>
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
 * multi-byte codepoint (a mid-codepoint cut decodes to U+FFFD, which we trim).
 */
function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  const sliced = Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8')
  return sliced.replace(/�+$/u, '').trim()
}

/**
 * Parse the `[[OPTIONS]]` block (if any) out of a live onboarding reply.
 * Returns the body with the block stripped + the render-ready options. When the
 * block is the WHOLE message (no prose survives), options are dropped and the
 * original text is returned as the body — a zero-body button prompt is invalid
 * and a bare button wall reads worse than plain text.
 *
 * Exported for unit testing.
 */
export function extractAgentOptions(text: string): ParsedAgentOptions {
  const match = OPTIONS_BLOCK_RE.exec(text)
  if (match === null) return { body: text, options: [] }
  const body = text.replace(OPTIONS_BLOCK_RE, '\n').trim()
  if (body.length === 0) return { body: text.trim(), options: [] }
  const rawLines = (match[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s+/u, '').trim())
    .filter((l) => l.length > 0)
  const options: Array<{ label: string; body: string; value: string }> = []
  const seenValues = new Set<string>()
  for (const line of rawLines) {
    if (options.length >= MAX_OPTIONS_TELEGRAM) break
    const value = truncateUtf8(line, VALUE_BYTE_CAP)
    if (value.length === 0 || RESERVED_OPTION_VALUES.has(value)) continue
    if (seenValues.has(value)) continue
    seenValues.add(value)
    const display =
      line.length > OPTION_DISPLAY_MAX_CHARS
        ? `${line.slice(0, OPTION_DISPLAY_MAX_CHARS - 1)}…`
        : line
    options.push({ label: OPTION_LABELS[options.length] ?? String(options.length + 1), body: display, value })
  }
  return { body, options }
}

/**
 * Built-in CC tool surface for the live agent. Read access over the REPL's cwd /
 * `--add-dir` (the owner home: persona/, entities/, Projects/) — the agent can
 * RECALL and SUMMARIZE everything onboarding materialized — PLUS the native
 * `Skill` mechanism and the file/exec tools the bundled skills need to run.
 *
 * P1-5 (lift audit § P1-5): `Skill` is what lets the spawned REPL invoke the
 * natively-discovered `SKILL.md` packs (`impeccable`, `agent-browser`, `remind`,
 * forged skills — provisioned into `<cwd>/.claude/skills/` by `agent-skills.ts`).
 * The design skills (`impeccable`) author code, so `Write`/`Edit` are required;
 * `agent-browser` and other skill scripts shell out, so `Bash` is required. This
 * tool grant is the OWNER's trusted live-chat agent ONLY — the untrusted import
 * (`cc-import-*`) and disposable Trident (`cc-trident-*`) substrates keep their
 * `tools: []` default-deny (`--tools ""`), so neither gets `Skill` nor exec
 * access (the prompt-injection gate from Codex-r1-P1 is untouched).
 *
 * `Workflow` (Work Board Phase 2a) exposes the native CC Dynamic Workflow tool
 * on the orchestrator surface so the owner's live-chat agent can FIRE background
 * tridents (and other workflows) directly + stay responsive while they run
 * detached — the same exec-model the trident inner loop uses (the dedicated
 * `cc-trident-fire-*` substrate fires the inner workflow; this grant readies the
 * orchestrator itself to fire board-bound tridents in Phase 2b). Adding it is a
 * CONSTANT-surface change: it is present on EVERY turn, so the reuse guard below
 * is satisfied (a constant surface, just a larger one).
 *
 * Constant across turns (the persistent substrate's reuse guard refuses to serve
 * a turn whose `--tools` surface differs from the warm REPL's, so a varying
 * surface would thrash the pool).
 */
const DEFAULT_TOOL_NAMES = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'Skill', 'Workflow'] as const

/**
 * Fallback persona when the owner's persona files are missing (persona-gen
 * failed or pre-onboarding instance). Spec § 1.6 step 2: never hard-fail on a
 * missing persona.
 */
const FALLBACK_PERSONA = [
  'You are the owner\'s personal Neutron assistant — grounded, concise, and',
  'useful. You help the user think through their projects and answer questions',
  'about anything captured in their workspace. Be direct; no corporate filler.',
].join('\n')

/** Friendly failure bubble — the anti-silence guarantee. */
const FAILURE_BODY =
  'I hit a problem answering that. Give it another try in a moment — if it keeps happening, your AI connection may need attention in settings.'

/**
 * Item 12 (2026-06-19, owner live-dogfood) — cold-start acknowledgement.
 * The FIRST turn into a project's chat pays a one-time CC cold-spawn
 * (~100s observed: MCP + dev-channel + plugins + system-prompt load) before
 * the warm session is hot. The owner asked a question in Globex and saw
 * only a typing indicator "with nothing happening" for 104s — it WAS
 * working, but with no progress affordance it read as hung. The
 * cold-start-ack pattern: the moment a cold first turn starts, emit
 * an immediate live (non-persisted) bubble so the user knows it's waking
 * up, not stuck. Subsequent turns hit the warm session and skip the ack.
 */
const COLD_START_ACK_BODY = "⏳ Waking up, one moment..."

/**
 * Item 12 — default delay before the cold-start ack fires. Long enough that
 * a warm session's near-instant reply pre-empts it (no spurious ack), short
 * enough that the ~100s cold-spawn case surfaces reassurance fast. 2.5s.
 */
const DEFAULT_COLD_START_ACK_DELAY_MS = 2_500

/** Cap on history turns spliced into a first-turn context block. */
const HISTORY_SPLICE_LIMIT = 12

/** Structural slice of `TranscriptWriter` — keeps this module off a static
 *  onboarding/ import edge; the landing-stack factory threads its instance. */
export interface LiveAgentTranscriptSink {
  append(entry: {
    role: 'user' | 'agent'
    body: string
    phase?: string
    button_prompt_id?: string
  }): unknown
}

/**
 * WAVE 2 P1 (gap-audit §(b) cat 4 / §(c) #10) — the reflection + learning layer
 * (`reflection/`, diary + corrections-log). Structural slice so this module
 * stays off a static `reflection/` import edge; the composer threads the real
 * `createReflection(...)` instance.
 *
 *   - `loadContext()` returns the `<learned_corrections>` + `<recent_diary>`
 *     block to splice into a topic's FIRST-turn system context (the read path),
 *     or null when there is nothing learned yet.
 *   - `onTurnComplete(turn)` is the FIRE-AND-FORGET post-turn hook: it detects
 *     whether the owner just corrected the agent and, if so, logs the learning
 *     so a future session applies it. Returns void; never throws into the turn.
 */
export interface LiveAgentReflectionSeam {
  loadContext(): string | null
  onTurnComplete(turn: {
    user_text: string
    agent_text: string
    scope?: string
    observed_at?: number
  }): void
}

/**
 * Path 1 onboarding seam (2026-06-27). When the owner is NOT yet onboarded, the
 * SAME live session runs the onboarding interview: the first turn splices an
 * `<onboarding>` preamble into the system prompt instructing Claude to conduct
 * the interview conversationally, each onboarding `agent_message` carries the
 * zip-import `upload_affordance`, and every completed turn is handed to the
 * fire-and-forget scribe (`onTurnComplete`) that extracts + persists the
 * profile WITHOUT blocking the reply. Omitted on the LLM-less / Managed path →
 * the live agent behaves exactly as steady-state.
 */
export interface LiveAgentOnboardingSeam {
  /** True while the owner is still onboarding (no terminal onboarding_state). */
  isActive(user_id: string): Promise<boolean>
  /** The onboarding interview preamble spliced into the first-turn system prompt. */
  systemPreamble(): string
  /**
   * Per-turn onboarding grounding re-injected on EVERY onboarding turn (warm AND
   * cold), mirroring the Work Board block — so a warm session can act on state
   * that landed AFTER the cold first turn. Today this carries the import-analysis
   * the agent already presented (proposed projects + curation status) so the
   * owner can curate it ("drop X"); `null` when there's nothing to ground on.
   * Optional + best-effort: a throwing/absent seam degrades to no block.
   */
  onboardingContext?(user_id: string): Promise<string | null>
  /** Upload affordance attached to onboarding agent_messages (zip import), or null. */
  uploadAffordance(): { source: 'chatgpt' | 'claude' } | null
  /** Fire-and-forget post-turn scribe — never blocks, never throws into the turn. */
  onTurnComplete(input: {
    user_id: string
    user_text: string
    agent_text: string
    observed_at: number
  }): void
}

export interface BuildLiveAgentTurnInput {
  /**
   * The DEDICATED conversational substrate (warm persistent CC REPL pool).
   * Built by the boot shell via `buildLlmCallSubstrate` WITHOUT `ephemeral`
   * and WITHOUT a `projectIdResolver` — this module keys the per-(instance,
   * topic) warm session through `spec.metering_context.project_id`, which
   * is per-dispatch and therefore race-free across concurrent topics.
   */
  substrate: Substrate
  /** The shared per-owner `PersonaPromptLoader` instance (gateway boot). */
  personaLoader: { load(): Promise<string> }
  /**
   * WAVE 2 Track A — per-project persona injection. For a PROJECT topic, returns
   * THAT project's free-form persona label (`projects.persona`, e.g. "Forge —
   * pragmatic build agent") so the project topic's FIRST turn — and therefore
   * its dedicated warm CC session (each topic keys a distinct warm REPL via
   * `metering_context.project_id`, see step 3) — carries its own personality
   * spliced ABOVE the owner-wide SOUL/USER doctrine. Re-evaluated per first
   * turn so a persona edited mid-session lands on the next cold topic.
   *
   * Returns null / empty (or the whole resolver is omitted) → the topic falls
   * back to the owner-wide persona alone (the pre-WAVE-2 behaviour). NEVER
   * consulted for the General topic (`turn.project_id === undefined`): General
   * is the cross-project surface and has no project persona. A resolver that
   * throws is swallowed (degrade to owner-wide persona) — a pathological
   * projects-table read must never kill the turn.
   */
  projectPersonaResolver?: (project_id: string) => Promise<string | null> | string | null
  /**
   * WAVE 2 P1 — the reflection + learning layer. When wired, the FIRST turn on
   * each (instance, topic) splices `reflection.loadContext()` into its system
   * context (so the warm session adopts the owner's past corrections + recent
   * diary), and every completed turn calls `reflection.onTurnComplete(...)` to
   * detect + log a fresh correction. Omitted on the LLM-less path → no-op.
   */
  reflection?: LiveAgentReflectionSeam
  /**
   * Path 1 onboarding seam. When wired AND `isActive(user_id)` is true, the
   * live session conducts the onboarding interview (preamble + upload affordance
   * + post-turn scribe). Omitted → the live agent is steady-state only.
   */
  onboarding?: LiveAgentOnboardingSeam
  /**
   * Work Board (Phase 1a) — the orchestrator's external-memory re-grounding
   * seam. Returns a COMPACT, ALREADY-FORMATTED `<work_board>` DATA block for
   * the given `project_slug` (active+next items + the drift-guard advisory), or
   * null when there is nothing to inject / the read failed. Injected on EVERY
   * turn: the cold first turn adds it as an unconditional `instance_fragments`
   * entry; warm turns splice it before the user's message (since
   * `instance_fragments` is assembled only on the cold turn, a fragment-only
   * wiring would re-ground once per session, not every turn). Best-effort: a
   * throwing/absent seam degrades to no block, never kills the turn.
   */
  workBoardSnapshot?: (project_slug: string) => string | null
  /** The SAME ButtonStore the engine emits through (persistence + history). */
  buttonStore: ButtonStore
  /** Operator audit trail — same TranscriptWriter the engine appends to. */
  transcript?: LiveAgentTranscriptSink
  project_slug: string
  /** Absolute owner home — workspace files for `assembleSystemPrompt`. */
  owner_home: string
  /** Default BEST_MODEL per memory feedback_default_to_opus.md. */
  model?: string
  max_tokens?: number
  timeout_ms?: number
  /**
   * Item 12 — delay before the cold-start "waking up" ack fires on a cold
   * first turn. A warm/fast turn settles before this and never acks.
   * Defaults to `DEFAULT_COLD_START_ACK_DELAY_MS`. Tests pin a tiny value
   * (or rely on synchronous stubs settling first so it never fires).
   */
  ack_delay_ms?: number
  /** Override the built-in tool allow-list (tests). */
  tool_names?: ReadonlyArray<string>
  now?: () => number
}

export interface LiveAgentTurnResult {
  outcome: 'replied' | 'failed'
  reply_prompt_id: string | null
}

/**
 * Build the turn runner. The bridge treats the return type structurally
 * (`LiveAgentTurnRunner` in chat-bridge.ts) — this module owns the richer
 * result for tests.
 */
export function buildLiveAgentTurn(
  input: BuildLiveAgentTurnInput,
): (turn: LiveAgentTurnRequest) => Promise<LiveAgentTurnResult> {
  const now = input.now ?? ((): number => Date.now())
  const timeout_ms = input.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const ack_delay_ms = input.ack_delay_ms ?? DEFAULT_COLD_START_ACK_DELAY_MS
  const tool_names = input.tool_names ?? DEFAULT_TOOL_NAMES
  /**
   * Topics that already received their system-context first turn THIS
   * process lifetime. A warm REPL carries the context in its own
   * transcript (and survives gateway restarts via the on-disk registry's
   * `--resume`), so re-sending after OUR restart is merely redundant
   * context, never a correctness break.
   */
  const contextSent = new Set<string>()

  /**
   * Go-live race fix (2026-06-20) — per-(instance, topic) turn serialization.
   *
   * `contextSent.add(topicKey)` only runs AFTER a turn's dispatch settles, and
   * the warm CC session it establishes is registered just as late. So when a
   * 2nd turn on the SAME (instance, topic) arrives BEFORE the 1st has settled
   * (the owner typed Q2 right after Q1), the un-serialized runner had BOTH
   * turns see `isColdFirstTurn` → BOTH arm the cold-start ack → BOTH cold-spawn
   * a parallel session for the same key: duplicate "waking up" acks, racing /
   * duplicated replies, one question lost.
   *
   * This map holds the TAIL of each topic's in-flight turn chain. A new turn
   * chains its body onto the prior turn's tail, so turns for one (instance,
   * topic) run strictly one-at-a-time and in arrival order: the 1st turn
   * establishes the warm session (and pays the single cold-start ack), the 2nd
   * runs ONLY after it settles — sees `contextSent`, skips the ack, reuses the
   * warm session, and answers its own question. Distinct topics keep distinct
   * chains, so cross-topic turns still run concurrently. This mirrors the
   * monorepo's one-turn-at-a-time-per-session discipline at the composer seam;
   * the persistent REPL's own `acquireTurn()` mutex serializes turns ON a warm
   * session, but cannot stop two turns from cold-spawning two sessions before
   * either is pooled — that gap is what this chain closes.
   */
  const turnChains = new Map<string, Promise<void>>()

  // The REPL `--tools` allow-list only consumes `t.name`; the rest of the
  // ToolDef shape is contract filler for the locked AgentSpec interface.
  const tools: ToolDef[] = tool_names.map((name) => ({
    name,
    description: `Built-in Claude Code tool '${name}' (live-agent read surface)`,
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    capability_required: 'fs:project_data', // C4-a § 2.3 (was fs:owner_data; alias still accepted)
  }))

  /**
   * Public entry: serialize this turn behind any in-flight turn for the same
   * (instance, topic), then run the body. The chain tail swallows the prior
   * turn's outcome (`() => undefined` on BOTH settle paths) so one turn's
   * failure never breaks the chain for the next, and the map self-prunes once a
   * topic's chain drains (the tail removes its own entry iff it is still the
   * current tail — a turn that enqueued meanwhile owns the new tail).
   */
  function runLiveAgentTurn(turn: LiveAgentTurnRequest): Promise<LiveAgentTurnResult> {
    const topicKey = `${turn.project_slug}:${turn.topic_id}`
    const prior = turnChains.get(topicKey) ?? Promise.resolve()
    const run = prior.then(() => runTurnBody(turn))
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    turnChains.set(topicKey, tail)
    void tail.then(() => {
      if (turnChains.get(topicKey) === tail) turnChains.delete(topicKey)
    })
    return run
  }

  return runLiveAgentTurn

  async function runTurnBody(
    turn: LiveAgentTurnRequest,
  ): Promise<LiveAgentTurnResult> {
    const observed_at = turn.observed_at ?? now()
    // Path 1 — is the owner still onboarding? Consulted once per turn so the
    // first-turn preamble, the upload affordance, and the post-turn scribe all
    // agree. A throwing seam degrades to steady-state (never kills the turn).
    //
    // Onboarding is a GENERAL-TOPIC-ONLY mode (2026-06-30). The interview, its
    // welcome seed, and the `[[OPTIONS]]` choice buttons belong to the owner's
    // General topic; a PROJECT topic only ever EXISTS after onboarding
    // materialized it, so a project-topic turn must always be steady-state and
    // must never improvise the generic onboarding intro ("…what should I call
    // you?") on top of the deterministic per-project opening finalize already
    // seeded. The web client opens a fresh socket per project tab, so a project
    // tab opened while `isActive(user)` still reads true (fire-and-forget
    // finalize slow, or its terminal `completed` upsert raced/failed) would
    // otherwise run the interview on the project topic. Gate on
    // `turn.project_id === undefined` (General) so it cannot.
    let onboardingActive = false
    if (input.onboarding !== undefined && turn.project_id === undefined) {
      try {
        onboardingActive = await input.onboarding.isActive(turn.user_id)
      } catch {
        onboardingActive = false
      }
    }
    // ── 1. Persist the user turn onto the previous agent row (best-effort).
    // Capture that previous agent reply: the owner's message THIS turn is a
    // response to the PRIOR reply, so correction detection must judge (prior
    // reply, user_text) — NOT (this turn's freshly generated reply, user_text).
    // A `seed_turn` carries a SYNTHETIC system instruction (auto-start), not a
    // real user message — skip persistence so it never renders as a user bubble.
    const priorAgentReply = turn.seed_turn === true
      ? null
      : await resolvePreviousRowWithUserText(input.buttonStore, turn, observed_at, now())
    if (turn.seed_turn !== true) {
      try {
        input.transcript?.append({
          role: 'user',
          body: turn.user_text,
          phase: 'completed',
        })
      } catch {
        /* audit-trail only — never blocks the turn */
      }
    }

    // ── 2. Compose the prompt.
    const topicKey = `${turn.project_slug}:${turn.topic_id}`
    // Work Board (Phase 1a) — resolve the compact board DATA block ONCE for this
    // turn. Injected on EVERY turn so the orchestrator re-grounds on disk-truth
    // instead of a rotting transcript: the cold first turn folds it into
    // `instance_fragments` (the cacheable system prefix), and the warm path
    // splices it before the user's message (because `instance_fragments` is
    // assembled ONLY on the cold turn — a fragment-only wiring would re-ground
    // once per session, not every turn). Best-effort: a throwing/absent seam
    // degrades to no block, never kills the turn.
    let workBoardFragment: string | null = null
    if (input.workBoardSnapshot !== undefined) {
      try {
        workBoardFragment = input.workBoardSnapshot(turn.project_slug)
      } catch (err) {
        console.warn(
          `${LOG_TAG} event=work_board_snapshot_failed project=${turn.project_slug} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    // Onboarding per-turn grounding (e.g. the import analysis the agent already
    // presented) — re-resolved EVERY onboarding turn so a warm session can act on
    // state that landed after the cold first turn (the import completes minutes
    // in). Mirrors workBoardFragment: spliced before the user message on warm
    // turns, folded into the system prefix on the cold turn. Best-effort.
    let onboardingContextFragment: string | null = null
    if (onboardingActive && input.onboarding?.onboardingContext !== undefined) {
      try {
        onboardingContextFragment = await input.onboarding.onboardingContext(turn.user_id)
      } catch (err) {
        console.warn(
          `${LOG_TAG} event=onboarding_context_failed user=${turn.user_id} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    let prompt: string
    const isColdFirstTurn = !contextSent.has(topicKey)
    if (!isColdFirstTurn) {
      // Warm turn: the system prefix is already cached in the REPL's transcript;
      // re-ground by splicing the FRESH board + onboarding-context blocks before
      // the user's message (onboarding context LAST so it's most salient).
      const warmPrefix = [workBoardFragment, onboardingContextFragment].filter(
        (s): s is string => s !== null && s.length > 0,
      )
      prompt =
        warmPrefix.length > 0 ? `${warmPrefix.join('\n\n')}\n\n${turn.user_text}` : turn.user_text
    } else {
      // While onboarding, splice the interview preamble into the first-turn
      // system prompt so the warm session conducts the interview conversationally.
      const onboardingPreamble =
        onboardingActive && input.onboarding !== undefined ? input.onboarding.systemPreamble() : null
      prompt = await composeFirstTurnPrompt(
        input,
        turn,
        now(),
        onboardingPreamble,
        workBoardFragment,
        onboardingContextFragment,
      )
    }

    // Item 12 — cold-start ack. On the first turn into this topic the warm
    // CC session has not spawned yet, so the real reply can be ~100s out.
    // Arm a DELAYED live bubble (NOT persisted — a transient reassurance,
    // like FAILURE_BODY): if the dispatch hasn't replied within
    // `ack_delay_ms`, emit "waking up, just a moment" so the user sees
    // progress instead of a typing indicator that reads as hung. A warm /
    // fast turn clears the timer before it fires, so there's no spurious
    // ack (and tests with synchronous stubs never see it). Best-effort:
    // sendSafe swallows a closed-socket throw.
    // Suppress the cold-start ack DURING onboarding: the onboarding flow shows
    // its own "Setting things up…" empty-state loader (ChatApp.tsx), which should
    // stay visible until the REPL is ready and the "Hey, welcome in" message
    // lands — a "Waking up your workspace…" bubble in front of it is redundant
    // and confusing (Ryan 2026-06-30). The ack remains for post-onboarding cold
    // first turns (a genuine project wake-up reassurance).
    let ackTimer: ReturnType<typeof setTimeout> | null = null
    if (isColdFirstTurn && !onboardingActive) {
      ackTimer = setTimeout(() => {
        sendSafe(turn.send, { type: 'agent_message', body: COLD_START_ACK_BODY, topic_id: turn.topic_id })
      }, ack_delay_ms)
    }
    const clearAckTimer = (): void => {
      if (ackTimer !== null) {
        clearTimeout(ackTimer)
        ackTimer = null
      }
    }

    // ── 3. Dispatch over the substrate (CC-spawn only — no direct API).
    const scope = turn.project_id ?? 'general'
    // Resolve the model PER-TURN through the dynamic accessor (NOT a constant
    // captured when this runner was built once at gateway boot): the
    // model-update watchdog flips `getBestModel()` at runtime, so a turn that
    // arrives after a flip — or the very first onboarding turn on a fresh
    // install — spawns the latest served model, never a retired id that would
    // hang for the full per-turn timeout. An explicit `input.model` still wins.
    const model = input.model ?? getBestModel()
    // Per-turn wall-clock budget. A COLD first turn into this topic OR any
    // onboarding turn pays the one-time cold-spawn load that routinely runs past
    // the substrate's snappy 180s steady-state ceiling under machine load, so
    // give those turns the generous `COLD_TURN_TIMEOUT_MS`; warm steady-state
    // turns keep the tight default. The budget is wired to BOTH the composer's
    // AbortController (below) AND the substrate's own per-turn timer (via
    // `spec.turn_timeout_ms`) so neither layer abandons the turn early — without
    // the spec override the substrate's 180s would still kill a slow cold turn.
    const isColdOrOnboardingTurn = isColdFirstTurn || onboardingActive
    const turnBudgetMs = isColdOrOnboardingTurn
      ? Math.max(timeout_ms, COLD_TURN_TIMEOUT_MS)
      : timeout_ms
    const spec: AgentSpec = {
      prompt,
      tools,
      model_preference: [model],
      // Per-(instance, topic) warm-session key: the persistent substrate folds
      // `metering_context.project_id` into its pool key when no
      // projectIdResolver is wired on this substrate (build-llm-call-
      // substrate.ts). Per-dispatch ⇒ race-free across concurrent topics.
      metering_context: { project_id: scope },
    }
    if (input.max_tokens !== undefined) spec.max_tokens = input.max_tokens
    // Only override the substrate ceiling for the cold/onboarding path; leave a
    // warm steady-state turn on the substrate default so a wedged warm turn
    // still trips the snappy timeout.
    if (isColdOrOnboardingTurn) spec.turn_timeout_ms = turnBudgetMs
    let text: string
    const started = now()
    try {
      const handle = input.substrate.start(spec)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), turnBudgetMs)
      try {
        text = await collectTokensToString(handle, ac.signal)
      } finally {
        clearTimeout(timer)
        // Item 12 — the dispatch settled; cancel the cold-start ack if it
        // hasn't already fired (warm/fast turn → no spurious "waking up").
        clearAckTimer()
      }
    } catch (err) {
      console.warn(
        `${LOG_TAG} event=turn_failed project=${turn.project_slug} topic=${turn.topic_id} scope=${scope} elapsed_ms=${now() - started} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      // A failed SEED turn (the synthetic auto-start welcome / opening) must NOT
      // leave a `FAILURE_BODY` bubble: the app-ws reply path persists it into the
      // durable chat_log, so reloading would replay the stuck error forever
      // instead of re-firing the welcome. Stay silent on a seed failure — the
      // receiver clears its per-process seeded-topic mark on the 'failed' result
      // so the next reload/re-subscribe regenerates the seed (now on the larger
      // cold-turn budget). A real user turn still gets the anti-silence bubble.
      if (turn.seed_turn !== true) {
        sendSafe(turn.send, { type: 'agent_message', body: FAILURE_BODY, topic_id: turn.topic_id })
      }
      return { outcome: 'failed', reply_prompt_id: null }
    }
    if (text.trim().length === 0) {
      console.warn(
        `${LOG_TAG} event=empty_reply project=${turn.project_slug} topic=${turn.topic_id} scope=${scope}`,
      )
      // Same seed-failure discipline as the catch above — never persist an error
      // bubble for a synthetic seed turn; let reload regenerate it.
      if (turn.seed_turn !== true) {
        sendSafe(turn.send, { type: 'agent_message', body: FAILURE_BODY, topic_id: turn.topic_id })
      }
      return { outcome: 'failed', reply_prompt_id: null }
    }
    // Only mark the context as delivered once a turn actually completed on
    // the warm session — a failed first turn retries with full context.
    contextSent.add(topicKey)

    // Path 1 — choice-step option buttons. While onboarding, parse a trailing
    // `[[OPTIONS]]` block out of the reply, strip it from the rendered body, and
    // emit the lines as tappable buttons (the client routes a tap back as the
    // owner's next turn). Steady-state replies never carry the sentinel, so they
    // stay plain text. `allow_freeform` is always true — typing still works.
    const parsed = onboardingActive
      ? extractAgentOptions(text)
      : { body: text, options: [] as Array<{ label: string; body: string; value: string }> }
    const replyBody = parsed.body
    const replyOptions = parsed.options

    // ── 4. Persist the reply, then send it live.
    let reply_prompt_id: string | null = null
    try {
      const replyPrompt = buildButtonPrompt({
        body: replyBody,
        options: replyOptions,
        allow_freeform: true,
        expires_in_ms: REPLY_ROW_TTL_MS,
        uuid: randomUUID,
      })
      const emitted = await input.buttonStore.emit(replyPrompt, { topic_id: turn.topic_id })
      reply_prompt_id = emitted.prompt_id
    } catch (err) {
      // Persistence failure must not eat the live reply — log + ship anyway
      // (the turn survives in the CC transcript; only hydration loses it).
      console.warn(
        `${LOG_TAG} event=persist_failed project=${turn.project_slug} topic=${turn.topic_id} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    const envelope: ChatOutbound = {
      type: 'agent_message',
      body: replyBody,
      // Item 15 — stamp the owning topic so the client routes this reply to
      // ITS topic, not whatever is focused now. A slow (cold) reply can land
      // after the user switched topics; without this the client painted it
      // into the focused topic (cross-project bleed).
      topic_id: turn.topic_id,
      // Path 1 — choice-step buttons (onboarding only; empty otherwise).
      options: replyOptions,
      allow_freeform: true,
      ...(reply_prompt_id !== null ? { prompt_id: reply_prompt_id } : {}),
    }
    // Path 1 — while onboarding, carry the zip-import affordance so the client
    // shows the 📎 "attach your ChatGPT/Claude export" hint and accepts a .zip.
    if (onboardingActive && input.onboarding !== undefined) {
      const aff = input.onboarding.uploadAffordance()
      if (aff !== null) envelope.upload_affordance = aff
    }
    sendSafe(turn.send, envelope)
    try {
      input.transcript?.append({
        role: 'agent',
        body: replyBody,
        phase: 'completed',
        ...(reply_prompt_id !== null ? { button_prompt_id: reply_prompt_id } : {}),
      })
    } catch {
      /* audit-trail only */
    }
    console.info(
      `${LOG_TAG} event=replied project=${turn.project_slug} topic=${turn.topic_id} scope=${scope} chars=${text.length} elapsed_ms=${now() - started}`,
    )
    // WAVE 2 P1 — fire-and-forget correction detection over THIS exchange. The
    // hook deterministically pre-gates (most turns carry no correction cue and
    // cost nothing), then LLM-judges the rest and logs any learning so a future
    // session applies it. Returns void + swallows its own errors; the try/catch
    // is belt-and-suspenders so a synchronous throw can never break the reply.
    if (input.reflection !== undefined) {
      try {
        input.reflection.onTurnComplete({
          user_text: turn.user_text,
          // The exchange being judged is the PRIOR assistant reply + the owner's
          // response to it — not this turn's just-generated reply. Empty when
          // there is no prior reply (first message / a standing preference still
          // judges fine against an empty prior).
          agent_text: priorAgentReply ?? '',
          scope,
          observed_at,
        })
      } catch (err) {
        console.warn(
          `${LOG_TAG} event=reflection_on_turn_failed project=${turn.project_slug} topic=${turn.topic_id} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    // Path 1 — fire-and-forget onboarding scribe. The exchange judged is the
    // assistant's question this turn (`text`) + the user's answer that prompted
    // it (`turn.user_text`). Skipped for the synthetic auto-start seed turn
    // (nothing to extract) and once onboarding is complete. Non-blocking by
    // construction, so it can NEVER cause an "I didn't quite catch that" stall.
    if (onboardingActive && input.onboarding !== undefined && turn.seed_turn !== true) {
      try {
        input.onboarding.onTurnComplete({
          user_id: turn.user_id,
          user_text: turn.user_text,
          agent_text: priorAgentReply ?? '',
          observed_at,
        })
      } catch (err) {
        console.warn(
          `${LOG_TAG} event=onboarding_scribe_failed project=${turn.project_slug} topic=${turn.topic_id} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    return { outcome: 'replied', reply_prompt_id }
  }
}

/**
 * The onboarding-native user-turn persistence: stamp the typed text as the
 * `__freeform__` resolution of the topic's latest unresolved row (the
 * previous live-agent reply, or an unanswered project seed prompt). The
 * chat-history renderer then shows it as the user bubble following that
 * agent bubble. `__freeform__` is gateway-synthetic by contract
 * (channels/button-routing.ts) — the wire-level FORBIDDEN_INBOUND_VALUES
 * guard only blocks CLIENTS from forging it.
 *
 * Returns the PRIOR agent reply body (the row the user's message is responding
 * to), or null when there is no prior row — so correction detection can judge
 * the correct (prior reply, user_text) exchange. The body is returned whether or
 * not the row was already resolved; resolution is the persistence side-effect,
 * the body is the last thing the assistant said either way.
 */
async function resolvePreviousRowWithUserText(
  buttonStore: ButtonStore,
  turn: LiveAgentTurnRequest,
  observed_at: number,
  wall_now: number,
): Promise<string | null> {
  try {
    // Use the INSERTION-ORDER recency lookup, NOT the pagination-ordered
    // listHistoryByTopic: the agent-reply row and a preceding inert user-turn row
    // can share a `created_at` ms (fast warm turn / pinned test clock), and
    // pagination's `prompt_id DESC` tiebreak (a random UUID) would
    // non-deterministically return the EMPTY inert row instead of the reply —
    // making the "prior reply" judged on this turn come back blank. `rowid DESC`
    // resolves the tie to the last-written row (the reply). See
    // ButtonStore.latestTurnByTopic.
    const latest = await buttonStore.latestTurnByTopic({
      topic_id: turn.topic_id,
      before: wall_now,
      now: wall_now,
    })
    if (latest === null || latest.resolved) {
      // No UNRESOLVED row to stamp the user text onto — either the first turn
      // on this topic, or the latest row is already resolved (e.g. an inert
      // `tag_gated` quiet turn persisted while the agent was silent). Persist
      // the user line as its own durable inert turn so the engaged turn that
      // FOLLOWED a quiet stretch never loses the message that triggered it
      // (Codex cross-model review, 2026-06-26). Without this the stamp path
      // no-ops and the triggering tagged message vanishes from history.
      if (turn.user_text.length > 0) {
        await buttonStore.persistInertUserTurn({
          topic_id: turn.topic_id,
          text: turn.user_text,
          speaker_user_id: turn.user_id,
          channel_kind: 'app-socket',
        })
      }
      return latest !== null && typeof latest.body === 'string' ? latest.body : null
    }
    const priorBody = typeof latest.body === 'string' ? latest.body : null
    await buttonStore.resolve({
      choice: {
        prompt_id: latest.prompt_id,
        choice_value: '__freeform__',
        freeform_text: turn.user_text,
        chosen_at: observed_at,
        speaker_user_id: turn.user_id,
        channel_kind: 'app-socket',
      },
    })
    return priorBody
  } catch (err) {
    console.warn(
      `${LOG_TAG} event=user_turn_persist_skipped project=${turn.project_slug} topic=${turn.topic_id} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return null
  }
}

/**
 * First turn on a (instance, topic) this process: persona-assembled system
 * context + a compact recent-history block + the user's message. The warm
 * REPL keeps all of it in its own transcript for subsequent turns.
 */
async function composeFirstTurnPrompt(
  input: BuildLiveAgentTurnInput,
  turn: LiveAgentTurnRequest,
  wall_now: number,
  onboardingPreamble?: string | null,
  boardFragment?: string | null,
  onboardingContextFragment?: string | null,
): Promise<string> {
  let persona = ''
  try {
    persona = await input.personaLoader.load()
  } catch (err) {
    console.warn(
      `${LOG_TAG} event=persona_load_failed project=${turn.project_slug} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  const scopeFragment =
    turn.project_id !== undefined
      ? [
          '<live_agent_context>',
          `You are chatting with the user inside the "${turn.project_id}" project topic.`,
          'Scope your answers to this project unless the user clearly asks wider.',
          `Project files (when materialized) live under Projects/${turn.project_id}/ in your working directory.`,
          'This is a live chat turn: answer the user directly and concisely.',
          '</live_agent_context>',
        ].join('\n')
      : [
          '<live_agent_context>',
          'You are chatting with the user in their General topic — the cross-project assistant surface.',
          'Their workspace (persona/, entities/, Projects/) is your working directory; read from it when recall helps.',
          'This is a live chat turn: answer the user directly and concisely.',
          '</live_agent_context>',
        ].join('\n')
  // gap-audit item 10 — operating-doctrine layer. The owner's generated SOUL
  // (base_persona above) is mostly STATIC IDENTITY; this fragment carries the
  // owner-agnostic "how you act on every turn" doctrine (truth-first,
  // calibrated confidence, anti-sycophancy/pushback, grounding reframe) so it
  // is present consistently on EVERY topic's first turn — which anchors that
  // topic's warm CC session and therefore governs every subsequent turn on it.
  // Per-context weighted: General gets cross-project breadth, a project topic
  // gets this-project craft. NOT owner-specific; the owner's SOUL still wins on
  // any sharper rule (the fragment says so explicitly).
  const doctrineFragment = buildOperatingDoctrineFragment(
    turn.project_id !== undefined
      ? { scope: 'project', project_id: turn.project_id }
      : { scope: 'general' },
  )
  // WAVE 2 Track A — per-project persona. For a project topic, splice THAT
  // project's persona label (from `projects.persona`) as its OWN fragment so
  // this topic's dedicated warm session adopts its personality on top of the
  // owner-wide SOUL/USER doctrine. Never for General; best-effort (a missing
  // persona or a throwing resolver degrades to the owner-wide persona alone).
  const projectPersonaFragment = await composeProjectPersonaFragment(input, turn)
  // Order: doctrine (how you act) right after the SOUL persona, then the
  // project-voice refinement, then the this-turn scope block.
  // Path 1 — onboarding interview preamble. When the owner isn't onboarded yet,
  // this fragment turns the live session into the conversational interviewer
  // (get name / work / interests / agent personality + name, offer history
  // import). It sits LAST in the system stack so it governs THIS first turn most
  // strongly; the warm session keeps it for the rest of the interview.
  const onboardingFragment =
    typeof onboardingPreamble === 'string' && onboardingPreamble.trim().length > 0
      ? onboardingPreamble
      : null
  // Work Board (Phase 1a) — the board DATA block is an UNCONDITIONAL fragment
  // so the cold turn folds the orchestrator's external memory into the
  // cacheable system prefix (warm turns re-splice the fresh board before the
  // user message). Already `<work_board>`-delimited + escaped at the seam.
  const workBoardFragment =
    typeof boardFragment === 'string' && boardFragment.trim().length > 0 ? boardFragment : null
  // Per-turn onboarding grounding (import-analysis the agent already presented).
  // Sits LAST so it governs this turn most strongly — the owner is curating it.
  const onboardingContext =
    typeof onboardingContextFragment === 'string' && onboardingContextFragment.trim().length > 0
      ? onboardingContextFragment
      : null
  const instance_fragments = [
    doctrineFragment,
    ...(projectPersonaFragment !== null ? [projectPersonaFragment] : []),
    scopeFragment,
    ...(workBoardFragment !== null ? [workBoardFragment] : []),
    ...(onboardingFragment !== null ? [onboardingFragment] : []),
    ...(onboardingContext !== null ? [onboardingContext] : []),
  ]
  let system: string
  try {
    system = await assembleSystemPrompt({
      base_persona: persona.trim().length > 0 ? persona : FALLBACK_PERSONA,
      agent_kind:
        turn.project_id !== undefined ? `project-agent:${turn.project_id}` : 'general-agent',
      owner_home: input.owner_home,
      instance_fragments,
      channel: 'web',
      active_skills: [],
    })
  } catch (err) {
    // Assembler reads owner workspace files — a pathological owner_home
    // must not kill the turn. Degrade to persona + (project persona) + scope.
    console.warn(
      `${LOG_TAG} event=system_prompt_assembly_failed project=${turn.project_slug} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    system = [
      persona.trim().length > 0 ? persona : FALLBACK_PERSONA,
      doctrineFragment,
      ...(projectPersonaFragment !== null ? [projectPersonaFragment] : []),
      scopeFragment,
    ].join('\n\n')
  }
  const history = await renderRecentHistoryBlock(input.buttonStore, turn.topic_id, wall_now)
  // WAVE 2 P1 — splice the reflection layer's learned-corrections + recent-diary
  // block so this topic's warm session adopts the owner's past corrections on
  // its first turn and applies them silently. Best-effort: a throwing/absent
  // seam degrades to no block, never kills the turn.
  let reflectionBlock: string | null = null
  if (input.reflection !== undefined) {
    try {
      reflectionBlock = input.reflection.loadContext()
    } catch (err) {
      console.warn(
        `${LOG_TAG} event=reflection_context_failed project=${turn.project_slug} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  const parts = [system]
  if (reflectionBlock !== null && reflectionBlock.trim().length > 0) parts.push(reflectionBlock)
  if (history !== null) parts.push(history)
  parts.push(
    `The user's message follows. Reply to it directly.\n\n${turn.user_text}`,
  )
  return parts.join('\n\n')
}

/**
 * WAVE 2 Track A — resolve THIS project topic's persona into a spliceable
 * `<project_persona>` fragment, or null when there is none to inject.
 *
 * Returns null (no fragment) when:
 *   - this is the General topic (`turn.project_id === undefined`) — General is
 *     the cross-project surface and carries no project persona;
 *   - no `projectPersonaResolver` is wired (the LLM-less / pre-WAVE-2 path);
 *   - the resolver returns null / empty / whitespace for this project;
 *   - the resolver throws (a pathological projects-table read must degrade to
 *     the owner-wide persona, never kill the turn).
 *
 * The label is wrapped so the model can attribute the instruction to its
 * project and is told it sits ON TOP of the owner-wide doctrine, not in place
 * of it (the owner's SOUL/USER is still the base_persona).
 */
async function composeProjectPersonaFragment(
  input: BuildLiveAgentTurnInput,
  turn: LiveAgentTurnRequest,
): Promise<string | null> {
  if (turn.project_id === undefined) return null
  if (input.projectPersonaResolver === undefined) return null
  let label: string | null
  try {
    label = await input.projectPersonaResolver(turn.project_id)
  } catch (err) {
    console.warn(
      `${LOG_TAG} event=project_persona_resolve_failed project=${turn.project_slug} topic=${turn.topic_id} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return null
  }
  if (label === null) return null
  const trimmed = label.trim()
  if (trimmed.length === 0) return null
  return [
    '<project_persona>',
    `For the "${turn.project_id}" project, embody this persona on top of your`,
    'owner-wide doctrine (it refines your voice for this project; it does not',
    'replace who you are):',
    // XML-escape the persona body before splicing it inside the
    // `<project_persona>` boundary (#322). The persona is owner-authored on a
    // single-owner Open instance today, but once `projects.persona` becomes
    // non-owner-writable (shared/imported projects — M2/M6) a persona literally
    // containing `</project_persona>` could close the tag early and inject
    // sibling instructions. Mirrors the escalation envelope's text escaping.
    escapeProjectPersonaText(trimmed),
    '</project_persona>',
  ].join('\n')
}

/**
 * Escape XML text content (`&`, `<`, `>`) for splicing inside an element
 * body. Quotes are legal inside element bodies, so they are left as-is to
 * avoid bloating the prompt. Anti-injection rationale matches
 * `escalation-loader.ts`'s `escapeXmlText`: the envelope is consumed by an
 * LLM (not a strict XML parser), so the goal is "no syntactic confusion that
 * could let the persona inject sibling tags," not full schema validity.
 */
function escapeProjectPersonaText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Compact chronological replay of the topic's recent `button_prompts`
 * history for the first turn's short-term memory. Resolved rows carry the
 * [agent body → user reply] pair; the just-resolved previous reply row
 * (step 1) makes the user's prior line part of this block too.
 */
async function renderRecentHistoryBlock(
  buttonStore: ButtonStore,
  topic_id: string,
  wall_now: number,
): Promise<string | null> {
  try {
    const { turns } = await buttonStore.listHistoryByTopic({
      topic_id,
      before: wall_now,
      before_prompt_id: null,
      limit: HISTORY_SPLICE_LIMIT,
      now: wall_now,
    })
    if (turns.length === 0) return null
    const lines: string[] = []
    // listHistoryByTopic returns newest-first; render oldest-first.
    for (const t of [...turns].reverse()) {
      lines.push(`Assistant: ${t.body}`)
      if (t.resolved && t.resolution_text.length > 0) {
        lines.push(`User: ${t.resolution_text}`)
      }
    }
    return `<recent_conversation>\n${lines.join('\n')}\n</recent_conversation>`
  } catch {
    return null
  }
}

/** Socket writes must never abort a turn (mirrors emitTypingBracket). */
function sendSafe(send: (event: ChatOutbound) => void, event: ChatOutbound): void {
  try {
    send(event)
  } catch (err) {
    console.warn(
      `${LOG_TAG} event=send_failed err=${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
