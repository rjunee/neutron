/**
 * output-scan.test.ts — F3: the output-scan detector framework. Each test pins
 * one of the four Vajra invariants baked into the scanner (each encodes a
 * paid-for production incident):
 *   1. edge-triggered LATCHED alerting (fire on rising edge only)
 *   2. doc-quote guards (inline-backtick / fenced / diff / bullet)
 *   3. bottom-N positional guards
 *   4. per-detector debounce stamped BEFORE the await (fire-once on retry)
 */

import { describe, expect, test } from 'bun:test'
import { OutputScanner, stripDocQuotes, DEFAULT_BOTTOM_N } from '../output-scan.ts'

/** A detector that fires `keys` when `needle` appears in the normalized view. */
function sigDetector(id: string, needle: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    present: (ctx: { normalized: string }) => ctx.normalized.includes(needle),
    keys: ['enter'] as const,
    ...extra,
  }
}

describe('OutputScanner — edge-triggered latch (invariant §1)', () => {
  test('fires once on the rising edge, holds while present, re-arms after absent', () => {
    const s = new OutputScanner()
    s.register(sigDetector('d', 'SIGNAL'))

    // Rising edge → fire.
    expect(s.scan('a wild SIGNAL appears', 0).map((f) => f.id)).toEqual(['d'])
    // Still present → latched, no re-fire (the "hourly re-fire on stale banner"
    // bug a pure time-dedupe would reproduce).
    expect(s.scan('a wild SIGNAL appears', 1).length).toBe(0)
    // Falling edge clears the latch (no fire on the clear itself).
    expect(s.scan('nothing here', 2).length).toBe(0)
    // Rising edge again → fires.
    expect(s.scan('SIGNAL is back', 3).map((f) => f.id)).toEqual(['d'])
  })

  test('a fired detection carries its keystroke action', () => {
    const s = new OutputScanner()
    s.register(sigDetector('approve', 'PROCEED'))
    const fired = s.scan('do you want to PROCEED', 0)
    expect(fired).toHaveLength(1)
    expect(fired[0]?.keys).toEqual(['enter'])
  })
})

describe('OutputScanner — fire-once / debounce-before-await (invariant §4)', () => {
  test('a retry with identical input does NOT re-fire (state committed in scan)', () => {
    const s = new OutputScanner()
    s.register(sigDetector('d', 'X'))
    // First scan fires AND commits the latch before returning, so a caller whose
    // keystroke write throws cannot re-fire on the next identical tick.
    expect(s.scan('X', 0).length).toBe(1)
    expect(s.scan('X', 0).length).toBe(0)
    expect(s.scan('X', 0).length).toBe(0)
  })

  test('debounceMs is a time floor on top of the latch', () => {
    const s = new OutputScanner()
    s.register(sigDetector('d', 'X', { debounceMs: 1000 }))
    expect(s.scan('X', 0).length).toBe(1) // fire @0
    expect(s.scan('-', 500).length).toBe(0) // falling edge clears latch
    // Rising edge @600 but within the 1000ms floor → suppressed.
    expect(s.scan('X', 600).length).toBe(0)
    expect(s.scan('-', 1200).length).toBe(0) // falling edge again
    // Rising edge @1300, now past the floor → fires.
    expect(s.scan('X', 1300).length).toBe(1)
  })
})

describe('stripDocQuotes — doc-quote guards (invariant §2)', () => {
  test('drops fenced-block lines', () => {
    const lines = ['live footer', '```', 'Do you want to proceed', '```', 'after']
    expect(stripDocQuotes(lines)).toEqual(['live footer', 'after'])
  })

  test('drops diff / blockquote / bullet lines', () => {
    expect(stripDocQuotes(['+ added', '> quoted', '- bullet', '* bullet2', 'kept'])).toEqual([
      'kept',
    ])
  })

  test('drops BARE diff add/delete markers (no trailing space)', () => {
    // Unified-diff deletion: `-Do you want to proceed` (Codex P2). A bare `-`/`+`
    // diff marker must not read as live chrome.
    expect(stripDocQuotes(['-Do you want to proceed', '+Yes please', '>quote', 'kept'])).toEqual([
      'kept',
    ])
  })

  test('blanks inline-backtick spans so a wrapped signature cannot match', () => {
    const [line] = stripDocQuotes(['press `1. Yes` to confirm'])
    expect(line).not.toContain('1. Yes')
    expect(line).toContain('press')
    expect(line).toContain('to confirm')
  })
})

