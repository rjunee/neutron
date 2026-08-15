/**
 * @neutronai/reminders — fire-time message-shape classifier.
 *
 * Ported from the legacy harness's reminder grammar (`prompts/reminder-agent-base.md` +
 * `prompts/reminder-patterns.md`). A stored reminder `message` is one of
 * three shapes; the fire-time dispatcher (`dispatcher.ts`) branches on the
 * shape to build the LLM composition prompt and to choose the graceful
 * degrade body when no LLM substrate is available:
 *
 *   • `literal`    — a plain body ("take out the trash"). With an LLM it is
 *                    smart-wrapped into a warm, context-aware nudge; without
 *                    one it is posted verbatim.
 *   • `smart-wrap` — an explicit composition instruction the agent follows
 *                    at fire time (marked with a leading `[smart]` sentinel).
 *                    Degrades to the instruction text.
 *   • `pattern`    — a `PATTERN: <name>` template block from the patterns
 *                    library (nag-until-done, escalating-urgency,
 *                    daily-countdown, check-in-cadence, context-aware-one-shot).
 *                    The block IS the orchestration prose; the agent follows
 *                    it. Degrades to the block's GOAL/TASK/EVENT line.
 *
 * A leading `[ROUTING] target_thread: <id>` header (the legacy harness parity) is parsed
 * off the front of any shape and surfaced as `routing_topic` so the
 * dispatcher can route the post; it is always stripped from the body the
 * user sees.
 */

/** The pattern names lifted from `prompts/reminder-patterns.md`. */
export const KNOWN_REMINDER_PATTERNS: readonly string[] = [
  'nag-until-done',
  'escalating-urgency',
  'daily-countdown',
  'check-in-cadence',
  'context-aware-one-shot',
]

export type ReminderShape =
  | { kind: 'literal'; body: string; routing_topic: string | null }
  | { kind: 'smart-wrap'; instruction: string; routing_topic: string | null }
  | {
      kind: 'pattern'
      pattern: string
      /** True when `pattern` is one of `KNOWN_REMINDER_PATTERNS`. */
      known: boolean
      block: string
      routing_topic: string | null
    }

const ROUTING_RE = /^\s*\[ROUTING\]\s*target_thread:\s*(\S+)\s*$/i
const SMART_RE = /^\s*\[smart\]\s*/i
// BACKWARD-COMPAT: reminders persisted BEFORE the `[smart]` sentinel was added
// to the composer (`smart-wrap.ts`) open directly with the locked smart-wrap
// prelude and carry NO sentinel. Recognize the FULL distinctive legacy structure
// so such a row is still classified as `smart-wrap` (degrading via its tail)
// instead of falling through to `literal` and posting the whole instruction.
// Recognition requires ALL THREE frozen markers the old composer always wrote,
// so a plain user literal that merely opens with the prelude phrase is NOT
// promoted into an authoritative composition instruction:
//   1. the prelude OPENING phrase (first line), and
//   2. the prelude's distinctive CLOSING phrase, present across every historical
//      prelude variant (weather-shell, owner-home-path, and path-free), and
//   3. the trailing `Original reminder:` payload with a non-empty body.
// These are FROZEN legacy markers (they detect old persisted bytes) — they do
// not track the current `SMART_WRAP_PRELUDE`, which now carries the `[smart]`
// sentinel and is matched by `SMART_RE` above before this ever runs.
const LEGACY_SMART_PRELUDE_OPEN_RE =
  /^\s*Compose a smart version of this reminder using available context/i
const LEGACY_SMART_PRELUDE_CLOSE_RE = /deliver the original message verbatim\b/i
const LEGACY_ORIGINAL_TAIL_RE = /(?:^|\n)Original reminder:\s*\S/i
// Anchored to a SINGLE line (no `/m`): the shape is decided from the first
// post-routing line only. A `PATTERN:` line buried later in the body — e.g.
// inside a smart-wrap "Original reminder: ..." tail carrying arbitrary user
// text — must NOT hijack classification (Codex N7 blocker 2).
const PATTERN_LINE_RE = /^\s*PATTERN:\s*([\w-]+)\s*$/i

/** The first non-empty line of an already-trimmed body (or '' if none). */
function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) return line
  }
  return ''
}

/**
 * Strip a leading `[ROUTING] target_thread: <id>` header (only when it is the
 * very first non-empty line — a `[ROUTING]` appearing mid-body is left as-is,
 * matching the base prompt's "only match at the very start" rule). Returns the
 * extracted thread id (or null) plus the remaining body.
 */
function stripRoutingHeader(message: string): { routing_topic: string | null; rest: string } {
  const lines = message.split('\n')
  // Find the first non-empty line.
  let firstIdx = 0
  while (firstIdx < lines.length && lines[firstIdx]!.trim().length === 0) firstIdx++
  if (firstIdx >= lines.length) return { routing_topic: null, rest: message }
  const m = ROUTING_RE.exec(lines[firstIdx]!)
  if (m === null) return { routing_topic: null, rest: message }
  const rest = lines.slice(firstIdx + 1).join('\n').replace(/^\n+/, '')
  return { routing_topic: m[1] ?? null, rest }
}

