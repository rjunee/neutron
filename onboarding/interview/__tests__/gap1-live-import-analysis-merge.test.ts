/**
 * GAP1 — additive project merge on the import-analysis review path
 * (Argus r2 BLOCKER, onboarding-wow-handoff-fix r3, 2026-06-09).
 *
 * The regression: Sam's 2026-06-09 signup seeded 7 import-proposed projects
 * and shelled only 3. On a confirm/restate reply at `import_analysis_presented`
 * ("go with A, B, C, D, E") the field extractor's `primary_projects` anchors to
 * the proposed list and returns a SHORTER set, dropping the user's untouched
 * additions; a plain-OVERWRITE of the seeded list then silently shrank it. The
 * fix makes the merge ADDITIVE — `union(seeded, extracted) MINUS explicit
 * removals` — so a confirm can only ADD, never silently shrink, while an
 * EXPLICIT drop ("drop Biohacking") still subtracts exactly that one.
 *
 * `primary_projects` is the prod source of truth for project shells: finalize
 * copies it into the confirmed list and the wow action builds one shell per
 * confirmed project — so preserving the full list HERE is what gets ALL
 * selected projects shells.
 *
 * K11a6 re-anchor (2026-07-06). The original tests drove this through the
 * interview engine's `engine.advance → llmRouter.route → dispatchRouterDecision
 *  → consumeImportAnalysisPresentedChoice → mergeAdvanceProjectsAdditively`
 * chain. That whole router-consumption drive is the dead-in-prod interview
 * engine conversational path K11b1 deletes. The RETAINED equivalent — the merge
 * that runs in PROD on every onboarding turn — is the Path-1 post-turn
 * extractor's `buildPhaseStatePatch` (`post-turn-extractor.ts`), which
 * implements the identical `(prior ∪ adds) MINUS removals` union over
 * `primary_projects` (its own comment cites the legacy engine's
 * `mergeAdvanceProjectsAdditively` as the behavior it ports). So we drive the
 * merge directly through `buildPhaseStatePatch(prior_phase_state, fields, text)`
 * and assert the merged `primary_projects` — a pure function of the prior
 * state + the turn's `ExtractedFields`, no engine/router/stub machinery.
 *
 * Note the one faithful adaptation: the router `amend`/`advance` expressed a
 * DROP as a plain-overwrite/omission plus a transient `removed_projects` signal;
 * the retained extractor NEVER shrinks by omission — a drop is expressed ONLY
 * via the `removed_projects` channel (`ExtractedFields.removed_projects`). The
 * behavioral assertion ("drop X → X gone, the rest kept") is identical.
 */

import { describe, expect, test } from 'bun:test'

import { buildPhaseStatePatch } from '../post-turn-extractor.ts'
import type { ExtractedFields } from '../extracted-fields.ts'

const SEVEN = [
  'Topline',
  'Northwind',
  'Acme Studio',
  'Acme',
  'Info Product Playbooks',
  'Buddhism',
  'Biohacking',
]

/** Prior phase_state at import_analysis_presented with the 7-project seed. */
function priorWithSeven(): Record<string, unknown> {
  return { primary_projects: [...SEVEN] }
}

/** The merged `primary_projects` after applying one turn's extraction, or the
 *  UNCHANGED prior list when the turn carried no project delta (the extractor
 *  omits the key, so the seeded list stands). */
function mergedPrimary(
  prior: Record<string, unknown>,
  fields: ExtractedFields | null,
  text: string,
): ReadonlyArray<string> {
  const patch = buildPhaseStatePatch(prior, fields, text)
  const v = 'primary_projects' in patch ? patch['primary_projects'] : prior['primary_projects']
  return Array.isArray(v) ? (v as string[]) : []
}

describe('GAP1 import-analysis additive merge (retained post-turn extractor path)', () => {
  test('a confirm whose extraction is SHORTER keeps the full seeded list (no silent shrink → all shells)', () => {
    // Reproduce-first: the extractor returns only [Topline, Northwind, Acme]
    // for this confirm — anchored to the proposed list, dropping the untouched
    // Buddhism + Biohacking (the 7→3 regression). The additive union with the
    // seeded 7 keeps all 7 → all 7 get shells downstream.
    const primary = mergedPrimary(
      priorWithSeven(),
      { primary_projects: ['Topline', 'Northwind', 'Acme'] },
      'go with Topline, Northwind, Acme, Buddhism and Biohacking',
    )
    expect(primary.length).toBe(7)
    for (const p of SEVEN) expect(primary).toContain(p)
  })

  test('an explicit-removal ("drop Biohacking") still drops exactly that one', () => {
    const remaining = SEVEN.filter((p) => p !== 'Biohacking')
    const primary = mergedPrimary(
      priorWithSeven(),
      { removed_projects: ['Biohacking'] },
      'looks good but drop Biohacking',
    )
    expect(primary).not.toContain('Biohacking')
    for (const p of remaining) expect(primary).toContain(p)
    expect(primary.length).toBe(6)
  })

  test('a review-completing REMOVAL drops exactly the named project (no silent re-add → no shell) — Argus r3 BLOCKER', () => {
    // Realistic flow the r3 additive-union regressed: "drop Biohacking, the
    // rest are good, go ahead" restates the kept 6 (anchored to the proposed
    // list) AND names removed=['Biohacking']. WITHOUT the additive-minus-removal
    // rule the union re-adds Biohacking from the seeded prior-7 and it would get
    // a shell.
    const kept = SEVEN.filter((p) => p !== 'Biohacking')
    const fields: ExtractedFields = {
      primary_projects: [...kept],
      removed_projects: ['Biohacking'],
    }
    const patch = buildPhaseStatePatch(
      priorWithSeven(),
      fields,
      'looks great, just drop Biohacking and go ahead',
    )
    const primary = Array.isArray(patch['primary_projects'])
      ? (patch['primary_projects'] as string[])
      : []
    // The dropped project must NOT survive (would otherwise get a shell).
    expect(primary).not.toContain('Biohacking')
    // The kept 6 all survive.
    for (const p of kept) expect(primary).toContain(p)
    expect(primary.length).toBe(6)
    // The transient `removed_projects` signal is NOT persisted into phase_state
    // (the extractor tracks drops under `dropped_projects` instead).
    expect(patch['removed_projects']).toBeUndefined()
    expect(patch['dropped_projects']).toEqual(['Biohacking'])
  })

  test('a confirm that ADDS net-new projects (no removal) still keeps them all — no regression', () => {
    // The additive behaviour must survive: a confirm whose extraction adds a
    // net-new project the seed did not have keeps the full union.
    const primary = mergedPrimary(
      priorWithSeven(),
      { primary_projects: [...SEVEN, 'Marathon Training'] },
      'all good, also add Marathon Training',
    )
    expect(primary.length).toBe(8)
    for (const p of SEVEN) expect(primary).toContain(p)
    expect(primary).toContain('Marathon Training')
  })

  test('a plain confirm carrying no project delta drops nothing', () => {
    // No `primary_projects` / `removed_projects` extracted → the extractor omits
    // the key entirely → the seeded 7 stand unchanged.
    const patch = buildPhaseStatePatch(priorWithSeven(), {}, 'looks good')
    expect('primary_projects' in patch).toBe(false)
    const primary = mergedPrimary(priorWithSeven(), {}, 'looks good')
    expect(primary.length).toBe(7)
    for (const p of SEVEN) expect(primary).toContain(p)
  })
})