describe('OutputScanner — doc-quote integration', () => {
  test('a backtick-quoted menu does NOT fire; live chrome does', () => {
    const s = new OutputScanner()
    s.register(sigDetector('approve', 'Doyouwanttoproceed'))
    // Quoted in docs/help text → guarded out.
    expect(s.scan('the prompt asks `Do you want to proceed`', 0).length).toBe(0)
    // Live terminal chrome → fires.
    expect(s.scan('Do you want to proceed\n❯ 1. Yes', 1).map((f) => f.id)).toEqual(['approve'])
  })

  test('a fenced example of the signature does NOT fire', () => {
    const s = new OutputScanner()
    s.register(sigDetector('rl', 'Stopandwaitforlimittoreset'))
    const fenced = 'docs:\n```\nStop and wait for limit to reset\n```\nend'
    expect(s.scan(fenced, 0).length).toBe(0)
  })
})

describe('OutputScanner — bottom-N positional guard (invariant §3)', () => {
  test('default window is the widened bottom-24', () => {
    expect(DEFAULT_BOTTOM_N).toBe(24)
  })

  test('a signature above the bottom-N window is not seen; within it fires', () => {
    const s = new OutputScanner()
    s.register({ ...sigDetector('d', 'NEEDLE'), bottomN: 3 })
    const above = ['NEEDLE', 'l2', 'l3', 'l4', 'l5'].join('\n')
    expect(s.scan(above, 0).length).toBe(0)
    const within = ['l1', 'l2', 'l3', 'NEEDLE', 'l5'].join('\n')
    expect(s.scan(within, 1).map((f) => f.id)).toEqual(['d'])
  })
})

