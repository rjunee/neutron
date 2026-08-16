import { describe, expect, test } from 'bun:test'

import {
  classifyReminderMessage,
  literalFallback,
  literalFallbackResult,
  KNOWN_REMINDER_PATTERNS,
  MAX_DEGRADED_INTENT_CHARS,
  MAX_NUDGE_BODY_CHARS,
  OVER_BOUND_NUDGE_BODY,
} from './message-shape.ts'

describe('classifyReminderMessage', () => {
  test('plain text → literal', () => {
    const s = classifyReminderMessage('take out the trash')
    expect(s.kind).toBe('literal')
    if (s.kind === 'literal') expect(s.body).toBe('take out the trash')
    expect(s.routing_topic).toBeNull()
  })

  test('[smart] prefix → smart-wrap, marker stripped', () => {
    const s = classifyReminderMessage('[smart] compose a weather-aware dog walk nudge')
    expect(s.kind).toBe('smart-wrap')
    if (s.kind === 'smart-wrap') {
      expect(s.instruction).toBe('compose a weather-aware dog walk nudge')
    }
  })

  test('PATTERN: header → pattern with name + full block', () => {
    const msg = 'PATTERN: nag-until-done\nTAG: canton-fair\nGOAL: book the trip'
    const s = classifyReminderMessage(msg)
    expect(s.kind).toBe('pattern')
    if (s.kind === 'pattern') {
      expect(s.pattern).toBe('nag-until-done')
      expect(s.known).toBe(true)
      expect(s.block).toContain('GOAL: book the trip')
    }
  })

  test('unknown PATTERN name → pattern with known=false', () => {
    const s = classifyReminderMessage('PATTERN: made-up-thing\nfoo: bar')
    expect(s.kind).toBe('pattern')
    if (s.kind === 'pattern') {
      expect(s.pattern).toBe('made-up-thing')
      expect(s.known).toBe(false)
    }
  })

  test('classifies from the FIRST line only — a later PATTERN: line does not hijack a literal', () => {
    // Codex N7 blocker 2: PATTERN detection must be anchored to the leading
    // line, so arbitrary user text mentioning "PATTERN:" stays literal.
    const s = classifyReminderMessage('remind me to fix the PATTERN: parser bug\nnotes below')
    expect(s.kind).toBe('literal')
  })

  test('the [smart] sentinel wins over a PATTERN: line buried in the body', () => {
    // A smart-wrap body carries the user's original text verbatim in its tail;
    // a "PATTERN: ..." line there must NOT flip the whole thing to a pattern.
    const s = classifyReminderMessage(
      '[smart] compose a context-aware nudge\n\nOriginal reminder: first line\nPATTERN: made-up-thing\nlast line',
    )
    expect(s.kind).toBe('smart-wrap')
  })

  test('BACKWARD-COMPAT: a legacy sentinel-less smart-wrap row (old persisted bytes) still classifies as smart-wrap', () => {
    // Reminders persisted BEFORE the `[smart]` sentinel was added to the composer
    // open directly with the locked prelude and carry NO sentinel. Without legacy
    // recognition these fall through to `literal` and post the whole composition
    // instruction. This pins the old persisted format (prelude opening + the
    // `Original reminder:` tail the old composer wrote).
    const legacy =
      'Compose a smart version of this reminder using available context ' +
      '(recent project state from {{OWNER_HOME}}/Projects/<slug>/STATUS.md read ' +
      'with your Read/Glob/Grep tools, the day of week and time of day). Keep it ' +
      '1-3 sentences, action-oriented, no preamble, no em dashes. If no useful ' +
      'context is available, deliver the original message verbatim.\n\n' +
      'Original reminder: walk the dogs'
    const s = classifyReminderMessage(legacy)
    expect(s.kind).toBe('smart-wrap')
    // The no-LLM degrade posts the user's original phrase, NOT the whole prelude.
    expect(literalFallback(s)).toBe('walk the dogs')
  })

  test('a literal that merely OPENS with the prelude phrase (no Original reminder: tail) stays literal', () => {
    // Legacy recognition requires the FULL locked structure. A user body that
    // happens to start with the prelude words must NOT be promoted to an
    // authoritative composition instruction (Codex N7 legacy-breadth blocker).
    const notLegacy =
      'Compose a smart version of this reminder using available context and text me the result'
    const s = classifyReminderMessage(notLegacy)
    expect(s.kind).toBe('literal')
    if (s.kind === 'literal') expect(s.body).toBe(notLegacy)
  })

  test('the prelude opening with a malformed/empty Original reminder line stays literal', () => {
    const malformed =
      'Compose a smart version of this reminder using available context.\n\nOriginal reminder:'
    const s = classifyReminderMessage(malformed)
    expect(s.kind).toBe('literal')
  })

  test('a noncanonical prelude opening + an Original reminder: line (missing the closing phrase) stays literal', () => {
    // Codex N7 legacy-breadth boundary: opening phrase + a tail is NOT enough —
    // the frozen prelude closing phrase must also be present, so this crafted
    // literal is not promoted to an authoritative composition instruction.
    const s = classifyReminderMessage(
      'Compose a smart version of this reminder using available context and text me the result\nOriginal reminder: arbitrary note',
    )
    expect(s.kind).toBe('literal')
  })

  test('[ROUTING] header is parsed off and stripped from the body', () => {
    const msg = '[ROUTING] target_thread: 4242\ntake out the trash'
    const s = classifyReminderMessage(msg)
    expect(s.routing_topic).toBe('4242')
    expect(s.kind).toBe('literal')
    if (s.kind === 'literal') expect(s.body).toBe('take out the trash')
  })

  test('[ROUTING] header combines with a pattern body', () => {
    const msg = '[ROUTING] target_thread: proj-7\nPATTERN: daily-countdown\nEVENT: launch'
    const s = classifyReminderMessage(msg)
    expect(s.routing_topic).toBe('proj-7')
    expect(s.kind).toBe('pattern')
    if (s.kind === 'pattern') expect(s.pattern).toBe('daily-countdown')
  })

  test('[ROUTING] mid-body is NOT treated as a header', () => {
    const msg = 'do the thing\n[ROUTING] target_thread: nope'
    const s = classifyReminderMessage(msg)
    expect(s.routing_topic).toBeNull()
    expect(s.kind).toBe('literal')
  })

  test('every KNOWN pattern classifies as known', () => {
    for (const p of KNOWN_REMINDER_PATTERNS) {
      const s = classifyReminderMessage(`PATTERN: ${p}\nx: y`)
      expect(s.kind).toBe('pattern')
      if (s.kind === 'pattern') expect(s.known).toBe(true)
    }
  })
})

