/**
 * Persona compose round-trip — line-edit + recommit.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchetypeLibrary } from '../../archetypes/library.ts'
import { composeArchetypeBlend } from '../../archetypes/compose.ts'
import { PersonaComposer, PersonaError } from '../compose.ts'
import { buildCringeChecker } from '../cringe-check.ts'

const dataDir = join(import.meta.dir, '..', '..', 'archetypes', 'data')

describe('PersonaComposer compose + applyEdit + commit', () => {
  test('compose produces draft with 0 cringe flags on clean input', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pc-'))
    try {
      const lib = new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') })
      const blend = composeArchetypeBlend([lib.get('marcus-aurelius')!])
      const composer = new PersonaComposer({
        cringeChecker: buildCringeChecker({ threshold: 3 }),
      })
      const draft = await composer.compose({
        project_slug: 't1',
        archetype_blend: blend,
        signals: { display_name: 'Alex' },
        user_facts: { display_name: 'Alex' },
        priority_map: { programs: [{ name: 'core work', tier: 'P0', rationale: 'first lever' }] },
      })
      expect(draft.cringe_check_flags.soul).toBe(0)
      expect(draft.regen_attempts.soul).toBe(0)
      expect(draft.soul_md.length).toBeGreaterThan(50)
      expect(draft.user_md.length).toBeGreaterThan(20)
      expect(draft.priority_map_md.length).toBeGreaterThan(50)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('applyEdit replaces a line + re-runs cringe-check', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pc-'))
    try {
      const lib = new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') })
      const blend = composeArchetypeBlend([lib.get('musashi')!])
      const composer = new PersonaComposer({
        cringeChecker: buildCringeChecker({ threshold: 3 }),
      })
      const draft = await composer.compose({
        project_slug: 't1',
        archetype_blend: blend,
        signals: { display_name: 'Alex' },
        user_facts: { display_name: 'Alex' },
        priority_map: { programs: [{ name: 'core', tier: 'P1', rationale: 'this' }] },
      })
      const lines_before = draft.soul_md.split('\n')
      const target_line = lines_before.findIndex((l) => l.includes('# SOUL.md')) + 1
      expect(target_line).toBeGreaterThan(0)
      const next = await composer.applyEdit({
        draft,
        file: 'soul',
        edit: { line: target_line, replacement: '# SOUL.md (Alex)' },
      })
      expect(next.soul_md).toContain('# SOUL.md (Alex)')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('applyEdit rejects out-of-range line', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pc-'))
    try {
      const lib = new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') })
      const blend = composeArchetypeBlend([lib.get('thoth')!])
      const composer = new PersonaComposer({
        cringeChecker: buildCringeChecker({ threshold: 3 }),
      })
      const draft = await composer.compose({
        project_slug: 't1',
        archetype_blend: blend,
        signals: { display_name: 'A' },
        user_facts: { display_name: 'A' },
        priority_map: { programs: [{ name: 'X', tier: 'P0', rationale: '' }] },
      })
      await expect(
        composer.applyEdit({
          draft,
          file: 'soul',
          edit: { line: 99_999, replacement: 'whatever' },
        }),
      ).rejects.toThrow(PersonaError)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('commit writes 3 files to disk', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pc-'))
    try {
      const lib = new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') })
      const blend = composeArchetypeBlend([lib.get('thoth')!])
      const composer = new PersonaComposer({
        cringeChecker: buildCringeChecker({ threshold: 3 }),
        ownerHomeFor: (_slug) => join(tmp, 'home', _slug),
      })
      const draft = await composer.compose({
        project_slug: 't1',
        archetype_blend: blend,
        signals: { display_name: 'A' },
        user_facts: { display_name: 'A' },
        priority_map: { programs: [{ name: 'X', tier: 'P0', rationale: '' }] },
      })
      const result = await composer.commit(draft)
      expect(result.paths).toHaveLength(3)
      expect(result.git_sha).toBeNull()
      const { existsSync } = await import('node:fs')
      expect(existsSync(result.paths[0]!)).toBe(true)
      expect(existsSync(result.paths[1]!)).toBe(true)
      expect(existsSync(result.paths[2]!)).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
