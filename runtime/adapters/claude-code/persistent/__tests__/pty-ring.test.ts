/**
 * pty-ring.test.ts — the rendered-screen ring: bottom-N line addressing,
 * normalize-on-read, the buffer bound, and the per-turn `textSince` window.
 *
 * § herdr step 2b. The ring is SNAPSHOT-REPLACE now, so the interesting tests are
 * the ones that vary the SCREEN rather than the text of one steady screen. The
 * question each `textSince` case is written against is "what would a wrong
 * implementation get right?":
 *
 *   • An implementation that returns the whole current screen gets every
 *     "something new appeared" case right. So the load-bearing cases are the
 *     EXCLUSIONS — an unchanged screen, and a line that was already there.
 *   • An implementation that returns '' whenever the screen did not grow gets the
 *     exclusions right. So a genuinely new line must be asserted too.
 *   • An implementation using a SET difference gets both of those right and fails
 *     only on a RECURRING identical line, which is the real production shape (a
 *     credential banner printed on two consecutive turns). Hence the multiset
 *     cases.
 *   • An implementation that diffs against the PREVIOUS snapshot rather than the
 *     MARK's gets a two-snapshot turn right and a three-snapshot turn wrong.
 */

import { describe, expect, test } from 'bun:test'
import { PtyRing, bottomNLines, DEFAULT_RING_MAX_BYTES } from '../pty-ring.ts'

describe('bottomNLines', () => {
  test('returns the last N newline-delimited lines', () => {
    expect(bottomNLines('a\nb\nc\nd\ne', 2)).toBe('d\ne')
  })

  test('a trailing newline is not counted as an empty final line', () => {
    expect(bottomNLines('a\nb\n', 1)).toBe('b')
    expect(bottomNLines('a\nb\n', 2)).toBe('a\nb')
  })

  test('N >= line count returns the whole text (trailing \\n trimmed)', () => {
    expect(bottomNLines('a\nb', 5)).toBe('a\nb')
    expect(bottomNLines('a\nb\n', 5)).toBe('a\nb')
  })

  test('non-positive N returns empty', () => {
    expect(bottomNLines('a\nb\nc', 0)).toBe('')
    expect(bottomNLines('a\nb\nc', -3)).toBe('')
  })

  test('single line, no newline', () => {
    expect(bottomNLines('solo', 1)).toBe('solo')
    expect(bottomNLines('solo', 24)).toBe('solo')
  })
})

describe('PtyRing — snapshot-replace', () => {
  test('replace REPLACES the screen, it does not append to it', () => {
    const r = new PtyRing()
    r.replace('first screen')
    r.replace('second screen')
    // The distinguishing assertion: an appending ring would hold both.
    expect(r.text()).toBe('second screen')
    expect(r.text()).not.toContain('first')
  })

  test('an empty screen is a real snapshot — this is the detector falling edge', () => {
    const r = new PtyRing()
    r.replace('❯ 1. Yes\n  2. No')
    expect(r.getRecentOutput({ bottomN: 24 })).toContain('1. Yes')
    // The pane is cleared. A diff-append ring would still be showing the menu
    // here, `present` would never go false, and the latch would never drop.
    r.replace('')
    expect(r.text()).toBe('')
    expect(r.getRecentOutput({ bottomN: 24 })).not.toContain('1. Yes')
  })

  test('snapshotSeq counts snapshots, and counts an unchanged one too', () => {
    const r = new PtyRing()
    expect(r.snapshotSeq()).toBe(0)
    r.replace('same')
    expect(r.snapshotSeq()).toBe(1)
    r.replace('same')
    // The ring counts what it is given; suppressing an unchanged screen is the
    // HOST's job (see herdr-host), not the ring's, and conflating the two is how
    // the idle gate breaks.
    expect(r.snapshotSeq()).toBe(2)
  })

  test('getRecentOutput with bottomN returns line-addressed slice', () => {
    const r = new PtyRing()
    r.replace('line1\nline2\nline3\nline4\n')
    expect(r.getRecentOutput({ bottomN: 2 })).toBe('line3\nline4')
  })

  test('getRecentOutput without bottomN returns the whole screen', () => {
    const r = new PtyRing()
    r.replace('a\nb\nc')
    expect(r.getRecentOutput()).toBe('a\nb\nc')
  })

  test('normalize collapses ANSI cursor escapes + whitespace for matching', () => {
    const r = new PtyRing()
    // Ink positions each word with a cursor-move CSI escape — never contiguous.
    r.replace('using\x1b[5Gthis\x1b[10G for\nlocal development')
    const norm = r.getRecentOutput({ normalize: true })
    expect(norm).toContain('usingthisforlocaldevelopment')
    expect(norm).not.toContain('\x1b')
  })

  test('normalize composes with bottomN (slice first, then normalize)', () => {
    const r = new PtyRing()
    r.replace('top noise\nbottom\x1b[2Gsignal')
    expect(r.getRecentOutput({ bottomN: 1, normalize: true })).toBe('bottomsignal')
  })
})

