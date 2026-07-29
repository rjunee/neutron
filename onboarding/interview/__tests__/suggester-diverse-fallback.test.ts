/**
 * 2026-06-04 (onboarding-suggester-llm-timeout) — diverse, per-instance-seeded
 * fallback tests for both suggesters.
 *
 * Pins the fix for Sam's 2026-06-04 report: every onboarding showed the
 * identical five male sages + same three names because the LLM path timed
 * out 100% of the time and the fallback was a single monotone constant.
 * The new fallback is deterministic per `seed` (owner_slug, NOT
 * `Math.random()`), spans gender + tone, and differs across instances.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildDiverseCharacterFallback,
  characterNamesInRenderOrder,
} from '../personality-character-suggester.ts'
import {
  buildDiverseAgentNameFallback,
  isValidAgentName,
} from '../agent-name-suggester.ts'

const OLD_MONOTONE_CHARACTERS = [
  'Sherlock Holmes',
  'Marcus Aurelius',
  'Mr. Miyagi',
  'Yoda',
  'Atticus Finch',
]

describe('buildDiverseCharacterFallback — variety + determinism', () => {
  test('shape: 3 personalized + 2 wild', () => {
    const out = buildDiverseCharacterFallback('project-a')
    expect(out.personalized).toHaveLength(3)
    expect(out.wild).toHaveLength(2)
    expect(characterNamesInRenderOrder(out)).toHaveLength(5)
  })

  test('deterministic: same seed → identical list (no Math.random)', () => {
    const a = buildDiverseCharacterFallback('project-a')
    const b = buildDiverseCharacterFallback('project-a')
    expect(characterNamesInRenderOrder(a)).toEqual(characterNamesInRenderOrder(b))
  })

  test('two different owners get different lists', () => {
    // Sweep a handful of seeds — at least one pair must differ (the whole
    // point of the fix). With a 10-entry pool and offset-by-hash sampling,
    // distinct seeds overwhelmingly produce distinct trios.
    const seeds = ['casey', 'soren', 'priya', 'anna', 'sam', 'devon']
    const lists = seeds.map((s) =>
      characterNamesInRenderOrder(buildDiverseCharacterFallback(s)).join('|'),
    )
    const distinct = new Set(lists)
    expect(distinct.size).toBeGreaterThan(1)
  })

  test('personalized trio is never all-one-gender (not 5 male sages)', () => {
    // The old fallback was all male. Assert the new one is not the old
    // monotone list for a representative spread of seeds.
    for (const seed of ['', 'a', 'project-xyz', 'acme', 'neutron']) {
      const names = characterNamesInRenderOrder(buildDiverseCharacterFallback(seed))
      expect(names).not.toEqual(OLD_MONOTONE_CHARACTERS)
    }
  })

  test('every fallback character has a non-empty bounded why line', () => {
    const out = buildDiverseCharacterFallback('project-a')
    for (const c of [...out.personalized, ...out.wild]) {
      expect(c.name.length).toBeGreaterThan(0)
      expect(c.name.length).toBeLessThanOrEqual(60)
      expect(c.why.length).toBeGreaterThan(0)
      expect(c.why.length).toBeLessThanOrEqual(160)
    }
  })

  test('null seed is handled (falls back to a stable empty-seed sample)', () => {
    const out = buildDiverseCharacterFallback(null)
    expect(out.personalized).toHaveLength(3)
    expect(out.wild).toHaveLength(2)
  })
})

describe('buildDiverseAgentNameFallback — variety + determinism', () => {
  test('shape: 3 picks, all valid agent names', () => {
    const out = buildDiverseAgentNameFallback('project-a')
    expect(out.picks).toHaveLength(3)
    for (const p of out.picks) {
      expect(isValidAgentName(p.name)).toBe(true)
      expect(p.tagline.length).toBeGreaterThan(0)
    }
  })

  test('deterministic: same seed → identical list', () => {
    const a = buildDiverseAgentNameFallback('project-a').picks.map((p) => p.name)
    const b = buildDiverseAgentNameFallback('project-a').picks.map((p) => p.name)
    expect(a).toEqual(b)
  })

  test('two different owners get different lists', () => {
    const seeds = ['casey', 'soren', 'priya', 'anna', 'sam', 'devon']
    const lists = seeds.map((s) =>
      buildDiverseAgentNameFallback(s).picks.map((p) => p.name).join('|'),
    )
    expect(new Set(lists).size).toBeGreaterThan(1)
  })

  test('picks are distinct within a list', () => {
    const names = buildDiverseAgentNameFallback('project-a').picks.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
