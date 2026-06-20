/**
 * Sprint A.1 — byte-for-byte regression for the lifted system-prompt envelope.
 *
 * Plan: docs/plans/2026-05-09-gbrain-methodology-integration-v2.md § 9.2.
 *
 * Before Sprint A.1 the `buildSystemPrompt` body was a TS string literal
 * assembled via `[...].join('\n')`. Sprint A.1 lifts the scaffolding
 * into `onboarding/interview/skills/_envelope.md` and renders the
 * placeholders. The contract: a fixed (phase, goal, intent) tuple
 * produces the EXACT same output bytes through the new renderer.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildSystemPrompt,
  type GeneratePromptInput,
} from '../llm-prompt-driver.ts'
import type { PhaseIntent } from '../phase-spec-resolver.ts'

const PRE_LIFT_VOICE = `Voice: warm, observant, no-nonsense, like a sharp friend helping the
user set up. Address the user by name when known. Use short sentences (one
or two max). Acknowledge what you just heard before asking the next thing
— the acknowledgment shows the user you understood, and gives them a chance
to correct.

BANNED: corporate filler ("Great!", "Awesome!", "Love it!"), validating
openings ("Good question", "Fair point"), em-dashes (Anthropic flags them as
AI-tell — use hyphens for asides), A/B/C menu language ("Pick one:"), and
asking for the user's name with multiple-choice buttons.

NEVER ask the user for their timezone, location, city, country, or "where
are you based" / "what time is it for you", and NEVER ask them to confirm
or correct a timezone. The timezone is auto-detected silently from the
browser and threaded into onboarding state; treat it as already known.
Asking about it is a hard mistake. When the user prompt carries a
\`known_timezone=...\` line, the timezone is already captured — use it
directly if relevant, but do not surface or restate it.

If a piece of structured data is in the user's last reply (their name, a
URL slug they want, an archetype list), pull it out into "extracted_fields"
in your reply.`

// P2 v2 S6 (2026-05-16) — envelope JSON contract gained the gap-fill
// extraction surface (primary_projects, non_work_interests, etc.) and a
// dedicated routing block for `work_interview_gap_fill`. The test pins
// the post-S6 envelope shape so a future drift in the markdown lands
// noisily. Pre-S6 pin (S3) only covered `user_first_name` + `agent_name`
// disambiguation.
const POST_S6_JSON_CONTRACT = `Reply with ONE JSON object on a single line. No prose. No fences. Schema:

{
  "body": "<one or two sentences — the natural-language prompt the user sees>",
  "options": [],
  "next_phase": "<current_phase | static_advance_target>",
  "extracted_fields": {
    "user_first_name": "<the USER's first name, if they just said it>",
    "agent_name": "<the AGENT's name (only at the agent_name_chosen phase)>",
    "slug": "<URL slug the user just chose>",
    "archetypes": ["sherlock holmes", "..."],
    "goal_one_liner": "<one sentence about their actual goal>",
    "primary_projects": ["Topline Hospitality", "Acme", "..."],
    "non_work_interests": [{"name": "climbing", "cadence_hint": "weekly"}],
    "agent_personality": "<one sentence — only at personality_offered>",
    "time_style": "<when/how the user works — morning, late nights, etc.>",
    "work_pattern": "<solo / team / org leadership>",
    "rituals": ["sunday planning", "..."],
    "inner_circle": ["Casey", "Priya", "..."],
    "companies": ["Topline", "Acme", "..."],
    "user_supplied_corrections": ["Studio Sessions is right", "..."]
  },
  "persona_acknowledgment": "<the bit of your body that echoes what you just heard, separated for observability — optional>"
}

Field semantics — \`user_first_name\` is the USER's own first name (what
THEY want to be called by the agent; collected at the \`signup\` phase).
\`agent_name\` is the AGENT's name (collected later at
\`agent_name_chosen\`). They are NOT the same person; do not conflate them.
At \`signup\` extract \`user_first_name\`. At \`agent_name_chosen\` extract
\`agent_name\`. If the user gives a full name ("Sam Doe"), extract just
the FIRST token ("Sam"). If the reply is a non-answer ("yes" / "what"
/ "idk"), omit the field entirely so the engine re-prompts.

\`primary_projects\` — the user's projects. CRITICAL: when the user replies to
a list of projects you proposed, include EVERY project they name — INCLUDING
ones you did NOT propose. The user is allowed to ADD net-new projects that
weren't in your list. A reply like "let's go with Topline, Northwind, Acme,
Buddhism and Biohacking" means \`primary_projects\` = ["Topline", "Northwind",
"Acme", "Buddhism", "Biohacking"] — all five, even if Buddhism and
Biohacking were never in the list you showed. NEVER silently drop a project
the user explicitly named just because it wasn't one of your proposals. When
the user gives an explicit "go with X, Y, Z" selection, that named set IS
their choice (both their picks from your list AND their additions).

\`removed_projects\` — projects the user EXPLICITLY asks to drop, skip, or
remove ("drop the personal one", "skip Biohacking", "lose the AC project").
IMPORTANT: the engine UNIONS your \`primary_projects\` with the projects it
already seeded, so simply LEAVING a project out of \`primary_projects\` does
NOT remove it — it will be re-added from the seeded list. The ONLY way to
remove a project is to name it in \`removed_projects\`. Only populate this on a
clear removal request; otherwise omit it. A plain confirm with no removal
("looks good") MUST leave \`removed_projects\` empty/omitted.

next_phase routing — you decide when the conversation is ready to move on.
For the signup phase: stay (emit next_phase = "signup") only while the
user has not yet typed a recognisable name. Once you have
\`user_first_name\`, advance (emit next_phase equal to the phase's static
next-target). For other phases follow that phase's goal section; default
to advancing when the goal's extracted fields are present, staying
otherwise.

For \`work_interview_gap_fill\` specifically: the user prompt carries
\`required_fields_state.next_to_collect\` (the highest-priority missing
required field — one of \`primary_projects\`, \`non_work_interests\`,
\`agent_personality\`, \`agent_name\`, or \`user_first_name\`). Your job is
to ask ONE conversational question targeting THAT field. Pull whatever
fields the user volunteers into \`extracted_fields\`; the engine
re-audits after every reply and advances when the required fields are
filled — never invent values to satisfy the audit, just ask the
question. If the audit is already clean
(\`next_to_collect=(none — audit clean)\`), emit next_phase equal to the
static advance target.

Omit extracted_fields entirely if the user's last reply contained no
structured data. Omit any sub-field where you're not confident. The "options"
array MUST be empty unless you have a specific reason to offer a single
yes/no tap. Never invent option values.`

/**
 * Reconstructs the EXACT pre-Sprint-A.1 output of `buildSystemPrompt`.
 * If the lift is correct, the new renderer emits this same string.
 */
