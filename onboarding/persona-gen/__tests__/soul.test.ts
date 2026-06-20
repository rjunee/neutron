/**
 * SOUL.md generator tests.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchetypeLibrary } from '../../archetypes/library.ts'
import { composeArchetypeBlend } from '../../archetypes/compose.ts'
import { generateSoulMd } from '../soul.ts'
import { deterministicCringe } from '../cringe-check.ts'

const dataDir = join(import.meta.dir, '..', '..', 'archetypes', 'data')

describe('generateSoulMd', () => {
  test('produces a SOUL.md with the locked sections', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'soul-'))
    try {
      const lib = new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') })
      const blend = composeArchetypeBlend([lib.get('odin')!, lib.get('thoth')!])
      const md = generateSoulMd({
        archetype_blend: blend,
        signals: {
          display_name: 'Alex',
          rituals: ['morning meditation'],
          time_style: 'async-low',
        },
      })
      expect(md).toContain('# SOUL.md')
      expect(md).toContain('## Archetypal Blend')
      expect(md).toContain('## Operating Principles')
      expect(md).toContain('## Communication Style')
      expect(md).toContain('## Decision Style')
      expect(md).toContain('Odin')
      expect(md).toContain('Thoth')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('output passes the deterministic cringe-check (no em-dashes from generated text)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'soul-'))
    try {
      const lib = new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') })
      const blend = composeArchetypeBlend([lib.get('marcus-aurelius')!])
      const md = generateSoulMd({
        archetype_blend: blend,
        signals: {
          display_name: 'Alex',
          rituals: ['morning meditation', 'evening journal'],
          time_style: 'async-low',
        },
      })
      const r = deterministicCringe(md)
      // Curated archetype md files are hand-tuned to be em-dash-free, so
      // the generator's output stays clean.
      expect(r.flags).toBe(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('Dharma Thread section appears when contemplative phrases captured', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'soul-'))
    try {
      const lib = new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') })
      const blend = composeArchetypeBlend([lib.get('padmasambhava')!])
      const md = generateSoulMd({
        archetype_blend: blend,
        signals: {
          display_name: 'Alex',
          contemplative_phrases: ['meditation', 'mindfulness'],
        },
      })
      expect(md).toContain('## Dharma Thread')
      expect(md).toContain('meditation')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
