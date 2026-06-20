/**
 * P2 v2 S8 — composeFromFreeText tests.
 *
 * Verifies the helper that derives a `BlendedArchetype` from a free-text
 * `agent_personality` phrase. Curated archetype mentions land curated
 * voice fragments; phrases with no curated mention return a free-text
 * blend with the phrase preserved verbatim.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchetypeLibrary, ArchetypeError } from '../library.ts'
import { composeFromFreeText } from '../compose.ts'

const dataDir = join(import.meta.dir, '..', 'data')

function fixture(): { lib: ArchetypeLibrary; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'free-text-blend-'))
  return {
    lib: new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') }),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

describe('composeFromFreeText', () => {
  test('phrase with a single curated mention returns the curated blend', () => {
    const { lib, cleanup } = fixture()
    try {
      const blend = composeFromFreeText(
        'I want a Sherlock-style sharp investigator who pushes back',
        { library: lib },
      )
      expect(blend.slugs).toEqual(['sherlock-holmes'])
      expect(blend.voice_md).toContain('Sherlock')
    } finally {
      cleanup()
    }
  })

  test('phrase with no curated mention returns a free-text blend that preserves the phrase verbatim', () => {
    const { lib, cleanup } = fixture()
    try {
      const phrase = 'a sharp strategist who pushes back when I am hand-waving'
      const blend = composeFromFreeText(phrase, { library: lib })
      expect(blend.slugs).toEqual(['free-text'])
      expect(blend.display_label).toBe('Free-text personality')
      expect(blend.voice_md).toContain(phrase)
      expect(blend.comm_md).toContain(phrase)
    } finally {
      cleanup()
    }
  })

  test('phrase with multiple curated mentions blends them up to MAX_BLEND', () => {
    const { lib, cleanup } = fixture()
    try {
      const blend = composeFromFreeText(
        'A Gandalf-with-Marcus-Aurelius temperament; touch of Musashi precision',
        { library: lib },
      )
      // Curated names must all land in the blend (order = library iteration).
      expect(blend.slugs).toContain('gandalf-the-white')
      expect(blend.slugs).toContain('marcus-aurelius')
      expect(blend.slugs).toContain('musashi')
      expect(blend.slugs).not.toContain('free-text')
    } finally {
      cleanup()
    }
  })

  test('library omitted → always returns a free-text blend even when phrase contains a curated name', () => {
    const blend = composeFromFreeText('I want a Sherlock-style investigator')
    expect(blend.slugs).toEqual(['free-text'])
    expect(blend.voice_md).toContain('Sherlock')
  })

  test('rejects empty / whitespace-only phrase', () => {
    expect(() => composeFromFreeText('')).toThrow(ArchetypeError)
    expect(() => composeFromFreeText('   ')).toThrow(ArchetypeError)
  })

  test('does not match curated archetypes off short common-word prefixes', () => {
    const { lib, cleanup } = fixture()
    try {
      // "the warm one" must not land an archetype whose slug starts
      // with "the" or whose display name has "the" as a token.
      const blend = composeFromFreeText('the warm one who listens', { library: lib })
      expect(blend.slugs).toEqual(['free-text'])
    } finally {
      cleanup()
    }
  })
})
