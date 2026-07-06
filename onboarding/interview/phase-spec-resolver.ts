/**
 * @neutronai/onboarding/interview — LLM-driven phase-spec resolver.
 *
 * Architecture: docs/research/onboarding-llm-prompts-architecture-2026-05-09.md
 *
 * Replaces the hardcoded `PHASE_PROMPTS` table with an LLM that generates
 * the body copy (and optionally a curated set of options) per phase given
 * a context bundle the engine constructs at emit time. The wider engine,
 * button primitive, channel adapters, web client, transcript writer, and
 * state store all stay untouched: this resolver returns the existing
 * `PhasePromptSpec` shape so the on-wire envelope is unchanged.
 *
 * Two layers ship here:
 *   1. `PhaseSpecResolver` — narrow async interface the engine calls.
 *      Tests inject a stub returning a deterministic spec; production
 *      wires `buildLlmPhaseSpecResolver`.
 *   2. `buildLlmPhaseSpecResolver` — the LLM-backed implementation.
 *      Calls an instance-resolved Anthropic client (BEST_MODEL — Opus 4.7
 *      by default; was FAST_MODEL/Haiku 4.5 pre-2026-05-31 CC-substrate
 *      migration), strict-parses a tiny JSON envelope, and falls back
 *      to the static spec when anything goes sideways (parse error,
 *      timeout, network blip, malformed options). The fallback path
 *      makes a model outage user-invisible.
 *
 * The resolver only owns BODY copy + which subset of allow-listed options
 * to surface. The engine still owns the next-phase decision (driven by
 * `LEGAL_TRANSITIONS` + `next_phase_overrides`) and option `value` routing
 * keys (the LLM cannot smuggle a routing-incompatible value).
 *
 * Per-phase rollout is gated by `NEUTRON_LLM_ONBOARDING_PHASES` — a comma-
 * separated list of phase names. The engine asks the resolver only for
 * phases on the list; everything else still resolves through the static
 * `PHASE_PROMPTS` table so a partial rollout is safe.
 */

import type { OnboardingPhase } from './phase.ts'
import type { PhasePromptSpec } from './phase-prompts.ts'
import { getOptionalKeyOffer } from '../optional-keys.ts'
// Static fallback table for routing fields. Imported directly from its
// canonical home `phase-prompts.ts` (the LLM driver only re-exports it).
// Importing from the leaf here breaks the `phase-spec-resolver` ↔
// `llm-prompt-driver` import cycle (R5 / audit P1-3) — the driver still
// imports this resolver one-directionally, no cycle remains.
import { STATIC_PHASE_SPECS } from './phase-prompts.ts'
import { RESERVED_OPTION_VALUES } from '../../channels/button-primitive.ts'
import type { RequiredField } from './required-fields-audit.ts'
import { OPTIN_TOKENS, OPTOUT_TOKENS } from '../../runtime/env-flag-tokens.ts'
import { CONVERSATIONAL_TIMEOUT_MS_DEFAULT } from './llm-timeouts.ts'

// ---------------------------------------------------------------------------
// Context bundle
// ---------------------------------------------------------------------------

/**
 * Last-N transcript turn snapshot the bundle hands the LLM. Only the
 * agent + user lines are surfaced; system lines are filtered out so the
 * LLM does not see internal recovery / sentinel notes.
 */
export interface PhaseRecentTurn {
  role: 'agent' | 'user'
  body: string
  phase: OnboardingPhase
}

/**
 * Frozen snapshot the resolver hands the LLM. All fields are derived from
 * the engine's existing `OnboardingState.phase_state` (already persisted)
 * plus the static phase intent table. No new column needed.
 */
export interface PhaseContextBundle {
  /** Frozen across the whole interview. */
  project_slug: string
  /** `web:<user_id>` or `tg:<chat_id>:<thread_id>`. The resolver passes
   *  this through to the `onLlmStart` / `onLlmEnd` callbacks (typing
   *  indicators) but never uses it for the LLM call itself. */
  topic_id: string
  user_id: string
  signup_via: 'telegram' | 'web'
  /** Telegram first_name when signup_via='telegram' AND the channel
   *  adapter populated it during the telegram-start handler. NULL on
   *  web signups. */
  telegram_display_name: string | null

  /** Phase about to emit. */
  phase: OnboardingPhase
  /** Fixed table of intents per phase — see `PHASE_INTENTS`. */
  intent: PhaseIntent

  /** Fields already captured in earlier phases. Sparse — only fields
   *  that have landed are present. Sourced from `phase_state`. */
  captured: {
    agent_name?: string | null
    archetype_hint?: string | null
    suggested_slug?: string | null
    chosen_slug?: string | null
    last_choice_value?: string | null
    last_choice_freeform?: string | null
  }

  /** Last N user lines + agent prompts (default 6 turns). Enough for the
   *  LLM to reference what the user just said without re-reading the
   *  full transcript every turn. */
  recent_turns: ReadonlyArray<PhaseRecentTurn>

  /** When > 0, the engine has just re-prompted because the prior reply
   *  failed validation. The LLM should rephrase rather than repeat. */
  attempt_count: number
  /** Free-text reason set by the engine when it knows why the prior
   *  reply failed (e.g. "the slug 'foo' is already taken"). */
  rejection_reason: string | null

  /**
   * P2 v2 § 9.3 (S6, 2026-05-16) — required-fields audit snapshot for
   * the `work_interview_gap_fill` phase. The driver threads this into
   * the user-prompt envelope so the LLM can anchor its next question on
   * the highest-priority missing field.
   *
   * Sparse — only populated for the gap-fill phase today. Other phases
   * either don't need it (signup) OR don't yet wire it (the LLM at
   * `personality_offered` could in principle reference it but the spec
   * doesn't ask for that yet).
   *
   * `filled` / `missing` are arrays of `RequiredField` keys in audit
   * priority order. `next_to_collect` is the highest-priority missing
   * field, null when audit clean.
   */
  required_fields_state?: {
    filled: ReadonlyArray<RequiredField>
    missing: ReadonlyArray<RequiredField>
    next_to_collect: RequiredField | null
  }

  /**
   * #306 (2026-06-19) — the auto-detected browser timezone already stamped
   * onto `phase_state.timezone` (web client → `?tz=` → engine.start). When
   * present the LLM knows the timezone is CAPTURED and must not ask for it
   * (the envelope's never-ask rule). Null/absent when the client never
   * reported one (Telegram, older browsers) — the agent still never asks,
   * it simply has no value to reference. Surfaced as `known_timezone=...`
   * in the user-prompt envelope.
   */
  known_timezone?: string | null
}

// ---------------------------------------------------------------------------
// Phase intents (the per-phase contract the LLM rephrases for)
// ---------------------------------------------------------------------------

/**
 * Static, hand-tuned per-phase contract. The LLM does NOT generate
 * intents — it generates copy *for* a fixed intent.
 */
export interface PhaseIntent {
  /** Short descriptor the LLM uses to know what info to extract. */
  goal: string
  /**
   * `free-text`     — engine accepts any non-empty reply, calls validator
   * `pick-or-text`  — engine offers suggested options when the LLM judges
   *                   they help, but free-text is always honored
   * `pick-only`     — confirmation/yes-no style; the LLM must surface
   *                   options, freeform is ignored at the engine layer
   */
  shape: 'free-text' | 'pick-or-text' | 'pick-only'
  /**
   * Allow-listed option values the engine will route. The LLM may choose
   * a SUBSET to surface; values it invents that are NOT in this list are
   * dropped at validation time. Empty when `shape='free-text'`.
   */
  allowed_option_values: ReadonlyArray<string>
  /** Hard cap on body length (chars). Forces brevity. Default 280. */
  max_body_chars: number
}

/**
 * Per-phase intent table. Phases driven externally (identity_oauth,
 * import_running, persona_synthesizing, wow_fired, completed, failed)
 * map to null and are never LLM-generated — those advance via direct
 * state writes from other modules.
 */
export const PHASE_INTENTS: Readonly<Record<string, PhaseIntent | null>> = {
  // P2 v2 § 3.1 — signup captures user_first_name with a single
  // free-text greeting.
  signup: {
    goal: "Greet the user warmly and capture their first name in one short free-text question.",
    shape: 'free-text',
    allowed_option_values: [],
    max_body_chars: 200,
  },
  // P2 v2 § 3.4 — ai_substrate_offered branches the flow. Pick-only +
  // freeform allowed so "just ChatGPT" shapes still route.
  ai_substrate_offered: {
    goal: 'Find out whether the user has prior ChatGPT or Claude conversations we can import.',
    shape: 'pick-or-text',
    allowed_option_values: ['chatgpt', 'claude', 'neither'],
    max_body_chars: 240,
  },
  // P2 v2 § 3.5 — import_upload_pending. Body is the verbatim download
  // instruction block; LLM may add a single warmth sentence and pick the
  // correct block (ChatGPT vs Claude).
  import_upload_pending: {
    goal: 'Explain how to download the export and wait for the upload, keeping the step-list verbatim.',
    shape: 'pick-or-text',
    allowed_option_values: ['skip'],
    max_body_chars: 1200,
  },
  // P2 v2 § 3.7 — import_analysis_presented. The wow moment — present
  // analysis bullets and ask "anything I missed?".
  import_analysis_presented: {
    goal: 'Present the import analysis (projects, themes, interests) as bullets and ask what was missed.',
    shape: 'free-text',
    allowed_option_values: [],
    max_body_chars: 1200,
  },
  // P2 v2 § 3.8 — work_interview_gap_fill. LLM picks the next-most-
  // important missing required field and asks one conversational
  // question per turn.
  work_interview_gap_fill: {
    goal: 'Ask one short conversational question that targets the highest-priority missing required field.',
    shape: 'free-text',
    allowed_option_values: [],
    max_body_chars: 200,
  },
  // P2 v2 § 3.9 — personality_offered. LLM generates user-tuned
  // personality suggestions; user picks, mixes, or describes their own.
  personality_offered: {
    goal: 'Ask the user what kind of personality the agent should have and offer three flavor suggestions tuned to their data.',
    shape: 'free-text',
    allowed_option_values: [],
    max_body_chars: 320,
  },
  // P2 v2 § 3.10 — agent_name_chosen. LLM generates 3-5 names that
  // echo personality + work themes.
  //
  // 2026-05-27: bumped max_body_chars from 280 → 480 because the bullet
  // list of 5 names × ~35-char taglines + intro + "or type your own"
  // line crosses ~300 chars routinely. The 280 cap silently failed the
  // resolver's `parseLlmSpec` length check and forced the static
  // fallback even when the model had produced a perfectly valid body.
  agent_name_chosen: {
    goal: 'Suggest 3-5 short, pronounceable agent names that echo the user personality and work themes. Your body MUST list each suggestion as a bullet line in the form `- <Name> — <one-line tagline>`.',
    shape: 'free-text',
    allowed_option_values: [],
    max_body_chars: 480,
  },
  persona_reviewed: {
    // P2 v2 § 3.14: post-persona transit; the user is invited to wrap
    // up before the Max-attach step.
    goal: 'Acknowledge the synthesized persona and transition into the Max-attach step.',
    shape: 'free-text',
    allowed_option_values: [],
    max_body_chars: 240,
  },
  // P2 v2 § 3.15 — max_oauth_offered. 2026-05-28 single-CTA collapse:
  // the only option presented is "Connect Claude Max". BYO API key + free
  // tier are gone from the surface (admin interface for substrate switch
  // is a future sprint per Sam 2026-05-28). The engine auto-skips this
  // phase entirely for owners whose substrate already has a Max-OAuth
  // refresh token persisted, so most users never see this prompt at all.
  max_oauth_offered: {
    goal: 'Offer the Claude Max attach handoff. Single CTA; the engine auto-skips this phase when the owner already has a max_oauth_refresh secret.',
    shape: 'pick-only',
    allowed_option_values: ['attach_max'],
    max_body_chars: 240,
  },
  // Phases driven externally — engine never asks the resolver for these.
  identity_oauth: null,
  instance_provisioned: null,
  import_running: null,
  persona_synthesizing: null,
  wow_fired: null,
  completed: null,
  failed: null,
  // Special-cased phases — the engine builds these via dedicated
  // builders (slug suggestion) and the resolver is bypassed entirely.
  // Mapped to null so a stray call falls through cleanly to the
  // static spec.
  slug_chosen: null,
  projects_proposed: null,
}

