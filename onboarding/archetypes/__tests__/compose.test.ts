/**
 * Archetype compose tests — 1/2/3-archetype blends produce stable output.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchetypeLibrary, ArchetypeError } from '../library.ts'
import { composeArchetypeBlend, MAX_BLEND } from '../compose.ts'

const dataDir = join(import.meta.dir, '..', 'data')

function lib(): { lib: ArchetypeLibrary; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'arch-comp-'))
  return {
    lib: new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') }),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

describe('composeArchetypeBlend', () => {
  test('1-archetype blend renders single section', () => {
    const { lib: l, cleanup } = lib()
    try {
      const odin = l.get('odin')!
      const blend = composeArchetypeBlend([odin])
      expect(blend.slugs).toEqual(['odin'])
      expect(blend.display_label).toBe('Odin')
      expect(blend.voice_md).toContain('Odin')
      expect(blend.comm_md).toContain('Odin')
      expect(blend.decision_md).toContain('Odin')
    } finally {
      cleanup()
    }
  })

  test('2-archetype blend renders both', () => {
    const { lib: l, cleanup } = lib()
    try {
      const blend = composeArchetypeBlend([l.get('odin')!, l.get('thoth')!])
      expect(blend.slugs).toEqual(['odin', 'thoth'])
      expect(blend.display_label).toBe('Odin / Thoth')
      expect(blend.voice_md).toContain('### Odin')
      expect(blend.voice_md).toContain('### Thoth')
    } finally {
      cleanup()
    }
  })

  test('3-archetype blend is stable across pick reorder', () => {
    const { lib: l, cleanup } = lib()
    try {
      const a = composeArchetypeBlend([l.get('odin')!, l.get('thoth')!, l.get('musashi')!])
      const b = composeArchetypeBlend([l.get('musashi')!, l.get('odin')!, l.get('thoth')!])
      expect(a.slugs).toEqual(b.slugs)
      expect(a.display_label).toBe(b.display_label)
      expect(a.voice_md).toBe(b.voice_md)
    } finally {
      cleanup()
    }
  })

  test('dedupes repeated picks', () => {
    const { lib: l, cleanup } = lib()
    try {
      const odin = l.get('odin')!
      const blend = composeArchetypeBlend([odin, odin, odin])
      expect(blend.slugs).toEqual(['odin'])
    } finally {
      cleanup()
    }
  })

  test('rejects empty pick list', () => {
    expect(() => composeArchetypeBlend([])).toThrow(ArchetypeError)
  })

  test(`rejects more than ${MAX_BLEND} archetypes`, () => {
    const { lib: l, cleanup } = lib()
    try {
      const fives = [l.get('odin')!, l.get('thoth')!, l.get('musashi')!, l.get('shiva')!, l.get('athena')!]
      expect(() => composeArchetypeBlend(fives)).toThrow(ArchetypeError)
    } finally {
      cleanup()
    }
  })
})
