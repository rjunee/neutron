/**
 * @neutronai/reminders — fire-time message-shape classifier.
 *
 * Ported from Vajra's reminder grammar (`prompts/reminder-agent-base.md` +
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
 * A leading `[ROUTING] target_thread: <id>` header (Vajra parity) is parsed
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
// prelude and carry NO sentinel. Recognize that distinctive prelude opening so
// a row stored under the old format is still classified as `smart-wrap` (and
// degrades via its `Original reminder:` tail) instead of falling through to
// `literal` and posting the whole composition instruction. Keep this in sync
// with `SMART_WRAP_PRELUDE`'s opening line in `cores/free/reminders/src/smart-wrap.ts`.
const LEGACY_SMART_PRELUDE_RE = /^\s*Compose a smart version of this reminder using available context/i
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

  // Legacy (pre-sentinel) smart-wrap row: the body opens with the locked prelude
  // and has no `[smart]` to strip, so the whole body IS the instruction.
  if (LEGACY_SMART_PRELUDE_RE.test(firstLine)) {
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
 */
const ORIGINAL_REMINDER_RE = /(?:^|\n)Original reminder:\s*([\s\S]+?)\s*$/i
function smartWrapLiteralLine(instruction: string): string {
  const m = ORIGINAL_REMINDER_RE.exec(instruction)
  const original = (m?.[1] ?? '').trim()
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
 * The body to post when no LLM substrate is available (graceful degrade).
 * Always returns something deliverable — never the raw pattern scaffolding.
 */
export function literalFallback(shape: ReminderShape): string {
  switch (shape.kind) {
    case 'literal':
      return shape.body
    case 'smart-wrap':
      return smartWrapLiteralLine(shape.instruction)
    case 'pattern':
      return patternLiteralLine(shape.block)
  }
}