// ---------------------------------------------------------------------------
// PHASE_KNOWLEDGE — P2-v3 S2 (2026-05-18)
// ---------------------------------------------------------------------------

/**
 * Hand-curated knowledge bundle per phase. `llm-router.ts` (`RouterInput.knowledge`)
 * uses `why_we_ask` + `faqs` to answer tangents and `expected_tangents` /
 * `advance_examples` as few-shot anchors.
 *
 * Moved here from `llm-router.ts` (K11a2 — refactor unit; this resolver is
 * the type's only live consumer and its natural home). `llm-router.ts`
 * re-exports this type for its own internal usage + external importers
 * until K11b1 deletes that file's dead halves.
 */
export interface PhaseKnowledgePack {
  why_we_ask: string
  faqs: Readonly<Record<string, string>>
  expected_tangents: ReadonlyArray<{
    user_text_example: string
    expected_action: 'answer' | 'amend'
    summary: string
  }>
  advance_examples: ReadonlyArray<{
    user_text_example: string
    canonical_value: string | null
    summary: string
  }>
}

/**
 * Hand-authored content + length caps per the sprint brief § 2.4. The
 * caps are enforced by `validatePhaseKnowledgePack` at module load — any
 * pack that exceeds them throws so the bug surfaces before production
 * traffic hits the router.
 *
 * Numbers come straight from the design doc § 2.4 + sprint brief § 2.4
 * (Argus r2 IMPORTANT #1): why_we_ask ≤ 400, faqs value ≤ 600,
 * expected_tangents 3-8, advance_examples 0-6, user_text examples ≤ 120.
 */
const KNOWLEDGE_PACK_LIMITS = {
  whyWeAskMax: 400,
  faqValueMax: 600,
  faqsMin: 1,
  faqsMax: 24,
  expectedTangentsMin: 3,
  expectedTangentsMax: 8,
  advanceExamplesMin: 0,
  advanceExamplesMax: 6,
  exampleSummaryMax: 100,
  exampleUserTextMax: 120,
} as const

const PACK_SIGNUP: PhaseKnowledgePack = {
  why_we_ask:
    "We're starting with your first name so the agent can address you properly. The agent you're configuring is going to be your personal assistant - everything from morning briefs to project tracking - so we want it to feel like talking to a person who knows you, not a form.",
  faqs: {
    purpose:
      "This first question is just to give the agent a name to use when it talks to you. We capture more (work, projects, voice) later in the flow.",
    privacy:
      "Your name lives on YOUR local disk only. The agent is the only thing that reads it. No analytics, no marketing.",
    name_format:
      "First name is fine. Nickname works too. The agent will use this when it greets you and in any morning briefs.",
    can_change_later:
      "Yes - you can tell the agent 'call me X' at any point and it updates the preference.",
  },
  expected_tangents: [
    {
      user_text_example: 'why do you need my name?',
      expected_action: 'answer',
      summary: 'asks about purpose - route to purpose FAQ',
    },
    {
      user_text_example: 'what are you going to do with it?',
      expected_action: 'answer',
      summary: 'asks about privacy/handling - route to privacy FAQ',
    },
    {
      user_text_example: "what's a sub-agent?",
      expected_action: 'answer',
      summary: 'asks about the broader system - one-paragraph orientation, then re-ask name',
    },
    {
      user_text_example: "I'm Sam and I use ChatGPT every day",
      expected_action: 'amend',
      summary: 'volunteers name AND ai_substrate signal - amend both fields, advance signup',
    },
  ],
  // BUG 1 defense-in-depth (onboarding-opening-fix, 2026-06-19) — signup's
  // only job is to capture the user's name, so a bare typed name IS the
  // advance. These exemplars teach the router to classify a name reply as
  // `advance` (carrying user_first_name in state_delta) rather than an
  // `amend`/low-confidence `answer` that strands the user on a second
  // name-ask. `canonical_value: null` — signup is free-text, not a
  // button-pick, so the engine treats the advance as a `__freeform__`
  // choice. (The engine's dispatchRouterDecision signup guard is the
  // primary fix; this hardens the classifier itself.)
  advance_examples: [
    {
      user_text_example: 'Ryan',
      canonical_value: null,
      summary: 'bare first name - advance signup, capture user_first_name',
    },
    {
      user_text_example: 'Sam Doe',
      canonical_value: null,
      summary: 'first + last name - advance signup, capture the first token',
    },
    {
      user_text_example: 'call me Jane',
      canonical_value: null,
      summary: 'explicit self-introduction - advance signup with user_first_name',
    },
    {
      user_text_example: "I'm Alex",
      canonical_value: null,
      summary: 'name intro - advance signup, capture user_first_name',
    },
  ],
}

const PACK_AI_SUBSTRATE_OFFERED: PhaseKnowledgePack = {
  why_we_ask:
    "We're asking which AI you've used so the agent can import your conversation history. Importing your past chats teaches the agent your projects, voice, and patterns BEFORE asking you a bunch of interview questions. Without an import the agent learns from scratch through ~5 extra interview questions.",
  faqs: {
    difference_between:
      "ChatGPT and Claude both let you export your full chat history as a .zip. The agent reads both formats the same way - the choice is purely 'which conversations should I learn from?'.",
    used_both:
      "If you've used both, pick whichever has the conversations most representative of how you work - we import one source now. You can rerun the import later from settings to bring in the other.",
    add_later:
      'You can rerun an import later from the settings page. For now, pick whichever substrate has the conversations most representative of how you actually work.',
    neither_consequence:
      "Picking 'Neither' is fine - you'll just get a slightly longer interview (about 5 extra short questions) so the agent has enough signal to build your persona.",
    privacy:
      'Conversation .zips live on YOUR local disk - the agent is the only thing that reads them. Raw .zips are deleted after pass-2 analysis completes.',
    enterprise_caveat:
      "ChatGPT Business / Enterprise plans don't expose the personal-export option. If you're on one of those, pick Neither and we'll cover it with interview questions.",
  },
  expected_tangents: [
    {
      user_text_example: "what's the difference between chatgpt and claude here?",
      expected_action: 'answer',
      summary: 'asks about substrate choice - route to difference_between FAQ',
    },
    {
      user_text_example: 'what if I have both?',
      expected_action: 'answer',
      summary: 'single-source import; pick one now, rerun later - route to used_both FAQ, then re-ask',
    },
    {
      user_text_example: 'can I add chatgpt later?',
      expected_action: 'answer',
      summary: 'explains rerun path - route to add_later FAQ',
    },
    {
      user_text_example: 'what happens if I pick neither?',
      expected_action: 'answer',
      summary: 'explains consequence - route to neither_consequence FAQ',
    },
    {
      user_text_example: 'I have ChatGPT Enterprise, can I still export?',
      expected_action: 'answer',
      summary: 'plan caveat - route to enterprise_caveat, offer Neither path',
    },
  ],
  advance_examples: [
    {
      user_text_example: 'just chatgpt',
      canonical_value: 'chatgpt',
      summary: "explicit chatgpt - map to 'chatgpt' option",
    },
    {
      user_text_example: "I've used Claude",
      canonical_value: 'claude',
      summary: "implicit claude - map to 'claude' option",
    },
    {
      user_text_example: 'neither one',
      canonical_value: 'neither',
      summary: "explicit none - map to 'neither' option",
    },
    {
      user_text_example: 'skip this',
      canonical_value: 'neither',
      summary:
        'user skip-attempt; ai_substrate_offered has no skip - degrade to neither',
    },
  ],
}

const PACK_IMPORT_UPLOAD_PENDING: PhaseKnowledgePack = {
  why_we_ask:
    "We're asking you to download and upload your ChatGPT or Claude history so the agent can learn your projects, voice, and patterns before asking a bunch of interview questions. Without an import, the agent has to ask everything from scratch.",
  faqs: {
    chatgpt_export_steps:
      'ChatGPT: Settings > Data Controls > Export data. Confirm via email; the link arrives in 20-30 minutes (longer for heavy histories). Download the .zip and upload here.',
    claude_export_steps:
      'Claude: Settings > Privacy & Personalization > Data Controls > Export. The .zip is usually ready inside 5 minutes. Download it and upload here.',
    plan_caveats:
      "ChatGPT Business and Enterprise plans don't expose the personal export option. If you're on one of those, switch to a Personal account or skip this step.",
    privacy_handling:
      'The .zip lives on YOUR local disk - the agent is the only thing that reads it. After pass-2 analysis completes, the raw .zip is deleted automatically.',
    file_size_caveats:
      'Heavy histories can hit 500 MB. The upload runs through your browser so it tolerates flaky networks; if it stalls past 5 minutes, refresh and try again.',
    file_format:
      "Both ChatGPT and Claude export as a .zip containing conversations.json plus media. Upload the .zip as-is - don't unzip it.",
    include_all_conversations:
      'Yes - the export is the full conversation history. The agent reads through everything in pass-1 to build the project / theme map, then pass-2 synthesises your voice and patterns.',
    skip_consequences:
      "You can skip - we'll just ask more questions in the interview. About 5 extra questions to fill in the gaps the import would have covered.",
  },
  expected_tangents: [
    // ── `answer` tangents — the user keeps their current source and just
    //    wants information. CRITICAL CONTRAST with the SOURCE-SWITCH amends
    //    below: "give me Claude's steps too" is a question (answer); "upload
    //    Claude INSTEAD" changes the source (amend). Pack budget is 8.
    {
      user_text_example: 'can you give me the instructions for claude as well',
      expected_action: 'answer',
      summary: 'wants to SEE Claude steps, keeps source - answer via claude_export_steps',
    },
    {
      user_text_example: 'why do you need this?',
      expected_action: 'answer',
      summary: 'asks about purpose - route to why_we_ask',
    },
    {
      user_text_example: 'what file format?',
      expected_action: 'answer',
      summary: 'asks about export format - route to file_format FAQ',
    },
    {
      user_text_example: 'do I include all conversations?',
      expected_action: 'answer',
      summary: 'asks about scope - route to include_all_conversations FAQ',
    },
    {
      user_text_example: 'I have ChatGPT Enterprise - can I export?',
      expected_action: 'answer',
      summary: 'plan caveat - route to plan_caveats and offer skip',
    },
    // ── freeform-intent-spec.md (2026-06-03) — SOURCE-SWITCH amends. The
    //    user wants to upload from a DIFFERENT service than the one whose
    //    instructions are currently showing. Emit state_delta
    //    { ai_substrate_used: "<new source>" } (NOT ai_substrate_available)
    //    so the engine re-renders the dynamic upload body for the new
    //    source. A switch mis-classified as `advance` advanced to
    //    import_running (the 2026-06-03 incident).
    {
      user_text_example: 'actually can i upload claude instead',
      expected_action: 'amend',
      summary: "SWITCH chatgpt->claude - state_delta {ai_substrate_used:'claude'}; re-renders Claude steps",
    },
    {
      user_text_example: 'wait, let me do chatgpt instead of claude',
      expected_action: 'amend',
      summary: "SWITCH claude->chatgpt - state_delta {ai_substrate_used:'chatgpt'}; re-renders ChatGPT steps",
    },
  ],
  advance_examples: [
    {
      user_text_example: 'skip',
      canonical_value: 'skip',
      summary: 'explicit skip',
    },
    {
      user_text_example: "I don't want to do this",
      canonical_value: 'skip',
      summary: 'implicit skip - route to skip with confirmation in response',
    },
  ],
}

