/**
 * Entity-page codec golden round-trip (refactor G3, updated by P8).
 *
 * `runtime/entity-format.ts` is THE entity-page codec — render
 * (`renderEntityPage`/`renderYamlFrontmatter`), parse (`parseFrontmatter`/
 * `extractCompiledTruth`/`extractTimeline`), and the `KIND_TO_DIR` /
 * `DIR_TO_KIND` maps. Before P8 this test pinned three HAND MIRRORS of those
 * pieces (scribe/write-to-gbrain.ts's `KIND_TO_DIR` + `parseFrontmatter` +
 * `extractCompiledTruthSlice`, gbrain-memory/GBrainSyncHook.ts's
 * `DIR_TO_KIND`) against the canonical implementations; P8 deleted the
 * mirrors against this test, so all consumers now import the one codec.
 *
 * What remains load-bearing:
 *   - the kind↔dir maps are exact inverses (DIR_TO_KIND is derived, but a
 *     future hand edit to either fails here loudly)
 *   - `extractCompiledTruth`'s liberal-parsing behavior on golden pages
 *     (hand-edited shapes must keep returning the whole body, canonical
 *     shapes must slice exactly)
 *   - `parseFrontmatter` is the exact inverse of `renderYamlFrontmatter` on
 *     every value shape the emitter produces
 *   - end to end: a page written by `writeEntity` reconstructs BYTE-IDENTICAL
 *     from the codec's parse side (frontmatter + compiled-truth + timeline)
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// A REAL, standard YAML parser (the repo's locked yaml@2) — used to prove the
// bytes this codec writes are safe for external YAML consumers, not just for
// our own naive parseYamlScalar.
import YAML from 'yaml'

import {
  DIR_TO_KIND,
  KIND_TO_DIR,
  extractCompiledTruth,
  extractTimeline,
  parseFrontmatter,
  renderEntityPage,
  renderYamlFrontmatter,
} from '../entity-format.ts'
import { writeEntity, type EntityWriteInput } from '../entity-writer.ts'

describe('KIND_TO_DIR / DIR_TO_KIND — exact inverses', () => {
  test('DIR_TO_KIND is the exact inverse of KIND_TO_DIR', () => {
    const kinds = Object.keys(KIND_TO_DIR) as Array<keyof typeof KIND_TO_DIR>
    expect(kinds.length).toBeGreaterThan(0)
    for (const kind of kinds) {
      const dir = KIND_TO_DIR[kind]
      expect(DIR_TO_KIND[dir]).toBe(kind)
    }
    // And no extra directories on the inverse side.
    expect(Object.keys(DIR_TO_KIND).sort()).toEqual(
      Object.values(KIND_TO_DIR).sort(),
    )
  })
})

describe('extractCompiledTruth — golden pages (liberal-parsing contract)', () => {
  const CASES: Array<{ page: string; expected: string }> = [
    // Canonical shape: frontmatter + compiled-truth + timeline.
    {
      page: '---\nslug: acme\ntype: company\n---\n\n# Acme\n\nAcme is a company.\n---\n\n## Timeline\n\n- 2026-01-01T00:00:00Z | chat | mentioned\n',
      expected: '# Acme\n\nAcme is a company.',
    },
    // No timeline section — compiled truth extends to end-of-body.
    {
      page: '---\nslug: a\ntype: person\n---\n\nJust prose, no timeline.\n',
      expected: 'Just prose, no timeline.\n',
    },
    // Hand-edited page: no frontmatter fence at all — whole body returned.
    {
      page: 'plain body, no fences',
      expected: 'plain body, no fences',
    },
    // Frontmatter open but never closes — whole body returned.
    {
      page: '---\nkey: v\n\nnever closes',
      expected: '---\nkey: v\n\nnever closes',
    },
    // Extra blank lines between the compiled-truth and the timeline separator
    // (extractCompiledTruth's regex is deliberately liberal on whitespace).
    {
      page: '---\nslug: b\ntype: concept\n---\n\nBody here.\n\n\n---\n\n\n## Timeline\n\n- x | y | z\n',
      expected: 'Body here.\n\n',
    },
    // Multi-line compiled truth with wikilinks and a Relationships section.
    {
      page: '---\nslug: c\ntype: person\ntier: 1\n---\n\n## State\n\n- Role: founder\n\n## Relationships\n\n- Works at [[acme]].\n- Advises [[beta]].\n---\n\n## Timeline\n\n- 2026-02-01T00:00:00Z | m | note one\n- 2026-01-01T00:00:00Z | m | note two\n',
      expected:
        '## State\n\n- Role: founder\n\n## Relationships\n\n- Works at [[acme]].\n- Advises [[beta]].',
    },
  ]

  for (const [i, { page, expected }] of CASES.entries()) {
    test(`fixture #${i}`, () => {
      expect(extractCompiledTruth(page)).toBe(expected)
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
    // Leading-dot decimal-lookalike strings: parseYamlScalar's number regex
    // accepts `\.\d+` (not just a leading digit), so needsQuotes must guard
    // this shape too or `.5` round-trips as the NUMBER 0.5, not the string
    // `'.5'` (data-integrity regression).
    { slug: 'a', type: 'person', note: '.5' },
    { slug: 'a', type: 'person', note: '-.5' },
    { slug: 'a', type: 'person', note: '+.25' },
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
    // Backslash boundaries: an array item whose value ends in a literal
    // backslash renders as `\\"` — a naive `s[i-1] !== '\\'` split mis-reads
    // the closing quote as escaped and breaks the round trip (Codex).
    { slug: 'a', type: 'person', tags: ['colon: \\', 'next'] },
    { slug: 'a', type: 'person', tags: ['ends\\', 'and "quoted"', 'x'] },
    { slug: 'a', type: 'person', tags: ['back\\slash: mid'] },
    { slug: 'a', type: 'person', nums: [1, 2, 3] },
  ]

  for (const [i, fm] of FRONTMATTER_FIXTURES.entries()) {
    test(`fixture #${i}: ${JSON.stringify(fm)}`, () => {
      // renderEntityPage renders a full on-disk-shaped page (frontmatter
      // fence + compiled-truth + timeline separator), which is exactly the
      // shape parseFrontmatter expects to scan.
      const page = renderEntityPage({ frontmatter: fm, compiledTruth: 'body', timeline: [] })
      expect(page.startsWith('---\n')).toBe(true)
      const parsed = parseFrontmatter(page)
      expect(parsed).toEqual(fm)
    })
  }
})

describe('needsQuotes — leading-dot decimal-lookalike strings stay strings', () => {
  // Data-integrity regression: parseYamlScalar's number regex accepts a
  // leading-dot decimal form (`\.\d+`), not just a leading digit. A frontmatter
  // STRING value of `.5` used to render unquoted (`note: .5`), which parses
  // back as the NUMBER 0.5 — a silent JS-type + text change on any
  // read-merge-rewrite (e.g. scribe/write-to-gbrain's readExistingPage →
  // writeEntity re-render).
  test('a `.5`-shaped string round-trips as a string, not a number', () => {
    const fm = { slug: 'a', type: 'person', note: '.5' }
    const rendered = renderYamlFrontmatter(fm)
    // Must be quoted on render so the read side can't reclaim it as a number.
    expect(rendered).toContain('note: ".5"')
    const page = renderEntityPage({ frontmatter: fm, compiledTruth: 'body', timeline: [] })
    const parsed = parseFrontmatter(page)
    expect(parsed['note']).toBe('.5')
    expect(typeof parsed['note']).toBe('string')
  })

  test('signed and multi-digit leading-dot strings also stay strings', () => {
    for (const note of ['-.5', '+.25', '.999']) {
      const fm = { note }
      const page = renderEntityPage({ frontmatter: fm, compiledTruth: 'body', timeline: [] })
      const parsed = parseFrontmatter(page)
      expect(parsed['note']).toBe(note)
      expect(typeof parsed['note']).toBe('string')
    }
  })

  // The fix must not over-quote strings the reader would NEVER coerce to a
  // number: the render guard is anchored to the WHOLE string (shared grammar
  // with parseYamlScalar), so a number-lookalike PREFIX is a plain string and
  // stays unquoted. Covers dotfile-style values (.env, .gitignore) AND the
  // `.5foo`/`5foo` prefix cases the old prefix-match over-quoted (Codex).
  test('number-lookalike prefixes and dotfiles stay unquoted (no over-quoting)', () => {
    for (const note of ['.env', '.gitignore', '.', '.5foo', '.5-config', '+.5foo', '5foo', '1.2.3']) {
      const rendered = renderYamlFrontmatter({ note })
      expect(rendered.trim()).toBe(`note: ${note}`)
      const page = renderEntityPage({ frontmatter: { note }, compiledTruth: 'body', timeline: [] })
      const parsed = parseFrontmatter(page)
      expect(parsed['note']).toBe(note)
      expect(typeof parsed['note']).toBe('string')
    }
  })

  // Overflow numeric literals (`1e400` → Infinity, giant integers) match the
  // number GRAMMAR even though our own read side won't coerce them (non-finite).
  // A STANDARD YAML parser DOES coerce them, so the renderer MUST quote them —
  // quoting is keyed to the grammar, decoupled from our finite-only read path.
  // (Regression: a finiteness-gated render guard left these unquoted → retyped
  // by any real YAML consumer.)
  test('overflow numeric literals are quoted and round-trip as strings', () => {
    for (const note of ['1e400', '-1e400', '99999999999999999999']) {
      const rendered = renderYamlFrontmatter({ note })
      expect(rendered.trim()).toBe(`note: ${JSON.stringify(note)}`)
      const page = renderEntityPage({ frontmatter: { note }, compiledTruth: 'body', timeline: [] })
      const parsed = parseFrontmatter(page)
      expect(parsed['note']).toBe(note)
      expect(typeof parsed['note']).toBe('string')
    }
  })
})

// INTEROP: the frontmatter this codec writes is also read by STANDARD YAML
// parsers (the repo's locked `yaml@2`). Our own parseYamlScalar is naive
// (finite-only coercion), so it alone cannot prove the on-disk bytes are safe
// for external consumers. This pins the actual hazard: render a set of
// numeric-lookalike STRINGS and assert a real YAML parser reads every one back
// as the original STRING — never a number/Infinity. Without grammar-based
// quoting, `1e400` would come back as Infinity here.
describe('interop — a real YAML parser reads our frontmatter numeric-lookalike strings as strings', () => {
  // Sanity anchor: prove the parser WOULD coerce these if we emitted them
  // unquoted, so the round-trip assertion below is meaningful (not vacuous).
  test('the real parser coerces bare numeric-lookalikes (why quoting is required)', () => {
    expect(YAML.parse('n: 1e400').n).toBe(Infinity)
    expect(YAML.parse('n: .5').n).toBe(0.5)
    expect(YAML.parse('n: 007').n).toBe(7)
  })

  // Every form yaml@2's core schema coerces to a number (decimal incl. leading
  // zeros, hex, octal, float, exponent, OVERFLOW→Infinity, ±.inf, .nan). Each
  // must come back a STRING through a real YAML parse of our rendered bytes.
  const NUMERIC_LOOKALIKE_STRINGS = [
    '.5',
    '-.5',
    '+.25',
    '007',
    '00',
    '-0',
    '010',
    '1e3',
    '1e400',
    '-1e400',
    '123',
    '99999999999999999999',
    '0x1f',
    '0o17',
    '1.',
    '.5e3',
    '.inf',
    '-.inf',
    '.nan',
  ]

  for (const note of NUMERIC_LOOKALIKE_STRINGS) {
    test(`\`${note}\` survives a real YAML parse as the string it is`, () => {
      const page = renderEntityPage({
        frontmatter: { slug: 'a', type: 'person', note },
        compiledTruth: 'body',
        timeline: [],
      })
      // Extract the frontmatter block (between the opening/closing fences) and
      // hand the exact bytes to the real parser.
      const fmBlock = page.slice(4, page.indexOf('\n---\n', 4))
      const realParsed = YAML.parse(fmBlock) as Record<string, unknown>
      expect(typeof realParsed['note']).toBe('string')
      expect(realParsed['note']).toBe(note)
    })
  }
})

describe('golden end-to-end: write → read → parse → re-render is byte-identical', () => {
  let ownerDir: string

  test('a written entity page reconstructs byte-identically via the codec parse side', async () => {
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

      // 1. parseFrontmatter (the inverse of renderYamlFrontmatter) recovers
      //    exactly the frontmatter map that was written.
      const parsedFm = parseFrontmatter(onDisk)
      expect(parsedFm).toEqual(input.body.frontmatter)

      // 2. Re-render from the recovered pieces (frontmatter, compiled truth,
      //    timeline — all via the codec's parse side) and assert
      //    BYTE-IDENTICAL reconstruction — the actual "golden round trip"
      //    the plan calls for.
      const compiled = extractCompiledTruth(onDisk)
      const recoveredTimeline = extractTimeline(onDisk)
      const reRendered = renderEntityPage({
        frontmatter: parsedFm,
        compiledTruth: compiled,
        timeline: recoveredTimeline,
      })
      expect(reRendered).toBe(onDisk)

      // 3. The write landed in the KIND_TO_DIR-mapped subdirectory.
      expect(out.path).toContain('/entities/people/')
    } finally {
      rmSync(ownerDir, { recursive: true, force: true })
    }
  })
})
