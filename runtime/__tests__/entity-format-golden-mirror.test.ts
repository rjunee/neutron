/**
 * Entity-page codec golden round-trip (refactor G3).
 *
 * `runtime/entity-writer.ts` is the canonical entity-page codec
 * (`renderYamlFrontmatter` + `extractCompiledTruth` + the `KIND_TO_DIR`
 * subdirectory map). Two modules keep HAND-WRITTEN mirrors of pieces of
 * that codec, by design, rather than importing across their own module
 * boundary (each documents why in its own comments):
 *   - `scribe/write-to-gbrain.ts:331-338` (`KIND_TO_DIR`) + `:440-484`
 *     (`readExistingPage`/`parseFrontmatter`/`parseYamlScalar`, the INVERSE
 *     of `renderYamlFrontmatter`/`renderYamlValue`) + the sibling
 *     `extractCompiledTruthSlice` (a byte-for-byte copy of
 *     `extractCompiledTruth`, explicitly commented "Mirror of
 *     entity-writer.ts:extractCompiledTruth (not exported there)" — it now
 *     IS exported, test-only, so this test can pin it).
 *   - `gbrain-memory/GBrainSyncHook.ts:47-54` (`DIR_TO_KIND`), the inverse
 *     of `KIND_TO_DIR`, commented "duplicated by design because the sync
 *     hook treats the writer output path as ground truth".
 *
 * Nothing enforces any of these three mirrors stay in lockstep with the
 * canonical codec. This test pins today's agreement via an actual
 * render → parse → re-render round trip so a future edit to ANY one of the
 * four files (entity-writer, write-to-gbrain, GBrainSyncHook, or this test)
 * fails loudly instead of silently drifting. Green today; P8 later deletes
 * the two hand mirrors against this test.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  writeEntity,
  type EntityWriteInput,
  _renderEntityPage,
  _extractCompiledTruth,
  _extractTimeline,
  _KIND_TO_DIR as ENTITY_WRITER_KIND_TO_DIR,
} from '../entity-writer.ts'

import {
  _extractCompiledTruthSlice,
  _parseFrontmatter,
  _KIND_TO_DIR as SCRIBE_KIND_TO_DIR,
} from '../../scribe/write-to-gbrain.ts'

import { _DIR_TO_KIND as GBRAIN_DIR_TO_KIND } from '../../gbrain-memory/GBrainSyncHook.ts'

describe('KIND_TO_DIR / DIR_TO_KIND — three-way mirror agreement', () => {
  test('scribe/write-to-gbrain.ts KIND_TO_DIR byte-equals runtime/entity-writer.ts KIND_TO_DIR', () => {
    expect(SCRIBE_KIND_TO_DIR).toEqual(ENTITY_WRITER_KIND_TO_DIR)
  })

  test('gbrain-memory/GBrainSyncHook.ts DIR_TO_KIND is the exact inverse of KIND_TO_DIR', () => {
    const kinds = Object.keys(ENTITY_WRITER_KIND_TO_DIR) as Array<
      keyof typeof ENTITY_WRITER_KIND_TO_DIR
    >
    expect(kinds.length).toBeGreaterThan(0)
    for (const kind of kinds) {
      const dir = ENTITY_WRITER_KIND_TO_DIR[kind]
      expect(GBRAIN_DIR_TO_KIND[dir]).toBe(kind)
    }
    // And no extra directories on the inverse side.
    expect(Object.keys(GBRAIN_DIR_TO_KIND).sort()).toEqual(
      Object.values(ENTITY_WRITER_KIND_TO_DIR).sort(),
    )
  })
})

describe('extractCompiledTruth / extractCompiledTruthSlice — byte-equal on golden pages', () => {
  const PAGES: string[] = [
    // Canonical shape: frontmatter + compiled-truth + timeline.
    '---\nslug: acme\ntype: company\n---\n\n# Acme\n\nAcme is a company.\n---\n\n## Timeline\n\n- 2026-01-01T00:00:00Z | chat | mentioned\n',
    // No timeline section — compiled truth extends to end-of-body.
    '---\nslug: a\ntype: person\n---\n\nJust prose, no timeline.\n',
    // Hand-edited page: no frontmatter fence at all.
    'plain body, no fences',
    // Frontmatter open but never closes.
    '---\nkey: v\n\nnever closes',
    // Extra blank lines between the compiled-truth and the timeline separator
    // (extractCompiledTruth's regex is deliberately liberal on whitespace).
    '---\nslug: b\ntype: concept\n---\n\nBody here.\n\n\n---\n\n\n## Timeline\n\n- x | y | z\n',
    // Multi-line compiled truth with wikilinks and a Relationships section.
    '---\nslug: c\ntype: person\ntier: 1\n---\n\n## State\n\n- Role: founder\n\n## Relationships\n\n- Works at [[acme]].\n- Advises [[beta]].\n---\n\n## Timeline\n\n- 2026-02-01T00:00:00Z | m | note one\n- 2026-01-01T00:00:00Z | m | note two\n',
  ]

  for (const [i, page] of PAGES.entries()) {
    test(`fixture #${i}`, () => {
      expect(_extractCompiledTruthSlice(page)).toBe(_extractCompiledTruth(page))
    })
  }
})

describe('renderYamlFrontmatter / parseFrontmatter — inverse round trip on golden frontmatter maps', () => {
  const FRONTMATTER_FIXTURES: Array<Record<string, unknown>> = [
    { slug: 'a', type: 'person' },
    { slug: 'a', type: 'person', tier: 1, confidence: 'low' },
    { slug: 'a', type: 'person', mention_count: 0 },
    { slug: 'a', type: 'concept', category: 'inferred_interest' },
    // Values requiring quoting: colon, leading digit, YAML keyword, hash,
    // brackets, leading dash, leading/trailing whitespace collapses away
    // (frontmatter values are single-line so we don't fixture raw whitespace).
    { slug: 'a', type: 'person', note: 'ratio 3:1' },
    { slug: 'a', type: 'person', note: '007 agent' },
    { slug: 'a', type: 'person', note: 'true' },
    { slug: 'a', type: 'person', note: 'yes' },
    { slug: 'a', type: 'person', note: '#hashtag' },
    { slug: 'a', type: 'person', note: '[bracketed]' },
    { slug: 'a', type: 'person', note: '-leading-dash' },
    { slug: 'a', type: 'person', note: 'has "quotes" inside' },
    { slug: 'a', type: 'person', note: 'has\\backslash' },
    { slug: 'a', type: 'person', note: '' },
    { slug: 'a', type: 'person', flag: true },
    { slug: 'a', type: 'person', flag: false },
    { slug: 'a', type: 'person', nothing: null },
    { slug: 'a', type: 'person', tags: [] },
    { slug: 'a', type: 'person', tags: ['x', 'y', 'z'] },
    { slug: 'a', type: 'person', tags: ['needs quoting: yes', 'true', '007'] },
    { slug: 'a', type: 'person', nums: [1, 2, 3] },
  ]

  for (const [i, fm] of FRONTMATTER_FIXTURES.entries()) {
    test(`fixture #${i}: ${JSON.stringify(fm)}`, () => {
      // _renderEntityPage renders a full on-disk-shaped page (frontmatter
      // fence + compiled-truth + timeline separator), which is exactly the
      // shape parseFrontmatter expects to scan.
      const page = _renderEntityPage({ frontmatter: fm, compiledTruth: 'body', timeline: [] })
      expect(page.startsWith('---\n')).toBe(true)
      const parsed = _parseFrontmatter(page)
      expect(parsed).toEqual(fm)
    })
  }
})

describe('golden end-to-end: write → read → scribe-mirror-parse → re-render is byte-identical', () => {
  let ownerDir: string

  test('a written entity page reconstructs byte-identically via the scribe mirrors', async () => {
    ownerDir = mkdtempSync(join(tmpdir(), 'neutron-g3-entity-golden-'))
    try {
      const input: EntityWriteInput = {
        ownerDataDir: ownerDir,
        kind: 'person',
        slug: 'alice-founder',
        originInstance: 'acme',
        receivingInstanceSlug: 'acme',
        body: {
          frontmatter: {
            slug: 'alice-founder',
            type: 'person',
            tier: 1,
            confidence: 'low',
            tags: ['founder', 'acme'],
          },
          compiledTruth:
            '## State\n\n- Role: founder\n\n## Relationships\n\n- Works at [[acme-ai]].\n',
          timelineAppend: {
            ts: '2026-04-10T14:00:00-07:00',
            source: 'meeting-notes',
            body: 'Discussed Q3 plan with Alice.',
          },
        },
      }
      const out = await writeEntity(input)
      const onDisk = await fs.readFile(out.path, 'utf8')

      // 1. The two extractCompiledTruth implementations agree on the REAL
      //    written page.
      const compiledFromWriter = _extractCompiledTruth(onDisk)
      const compiledFromScribe = _extractCompiledTruthSlice(onDisk)
      expect(compiledFromScribe).toBe(compiledFromWriter)

      // 2. Scribe's parseFrontmatter (the hand-rolled inverse of
      //    renderYamlFrontmatter) recovers exactly the frontmatter map that
      //    was written.
      const parsedFm = _parseFrontmatter(onDisk)
      expect(parsedFm).toEqual(input.body.frontmatter)

      // 3. Re-render from the recovered pieces (frontmatter via scribe's
      //    parser, compiledTruth via either extractor, timeline via the
      //    writer's own parser) and assert BYTE-IDENTICAL reconstruction —
      //    the actual "golden round trip" the plan calls for.
      const recoveredTimeline = _extractTimeline(onDisk)
      const reRendered = _renderEntityPage({
        frontmatter: parsedFm,
        compiledTruth: compiledFromScribe,
        timeline: recoveredTimeline,
      })
      expect(reRendered).toBe(onDisk)
    } finally {
      rmSync(ownerDir, { recursive: true, force: true })
    }
  })
})
