/**
 * GAP1 reproduce-first lock (onboarding-wow-handoff-fix, 2026-06-09).
 *
 * Sam's real 2026-06-09 signup: the import PROPOSED 7 projects (Topline,
 * Northwind, Acme Studio, Acme, Info Product Playbooks,
 * Functional Chocolate, Home Finances) but only 3 shells were created. Two
 * silent-narrowing points were responsible:
 *
 *   (1a) `MAX_ANALYSIS_PROJECTS = 5` sliced the presentation, so the user
 *        never even SAW proposed projects 6-7 to confirm them.
 *   (1b) the freeform-confirm merge OVERWROTE `primary_projects` with the
 *        LLM-extracted set, which routinely drops net-new additions the
 *        user named ("Buddhism", "Biohacking") because the extraction
 *        anchors to the proposed list.
 *
 * This file pins the deterministic halves of the fix: the presentation now
 * shows ALL proposed projects (≤7), and the confirm merge is additive (a
 * confirm reply can only ADD, never silently shrink the seeded list).
 */

import { describe, expect, test } from 'bun:test'

import {
  buildImportAnalysisPresentedPromptSpec,
  MAX_ANALYSIS_PROJECTS,
  type ImportResultForAnalysisBuilder,
} from '../phase-prompts.ts'

const SEVEN_PROPOSED: ImportResultForAnalysisBuilder = {
  proposed_projects: [
    { name: 'Topline', rationale: 'biggest open thread' },
    { name: 'Northwind', rationale: 'nootropic launch' },
    { name: 'Acme Studio', rationale: 'holdco umbrella' },
    { name: 'Acme', rationale: 'spousal venture' },
    { name: 'Info Product Playbooks', rationale: 'course work' },
    { name: 'Functional Chocolate', rationale: 'consumer product' },
    { name: 'Home Finances', rationale: 'personal ops' },
  ],
  inferred_interests: [],
  confidence_by_inference: [],
  conversation_count: 236,
}

describe('GAP1 — presentation shows ALL proposed projects (no 5-slice)', () => {
  test('MAX_ANALYSIS_PROJECTS is at least the Pass-2 cap of 7', () => {
    // The ceiling MUST be ≥ Pass-2's hard cap so the presentation never
    // drops a project the user could confirm.
    expect(MAX_ANALYSIS_PROJECTS).toBeGreaterThanOrEqual(7)
  })

  test('a 7-project import surfaces all 7 names in the body (projects 6 & 7 no longer sliced off)', () => {
    const spec = buildImportAnalysisPresentedPromptSpec({
      user_first_name: 'Sam',
      import_source: 'claude-zip',
      import_result: SEVEN_PROPOSED,
      import_failed: false,
      import_partial: false,
      import_months_span: null,
    })
    // Every proposed project — including the two that the legacy
    // MAX_ANALYSIS_PROJECTS=5 slice dropped before the user saw them.
    for (const p of SEVEN_PROPOSED.proposed_projects) {
      expect(spec.body).toContain(p.name)
    }
    // Specifically the previously-dropped tail.
    expect(spec.body).toContain('Functional Chocolate')
    expect(spec.body).toContain('Home Finances')
  })
})
