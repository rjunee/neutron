/**
 * @neutronai/onboarding/interview — deterministic button-backed answer capture.
 *
 * BUG 1 (2026-06-30, Ryan live test — personality asked TWICE): the button-backed
 * required field `agent_personality` was persisted ONLY by the fire-and-forget
 * post-turn LLM extractor (`post-turn-extractor.ts`). When the owner TAPPED a
 * suggested personality, nothing wrote `phase_state` until that slow
 * (sometimes-timing-out) extractor parsed it back out of the transcript.
 * Meanwhile the per-turn required-step guard (`onboarding-preamble.ts`
 * `buildOnboardingStepGuardFragment`, driven by `required-fields-audit.ts`)
 * re-injects the "STILL OPEN - PERSONALITY" hard-require from the STALE pre-turn
 * `phase_state` on every turn — so the live agent dutifully re-asked the exact
 * thing the owner just answered.
 *
 * THE FIX (Path-1 live-session; no phase-machine revival): this PURE decision
 * function inspects the incoming answer + the PRIOR agent message (the question
 * being answered) + the current `phase_state`, and decides whether the answer
 * deterministically settles `agent_personality`. The onboarding seam runs it at
 * turn-START (before the step guard reads `phase_state`), so the audit recomputes
 * AFTER the answer lands and the step is never re-asked. The LLM extractor stays
 * wired as the fallback for free-text answers this function conservatively
 * declines (e.g. a personality described after tapping "Something else").
 *
 * 2026-07-01 (DROP the agent-NAME step): the former `agent_name` capture branch
 * is gone — Neutron Open never asks the owner to name the orchestrator.
 *
 * 2026-07-18 (IMPORT STEP GUARD): `import_decision` joins `agent_personality` as
 * a button-backed field this settles. The history-import offer had NO capture at
 * all — it was prose in the preamble — so the live agent narrated skips the owner
 * never chose. Reusing THIS turn-start path (rather than adding a second capture
 * mechanism) means the answer lands in `phase_state` before the step guard reads
 * it, so the guard stops re-asking on the very next turn, exactly as it does for
 * personality.
 *
 * It is deliberately conservative: it only fires when the PRIOR agent message
 * carried a persisted option set (a genuine choice step), and it anchors the
 * personality step on the DEFINED archetype names actually presented — so an
 * early yes/no like the import offer can never be mis-captured as a personality.
 *
 * IMPORTANT (Codex r1 P1): the caller MUST pass the prior agent row's DURABLE
 * options (`ButtonStore` `options[].value`), NOT the row body. Live-agent replies
 * persist the `[[OPTIONS]]` block STRIPPED from `body` (it lives in
 * `options_json`), so re-parsing the body would find no block and this would
 * never fire in production.
 */

import {
  DEFINED_PERSONALITY_CHARACTER_NAMES,
  IMPORT_DECISION_OPTIONS,
} from './onboarding-preamble.ts'
import type { ImportDecision } from './required-fields-audit.ts'

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

/** Bare confirmations / control words that are never a personality descriptor. */
const CONFIRMATION_RE =
  /^(yes|no|yep|yeah|nope|ok|okay|sure|sounds good|go ahead|please do|do it|confirm|skip|maybe|not sure|idk)\b/i

export interface CaptureButtonBackedInput {
  /** The durable onboarding `phase_state` read at turn start. */
  phase_state: Readonly<Record<string, unknown>>
  /** The owner's answer this turn — a tapped option's value OR typed text. */
  user_text: string
  /**
   * The DURABLE option values (`ButtonStore` prompt `options[].value`) of the
   * prior agent question — the choice lines the owner could tap. Empty when the
   * prior turn was not a choice step (or there was no prior turn). This is the
   * signal, NOT the row body (which has the `[[OPTIONS]]` block stripped).
   */
  prior_agent_options: ReadonlyArray<string>
}

export interface CapturedButtonBackedField {
  field: 'agent_personality' | 'import_decision'
  value: string
}

/** The import-step option labels, lowercased once for anchor matching. */
const IMPORT_OPTION_LABELS_LC: ReadonlyArray<string> = IMPORT_DECISION_OPTIONS.map((o) =>
  o.label.toLowerCase(),
)

/**
 * A DECLINE of the import. Checked BEFORE the provider matchers on purpose: "I
 * don't have a Claude export" names a provider but is a decline, and reading it
 * as `claude` would strand the owner on an upload they cannot do.
 *
 * The bare leading "no" is deliberately narrowed to answers that name NO
 * provider, so "no, my Claude one" stays a `claude` answer rather than being
 * swallowed as a skip. Getting this direction wrong is the expensive one — a
 * false `neither` is precisely the "we'll skip the import for now" bug.
 */
const IMPORT_DECLINE_RE =
  /\b(skip|neither|none|nope|nah|no thanks|not now|not right now|maybe later|later|pass|don'?t have|do not have|haven'?t got|have no|no export|no history|nothing to import)\b/i
const IMPORT_BARE_NO_RE = /^no\b(?!.*\b(chatgpt|open ?ai|gpt|claude|anthropic)\b)/i

const MENTIONS_CHATGPT_RE = /\b(chatgpt|open ?ai|gpt)\b/i
const MENTIONS_CLAUDE_RE = /\b(claude|anthropic)\b/i

