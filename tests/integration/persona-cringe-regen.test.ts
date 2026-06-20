/**
 * Integration test — persona cringe-check regen + cap (P2 S2 § 6a).
 *
 * Given: a deliberately-cringey interview state (the spec's exact phrase:
 *   "I just LOVE collaborating with synergistic partners to unlock value").
 * Plus a CringeChecker booted with the default threshold (3) and a
 * regenerator whose drafts always retain at least 3 flag markers, so the
 * loop hits the regenCap=3 ceiling.
 *
 * When: PersonaComposer.compose(...) runs.
 *
 * Then: each regen attempt still flags ≥ 3 patterns, the cap fires after
 * 3 attempts, and PersonaError{code:'cringe_cap_exceeded'} surfaces.
 */

import { describe, expect, test } from 'bun:test'
import {
  ArchetypeLibrary,
  PersonaComposer,
  PersonaError,
  buildCringeChecker,
  composeArchetypeBlend,
  type PersonaRegenerator,
  type PersonaFile,
} from '@neutronai/onboarding/index.ts'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

describe('persona cringe-check regen integration', () => {
  test('three regen attempts then cringe_cap_exceeded on a cringey fixture', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-cringe-int-'))
    try {
      const dataDir = join(import.meta.dir, '..', '..', 'onboarding', 'archetypes', 'data')
      const lib = new ArchetypeLibrary({ dataDir, cacheDir: join(tmp, 'cache') })
      const odin = lib.get('odin')
      const thoth = lib.get('thoth')
      expect(odin).not.toBeNull()
      expect(thoth).not.toBeNull()
      const blend = composeArchetypeBlend([odin!, thoth!])

      const cringeChecker = buildCringeChecker({ threshold: 3 })

      // The regenerator returns a draft that ALWAYS retains 3+ flag
      // markers. Per § 6a: substrate "returns increasingly-de-cringed
      // drafts but always retains at least 3 flag markers for the test."
      const regenLog: Array<{ file: PersonaFile; attempt: number }> = []
      const attempts: Record<PersonaFile, number> = { soul: 0, user: 0, priority_map: 0 }
      const regenerator: PersonaRegenerator = {
        async regenerate({ file }) {
          attempts[file] += 1
          regenLog.push({ file, attempt: attempts[file] })
          // Each attempt removes a few cringey phrases but keeps three
          // residual ones so the threshold is still hit.
          const noise =
            attempts[file] === 1
              ? '— synergistic — game-changer — unlock value '
              : attempts[file] === 2
                ? '— synergy game-changer cutting-edge '
                : '— synergistic cutting-edge revolutionary '
          return `# regen ${file} #${attempts[file]}\n\n${noise}\nNo other content.\n`
        },
      }

      const composer = new PersonaComposer({
        cringeChecker,
        regenerator,
        regenCap: 3,
      })

      const cringeySignals = {
        display_name: 'Test User',
        rituals: ['I just LOVE collaborating with synergistic partners to unlock value'],
        work_pattern: 'cutting-edge — synergy — unlock value',
        time_style: 'async-low',
      }

      let caught: PersonaError | null = null
      try {
        await composer.compose({
          project_slug: 'cringe-test',
          archetype_blend: blend,
          signals: cringeySignals,
          user_facts: { display_name: 'Test User' },
          priority_map: {
            programs: [
              { name: 'unlock value', tier: 'P1', rationale: 'world-class — synergistic' },
            ],
          },
        })
      } catch (err) {
        if (err instanceof PersonaError) caught = err
        else throw err
      }
      expect(caught).not.toBeNull()
      expect(caught!.code).toBe('cringe_cap_exceeded')
      // The cap was hit on `soul` — first file in the loop.
      expect(attempts.soul).toBe(3)
      expect(regenLog.length).toBeGreaterThanOrEqual(3)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