const PACK_PERSONALITY_OFFERED: PhaseKnowledgePack = {
  why_we_ask:
    "We're asking what kind of personality you want the agent to have so its voice matches how you actually want to be addressed. You can pick from the archetype suggestions, describe your own blend in plain English, or both. This shapes how the agent talks to you in briefs, reminders, and replies.",
  faqs: {
    archetype_meanings:
      "The archetype names (Sage, Strategist, Confidant, etc.) are shorthand for tone+posture combinations. Sage = calm + reflective. Strategist = direct + decisive. Confidant = warm + protective. Pick one or blend two - the agent supports mixes like 'Strategist with warmth'.",
    custom_personality:
      "Plain English works. 'Direct but kind', 'pushy when I'm procrastinating', 'reflective in mornings, sharp in evenings' - all valid. The agent reads your description and generates a SOUL.md that matches.",
    can_change_later:
      "Yes - the personality blend is editable from the agent's settings any time. You can also tell the agent 'be more X' mid-conversation and it'll adapt.",
    address_preference:
      "If you want the agent to call you by a specific name or nickname different from your first name, just say so - 'call me Doe', 'address me as Dr. K'. We store that as an auxiliary preference.",
    no_default:
      "We don't have a 'default' personality - the next step in the flow needs an answer. If you're unsure, type 'just pick one' and we'll route you to Sage as a safe starting point you can edit later.",
    how_it_shows_up:
      "Personality shapes tone (warm vs direct), framing (questions vs statements), and how the agent handles pushback (folds vs holds the line). It does NOT change WHAT the agent knows or does - that's the persona files + the cores.",
  },
  expected_tangents: [
    {
      user_text_example: 'what do these archetype names mean?',
      expected_action: 'answer',
      summary: 'asks about archetype shorthand - route to archetype_meanings FAQ',
    },
    {
      user_text_example: 'can I describe my own?',
      expected_action: 'answer',
      summary: 'explains custom personality path - route to custom_personality',
    },
    {
      user_text_example: 'can I change this later?',
      expected_action: 'answer',
      summary: 'explains editability - route to can_change_later FAQ',
    },
    {
      user_text_example: 'I want it to call me Doe',
      expected_action: 'amend',
      summary:
        "user address preference - amend auxiliary_facts.user_address_preference='Doe', re-ask personality",
    },
    {
      user_text_example: 'call me Dr. K',
      expected_action: 'amend',
      summary: "alternate address - amend auxiliary_facts.user_address_preference='Dr. K'",
    },
    {
      user_text_example: 'how does this actually show up?',
      expected_action: 'answer',
      summary: 'asks about behavioural impact - route to how_it_shows_up FAQ',
    },
    {
      user_text_example: "what if I don't pick one?",
      expected_action: 'answer',
      summary: 'asks about default - route to no_default FAQ',
    },
  ],
  advance_examples: [],
}

// ---------------------------------------------------------------------------
// P2-v3 S3 packs (2026-05-18) — the remaining 7 user-input-bearing phases
// per docs/plans/P2-v3-S3-knowledge-packs-remaining-phases.md § 4. Each
// pack hand-authored to ship-quality. Summaries tightened to fit the
// 100-char cap (some brief summaries were edited for length; semantic
// intent preserved).
// ---------------------------------------------------------------------------

const PACK_IMPORT_ANALYSIS_PRESENTED: PhaseKnowledgePack = {
  why_we_ask:
    "We just analysed the conversations you imported and pulled out what looks like your projects, themes, and interests. We're showing them back to you so you can correct anything we got wrong before the agent commits them to memory. A 'looks good' is the most common reply; corrections at this step are higher-leverage than fixing things later.",
  faqs: {
    what_was_analysed:
      'The agent read every conversation in your export in pass-1 and extracted projects (recurring named work), themes (topics you return to), and non-work interests. Pass-2 then synthesised your voice and patterns. Both passes ran on Haiku 4.5 on your instance.',
    accuracy_expectations:
      "About 80-90% of bullets land correctly the first time. Edge cases: alias-only project names (e.g. 'the side thing'), one-off explorations, or topics you've stopped working on. We'd rather over-include and let you delete than miss something.",
    correction_format:
      "Just say what's wrong in plain English. 'Drop the photography one - that was a 2024 thing' / 'Add Beacon, I forgot to mention it' / 'merge X and Y, they're the same project'. The agent rewrites the list.",
    add_missing:
      'If we missed a project, theme, or interest, name it and (optional) one-sentence what it is. The agent appends it without re-running the full analysis.',
    skip_consequences:
      "Replying 'looks good' or 'all correct' moves on. We then either jump straight to personality_offered (if the import filled every required field) or to work_interview_gap_fill (to pick up missing pieces like your inner-circle people).",
    where_does_this_go:
      "The corrected list lands in your `primary_projects` and `non_work_interests` arrays - the same shape the agent uses for morning briefs, project tracking, and routing. You can edit them later from the settings page.",
  },
  expected_tangents: [
    {
      user_text_example: 'what did you actually read to come up with this?',
      expected_action: 'answer',
      summary: 'asks about analysis source - route to what_was_analysed FAQ',
    },
    {
      user_text_example: 'how accurate is this usually?',
      expected_action: 'answer',
      summary: 'asks about calibration - route to accuracy_expectations FAQ',
    },
    {
      user_text_example: 'drop the photography one - that was a 2024 thing',
      expected_action: 'amend',
      summary: 'remove a project - amend primary_projects to drop one entry',
    },
    {
      user_text_example: 'add Beacon, I forgot to mention it',
      expected_action: 'amend',
      summary: 'add a project - amend primary_projects to append one entry',
    },
    {
      user_text_example: 'where does this end up?',
      expected_action: 'answer',
      summary: 'asks about persistence - route to where_does_this_go FAQ',
    },
    {
      user_text_example: "merge topline and topline.co, they're the same",
      expected_action: 'amend',
      summary: 'dedupe two projects - amend primary_projects to merge entries',
    },
  ],
  advance_examples: [
    {
      user_text_example: 'looks good',
      canonical_value: null,
      summary: 'explicit confirmation - free-text advance, no canonical value',
    },
    {
      user_text_example: 'all correct',
      canonical_value: null,
      summary: 'explicit confirmation, alt phrasing - free-text advance',
    },
    {
      user_text_example: "yep that's it",
      canonical_value: null,
      summary: 'casual confirmation - free-text advance',
    },
  ],
}

const PACK_WORK_INTERVIEW_GAP_FILL: PhaseKnowledgePack = {
  why_we_ask:
    "We're filling in the pieces the conversation import didn't cover. The agent needs a few specific data points before it can build your persona - your name (if we didn't catch it), your active projects, and the non-work things you care about. We ask one short question at a time so it feels like a conversation, not a form.",
  faqs: {
    why_more_questions:
      'The import filled most of the picture but some required fields did not show up clearly enough. We ask follow-ups for those specific gaps - not a full restart. Usually 1-5 questions depending on how much your imported conversations covered.',
    can_skip:
      "You can skip an individual question by saying 'skip' or 'pass' - we'll move to the next gap. You CANNOT skip the entire gap-fill: every required field has to land before the agent can compose a persona.",
    required_fields:
      'Five required fields: first name, primary projects (need at least 3), non-work interests (need at least 1), agent personality, agent name. The first three get asked here; the last two have dedicated phases later.',
    why_three_projects:
      "Three is the floor for the agent to disambiguate between projects when you mention them by alias. Below 3 the agent ends up asking 'which project do you mean?' constantly. You can add more later.",
    project_format:
      "Just name the project. 'Topline' / 'Northwind' / 'the book'. One sentence of context optional but helpful. The agent infers active vs dormant from how often the project shows up in your imported conversations.",
    interest_format:
      "Same shape as projects - name + optional cadence hint. 'CrossFit, almost daily' / 'reading, mostly weekends' / 'mushroom foraging in fall'. The agent uses these to anchor morning-brief content and recovery suggestions.",
    edit_later:
      "Yes. Every field is editable from the agent's settings after onboarding. We're capturing a baseline here so the agent doesn't start from zero on Day 1.",
  },
  expected_tangents: [
    {
      user_text_example: 'why are you asking me more questions?',
      expected_action: 'answer',
      summary: 'asks about gap rationale - route to why_more_questions FAQ',
    },
    {
      user_text_example: 'can I skip this one?',
      expected_action: 'answer',
      summary: 'asks per-question skip - route to can_skip FAQ',
    },
    {
      user_text_example: "I'd rather skip the rest of the questions",
      expected_action: 'answer',
      summary: 'user wants escape hatch - route to can_skip, explain required-field floor',
    },
    {
      user_text_example: 'why do you need three projects?',
      expected_action: 'answer',
      summary: 'asks about minimum - route to why_three_projects FAQ',
    },
    {
      user_text_example: "what's left to ask?",
      expected_action: 'answer',
      summary: 'asks remaining gaps - LLM consults state and names next_to_collect field',
    },
    {
      user_text_example: 'Sam, and my projects are Topline, Northwind, Beacon',
      expected_action: 'amend',
      summary: 'volunteers name+projects in one turn - amend both fields together',
    },
    {
      user_text_example: 'can I edit this stuff later?',
      expected_action: 'answer',
      summary: 'asks about post-onboarding edits - route to edit_later FAQ',
    },
  ],
  advance_examples: [
    {
      user_text_example: 'Sam',
      canonical_value: null,
      summary: 'single-field answer (name) - free-text advance for the current gap',
    },
    {
      user_text_example: 'Topline, Northwind, Beacon, CC',
      canonical_value: null,
      summary: 'projects list - free-text advance',
    },
    {
      user_text_example: 'CrossFit and reading',
      canonical_value: null,
      summary: 'interests list - free-text advance',
    },
    {
      user_text_example: 'skip',
      canonical_value: 'skip',
      summary: "per-field skip - canonical_value='skip' routes handler to the next gap",
    },
  ],
}

