/**
 * wedged-prompt-detector.test.ts — P0: WEDGED-INTERACTIVE-PROMPT detect + recover
 * (master-table row #1). Each test pins a ported Vajra gate / lesson:
 *   • the detector FIRES on a synthetic AskUserQuestion frame with ALL gates
 *     (footer + live `^❯` cursor) — but only after the 2-tick stability gate;
 *   • a doc-quoted (fenced / `>`-quoted / backtick) menu does NOT fire;
 *   • the recovery ladder escapes→escapes→ctrl-c WITH a verify re-read between
 *     each, clears as soon as the menu drops, and NEVER auto-picks (no digit /
 *     Enter ever leaves the keyboard);
 *   • a FAILED re-capture (`null`) counts as NOT-cleared so it keeps escalating;
 *   • a persistent block surfaces the question to chat + fires ONE operator alert.
 */

import { describe, expect, test } from 'bun:test'
import {
  isWedgedInteractivePrompt,
  createWedgedPromptDetector,
  wedgeSignaturePresent,
  runWedgedRecovery,
  extractWedgeQuestion,
  WEDGE_BOTTOM_N,
  WEDGED_PROMPT_DETECTOR_ID,
  type WedgeRecoveryDeps,
} from '../wedged-prompt-detector.ts'
import { buildDetectorContext } from '../output-scan.ts'
import type { Key } from '../keystrokes.ts'

/** Build a synthetic AskUserQuestion / arrow-menu PTY frame: some scrollback,
 *  the question, numbered options with a live `❯` cursor on the first, and the
 *  footer. `opts` lets a test break exactly one gate. */
function askMenuFrame(opts: {
  scrollback?: number
  withCursor?: boolean
  footer?: string
  question?: string
  normalChrome?: boolean
} = {}): string {
  const scrollback = opts.scrollback ?? 6
  const lines: string[] = []
  for (let i = 0; i < scrollback; i++) lines.push(`prior output line ${i}`)
  lines.push(opts.question ?? 'Which approach should I take for the migration?')
  lines.push('')
  lines.push(opts.withCursor === false ? '  1. Use a backfill script' : '❯ 1. Use a backfill script')
  lines.push('  2. Rename the column in place')
  lines.push('  3. Add a new table')
  lines.push('')
  if (opts.normalChrome === true) lines.push('  ⏵⏵ bypass permissions on   esc to interrupt   ? for shortcuts')
  lines.push(opts.footer ?? '↑/↓ to navigate · enter to select · esc to cancel')
  return lines.join('\n')
}

function ctxOf(frame: string) {
  return buildDetectorContext(frame, WEDGE_BOTTOM_N, 0)
}

describe('isWedgedInteractivePrompt — gates', () => {
  test('fires on a full AskUserQuestion frame (footer + live ^❯ cursor)', () => {
    expect(isWedgedInteractivePrompt(ctxOf(askMenuFrame()))).toBe(true)
  })

  test('no live ^❯ cursor → not wedged (gate b)', () => {
    expect(isWedgedInteractivePrompt(ctxOf(askMenuFrame({ withCursor: false })))).toBe(false)
  })

  test('missing a footer phrase → not wedged (gate a)', () => {
    // Drop "to navigate" from the footer.
    expect(
      isWedgedInteractivePrompt(ctxOf(askMenuFrame({ footer: 'enter to select · esc to cancel' }))),
    ).toBe(false)
  })

  test('normal live/working chrome present → not wedged (gate 0)', () => {
    expect(isWedgedInteractivePrompt(ctxOf(askMenuFrame({ normalChrome: true })))).toBe(false)
  })

  test('footer with no menu at all → not wedged', () => {
    expect(isWedgedInteractivePrompt(ctxOf('just some text\nand more text'))).toBe(false)
  })

  test('cursor too far above the footer (>30 lines) → not wedged (positional)', () => {
    // 40 lines of menu body between the cursor and the footer pushes the cursor
    // outside the 30-line look-back.
    const lines = ['❯ 1. Yes']
    for (let i = 0; i < 40; i++) lines.push(`filler ${i}`)
    lines.push('↑/↓ to navigate · enter to select · esc to cancel')
    expect(isWedgedInteractivePrompt(ctxOf(lines.join('\n')))).toBe(false)
  })
})

describe('isWedgedInteractivePrompt — doc-quote guard (a quoted menu must NOT fire)', () => {
  test('a fenced code block containing the menu does not fire', () => {
    const frame = [
      'Here is what a menu looks like:',
      '```',
      '❯ 1. Use a backfill script',
      '  2. Rename the column',
      '↑/↓ to navigate · enter to select · esc to cancel',
      '```',
      'end of example',
    ].join('\n')
    expect(isWedgedInteractivePrompt(ctxOf(frame))).toBe(false)
  })

  test('a `>`-blockquoted menu does not fire', () => {
    const frame = [
      '> ❯ 1. Use a backfill script',
      '>   2. Rename the column',
      '> ↑/↓ to navigate · enter to select · esc to cancel',
    ].join('\n')
    expect(isWedgedInteractivePrompt(ctxOf(frame))).toBe(false)
  })

  test('an inline-backtick-wrapped cursor line does not fire', () => {
    const frame = [
      'the cursor renders as `❯ 1.` at the start of the selected option',
      '  2. another option',
      '↑/↓ to navigate · enter to select · esc to cancel',
    ].join('\n')
    expect(isWedgedInteractivePrompt(ctxOf(frame))).toBe(false)
  })
})

