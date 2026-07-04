import { describe, test, expect } from 'bun:test'
import { entitySlugify, SLUG_REGEX } from '../entity-slug.ts'
import { slugify as scribeSlugify } from '../../scribe/write-to-gbrain.ts'

describe('entitySlugify — pinned grammar (P2-8 consolidation)', () => {
  test('lower-cases, hyphenates non-alphanumeric runs, strips edge hyphens', () => {
    expect(entitySlugify('Casey Rivera')).toBe('casey-rivera')
    expect(entitySlugify('Compound Engineering!')).toBe('compound-engineering')
    expect(entitySlugify("DHH's Rails Style")).toBe('dhh-s-rails-style')
    expect(entitySlugify('  spaces  ')).toBe('spaces')
    expect(entitySlugify('!!!hi!!!')).toBe('hi')
  })

  test('returns null when nothing alphanumeric survives', () => {
    expect(entitySlugify('---')).toBeNull()
    expect(entitySlugify('')).toBeNull()
    expect(entitySlugify('!!!')).toBeNull()
  })

  test('caps at 80 chars and keeps the capped slug grammar-valid', () => {
    const long = 'a'.repeat(200)
    const out = entitySlugify(long)
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(80)
    expect(SLUG_REGEX.test(out!)).toBe(true)
  })

  test('defensive non-string guard (scribe copy carried this) returns null', () => {
    // @ts-expect-error — exercising the runtime guard preserved from the scribe copy
    expect(entitySlugify(undefined)).toBeNull()
    // @ts-expect-error
    expect(entitySlugify(42)).toBeNull()
  })

  test('every output satisfies SLUG_REGEX', () => {
    for (const s of ['Casey Rivera', 'a_b_c', 'Über Cool', '99 Bottles']) {
      const out = entitySlugify(s)
      if (out !== null) expect(SLUG_REGEX.test(out)).toBe(true)
    }
  })

  test('scribe re-export resolves to the one shared impl', () => {
    // (K3, 2026-07-03) — the `onboarding/history-import/entity-populator.ts`
    // re-export of `slugify` was dropped when that module was deleted with the
    // per-chunk import pipeline; the scribe parity check remains.
    expect(scribeSlugify).toBe(entitySlugify)
    for (const s of ['Casey Rivera', 'Compound Engineering!', '---', 'a'.repeat(200)]) {
      expect(scribeSlugify(s)).toBe(entitySlugify(s))
    }
  })
})
