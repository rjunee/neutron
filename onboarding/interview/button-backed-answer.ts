/**
 * @neutronai/onboarding/interview — deterministic button-backed answer capture.
 *
 * BUG 1 (2026-06-30, Ryan live test — agent name/personality asked TWICE): the
 * two button-backed required fields (`agent_personality`, `agent_name`) were
 * persisted ONLY by the fire-and-forget post-turn LLM extractor
 * (`post-turn-extractor.ts` — literally commented "agent_name — LLM only"). When
 * the owner TAPPED a suggested name/personality, nothing wrote `phase_state`
 * until that slow (sometimes-timing-out) extractor parsed it back out of the
 * transcript. Meanwhile the per-turn required-step guard
 * (`onboarding-preamble.ts` `buildOnboardingStepGuardFragment`, driven by
 * `required-fields-audit.ts`) re-injects the "STILL OPEN - NAME/PERSONALITY"
 * hard-require from the STALE pre-turn `phase_state` on every turn — so the live
 * agent dutifully re-asked the exact thing the owner just answered.
 *
 * THE FIX (Path-1 live-session; no phase-machine revival): this PURE decision
 * function inspects the incoming answer + the PRIOR agent message (the question
 * being answered) + the current `phase_state`, and decides whether the answer
 * deterministically settles `agent_personality` or `agent_name`. The onboarding
 * seam runs it at turn-START (before the step guard reads `phase_state`), so the
 * audit recomputes AFTER the answer lands and the step is never re-asked. The
 * LLM extractor stays wired as the fallback for free-text answers this function
 * conservatively declines (e.g. a personality described after tapping "Something
 * else").
 *
 * It is deliberately conservative: it only fires when the PRIOR agent message
 * carried an `[[OPTIONS]]` choice block (a genuine choice step), and it anchors
 * the personality step on the DEFINED archetype names actually presented — so an
 * early yes/no like the import offer can never be mis-captured as a personality.
 */

import { DEFINED_PERSONALITY_CHARACTER_NAMES } from './onboarding-preamble.ts'

/** The `[[OPTIONS]] … [[/OPTIONS]]` block the agent appends at a choice step —
 *  mirrors `build-live-agent-turn.ts`'s `OPTIONS_BLOCK_RE` (kept local so this
 *  onboarding-layer helper takes no gateway import edge). */
const OPTIONS_BLOCK_RE = /\[\[OPTIONS\]\]\s*\n([\s\S]*?)\n?\s*\[\[\/OPTIONS\]\]/i

/**
 * Escape-hatch option lines that must NEVER settle a field — the owner is
 * asking to describe their own instead of taking a suggestion, so the described
 * value arrives on the NEXT turn (handled by the LLM extractor).
 */
const ESCAPE_PATTERNS: ReadonlyArray<RegExp> = [
  /something else/i,
  /i'?ll (choose|pick) my own/i,
  /i'?ll describe/i,
  /choose my own/i,
  /describe (it|my own)/i,
  /none of (these|them|the above)/i,
  /^you pick\b/i,
]

/** Bare confirmations / control words that are never a name. */
const CONFIRMATION_RE =
  /^(yes|no|yep|yeah|nope|ok|okay|sure|sounds good|go ahead|please do|do it|confirm|skip|maybe|not sure|idk)\b/i

/** Longest a captured NAME may be — a name is a word or two; a longer line is a
 *  sentence/description the extractor should handle, not a name. Personality
 *  descriptors are allowed to be longer (a free phrase is a valid voice). */
const NAME_MAX_LEN = 40
const NAME_MAX_WORDS = 6

export interface CaptureButtonBackedInput {
  /** The durable onboarding `phase_state` read at turn start. */
  phase_state: Readonly<Record<string, unknown>>
  /** The owner's answer this turn — a tapped option's value OR typed text. */
  user_text: string
  /** The agent's previous message (the question being answered), or null. */
  prior_agent_text: string | null
}