describe('OutputScanner — registration', () => {
  test('independent detectors fire independently in one scan', () => {
    const s = new OutputScanner()
    s.register(sigDetector('a', 'AAA'))
    s.register(sigDetector('b', 'BBB'))
    expect(s.size).toBe(2)
    expect(s.scan('AAA and BBB', 0).map((f) => f.id).sort()).toEqual(['a', 'b'])
  })

  test('a duplicate detector id throws (wiring bug)', () => {
    const s = new OutputScanner()
    s.register(sigDetector('dup', 'X'))
    expect(() => s.register(sigDetector('dup', 'Y'))).toThrow(/duplicate detector id/)
  })

  test('P1 tool-use-approve: BOTH cues fire 1+enter; single cue does NOT; debounce stamped before await', () => {
    // Mirrors the substrate registration (port row #2): question + `❯ 1. Yes`
    // selector, both matched on the normalized (whitespace-stripped) view.
    const QUESTION = /doyouwantto(makethisedit|proceed|runthiscommand|create)/i
    const SELECTOR = /❯1\.yes/i
    const s = new OutputScanner()
    s.register({
      id: 'tool-use-approve',
      debounceMs: 5000,
      present: (ctx: { normalized: string }) =>
        QUESTION.test(ctx.normalized) && SELECTOR.test(ctx.normalized),
      keys: ['1', 'enter'] as const,
    })

    // BOTH cues present (Ink shreds the question across cursor moves) → fires
    // `1`+`enter`.
    const live = 'Do you\x1b[8G want to\x1b[16G proceed?\n❯ 1. Yes\n  2. No'
    const fired = s.scan(live, 0)
    expect(fired.map((f) => f.id)).toEqual(['tool-use-approve'])
    expect(fired[0]?.keys).toEqual(['1', 'enter'])

    // Single cue only — selector with no question (lingering scrollback) does
    // NOT fire; question with no selector also does NOT fire.
    const s2 = new OutputScanner()
    s2.register({
      id: 'tool-use-approve',
      present: (ctx: { normalized: string }) =>
        QUESTION.test(ctx.normalized) && SELECTOR.test(ctx.normalized),
      keys: ['1', 'enter'] as const,
    })
    expect(s2.scan('some output\n❯ 1. Yes\n  2. No', 0).length).toBe(0)
    expect(s2.scan('Do you want to proceed with the plan', 1).length).toBe(0)

    // Debounce stamped BEFORE return → a retry on the same frame (caller's
    // keystroke write threw) does NOT re-fire and double-Enter, and a re-arm
    // within 5s is suppressed by the floor.
    expect(s.scan(live, 1).length).toBe(0) // latched, identical frame
    expect(s.scan('idle prompt', 2).length).toBe(0) // falling edge clears latch
    expect(s.scan(live, 2000).length).toBe(0) // rising edge but within 5s floor
    expect(s.scan('idle prompt', 6000).length).toBe(0) // falling edge again
    expect(s.scan(live, 6001).map((f) => f.id)).toEqual(['tool-use-approve']) // past floor
  })

  test('P1 rate-limit-options-stop: both cues in bottom-N fire 3+enter; doc-quoted slash does NOT', () => {
    // Mirrors the substrate registration (port row #4): the `/rate-limit-options`
    // slash command name AND option 3's verbatim `Stop and wait for limit to
    // reset`, both matched on the normalized (whitespace-stripped) view, within
    // the bottom-30 window. `3`+`enter` selects "Stop and wait" (position-
    // independent). Ryan 2026-05-23 directive.
    const OPTIONS = /\/rate-limit-options/i
    const STOP = /stopandwaitforlimittoreset/i
    const mk = () => {
      const s = new OutputScanner()
      s.register({
        id: 'rate-limit-options-stop',
        bottomN: 30,
        debounceMs: 60_000,
        present: (ctx: { normalized: string }) => OPTIONS.test(ctx.normalized) && STOP.test(ctx.normalized),
        keys: ['3', 'enter'] as const,
      })
      return s
    }

    // BOTH cues present (Ink shreds the picker across cursor moves) → fires
    // `3`+`enter`.
    const live =
      'You[8G hit your[16G org limit\n/rate-limit-options\n  1. Upgrade\n  2. Switch model\n❯ 3. Stop and wait for limit to reset'
    const fired = mk().scan(live, 0)
    expect(fired.map((f) => f.id)).toEqual(['rate-limit-options-stop'])
    expect(fired[0]?.keys).toEqual(['3', 'enter'])

    // A doc-quote of the slash command (the option-3 line still present, e.g. a
    // brief or this very PR) does NOT fire: stripDocQuotes blanks the inline-
    // backtick span so `/rate-limit-options` never reaches the normalized view.
    const quoted =
      'CC injects the `/rate-limit-options` picker; we auto-press\nStop and wait for limit to reset (option 3).'
    expect(mk().scan(quoted, 0).length).toBe(0)
    // Fenced quote of both cues also does NOT fire (whole block dropped).
    const fenced = '```\n/rate-limit-options\nStop and wait for limit to reset\n```'
    expect(mk().scan(fenced, 0).length).toBe(0)

    // Single cue only — slash command with no option-3 text (a conversational
    // mention) does NOT fire.
    expect(mk().scan('run /rate-limit-options to see your usage', 0).length).toBe(0)

    // Fire-once: debounce stamped BEFORE return, so an identical next frame is
    // latched and a re-arm within 60s is suppressed by the floor.
    const s = mk()
    expect(s.scan(live, 0).length).toBe(1) // rising edge fires
    expect(s.scan(live, 1).length).toBe(0) // latched, identical frame
    expect(s.scan('idle prompt', 2).length).toBe(0) // falling edge clears latch
    expect(s.scan(live, 30_000).length).toBe(0) // rising edge but within 60s floor
    expect(s.scan('idle prompt', 61_000).length).toBe(0) // falling edge again
    expect(s.scan(live, 61_001).map((f) => f.id)).toEqual(['rate-limit-options-stop']) // past floor
  })

  test('the disclaimer-style detector: a single Enter on the rising edge', () => {
    const s = new OutputScanner()
    s.register({
      id: 'disclaimer',
      bottomN: 200,
      present: (ctx) => /usingthisforlocaldevelopment/i.test(ctx.normalized),
      keys: ['enter'] as const,
    })
    // Ink renders the phrase shredded by cursor-move escapes + whitespace.
    const frame = 'Are you\x1b[3G using\x1b[9G this\x1b[14G for local\ndevelopment?'
    const fired = s.scan(frame, 0)
    expect(fired).toHaveLength(1)
    expect(fired[0]?.keys).toEqual(['enter'])
    // Already dismissed → no second Enter.
    expect(s.scan(frame, 1).length).toBe(0)
  })

  test('P1 compact-resume-picker: exact label fires down+enter; normal conversation does NOT', () => {
    // Mirrors the substrate registration (port row #3): EXACT-STRING match on
    // one of the two literal picker labels, action `down`+`enter` (arrow-driven,
    // never a digit). Matched on the normalized (whitespace-stripped) view.
    const SUMMARY = /resumefromsummary\(recommended\)/i
    const FULL = /resumefullsessionas-is/i
    const register = (sc: OutputScanner) =>
      sc.register({
        id: 'compact-resume-picker',
        debounceMs: 5000,
        present: (ctx: { normalized: string }) =>
          SUMMARY.test(ctx.normalized) || FULL.test(ctx.normalized),
        keys: ['down', 'enter'] as const,
      })

    // The picker frame (Ink shreds each word across cursor moves) → fires
    // `down`+`enter`, NOT a number-key.
    const s = new OutputScanner()
    register(s)
    const picker =
      'Resume\x1b[8G from\x1b[16G summary\x1b[24G (recommended)\n  Resume full session as-is'
    const fired = s.scan(picker, 0)
    expect(fired.map((f) => f.id)).toEqual(['compact-resume-picker'])
    expect(fired[0]?.keys).toEqual(['down', 'enter'])

    // The full-session label alone also fires (either exact label is sufficient).
    const s2 = new OutputScanner()
    register(s2)
    expect(s2.scan('Resume full session as-is', 0).map((f) => f.id)).toEqual([
      'compact-resume-picker',
    ])

    // NORMAL CONVERSATION must NOT fire — the lesson that motivates the
    // exact-string match. Prose merely mentioning "resume", "summary", "full
    // session", or numbered options does not trip the detector.
    const s3 = new OutputScanner()
    register(s3)
    expect(s3.scan('Let me resume the session and write a summary of the full plan.', 0).length).toBe(
      0,
    )
    expect(s3.scan('1. summary  2. full session  3. resume', 1).length).toBe(0)

    // Debounce stamped BEFORE return → a same-frame retry does NOT re-fire (no
    // double down+enter), a re-arm within 5s is suppressed, past the floor fires.
    expect(s.scan(picker, 1).length).toBe(0) // latched, identical frame
    expect(s.scan('idle prompt', 2).length).toBe(0) // falling edge clears latch
    expect(s.scan(picker, 2000).length).toBe(0) // rising edge but within 5s floor
    expect(s.scan('idle prompt', 6000).length).toBe(0) // falling edge again
    expect(s.scan(picker, 6001).map((f) => f.id)).toEqual(['compact-resume-picker']) // past floor
  })
})