const PACK_AGENT_NAME_CHOSEN: PhaseKnowledgePack = {
  // 2026-05-27 (Sam-incident): the prior text said "names suggested
  // above" implying names were already present in the body. The LLM
  // driver could then satisfy `goal` with a bullet-less intro and never
  // emit a name list (what Sam hit). The rewording below instructs the
  // LLM directly: every emit MUST contain a bullet list of 3-5
  // suggestions in `- Name — tagline` form. The post-resolve validator
  // in `parseLlmSpec` also enforces this; this text is the prompt-side
  // half of the same contract.
  why_we_ask:
    "We're picking the agent's name. The agent uses it in greetings, briefs, and cross-agent context. Your body MUST list 3-5 name suggestions, each on its own line in the form `- <Name> — <one-line tagline>`. Names must be short (<=16 chars), pronounceable, ASCII letters only, and echo the user's personality archetype + work themes. The user picks one, mixes two, or types their own.",
  faqs: {
    suggestion_logic:
      "The suggested names were generated from your agent_personality answer + your top three project themes. They're meant to sound like a name a person would have - short, pronounceable, no numbers or hyphens.",
    custom_name_rules:
      "Any name works as long as it's pronounceable and under 32 characters. ASCII letters preferred (the slug derives from this). No special characters, no emoji, no all-caps. 'Atlas' / 'Sage' / 'Iris' are typical shapes; 'Doe-Bot-V2' is not.",
    name_changes_later:
      'Yes - you can rename the agent any time from settings. The change propagates to all surfaces (Telegram bot name, briefs, signature, references in agent-to-agent calls).',
    more_suggestions:
      "If none of the suggestions land, just say 'more' or 'suggest 3 more' and the agent generates a fresh batch. The new batch will avoid duplicates from the prior round.",
    personality_match:
      "The names skew toward your personality vector. If you picked 'sage', expect Atlas / Iris / Cyrus shapes. If you picked 'direct', expect shorter punchier names. The match is a hint, not a hard rule - override freely.",
    multiple_agents:
      "Each instance has ONE agent. If you eventually run multiple instances (a personal agent and a work agent), each picks its own name independently. They're separate processes, separate vaults, separate personalities.",
  },
  expected_tangents: [
    {
      user_text_example: 'how did you come up with these?',
      expected_action: 'answer',
      summary: 'asks about suggestion source - route to suggestion_logic FAQ',
    },
    {
      user_text_example: 'can you suggest 3 more?',
      expected_action: 'answer',
      summary: 'user wants fresh batch - route to more_suggestions, regenerate names inline',
    },
    {
      user_text_example: 'those names are fine but give me a few more',
      expected_action: 'answer',
      summary: 'shorter regenerate variant - same routing as above',
    },
    {
      user_text_example: 'what are the rules for a custom name?',
      expected_action: 'answer',
      summary: 'asks about constraints - route to custom_name_rules FAQ',
    },
    {
      user_text_example: 'can I change this later?',
      expected_action: 'answer',
      summary: 'asks about editability - route to name_changes_later FAQ',
    },
    {
      user_text_example: 'why those names specifically?',
      expected_action: 'answer',
      summary: 'asks about personality matching - route to personality_match FAQ',
    },
  ],
  advance_examples: [
    {
      user_text_example: 'Atlas',
      canonical_value: null,
      summary: 'picks one of the offered names - free-text advance',
    },
    {
      user_text_example: "let's go with Iris",
      canonical_value: null,
      summary: "picks suggested name conversationally - LLM extracts 'Iris'",
    },
    {
      user_text_example: 'call it Nova',
      canonical_value: null,
      summary: 'custom name not in the suggested batch - free-text advance',
    },
  ],
}

const PACK_SLUG_CHOSEN: PhaseKnowledgePack = {
  why_we_ask:
    "We're asking you to confirm or change the suggested instance name (slug). The slug is the short identifier that becomes part of your instance's address and the Telegram bot handle (e.g. @demobot). It's the only piece of your onboarding that becomes part of a public identifier, so it's worth getting right.",
  faqs: {
    what_is_the_slug_used_for:
      "Three places: (1) part of your instance's address; (2) the Telegram bot handle @<slug>neutronbot; (3) the per-instance file path on disk. Nothing else is keyed off it - the agent's internal identifiers use UUIDs, not the slug.",
    slug_rules:
      '3-30 characters. Lowercase letters, numbers, and hyphens only. Must start with a letter. No consecutive hyphens. The validator enforces these; bad slugs trigger a re-prompt with the rejection reason.',
    can_change_slug_later:
      "Slug renames are supported but cost an instance-wide URL update (DNS, Telegram handle, file paths). We don't recommend renaming after the agent has been live more than a week. The settings page exposes the rename flow with explicit warnings.",
    why_a_slug_not_a_uuid:
      "URLs and Telegram handles need to be human-readable so you can share them. The slug is the human-readable label; the UUID is the immutable internal id. Both exist; the slug is the one you'll see and type.",
    availability:
      "We check availability against the global slug registry before accepting. If 'sam' is already taken, we'll suggest 'jane-doe' / 'samj' / 'sam2' etc. as alternatives. You can also type your own.",
    suggested_slug_source:
      "The default suggestion is derived from your first name (lowercased, hyphens for spaces). If that's taken or invalid, we append your agent's name or a short suffix. You're not bound by the suggestion - any valid slug works.",
  },
  expected_tangents: [
    {
      user_text_example: 'is the slug used for anything other than the URL?',
      expected_action: 'answer',
      summary: 'asks about scope - route to what_is_the_slug_used_for FAQ',
    },
    {
      user_text_example: 'what are the rules?',
      expected_action: 'answer',
      summary: 'asks about validation - route to slug_rules FAQ',
    },
    {
      user_text_example: 'can I change this later?',
      expected_action: 'answer',
      summary: 'asks about renames - route to can_change_slug_later FAQ',
    },
    {
      user_text_example: 'why is it called a slug?',
      expected_action: 'answer',
      summary: 'asks about terminology - route to why_a_slug_not_a_uuid FAQ',
    },
    {
      user_text_example: "is 'sam' available?",
      expected_action: 'answer',
      summary: 'asks availability pre-commit - route to availability FAQ, check registry',
    },
    {
      user_text_example: 'where did the suggested slug come from?',
      expected_action: 'answer',
      summary: 'asks about default source - route to suggested_slug_source FAQ',
    },
  ],
  advance_examples: [
    {
      user_text_example: 'sam',
      canonical_value: null,
      summary: 'user confirms short custom slug - free-text advance, validator runs downstream',
    },
    {
      user_text_example: 'yes use the suggested one',
      canonical_value: null,
      summary: 'confirms the agent-suggested slug - engine reads suggested_slug from state',
    },
    {
      user_text_example: "let's go with jane-doe",
      canonical_value: null,
      summary: 'custom hyphenated slug - free-text advance',
    },
    {
      user_text_example: 'keep it as is',
      canonical_value: null,
      summary: 'implicit accept of the suggestion - engine treats as confirm',
    },
  ],
}

const PACK_PROJECTS_PROPOSED: PhaseKnowledgePack = {
  why_we_ask:
    "We're showing you the projects we'll commit to memory so the agent can recognise them later. The list comes from your import analysis + gap-fill answers. The agent uses this list to route morning briefs, project tracking, and any 'how's X going?' style questions. Confirm, edit, or add - this is the last chance before persona synthesis.",
  faqs: {
    what_counts_as_a_project:
      "A project is recurring named work that you'll want the agent to track over time. Companies, products, books, ongoing creative work, study tracks. NOT one-off tasks ('mow the lawn'), themes ('learning Italian'), or interests ('cooking'). Themes and interests live elsewhere in the persona.",
    edit_format:
      "Same as analysis: just say what to change in plain English. 'Drop X' / 'Ignore X' / 'Leave out X' / 'Add Y' / 'Rename Z to W' / 'merge A and B' all work — and if you'd rather sort it out later, every project can be renamed or deleted anytime from settings. The agent rewrites the list. (Engine note: the engine UNIONS your extracted primary_projects onto the already-shown list, so to DROP/IGNORE/RENAME-AWAY a project you MUST name the removed/old title in state_delta.removed_projects — omitting it from primary_projects does NOT remove it. Adds go in primary_projects.)",
    minimum_count:
      "We need at least 3 projects for the agent to disambiguate aliases. Below 3 the agent ends up asking 'which project?' every time you mention work by nickname. You're showing 5 right now - well above the floor.",
    add_format:
      "Optional one-sentence context per project helps the agent route better. 'Northwind - DTC supplement brand for cycle care' / 'Topline - SBA-financed roll-up of childcare networks'. Without context, the agent infers from import history.",
    private_projects:
      "Projects with sensitive context (legal, medical, personal-finance) get the same treatment as any other - the agent reads them but never shares them outside your instance. Tag a project as 'private' in the name (e.g. 'estate planning - private') and the agent applies extra caution on outbound surfaces.",
    finalize_consequence:
      'Confirming triggers persona synthesis - a 30-90 second pass-2 LLM call that writes your SOUL.md, USER.md, and per-project context files. After that, project edits are still possible but require a separate rerun (settings page > edit projects > re-synthesize).',
  },
  expected_tangents: [
    {
      user_text_example: 'what counts as a project here?',
      expected_action: 'answer',
      summary: 'asks about taxonomy - route to what_counts_as_a_project FAQ',
    },
    {
      user_text_example: 'drop the photography one',
      expected_action: 'amend',
      summary: 'remove - name it in state_delta.removed_projects (omission keeps it; engine unions)',
    },
    {
      user_text_example: "add Acme, it's my wife's brand",
      expected_action: 'amend',
      summary: 'add a project - include the new name in state_delta.primary_projects',
    },
    {
      user_text_example: 'rename CC to Contemplative Crossfit',
      expected_action: 'amend',
      summary: 'rename - removed_projects:[old name] AND primary_projects includes [new name]',
    },
    {
      user_text_example: 'how many do I need?',
      expected_action: 'answer',
      summary: 'asks about minimum - route to minimum_count FAQ',
    },
    {
      user_text_example: 'what happens when I confirm?',
      expected_action: 'answer',
      summary: 'asks about downstream side effect - route to finalize_consequence FAQ',
    },
  ],
  advance_examples: [
    {
      user_text_example: 'looks good',
      canonical_value: null,
      summary: 'confirms the list - free-text advance',
    },
    {
      user_text_example: "all correct, let's go",
      canonical_value: null,
      summary: 'confirms with momentum cue - free-text advance',
    },
    {
      user_text_example: 'confirm',
      canonical_value: null,
      summary: 'explicit confirmation - free-text advance',
    },
  ],
}

const PACK_PERSONA_REVIEWED: PhaseKnowledgePack = {
  why_we_ask:
    "The agent just synthesised your persona from everything we collected. Before we move to the final step (attaching your Claude Max or BYO key), this is your last checkpoint to read it and call out anything that doesn't sound right. Most users skim and accept; the option to revise is there if something feels off.",
  faqs: {
    what_was_synthesised:
      "Three files: SOUL.md (the agent's personality + operating principles), USER.md (what the agent knows about YOU - name, projects, interests, context), and per-project context files. Everything lives in your instance; nothing was sent anywhere external.",
    can_i_edit_directly:
      "Yes - all the persona files are markdown in your instance's vault. You can edit them by hand after onboarding completes. For now, the easiest path is to tell the agent what feels off and let it rewrite the relevant section.",
    revisit_personality:
      'If the personality tone feels wrong (too formal, not pushy enough, etc.), you can jump back to personality_offered without losing the rest of the onboarding state. The agent re-prompts and re-synthesises only the persona files.',
    revisit_agent_name:
      'Same path as personality - jump back to agent_name_chosen, pick a different name, the agent re-renders the persona files with the new name. Slug and projects stay intact.',
    revisit_slug:
      "Slug revisits are supported here but rare - the slug picker tends to land cleanly on the first pass. Available if you've changed your mind.",
    move_on_default:
      "Saying 'looks good' / 'move on' / 'next' advances to max_oauth_offered (or directly to wow_fired if you already attached Max via the import flow).",
    what_max_offers:
      "Next phase is the Max-connect prompt - a single 'Connect Claude Max' button that links the agent to your Claude Max subscription via OAuth. If you already attached Max during the import phase, this step auto-skips entirely.",
  },
  expected_tangents: [
    {
      user_text_example: 'what did you just write?',
      expected_action: 'answer',
      summary: 'asks about persona output - route to what_was_synthesised FAQ',
    },
    {
      user_text_example: 'the personality feels off',
      expected_action: 'answer',
      summary: 'asks to revisit personality - route to revisit_personality FAQ; no state_delta',
    },
    {
      user_text_example: 'actually I want to change the name',
      expected_action: 'answer',
      summary: 'asks to revisit agent name - route to revisit_agent_name FAQ; no state_delta',
    },
    {
      user_text_example: 'can I edit these files myself later?',
      expected_action: 'answer',
      summary: 'asks about post-onboarding edits - route to can_i_edit_directly FAQ',
    },
    {
      user_text_example: 'what comes next?',
      expected_action: 'answer',
      summary: 'asks about next phase - route to what_max_offers FAQ',
    },
  ],
  advance_examples: [
    {
      user_text_example: 'looks good',
      canonical_value: null,
      summary: 'explicit accept - free-text advance to max_oauth_offered',
    },
    {
      user_text_example: 'move on',
      canonical_value: null,
      summary: 'casual accept - free-text advance',
    },
    {
      user_text_example: 'yep ship it',
      canonical_value: null,
      summary: 'enthusiastic accept - free-text advance',
    },
  ],
}

