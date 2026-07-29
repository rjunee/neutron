/**
 * pty-ring.test.ts — F1: the public, line-addressable PTY ring-read accessor.
 * Covers bottom-N line addressing, normalize-on-read, the widened buffer bound,
 * and the trailing-newline edge.
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

describe('PtyRing', () => {
  test('append + raw accumulates verbatim', () => {
    const r = new PtyRing()
    r.append('hello ')
    r.append('world')
    expect(r.text()).toBe('hello world')
  })

  test('getRecentOutput with bottomN returns line-addressed slice', () => {
    const r = new PtyRing()
    r.append('line1\nline2\nline3\nline4\n')
    expect(r.getRecentOutput({ bottomN: 2 })).toBe('line3\nline4')
  })

  test('getRecentOutput without bottomN returns the whole buffer', () => {
    const r = new PtyRing()
    r.append('a\nb\nc')
    expect(r.getRecentOutput()).toBe('a\nb\nc')
  })

  test('normalize collapses ANSI cursor escapes + whitespace for matching', () => {
    const r = new PtyRing()
    // Ink positions each word with a cursor-move CSI escape — never contiguous.
    r.append('using\x1b[5Gthis\x1b[10G for\nlocal development')
    const norm = r.getRecentOutput({ normalize: true })
    expect(norm).toContain('usingthisforlocaldevelopment')
    expect(norm).not.toContain('\x1b')
  })

  test('normalize composes with bottomN (slice first, then normalize)', () => {
    const r = new PtyRing()
    r.append('top noise\nbottom\x1b[2Gsignal')
    expect(r.getRecentOutput({ bottomN: 1, normalize: true })).toBe('bottomsignal')
  })

  test('bounds the buffer to maxBytes (rolling)', () => {
    const r = new PtyRing(8)
    r.append('0123456789')
    expect(r.text()).toBe('23456789')
    expect(r.text().length).toBe(8)
  })

  test('default buffer is widened beyond the legacy 16 KB', () => {
    expect(DEFAULT_RING_MAX_BYTES).toBeGreaterThan(16 * 1024)
  })

  test('a non-positive maxBytes falls back to the default', () => {
    const r = new PtyRing(0)
    const big = 'x'.repeat(DEFAULT_RING_MAX_BYTES + 100)
    r.append(big)
    expect(r.text().length).toBe(DEFAULT_RING_MAX_BYTES)
  })

  test('totalBytesAppended is monotonic and survives rolling eviction', () => {
    const r = new PtyRing(4)
    expect(r.totalBytesAppended()).toBe(0)
    r.append('abcdef') // buffer evicts to 'cdef', but the counter keeps climbing
    expect(r.totalBytesAppended()).toBe(6)
    r.append('gh')
    expect(r.totalBytesAppended()).toBe(8)
  })

  test('textSince returns only output appended after the mark', () => {
    const r = new PtyRing()
    r.append('turn-1 banner\n')
    const mark = r.totalBytesAppended() // boundary: turn 2 starts here
    // Nothing appended since the mark yet → empty (the "no new output" case that
    // keeps a stale banner out of the current-turn window).
    expect(r.textSince(mark)).toBe('')
    r.append('turn-2 output')
    expect(r.textSince(mark)).toBe('turn-2 output')
    // The mark excludes the earlier turn-1 banner entirely.
    expect(r.textSince(mark)).not.toContain('banner')
  })

  test('textSince clamps to the retained buffer when eviction outran the mark', () => {
    const r = new PtyRing(4)
    r.append('ab')
    const mark = r.totalBytesAppended()
    // Append more than the buffer holds since the mark: newBytes (6) > buf.length (4)
    // → return the whole retained buffer, not a slice that reaches past its start.
    r.append('cdefgh')
    expect(r.textSince(mark)).toBe(r.text())
    expect(r.text()).toBe('efgh')
  })
})
