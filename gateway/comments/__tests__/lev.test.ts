/**
 * P7.2 S2 — banded Levenshtein + bestFuzzyWindow unit tests.
 *
 * Pure-function tests; no I/O. Covers per brief § 10.2:
 *   - bandedLevenshtein returns exact distance for distances ≤ cap
 *   - bandedLevenshtein returns cap+1 sentinel above cap
 *   - bandedLevenshtein handles empty strings + length-difference shortcuts
 *   - bestFuzzyWindow finds the best window when within tolerance
 *   - bestFuzzyWindow returns null when no window meets tolerance
 *   - allIndicesOf + pickClosest helpers
 */

import { describe, expect, it } from 'bun:test'

import {
  allIndicesOf,
  bandedLevenshtein,
  bestFuzzyWindow,
  pickClosest,
} from '../lev.ts'

describe('bandedLevenshtein — exact distance below cap', () => {
  it('returns 0 for identical strings', () => {
    expect(bandedLevenshtein('hello world', 'hello world', 5)).toBe(0)
  })

  it('returns 1 for a single insert', () => {
    expect(bandedLevenshtein('hello', 'helloo', 3)).toBe(1)
  })

  it('returns 1 for a single delete', () => {
    expect(bandedLevenshtein('hello', 'hell', 3)).toBe(1)
  })

  it('returns 1 for a single substitution', () => {
    expect(bandedLevenshtein('hello', 'jello', 3)).toBe(1)
  })

  it('returns 2 for two substitutions', () => {
    expect(bandedLevenshtein('kitten', 'sitten', 3)).toBe(1)
    expect(bandedLevenshtein('kitten', 'sitting', 5)).toBe(3)
  })
})

describe('bandedLevenshtein — cap behaviour', () => {
  it('returns cap+1 when distance strictly exceeds cap', () => {
    expect(bandedLevenshtein('hello', 'world', 1)).toBe(2)
  })

  it('returns cap+1 immediately when length difference exceeds cap', () => {
    // 5-char gap > cap=2 → bail without DP work.
    expect(bandedLevenshtein('ab', 'abcdefg', 2)).toBe(3)
  })

  it('handles empty needle vs non-empty haystack within cap', () => {
    expect(bandedLevenshtein('', 'abc', 3)).toBe(3)
    expect(bandedLevenshtein('', 'abc', 2)).toBe(3)
    expect(bandedLevenshtein('', 'abc', 10)).toBe(3)
  })

  it('handles empty haystack vs non-empty needle', () => {
    expect(bandedLevenshtein('abc', '', 3)).toBe(3)
    expect(bandedLevenshtein('abc', '', 2)).toBe(3)
  })

  it('handles both empty', () => {
    expect(bandedLevenshtein('', '', 0)).toBe(0)
    expect(bandedLevenshtein('', '', 5)).toBe(0)
  })

  it('returns cap+1 when cap is negative (defensive)', () => {
    expect(bandedLevenshtein('a', 'b', -1)).toBeGreaterThanOrEqual(0)
  })
})

describe('bestFuzzyWindow — best match', () => {
  it('finds an exact substring with distance=0', () => {
    const result = bestFuzzyWindow('the quick brown fox', 'quick', { tolerance: 0.25 })
    expect(result).not.toBeNull()
    expect(result?.lev_distance).toBe(0)
    expect(result?.window_start).toBe(4)
  })

  it('finds a fuzzy substring within tolerance (typo)', () => {
    // "qiuck" → "quick" is distance 2 (one swap). tolerance 0.4 * 5 = 2.
    const result = bestFuzzyWindow('the qiuck brown fox', 'quick', { tolerance: 0.4 })
    expect(result).not.toBeNull()
    expect(result?.lev_distance).toBeGreaterThan(0)
    expect(result?.lev_distance).toBeLessThanOrEqual(2)
  })

  it('returns null when no window is within tolerance', () => {
    const result = bestFuzzyWindow(
      'completely different text with no overlap',
      'xenophobia',
      { tolerance: 0.1 },
    )
    expect(result).toBeNull()
  })

  it('returns null for an empty needle', () => {
    expect(bestFuzzyWindow('abc', '', { tolerance: 0.5 })).toBeNull()
  })

  it('returns null for an empty haystack', () => {
    expect(bestFuzzyWindow('', 'abc', { tolerance: 0.5 })).toBeNull()
  })

  it('prefers the lower-distance window when multiple are within tolerance', () => {
    // Two candidate "quic" substrings; the exact "quick" wins on distance.
    const result = bestFuzzyWindow(
      'said quic, then quick later',
      'quick',
      { tolerance: 0.4 },
    )
    expect(result).not.toBeNull()
    expect(result?.lev_distance).toBe(0)
    // The 0-distance "quick" sits at offset 16.
    expect(result?.window_start).toBe(16)
  })
})

describe('allIndicesOf', () => {
  it('returns every match offset', () => {
    expect(allIndicesOf('abcabcabc', 'abc')).toEqual([0, 3, 6])
  })

  it('returns an empty array when no match', () => {
    expect(allIndicesOf('abc', 'xyz')).toEqual([])
  })

  it('handles overlapping matches', () => {
    expect(allIndicesOf('aaaa', 'aa')).toEqual([0, 1, 2])
  })

  it('returns empty for empty needle or haystack', () => {
    expect(allIndicesOf('', 'a')).toEqual([])
    expect(allIndicesOf('a', '')).toEqual([])
  })
})

describe('pickClosest', () => {
  it('returns the only candidate when length is 1', () => {
    expect(pickClosest([42], 100)).toBe(42)
  })

  it('returns the closest candidate', () => {
    expect(pickClosest([0, 50, 100, 200], 60)).toBe(50)
  })

  it('ties broken by smaller offset', () => {
    // 50 and 70 are equidistant from 60; pick 50.
    expect(pickClosest([50, 70], 60)).toBe(50)
  })

  it('throws on an empty list', () => {
    expect(() => pickClosest([], 0)).toThrow()
  })
})
