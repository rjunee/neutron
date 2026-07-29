/**
 * @neutronai/onboarding — best-effort agent-name extraction from a freeform
 * signup reply.
 *
 * 2026-05-11 — added when the signup static fallback was rewritten from
 * "What's your name?" to the persona-discovery question Jane asked for.
 * The original single-question fallback could rely on the whole reply
 * being the user's name; the persona-discovery prompt invites multi-field
 * replies ("Sherlock Holmes but warmer, call me Jane") where the actual
 * `agent_name` is a small slice of the text. The engine's freeform-text
 * capture writes `phase_state.agent_name` from this slice; the slug
 * picker seeds `suggested_slug` off the same value. Getting it wrong
 * means the user lands on a slug derived from archetype text ("sherlock-
 * holmes-but-warmer-call-me-sam") instead of their name.
 *
 * 2026-05-12 (Bug C — Codex r2 follow-up from PR #71) — the whole-reply
 * fallback now rejects long replies (> SHORT_NAME_MAX_CHARS) AND multi-
 * word replies that look like archetype talk. When no name-shaped
 * pattern matches AND the reply doesn't look like a bare name, the
 * function returns `null` so the caller (engine signup→name_chosen
 * transition) can stay at signup and emit a clarifying re-prompt
 * instead of advancing with garbage `agent_name`.
 *
 * Patterns recognised, in order of specificity:
 *   1. "call me X" / "call me X."     (e.g. "Sherlock but warmer, call me Jane")
 *   2. "name is X"  / "my name is X"  (e.g. "My name is Jane Doe.")
 *   3. "I'm X" / "I am X" — ONLY when X is a plausible proper noun
 *      (capitalised first letter AND not in the verb-continuation
 *      stop list). Codex r1 P1 (2026-05-11): without the stop-list
 *      guard, a persona-discovery reply like "I'm thinking Marcus
 *      Aurelius but warmer" would extract "thinking Marcus Aurelius"
 *      — same shape of bug the rewrite was supposed to fix.
 *   4. Bare-name fallback: reply is short (<= SHORT_NAME_MAX_CHARS) AND
 *      has <= MAX_NAME_TOKENS tokens AND every token starts with a
 *      letter (no leading digit / symbol). Preserves the single-word
 *      case ("Jane") + short two-word case ("Jane Doe") without
 *      swallowing long archetype talk.
 *   5. Else `null` — the engine stays at signup and re-prompts.
 *
 * Each match is post-processed: trim trailing punctuation, cap at three
 * whitespace-separated tokens (so "Jane Doe from Acme" still
 * captures "Jane Doe"), and reject empty matches (falls through to the
 * next pattern).
 */

const MAX_NAME_TOKENS = 3
/**
 * 2026-05-12 — soft upper bound on a "looks like a name" reply. Real
 * names are short; archetype prose is long. Replies longer than this
 * fall through to `null` (caller re-prompts) when no explicit name
 * pattern fired. Tuned wide enough to accept "Jane Mary Doe" +
 * trailing punctuation; conservative enough to reject a one-sentence
 * persona description.
 */
const SHORT_NAME_MAX_CHARS = 30

/**
 * Common verb / hedge continuations that follow "I'm" / "I am" in a
 * persona-discovery reply (e.g. "I'm thinking ...", "I'm looking for
 * ...", "I'm interested in ..."). When the FIRST captured token after
 * "I'm X" is in this set, the match is rejected and the function falls
 * through to the next pattern. Lowercase-keyed; comparison is case-
 * insensitive.
 *
 * Codex r1 P1 (2026-05-11) — discovered while reviewing the new signup
 * fallback. The persona-discovery prompt explicitly invites this shape
 * of reply, so the false-positive lands in the normal happy path rather
 * than an edge case.
 */
const I_AM_CONTINUATION_STOP_WORDS: ReadonlySet<string> = new Set([
  'thinking',
  'looking',
  'wondering',
  'hoping',
  'wanting',
  'feeling',
  'seeking',
  'interested',
  'open',
  'leaning',
  'going',
  'curious',
  'after',
  'down',
  'into',
  'kind',
  'sort',
  'good',
  'fine',
  'a',
  'an',
  'the',
  'just',
  'mostly',
  'really',
  'pretty',
  'somewhere',
])

/**
 * Extract a best-effort agent_name slice from a freeform signup reply.
 * Returns `null` when:
 *   - input is empty / not a string, OR
 *   - no explicit name pattern fired AND the reply is too long / looks
 *     like archetype prose (see SHORT_NAME_MAX_CHARS + looksLikeBareName).
 *
 * The null return is load-bearing: the engine's signup→name_chosen
 * transition stays at signup and emits a clarifying re-prompt ("Got it.
 * What should I call you?") rather than advancing with garbage agent_name.
 * Pre-2026-05-12 the fallback returned the whole reply verbatim, which
 * caused owners to land with `suggested_slug =
 * "a-warm-collaborator-with-marcus-aurelius-vibes"`.
 */