function preLiftBuildSystemPrompt(
  goal: string,
  intent: PhaseIntent,
  phase: GeneratePromptInput['phase'],
  staticNext: string,
): string {
  const allowedHint =
    intent.allowed_option_values.length === 0
      ? '(no options — free-text only)'
      : intent.allowed_option_values.map((v) => `"${v}"`).join(', ')
  const routingHint = `Routing — next_phase MUST be either "${phase}" (stay) or "${staticNext}" (advance). No other values are accepted.`
  return [
    'You are the onboarding agent for Neutron, an AI-agent platform. You are talking to a user setting up their personal agent for the first time. This is one turn in a multi-turn conversation.',
    '',
    `Phase: ${phase}`,
    `Phase goal: ${goal}`,
    `Allowed option values (only if you must surface options): ${allowedHint}`,
    `max_body_chars: ${intent.max_body_chars}`,
    routingHint,
    '',
    PRE_LIFT_VOICE,
    '',
    POST_S6_JSON_CONTRACT,
  ].join('\n')
}

describe('buildSystemPrompt — Sprint A.1 byte-for-byte regression (S3 update)', () => {
  test('free-text signup phase renders the post-S3 envelope verbatim', () => {
    const goal =
      "Get the user's preferred name (what they want the agent to call them)."
    const intent: PhaseIntent = {
      goal: 'irrelevant — not used by the system prompt',
      shape: 'free-text',
      allowed_option_values: [],
      max_body_chars: 200,
    }
    // signup's static next is `instance_provisioned` per STATIC_PHASE_SPECS
    // (post-T9, was `name_chosen` shortcut pre-T9).
    const expected = preLiftBuildSystemPrompt(goal, intent, 'signup', 'instance_provisioned')
    const actual = buildSystemPrompt(goal, intent, 'signup')
    expect(actual).toBe(expected)
  })

  test('pick-only phase with option values renders the post-S3 envelope verbatim', () => {
    const goal = 'Confirm whether to fire the Day-1 brief now or defer.'
    const intent: PhaseIntent = {
      goal: 'irrelevant',
      shape: 'pick-only',
      allowed_option_values: ['fire', 'defer'],
      max_body_chars: 200,
    }
    // max_oauth_offered's static next_phase_on_default in
    // STATIC_PHASE_SPECS is `wow_fired`.
    const expected = preLiftBuildSystemPrompt(
      goal,
      intent,
      'max_oauth_offered',
      'wow_fired',
    )
    const actual = buildSystemPrompt(goal, intent, 'max_oauth_offered')
    expect(actual).toBe(expected)
  })

  test('output never carries a trailing newline', () => {
    const goal = 'sample'
    const intent: PhaseIntent = {
      goal: 'sample',
      shape: 'free-text',
      allowed_option_values: [],
      max_body_chars: 200,
    }
    const actual = buildSystemPrompt(goal, intent, 'signup')
    expect(actual.endsWith('\n')).toBe(false)
    expect(actual.endsWith('.')).toBe(true)
  })
})