const PACK_MAX_OAUTH_OFFERED: PhaseKnowledgePack = {
  why_we_ask:
    "We need a Claude Max subscription to run premium models (Sonnet / Opus) for synthesis and deep-reasoning tasks. One click connects your Max sub so the agent runs on your existing Anthropic quota - no separate billing, no API key to paste. If you already attached Max earlier in onboarding (e.g. during import) we skip this step entirely.",
  faqs: {
    attach_max_what_it_does:
      "Connect Claude Max links the agent to your Claude Max subscription via OAuth. The agent runs on your Max quota - no separate billing, no API key to manage. We never see your Anthropic credentials; the OAuth token is scoped to message-generation only.",
    privacy_max_oauth:
      "The OAuth flow grants scoped access to Anthropic's messages API only - we can't see your conversations from chat.anthropic.com, can't read your Claude usage history, and can't touch billing. The token is stored encrypted in your instance.",
    quota_concerns:
      "If you're worried about burning Max quota - the agent uses Haiku 4.5 for most onboarding/routing work (cheap), Sonnet only when needed (escalation), and Opus only for explicit deep-reasoning tasks. Typical daily usage is well under 5% of a Max Pro plan.",
    no_max_sub:
      "Right now Claude Max is required to keep going - we use premium models for persona synthesis, brief generation, and deep reasoning. A future admin interface will let you switch substrates (BYO Anthropic key or free tier) but that's not in the onboarding flow yet. If you don't have Max, the simplest path is to subscribe and re-open this chat - your progress so far is preserved.",
    can_change_later:
      "The substrate choice is reversible from settings (admin interface lands in a future sprint). Switching credentials doesn't lose state - the agent transparently reconnects.",
    // WAVE 1 credential-management — up-front OPTIONAL keys. The system runs
    // fully on Claude Max alone; these only ADD capabilities. Copy is derived
    // from the canonical `onboarding/optional-keys.ts` offer registry so the
    // onboarding answer and the stored activation stay in lockstep.
    optional_openai_key:
      `${getOptionalKeyOffer('openai_api_key')!.question} ${getOptionalKeyOffer('openai_api_key')!.activation} Skipping is fine — ${getOptionalKeyOffer('openai_api_key')!.skip_note}`,
    optional_codex_auth:
      `${getOptionalKeyOffer('codex_auth')!.question} ${getOptionalKeyOffer('codex_auth')!.activation} Skipping is fine — ${getOptionalKeyOffer('codex_auth')!.skip_note}`,
  },
  expected_tangents: [
    {
      user_text_example: 'what does connecting max actually do?',
      expected_action: 'answer',
      summary: 'asks about Max connect mechanics - route to attach_max_what_it_does FAQ',
    },
    {
      user_text_example: 'what does attaching Max give you access to?',
      expected_action: 'answer',
      summary: 'asks about Max OAuth scope - route to privacy_max_oauth FAQ',
    },
    {
      user_text_example: 'will the agent burn through my Max quota?',
      expected_action: 'answer',
      summary: 'asks about Max consumption - route to quota_concerns FAQ',
    },
    {
      user_text_example: "I don't have Claude Max",
      expected_action: 'answer',
      summary: 'no Max sub - route to no_max_sub FAQ (no skip path in onboarding right now)',
    },
    {
      user_text_example: 'can I change this later?',
      expected_action: 'answer',
      summary: 'asks about reversibility - route to can_change_later FAQ',
    },
    {
      user_text_example: 'can I add an OpenAI key for embeddings?',
      expected_action: 'answer',
      summary: 'asks about the optional OpenAI key - route to optional_openai_key FAQ',
    },
    {
      user_text_example: 'do you support codex / cross-model reviews?',
      expected_action: 'answer',
      summary: 'asks about the optional Codex auth - route to optional_codex_auth FAQ',
    },
  ],
  advance_examples: [
    {
      user_text_example: 'connect max',
      canonical_value: 'attach_max',
      summary: "explicit connect - canonical_value='attach_max' (pick-only)",
    },
    {
      user_text_example: "let's connect my Max subscription",
      canonical_value: 'attach_max',
      summary: "verbose connect - canonical_value='attach_max'",
    },
    {
      user_text_example: 'go ahead',
      canonical_value: 'attach_max',
      summary: "implicit accept - canonical_value='attach_max' (single CTA)",
    },
  ],
}

/**
 * Per-phase knowledge bundle the LLM router consults to (a) detect on-
 * topic vs tangential replies and (b) compose in-context answers. Null
 * for auto-skip / transit / terminal phases — the router is never
 * called on those (see design § 3.2). S2 hand-authors packs for 4
 * high-leverage user-visible phases; S3 covers the remaining 9.
 *
 * Maintaining this as a parallel const (rather than embedding
 * `knowledge` in `PhaseIntent`) avoids dragging the knowledge bundle
 * through the OUTGOING prompt-spec resolver's token budget on every
 * emit.
 */
export const PHASE_KNOWLEDGE: Readonly<Record<OnboardingPhase, PhaseKnowledgePack | null>> = {
  // S2 — hand-authored.
  signup: PACK_SIGNUP,
  ai_substrate_offered: PACK_AI_SUBSTRATE_OFFERED,
  import_upload_pending: PACK_IMPORT_UPLOAD_PENDING,
  personality_offered: PACK_PERSONALITY_OFFERED,

  // S3 — hand-authored (2026-05-18). Covers the remaining seven
  // user-input-bearing phases per the brief § 4. Eleven of eighteen
  // phases now carry packs; the remaining seven (identity_oauth,
  // instance_provisioned, import_running, persona_synthesizing, wow_fired,
  // completed, failed) stay forever-null because they don't accept
  // routable text.
  import_analysis_presented: PACK_IMPORT_ANALYSIS_PRESENTED,
  work_interview_gap_fill: PACK_WORK_INTERVIEW_GAP_FILL,
  agent_name_chosen: PACK_AGENT_NAME_CHOSEN,
  slug_chosen: PACK_SLUG_CHOSEN,
  projects_proposed: PACK_PROJECTS_PROPOSED,
  persona_reviewed: PACK_PERSONA_REVIEWED,
  max_oauth_offered: PACK_MAX_OAUTH_OFFERED,

  // Forever-null — transit / terminal / external-driven phases.
  identity_oauth: null,
  instance_provisioned: null,
  import_running: null,
  persona_synthesizing: null,
  wow_fired: null,
  completed: null,
  failed: null,
}

/**
 * Validate a `PhaseKnowledgePack` against the size caps + structural
 * requirements per the sprint brief § 2.4. Throws on any violation so
 * the bug surfaces at module load, never at runtime.
 *
 * Intentionally hand-rolled (not zod) to mirror the discipline already
 * established by `parseLlmSpec` in this file — keeps the validator on
 * the same axis as the rest of the resolver and avoids dragging zod
 * into a module that doesn't otherwise need it.
 */
export function validatePhaseKnowledgePack(
  pack: PhaseKnowledgePack,
  phase: string,
): void {
  if (typeof pack.why_we_ask !== 'string' || pack.why_we_ask.length === 0) {
    throw new Error(
      `PHASE_KNOWLEDGE[${phase}].why_we_ask must be a non-empty string`,
    )
  }
  if (pack.why_we_ask.length > KNOWLEDGE_PACK_LIMITS.whyWeAskMax) {
    throw new Error(
      `PHASE_KNOWLEDGE[${phase}].why_we_ask is ${pack.why_we_ask.length} chars (max ${KNOWLEDGE_PACK_LIMITS.whyWeAskMax})`,
    )
  }
  if (pack.faqs === null || typeof pack.faqs !== 'object' || Array.isArray(pack.faqs)) {
    throw new Error(
      `PHASE_KNOWLEDGE[${phase}].faqs must be a plain object`,
    )
  }
  const faqEntries = Object.entries(pack.faqs)
  if (
    faqEntries.length < KNOWLEDGE_PACK_LIMITS.faqsMin ||
    faqEntries.length > KNOWLEDGE_PACK_LIMITS.faqsMax
  ) {
    throw new Error(
      `PHASE_KNOWLEDGE[${phase}].faqs has ${faqEntries.length} entries (allowed ${KNOWLEDGE_PACK_LIMITS.faqsMin}-${KNOWLEDGE_PACK_LIMITS.faqsMax})`,
    )
  }
  for (const [k, v] of faqEntries) {
    if (typeof k !== 'string' || k.length === 0) {
      throw new Error(
        `PHASE_KNOWLEDGE[${phase}].faqs has a non-string or empty key`,
      )
    }
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(
        `PHASE_KNOWLEDGE[${phase}].faqs[${k}] must be a non-empty string`,
      )
    }
    if (v.length > KNOWLEDGE_PACK_LIMITS.faqValueMax) {
      throw new Error(
        `PHASE_KNOWLEDGE[${phase}].faqs[${k}] is ${v.length} chars (max ${KNOWLEDGE_PACK_LIMITS.faqValueMax})`,
      )
    }
  }
  if (!Array.isArray(pack.expected_tangents)) {
    throw new Error(
      `PHASE_KNOWLEDGE[${phase}].expected_tangents must be an array`,
    )
  }
  if (
    pack.expected_tangents.length < KNOWLEDGE_PACK_LIMITS.expectedTangentsMin ||
    pack.expected_tangents.length > KNOWLEDGE_PACK_LIMITS.expectedTangentsMax
  ) {
    throw new Error(
      `PHASE_KNOWLEDGE[${phase}].expected_tangents has ${pack.expected_tangents.length} entries (allowed ${KNOWLEDGE_PACK_LIMITS.expectedTangentsMin}-${KNOWLEDGE_PACK_LIMITS.expectedTangentsMax})`,
    )
  }
  for (let i = 0; i < pack.expected_tangents.length; i += 1) {
    const ex = pack.expected_tangents[i]!
    if (
      typeof ex.user_text_example !== 'string' ||
      ex.user_text_example.length === 0 ||
      ex.user_text_example.length > KNOWLEDGE_PACK_LIMITS.exampleUserTextMax
    ) {
      throw new Error(
        `PHASE_KNOWLEDGE[${phase}].expected_tangents[${i}].user_text_example must be 1-${KNOWLEDGE_PACK_LIMITS.exampleUserTextMax} chars`,
      )
    }
    if (ex.expected_action !== 'answer' && ex.expected_action !== 'amend') {
      throw new Error(
        `PHASE_KNOWLEDGE[${phase}].expected_tangents[${i}].expected_action must be 'answer' or 'amend'`,
      )
    }
    if (
      typeof ex.summary !== 'string' ||
      ex.summary.length === 0 ||
      ex.summary.length > KNOWLEDGE_PACK_LIMITS.exampleSummaryMax
    ) {
      throw new Error(
        `PHASE_KNOWLEDGE[${phase}].expected_tangents[${i}].summary must be 1-${KNOWLEDGE_PACK_LIMITS.exampleSummaryMax} chars`,
      )
    }
  }
  if (!Array.isArray(pack.advance_examples)) {
    throw new Error(
      `PHASE_KNOWLEDGE[${phase}].advance_examples must be an array`,
    )
  }
  if (
    pack.advance_examples.length < KNOWLEDGE_PACK_LIMITS.advanceExamplesMin ||
    pack.advance_examples.length > KNOWLEDGE_PACK_LIMITS.advanceExamplesMax
  ) {
    throw new Error(
      `PHASE_KNOWLEDGE[${phase}].advance_examples has ${pack.advance_examples.length} entries (allowed ${KNOWLEDGE_PACK_LIMITS.advanceExamplesMin}-${KNOWLEDGE_PACK_LIMITS.advanceExamplesMax})`,
    )
  }
  for (let i = 0; i < pack.advance_examples.length; i += 1) {
    const ex = pack.advance_examples[i]!
    if (
      typeof ex.user_text_example !== 'string' ||
      ex.user_text_example.length === 0 ||
      ex.user_text_example.length > KNOWLEDGE_PACK_LIMITS.exampleUserTextMax
    ) {
      throw new Error(
        `PHASE_KNOWLEDGE[${phase}].advance_examples[${i}].user_text_example must be 1-${KNOWLEDGE_PACK_LIMITS.exampleUserTextMax} chars`,
      )
    }
    if (
      ex.canonical_value !== null &&
      (typeof ex.canonical_value !== 'string' || ex.canonical_value.length === 0)
    ) {
      throw new Error(
        `PHASE_KNOWLEDGE[${phase}].advance_examples[${i}].canonical_value must be null or non-empty string`,
      )
    }
    if (
      typeof ex.summary !== 'string' ||
      ex.summary.length === 0 ||
      ex.summary.length > KNOWLEDGE_PACK_LIMITS.exampleSummaryMax
    ) {
      throw new Error(
        `PHASE_KNOWLEDGE[${phase}].advance_examples[${i}].summary must be 1-${KNOWLEDGE_PACK_LIMITS.exampleSummaryMax} chars`,
      )
    }
  }
}

