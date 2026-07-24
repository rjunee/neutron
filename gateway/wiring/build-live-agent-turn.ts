/**
 * @neutronai/gateway/wiring — post-onboarding live-agent chat turn.
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

import type { ButtonStore } from '@neutronai/channels/button-store.ts'
import {
  buildButtonPrompt,
  MAX_OPTIONS_TELEGRAM,
  RESERVED_OPTION_VALUES,
  VALUE_BYTE_CAP,
} from '@neutronai/channels/button-primitive.ts'
import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'
import { assembleSystemPrompt } from '@neutronai/runtime/system-prompt.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { ToolDef } from '@neutronai/cores-sdk/manifest'
import { collectTokensToString } from './build-llm-call-substrate.ts'
import { buildOperatingDoctrineFragment } from './operating-doctrine.ts'
import { buildLiveAgentScopeFragment } from './live-agent-scope-fragment.ts'
import type { LiveAgentTurnRequest } from '../http/chat-bridge.ts'
import { fireAndForget, neutralizeAbandonedSettle } from '@neutronai/logger/fire-and-forget.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('live-agent-turn')

/**
 * ACTIVITY-BASED turn timeout (2026-07-01). The per-turn budget is NOT a fixed
 * wall clock. The substrate abandons a turn only after `turn_timeout_ms` with NO
 * PTY activity from the `claude` child (an actively-working turn resets that idle
 * clock on every spinner tick / streamed token / tool-output byte), so a
 * long-but-live turn runs as long as it needs. `TURN_INACTIVITY_MS` is the warm
 * steady-state idle window sent as `spec.turn_timeout_ms`.
 *
 * Historical note: this fix replaced a fixed 180s (substrate) / 240s (composer)
 * wall clock that hard-failed a slow-but-active turn — Ryan live-test 2026-07-01:
 * a "weave timer+tracker together then do full e2e testing" turn died at
 * elapsed_ms=180009 while the agent was still working, then showed a misleading
 * "your AI connection may need attention in settings" dead-end.
 */
const TURN_INACTIVITY_MS = 90_000

/**
 * Larger inactivity window for a COLD first turn / onboarding turn. Those turns
 * carry a heavier initial payload (a large system / onboarding prompt) whose first
 * silent think — before the TUI starts rendering — can run longer under machine
 * load. A more generous idle tolerance keeps a slow-but-progressing cold turn
 * alive; the absolute ceiling below still bounds a genuinely hung one. (The cold
 * SPAWN itself — REPL fork, MCP/dev-channel bind, plugin load — happens BEFORE the
 * substrate's per-turn watchdog starts, so it is covered by the composer's
 * absolute-ceiling AbortController, not this idle window.)
 */
const COLD_TURN_INACTIVITY_MS = 180_000

/**
 * Absolute-ceiling backstop (ms) for a single turn — the hard upper bound, wired
 * to BOTH the composer's AbortController AND the substrate
 * (`spec.turn_absolute_ceiling_ms`). Bounds the cold-spawn phase and a
 * live-but-livelocked child. Very high (45min) — a real turn, however long,
 * settles well under it; this exists only so a truly-hung process can't live
 * forever. Overridable via `input.timeout_ms` (tests pin a small value).
 */
const TURN_ABSOLUTE_CEILING_MS = 45 * 60_000

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
 * M2 modality threading — build the `<user_attachments>` PROMPT fragment for a
 * turn's attachment upload URLs. Each URL is resolved to its local blob path via
 * the injected `resolve` seam; unresolvable/malformed URLs are skipped (a `warn`
 * is logged, never a throw). Returns null when there are no attachments, no
 * resolver, or nothing resolved — so the caller splices a clean no-op (no bare
 * `<user_attachments>` tag). The fragment lists each resolved ABSOLUTE path +
 * canonical MIME and instructs the agent to open them with the `Read` tool (the
 * CC REPL renders images AND PDFs natively from local paths).
 *
 * Exported for unit testing.
 */
export function buildAttachmentsFragment(
  attachments: ReadonlyArray<string> | undefined,
  resolve:
    | ((url: string) => { path: string; content_type: string; transcript?: string | null } | null)
    | undefined,
  warn: (event: string, meta: Record<string, unknown>) => void = () => undefined,
): string | null {
  if (resolve === undefined) return null
  if (attachments === undefined || attachments.length === 0) return null
  const lines: string[] = []
  for (const url of attachments) {
    if (typeof url !== 'string' || url.length === 0) continue
    let resolved: { path: string; content_type: string; transcript?: string | null } | null = null
    try {
      resolved = resolve(url)
    } catch (err) {
      warn('attachment_resolve_failed', {
        url,
        error: err instanceof Error ? err.message : String(err),
      })
      resolved = null
    }
    if (resolved === null) {
      warn('attachment_unresolved', { url })
      continue
    }
    // M2 task 5 — AUDIO voice notes carry an auto-transcript inline (the agent
    // cannot `Read` raw audio bytes). A non-empty transcript is embedded (capped
    // so a long note doesn't blow the prompt budget); a null/absent transcript
    // (keyless box or failed ASR) degrades to a graceful note telling the owner
    // how to enable it.
    if (resolved.content_type.startsWith('audio/')) {
      const transcript = resolved.transcript
      if (typeof transcript === 'string' && transcript.trim().length > 0) {
        const trimmed = transcript.trim()
        const capped =
          trimmed.length > ATTACHMENT_TRANSCRIPT_MAX_CHARS
            ? `${trimmed.slice(0, ATTACHMENT_TRANSCRIPT_MAX_CHARS)}… [transcript truncated]`
            : trimmed
        lines.push(`- ${resolved.path} (${resolved.content_type}) — voice note; auto-transcript:`)
        for (const l of capped.split('\n')) lines.push(`  ${l}`)
      } else {
        lines.push(
          `- ${resolved.path} (${resolved.content_type}) — voice note; transcription unavailable — set OPENAI_API_KEY to enable voice transcription`,
        )
      }
      continue
    }
    lines.push(`- ${resolved.path} (${resolved.content_type})`)
  }
  if (lines.length === 0) return null
  return [
    '<user_attachments>',
    'The user attached these local files with their message. Open images and PDFs',
    'with the Read tool to view their contents (it renders them natively from local',
    'paths). AUDIO voice notes include an auto-generated transcript inline below —',
    'do NOT attempt to Read the raw audio bytes; use the transcript text:',
    ...lines,
    '</user_attachments>',
  ].join('\n')
}

