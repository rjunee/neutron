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
})
