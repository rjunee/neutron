/**
 * LLM-extension tests — cache-on-second-call (mocked LLM).
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchetypeLibrary, ArchetypeError } from '../library.ts'
import { parseExtensionMarkdown, InMemoryExtensionCache } from '../llm-extension.ts'

const dataDir = join(import.meta.dir, '..', 'data')

describe('LLM extension via library cache', () => {
  test('first call dispatches; second call hits disk cache without re-dispatching', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llm-ext-'))
    try {
      let dispatchCount = 0
      const lib = new ArchetypeLibrary({
        dataDir,
        cacheDir: join(tmp, 'cache'),
        generateExtension: async (_name) => {
          dispatchCount += 1
          return {
            voice_md: 'Voice fragment for the test extension.',
            comm_md: 'Crisp.',
            decision_md: 'Pick the move.',
          }
        },
      })
      const a = await lib.generateExtension('Bilbo Baggins')
      expect(a.slug).toBe('bilbo-baggins')
      expect(a.display_name).toBe('Bilbo Baggins')
      expect(dispatchCount).toBe(1)

      // Second call returns cached fragment without dispatching.
      const lib2 = new ArchetypeLibrary({
        dataDir,
        cacheDir: join(tmp, 'cache'),
        generateExtension: async (_name) => {
          dispatchCount += 1
          throw new Error('should NOT be called on cached re-fetch')
        },
      })
      const b = await lib2.generateExtension('Bilbo Baggins')
      expect(b.slug).toBe(a.slug)
      expect(b.voice_md).toBe(a.voice_md)
      expect(dispatchCount).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('throws ArchetypeError when generator is missing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llm-ext-'))
    try {
      const lib = new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') })
      await expect(lib.generateExtension('Random Guy')).rejects.toThrow(ArchetypeError)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('parseExtensionMarkdown', () => {
  test('parses canonical markdown shape into 3 sections', () => {
    const md = `## Voice

Sample voice paragraph.

## Communication

Crisp.

## Decision

Pick the move.`
    const parts = parseExtensionMarkdown(md, 'test')
    expect(parts.voice_md).toContain('Sample voice paragraph')
    expect(parts.comm_md).toContain('Crisp')
    expect(parts.decision_md).toContain('Pick the move')
  })

  test('throws when a section is missing', () => {
    expect(() => parseExtensionMarkdown('## Voice\n\njust this', 'incomplete')).toThrow()
  })

  test('strips code-fence wrapping', () => {
    const wrapped = '```markdown\n## Voice\n\nA\n\n## Communication\n\nB\n\n## Decision\n\nC\n```'
    const parts = parseExtensionMarkdown(wrapped, 'fenced')
    expect(parts.voice_md).toBe('A')
    expect(parts.comm_md).toBe('B')
    expect(parts.decision_md).toBe('C')
  })
})

describe('InMemoryExtensionCache', () => {
  test('put + get round-trip', () => {
    const cache = new InMemoryExtensionCache()
    expect(cache.has('Bilbo')).toBe(false)
    cache.put('Bilbo', { voice_md: 'v', comm_md: 'c', decision_md: 'd' })
    expect(cache.has('Bilbo')).toBe(true)
    expect(cache.get('Bilbo')!.voice_md).toBe('v')
  })
})