/** Cap on an inlined voice-note transcript (chars) so one long note can't blow
 *  the prompt budget. Task 5. */
const ATTACHMENT_TRANSCRIPT_MAX_CHARS = 4000

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

/**
 * Friendly failure bubble — the anti-silence guarantee. Used ONLY for a genuine
 * credential / connection / substrate failure (all-cooldown, binary-not-found,
 * channel-wedged, empty reply). A freeze-TIMEOUT is NOT surfaced with this text —
 * misdiagnosing a slow turn as a credential problem is exactly the dead-end Ryan
 * flagged (2026-07-01). Timeouts get `TIMEOUT_BODY` + a Retry affordance instead.
 */
const FAILURE_BODY =
  'I hit a problem answering that. Give it another try in a moment — if it keeps happening, your AI connection may need attention in settings.'

/**
 * Freeze-timeout bubble (2026-07-01). Honest: a timeout is a slow / wedged turn,
 * not a setup problem. Shown only after the automatic single retry ALSO froze;
 * paired with a one-click Retry button (below) and `allow_freeform` so the user
 * can simply send again. NEVER the misleading "AI connection may need attention"
 * text — that misdiagnoses a timeout as a credential failure.
 */
export const TIMEOUT_BODY =
  'That one took too long, so I stopped before finishing. This is usually a temporary hiccup, not a problem with your setup — tap Retry, or just send it again.'

/**
 * Auth-reconnect bubble (2026-07-24 dogfood). Shown when the turn failed because the
 * underlying Claude connection reported an invalid/expired credential (the substrate
 * stamps `auth_invalid`; see `isAuthInvalid`). This is DISTINCT from a freeze-timeout
 * and from the generic `FAILURE_BODY`: the actionable fix is to reconnect the Claude
 * token, so the message says exactly that instead of the useless "tap Retry" (which
 * would just hit the same invalid token). Kept honest + specific: an expired token or
 * a hit usage limit both surface this way.
 *
 * Reconnect story (investigated 2026-07-24): a pure browser-only re-auth is NOT
 * feasible with what the repo has — `claude setup-token` (the OAuth step) must be run
 * on the machine and its printed token captured from the CLI's stdout. That capture
 * is exactly what the existing install-token handoff automates (`open/install-token-
 * handoff.ts`), and that handoff is already reconnect-capable as-is (its stateless
 * signup_id → persist-token → restart flow works whether it is a first-time setup or
 * a token refresh — no changes needed). So the bubble points at the same reconnect
 * command; a one-click in-chat "reconnect" button that drives the handoff end-to-end
 * is a follow-up (it needs a client affordance + turn→handoff plumbing), tracked
 * rather than half-built here.
 */
export const AUTH_RECONNECT_BODY =
  'Your Claude connection needs to be reconnected. The access token has expired or was rejected (this can also happen right after hitting a usage limit). Reconnect it by running `claude setup-token` on the machine running Neutron (or re-running the install command), then send your message again.'

/**
 * Retry-affordance routing value (2026-07-01). Emitted as the Retry button's
 * `value` on the freeze-timeout bubble; a tap routes it back as the next turn.
 * The runner special-cases it: recover the last real user message for this topic
 * (`lastUserText`) and re-run on THAT — so Retry acts on what the user actually
 * asked, not this opaque token. Short (≤ VALUE_BYTE_CAP), NOT a reserved option
 * value (so it validates) and NOT a forbidden inbound sentinel (so the tap is not
 * rejected at the wire guard). Distinctive enough that a user is exceedingly
 * unlikely to type it verbatim.
 */
export const RETRY_TURN_VALUE = '__retry_turn__'

/**
 * Fallback re-prompt when a Retry tap arrives but no prior user message is
 * recorded for the topic (e.g. a gateway restart cleared the in-process map).
 * The turn still does something sensible rather than echoing the opaque sentinel.
 */
