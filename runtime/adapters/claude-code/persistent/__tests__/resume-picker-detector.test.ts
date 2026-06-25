/**
 * resume-picker-detector.test.ts — P2: RESUME-SESSION-FAILURE picker safety net
 * (master-table row #7). Each test pins a ported Vajra invariant:
 *   • the detector FIRES on a synthetic "Resume Session" picker frame (title +
 *     footer) and re-arms via the framework edge-latch (fire once, clear on
 *     absent);
 *   • a doc-quoted (fenced / `>`-quoted / backtick) picker does NOT fire;
 *   • the AskUserQuestion menu (esc to CANCEL) does NOT fire this detector (no
 *     collision with detector #1);
 *   • recovery ESCAPES-THEN-RECOVERS — sends exactly one Escape (never a digit /
 *     Enter), then scans disk: a hit surfaces a "recovered" notice + requestResume;
 *     a miss surfaces a "session lost" notice + alert.
 */

import { describe, expect, test } from 'bun:test'
import {
  isResumeSessionPicker,
  createResumePickerDetector,
  resumePickerPresent,
  runResumePickerRecovery,
  extractResumePicker,
  RESUME_PICKER_BOTTOM_N,
  RESUME_PICKER_DETECTOR_ID,
  type ResumePickerRecoveryDeps,
} from '../resume-picker-detector.ts'
import { OutputScanner } from '../output-scan.ts'
import { buildDetectorContext } from '../output-scan.ts'
import type { Key } from '../keystrokes.ts'

/** Build a synthetic CC "Resume Session" picker frame: some scrollback, the
 *  title, a couple of recent-session rows with a live cursor, and the picker
 *  footer (`Enter to select` + `Esc to clear`). `opts` breaks exactly one gate. */
function resumePickerFrame(opts: {
  scrollback?: number
  title?: string
  footer?: string
} = {}): string {
  const scrollback = opts.scrollback ?? 4
  const lines: string[] = []
  for (let i = 0; i < scrollback; i++) lines.push(`prior output line ${i}`)
  lines.push(opts.title ?? 'Resume Session')
  lines.push('')
  lines.push('❯ 1. 2026-06-24 14:02   Add the resume picker safety net')
  lines.push('  2. 2026-06-23 09:11   Port the compact-resume picker')
  lines.push('  3. 2026-06-22 17:40   Wire the output-scan tick')
  lines.push('')
  lines.push(opts.footer ?? '↑/↓ to navigate · Enter to select · Esc to clear')
  return lines.join('\n')
}

function ctxOf(frame: string) {
  return buildDetectorContext(frame, RESUME_PICKER_BOTTOM_N, 0)
}

describe('isResumeSessionPicker — gates', () => {
  test('fires on a full Resume Session picker (title + footer)', () => {
    expect(isResumeSessionPicker(ctxOf(resumePickerFrame()))).toBe(true)
  })

  test('missing the "Resume Session" title → not the picker', () => {
    expect(isResumeSessionPicker(ctxOf(resumePickerFrame({ title: 'Pick something' })))).toBe(false)
  })

  test('title present but no picker footer cue → not the picker', () => {
    expect(
      isResumeSessionPicker(ctxOf(resumePickerFrame({ footer: 'press any key to continue' }))),
    ).toBe(false)
  })

  test('title + only `Enter to select` (no `Esc to clear`) → NOT the picker (Codex P2)', () => {
    // `Enter to select` is shared with the AskUserQuestion footer, so the
    // distinctive `Esc to clear` is REQUIRED — `Enter to select` alone must not fire.
    expect(
      isResumeSessionPicker(ctxOf(resumePickerFrame({ footer: '↑/↓ to navigate · Enter to select' }))),
    ).toBe(false)
  })

  test('a live AskUserQuestion whose TITLE contains "Resume Session" but footer is `esc to cancel` does NOT fire (Codex P2 collision)', () => {
    // The exact collision Codex flagged: a normal user-choice prompt about resuming
    // a session, with the AskUserQuestion `Enter to select · Esc to cancel` footer.
    // Requiring `Esc to clear` keeps detector #1 the sole handler here.
    const askMenu = [
      'Resume Session — which one do you want?',
      '❯ 1. yesterday’s migration session',
      '  2. start fresh',
      '↑/↓ to navigate · Enter to select · Esc to cancel',
    ].join('\n')
    expect(isResumeSessionPicker(ctxOf(askMenu))).toBe(false)
  })

  test('the AskUserQuestion menu (esc to cancel, no title) does NOT fire this detector', () => {
    // Detector #1's footer is `esc to cancel`, not `esc to clear`, and it has no
    // "Resume Session" title — so the resume-picker detector ignores it entirely.
    const askMenu = [
      'Which approach should I take?',
      '❯ 1. Use a backfill script',
      '  2. Rename the column in place',
      '↑/↓ to navigate · enter to select · esc to cancel',
    ].join('\n')
    expect(isResumeSessionPicker(ctxOf(askMenu))).toBe(false)
  })
})

describe('isResumeSessionPicker — doc-quote guard (a quoted picker must NOT fire)', () => {
  test('a fenced code block containing the picker does not fire', () => {
    const frame = [
      'Here is what the resume picker looks like:',
      '```',
      'Resume Session',
      '❯ 1. 2026-06-24 14:02   some session',
      '↑/↓ to navigate · Enter to select · Esc to clear',
      '```',
      'end of example',
    ].join('\n')
    expect(isResumeSessionPicker(ctxOf(frame))).toBe(false)
  })

  test('a `>`-blockquoted picker does not fire', () => {
    const frame = [
      '> Resume Session',
      '> ❯ 1. 2026-06-24 14:02   some session',
      '> ↑/↓ to navigate · Enter to select · Esc to clear',
    ].join('\n')
    expect(isResumeSessionPicker(ctxOf(frame))).toBe(false)
  })

  test('inline-backtick-wrapped title + footer does not fire', () => {
    const frame = [
      'the `Resume Session` picker shows `Esc to clear` in its footer',
      'just prose, no live picker here',
    ].join('\n')
    expect(isResumeSessionPicker(ctxOf(frame))).toBe(false)
  })
})

