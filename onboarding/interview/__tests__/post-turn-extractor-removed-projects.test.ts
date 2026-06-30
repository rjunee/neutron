/**
 * @neutronai/onboarding/interview — post-turn extractor curation-drop tests.
 *
 * Import-curation handoff (2026-06-29): the Path-1 post-turn extractor never
 * implemented the `removed_projects` channel that `ExtractedFields` documents
 * (GAP1, 2026-06-09) and the legacy engine's `mergeAdvanceProjectsAdditively`
 * honors. So when the owner curated their import-proposed projects ("drop Family
 * Home"), nothing subtracted it — `primary_projects` stayed additive and
 * finalize re-added it from the import union, materializing a project the owner
 * explicitly rejected. These tests pin the port: parse `removed_projects`,
 * subtract it from the merged `primary_projects`, and accumulate it under
 * `dropped_projects` (so finalize can exclude it from the import side too).
 */

import { describe, expect, it } from 'bun:test'

import { buildPhaseStatePatch, parseExtractedFields } from '../post-turn-extractor.ts'

describe('parseExtractedFields — removed_projects', () => {
  it('parses an explicit removed_projects array', () => {
    const out = parseExtractedFields('{"removed_projects":["Family Home","Side gig"]}')
    expect(out?.removed_projects).toEqual(['Family Home', 'Side gig'])
  })

  it('drops empty / non-string entries and omits when absent', () => {
    expect(parseExtractedFields('{"removed_projects":["",123,"Keep"]}')?.removed_projects).toEqual([
      'Keep',
    ])
    expect(parseExtractedFields('{"primary_projects":["A"]}')?.removed_projects).toBeUndefined()
  })
})

describe('buildPhaseStatePatch — curation drop', () => {
  it('subtracts an explicitly removed project from the merged primary_projects', () => {
    const prior = { primary_projects: ['Amascence', 'Family Home', 'Moisture Oyster'] }
    const patch = buildPhaseStatePatch(prior, { removed_projects: ['Family Home'] }, 'drop family home')
    expect(patch['primary_projects']).toEqual(['Amascence', 'Moisture Oyster'])
    // And records the drop so finalize can exclude it from the import union too.
    expect(patch['dropped_projects']).toEqual(['Family Home'])
  })

  it('removal is case-insensitive and accumulates across turns', () => {
    const prior = {
      primary_projects: ['Amascence', 'Family Home'],
      dropped_projects: ['Old One'],
    }
    const patch = buildPhaseStatePatch(prior, { removed_projects: ['family home'] }, 'x')
    expect(patch['primary_projects']).toEqual(['Amascence'])
    // The drop is recorded VERBATIM (finalize matches by slug, so casing is
    // irrelevant); the case-insensitive match is what removed it from primary.
    expect(patch['dropped_projects']).toEqual(['Old One', 'family home'])
  })

  it('still ADDS while removing in the same turn (keep the rest, drop one)', () => {
    const prior = { primary_projects: ['Amascence', 'Family Home'] }
    const patch = buildPhaseStatePatch(
      prior,
      { primary_projects: ['Amascence', 'Moisture Oyster'], removed_projects: ['Family Home'] },
      'keep amascence + moisture oyster, drop family home',
    )
    expect(patch['primary_projects']).toEqual(['Amascence', 'Moisture Oyster'])
    expect(patch['dropped_projects']).toEqual(['Family Home'])
  })

  it('a normal additive turn (no removals) never shrinks + writes no dropped list', () => {
    const prior = { primary_projects: ['Amascence', 'Family Home'] }
    const patch = buildPhaseStatePatch(prior, { primary_projects: ['New Thing'] }, 'also new thing')
    expect(patch['primary_projects']).toEqual(['Amascence', 'Family Home', 'New Thing'])
    expect(patch['dropped_projects']).toBeUndefined()
  })

  it('a later explicit RE-ADD clears a prior drop (owner changed their mind)', () => {
    // Turn 1 dropped Family Home; turn 2 the owner says "actually keep Family Home".
    const prior = { primary_projects: ['Amascence'], dropped_projects: ['Family Home'] }
    const patch = buildPhaseStatePatch(
      prior,
      { primary_projects: ['Family Home'] },
      'actually keep family home',
    )
    // It is added back to primary AND removed from the dropped list, so finalize
    // will create it (the reversal is honored, not silently ignored).
    expect(patch['primary_projects']).toEqual(['Amascence', 'Family Home'])
    expect(patch['dropped_projects']).toEqual([])
  })

  it('a same-turn drop wins over a same-turn add of the same project (stays dropped)', () => {
    const prior = { primary_projects: ['Amascence', 'Family Home'] }
    const patch = buildPhaseStatePatch(
      prior,
      { primary_projects: ['Family Home'], removed_projects: ['Family Home'] },
      'contradictory',
    )
    expect(patch['primary_projects']).toEqual(['Amascence'])
    expect(patch['dropped_projects']).toEqual(['Family Home'])
  })
})