export function extractAgentNameFromFreeform(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  // Pattern 1 — "call me X" anywhere in the reply. Most specific
  // self-introduction phrase; runs first so a reply that has both
  // ("I'm thinking Sherlock-but-warmer, call me Jane") prefers "Jane".
  const callMe = matchAfterPhrase(trimmed, /\bcall\s+me\s+/i, /* requireCapital */ false)
  if (callMe !== null) return callMe

  // Pattern 2 — "(my )?name is X". Explicit name introduction.
  const nameIs = matchAfterPhrase(
    trimmed,
    /\b(?:my\s+)?name\s+is\s+/i,
    /* requireCapital */ false,
  )
  if (nameIs !== null) return nameIs

  // Pattern 3 — "I'm X" / "I am X". Looser; risks false positives in
  // persona-discovery replies like "I'm thinking Marcus Aurelius...".
  // Guard with TWO conditions on the FIRST captured token:
  //   (a) starts with an uppercase ASCII letter (proper-noun signal); AND
  //   (b) is NOT in I_AM_CONTINUATION_STOP_WORDS.
  // When either fails, fall through to the bare-name fallback so the
  // user's persona description isn't mis-parsed as their name.
  //
  // Argus r1 [MINOR] (2026-05-11): the character class must accept BOTH
  // the ASCII apostrophe (U+0027) AND the typographic single quotes
  // U+2018 (LEFT) and U+2019 (RIGHT). iOS autocorrect rewrites a typed
  // straight quote to U+2019, so "I’m Jane" from an iPhone would
  // otherwise fail this pattern and seed an unusable slug like
  // `i-m-sam` / `im-sam` via the whole-reply fallback.
  const iAm = matchAfterPhrase(
    trimmed,
    /\bI\s*['‘’]?\s*a?m\s+/i,
    /* requireCapital */ true,
  )
  if (iAm !== null) return iAm

  // Pattern 4 — bare name. Accept only when the trimmed reply is short
  // AND every token starts with a letter (no digits / punctuation
  // leading the first token). Capitalisation is NOT required — slug
  // sanitisation downcases anyway, and the typed-name UX should
  // tolerate "jane doe" / "Jane" / "JANE" indifferently.
  if (looksLikeBareName(trimmed)) return trimmed

  // No pattern matched AND the reply doesn't look like a bare name.
  // Returning null tells the engine: "I can't extract a name from this;
  // please re-prompt the user." Stops the engine from advancing to
  // name_chosen with archetype prose as `agent_name`.
  return null
}

/**
 * 2026-05-12 — heuristic for "this trimmed reply could plausibly be the
 * user's name with no introduction phrase".
 *
 * Accepts:
 *   - Single token of any case: "Jane", "sam", "JANE"
 *   - Two-to-three-token names: "Jane Doe", "Jane Mary Doe"
 *   - Hyphenated or apostrophised tokens: "Mary-Jane", "O'Brien"
 *
 * Rejects:
 *   - Replies longer than SHORT_NAME_MAX_CHARS
 *   - Replies with more than MAX_NAME_TOKENS tokens
 *   - Replies whose FIRST token starts with a non-letter (digit, symbol)
 *   - Replies containing punctuation other than apostrophe / hyphen /
 *     period within tokens (commas / semicolons signal archetype prose)
 */
function looksLikeBareName(trimmed: string): boolean {
  if (trimmed.length === 0) return false
  if (trimmed.length > SHORT_NAME_MAX_CHARS) return false
  // Reject obvious clause separators — commas, semicolons, colons,
  // exclamation, question marks. A bare name doesn't have them.
  if (/[,;:!?]/.test(trimmed)) return false
  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 0 || tokens.length > MAX_NAME_TOKENS) return false
  for (const t of tokens) {
    // Each token must start with a letter (Unicode-aware) — defensive
    // against replies that start with a digit or symbol.
    if (!/^\p{L}/u.test(t)) return false
    // The token may end with a single trailing period (e.g. "Jane.")
    // which the caller strips. Reject any other interior punctuation
    // — apostrophes (O'Brien) and hyphens (Mary-Jane) are allowed.
    if (!/^[\p{L}][\p{L}'‘’\-]*\.?$/u.test(t)) return false
  }
  return true
}

/**
 * Slice the trimmed reply at the FIRST occurrence of `phrase` and return
 * up to `MAX_NAME_TOKENS` whitespace-separated tokens AFTER the match.
 * Trims trailing punctuation. Returns null when the match is missing OR
 * the captured slice is empty.
 *
 * When `requireCapital` is true, the FIRST captured token must (a) start
 * with an uppercase ASCII letter AND (b) not be in
 * I_AM_CONTINUATION_STOP_WORDS. Used by the "I'm X" pattern to filter
 * out persona-description continuations like "I'm thinking ...".
 */
function matchAfterPhrase(
  input: string,
  phrase: RegExp,
  requireCapital: boolean,
): string | null {
  const match = phrase.exec(input)
  if (match === null) return null
  const tail = input.slice(match.index + match[0].length).trim()
  if (tail.length === 0) return null
  // Stop at the first comma/period/etc so a multi-clause reply like
  // "call me Jane, sherlock but warmer" returns "Jane" rather than
  // "Jane sherlock but warmer".
  const clauseEnd = tail.search(/[,.;:!?]/)
  const clause = clauseEnd === -1 ? tail : tail.slice(0, clauseEnd)
  const tokens = clause.trim().split(/\s+/).slice(0, MAX_NAME_TOKENS)
  const cleaned = tokens
    .map((t) => t.replace(/[.,;:!?]+$/u, ''))
    .filter((t) => t.length > 0)
  if (cleaned.length === 0) return null
  const first = cleaned[0]
  if (first === undefined) return null
  if (requireCapital) {
    // Reject lowercase-led tokens (likely verb continuations like
    // "thinking") AND known stop words (defense in depth — a freak
    // case like "I'm Looking-Glass-Warmer" would survive the
    // uppercase check but should still be rejected).
    if (!/^[A-Z]/.test(first)) return null
    if (I_AM_CONTINUATION_STOP_WORDS.has(first.toLowerCase())) return null
  }
  return cleaned.join(' ')
}
