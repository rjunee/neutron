/**
 * gap-audit item 10 — unit coverage for the operating-doctrine layer
 * (`operating-doctrine.ts`). Asserts the doctrine is the SAME owner-agnostic
 * principle set on every surface, that it never leaks owner-specific content,
 * and that only the per-context weighting tail differs General vs project.
 */
import { describe, expect, test } from 'bun:test'

import {
  DOCTRINE_PRINCIPLES,
  buildOperatingDoctrineFragment,
} from '../operating-doctrine.ts'

describe('operating-doctrine — principle set', () => {
  test('every principle appears in the General fragment, numbered', () => {
    const frag = buildOperatingDoctrineFragment({ scope: 'general' })
    expect(DOCTRINE_PRINCIPLES.length).toBeGreaterThanOrEqual(6)
    for (let i = 0; i < DOCTRINE_PRINCIPLES.length; i++) {
      expect(frag).toContain(`${i + 1}. ${DOCTRINE_PRINCIPLES[i]}`)
    }
  })

  test('the lived "how you act" doctrine — anti-sycophancy, calibrated confidence, reframe — is present', () => {
    const frag = buildOperatingDoctrineFragment({ scope: 'general' })
    expect(frag).toContain('<operating_doctrine')
    expect(frag.toLowerCase()).toContain('no sycophancy')
    expect(frag.toLowerCase()).toContain('calibrated confidence')
    expect(frag.toLowerCase()).toContain('truth first')
    // The dharma/grounding-reframe layer, kept general (no owner reframes).
    expect(frag.toLowerCase()).toContain('grounding reframe')
    // It composes WITH the SOUL, deferring to a sharper owner rule.
    expect(frag.toLowerCase()).toContain('who you are')
    expect(frag.toLowerCase()).toContain('how you act')
  })

  test('the principle body is byte-identical across surfaces (consistency)', () => {
    const general = buildOperatingDoctrineFragment({ scope: 'general' })
    const project = buildOperatingDoctrineFragment({ scope: 'project', project_id: 'gondor' })
    for (const principle of DOCTRINE_PRINCIPLES) {
      expect(general).toContain(principle)
      expect(project).toContain(principle)
    }
  })

  test('contains NO hardcoded owner-specific content (general / self-hoster doctrine)', () => {
    const frag = buildOperatingDoctrineFragment({ scope: 'general' })
    // No owner name, no Vajra archetypes, no owner-private reframes leaked in.
    for (const banned of ['Ryan', 'Vajra', 'Odin', 'Thoth', 'Padmasambhava', 'firewood']) {
      expect(frag).not.toContain(banned)
    }
  })
})

describe('operating-doctrine — per-context weighting', () => {
  test('General weights toward cross-project breadth', () => {
    const frag = buildOperatingDoctrineFragment({ scope: 'general' })
    expect(frag).toContain('scope="general"')
    expect(frag.toLowerCase()).toContain('cross-project')
    expect(frag.toLowerCase()).toContain('whole picture')
  })

  test('a project topic weights toward this-project craft and names the project', () => {
    const frag = buildOperatingDoctrineFragment({ scope: 'project', project_id: 'minas-tirith' })
    expect(frag).toContain('scope="project"')
    expect(frag).toContain('the "minas-tirith" project')
    expect(frag.toLowerCase()).toContain('keep any grounding reframe especially light')
  })

  test('project scope without a project_id still renders (generic "this project")', () => {
    const frag = buildOperatingDoctrineFragment({ scope: 'project' })
    expect(frag).toContain('scope="project"')
    expect(frag).toContain('this project')
  })
})
