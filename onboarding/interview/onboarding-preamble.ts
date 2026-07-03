/**
 * @neutronai/onboarding/interview — the live-session onboarding preamble.
 *
 * Path 1 (onboarding-as-CC-session, 2026-06-27): instead of a phase-machine
 * driving the interview turn-by-turn through an LLM router, the SAME live Claude
 * Code chat session conducts the interview. This fragment is spliced into the
 * first-turn system prompt while the owner is not yet onboarded; Claude itself
 * decides what has been answered and what to ask next. A fire-and-forget
 * post-turn extractor (`post-turn-extractor.ts`) scribes the structured profile
 * out of the conversation in the background.
 *
 * The four fields the extractor + `required-fields-audit.ts` need before
 * onboarding completes: the user's first name, ≥3 work projects/focus areas,
 * ≥1 non-work interest, and the agent's personality.
 *
 * 2026-07-01 (DROP the agent-NAME step): Neutron Open is an agent ORCHESTRATOR,
 * not a personal agent, so onboarding NEVER asks the owner to name it. The
 * former step-5 "a name for you" ask and the `needsName` half of the step guard
 * are gone; personality alone drives SOUL.md.
 */

import { STATIC_PERSONALITY_CHARACTER_FALLBACK } from './personality-character-suggester.ts'
import { auditRequiredFields } from './required-fields-audit.ts'

export interface OnboardingPreambleInput {
  /** Whether an AI history-import (ChatGPT/Claude) is offered on this box. */
  import_offered: boolean
}

/**
 * The DEFINED personality-archetype menu the agent offers at the personality
 * step (item 1, 2026-06-30). Before this, the preamble told the model to "offer
 * a couple of concrete flavors" and it improvised a fresh, inconsistent trio
 * every run. We instead inject a stable, curated set of NAMED characters (the
 * voice anchors `personality-character-suggester.ts` was built around) so every
 * owner sees the same recognisable choices — rendered as tappable buttons via
 * the `[[OPTIONS]]` protocol below. The owner can still describe their own.
 */
const DEFINED_PERSONALITY_CHARACTERS: ReadonlyArray<{ name: string; why: string }> = [
  ...STATIC_PERSONALITY_CHARACTER_FALLBACK.personalized,
  ...STATIC_PERSONALITY_CHARACTER_FALLBACK.wild,
]

/**
 * The archetype NAMES the personality step presents (item, 2026-06-30 name/
 * closing fix). Exported so the deterministic button-backed-answer capture
 * (`button-backed-answer.ts`) can recognise "the prior agent message WAS the
 * personality step" by matching these names inside its `[[OPTIONS]]` block —
 * the signal that lets it settle `agent_personality` at choice-time instead of
 * waiting on the flaky post-turn LLM extractor. Kept in lock-step with the set
 * the step guard forces (`DEFINED_PERSONALITY_CHARACTERS` above), so the
 * matcher can never drift from what the agent is instructed to render.
 */
export const DEFINED_PERSONALITY_CHARACTER_NAMES: ReadonlyArray<string> =
  DEFINED_PERSONALITY_CHARACTERS.map((c) => c.name)

