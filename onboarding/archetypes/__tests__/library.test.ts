/**
 * Archetype library tests — loads + indexes the 24 curated md files.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchetypeLibrary, diceCoefficient } from '../library.ts'

const dataDir = join(import.meta.dir, '..', 'data')

function freshLibrary(): { lib: ArchetypeLibrary; tmp: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'arch-lib-'))
  const lib = new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') })
  return { lib, tmp }
}

describe('ArchetypeLibrary', () => {
  test('loads exactly 24 curated archetypes', () => {
    const { lib, tmp } = freshLibrary()
    try {
      expect(lib.list()).toHaveLength(24)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('all 24 expected slugs are present', () => {
    const { lib, tmp } = freshLibrary()
    try {
      const expected = [
        'odin', 'thoth', 'padmasambhava', 'krishna', 'athena', 'shiva',
        'quan-yin', 'loki', 'gandalf-the-white', 'sherlock-holmes',
        'hermione-granger', 'captain-picard', 'dumbledore', 'lisbeth-salander',
        'atticus-finch', 'jane-eyre', 'musashi', 'marcus-aurelius', 'da-vinci',
        'curie', 'feynman', 'carl-jung', 'cleopatra', 'sun-tzu',
      ]
      for (const slug of expected) {
        expect(lib.get(slug)).not.toBeNull()
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('each archetype has voice / comm / decision sections populated', () => {
    const { lib, tmp } = freshLibrary()
    try {
      for (const arch of lib.list()) {
        expect(arch.voice_md.length).toBeGreaterThan(20)
        expect(arch.comm_md.length).toBeGreaterThan(10)
        expect(arch.decision_md.length).toBeGreaterThan(5)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('matchByName: exact display_name (case-insensitive)', () => {
    const { lib, tmp } = freshLibrary()
    try {
      const odin = lib.matchByName('Odin')
      expect(odin).not.toBeNull()
      expect(odin!.slug).toBe('odin')

      const sun_tzu = lib.matchByName('sun tzu')
      expect(sun_tzu).not.toBeNull()
      expect(sun_tzu!.slug).toBe('sun-tzu')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('matchByName: fuzzy match handles a small typo above threshold', () => {
    const { lib, tmp } = freshLibrary()
    try {
      // "Marcus Aurellius" (extra l) → "marcus aurelius" by Dice on bigrams
      // is well above the 0.85 default threshold.
      const aur = lib.matchByName('Marcus Aurellius')
      expect(aur).not.toBeNull()
      expect(aur!.slug).toBe('marcus-aurelius')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('Codex r9 P2: token-overlap matches short inputs to multi-word curated names', () => {
    const { lib, tmp } = freshLibrary()
    try {
      const cases: Array<[string, string]> = [
        ['Gandalf', 'gandalf-the-white'],
        ['Picard', 'captain-picard'],
        ['Atticus', 'atticus-finch'],
        ['Holmes', 'sherlock-holmes'],
        ['Sherlock', 'sherlock-holmes'],
        ['Jane Eyre', 'jane-eyre'],
        ['Lisbeth', 'lisbeth-salander'],
      ]
      for (const [input, expected] of cases) {
        const r = lib.matchByName(input)
        expect(r).not.toBeNull()
        expect(r!.slug).toBe(expected)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('matchByName returns null below threshold', () => {
    const { lib, tmp } = freshLibrary()
    try {
      expect(lib.matchByName('completely-unknown-character')).toBeNull()
      expect(lib.matchByName('')).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('archetype source classifications match § 2.2', () => {
    const { lib, tmp } = freshLibrary()
    try {
      expect(lib.get('odin')!.source).toBe('mythological')
      expect(lib.get('musashi')!.source).toBe('historical')
      expect(lib.get('sherlock-holmes')!.source).toBe('fictional')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('diceCoefficient: identical strings return 1.0', () => {
    expect(diceCoefficient('odin', 'odin')).toBe(1)
  })

  test('diceCoefficient: high overlap returns score > 0.5', () => {
    expect(diceCoefficient('sherlock', 'sherlock holmes')).toBeGreaterThan(0.5)
  })
})