/**
 * Classify a stored reminder `message` into one of the three fire-time
 * shapes, after stripping any leading `[ROUTING]` header.
 */
export function classifyReminderMessage(message: string): ReminderShape {
  const { routing_topic, rest } = stripRoutingHeader(message)
  const trimmed = rest.trim()

  // Classify from the FIRST post-routing line only, so a marker appearing on a
  // later line cannot override the leading shape. The `[smart]` sentinel takes
  // precedence over `PATTERN:` — a smart-wrap body opens with the sentinel and
  // may legitimately carry the word "PATTERN:" deeper in the user's text.
  const firstLine = firstNonEmptyLine(trimmed)

  if (SMART_RE.test(firstLine)) {
    return {
      kind: 'smart-wrap',
      instruction: trimmed.replace(SMART_RE, '').trim(),
      routing_topic,
    }
  }

  // Legacy (pre-sentinel) smart-wrap row: the body opens with the locked prelude,
  // carries the prelude's distinctive closing phrase, AND ends with the composer's
  // `Original reminder:` tail — with no `[smart]` to strip, so the whole body IS
  // the instruction. All three frozen markers are required so a plain literal that
  // merely opens with the prelude phrase stays literal.
  if (
    LEGACY_SMART_PRELUDE_OPEN_RE.test(firstLine) &&
    LEGACY_SMART_PRELUDE_CLOSE_RE.test(trimmed) &&
    LEGACY_ORIGINAL_TAIL_RE.test(trimmed)
  ) {
    return {
      kind: 'smart-wrap',
      instruction: trimmed,
      routing_topic,
    }
  }

  const patternMatch = PATTERN_LINE_RE.exec(firstLine)
  if (patternMatch !== null) {
    const pattern = (patternMatch[1] ?? '').toLowerCase()
    return {
      kind: 'pattern',
      pattern,
      known: KNOWN_REMINDER_PATTERNS.includes(pattern),
      block: trimmed,
      routing_topic,
    }
  }

  return { kind: 'literal', body: trimmed, routing_topic }
}

/**
 * Pull the user's original phrase out of a smart-wrap instruction for the
 * no-LLM degrade. The Reminders Core composer appends the raw body as a
 * trailing `Original reminder: <body>` line (`smart-wrap.ts`), so when no
 * substrate is available we post that verbatim rather than the composition
 * instruction itself. Falls back to the whole instruction for a hand-authored
 * `[smart] ...` body that carries no such marker.
 *
 * A SINGLE FORWARD SCAN, not a regex. The regex this replaces —
 * `/(?:^|\n)Original reminder:\s*([\s\S]+?)\s*$/i` — is QUADRATIC on adversarial
 * input: the leading `\s*`, the lazy `[\s\S]+?` and the trailing `\s*$` are
 * mutually ambiguous, so a body of "Original reminder:" followed by many spaces
 * makes the engine retry every split (CodeQL `js/polynomial-redos`, HIGH; the
 * same lesson already written down in `skill-forge/distiller.ts` and
 * `doc-search/chunk.ts`). A stored reminder `message` is attacker-shaped as far
 * as this package is concerned — any tool caller can write one — and the
 * fire-time degrade path runs it on the tick loop. `indexOf` + `slice` + `trim`
 * is O(n) and preserves the regex's semantics EXACTLY: the FIRST line-initial
 * marker wins, and its payload is whitespace-trimmed (empty → no match).
 */
const ORIGINAL_REMINDER_MARKER = 'original reminder:'
function originalReminderPayload(instruction: string): string {
  const haystack = instruction.toLowerCase()
  let from = 0
  for (;;) {
    const at = haystack.indexOf(ORIGINAL_REMINDER_MARKER, from)
    if (at < 0) return ''
    // Line-initial only — a marker mid-line is prose, not the composer's tail.
    if (at === 0 || instruction[at - 1] === '\n') {
      return instruction.slice(at + ORIGINAL_REMINDER_MARKER.length).trim()
    }
    from = at + 1
  }
}
function smartWrapLiteralLine(instruction: string): string {
  const original = originalReminderPayload(instruction)
  return original.length > 0 ? original : instruction
}

/** Pull a human-readable line out of a pattern block for the no-LLM degrade. */
function patternLiteralLine(block: string): string {
  for (const key of ['GOAL', 'TASK', 'EVENT', 'HABIT', 'TOPIC']) {
    const re = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'im')
    const m = re.exec(block)
    if (m !== null && (m[1] ?? '').trim().length > 0) {
      return m[1]!.trim().replace(/^FILL:\s*/i, '')
    }
  }
  return 'You have a reminder due.'
}