export function buildOnboardingPreamble(input: OnboardingPreambleInput): string {
  const lines: string[] = []
  lines.push('<onboarding>')
  lines.push(
    'IMPORTANT: This is the owner\'s VERY FIRST conversation with you. You are onboarding',
    'them — getting to know them so you can become their genuinely useful personal',
    'assistant. Run this as a warm, natural conversation, NOT a form. Ask ONE thing at a',
    'time, react to what they say, and keep it short and human. No corporate filler, no',
    'numbered checklists shown to the user, no "Question 1 of 5".',
  )
  lines.push('')
  lines.push('Over the course of the conversation, naturally learn:')
  lines.push('  1. Their first name (what they\'d like you to call them).')
  if (input.import_offered) {
    // The import offer is the EXPLICIT, EARLY first step — right after the name
    // and BEFORE the work questions — so the box can analyse their real history
    // and the rest of the interview is informed by it (onboarding-experience
    // spec: upload precedes the guided interview). Positioned here, between goal
    // #1 and goal #2, on purpose: placed at the end the model defers it past the
    // work-interview, which is the "import is buried" bug this fixes.
    lines.push('')
    lines.push(
      'RIGHT AFTER they tell you their name — as your very FIRST move, and BEFORE you ask',
      'what they work on — EXPLICITLY and prominently offer to import their existing ChatGPT',
      'or Claude history, so you start out already knowing their projects and context. Make',
      'this a clear, up-front ask (not a throwaway aside): tell them they can export their',
      'data from ChatGPT/Claude settings and then drag-and-drop or attach the .zip right here',
      'in the chat — there is an attach (📎) / drop-zone control for exactly this. If they',
      'attach one, acknowledge it warmly; the import runs in the background and shows live',
      'progress while you keep talking, then you\'ll share what you found. If they decline or',
      'don\'t have an export handy, that is completely fine — just move on to the questions',
      'below. Either way, only ask this once.',
    )
    lines.push('')
  }
  lines.push(
    '  2. What they work on — get at least three concrete projects, focus areas, or',
    '     things currently on their plate. Probe gently for more if they give only one.',
  )
  lines.push('  3. At least one thing they care about OUTSIDE work (a hobby / interest).')
  lines.push(
    '  4. The personality they want from YOU — whose voice should you take on? Offer the',
    '     DEFINED set of character archetypes below as tappable options (emit them with',
    '     the [[OPTIONS]] block — see "Offering choices"). Each is a recognisable figure',
    '     whose vibe anchors how you talk. Always include a "Something else (I\'ll describe',
    '     it)" option so they can give their own flavor (warm, blunt, a sharp technical',
    '     peer, …) in free text. Offer THESE — do not invent a different list:',
  )
  for (const c of DEFINED_PERSONALITY_CHARACTERS) {
    lines.push(`       - ${c.name} — ${c.why}`)
  }
  lines.push('')
  lines.push(
    'Do NOT ask them to name you. This is an agent ORCHESTRATOR, not a personal agent',
    'with a name — never ask "what should you call me" or suggest names for yourself.',
    'The personality above is the last thing you need from them.',
  )
  lines.push('')
  lines.push('Offering choices (tappable buttons):')
  lines.push(
    'When you offer the owner a set of choices — the personality archetypes or a yes/no',
    'like the history-import offer — give them tappable buttons by appending a block in',
    'EXACTLY this format at the very END of your message, after your prose question:',
  )
  lines.push('')
  lines.push('  [[OPTIONS]]')
  lines.push('  - First choice')
  lines.push('  - Second choice')
  lines.push('  - Something else (I\'ll describe it)')
  lines.push('  [[/OPTIONS]]')
  lines.push('')
  lines.push(
    'Rules: write your normal conversational question FIRST, then the block. Keep each',
    'option SHORT (a few words) — the option\'s text is exactly what gets sent back when',
    'they tap it, so make it self-explanatory. Use the block ONLY for genuine choice',
    'steps (personality, a clear yes/no), at most ~6 options, and always',
    'leave room for a free-text answer (they can ignore the buttons and just type). Do',
    'NOT use it for open questions like "what do you work on?". Never show the literal',
    '[[OPTIONS]] markers in prose — they are stripped before the owner sees the message.',
  )
  lines.push('')
  lines.push(
    'You do NOT need to collect these in order, and a single answer may cover several. Do',
    'not re-ask something they already told you.',
  )
  lines.push('')
  lines.push(
    'FINISHING — do NOT write your own closing/wrap-up. The system sends ONE closing',
    'message automatically the moment the last step is answered: it confirms everything',
    'is set, names the projects it created, and invites the owner to open one in the LEFT',
    'RAIL (each has its own Work, Documents, and Chat). So once they have given the final',
    'answer (their personality choice), reply with at MOST a single short, warm',
    'acknowledgement of that answer (e.g. "Love it.") and STOP.',
    'Do NOT say "you\'re all set", do NOT list or',
    'summarise their projects, do NOT mention the left rail or "onboarding complete", and',
    'do NOT ask "what do you want to look at first?". Restating any of that duplicates the',
    'automatic closing (the exact bug we are avoiding). Never announce phases; the',
    'transition should feel seamless as you simply continue as their assistant.',
  )
  lines.push('')
  lines.push(
    'STYLE: do not use em dashes (—) in your messages to the owner; write with commas,',
    'periods, or parentheses instead.',
  )
  lines.push('</onboarding>')
  return lines.join('\n')
}