describe('createResumePickerDetector — edge-latch (fire once, clear on absent)', () => {
  test('id + no keys (recovery is the escape-then-recover ladder)', () => {
    const det = createResumePickerDetector()
    expect(det.id).toBe(RESUME_PICKER_DETECTOR_ID)
    expect(det.keys).toBeUndefined()
  })

  test('fires once on the rising edge, holds latched while present, re-arms on absent', () => {
    const scanner = new OutputScanner()
    scanner.register(createResumePickerDetector())
    const wedged = resumePickerFrame()

    // Rising edge → fires once.
    let fired = scanner.scan(wedged, 1)
    expect(fired.map((f) => f.id)).toEqual([RESUME_PICKER_DETECTOR_ID])
    // Still present → latched, no re-fire.
    fired = scanner.scan(wedged, 2)
    expect(fired).toHaveLength(0)
    // Falling edge (picker gone) → latch clears, no fire.
    fired = scanner.scan('back to normal output', 3)
    expect(fired).toHaveLength(0)
    // Present again → fresh rising edge → fires once more.
    fired = scanner.scan(wedged, 4)
    expect(fired.map((f) => f.id)).toEqual([RESUME_PICKER_DETECTOR_ID])
  })

  test('the fired detection carries no keys (the substrate dispatches recovery)', () => {
    const scanner = new OutputScanner()
    scanner.register(createResumePickerDetector())
    const fired = scanner.scan(resumePickerFrame(), 1)
    expect(fired[0]?.keys).toBeUndefined()
  })
})

/** A recording fake of the recovery's injected effects. */
function fakeDeps(latestSession: string | null): {
  deps: ResumePickerRecoveryDeps
  keysSent: Key[]
  surfaced: string[]
  resumed: string[]
  alerts: string[]
} {
  const keysSent: Key[] = []
  const surfaced: string[] = []
  const resumed: string[] = []
  const alerts: string[] = []
  const deps: ResumePickerRecoveryDeps = {
    writeKey: (k) => keysSent.push(k),
    findLatestSession: () => latestSession,
    surface: (t) => surfaced.push(t),
    requestResume: (id) => resumed.push(id),
    alert: (t) => alerts.push(t),
    delay: async () => {},
    escapeSettleMs: 0,
  }
  return { deps, keysSent, surfaced, resumed, alerts }
}

describe('runResumePickerRecovery — escape-then-recover (never blind-answer)', () => {
  test('picker present → Escape fired exactly once + disk recovery invoked', async () => {
    const { deps, keysSent, surfaced } = fakeDeps('recovered-uuid-1234')
    let scanned = false
    deps.findLatestSession = () => {
      scanned = true
      return 'recovered-uuid-1234'
    }
    const res = await runResumePickerRecovery(deps)
    expect(keysSent).toEqual(['escape'])
    expect(scanned).toBe(true)
    expect(res.recovered).toBe(true)
    expect(surfaced).toHaveLength(1)
  })

  test('recovery found a session → resumes it (notice + requestResume)', async () => {
    const { deps, surfaced, resumed, alerts } = fakeDeps('recovered-uuid-1234')
    const res = await runResumePickerRecovery(deps)
    expect(res).toMatchObject({ recovered: true, sessionId: 'recovered-uuid-1234' })
    expect(resumed).toEqual(['recovered-uuid-1234'])
    expect(surfaced[0]).toContain('recovered')
    // A successful recovery is not an operator-alert situation.
    expect(alerts).toHaveLength(0)
  })

  test('no session found → fresh + "session lost" notice (+ alert), no resume', async () => {
    const { deps, surfaced, resumed, alerts } = fakeDeps(null)
    const res = await runResumePickerRecovery(deps)
    expect(res.recovered).toBe(false)
    expect(res.sessionId).toBeUndefined()
    expect(resumed).toHaveLength(0)
    expect(surfaced).toHaveLength(1)
    expect(surfaced[0]).toContain('lost')
    expect(alerts).toHaveLength(1)
  })

  test('NEVER blind-answers: only Escape is ever sent (no digit / Enter), in any outcome', async () => {
    for (const latest of ['some-uuid', null] as Array<string | null>) {
      const { deps, keysSent } = fakeDeps(latest)
      await runResumePickerRecovery(deps)
      expect(keysSent).toEqual(['escape'])
      for (const k of keysSent) {
        expect(k === 'enter').toBe(false)
        expect(/^[0-9]$/.test(k)).toBe(false)
      }
    }
  })
})

describe('resumePickerPresent / extractResumePicker helpers', () => {
  test('resumePickerPresent is true on a picker frame, false once cleared', () => {
    expect(resumePickerPresent(resumePickerFrame())).toBe(true)
    expect(resumePickerPresent('turn resumed, normal output here')).toBe(false)
  })

  test('extractResumePicker returns the picker text (title + footer) for logging', () => {
    const snap = extractResumePicker(resumePickerFrame())
    expect(snap).toContain('Resume Session')
    expect(snap).toContain('Esc to clear')
  })
})
