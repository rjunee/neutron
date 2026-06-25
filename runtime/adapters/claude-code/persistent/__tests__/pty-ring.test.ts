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
    expect(r.raw()).toBe('hello world')
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
    expect(r.raw()).toBe('23456789')
    expect(r.raw().length).toBe(8)
  })

  test('default buffer is widened beyond the legacy 16 KB', () => {
    expect(DEFAULT_RING_MAX_BYTES).toBeGreaterThan(16 * 1024)
  })

  test('a non-positive maxBytes falls back to the default', () => {
    const r = new PtyRing(0)
    const big = 'x'.repeat(DEFAULT_RING_MAX_BYTES + 100)
    r.append(big)
    expect(r.raw().length).toBe(DEFAULT_RING_MAX_BYTES)
  })
})
