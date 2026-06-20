/**
 * Pure-helper tests for `build-onboarding-handoff.ts`.
 *
 * History: this file was `build-onboarding-handoff-gap2-starters.test.ts`
 * (GAP2 2026-06-09 — multi-starter keyboard helpers). Item 5
 * (2026-06-11, ISSUES #208) retired the button machinery
 * (`buildStarterOptions` / `buildDeterministicProjectSeed` /
 * `clampComposition`) in favour of the free-form opening message, so
 * those describes were REPLACED (not silently deleted) by coverage for
 * the new helpers:
 *
 *   - `synthesizeMatchFromSignal` (unchanged behaviour — kept verbatim)
 *   - `buildDeterministicProjectOpening` (paragraph + ONE next move)
 *   - `firstProseParagraph` (README → opening paragraph lift)
 *   - `finalizeOpeningBody` (em-dash normalization + 700-char clamp)
 *   - `buildProjectDocReader` (materialized-doc read seam)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDeterministicProjectOpening,
  buildProjectDocReader,
  finalizeOpeningBody,
  firstProseParagraph,
  synthesizeMatchFromSignal,
  OPENING_MESSAGE_MAX_CHARS,
  PROJECT_DOC_MAX_CHARS,
  SYNTHESIZED_SUGGESTED_TOPICS_CAP,
} from '../build-onboarding-handoff.ts'

const NO_DOCS = { readme: null, transcript_summary: null, status_md: null }

describe('synthesizeMatchFromSignal (GAP2)', () => {
  test('returns null when there is no related signal', () => {
    expect(
      synthesizeMatchFromSignal('Biohacking', { entities: [], topics: [], interests: [] }),
    ).toBeNull()
  })

  test('synthesizes a matched-shaped object from topics/interests/entities', () => {
    const out = synthesizeMatchFromSignal('Biohacking', {
      entities: ['Biohacking gear'],
      topics: ['Biohacking cold plunge protocol'],
      interests: ['biohacking'],
    })
    expect(out).not.toBeNull()
    expect(out!.name).toBe('Biohacking')
    expect(out!.rationale.toLowerCase()).toContain('biohacking')
    // suggested_topics drive the next-move pick; topics rank first.
    expect(out!.suggested_topics[0]).toBe('Biohacking cold plunge protocol')
    expect(out!.suggested_topics.length).toBeLessThanOrEqual(SYNTHESIZED_SUGGESTED_TOPICS_CAP)
  })

  test('dedups suggested topics across the three signal lists', () => {
    const out = synthesizeMatchFromSignal('X', {
      entities: ['Xterm'],
      topics: ['Xterm'],
      interests: ['Xterm'],
    })
    expect(out).not.toBeNull()
    // "Xterm" appears once despite being in all three lists.
    expect(out!.suggested_topics.filter((t) => t.toLowerCase() === 'xterm').length).toBe(1)
  })
})

describe('buildDeterministicProjectOpening (Item 5)', () => {
  test('README first paragraph wins over the import rationale (Item 4 read order)', () => {
    const out = buildDeterministicProjectOpening(
      'Acme',
      { name: 'Acme', rationale: '84 LLC mentions plus 67 brand mentions.', suggested_topics: [] },
      {
        readme: '# Acme\n\nAcme is the DTC venture with Casey; launch is two weeks out.\n\n## Threads\n\nMore detail.',
        transcript_summary: null,
        status_md: null,
      },
    )
    expect(out.body).toContain('DTC venture with Casey')
    expect(out.body).not.toContain('84 LLC mentions')
  })

  test('matched rationale + suggested topic → paragraph + single dig-in offer', () => {
    const out = buildDeterministicProjectOpening(
      'Topline',
      {
        name: 'Topline',
        rationale: 'The Topline JV cash flow is the highest-leverage thread',
        suggested_topics: ['Topline JV threads'],
      },
      NO_DOCS,
    )
    expect(out.body).toContain('cash flow is the highest-leverage thread.')
    expect(out.body).toContain('Want me to dig into Topline JV threads?')
    // Exactly one next-move line, separated by a blank line.
    expect(out.body.split('\n\n')).toHaveLength(2)
  })

  test('rationale present, no topics → open question variant', () => {
    const out = buildDeterministicProjectOpening(
      'Acme',
      { name: 'Acme', rationale: 'Brand launch in two weeks.', suggested_topics: [] },
      NO_DOCS,
    )
    expect(out.body).toContain('Brand launch in two weeks.')
    expect(out.body).toContain('What would you like to do next?')
  })

  test('no signal at all → § 4.4 no-history voice', () => {
    const out = buildDeterministicProjectOpening('Mystery', null, NO_DOCS)
    expect(out.body).toContain('You added Mystery to your projects.')
    expect(out.body).toContain('tell me what it is and what you want me to track')
  })
})

describe('firstProseParagraph', () => {
  test('skips headings and lifts the first prose block, flattened', () => {
    const md = '# Title\n\nFirst paragraph line one\nline two.\n\nSecond paragraph.'
    expect(firstProseParagraph(md)).toBe('First paragraph line one line two.')
  })

  test('returns empty string for heading-only docs', () => {
    expect(firstProseParagraph('# Just a title\n\n## And a subtitle')).toBe('')
  })
})

describe('finalizeOpeningBody (Item 5)', () => {
  test('normalizes em dashes to hyphens (hard rule)', () => {
    const out = finalizeOpeningBody('The JV — cash flow — is live.\n\nNext?')
    expect(out).not.toContain('—')
    expect(out).toContain('The JV - cash flow - is live.')
  })

  test('clamps overlong bodies at a sentence boundary under the 700-char cap', () => {
    const long = `${'A solid sentence about the project. '.repeat(60)}`
    const out = finalizeOpeningBody(long)
    expect(out.length).toBeLessThanOrEqual(OPENING_MESSAGE_MAX_CHARS)
    expect(out.endsWith('…')).toBe(true)
  })

  test('short bodies pass through untouched', () => {
    expect(finalizeOpeningBody('Short and sweet.\n\nWhat next?')).toBe(
      'Short and sweet.\n\nWhat next?',
    )
  })

  test('empty body gets the recognisable stand-in (never empty)', () => {
    expect(finalizeOpeningBody('   ').length).toBeGreaterThan(0)
  })
})

describe('buildProjectDocReader (Item 5)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-doc-reader-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('reads Projects/<slug>/<relpath> and caps content', () => {
    const root = join(tmp, 'Projects', 'topline')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'README.md'), 'Readme body.', 'utf8')
    writeFileSync(join(root, 'docs', 'transcript-summary.md'), 'Z'.repeat(PROJECT_DOC_MAX_CHARS + 500), 'utf8')
    const read = buildProjectDocReader({ owner_home: tmp })
    expect(read('topline', 'README.md')).toBe('Readme body.')
    expect(read('topline', join('docs', 'transcript-summary.md'))!.length).toBe(PROJECT_DOC_MAX_CHARS)
  })

  test('returns null for missing or empty files (never throws)', () => {
    const read = buildProjectDocReader({ owner_home: tmp })
    expect(read('nope', 'README.md')).toBeNull()
    const root = join(tmp, 'Projects', 'empty')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'README.md'), '   \n', 'utf8')
    expect(read('empty', 'README.md')).toBeNull()
  })
})