/**
 * DETERMINISTIC step guard (item 3, 2026-06-30 fresh-install fix) — a per-turn
 * fragment re-injected on EVERY onboarding turn (the same mechanism the
 * `<import_analysis>` grounding uses) that FORCES the button-driven personality
 * step to actually happen.
 *
 * THE BUG this fixes: the personality/archetype step lived only as soft prose in
 * the first-turn preamble ("offer the DEFINED set ... as tappable options"), and
 * the preamble ALSO says "you do NOT need to collect these in order." So whether
 * the archetype buttons ever appeared was pure LLM whim — a fresh-install verify
 * saw a whole onboarding run with ZERO option buttons (the agent settled
 * personality by free text, or inferred it, and skipped the choice UI entirely).
 * The preamble alone cannot GUARANTEE the step.
 *
 * THE FIX (stays inside Path-1 live-session — no phase-machine revival): audit
 * the durable `phase_state` for the button-backed personality field. While
 * `agent_personality` is still unset, this fragment HARD-REQUIRES the agent to
 * present the named archetypes as a `[[OPTIONS]]` block (it cannot be settled by
 * free text alone, and the agent may not finalize without it). Returns null once
 * personality is settled (nothing to force).
 *
 * 2026-07-01 (DROP the agent-NAME step): the former second half of this guard —
 * a `needsName` branch that forced a name-suggestion `[[OPTIONS]]` block once
 * personality was set — is gone. Neutron Open never asks the owner to name the
 * orchestrator, so personality is the only button-driven required step.
 *
 * Because it re-injects every turn, the agent cannot drift past the personality
 * step without rendering the buttons — making the step reliable rather than
 * LLM-whim — while still leaving room for a free-text answer (the [[OPTIONS]]
 * block always carries a "Something else" / "I'll describe it" escape and the
 * owner can ignore the buttons and type).
 */
export function buildOnboardingStepGuardFragment(
  phase_state: Readonly<Record<string, unknown>>,
): string | null {
  const audit = auditRequiredFields(phase_state)
  const needsPersonality = new Set(audit.missing).has('agent_personality')
  if (!needsPersonality) return null
  const lines: string[] = []
  lines.push('<onboarding_required_steps>')
  lines.push(
    'REQUIRED-STEP GUARD: the personality step is button-driven and MUST be',
    'presented as a `[[OPTIONS]]` block (see "Offering choices") — never settled by',
    'free text alone and never silently skipped. You may not wrap up / finalize',
    'onboarding until it is settled.',
  )
  lines.push('')
  lines.push(
    'STILL OPEN - PERSONALITY: you have NOT yet settled the personality/voice the owner',
    'wants from you. The next time it is natural in the conversation (and BEFORE you',
    'wrap up), you MUST ask which voice they want and present THESE named archetypes as',
    'a tappable [[OPTIONS]] block (plus a "Something else (I\'ll describe it)" option).',
    'Do not invent a different list, and do not skip the buttons:',
  )
  for (const c of DEFINED_PERSONALITY_CHARACTERS) {
    lines.push(`  - ${c.name}`)
  }
  lines.push('</onboarding_required_steps>')
  return lines.join('\n')
}

/**
 * IMPORT-IN-FLIGHT steer (2026-07-01 SEV1 M1 blocker — "STOP M2" a). A per-turn
 * fragment injected while a history import is uploading / being analyzed. Its job
 * is to keep the live agent from doing PROJECT DISCOVERY during the upload: the
 * real projects come from the import once it lands, so asking "what do you work
 * on?" now and creating projects from thin chat answers is exactly the bug this
 * sprint fixes (the durable post-turn extractor already refuses to persist
 * project-discovery fields while the import is in flight; this fragment keeps the
 * conversation itself from soliciting them, so the owner isn't asked a question
 * whose answer is silently dropped).
 *
 * Import-INDEPENDENT progress is still encouraged: acknowledge the upload, and if
 * personality/voice (→ SOUL.md) is still open, that is the thing to move on. When
 * the import finishes the system surfaces what it found and project discovery
 * resumes.
 *
 * Returns null when no import is in flight (the caller then injects nothing).
 */
export function buildImportInFlightSteerFragment(import_in_flight: boolean): string | null {
  if (!import_in_flight) return null
  const lines: string[] = []
  lines.push('<import_in_flight>')
  lines.push(
    'A history import is uploading and being analyzed RIGHT NOW. Do NOT ask the owner',
    'about their projects, work, or what they are focused on yet, and do NOT try to',
    'create or name any projects: their real projects come from this import once it',
    'finishes. While it runs, keep the conversation on import-INDEPENDENT things only.',
    'Acknowledge the upload warmly, and if you still need it, this is a good moment to',
    'settle the personality/voice they want from you (offer the archetype options). The',
    'moment the import is done the system surfaces what it found and project discovery',
    'continues from there, so there is no need to rush it.',
  )
  lines.push('</import_in_flight>')
  return lines.join('\n')
}