describe('createWedgedPromptDetector — 2-tick stability gate (gate c)', () => {
  test('does NOT fire on the first tick; fires on the second consecutive tick', () => {
    const det = createWedgedPromptDetector()
    expect(det.id).toBe(WEDGED_PROMPT_DETECTOR_ID)
    const ctx = ctxOf(askMenuFrame())
    // First observation: present but unstable → false.
    expect(det.present(ctx)).toBe(false)
    // Second consecutive observation → fires.
    expect(det.present(ctx)).toBe(true)
  })

  test('a one-tick flash (present then absent) never fires', () => {
    const det = createWedgedPromptDetector()
    expect(det.present(ctxOf(askMenuFrame()))).toBe(false)
    expect(det.present(ctxOf('back to normal output'))).toBe(false)
    // Re-arming: needs two consecutive present ticks again.
    expect(det.present(ctxOf(askMenuFrame()))).toBe(false)
    expect(det.present(ctxOf(askMenuFrame()))).toBe(true)
  })

  test('the registered detector carries NO keys (recovery is the verify ladder)', () => {
    expect(createWedgedPromptDetector().keys).toBeUndefined()
  })
})

/** A recording fake of the recovery's injected effects. `ringScript` is read
 *  one entry per `readRing()` call; a `null` entry models a failed re-capture. */
function fakeDeps(ringScript: Array<string | null>): {
  deps: WedgeRecoveryDeps
  keysSent: Key[]
  surfaced: string[]
  alerts: string[]
} {
  const keysSent: Key[] = []
  const surfaced: string[] = []
  const alerts: string[] = []
  let i = 0
  const deps: WedgeRecoveryDeps = {
    writeKey: (k) => keysSent.push(k),
    readRing: () => ringScript[Math.min(i++, ringScript.length - 1)] ?? null,
    delay: async () => {},
    surface: (q) => surfaced.push(q),
    alert: (t) => alerts.push(t),
    now: () => 0,
    verifyDelayMs: 0,
  }
  return { deps, keysSent, surfaced, alerts }
}

const WEDGED = askMenuFrame()
const CLEARED = 'turn resumed, normal output here'

describe('runWedgedRecovery — escape/ctrl-c ladder with verify', () => {
  test('first escape clears it → cleared by escape, only one key sent', async () => {
    const { deps, keysSent, surfaced, alerts } = fakeDeps([CLEARED])
    const res = await runWedgedRecovery(deps)
    expect(res.outcome).toBe('cleared')
    expect(res.clearedBy).toBe('escape')
    expect(keysSent).toEqual(['escape'])
    expect(surfaced).toHaveLength(0)
    expect(alerts).toHaveLength(0)
  })

  test('escalates escape→escape→ctrl-c when the menu persists, clears on ctrl-c', async () => {
    // wedged after escape #1, wedged after escape #2, cleared after ctrl-c.
    const { deps, keysSent } = fakeDeps([WEDGED, WEDGED, CLEARED])
    const res = await runWedgedRecovery(deps)
    expect(res.outcome).toBe('cleared')
    expect(res.clearedBy).toBe('ctrl-c')
    expect(keysSent).toEqual(['escape', 'escape', 'ctrl-c'])
  })

  test('a FAILED re-capture (null) counts as NOT-cleared and keeps escalating', async () => {
    // null after escape #1 (not-cleared), null after escape #2, cleared on ctrl-c.
    const { deps, keysSent } = fakeDeps([null, null, CLEARED])
    const res = await runWedgedRecovery(deps)
    expect(res.outcome).toBe('cleared')
    expect(res.clearedBy).toBe('ctrl-c')
    expect(keysSent).toEqual(['escape', 'escape', 'ctrl-c'])
  })

  test('persistent block → surfaces the question to chat + ONE operator alert', async () => {
    const { deps, keysSent, surfaced, alerts } = fakeDeps([WEDGED, WEDGED, WEDGED, WEDGED])
    const res = await runWedgedRecovery(deps)
    expect(res.outcome).toBe('blocked')
    expect(keysSent).toEqual(['escape', 'escape', 'ctrl-c'])
    expect(surfaced).toHaveLength(1)
    expect(surfaced[0]).toContain('to navigate')
    expect(alerts).toHaveLength(1)
  })

  test('NEVER auto-picks: no digit or Enter is ever sent, in any outcome', async () => {
    for (const script of [[CLEARED], [WEDGED, CLEARED], [WEDGED, WEDGED, WEDGED]]) {
      const { deps, keysSent } = fakeDeps(script)
      await runWedgedRecovery(deps)
      for (const k of keysSent) {
        expect(k === 'enter').toBe(false)
        expect(/^[0-9]$/.test(k)).toBe(false)
      }
    }
  })
})

describe('wedgeSignaturePresent / extractWedgeQuestion helpers', () => {
  test('wedgeSignaturePresent is true on a wedged frame, false once cleared', () => {
    expect(wedgeSignaturePresent(WEDGED)).toBe(true)
    expect(wedgeSignaturePresent(CLEARED)).toBe(false)
  })

  test('extractWedgeQuestion returns the menu text (footer + options) for chat', () => {
    const q = extractWedgeQuestion(WEDGED)
    expect(q).toContain('to navigate')
    expect(q).toContain('1. Use a backfill script')
  })
})