// Module-load validation of every non-null pack. A bad pack throws at
// import time so the bug surfaces in CI, never at runtime against a
// real user.
for (const [phase, pack] of Object.entries(PHASE_KNOWLEDGE)) {
  if (pack !== null) {
    validatePhaseKnowledgePack(pack, phase)
  }
}

/**
 * Resolve the knowledge pack for a phase. Returns null when the phase
 * has no pack (S3+ phases, transit / terminal / external-driven
 * phases). The engine treats null as "the router does not fire on this
 * phase" — same shape the resolver uses.
 */
export function getKnowledgeForPhase(
  phase: OnboardingPhase,
): PhaseKnowledgePack | null {
  return PHASE_KNOWLEDGE[phase]
}

// ---------------------------------------------------------------------------
// Resolver interface + LLM implementation
// ---------------------------------------------------------------------------

export interface PhaseSpecResolver {
  /**
   * Returns `null` when the resolver has nothing to say for this phase
   * (e.g. the env flag is off, or the phase is not in the LLM-enabled
   * set). The engine treats `null` as "use the static spec" — same
   * contract as today's `resolvePhasePromptSpec`.
   */
  resolve(bundle: PhaseContextBundle): Promise<PhasePromptSpec | null>
}

/**
 * Substrate-shaped LLM call. Production wires Anthropic Haiku 4.5 via the
 * instance-resolved Anthropic credentials; tests inject a stub returning
 * a deterministic JSON string.
 */
export type LlmCallFn = (input: {
  system: string
  user: string
  max_tokens: number
}) => Promise<string>

export interface LlmPhaseSpecResolverDeps {
  /** Anthropic Messages API substrate. Resolver wraps with timeout. */
  llm: LlmCallFn

  /**
   * Comma-separated phase names enabled for LLM rephrasing. Production
   * passes `process.env['NEUTRON_LLM_ONBOARDING_PHASES']`. When the
   * resulting set is empty, the resolver returns `null` for every
   * phase — which the engine maps to the static fallback. This is the
   * default; ladder phases on by editing the env var.
   */
  enabled_phases: ReadonlySet<OnboardingPhase>

  /**
   * Optional structured logger. Defaults to `console.warn` on warn/error
   * and a no-op on info.
   */
  log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    meta?: Record<string, unknown>,
  ) => void

  /** Hard timeout for the LLM call. Defaults to the conversational tier
   *  `CONVERSATIONAL_TIMEOUT_MS_DEFAULT` (45s; env `NEUTRON_GAP_FILL_TIMEOUT_MS`).
   *  The resolver reuses ONE warm `claude` session (no per-turn cold spawn), but a
   *  REAL phase-spec turn runs Opus over ~400 tokens of personalised content on an
   *  accumulating session, so it can legitimately run well past the old 12s tier —
   *  45s covers a warm turn (a typing indicator is shown throughout) so the rich
   *  phases land the LLM spec instead of degrading to the static phase prompt
   *  (2026-06-18 warm-turn static-fallback fix). A genuine stall still falls back. */
  timeout_ms?: number

  /**
   * ONE-TIME elevated budget for the FIRST LLM dispatch only (2026-06-18
   * conversational cold-start fix). The first conversational turn can race the
   * composer's cold CC spawn (~11-30 s) even WITH the `awaitReady` gate — the gate
   * can resolve at its cap while the warm session is still spawning, or the
   * pre-warm's warm-up turn errored and was swallowed. The snappy 12 s tier is far
   * too tight for a cold spawn, so the first turn degrades to static purely from
   * spawn latency (the live-signup symptom). When set, EXACTLY the first dispatch
   * uses this (cold-spawn-sized) budget; every subsequent warm dispatch uses
   * `timeout_ms`. Belt-and-suspenders with `awaitReady`: the conversational path
   * does NOT degrade to static merely because the warm session is still spawning.
   * Omit (managed gateway / tests) to apply `timeout_ms` to every call.
   */
  first_call_timeout_ms?: number

  /**
   * Callback fired BEFORE the LLM call begins. Production wires the
   * web `agent_typing_start` envelope; the engine swallows errors
   * (a typing-indicator failure must never block the resolver). Receives
   * the bundle so the callback can dispatch on `topic_id` / `phase`.
   */
  onLlmStart?: (bundle: PhaseContextBundle) => void

  /**
   * Callback fired AFTER the LLM call completes — both on success AND
   * on error / timeout / parse failure. Always paired with
   * `onLlmStart`. Same swallow-errors contract.
   */
  onLlmEnd?: (
    bundle: PhaseContextBundle,
    outcome: { ok: boolean; reason?: string },
  ) => void

  /**
   * Optional pre-warm readiness gate (2026-06-18 synthesis-completes fix).
   * Awaited ONCE, OUTSIDE the conversational timeout, before the FIRST LLM
   * dispatch — so the cold CC spawn the composer pre-warms (~11-30 s) finishes
   * BEFORE the short conversational budget starts ticking. Without it the first
   * real turn races the cold spawn and times out at 12 s into the static
   * fallback purely from spawn latency (the live-signup symptom). The composer
   * wires a BOUNDED awaiter (`PREWARM_AWAIT_CAP_MS_DEFAULT`) that resolves on
   * real readiness or the cap, whichever first; it must never throw (best-effort
   * — a failed/late pre-warm just degrades to the pre-fix race). Subsequent
   * dispatches re-await an already-resolved promise (instant), so only the cold
   * first turn waits and warm turns stay snappy.
   */
  awaitReady?: () => Promise<void>

  /**
   * Optional warm-readiness probe (2026-06-18 cold-start fix, round 2). Reports
   * whether the composer's pre-warm has settled (the warm `claude` REPL is up).
   * The original cold-start fix elevated EXACTLY the first dispatch — but the live
   * owner-signup showed the first TWO conversational calls racing the cold spawn
   * and BOTH timing out at the 12 s tier (`×2` in the log). When this probe is
   * supplied, the elevated `first_call_timeout_ms` budget applies to EVERY dispatch
   * that lands while the pre-warm has NOT yet settled (the whole cold window), not
   * just the first — so no early turn degrades to static purely from spawn latency.
   * Once it reports ready, every dispatch uses the snappy `timeout_ms` tier. Omit
   * (managed gateway / tests) to keep the first-call-only behavior.
   */
  isWarmReady?: () => boolean
}

export interface BuildLlmPhaseSpecResolverInput
  extends LlmPhaseSpecResolverDeps {}

/**
 * Build the production LLM-backed resolver. Returns `null` from `resolve`
 * when the phase is not in the enabled set; the engine then falls back
 * to its existing static spec lookup.
 */
