/**
 * M2.6 Ph2 — local-slug assigner. Locks brief test #8 (grammar never violated)
 * + the collision discipline that backs test #2 (two members, distinct slugs).
 */

import { describe, expect, test } from 'bun:test'
import {
  assignLocalSlug,
  slugifyDisplayName,
  FALLBACK_LOCAL_SLUG_BASE,
} from '../local-slug.ts'
import { SLUG_RE, validateSlugFormat } from '../slug-format.ts'

const neverTaken = (): boolean => false

describe('slugifyDisplayName', () => {
  test('basic name → grammar-shaped base', () => {
    expect(slugifyDisplayName('Mona')).toBe('mona')
    expect(slugifyDisplayName('Jane Doe')).toBe('jane-doe')
    expect(slugifyDisplayName('  John  Quincy Smith ')).toBe('john-quincy-smith')
  })

  test('collapses punctuation + diacritics, trims hyphens', () => {
    expect(slugifyDisplayName("O'Brien")).toBe('o-brien')
    expect(slugifyDisplayName('José')).toBe('jose')
    expect(slugifyDisplayName('a.b.c')).toBe('a-b-c')
  })

  test('returns empty for un-slugifiable input (caller substitutes fallback)', () => {
    expect(slugifyDisplayName('!!!')).toBe('')
    expect(slugifyDisplayName('123')).toBe('') // leading-digit-only
    expect(slugifyDisplayName('Z')).toBe('') // below 3-char floor
    expect(slugifyDisplayName('')).toBe('')
  })
})

describe('assignLocalSlug — grammar guarantee (brief test #8)', () => {
  test('always returns a grammar-valid slug', () => {
    for (const name of [
      'Mona',
      'X',
      '!!!',
      '123 456',
      'admin', // an ordinary name now — local_slug is grammar-only (T1 rip)
      'A'.repeat(80),
      'José García-Ñoño',
      '   ',
    ]) {
      const slug = assignLocalSlug(name, neverTaken)
      expect(SLUG_RE.test(slug), `"${name}" → "${slug}" must match grammar`).toBe(true)
      // validateSlugFormat is grammar-only — throws on double-hyphen / trailing-hyphen
      expect(() => validateSlugFormat(slug)).not.toThrow()
    }
  })

  test('all-symbols name falls back to the neutral base, never a violation', () => {
    expect(assignLocalSlug('@#$%', neverTaken)).toBe(FALLBACK_LOCAL_SLUG_BASE)
  })

  test('a grammar-legal name is emitted as the bare base (no reserved-list filtering)', () => {
    // After the T1 RESERVED_SLUGS rip, a member's local_slug is an in-DB
    // attribution handle, never a hostname — so there is no reserved set to
    // dodge. "admin" is a perfectly valid bare base.
    const slug = assignLocalSlug('admin', neverTaken)
    expect(slug).toBe('admin')
    expect(() => validateSlugFormat(slug)).not.toThrow()
  })
})

describe('assignLocalSlug — collision discipline (backs brief test #2)', () => {
  test('two members with the same name get DISTINCT slugs', () => {
    const taken = new Set<string>()
    const isTaken = (s: string): boolean => taken.has(s)

    const a = assignLocalSlug('Mona', isTaken)
    taken.add(a)
    const b = assignLocalSlug('Mona', isTaken)
    taken.add(b)
    const c = assignLocalSlug('Mona', isTaken)

    expect(a).toBe('mona')
    expect(b).toBe('mona-2')
    expect(c).toBe('mona-3')
    expect(new Set([a, b, c]).size).toBe(3)
    for (const s of [a, b, c]) expect(SLUG_RE.test(s)).toBe(true)
  })

  test('suffix path also applies to fallback-base collisions', () => {
    const taken = new Set<string>([FALLBACK_LOCAL_SLUG_BASE])
    const slug = assignLocalSlug('###', (s) => taken.has(s))
    expect(slug).toBe(`${FALLBACK_LOCAL_SLUG_BASE}-2`)
  })
})
