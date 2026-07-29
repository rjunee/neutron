/**
 * FallbackGallery — 12-PNG archetype-keyed default portraits.
 *
 * Per docs/plans/P2-onboarding.md § 2.7 + § 6 S4 (lines 2101).
 *
 *   - All 12 archetype slugs resolve to a real on-disk PNG.
 *   - Unknown archetype hint → FALLBACK_DEFAULT_SLUG.
 *   - Aliases (gandalf, leonardo, marie-curie) normalize to the canonical slug.
 *   - PNGs are non-empty (the placeholder bytes are deterministic 256x256 colors).
 */

import { describe, expect, test } from 'bun:test'
import {
  FALLBACK_ARCHETYPE_SLUGS,
  FALLBACK_DEFAULT_SLUG,
  FallbackGallery,
  FallbackGalleryError,
  normalizeArchetype,
} from '../fallback-gallery.ts'

describe('FallbackGallery — 12 PNG archetype-keyed gallery', () => {
  test('verifyComplete returns all 12 slugs present, none missing', () => {
    const g = new FallbackGallery()
    const { present, missing } = g.verifyComplete()
    expect(missing).toEqual([])
    expect(present.length).toBe(FALLBACK_ARCHETYPE_SLUGS.length)
    expect(present.length).toBe(12)
    for (const slug of FALLBACK_ARCHETYPE_SLUGS) {
      expect(present).toContain(slug)
    }
  })

  test('every archetype slug resolves to a non-empty PNG', () => {
    const g = new FallbackGallery()
    for (const slug of FALLBACK_ARCHETYPE_SLUGS) {
      const portrait = g.pick(slug)
      expect(portrait.slug).toBe(slug)
      expect(portrait.bytes.length).toBeGreaterThan(64)
      // PNG signature: 89 50 4E 47 0D 0A 1A 0A
      expect(portrait.bytes[0]).toBe(0x89)
      expect(portrait.bytes[1]).toBe(0x50)
      expect(portrait.bytes[2]).toBe(0x4e)
      expect(portrait.bytes[3]).toBe(0x47)
    }
  })

  test('list() enumerates every PNG in the data dir', () => {
    const g = new FallbackGallery()
    const all = g.list()
    expect(all.length).toBe(12)
    for (const portrait of all) {
      expect(FALLBACK_ARCHETYPE_SLUGS).toContain(portrait.slug)
    }
  })

  test('unknown archetype hint falls back to default slug', () => {
    const g = new FallbackGallery()
    const portrait = g.pick('not-a-real-archetype')
    expect(portrait.slug).toBe(FALLBACK_DEFAULT_SLUG)
  })

  test('undefined hint falls back to default slug', () => {
    const g = new FallbackGallery()
    const portrait = g.pick(undefined)
    expect(portrait.slug).toBe(FALLBACK_DEFAULT_SLUG)
  })

  test('alias hints normalize to canonical slug', () => {
    expect(normalizeArchetype('Gandalf')).toBe('gandalf-the-white')
    expect(normalizeArchetype('sherlock')).toBe('sherlock-holmes')
    expect(normalizeArchetype('marcus')).toBe('marcus-aurelius')
    expect(normalizeArchetype('leonardo')).toBe('da-vinci')
    expect(normalizeArchetype('Marie Curie')).toBe('curie')
    expect(normalizeArchetype('  Padma  ')).toBe('padmasambhava')
    expect(normalizeArchetype('guru rinpoche')).toBe('padmasambhava')
  })

  test('canonical archetype slugs round-trip through normalizeArchetype', () => {
    for (const slug of FALLBACK_ARCHETYPE_SLUGS) {
      expect(normalizeArchetype(slug)).toBe(slug)
    }
  })

  test('blended hints split on /|,+& and pick first matching slug (Codex r1 P2 fix)', () => {
    expect(normalizeArchetype('Odin/Thoth/Padmasambhava')).toBe('odin')
    expect(normalizeArchetype('Marie Curie + Da Vinci')).toBe('curie')
    expect(normalizeArchetype('gandalf|sherlock')).toBe('gandalf-the-white')
    expect(normalizeArchetype('a, b, marcus')).toBe('marcus-aurelius')
    expect(normalizeArchetype('athena & shiva')).toBe('athena')
  })

  test('blended hints with no matching fragment fall through to default', () => {
    expect(normalizeArchetype('alpha/beta/gamma')).toBe(FALLBACK_DEFAULT_SLUG)
  })

  test('missing data dir surfaces FallbackGalleryError', () => {
    const g = new FallbackGallery({ data_dir: '/tmp/__neutron_no_such_dir__' })
    expect(() => g.list()).toThrow(FallbackGalleryError)
  })
})