describe('literalFallback', () => {
  test('literal → body verbatim', () => {
    expect(literalFallback(classifyReminderMessage('walk the dogs'))).toBe('walk the dogs')
  })

  test('smart-wrap → instruction text', () => {
    expect(literalFallback(classifyReminderMessage('[smart] ping about standup'))).toBe(
      'ping about standup',
    )
  })

  test('smart-wrap with an "Original reminder:" tail → degrades to the original phrase, not the instruction', () => {
    // The Reminders Core composer persists `[smart] <prelude>\n\nOriginal
    // reminder: <body>`; the no-LLM degrade must post <body>, never the
    // composition prelude. Regression for N7 Codex blocker 1.
    const composed =
      '[smart] Compose a smart version of this reminder using available context ' +
      '(recent project state from STATUS.md, the day of week and time of day).\n\n' +
      'Original reminder: walk the dogs'
    const out = literalFallback(classifyReminderMessage(composed))
    expect(out).toBe('walk the dogs')
    expect(out).not.toContain('Compose a smart version')
  })

  test('pattern → GOAL line, FILL marker stripped, never raw scaffold', () => {
    const out = literalFallback(
      classifyReminderMessage('PATTERN: nag-until-done\nGOAL: FILL:book the Canton Fair trip'),
    )
    expect(out).toBe('book the Canton Fair trip')
    expect(out).not.toContain('PATTERN:')
  })

  test('pattern with no recognizable line → neutral degrade', () => {
    const out = literalFallback(classifyReminderMessage('PATTERN: nag-until-done\nrandom: stuff'))
    expect(out).toBe('You have a reminder due.')
  })
})