/**
 * The upper bound, in characters, on a COMPOSED nudge body. A reminder nudge is
 * one to three sentences; a composed body past this bound is prima facie not a
 * nudge but a composition failure (#293 acceptance criterion 4: "a 3,400-character
 * nudge is prima facie a composition failure"), and the dispatcher refuses it
 * rather than posting it.
 *
 * NOT a token cap — `DEFAULT_MAX_TOKENS` in `dispatcher.ts` caps what the model
 * is ASKED for; this caps what actually reaches the owner. The ritual path has
 * its own, far wider budget (`RITUAL_MAX_TOKENS`) and is deliberately EXEMPT:
 * a morning brief is supposed to be long.
 */
export const MAX_NUDGE_BODY_CHARS = 2000

/**
 * The FAR TIGHTER bound on how much STORED INTENT may be posted verbatim when
 * composition did not produce a body (no substrate, a thrown/empty compose, or a
 * composed body refused by {@link MAX_NUDGE_BODY_CHARS}).
 *
 * WHY THIS IS NOT `MAX_NUDGE_BODY_CHARS` (Argus round 1, confirmed x2). The two
 * bounds guard different things and must not be the same number. The composed
 * bound asks "is this plausibly a nudge?" of text the MODEL wrote — text that has
 * already been through the composer and carries no raw intent. This bound asks a
 * strictly harder question of text the OWNER wrote for an AGENT to read: how much
 * of a private operational payload may reach the owner's chat when nothing
 * rendered it? #293's leaked fires were 3.3k and 3.4k chars, but 29% of live
 * reminder rows sit in the 1001–2000 bucket — every one of them would still have
 * posted verbatim under a single 2000-char bound, which is exactly the leak the
 * card says must NEVER happen ("NEVER the raw intent").
 *
 * 300 chars ≈ the one-to-three sentences a nudge is. "take out the trash"
 * degrading byte-identically is the DESIGNED behaviour and stays; a multi-paragraph
 * "OVERNIGHT BUILD DRIVER (wake 15) — …" does not.
 */
export const MAX_DEGRADED_INTENT_CHARS = 300

/**
 * What is posted instead when the degrade body is itself over the bound.
 *
 * It carries ZERO bytes of the stored `message` — that message reaching the
 * owner's chat IS the defect. It DOES name the reminder id, which is a
 * content-free UUID: without it a recurring over-bound reminder posts an
 * identical, unactionable sentence every fire with no way to tell which reminder
 * to go fix (Argus round 1, confirmed x2). The id is the handle the reminders
 * tab and `reminders_cancel` both take.
 */
export function overBoundNudgeBody(reminder_id: string | null): string {
  const id = (reminder_id ?? '').trim()
  const which = id.length > 0 ? `Reminder ${id}` : 'A scheduled reminder'
  return `${which} fired, but its message could not be rendered as a nudge. Open the reminders tab to read it.`
}

/**
 * The id-less refusal line — see {@link overBoundNudgeBody}. Kept as a constant
 * for callers (and tests) that have no reminder in hand.
 */
export const OVER_BOUND_NUDGE_BODY = overBoundNudgeBody(null)

/** The unbounded degrade text for a shape — see {@link literalFallbackResult}. */
function rawLiteralFallback(shape: ReminderShape): string {
  switch (shape.kind) {
    case 'literal':
      return shape.body
    case 'smart-wrap':
      return smartWrapLiteralLine(shape.instruction)
    case 'pattern':
      return patternLiteralLine(shape.block)
  }
}

/**
 * The body to post when composition did not produce one (graceful degrade), plus
 * whether the shape's own text was REFUSED for exceeding
 * {@link MAX_DEGRADED_INTENT_CHARS}. The dispatcher needs the flag to log the
 * refusal against the reminder id; every other caller wants {@link literalFallback}.
 *
 * A body at or under the bound passes through BYTE-IDENTICAL — "take out the
 * trash" degrading verbatim is the designed behaviour, not the leak. Pass the
 * reminder id so the refusal line can name which reminder went unrendered.
 */
export function literalFallbackResult(
  shape: ReminderShape,
  reminder_id: string | null = null,
): {
  body: string
  refused: boolean
} {
  const raw = rawLiteralFallback(shape)
  if (raw.length > MAX_DEGRADED_INTENT_CHARS) {
    return { body: overBoundNudgeBody(reminder_id), refused: true }
  }
  return { body: raw, refused: false }
}

/**
 * The body to post when composition did not produce one (graceful degrade).
 * Always returns something deliverable — never the raw pattern scaffolding, and
 * never more than {@link MAX_DEGRADED_INTENT_CHARS} characters of stored intent.
 */
export function literalFallback(shape: ReminderShape): string {
  return literalFallbackResult(shape).body
}