export interface CapturedButtonBackedField {
  field: 'agent_name' | 'agent_personality'
  value: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isEscapeChoice(text: string): boolean {
  return ESCAPE_PATTERNS.some((re) => re.test(text))
}

/** Split an `[[OPTIONS]]` block body into its option lines (bullets stripped). */
function parseOptionLines(block: string): string[] {
  return block
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s+/u, '').trim())
    .filter((l) => l.length > 0)
}

function looksLikeName(value: string): boolean {
  if (value.length > NAME_MAX_LEN) return false
  if (value.split(/\s+/).length > NAME_MAX_WORDS) return false
  if (value.includes('?')) return false
  if (CONFIRMATION_RE.test(value)) return false
  return true
}

/**
 * Decide whether the incoming onboarding answer deterministically settles one of
 * the two button-backed required fields. Returns the field + verbatim value to
 * persist, or null when this turn is not a settling answer (let the LLM
 * extractor handle it).
 *
 * Priority mirrors `required-fields-audit.ts`: personality is collected before
 * the name, and the step guard forces personality FIRST, so:
 *   - personality unset + prior message presented the archetype menu → settle
 *     `agent_personality` with the owner's pick (tapped archetype line OR a
 *     typed descriptor).
 *   - personality set + name unset + prior message presented a (non-archetype)
 *     choice block → settle `agent_name`.
 */
export function captureButtonBackedRequiredField(
  input: CaptureButtonBackedInput,
): CapturedButtonBackedField | null {
  const value = input.user_text.trim()
  if (value.length === 0) return null
  if (isEscapeChoice(value)) return null

  // Only a genuine choice step (the agent appended an [[OPTIONS]] block last
  // turn) is eligible — this is what keeps arbitrary conversational turns from
  // ever being mis-captured.
  const optionsMatch =
    input.prior_agent_text !== null ? OPTIONS_BLOCK_RE.exec(input.prior_agent_text) : null
  if (optionsMatch === null) return null
  const optionLines = parseOptionLines(optionsMatch[1] ?? '')
  const optionBody = optionLines.join('\n').toLowerCase()

  const personalityMissing = !isNonEmptyString(input.phase_state['agent_personality'])
  const nameMissing = !isNonEmptyString(input.phase_state['agent_name'])
  if (!personalityMissing && !nameMissing) return null

  // Did the prior message present the personality archetype menu? Anchor on the
  // DEFINED archetype names actually rendered (substring — the agent may append
  // a "— why" gloss to each). This distinguishes the personality step from an
  // early yes/no (e.g. the import offer) that must NEVER settle personality.
  const presentedPersonality = DEFINED_PERSONALITY_CHARACTER_NAMES.some((n) =>
    optionBody.includes(n.toLowerCase()),
  )

  // Was the answer an exact tap of a presented option? (Clean, unambiguous.)
  const isTapOfPresented = optionLines.some((o) => o.toLowerCase() === value.toLowerCase())

  // ── Personality step ──────────────────────────────────────────────────────
  if (personalityMissing && presentedPersonality) {
    // A tapped archetype is captured verbatim. A typed personality is a valid
    // free-form voice descriptor too, as long as it isn't a bare confirmation
    // or a question back to the agent.
    if (isTapOfPresented || (!CONFIRMATION_RE.test(value) && !value.endsWith('?'))) {
      return { field: 'agent_personality', value }
    }
    return null
  }

  // ── Name step ─────────────────────────────────────────────────────────────
  // Personality already settled, only the name remains, and the prior message
  // was a (non-archetype) choice block — i.e. the name-suggestion step.
  if (!personalityMissing && nameMissing && !presentedPersonality) {
    if (isTapOfPresented) return { field: 'agent_name', value }
    if (looksLikeName(value)) return { field: 'agent_name', value }
    return null
  }

  return null
}