/**
 * Normalize an import answer (a tapped option label OR free text) into the
 * locked `chatgpt | claude | neither` vocabulary. Returns null when the answer
 * is genuinely ambiguous — including "I have both" — so the guard simply
 * re-asks with buttons rather than durably recording a decision the owner did
 * not make. A conservative decline-to-capture is always recoverable; a wrong
 * capture is not.
 */
export function classifyImportDecision(raw: string): ImportDecision | null {
  const text = raw.trim()
  if (text.length === 0) return null
  // An exact tap of a presented option is unambiguous — take it verbatim.
  const tapped = IMPORT_DECISION_OPTIONS.find(
    (o) => o.label.toLowerCase() === text.toLowerCase(),
  )
  if (tapped !== undefined) return tapped.decision
  if (IMPORT_DECLINE_RE.test(text) || IMPORT_BARE_NO_RE.test(text)) return 'neither'
  const chatgpt = MENTIONS_CHATGPT_RE.test(text)
  const claude = MENTIONS_CLAUDE_RE.test(text)
  if (chatgpt && claude) return null
  if (chatgpt) return 'chatgpt'
  if (claude) return 'claude'
  return null
}

/** Did the prior agent message present the history-import choice step? */
function presentedImportDecision(option_body_lc: string): boolean {
  return IMPORT_OPTION_LABELS_LC.some((label) => option_body_lc.includes(label))
}

/**
 * The import decision is already settled when it was captured, or when an
 * import ACTUALLY ran (uploading an export IS the decision). Mirrors
 * `required-fields-audit.ts`'s `isFilled('import_decision')` so the capture and
 * the guard can never disagree about whether the step is open.
 */
function importDecisionSettled(phase_state: Readonly<Record<string, unknown>>): boolean {
  if (isNonEmptyString(phase_state['import_decision'])) return true
  if (isNonEmptyString(phase_state['import_job_id'])) return true
  const result = phase_state['import_result']
  return typeof result === 'object' && result !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isEscapeChoice(text: string): boolean {
  return ESCAPE_PATTERNS.some((re) => re.test(text))
}

/**
 * Decide whether the incoming onboarding answer deterministically settles the
 * button-backed `agent_personality` field. Returns the field + verbatim value to
 * persist, or null when this turn is not a settling answer (let the LLM
 * extractor handle it).
 *
 * 2026-07-01 (DROP the agent-NAME step): personality is now the ONLY button-
 * backed required field. The former name branch (personality set + name unset +
 * a non-archetype choice block → settle `agent_name`) is gone; Neutron Open
 * never asks the owner to name the orchestrator.
 *
 *   - personality unset + prior message presented the archetype menu → settle
 *     `agent_personality` with the owner's pick (tapped archetype line OR a
 *     typed descriptor).
 */
export function captureButtonBackedRequiredField(
  input: CaptureButtonBackedInput,
): CapturedButtonBackedField | null {
  const value = input.user_text.trim()
  if (value.length === 0) return null

  // Only a genuine choice step (the prior agent question carried a persisted
  // option set) is eligible — this is what keeps arbitrary conversational turns
  // from ever being mis-captured.
  const optionLines = input.prior_agent_options.map((o) => o.trim()).filter((o) => o.length > 0)
  if (optionLines.length === 0) return null
  const optionBody = optionLines.join('\n').toLowerCase()

  // Did the prior message present the personality archetype menu? Anchor on the
  // DEFINED archetype names actually rendered (substring — the agent may append
  // a "— why" gloss to each). This distinguishes the personality step from an
  // early yes/no (e.g. the import offer) that must NEVER settle personality.
  const presentedPersonality = DEFINED_PERSONALITY_CHARACTER_NAMES.some((n) =>
    optionBody.includes(n.toLowerCase()),
  )

  // ── IMPORT DECISION (2026-07-18). Checked before personality and mutually
  // exclusive with it: the two steps are anchored on disjoint option menus, so
  // an import yes/no can never settle a personality (the guard the 06-30 fix
  // already relied on) and vice versa. Free text counts here — the owner may
  // type "I have claude history" or "skip" instead of tapping — but only in
  // reply to the step that actually asked, and only when it normalizes to the
  // locked vocabulary. An ambiguous answer captures NOTHING, leaving the guard
  // to re-ask rather than inventing a decision (the whole point of this fix).
  if (!presentedPersonality && !importDecisionSettled(input.phase_state)) {
    if (presentedImportDecision(optionBody)) {
      const decision = classifyImportDecision(value)
      if (decision !== null) return { field: 'import_decision', value: decision }
    }
    return null
  }

  if (isEscapeChoice(value)) return null

  // Personality already settled → nothing to capture.
  if (isNonEmptyString(input.phase_state['agent_personality'])) return null

  if (!presentedPersonality) return null

  // Was the answer an exact tap of a presented option? (Clean, unambiguous.)
  const isTapOfPresented = optionLines.some((o) => o.toLowerCase() === value.toLowerCase())

  // A tapped archetype is captured verbatim. A typed personality is a valid
  // free-form voice descriptor too, as long as it isn't a bare confirmation
  // or a question back to the agent.
  if (isTapOfPresented || (!CONFIRMATION_RE.test(value) && !value.endsWith('?'))) {
    return { field: 'agent_personality', value }
  }
  return null
}