/**
 * Escape import-derived text before splicing it into the `<import_analysis>`
 * prompt block. The proposed project name/rationale come from the user's
 * ChatGPT/Claude export (untrusted), so XML-like content must not be able to
 * close the wrapper or inject sibling instructions. Mirrors `work-board/
 * fragment.ts`'s `escapeData` + `escalation-loader.ts`'s `escapeXmlText`.
 */
function escapeImportText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** A project the agent proposed from the user's import (name + why). */
export interface ProposedProjectForContext {
  name: string
  rationale?: string
}

export interface ImportAnalysisContextInput {
  /** The projects the agent presented after reading the import (verbatim). */
  proposed_projects: ReadonlyArray<ProposedProjectForContext>
  /**
   * The CURRENT working project set (`phase_state.primary_projects`) AFTER any
   * curation — a proposed project missing from here has been dropped by the
   * owner and will NOT be created.
   */
  active_project_names: ReadonlyArray<string>
  /** The owner's first name, if already known. */
  user_first_name?: string | null
}

/**
 * Per-turn onboarding grounding for the import-analysis → curation handoff.
 *
 * THE BUG this fixes: the import-analysis result (the proposed-projects list the
 * agent "presented" after reading the export) is delivered to the client OUT OF
 * BAND — an ephemeral app-ws `agent_message` that never enters the warm REPL's
 * transcript. So when the owner replies to curate it ("drop the Family Home
 * project, keep the rest"), the live-agent turn has NO record of having proposed
 * anything and answers "this is our first conversation, I haven't proposed any
 * projects." This fragment re-injects the proposed set (with rationale + which
 * have already been dropped) into the agent's context EVERY onboarding turn —
 * exactly like the Work Board block re-grounds every turn — so the warm session
 * KNOWS what it proposed and can handle keep/drop/edit/add, then finalize the
 * curated set. Returns null when there's no import analysis to ground on.
 */
export function buildImportAnalysisContextFragment(
  input: ImportAnalysisContextInput,
): string | null {
  const proposed = input.proposed_projects.filter((p) => p.name.trim().length > 0)
  if (proposed.length === 0) return null
  const active = new Set(
    input.active_project_names.map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0),
  )
  const lines: string[] = []
  lines.push('<import_analysis>')
  lines.push(
    'CONTEXT — you have ALREADY read this owner\'s imported ChatGPT/Claude history earlier in',
    'THIS onboarding and PRESENTED them an analysis, including the proposed projects below.',
    'Do NOT claim you have not proposed anything, that you have no memory of it, or that this',
    'is your first message — you proposed these, and the owner may now be reviewing/curating',
    'the list.',
  )
  lines.push('')
  lines.push('Projects you proposed from their import:')
  for (const p of proposed) {
    const dropped = !active.has(p.name.trim().toLowerCase())
    // Escape import-derived text: a project name / rationale lifted from the
    // user's ChatGPT/Claude export is untrusted and could contain XML-like text
    // (e.g. "</import_analysis>") that would close this wrapper and inject
    // sibling instructions into every warm onboarding turn. Mirrors the
    // anti-injection escaping the work-board + escalation prompt seams use.
    const name = escapeImportText(p.name.trim())
    const rationale =
      p.rationale !== undefined && p.rationale.trim().length > 0
        ? ` — ${escapeImportText(p.rationale.trim())}`
        : ''
    lines.push(`  - ${name}${rationale}${dropped ? '   [DROPPED by the owner — will NOT be created]' : ''}`)
  }
  lines.push('')
  lines.push(
    'When the owner curates ("drop X", "keep the rest", "rename Y to Z", "add W"), respond',
    'naturally and confirm the updated set; a dropped project is not created, and one you',
    'add is. You do not need their explicit sign-off on every project — once the set looks',
    'right, keep going. You still need the rest of the interview (their work focus beyond',
    'these, a non-work interest, and your personality) before you finalize.',
  )
  lines.push('</import_analysis>')
  return lines.join('\n')
}