describe('PtyRing — the buffer bound', () => {
  test('a screen at herdr\'s 999-line read cap is retained WHOLE, not clamped', () => {
    // The bound that matters in production. herdr caps `pane.read` at 999 lines
    // (measured), and the largest detector window is 200 lines, so the default
    // ring must hold a full-cap screen without dropping its top. Both numbers are
    // pinned as VALUES here, not just as a relation, so moving either is visible.
    const HERDR_READ_LINE_CAP = 999
    const WIDE = 200
    const screen = Array.from({ length: HERDR_READ_LINE_CAP }, (_, i) => `L${i}`.padEnd(WIDE, '.')).join('\n')
    expect(Buffer.byteLength(screen, 'utf8')).toBeLessThan(DEFAULT_RING_MAX_BYTES)
    const r = new PtyRing()
    r.replace(screen)
    expect(r.text()).toBe(screen)
    // The top line survives — a clamp would have eaten it.
    expect(r.getRecentOutput({ bottomN: HERDR_READ_LINE_CAP })).toContain('L0')
    expect(r.getRecentOutput({ bottomN: 200 })).toContain('L998')
  })

  test('over-cap clamping drops WHOLE leading lines, never a partial line', () => {
    // A byte-slice clamp would leave a half line at the top, which every reader
    // here would then treat as a real line.
    const r = new PtyRing(12)
    r.replace('aaaa\nbbbb\ncccc\ndddd')
    const lines = r.text().split('\n')
    expect(r.text().length).toBeLessThanOrEqual(12)
    // Every retained line is intact.
    for (const l of lines) expect(l).toMatch(/^(aaaa|bbbb|cccc|dddd)$/)
    // And it kept the BOTTOM, because every detector read is bottom-anchored.
    expect(lines.at(-1)).toBe('dddd')
  })

  test('default buffer holds a full-cap screen (and is far past the legacy 16 KB)', () => {
    expect(DEFAULT_RING_MAX_BYTES).toBe(512 * 1024)
    expect(DEFAULT_RING_MAX_BYTES).toBeGreaterThan(16 * 1024)
  })

  test('a non-positive maxBytes falls back to the default', () => {
    const r = new PtyRing(0)
    const big = 'x'.repeat(DEFAULT_RING_MAX_BYTES + 100)
    r.replace(big)
    expect(Buffer.byteLength(r.text(), 'utf8')).toBe(DEFAULT_RING_MAX_BYTES)
  })

  // ── The bound is UTF-8 BYTES, not UTF-16 code units ──────────────────────────
  // `String.length` counts code units, which for anything non-ASCII is FEWER than
  // the bytes — so measuring with it makes the bound too LAX, never too strict. An
  // all-ASCII test cannot see the difference, which is exactly why it survived.

  test('a MULTIBYTE screen is bounded by BYTES — the ASCII case cannot see this', () => {
    // 400,000 × 'é' is 400,000 code units and 800,000 UTF-8 bytes. Measured with
    // `.length` it looks like it fits under 512 KiB and is retained whole.
    const r = new PtyRing()
    const screen = 'é'.repeat(400_000)
    expect(screen.length).toBeLessThan(DEFAULT_RING_MAX_BYTES) // the misleading view
    expect(Buffer.byteLength(screen, 'utf8')).toBeGreaterThan(DEFAULT_RING_MAX_BYTES)
    r.replace(screen)
    expect(Buffer.byteLength(r.text(), 'utf8')).toBeLessThanOrEqual(DEFAULT_RING_MAX_BYTES)
  })

  test('CONTROL — a multibyte screen that genuinely FITS is retained whole', () => {
    // Otherwise a bound that simply truncated every non-ASCII screen would pass.
    const r = new PtyRing(1024)
    const screen = 'é'.repeat(100) // 200 bytes
    r.replace(screen)
    expect(r.text()).toBe(screen)
  })

  test('the clamp cuts on a CHARACTER boundary — no replacement characters', () => {
    // A byte-offset slice lands mid-character and decodes to U+FFFD. Sized so the
    // cut necessarily falls inside a multi-byte character.
    const r = new PtyRing(101)
    r.replace('é'.repeat(200)) // 400 bytes, cap 101 → the cut lands mid-character
    const out = r.text()
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(101)
    expect(out).not.toContain('\uFFFD')
    expect(out).toMatch(/^é+$/)
  })

  test('an ASTRAL character (surrogate pair) is never split by the clamp', () => {
    // '😀' is ONE code point, TWO UTF-16 units, FOUR UTF-8 bytes — the shape that
    // breaks both a code-unit slice and a naive byte slice.
    const r = new PtyRing(50)
    r.replace('😀'.repeat(100)) // 400 bytes
    const out = r.text()
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(50)
    expect(out).not.toContain('\uFFFD')
    expect([...out].every((c) => c === '😀')).toBe(true)
  })

  test('multibyte LINES are dropped by byte cost — it keeps the MAXIMAL fitting tail', () => {
    // The per-line accounting in the drop loop. Measuring each removed line with
    // `.length` under-charges a multibyte line, so `size` falls too slowly and the
    // loop drops MORE lines than it needs to — the bound still holds, but the ring
    // throws away screen a correct implementation would have kept, which can take it
    // below the detector window. So the assertion is RETENTION, not just the bound:
    // a bound-only check passes for an implementation that discards everything.
    const CAP = 100
    const line = 'é'.repeat(10) // 20 UTF-8 bytes, 10 UTF-16 units, +1 for the \n
    const r = new PtyRing(CAP)
    r.replace(Array.from({ length: 20 }, () => line).join('\n'))

    const out = r.text()
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(CAP)
    // Bottom-anchored, and MAXIMAL: one more line would not have fit.
    expect(out.endsWith(line)).toBe(true)
    const kept = out.split('\n').length
    expect(Buffer.byteLength([...Array(kept + 1)].map(() => line).join('\n'), 'utf8')).toBeGreaterThan(
      CAP,
    )
    // Concretely: 4 lines are 83 bytes and fit; 5 are 104 and do not.
    expect(kept).toBe(4)
  })
})

