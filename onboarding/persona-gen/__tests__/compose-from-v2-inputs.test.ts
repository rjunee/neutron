/**
 * P2 v2 S8 — persona-gen consumes v2 collected_data.
 *
 * Builds a v2 InterviewSignals + UserFacts + PriorityMapInput fixture and
 * asserts the three persona files (`SOUL.md`, `USER.md`, `priority-map.md`)
 * carry the v2 fields. Verifies the canonical H1 headers stay intact for
 * downstream consumers (the stripPersonaFileH1 helper in phase-prompts
 * runs at the user-facing render boundary, not at composition time).
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchetypeLibrary } from '../../archetypes/library.ts'
import { composeFromFreeText } from '../../archetypes/compose.ts'
import {
  PersonaComposer,
  type ComposeInput,
} from '../compose.ts'
import { deterministicCringe, type CringeChecker } from '../cringe-check.ts'
import { generateSoulMd } from '../soul.ts'
import { generateUserMd } from '../user.ts'
import { generatePriorityMapMd } from '../priority-map.ts'

const dataDir = join(import.meta.dir, '..', '..', 'archetypes', 'data')

const CASEY_PERSONALITY =
  'warm thinking-partner with a sharp edge, explains the why, pushes back when I am spiraling'

const CASEY_PROJECTS: ReadonlyArray<string> = [
  'Acme (fragrance brand)',
  'Hera concept (perfume #1)',
  'Wholesale-distribution playbook',
]

const CASEY_INTERESTS: ReadonlyArray<string> = [
  'yoga (3x/week)',
  'mixing playlists for the family',
  'rare-book hunting',
]

const CASEY_INNER_CIRCLE: ReadonlyArray<string> = [
  'Jordan (husband)',
  'Maya (daughter)',
  'Zoe (daughter)',
  'Sam (perfumer)',
]

const CASEY_COMPANIES: ReadonlyArray<string> = [
  'Acme (founder + creative director)',
]

const CASEY_WORK_THEMES: ReadonlyArray<string> = [
  'fragrance product development',
  'Acme brand voice',
  'supply chain logistics',
]

function buildLibrary(tmp: string): ArchetypeLibrary {
  return new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') })
}

function nonCringeChecker(): CringeChecker {
  // Use the deterministic cringe check at a high threshold so the
  // fixture's clean text passes without forcing the regenerator.
  return {
    threshold: 999,
    async check({ content }): Promise<{ flags: number; reasons: string[] }> {
      return deterministicCringe(content)
    },
  }
}

describe('persona-gen consumes v2 collected_data', () => {
  test('SOUL.md surfaces agent_personality + primary_projects + non_work_interests', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v2-soul-'))
    try {
      const blend = composeFromFreeText(CASEY_PERSONALITY)
      const md = generateSoulMd({
        archetype_blend: blend,
        signals: {
          display_name: 'Sage',
          user_first_name: 'Casey',
          agent_name: 'Sage',
          agent_personality: CASEY_PERSONALITY,
          primary_projects: CASEY_PROJECTS,
          non_work_interests: CASEY_INTERESTS,
          inner_circle: CASEY_INNER_CIRCLE,
        },
      })
      expect(md).toContain('# SOUL.md')
      expect(md).toContain('You are Sage')
      expect(md).toContain('work with Casey')
      expect(md).toContain(CASEY_PERSONALITY)
      // primary_projects + non_work_interests fold into Operating Principles
      for (const p of CASEY_PROJECTS) expect(md).toContain(p)
      for (const i of CASEY_INTERESTS) expect(md).toContain(i)
      // inner_circle anchors the relationship-awareness principle
      for (const person of CASEY_INNER_CIRCLE) expect(md).toContain(person)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('USER.md renders Companies / Key Projects / Inner Circle / Outside Interests', () => {
    const md = generateUserMd({
      display_name: 'Casey',
      companies: CASEY_COMPANIES,
      primary_projects: CASEY_PROJECTS,
      non_work_interests: CASEY_INTERESTS,
      inner_circle: CASEY_INNER_CIRCLE,
    })
    expect(md).toContain('# USER.md')
    expect(md).toContain('## Companies')
    expect(md).toContain('Acme (founder + creative director)')
    expect(md).toContain('## Key Projects')
    for (const p of CASEY_PROJECTS) expect(md).toContain(p)
    expect(md).toContain('## Inner Circle')
    for (const person of CASEY_INNER_CIRCLE) expect(md).toContain(person)
    expect(md).toContain('## Outside Interests')
    for (const i of CASEY_INTERESTS) expect(md).toContain(i)
    // Preamble names the user + their first company.
    expect(md.split('\n').slice(1, 4).join(' ')).toContain('Casey')
  })

  test('priority-map.md Programs section is sourced from primary_projects + work_themes', () => {
    const md = generatePriorityMapMd({
      primary_projects: CASEY_PROJECTS,
      work_themes: CASEY_WORK_THEMES,
      tier_1_people: CASEY_INNER_CIRCLE,
    })
    expect(md).toContain('# priority-map.md')
    expect(md).toContain('## Programs')
    for (const p of CASEY_PROJECTS) expect(md).toContain(p)
    expect(md).toContain('### Work themes')
    for (const t of CASEY_WORK_THEMES) expect(md).toContain(t)
    expect(md).toContain('## People Priority')
    for (const person of CASEY_INNER_CIRCLE) expect(md).toContain(person)
  })

  test('PersonaComposer.compose() returns three files with v2 content + commits them to disk', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v2-persona-flow-'))
    try {
      const lib = buildLibrary(tmp)
      const composer = new PersonaComposer({
        cringeChecker: nonCringeChecker(),
        ownerHomeFor: (slug: string): string => join(tmp, slug, 'persona'),
      })
      const input: ComposeInput = {
        project_slug: 'casey',
        archetype_blend: composeFromFreeText(CASEY_PERSONALITY, { library: lib }),
        signals: {
          display_name: 'Sage',
          user_first_name: 'Casey',
          agent_name: 'Sage',
          agent_personality: CASEY_PERSONALITY,
          primary_projects: CASEY_PROJECTS,
          non_work_interests: CASEY_INTERESTS,
          work_themes: CASEY_WORK_THEMES,
          companies: CASEY_COMPANIES,
          inner_circle: CASEY_INNER_CIRCLE,
        },
        user_facts: {
          display_name: 'Casey',
          companies: CASEY_COMPANIES,
          primary_projects: CASEY_PROJECTS,
          non_work_interests: CASEY_INTERESTS,
          inner_circle: CASEY_INNER_CIRCLE,
        },
        priority_map: {
          programs: [],
          primary_projects: CASEY_PROJECTS,
          work_themes: CASEY_WORK_THEMES,
          tier_1_people: CASEY_INNER_CIRCLE,
        },
      }
      const draft = await composer.compose(input)
      // Canonical H1s are preserved on disk for downstream consumers
      // (the stripPersonaFileH1 helper at the user-facing render
      // boundary peels them off when rendering the review excerpt).
      expect(draft.soul_md.startsWith('# SOUL.md')).toBe(true)
      expect(draft.user_md.startsWith('# USER.md')).toBe(true)
      expect(draft.priority_map_md.startsWith('# priority-map.md')).toBe(true)
      expect(draft.soul_md).toContain(CASEY_PERSONALITY)
      expect(draft.user_md).toContain('Acme')
      expect(draft.priority_map_md).toContain('Acme (fragrance brand)')

      const commit = await composer.commit(draft)
      expect(commit.paths.length).toBe(3)
      const onDiskSoul = readFileSync(commit.paths[0]!, 'utf8')
      const onDiskUser = readFileSync(commit.paths[1]!, 'utf8')
      const onDiskMap = readFileSync(commit.paths[2]!, 'utf8')
      expect(onDiskSoul).toContain(CASEY_PERSONALITY)
      expect(onDiskUser).toContain('## Outside Interests')
      expect(onDiskMap).toContain('## Programs')
      // Files written under <tmp>/casey/persona/SOUL.md etc.
      expect(commit.paths[0]).toContain('casey/persona/SOUL.md')
      expect(commit.paths[1]).toContain('casey/persona/USER.md')
      expect(commit.paths[2]).toContain('casey/persona/priority-map.md')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
