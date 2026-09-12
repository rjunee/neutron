import { describe, expect, test } from 'bun:test'
import { trimAsciiWs } from './ascii-trim.ts'

/** The six, named the way the mirrors name them: SPACE TAB LF VT FF CR. */
const SIX = [' ', '\t', '\n', '\u000b', '\f', '\r'] as const

describe('trimAsciiWs — the six ASCII whitespace characters, scanned linearly', () => {
  test('strips all six characters from BOTH ends, including mixed runs', () => {
    for (const c of SIX) {
      expect(trimAsciiWs(`${c}forge-done${c}`)).toBe('forge-done')
      expect(trimAsciiWs(`${c}${c}${c}forge-done`)).toBe('forge-done')
      expect(trimAsciiWs(`forge-done${c}${c}${c}`)).toBe('forge-done')
    }
    // …and a mixed run of every one of them, at each end.
    expect(trimAsciiWs(' \t\n\f\rforge-done\r\f\n\t ')).toBe('forge-done')
  })

  test('INTERIOR whitespace is untouched — this is a trim, not a strip', () => {
    expect(trimAsciiWs('a \t b')).toBe('a \t b')
    expect(trimAsciiWs('  a \t b  ')).toBe('a \t b')
  })

  test('the trim() divergence: NBSP, EM-space and the BOM are NOT stripped', () => {
    // `String.prototype.trim` eats all three, and the bash and SQL mirrors cannot
    // express them — which is exactly why this function names its own set.
    for (const c of ['\u00a0', '\u2003', '\ufeff']) {
      expect(trimAsciiWs(`${c}forge-done${c}`)).toBe(`${c}forge-done${c}`)
      expect(`${c}forge-done${c}`.trim()).toBe('forge-done') // the divergence itself
    }
  })

  test('the empty string and an ALL-whitespace string both come back empty', () => {
    expect(trimAsciiWs('')).toBe('')
    expect(trimAsciiWs(' \t\n\f\r')).toBe('')
    expect(trimAsciiWs(' '.repeat(1000))).toBe('')
  })

  test('a string with nothing to trim is returned unchanged', () => {
    expect(trimAsciiWs('forge-done')).toBe('forge-done')
    expect(trimAsciiWs('a \t b')).toBe('a \t b')
    expect(trimAsciiWs('fix-round-3')).toBe('fix-round-3')
  })

  test('a long INTERIOR whitespace run round-trips — the shape that made the regex quadratic', () => {
    // CodeQL js/polynomial-redos: the old `[\t\n\f\r ]+$` alternative
    // backtracked across this run once per starting offset. The two-pointer scan
    // reads each end once and stops.
    const s = `a${' '.repeat(100000)}b`
    expect(trimAsciiWs(s)).toBe(s)
  })
})