describe('PtyRing.textSince — scoping a turn to a baseline screen', () => {
  test('a screen unchanged since the mark yields NOTHING new', () => {
    const r = new PtyRing()
    r.replace('turn-1 banner\nfooter')
    const mark = r.mark()
    // The Ink TUI repaints constantly. A byte-count mark would have advanced by a
    // whole screen on each repaint and returned the entire screen here — which is
    // exactly the stale-banner re-arm per-turn scoping exists to prevent.
    r.replace('turn-1 banner\nfooter')
    expect(r.textSince(mark)).toBe('')
  })

  test('a line already on screen at the mark is EXCLUDED; a new line is included', () => {
    const r = new PtyRing()
    r.replace('turn-1 banner\nfooter')
    const mark = r.mark()
    r.replace('turn-1 banner\nfooter\nturn-2 output')
    expect(r.textSince(mark)).toBe('turn-2 output')
    expect(r.textSince(mark)).not.toContain('banner')
    expect(r.textSince(mark)).not.toContain('footer')
  })

  test('a RECURRING identical line yields exactly one new copy (multiset, not set)', () => {
    // The production shape: a credential banner printed on turn 1 is still on
    // screen, and turn 2 prints the SAME banner again. A set difference would
    // suppress the second copy and the detector would go blind on turn 2 — the
    // warm-session re-arm case in auth-failure-classification.test.ts.
    const BANNER = 'API Error: 401 OAuth access token is invalid.'
    const r = new PtyRing()
    r.replace(`${BANNER}\nfooter`)
    const mark = r.mark()
    r.replace(`${BANNER}\nfooter\n${BANNER}`)
    expect(r.textSince(mark)).toBe(BANNER)
  })

  test('two occurrences at the mark and three now yields exactly one', () => {
    const r = new PtyRing()
    r.replace('dup\ndup\nkeep')
    const mark = r.mark()
    r.replace('dup\ndup\nkeep\ndup')
    expect(r.textSince(mark)).toBe('dup')
  })

  test('the window is against the MARK, not against the previous snapshot', () => {
    // A turn spans many polls. An implementation that diffed each snapshot against
    // the one before it would report only the LAST poll's additions and lose
    // everything the turn printed earlier.
    const r = new PtyRing()
    r.replace('base')
    const mark = r.mark()
    r.replace('base\nfirst')
    r.replace('base\nfirst\nsecond')
    r.replace('base\nfirst\nsecond\nthird')
    expect(r.textSince(mark)).toBe('first\nsecond\nthird')
  })

  test('a mark taken before any snapshot treats the whole screen as new', () => {
    const r = new PtyRing()
    const mark = r.mark()
    r.replace('everything here is new')
    expect(r.textSince(mark)).toBe('everything here is new')
  })

  test('a cleared screen yields nothing new, even though the screen CHANGED', () => {
    const r = new PtyRing()
    r.replace('banner\nfooter')
    const mark = r.mark()
    r.replace('')
    // The screen changed, so a "did anything change since the mark?" implementation
    // would hand the caller a screen; there is genuinely no new OUTPUT.
    expect(r.textSince(mark)).toBe('')
  })

  test('scrolled-off baseline lines do not resurrect as new output', () => {
    const r = new PtyRing()
    r.replace('old-1\nold-2\nold-3')
    const mark = r.mark()
    // old-1/old-2 scrolled off the top; old-3 is still visible; two lines are new.
    r.replace('old-3\nnew-1\nnew-2')
    expect(r.textSince(mark)).toBe('new-1\nnew-2')
  })

  test('the result keeps SCREEN ORDER, so a bottom-N read of it is meaningful', () => {
    const r = new PtyRing()
    r.replace('header')
    const mark = r.mark()
    r.replace('header\nalpha\nbeta\ngamma')
    // Order-preserving, so `buildDetectorContext`'s bottom-N slice and doc-quote
    // guard — both positional — still mean what they mean.
    expect(r.textSince(mark)).toBe('alpha\nbeta\ngamma')
    expect(bottomNLines(r.textSince(mark), 1)).toBe('gamma')
  })

  test('a mark is a baseline, not a quantity — two marks on one screen agree', () => {
    const r = new PtyRing()
    r.replace('a\nb')
    const m1 = r.mark()
    const m2 = r.mark()
    r.replace('a\nb\nc')
    expect(r.textSince(m1)).toBe('c')
    expect(r.textSince(m2)).toBe('c')
  })
})