// #293 defect B: a fire whose compose step failed posted 3.4k characters of the
// owner's private operational `message` into his chat, because the degrade path
// had no bound. The degrade is still verbatim for a real reminder; what changes
// is that an over-long one is REFUSED rather than posted.
//
// The bound on the DEGRADE is `MAX_DEGRADED_INTENT_CHARS` (300), NOT the
// composed-body bound `MAX_NUDGE_BODY_CHARS` (2000) — Argus round 1, confirmed
// x2: 29% of live reminder rows sit in the 1001–2000 bucket and would have
// posted verbatim under a single 2000-char bound, which is the leak the card
// says must NEVER happen.
describe('literalFallback — MAX_DEGRADED_INTENT_CHARS bound', () => {
  test('a short literal degrades byte-identically — the designed behaviour', () => {
    expect(literalFallback(classifyReminderMessage('take out the trash'))).toBe(
      'take out the trash',
    )
  })

  test('a fallback of exactly MAX_DEGRADED_INTENT_CHARS passes verbatim; one char more is refused', () => {
    const at_bound = 'x'.repeat(MAX_DEGRADED_INTENT_CHARS)
    const at = literalFallbackResult(classifyReminderMessage(at_bound))
    expect(at.refused).toBe(false)
    expect(at.body).toBe(at_bound)

    const over = literalFallbackResult(
      classifyReminderMessage('x'.repeat(MAX_DEGRADED_INTENT_CHARS + 1)),
    )
    expect(over.refused).toBe(true)
    expect(over.body).toBe(OVER_BOUND_NUDGE_BODY)
  })

  // THE REGRESSION THE ROUND-1 BOUND MISSED. A 1,900-char private intent is
  // under the composed-body bound and was posted verbatim; it is the modal
  // shape of the leaked rows, not an outlier.
  test('a 1900-char intent — under MAX_NUDGE_BODY_CHARS — is still refused', () => {
    const intent = `LEAK_MARKER_XYZ `.repeat(119)
    expect(intent.length).toBeGreaterThan(MAX_DEGRADED_INTENT_CHARS)
    expect(intent.length).toBeLessThan(MAX_NUDGE_BODY_CHARS)
    const out = literalFallback(classifyReminderMessage(intent))
    expect(out).not.toContain('LEAK_MARKER_XYZ')
    expect(out).toBe(OVER_BOUND_NUDGE_BODY)
  })

  test('an over-bound literal degrades to the generic line, carrying none of the intent', () => {
    const intent = `LEAK_MARKER_XYZ `.repeat(200)
    expect(intent.length).toBeGreaterThan(MAX_NUDGE_BODY_CHARS)
    const out = literalFallback(classifyReminderMessage(intent))
    expect(out).not.toContain('LEAK_MARKER_XYZ')
    expect(out).toBe(OVER_BOUND_NUDGE_BODY)
    expect(out.length).toBeLessThanOrEqual(MAX_DEGRADED_INTENT_CHARS)
  })

  test('an over-bound smart-wrap "Original reminder:" tail is refused too', () => {
    const intent =
      '[smart] Compose a smart version of this reminder using available context.\n\n' +
      `Original reminder: ${'LEAK_MARKER_XYZ '.repeat(200)}`
    const out = literalFallback(classifyReminderMessage(intent))
    expect(out).toBe(OVER_BOUND_NUDGE_BODY)
    expect(out).not.toContain('LEAK_MARKER_XYZ')
  })

  // The refusal line NAMES THE REMINDER (Argus round 1, confirmed x2): a
  // recurring over-bound reminder that posts an identical, id-free sentence
  // every fire is unactionable. The id is a content-free UUID.
  test('the refusal line names the reminder id and still carries no intent bytes', () => {
    const out = literalFallbackResult(
      classifyReminderMessage(`LEAK_MARKER_XYZ `.repeat(200)),
      'rem-9f3c',
    )
    expect(out.refused).toBe(true)
    expect(out.body).toContain('rem-9f3c')
    expect(out.body).not.toContain('LEAK_MARKER_XYZ')
    expect(out.body.length).toBeLessThanOrEqual(MAX_DEGRADED_INTENT_CHARS)
  })
})

// CodeQL `js/polynomial-redos` (HIGH) on the `Original reminder:` extraction —
// `/(?:^|\n)Original reminder:\s*([\s\S]+?)\s*$/i` is quadratic on a marker
// followed by many spaces, and a stored `message` is caller-authored text run on
// the tick loop. The replacement is a single forward scan; these pin BOTH that
// the semantics survived and that the pathological input is now linear.
describe('smart-wrap "Original reminder:" extraction is linear', () => {
  test('the payload is still the trimmed tail after the FIRST line-initial marker', () => {
    const shape = classifyReminderMessage(
      '[smart] compose something\n\nOriginal reminder:   walk the dogs   ',
    )
    expect(literalFallback(shape)).toBe('walk the dogs')
  })

  test('a marker mid-line is prose, not the composer tail', () => {
    const shape = classifyReminderMessage('[smart] the Original reminder: was lost')
    expect(literalFallback(shape)).toBe('the Original reminder: was lost')
  })

  test('a whitespace-only payload falls back to the whole instruction', () => {
    const shape = classifyReminderMessage('[smart] do the thing\nOriginal reminder:    ')
    expect(literalFallback(shape)).toBe('do the thing\nOriginal reminder:')
  })

  test('the old quadratic input resolves promptly', () => {
    const evil = `Original reminder:${' '.repeat(60_000)}`
    const started = Date.now()
    literalFallback(classifyReminderMessage(`[smart] x\n${evil}`))
    // WALL-CLOCK-BOUND-OK: this pins a ReDoS fix, and "does not backtrack
    // super-linearly" has no deterministic surrogate — the scan and the regex
    // return the SAME string, so only cost distinguishes them. The margin is not
    // marginal: the linear scan is sub-millisecond, while the regex this replaced
    // is O(n^2) over a 60,000-space run (~3.6e9 backtracks, minutes). A 5 s
    // threshold is >1000x the observed time and cannot redden from runner load.
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