const RETRY_FALLBACK_TEXT = 'Please try my previous message again.'

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
  /**
   * BUG 1 fix (2026-06-30) — deterministic button-backed answer capture, run at
   * turn-START (BEFORE the system prompt / step-guard reads `phase_state`) and
   * AWAITED (not fire-and-forget) so the persist is visible to the same turn's
   * grounding. When the owner taps/types the agent name or personality, this
   * writes it straight to `phase_state` so the required-step audit recomputes
   * with the answer already settled and never re-asks. A no-op turn (not a
   * name/personality answer) returns `{ finalized: false }` and the turn runs
   * normally.
   *
   * `finalized: true` signals BUG 2: this answer settled the LAST required field
   * and onboarding finalize was fired, so the runner MUST suppress its own
   * wrap-up reply — the deterministic finalize closing (which names the left
   * rail) is the single closing. Optional + best-effort: a throwing/absent seam
   * degrades to the pre-fix behaviour (extractor-only persistence).
   */
  captureRequiredAnswer?(input: {
    user_id: string
    user_text: string
    /** The DURABLE option values of the prior agent question (its persisted
     *  `options[].value`), NOT the row body — live-agent replies strip the
     *  `[[OPTIONS]]` block out of `body`, so the body alone would never match. */
    prior_agent_options: ReadonlyArray<string>
  }): Promise<{ finalized: boolean }>
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
   * the active project (active+next items + the drift-guard advisory), or null
   * when there is nothing to inject / the read failed. Keyed on BOTH the instance
   * `project_slug` (owner boundary) and the real per-turn `project_id` (the
   * per-project dimension; undefined on General) so the injected board matches
   * the project the agent's `work_board_*` writes scope to — otherwise the agent
   * re-grounds on General's board while writing to the project's, or vice-versa.
   * Injected on EVERY turn: the cold first turn adds it as an unconditional
   * `instance_fragments` entry; warm turns splice it before the user's message
   * (since `instance_fragments` is assembled only on the cold turn, a fragment-
   * only wiring would re-ground once per session, not every turn). Best-effort: a
   * throwing/absent seam degrades to no block, never kills the turn.
   */
  workBoardSnapshot?: (project_slug: string, project_id: string | undefined) => string | null
  /**
   * RC3 ([BEHAVIOR]) — the agent-nexus re-grounding seam. Returns the ALREADY-
   * FORMATTED, escaped `<agent_nexus>` DATA block of the recent decision/handoff/
   * learning events OTHER agents recorded on this project (an overnight trident
   * run's Argus verdict, an owner correction reflection captured), or `null` when
   * the log is empty / the read failed. ASYNC because the nexus sidecar read is
   * async (unlike the sync in-memory work board). Keyed on BOTH the instance
   * `project_slug` (owner boundary) and the real per-turn `project_id` (undefined
   * on General) so the reader scopes to the SAME `.nexus` RC2's emitters wrote to.
   * Injected on EVERY turn like the work board (cold → `instance_fragments`; warm
   * → spliced before the user's message). Wired ONLY when the shared perfect-recall
   * flag is on (the composer builds no `NexusStore` otherwise), so RC3 ships DARK.
   * Best-effort: a throwing/absent seam degrades to no block, never kills the turn.
   */
  nexusSnapshot?: (
    project_slug: string,
    project_id: string | undefined,
  ) => Promise<string | null>
  /**
   * Per-project "available services" awareness (Settings-tab credentials).
   * Returns the ALREADY-FORMATTED, escaped `<available_services>` DATA block
   * for the active project — which external services are credentialed
   * (per-project or global default) so the agent knows what it can use and can
   * gracefully refuse the rest. Keyed on BOTH the instance `project_slug` (the
   * owner boundary) and the real per-turn `project_id` (the per-project
   * dimension; undefined on the General topic → global defaults only). Injected
   * every turn like the work board; best-effort (throwing/absent → no block).
   */
  availableServicesSnapshot?: (
    project_slug: string,
    project_id: string | undefined,
  ) => string | null
  /**
   * RB1 (perfect-recall lane) — the breadth memory-index manifest. Returns the
   * ALREADY-FORMATTED, escaped `<memory_index>` DATA block (a pointers-only map
   * of the entities the owner's memory knows about: `slug → title → one-line`
   * for people/companies/concepts) so the agent can name — and then
   * `memory_search` — an entity it was never told about in-conversation. Unlike
   * the work board this is injected ONCE per (instance, topic) session: it folds
   * into the cold-turn `instance_fragments` only (stable breadth, not per-turn
   * state), so warm turns don't re-splice it. Omitted when the perfect-recall
   * flag is off; best-effort (a throwing/absent seam degrades to no block).
   */
  memoryIndexSnapshot?: () => Promise<string | null> | string | null
  /**
   * Plan task 8 — the deterministic ritual-approval capture seam. When wired, at
   * turn-START (after user-turn persistence, BEFORE the onboarding required-answer
   * capture) the runner calls this with the owner's answer + the PERSISTED option
   * values of the prior prompt. It resolves an in-chat ritual approval ONLY on an
   * EXACT match of an `rap:` opaque token in that persisted set (owner-only). On a
   * non-null result the runner ships that deterministic confirmation and NEVER
   * dispatches the LLM turn (an opaque approval token must never fall through to
   * the free-text personality capture or the substrate). Omitted (LLM-less box /
   * no credential) ⇒ no-op, the turn runs normally. Best-effort: a throwing seam
   * degrades to the normal turn.
   */
  ritualApprovalCapture?: (input: {
    user_id: string
    user_text: string
    topic_id: string
    prior_option_values: readonly string[]
  }) => Promise<{ body: string } | null>
  /**
   * M2 modality threading — resolve a chat-attachment upload URL to its local
   * blob path + canonical MIME (`resolveChatAttachmentLocalPath`, supplied by
   * the composer over `owner_home`). When wired AND a turn carries
   * `attachments`, the runner builds a `<user_attachments>` prompt fragment of
   * the resolved absolute paths so the agent can `Read` them (the CC REPL
   * renders images AND PDFs natively). An unresolvable URL is skipped with a
   * warn (never throws). Omitted (LLM-less box) ⇒ no attachment fragment.
   */
  resolveAttachment?: (
    url: string,
  ) => { path: string; content_type: string; transcript?: string | null } | null
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
  // Absolute-ceiling backstop for a turn (composer AbortController + substrate
  // `spec.turn_absolute_ceiling_ms`). This is NOT the fixed per-turn cap the old
  // code used — the substrate's activity watchdog handles freeze detection; this
  // only bounds the cold-spawn phase + a live-but-livelocked child. `input.timeout_ms`
  // overrides it (tests pin a small value).
  const absoluteCeilingMs = input.timeout_ms ?? TURN_ABSOLUTE_CEILING_MS
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
   * Retry affordance (2026-07-01) — the last REAL user message per (instance,
   * topic) THIS process. Recorded on every real user turn; consulted when a turn
   * arrives carrying `RETRY_TURN_VALUE` (a tap on the freeze-timeout Retry button)
   * so the retry re-runs on what the user actually asked, not the opaque sentinel.
   * Lost on restart — a Retry tapped after a gateway restart falls back to
   * `RETRY_FALLBACK_TEXT`, which is fine: a freeze + Retry is a same-session,
   * seconds-to-minutes flow.
   */
  const lastUserText = new Map<string, string>()

  /**
   * Retry affordance, attachments companion — the last REAL turn's attachment
   * upload URLs per (instance, topic) THIS process. Recorded alongside
   * `lastUserText` on every real user turn; consulted on a `RETRY_TURN_VALUE`
   * recovery so the retried turn re-injects the ORIGINAL attachments (the doc /
   * image the user sent). Without this, a Retry after a freeze recovers only the
   * text and silently drops the attachment, so the agent can no longer see it.
   */
  const lastAttachments = new Map<string, ReadonlyArray<string>>()

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
    // `tail` is a deliberately never-rejecting sequencing baton; this only prunes
    // the per-topic chain map — no rejection to surface (the real turn error is
    // returned to the caller via `run`). Silent neutralize, not fireAndForget.
    neutralizeAbandonedSettle(tail.then(() => {
      if (turnChains.get(topicKey) === tail) turnChains.delete(topicKey)
    }))
    return run
  }

  return runLiveAgentTurn

  async function runTurnBody(
    turn: LiveAgentTurnRequest,
  ): Promise<LiveAgentTurnResult> {
    const observed_at = turn.observed_at ?? now()
    const topicKey = `${turn.project_slug}:${turn.topic_id}`
    // Retry affordance (2026-07-01): a tap on the freeze-timeout Retry button
    // routes back `RETRY_TURN_VALUE`. Recover the last real user message for this
    // topic and re-run on THAT (so every downstream step — persistence, prompt,
    // scribe — sees the real question, not the opaque sentinel). Rebind `turn`
    // once, up front, so the rest of the body is retry-agnostic. Fall back to a
    // gentle re-prompt if nothing was recorded (e.g. a restart cleared the map).
    if (turn.user_text === RETRY_TURN_VALUE) {
      const recovered = lastUserText.get(topicKey) ?? RETRY_FALLBACK_TEXT
      const recoveredAttachments = lastAttachments.get(topicKey)
      moduleLog.info('retry_tap', {
        project: turn.project_slug,
        topic: turn.topic_id,
        recovered: recovered !== RETRY_FALLBACK_TEXT,
        attachments: recoveredAttachments?.length ?? 0,
      })
      // Re-inject the ORIGINAL attachments too, not just the text — a freeze +
      // Retry on a turn that carried a doc/image must re-run WITH that doc/image.
      // Only set the optional field when there ARE attachments (exactOptional).
      turn =
        recoveredAttachments !== undefined
          ? { ...turn, user_text: recovered, attachments: recoveredAttachments }
          : { ...turn, user_text: recovered }
    }
    // Record the last real user message + its attachments so a later Retry tap
    // can recover both. Skip the synthetic seed turn (no real message) and an
    // empty body.
    if (turn.seed_turn !== true && turn.user_text.length > 0) {
      lastUserText.set(topicKey, turn.user_text)
      if (turn.attachments !== undefined && turn.attachments.length > 0) {
        lastAttachments.set(topicKey, turn.attachments)
      } else {
        lastAttachments.delete(topicKey)
      }
    }
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
    // BUG 1 fix — read the prior agent question's DURABLE options BEFORE the
    // resolve below mutates the row (and before an inert user-turn row can become
    // "latest"). Live-agent replies persist the `[[OPTIONS]]` block stripped from
    // `body` (it lives in `options_json`), so the deterministic capture must key
    // off these persisted option values, not the stripped body text. Onboarding-
    // only + best-effort: a read failure degrades to no capture.
    let priorAgentOptions: string[] = []
    if (
      turn.seed_turn !== true &&
      ((onboardingActive && input.onboarding?.captureRequiredAnswer !== undefined) ||
        input.ritualApprovalCapture !== undefined)
    ) {
      try {
        const priorPrompt = await input.buttonStore.latestPromptByTopic({
          topic_id: turn.topic_id,
          before: now(),
          now: now(),
        })
        priorAgentOptions = priorPrompt?.options.map((o) => o.value) ?? []
      } catch {
        priorAgentOptions = []
      }
    }
    // Argus r1 BLOCKER — a web ritual emits TWO prompts in one turn (content grant
    // + separate egress grant), so the CONTENT Approve token stops being "the
    // latest prompt" once the egress prompt lands, and keying the ritual capture
    // off `latestPromptByTopic` alone makes the content token uncapturable (web
    // rituals could never be scheduled). Union the recent option set instead —
    // still T8-safe (a value is eligible only if it was a real offered button in a
    // recent prompt), kept SEPARATE from onboarding's latest-only capture.
    let priorRitualOptions: string[] = []
    if (turn.seed_turn !== true && input.ritualApprovalCapture !== undefined) {
      try {
        priorRitualOptions = await input.buttonStore.recentPromptOptionsByTopic({
          topic_id: turn.topic_id,
          before: now(),
          now: now(),
          limit: 4,
        })
      } catch {
        priorRitualOptions = []
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

    // Plan task 8 — deterministic ritual-approval capture. Runs AFTER step-1
    // user-turn persistence + transcript append and BEFORE the onboarding
    // required-answer capture, so an opaque `rap:` approval token can NEVER fall
    // through to the personality free-text capture or the substrate LLM turn. The
    // seam resolves the approval ONLY on an exact match of a persisted option
    // value (owner-only) — an unrelated reply returns null and the turn runs
    // normally (T8). Best-effort: a throw warns + continues the normal turn.
    if (
      input.ritualApprovalCapture !== undefined &&
      turn.seed_turn !== true &&
      priorRitualOptions.length > 0
    ) {
      try {
        const result = await input.ritualApprovalCapture({
          user_id: turn.user_id,
          user_text: turn.user_text,
          topic_id: turn.topic_id,
          prior_option_values: priorRitualOptions,
        })
        if (result !== null) {
          // Persist the deterministic confirmation as an inert history turn +
          // ship it live; the LLM turn is NEVER dispatched for an approval act.
          try {
            await input.buttonStore.persistInertAgentTurn({
              topic_id: turn.topic_id,
              body: result.body,
            })
          } catch (err) {
            moduleLog.warn('ritual_capture_persist_failed', {
              project: turn.project_slug,
              topic: turn.topic_id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          sendSafe(turn.send, {
            type: 'agent_message',
            body: result.body,
            topic_id: turn.topic_id,
            options: [],
            allow_freeform: true,
          })
          try {
            input.transcript?.append({ role: 'agent', body: result.body, phase: 'completed' })
          } catch {
            /* audit-trail only */
          }
          return { outcome: 'replied', reply_prompt_id: null }
        }
      } catch (err) {
        moduleLog.warn('ritual_capture_failed', {
          project: turn.project_slug,
          topic: turn.topic_id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // BUG 1 fix (2026-06-30) — deterministic button-backed answer capture. When
    // the owner just tapped/typed the agent name or personality, persist it to
    // `phase_state` NOW — synchronously, BEFORE the step-guard grounding below
    // reads `phase_state` — so the required-step audit recomputes with the answer
    // already settled and the live agent never re-asks it (the flaky post-turn
    // extractor was the sole writer; see button-backed-answer.ts). Awaited (not
    // fire-and-forget) precisely so the write is visible to THIS turn's prompt.
    // Skipped for the synthetic seed turn (no answer). Best-effort: a throwing
    // seam degrades to extractor-only persistence, never kills the turn.
    if (
      onboardingActive &&
      turn.seed_turn !== true &&
      input.onboarding?.captureRequiredAnswer !== undefined
    ) {
      try {
        const capture = await input.onboarding.captureRequiredAnswer({
          user_id: turn.user_id,
          user_text: turn.user_text,
          prior_agent_options: priorAgentOptions,
        })
        // BUG 2 fix — this answer settled the LAST required field and finalize
        // fired. Suppress the live agent's own wrap-up so the ONE closing is the
        // deterministic finalize message (which already names the left rail). The
        // owner's answer bubble was already persisted (step 1); finalize delivers
        // the closing + per-project openings over the same durable path.
        if (capture.finalized) {
          return { outcome: 'replied', reply_prompt_id: null }
        }
      } catch (err) {
        moduleLog.warn('capture_required_answer_failed', {
          project: turn.project_slug,
          topic: turn.topic_id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // ── 2. Compose the prompt. (`topicKey` was resolved at the top of the body.)
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
        workBoardFragment = input.workBoardSnapshot(turn.project_slug, turn.project_id)
      } catch (err) {
        moduleLog.warn('work_board_snapshot_failed', {
          project: turn.project_slug,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // Available-services awareness — resolve the project-scoped credential
    // picture ONCE for this turn (keyed on the real per-turn project_id, so
    // switching projects flips availability). Best-effort like the board.
    let availableServicesFragment: string | null = null
    if (input.availableServicesSnapshot !== undefined) {
      try {
        availableServicesFragment = input.availableServicesSnapshot(
          turn.project_slug,
          turn.project_id,
        )
      } catch (err) {
        moduleLog.warn('available_services_snapshot_failed', {
          project: turn.project_slug,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // RC3 — agent-nexus re-grounding. Read the recent decision/handoff/learning
    // events OTHER agents recorded on this project ONCE for this turn, formatted as
    // the escaped `<agent_nexus>` DATA block. ASYNC (the nexus sidecar read is
    // async). Best-effort like the board: a throwing/absent seam (or an empty log)
    // degrades to no block, never kills the turn.
    let nexusFragment: string | null = null
    if (input.nexusSnapshot !== undefined) {
      try {
        nexusFragment = await input.nexusSnapshot(turn.project_slug, turn.project_id)
      } catch (err) {
        moduleLog.warn('nexus_snapshot_failed', {
          project: turn.project_slug,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // RB2 (a) — the reflection layer's learned-corrections + recent-diary block,
    // resolved ONCE PER TURN (exactly like the work board + nexus) so it re-splices
    // on WARM turns too, not only the cold first turn. Before RB2 this was loaded
    // ONLY inside `composeFirstTurnPrompt` (cold), so any correction the reflection
    // layer had persisted mid-session didn't resurface until a brand-new session; now
    // the FRESH block is re-read + spliced before the user's message on every warm
    // turn. What RB2 (a) guarantees is precise: the CURRENTLY-PERSISTED corrections
    // re-appear every warm turn. It does NOT force a just-submitted correction to
    // surface on the immediately-next turn — correction DETECTION is intentionally
    // async fire-and-forget (`reflection.onTurnComplete`; an LLM judge that persists
    // AFTER it resolves, F3 — blocking every chat turn on it would be an unacceptable
    // latency regression), so a correction typically lands by the next turn but an
    // instantly-fired follow-up can out-race the persist and see it one turn later.
    // Already capped in the reflection layer (12 corrections / 3 days) — RB2 does
    // NOT change the cap, only the first-turn-only gate. Best-effort: a
    // throwing/absent seam degrades to no block, and an empty context stays null so
    // the splice is a clean no-op (no bare `<reflection>` tag).
    let reflectionFragment: string | null = null
    if (input.reflection !== undefined) {
      try {
        reflectionFragment = input.reflection.loadContext()
      } catch (err) {
        moduleLog.warn('reflection_context_failed', {
          project: turn.project_slug,
          error: err instanceof Error ? err.message : String(err),
        })
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
        moduleLog.warn('onboarding_context_failed', {
          user: turn.user_id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // M2 modality threading — resolve this turn's attachment upload URLs to a
    // `<user_attachments>` prompt fragment of local blob paths the agent can
    // `Read`. Built once for the turn; injected on BOTH the warm splice (right
    // before the user's message, so it's adjacent to what it describes) and the
    // cold first-turn prompt. NEVER mutates `turn.user_text` (that feeds
    // capture/reflection/scribe/persistence) — the paths live in the prompt only.
    const attachmentsFragment = buildAttachmentsFragment(
      turn.attachments,
      input.resolveAttachment,
      (event, meta) => moduleLog.warn(event, { project: turn.project_slug, topic: turn.topic_id, ...meta }),
    )
    let prompt: string
    const isColdFirstTurn = !contextSent.has(topicKey)
    if (!isColdFirstTurn) {
      // Warm turn: the system prefix is already cached in the REPL's transcript;
      // re-ground by splicing the FRESH board + onboarding-context blocks before
      // the user's message. The attachment fragment goes LAST — immediately
      // before the user's message — so the resolved doc/image paths sit adjacent
      // to the message they belong to (onboarding context precedes it).
      const warmPrefix = [
        workBoardFragment,
        nexusFragment,
        reflectionFragment,
        availableServicesFragment,
        onboardingContextFragment,
        attachmentsFragment,
      ].filter((s): s is string => s !== null && s.trim().length > 0)
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
        availableServicesFragment,
        nexusFragment,
        reflectionFragment,
        attachmentsFragment,
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
        // FIX #333 — `system_notice: true` marks this a TRANSIENT live-only pill:
        // the client renders it as a quiet centered "Waking up…" notice, and the
        // persistence layer (`AppWsAdapter.send`) skips the durable chat_log row,
        // so a reload/project-switch can't re-hydrate it as a stray chat bubble.
        sendSafe(turn.send, {
          type: 'agent_message',
          body: COLD_START_ACK_BODY,
          topic_id: turn.topic_id,
          system_notice: true,
        })
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
    // ACTIVITY-BASED per-turn budgets (2026-07-01). Both are ADDITIVE spec fields
    // the persistent-REPL adapter reads. `turn_timeout_ms` is the INACTIVITY window
    // (idle-time-since-last-PTY-byte before a turn is deemed frozen) — an active
    // turn resets it on every byte, so a long-but-working turn is never killed on a
    // fixed clock. A COLD first turn / onboarding turn gets the larger idle window
    // (heavier initial processing); warm steady-state stays snappy. `turn_absolute_
    // ceiling_ms` is the hard backstop. The composer's own AbortController mirrors
    // the ceiling (below) to bound the cold-spawn phase, which runs before the
    // substrate's watchdog starts.
    const isColdOrOnboardingTurn = isColdFirstTurn || onboardingActive
    const inactivityMs = isColdOrOnboardingTurn ? COLD_TURN_INACTIVITY_MS : TURN_INACTIVITY_MS
    const spec: AgentSpec = {
      prompt,
      tools,
      model_preference: [model],
      // Per-(instance, topic) warm-session key: the persistent substrate folds
      // `metering_context.project_id` into its pool key when no
      // projectIdResolver is wired on this substrate (build-llm-call-
      // substrate.ts). Per-dispatch ⇒ race-free across concurrent topics.
      metering_context: { project_id: scope },
      turn_timeout_ms: inactivityMs,
      turn_absolute_ceiling_ms: absoluteCeilingMs,
    }
    if (input.max_tokens !== undefined) spec.max_tokens = input.max_tokens

    // Dispatch, collecting the reply text; the composer AbortController is a pure
    // ABSOLUTE-CEILING backstop (the substrate's activity watchdog does freeze
    // detection). Returns the text, or throws the substrate/abort error.
    const dispatchOnce = async (): Promise<string> => {
      const handle = input.substrate.start(spec)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), absoluteCeilingMs)
      try {
        // FIX #347 — cancel the pending cold-start ack the moment the FIRST
        // token streams (not only when the whole turn settles below), so a turn
        // that starts replying before the ack delay elapses never fires a
        // spurious "Waking up…" pill after the answer has begun.
        return await collectTokensToString(handle, ac.signal, clearAckTimer)
      } finally {
        clearTimeout(timer)
        // Item 12 — the dispatch settled; cancel the cold-start ack if it
        // hasn't already fired (warm/fast turn → no spurious "waking up").
        clearAckTimer()
      }
    }

    // Auto-retry a genuine FREEZE-timeout ONCE, silently. A freeze is the
    // substrate's activity watchdog (or the composer ceiling) abandoning a wedged
    // turn; the substrate poisons + respawns the warm REPL, so the retry lands on a
    // clean session and the common transient case self-heals with NO dead-end
    // bubble. A seed turn is never retried (reload regenerates it). A NON-freeze
    // error (credentials / cooldown / binary / channel) is NOT retried — it is a
    // real fault that keeps its own actionable message.
    const maxAttempts = turn.seed_turn === true ? 1 : 2
    const dispatchStartedAt = now()
    let text: string | null = null
    let lastErrMessage = ''
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const started = now()
      try {
        text = await dispatchOnce()
        break
      } catch (err) {
        lastErrMessage = err instanceof Error ? err.message : String(err)
        const frozen = isFreezeTimeout(lastErrMessage)
        moduleLog.warn('turn_failed', {
          project: turn.project_slug,
          topic: turn.topic_id,
          scope,
          attempt,
          frozen,
          elapsed_ms: now() - started,
          error: lastErrMessage,
        })
        if (frozen && attempt + 1 < maxAttempts) {
          moduleLog.info('turn_auto_retry', {
            project: turn.project_slug,
            topic: turn.topic_id,
            scope,
          })
          continue
        }
        break
      }
    }

    if (text === null) {
      // Terminal failure after any auto-retry. A failed SEED turn (the synthetic
      // auto-start welcome / opening) must NOT leave a bubble: the app-ws reply
      // path persists it into the durable chat_log, so reloading would replay the
      // stuck error instead of re-firing the welcome. Stay silent — the receiver
      // clears its per-process seeded-topic mark on the 'failed' result so the next
      // reload/re-subscribe regenerates the seed. A real user turn gets a bubble:
      //   • AUTH-INVALID → the actionable `AUTH_RECONNECT_BODY` (reconnect your
      //     Claude token) — checked FIRST so an expired-credential turn never
      //     misreads as a slow turn (its message carries no "turn timeout"/"aborted"
      //     token, so it wouldn't hit the freeze branch anyway — but ordering makes
      //     the intent explicit).
      //   • freeze-TIMEOUT → the honest `TIMEOUT_BODY` + a one-click Retry button
      //     (NEVER the misleading "AI connection may need attention" text).
      //   • any other fault → the credential/connection `FAILURE_BODY`.
      if (turn.seed_turn !== true) {
        if (isAuthInvalid(lastErrMessage)) {
          await sendAuthReconnect(input.buttonStore, turn)
        } else if (isFreezeTimeout(lastErrMessage)) {
          await sendTimeoutRetry(input.buttonStore, turn)
        } else {
          sendSafe(turn.send, { type: 'agent_message', body: FAILURE_BODY, topic_id: turn.topic_id })
        }
      }
      return { outcome: 'failed', reply_prompt_id: null }
    }
    if (text.trim().length === 0) {
      moduleLog.warn('empty_reply', {
        project: turn.project_slug,
        topic: turn.topic_id,
        scope,
      })
      // Same seed-failure discipline as above — never persist an error bubble for a
      // synthetic seed turn; let reload regenerate it. An empty reply is a
      // substrate fault, not a timeout, so it keeps the generic failure bubble.
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
      moduleLog.warn('persist_failed', {
        project: turn.project_slug,
        topic: turn.topic_id,
        error: err instanceof Error ? err.message : String(err),
      })
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
    moduleLog.info('replied', {
      project: turn.project_slug,
      topic: turn.topic_id,
      scope,
      chars: text.length,
      elapsed_ms: now() - dispatchStartedAt,
    })
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
        moduleLog.warn('reflection_on_turn_failed', {
          project: turn.project_slug,
          topic: turn.topic_id,
          error: err instanceof Error ? err.message : String(err),
        })
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
        moduleLog.warn('onboarding_scribe_failed', {
          project: turn.project_slug,
          topic: turn.topic_id,
          error: err instanceof Error ? err.message : String(err),
        })
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
          channel_kind: 'app_socket',
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
        channel_kind: 'app_socket',
      },
    })
    return priorBody
  } catch (err) {
    moduleLog.warn('user_turn_persist_skipped', {
      project: turn.project_slug,
      topic: turn.topic_id,
      error: err instanceof Error ? err.message : String(err),
    })
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
  availableServicesFragmentRaw?: string | null,
  nexusFragmentRaw?: string | null,
  reflectionBlockRaw?: string | null,
  attachmentsFragmentRaw?: string | null,
): Promise<string> {
  let persona = ''
  try {
    persona = await input.personaLoader.load()
  } catch (err) {
    moduleLog.warn('persona_load_failed', {
      project: turn.project_slug,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const scopeFragment =
    turn.project_id !== undefined
      ? buildLiveAgentScopeFragment({ scope: 'project', project_id: turn.project_id })
      : buildLiveAgentScopeFragment({ scope: 'general' })
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
  // Available-services awareness — an UNCONDITIONAL fragment on the cold turn so
  // the project's credential picture folds into the cacheable system prefix
  // (warm turns re-splice the fresh block). Already `<available_services>`-
  // delimited + escaped at the seam.
  const availableServicesFragment =
    typeof availableServicesFragmentRaw === 'string' &&
    availableServicesFragmentRaw.trim().length > 0
      ? availableServicesFragmentRaw
      : null
  // RC3 — the `<agent_nexus>` block is an UNCONDITIONAL fragment on the cold turn
  // so the shared coordination log folds into the cacheable system prefix (warm
  // turns re-splice the fresh block). Already `<agent_nexus>`-delimited + escaped
  // at the seam; null on an empty/un-emitted nexus (the dark/no-op default).
  const nexusFragment =
    typeof nexusFragmentRaw === 'string' && nexusFragmentRaw.trim().length > 0
      ? nexusFragmentRaw
      : null
  // Per-turn onboarding grounding (import-analysis the agent already presented).
  // Sits LAST so it governs this turn most strongly — the owner is curating it.
  const onboardingContext =
    typeof onboardingContextFragment === 'string' && onboardingContextFragment.trim().length > 0
      ? onboardingContextFragment
      : null
  // RB1 (perfect-recall) — the breadth memory-index manifest. Resolved ONLY on
  // the cold first turn (this function) so it folds into `instance_fragments`
  // once per (instance, topic) session — it's stable breadth, not per-turn
  // state, so warm turns never re-splice it. Best-effort: a throwing/absent seam
  // (or the flag being off → seam omitted) degrades to no block. Sits near the
  // scope block (breadth grounding), before the this-turn onboarding curation.
  let memoryIndexFragment: string | null = null
  if (input.memoryIndexSnapshot !== undefined) {
    try {
      memoryIndexFragment = (await input.memoryIndexSnapshot()) ?? null
    } catch (err) {
      moduleLog.warn('memory_index_snapshot_failed', {
        project: turn.project_slug,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const memoryIndex =
    memoryIndexFragment !== null && memoryIndexFragment.trim().length > 0
      ? memoryIndexFragment
      : null
  const instance_fragments = [
    doctrineFragment,
    ...(projectPersonaFragment !== null ? [projectPersonaFragment] : []),
    scopeFragment,
    ...(memoryIndex !== null ? [memoryIndex] : []),
    ...(workBoardFragment !== null ? [workBoardFragment] : []),
    ...(nexusFragment !== null ? [nexusFragment] : []),
    ...(availableServicesFragment !== null ? [availableServicesFragment] : []),
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
    moduleLog.warn('system_prompt_assembly_failed', {
      project: turn.project_slug,
      error: err instanceof Error ? err.message : String(err),
    })
    system = [
      persona.trim().length > 0 ? persona : FALLBACK_PERSONA,
      doctrineFragment,
      ...(projectPersonaFragment !== null ? [projectPersonaFragment] : []),
      scopeFragment,
    ].join('\n\n')
  }
  const history = await renderRecentHistoryBlock(input.buttonStore, turn.topic_id, wall_now)
  // WAVE 2 P1 / RB2 (a) — splice the reflection layer's learned-corrections +
  // recent-diary block so this topic's warm session adopts the owner's past
  // corrections on its first turn and applies them silently. RB2: the block is now
  // resolved ONCE in the per-turn body (like the work board + nexus) and threaded
  // in here, so the SAME fresh block also re-splices on warm turns — the cold-turn
  // placement (between the system prefix and the recent-history block) is
  // unchanged. Null/empty (nothing learned, or a throwing/absent seam) → no block.
  const reflectionBlock =
    typeof reflectionBlockRaw === 'string' && reflectionBlockRaw.trim().length > 0
      ? reflectionBlockRaw
      : null
  // M2 modality threading — the `<user_attachments>` block of resolved local
  // blob paths. Placed LAST before the user's message so it's adjacent to the
  // message it belongs to (the agent `Read`s these paths). Null/empty → no block.
  const attachmentsBlock =
    typeof attachmentsFragmentRaw === 'string' && attachmentsFragmentRaw.trim().length > 0
      ? attachmentsFragmentRaw
      : null
  const parts = [system]
  if (reflectionBlock !== null && reflectionBlock.trim().length > 0) parts.push(reflectionBlock)
  if (history !== null) parts.push(history)
  if (attachmentsBlock !== null) parts.push(attachmentsBlock)
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
    moduleLog.warn('project_persona_resolve_failed', {
      project: turn.project_slug,
      topic: turn.topic_id,
      error: err instanceof Error ? err.message : String(err),
    })
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
    moduleLog.warn('send_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Classify a dispatch error as a FREEZE-TIMEOUT (the turn was slow / wedged) vs a
 * real credential / connection / substrate fault. The persistent-REPL adapter
 * surfaces a frozen turn as `persistent-repl: turn timeout` and the composer's own
 * absolute-ceiling AbortController surfaces `cc-llm-call: aborted`; both mean "the
 * turn didn't finish in time", NOT "your setup is broken". Everything else
 * (all-cooldown, invalid key, binary-not-found, channel-wedged, empty) is a real
 * fault that must KEEP its own actionable message — the whole point of this fix is
 * to stop misdiagnosing a timeout as a credential problem.
 */
export function isFreezeTimeout(message: string): boolean {
  return /turn timeout/i.test(message) || /\baborted\b/i.test(message)
}

/**
 * Classify a dispatch error as an AUTH-INVALID failure — the underlying `claude`
 * child reported an invalid/expired credential (the substrate abandons the turn with
 * the stamped `auth_invalid` class + the distinctive `auth token invalid — reconnect
 * required` message; see `pool.ts` `failAuthInvalid`). Matched on the message prose
 * (the classifier sees the thrown Error's `.message`, not its `.code`) — the two
 * phrases are distinctive and NEITHER contains a `turn timeout` / `aborted` token, so
 * an auth failure can never also read as a freeze-timeout. Checked BEFORE
 * `isFreezeTimeout` in the terminal-failure handler so the owner gets the actionable
 * reconnect bubble instead of a useless "tap Retry".
 */
export function isAuthInvalid(message: string): boolean {
  return /auth token invalid/i.test(message) || /reconnect required/i.test(message)
}

/**
 * Surface the honest freeze-timeout bubble + a one-click Retry affordance. Persists
 * the reply as a `button_prompt` (so the web client mints a `prompt_id` and the tap
 * routes as a `button_choice`) carrying a single Retry option whose value is
 * `RETRY_TURN_VALUE`; `allow_freeform` stays true so the user can simply send their
 * message again. When the persist fails we still ship the live envelope (buttonless
 * on a client that needs a prompt_id, but the message + freeform re-send still
 * work). Called ONLY for a real (non-seed) user turn after the auto-retry.
 */
async function sendTimeoutRetry(
  buttonStore: ButtonStore,
  turn: LiveAgentTurnRequest,
): Promise<void> {
  const options = [{ label: OPTION_LABELS[0]!, body: 'Retry', value: RETRY_TURN_VALUE }]
  let reply_prompt_id: string | null = null
  try {
    const prompt = buildButtonPrompt({
      body: TIMEOUT_BODY,
      options,
      allow_freeform: true,
      expires_in_ms: REPLY_ROW_TTL_MS,
      uuid: randomUUID,
    })
    const emitted = await buttonStore.emit(prompt, { topic_id: turn.topic_id })
    reply_prompt_id = emitted.prompt_id
  } catch (err) {
    moduleLog.warn('timeout_retry_persist_failed', {
      project: turn.project_slug,
      topic: turn.topic_id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const envelope: ChatOutbound = {
    type: 'agent_message',
    body: TIMEOUT_BODY,
    topic_id: turn.topic_id,
    options,
    allow_freeform: true,
    ...(reply_prompt_id !== null ? { prompt_id: reply_prompt_id } : {}),
  }
  sendSafe(turn.send, envelope)
}

/**
 * Surface the auth-reconnect bubble (`AUTH_RECONNECT_BODY`) when a turn failed on an
 * invalid/expired Claude credential. Persists it as a durable history row (so a
 * reload re-hydrates the actionable message, not a ghost) and ships it live. NO
 * Retry button — retrying is pointless while the token is invalid, and a button that
 * re-runs the turn would just hit the same auth error; `allow_freeform` stays true so
 * the owner can send again once they have reconnected. When the persist fails we
 * still ship the live envelope (the message + freeform re-send still work). Called
 * ONLY for a real (non-seed) user turn.
 */
async function sendAuthReconnect(
  buttonStore: ButtonStore,
  turn: LiveAgentTurnRequest,
): Promise<void> {
  let reply_prompt_id: string | null = null
  try {
    const prompt = buildButtonPrompt({
      body: AUTH_RECONNECT_BODY,
      options: [],
      allow_freeform: true,
      expires_in_ms: REPLY_ROW_TTL_MS,
      uuid: randomUUID,
    })
    const emitted = await buttonStore.emit(prompt, { topic_id: turn.topic_id })
    reply_prompt_id = emitted.prompt_id
  } catch (err) {
    moduleLog.warn('auth_reconnect_persist_failed', {
      project: turn.project_slug,
      topic: turn.topic_id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const envelope: ChatOutbound = {
    type: 'agent_message',
    body: AUTH_RECONNECT_BODY,
    topic_id: turn.topic_id,
    allow_freeform: true,
    ...(reply_prompt_id !== null ? { prompt_id: reply_prompt_id } : {}),
  }
  sendSafe(turn.send, envelope)
}