export function buildLlmPhaseSpecResolver(
  deps: BuildLlmPhaseSpecResolverInput,
): PhaseSpecResolver {
  const log =
    deps.log ??
    ((level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => {
      if (level === 'info') return
      const tail = meta !== undefined ? ` ${JSON.stringify(meta)}` : ''
      console.warn(`[phase-spec-resolver] ${msg}${tail}`)
    })
  const timeout_ms = deps.timeout_ms ?? CONVERSATIONAL_TIMEOUT_MS_DEFAULT
  // ONE-TIME elevated budget for the cold first dispatch (2026-06-18 cold-start
  // fix). `firstCallPending` flips false the moment the first dispatch is claimed,
  // so exactly one call pays the cold-spawn-sized budget; warm turns stay snappy.
  let firstCallPending = deps.first_call_timeout_ms !== undefined

  return {
    async resolve(bundle: PhaseContextBundle): Promise<PhasePromptSpec | null> {
      // Per-phase env-flag rollout. When the phase is NOT enabled,
      // return null so the engine falls back to its existing static
      // spec lookup. This is the default in production until each
      // phase is laddered on individually.
      if (!deps.enabled_phases.has(bundle.phase)) return null

      const intent = PHASE_INTENTS[bundle.phase]
      if (intent === null || intent === undefined) {
        // Phase is externally driven OR specially cased — engine should
        // not have called us. Return null defensively.
        return null
      }

      const system = buildSystemPrompt(intent)
      const user = buildUserPrompt(bundle)

      // Pre-warm readiness gate (2026-06-18): wait for the composer's cold CC
      // spawn to settle BEFORE the conversational timeout starts ticking, so the
      // first real turn doesn't time out into the static fallback purely from
      // cold-spawn latency. Bounded + best-effort inside the composer's awaiter;
      // defensively swallow here too so it can never block the resolver.
      if (deps.awaitReady !== undefined) {
        try {
          await deps.awaitReady()
        } catch {
          /* best-effort — proceed; the dispatch below covers a cold session */
        }
      }

      // Claim the elevated cold-spawn budget for any dispatch in the COLD WINDOW
      // (2026-06-18 cold-start fix, round 2). `first_call_timeout_ms` is sized to
      // cover a ~11-30s cold CC spawn; the snappy `timeout_ms` tier is far too tight
      // for it. The original fix elevated ONLY the first dispatch, but the live
      // owner-signup showed the first TWO turns racing the cold spawn and both
      // timing out at 12s (the `×2`). So elevate while the cold window is open:
      //   - always the FIRST dispatch (`firstCallPending`) — covers the case where
      //     the pre-warm's warm-up turn errored and `isWarmReady` reports ready
      //     while the next real call still cold-spawns; AND
      //   - any dispatch while `isWarmReady()` reports NOT-yet-ready — covers the
      //     ×2 (and ×N) cold-window races until the warm REPL is actually up.
      // Once the warm session is ready, every dispatch uses the snappy tier. This
      // is the belt to `awaitReady`'s suspenders.
      const warmNotReady = deps.isWarmReady !== undefined && !deps.isWarmReady()
      let effective_timeout_ms = timeout_ms
      if (deps.first_call_timeout_ms !== undefined && (firstCallPending || warmNotReady)) {
        effective_timeout_ms = deps.first_call_timeout_ms
      }
      firstCallPending = false

      // Wrap the LLM call in onLlmStart/onLlmEnd so the typing-indicator
      // emits even when the call throws or times out. The callbacks
      // themselves are swallow-errors so a bad indicator wire never
      // blocks the resolver.
      safeCall(deps.onLlmStart, bundle)
      let raw: string
      try {
        raw = await withTimeout(
          deps.llm({ system, user, max_tokens: 400 }),
          effective_timeout_ms,
        )
      } catch (err) {
        safeEnd(deps.onLlmEnd, bundle, {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        })
        log('warn', 'llm call failed; falling back to static spec', {
          phase: bundle.phase,
          project_slug: bundle.project_slug,
          err: err instanceof Error ? err.message : String(err),
        })
        return null
      }
      safeEnd(deps.onLlmEnd, bundle, { ok: true })

      const parsed = parseLlmSpec(raw, intent)
      if (parsed === null) {
        log('warn', 'malformed llm output; falling back to static spec', {
          phase: bundle.phase,
          project_slug: bundle.project_slug,
          raw_head: raw.slice(0, 200),
        })
        return null
      }
      // BODY↔OPTIONS DESYNC GUARD (onboarding-bodyoptions-desync, 2026-06-20)
      // — the launch showstopper. The phase-spec LLM runs on ONE warm,
      // ACCUMULATING `cc-llm` REPL (open/composer.ts), so a cold-start /
      // accumulated-context turn can return the PREVIOUS phase's body (e.g. a
      // "what's your first name?" re-ask emitted while the engine has already
      // advanced to `ai_substrate_offered`). When that lagged body arrives with
      // an EMPTY options array, the old `materializeSpec` hardening grafted the
      // CURRENT phase's static options onto it — manufacturing the live defect:
      // a NAME body wearing the IMPORT buttons (Yes ChatGPT / Yes Claude /
      // Neither), and a phantom second name-ask. body and options came from
      // DIFFERENT phases.
      //
      // The invariant: a prompt's body and its options MUST come from the SAME
      // phase. So when an option-bearing phase resolves option-less, do NOT
      // splice static options onto the LLM body — discard the whole LLM spec and
      // let the engine fall back to the FULL static spec (body AND options both
      // from this phase). A NON-empty option subset is still a legitimate
      // narrowing and is preserved by `materializeSpec`. This also subsumes the
      // BUG-2 phantom-buttons fix more robustly: an option-bearing phase can no
      // longer emit a body without its buttons.
      if (intent.allowed_option_values.length > 0 && parsed.options.length === 0) {
        log(
          'warn',
          'option-bearing phase resolved option-less; using static spec to keep body/options in-phase',
          {
            phase: bundle.phase,
            project_slug: bundle.project_slug,
            body_head: parsed.body.slice(0, 80),
          },
        )
        return null
      }
      return materializeSpec(parsed, intent, bundle.phase)
    },
  }
}

function safeCall(
  fn: ((b: PhaseContextBundle) => void) | undefined,
  bundle: PhaseContextBundle,
): void {
  if (fn === undefined) return
  try {
    fn(bundle)
  } catch (err) {
    console.warn(
      `[phase-spec-resolver] onLlmStart callback threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

function safeEnd(
  fn:
    | ((b: PhaseContextBundle, o: { ok: boolean; reason?: string }) => void)
    | undefined,
  bundle: PhaseContextBundle,
  outcome: { ok: boolean; reason?: string },
): void {
  if (fn === undefined) return
  try {
    fn(bundle, outcome)
  } catch (err) {
    console.warn(
      `[phase-spec-resolver] onLlmEnd callback threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

// ---------------------------------------------------------------------------
// LLM prompt construction
// ---------------------------------------------------------------------------

const TONE_CONTRACT = `Voice: casual, warm, conversational. Talk like a friend who's helping the
user set up. Use the user's name when known. Keep replies short (one or
two sentences). Avoid corporate filler ("Great!", "Awesome!"), validating
openings ("Good question"), and em-dashes (Anthropic's AI-tells regex
flags them). Use hyphens for asides instead.`

const JSON_CONTRACT = `Output ONE JSON object on a single line. No prose. No markdown fences.
Schema:
  { "body": "<one or two sentences, ${'<='} max_body_chars>",
    "options": [ { "label": "A"|"B"|"C"|"D", "body": "<short>", "value": "<slug>" } ]
  }
The "options" array MUST be empty for free-text intents. For pick-only
and pick-or-text intents, EVERY option's "value" MUST come from the
allowed list. Never invent new option values. Never include the strings
"__freeform__", "__timeout__", "__cancel__".`

export function buildSystemPrompt(intent: PhaseIntent): string {
  const allowedHint =
    intent.allowed_option_values.length === 0
      ? '(no options allowed — free-text only)'
      : intent.allowed_option_values.map((v) => `"${v}"`).join(', ')
  return [
    `You are the onboarding agent rephrasing one prompt for the user.`,
    ``,
    // Cross-phase body-lag guard (onboarding-bodyoptions-desync, 2026-06-20).
    // This resolver runs on ONE warm, ACCUMULATING `cc-llm` session, so prior
    // turns (and the questions they asked) are in your context. Each call is a
    // STANDALONE rephrase of the CURRENT phase below — never continue or re-ask
    // a PRIOR turn's question. If the conversation already moved past a step
    // (e.g. the name was given), do not ask for it again; rephrase ONLY the
    // current phase intent.
    `This is a standalone rephrase of the CURRENT phase only. Ignore any task or question from earlier turns — generate the prompt for the phase intent below and nothing else.`,
    ``,
    `Phase intent: ${intent.goal}`,
    `Shape: ${intent.shape}`,
    `Allowed option values: ${allowedHint}`,
    `max_body_chars: ${intent.max_body_chars}`,
    ``,
    TONE_CONTRACT,
    ``,
    JSON_CONTRACT,
  ].join('\n')
}

export function buildUserPrompt(bundle: PhaseContextBundle): string {
  const lines: string[] = []
  lines.push(`signup_via=${bundle.signup_via}`)
  if (bundle.telegram_display_name !== null) {
    lines.push(`telegram_first_name=${sanitizeUserContent(bundle.telegram_display_name)}`)
  }
  if (bundle.captured.agent_name !== undefined && bundle.captured.agent_name !== null) {
    lines.push(`captured.agent_name=${sanitizeUserContent(bundle.captured.agent_name)}`)
  }
  if (
    bundle.captured.archetype_hint !== undefined &&
    bundle.captured.archetype_hint !== null
  ) {
    lines.push(`captured.archetype_hint=${sanitizeUserContent(bundle.captured.archetype_hint)}`)
  }
  if (
    bundle.captured.suggested_slug !== undefined &&
    bundle.captured.suggested_slug !== null
  ) {
    lines.push(`captured.suggested_slug=${sanitizeUserContent(bundle.captured.suggested_slug)}`)
  }
  lines.push(`attempt_count=${bundle.attempt_count}`)
  if (bundle.rejection_reason !== null) {
    lines.push(`rejection_reason=${sanitizeUserContent(bundle.rejection_reason)}`)
  }
  if (bundle.required_fields_state !== undefined) {
    // P2 v2 § 9.3 — surface the audit snapshot so the LLM can target
    // the highest-priority missing field with its next question.
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
    lines.push(`recent_turns:`)
    for (const t of bundle.recent_turns) {
      const head = t.body.length > 80 ? `${t.body.slice(0, 77)}...` : t.body
      lines.push(`  ${t.role}@${t.phase}: ${sanitizeUserContent(head)}`)
    }
  }
  // Per-channel hint for the signup-on-web case (avoid surfacing a
  // "Use my Telegram display name" suggestion when the user is on the
  // web). Channel context the LLM should respect.
  if (bundle.signup_via === 'web') {
    lines.push(
      `note: this user signed up via web — do NOT suggest using their Telegram display name`,
    )
  }
  if (bundle.attempt_count > 0) {
    lines.push(
      `note: prior reply failed validation — rephrase rather than repeat verbatim`,
    )
  }
  return lines.join('\n')
}

/**
 * Strip user-supplied content of literal newlines + carriage returns so
 * a multi-line reply (e.g. `Sam\nrejection_reason=hijacked` typed by
 * a malicious user) cannot escape its enclosing line in the user
 * prompt and inject top-level metadata the LLM would treat as
 * trustworthy resolver-context. Replaces `\n` and `\r` with the
 * literal two-char escape `\n` so the model still sees the user's
 * intent without breaking the line-delimited control format. Also
 * trims to a hard 200-char cap as defense-in-depth against prompt
 * stuffing. (Codex 2026-05-09 P2.)
 */
function sanitizeUserContent(raw: string): string {
  const escaped = raw.replace(/\r/g, '').replace(/\n/g, '\\n')
  return escaped.length > 200 ? `${escaped.slice(0, 197)}...` : escaped
}

// ---------------------------------------------------------------------------
// LLM output parser + materializer
// ---------------------------------------------------------------------------

interface ParsedLlmSpec {
  body: string
  options: ReadonlyArray<{ label: string; body: string; value: string }>
}

/**
 * Strict-parse the LLM's JSON envelope. Returns null when the envelope
 * is invalid (bad JSON, missing body, options that violate the intent
 * contract). The caller falls back to the static spec on null.
 *
 * Tolerates `\`\`\`json` fences and leading/trailing whitespace because
 * model adherence to "no fences" is empirically ~95%.
 */
export function parseLlmSpec(raw: string, intent: PhaseIntent): ParsedLlmSpec | null {
  const stripped = stripJsonFences(raw).trim()
  if (stripped.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const body = obj['body']
  if (typeof body !== 'string' || body.length === 0) return null
  if (body.length > intent.max_body_chars) return null

  // For free-text intents, force options to []. The LLM sometimes
  // suggests buttons even when instructed not to; the engine's contract
  // wins.
  if (intent.shape === 'free-text') {
    return { body: body.trim(), options: [] }
  }

  const optionsRaw = obj['options']
  if (!Array.isArray(optionsRaw)) return null

  const options: Array<{ label: string; body: string; value: string }> = []
  const allowedSet = new Set(intent.allowed_option_values)
  for (const o of optionsRaw) {
    if (typeof o !== 'object' || o === null) continue
    const oo = o as Record<string, unknown>
    const label = oo['label']
    const obody = oo['body']
    const value = oo['value']
    if (typeof label !== 'string' || label.length === 0) continue
    if (typeof obody !== 'string' || obody.length === 0) continue
    if (typeof value !== 'string' || value.length === 0) continue
    if (RESERVED_OPTION_VALUES.has(value)) continue
    if (!allowedSet.has(value)) continue
    options.push({ label, body: obody, value })
  }

  // pick-only intents must surface EVERY allowed option — the LLM
  // controls only body copy, never which control-flow branches the user
  // can take. Skipping `pause` on `name_chosen` or `skip-max` on
  // `persona_reviewed` would strand the user with no escape hatch
  // (allow_freeform is false on pick-only). When any required value is
  // missing, fall back to the static spec by returning null. (Codex
  // 2026-05-09 P2.)
  if (intent.shape === 'pick-only') {
    if (options.length === 0) return null
    const presentValues = new Set(options.map((o) => o.value))
    for (const required of intent.allowed_option_values) {
      if (!presentValues.has(required)) return null
    }
  }

  return { body: body.trim(), options }
}

function stripJsonFences(raw: string): string {
  // Strip leading ```json / ``` and trailing ```
  const fenceStart = raw.match(/^\s*```(?:json)?\s*\n/i)
  let out = raw
  if (fenceStart !== null) {
    out = out.slice(fenceStart[0].length)
  }
  const fenceEnd = out.match(/\n```\s*$/)
  if (fenceEnd !== null) {
    out = out.slice(0, out.length - fenceEnd[0].length)
  }
  return out
}

/**
 * Stitch the parsed LLM body+options onto the static phase spec
 * skeleton. The static spec contributes `next_phase_on_default`,
 * `next_phase_overrides`, `kind`, and `allow_freeform` so routing /
 * rendering invariants stay locked to the engine's source of truth —
 * the LLM never picks the next phase.
 */
export function materializeSpec(
  parsed: ParsedLlmSpec,
  intent: PhaseIntent,
  phase: OnboardingPhase,
): PhasePromptSpec {
  const fallback = STATIC_PHASE_SPECS[phase] ?? null
  if (fallback === null) {
    // No static spec to anchor next-phase routing — refuse to materialize
    // an LLM spec that would have nowhere to go. Caller treats null
    // returns as fallback-required.
    throw new Error(
      `materializeSpec: no static fallback for phase=${phase} (illegal state — engine should not call resolver here)`,
    )
  }
  // BODY↔OPTIONS in-phase invariant (onboarding-bodyoptions-desync,
  // 2026-06-20). Body and options are used here EXACTLY as the LLM produced
  // them on this single call for this single phase — never spliced across
  // sources. The earlier BUG-2 hardening grafted the static fallback's
  // options onto the LLM body when the LLM dropped its options; on the warm
  // accumulating `cc-llm` session that grafted the CURRENT phase's buttons
  // onto a LAGGED (previous-phase) body — the live "name body + import
  // buttons" desync. The option-less case for an option-bearing phase is now
  // caught one level up in `resolve()`, which discards the whole LLM spec and
  // falls back to the FULL static spec (body AND options both in-phase). So
  // by the time we materialize, `parsed.options` is the LLM's own in-phase
  // set (a possibly-narrowed subset for option-bearing phases, or `[]` for
  // free-text phases whose static fallback is also option-less).
  const options = parsed.options
  const out: PhasePromptSpec = {
    phase,
    body: parsed.body,
    options,
    allow_freeform: intent.shape !== 'pick-only',
    next_phase_on_default: fallback.next_phase_on_default,
  }
  if (fallback.next_phase_overrides !== undefined) {
    out.next_phase_overrides = fallback.next_phase_overrides
  }
  if (fallback.kind !== undefined) {
    out.kind = fallback.kind
  }
  return out
}

// ---------------------------------------------------------------------------
// Lightweight validators (the engine calls these on inbound user replies)
// ---------------------------------------------------------------------------

export type ReplyValidator =
  | 'non-empty'
  | 'name'
  | 'archetype-list'
  | 'rituals'
  | 'work-pattern'
  | 'choice-only'

export interface ValidateReplyResult {
  ok: boolean
  /** When ok=false, a short reason the engine can stash in
   *  `phase_state.rejection_reason` so the next resolver call surfaces
   *  it. Stays under ~80 chars. */
  reason?: string
  /** When ok=true, the canonical string the engine should write to
   *  the captured field (trimmed name, sanitized slug, etc). */
  canonical?: string
}

/**
 * Minimal free-text validators. Reserved for use by a future engine
 * extension that routes free-text replies through `validateReply`
 * before advancing phase. Today the engine validates ad-hoc per phase;
 * this helper centralises the rules so a follow-up sprint can flip the
 * call site without re-deriving the regexes.
 */
export function validateReply(
  text: string,
  validator: ReplyValidator,
): ValidateReplyResult {
  const trimmed = text.trim()
  if (validator === 'choice-only') {
    return { ok: false, reason: 'choice-only validator must be applied to button choices, not free-text' }
  }
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty reply' }
  }
  switch (validator) {
    case 'non-empty':
      return { ok: true, canonical: trimmed }
    case 'name': {
      // Reject obvious refusals + over-long replies.
      if (/^(none|skip|pass|nothing|no)$/i.test(trimmed)) {
        return { ok: false, reason: "didn't catch a name" }
      }
      if (trimmed.length > 80) {
        return { ok: false, reason: 'name too long (max 80 chars)' }
      }
      return { ok: true, canonical: trimmed }
    }
    case 'archetype-list': {
      const parts = trimmed
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      if (parts.length === 0) return { ok: false, reason: 'no archetypes given' }
      if (parts.length > 4) {
        return { ok: false, reason: 'too many archetypes (max 4)' }
      }
      for (const p of parts) {
        if (p.length > 40) {
          return { ok: false, reason: `archetype "${p.slice(0, 20)}..." too long` }
        }
      }
      return { ok: true, canonical: parts.join(', ') }
    }
    case 'rituals':
      return { ok: true, canonical: trimmed }
    case 'work-pattern': {
      if (trimmed.length > 280) {
        return { ok: false, reason: 'reply too long (max 280 chars)' }
      }
      return { ok: true, canonical: trimmed }
    }
  }
}

// ---------------------------------------------------------------------------
// withTimeout helper
// ---------------------------------------------------------------------------

/**
 * Race the input promise against a timer. Resolves with the input's
 * result when it wins; rejects with a `TimeoutError` when the timer
 * fires first. The pending input promise is left to resolve in the
 * background — the resolver does not chase cancellation because the
 * Anthropic SDK does not expose an abort handle here.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`timed out after ${ms}ms`))
    }, ms)
  })
  try {
    return await Promise.race([p, timeoutP])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError'
}

// ---------------------------------------------------------------------------
// Env-flag parser
// ---------------------------------------------------------------------------

/**
 * Every phase the resolver is willing to LLM-rephrase. Derived once from
 * `PHASE_INTENTS` (any phase with a non-null intent). Used by
 * `resolveEnabledPhases` to compute the "default-on for all phases" set
 * when the env vars opt for that.
 */
export function allLlmEligiblePhases(): ReadonlySet<OnboardingPhase> {
  const out = new Set<OnboardingPhase>()
  for (const key of Object.keys(PHASE_INTENTS)) {
    if (PHASE_INTENTS[key] !== null) out.add(key as OnboardingPhase)
  }
  return out
}

/**
 * Parse the comma-separated phase list from `NEUTRON_LLM_ONBOARDING_PHASES`
 * into a typed set. Unknown phase names are silently dropped (operators
 * see no LLM rephrasing for those entries; the static spec wins). Empty
 * input returns an empty set — callers decide whether empty means
 * "off" or "default-on" via `resolveEnabledPhases`.
 */
export function parseEnabledPhasesEnv(
  raw: string | undefined,
): ReadonlySet<OnboardingPhase> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return new Set<OnboardingPhase>()
  }
  const valid = allLlmEligiblePhases()
  const out = new Set<OnboardingPhase>()
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    if (valid.has(trimmed as OnboardingPhase)) {
      out.add(trimmed as OnboardingPhase)
    }
  }
  return out
}

/**
 * 2026-05-12 sprint — single source of truth for which phases the LLM
 * resolver should rephrase, given the gateway process's env block.
 *
 * Policy (new default: LLM-on for ALL eligible phases):
 *
 * Precedence — `NEUTRON_LLM_ONBOARDING_PHASES` always wins when set
 * (operator override). `NEUTRON_LLM_ONBOARDING_DEFAULT` only takes
 * effect when `_PHASES` is unset / empty.
 *
 * `NEUTRON_LLM_ONBOARDING_PHASES`:
 *   - `unset` / `""` / `"   "` — fall through to `_DEFAULT` (below).
 *   - one of `off`/`none`/`disabled`/`no`/`false`/`0` — hard opt-out;
 *     resolver wires no phases regardless of `_DEFAULT`.
 *   - one of `all`/`1`/`true`/`yes`/`on`/`enabled` — opt-in for every
 *     LLM-eligible phase (same as default-on).
 *   - comma-separated list (`signup,name_chosen,...`) — exactly those
 *     phases. Unknown / null-intent names dropped.
 *
 * `NEUTRON_LLM_ONBOARDING_DEFAULT`:
 *   - `unset` — default ON (every eligible phase).
 *   - one of `1`/`true`/`yes`/`on`/`enabled`/`all` — default ON.
 *   - one of `off`/`none`/`disabled`/`no`/`false`/`0`/`""` — default OFF.
 *
 * The result is the set of phases the LLM call will fire for; phases
 * NOT in the set fall through to the deterministic `STATIC_PHASE_SPECS`
 * table.
 *
 * Failure-mode contract: even when a phase IS in the enabled set, any
 * LLM error (timeout, parse, allow-list rejection) still falls back to
 * the static spec for that phase. The set decides "should we ATTEMPT
 * the LLM call"; the per-call resilience is unchanged.
 */
export function resolveEnabledPhases(
  env: { [key: string]: string | undefined } | NodeJS.ProcessEnv,
): ReadonlySet<OnboardingPhase> {
  const rawPhases = env['NEUTRON_LLM_ONBOARDING_PHASES']
  const phasesTrimmed = typeof rawPhases === 'string' ? rawPhases.trim() : ''

  if (phasesTrimmed.length > 0) {
    const lowered = phasesTrimmed.toLowerCase()
    if (OPTOUT_TOKENS.has(lowered)) return new Set<OnboardingPhase>()
    if (OPTIN_TOKENS.has(lowered)) return allLlmEligiblePhases()
    return parseEnabledPhasesEnv(phasesTrimmed)
  }

  // `_PHASES` unset/empty → fall through to `_DEFAULT` (default-on).
  //
  // Codex r1 P1 (2026-05-12): distinguish a truly-absent variable
  // (`undefined`) from a present-but-empty one (`""`). Systemd drop-ins
  // routinely use `Environment=NEUTRON_LLM_ONBOARDING_DEFAULT=` to
  // explicitly clear the parent unit's value — that operator intent is
  // "opt-out", NOT "fall back to default-on". The OPTOUT_TOKENS set
  // already lists `""`; honor that contract before reaching the
  // "absent ⇒ default-on" branch.
  const rawDefault = env['NEUTRON_LLM_ONBOARDING_DEFAULT']
  if (rawDefault === undefined) {
    // Truly absent → default-on. The unit template explicitly sets `1`
    // for clarity, but a missing-env-var dev mode still gets the new
    // default behavior.
    return allLlmEligiblePhases()
  }
  const defaultTrimmed = typeof rawDefault === 'string' ? rawDefault.trim().toLowerCase() : ''
  if (OPTOUT_TOKENS.has(defaultTrimmed)) return new Set<OnboardingPhase>()
  if (OPTIN_TOKENS.has(defaultTrimmed)) return allLlmEligiblePhases()
  // Unrecognized token — treat as opt-out to be safe (operator typo
  // shouldn't silently enable LLM globally).
  return new Set<OnboardingPhase>()
}
