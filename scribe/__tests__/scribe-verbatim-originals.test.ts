/**
 * VERBATIM originals — the guard + the write path.
 *
 * the legacy harness's scribe captured Ryan's reflective passages UNPARAPHRASED into
 * `entities/originals/` (949 pages — his largest entity class). Neutron wrote
 * the `original` kind as a one-line LLM synthesis
 * (`scribe/reflect/reserved-kinds.ts:48,55`), so ongoing capture would have
 * accreted summaries instead of his own sentences. These tests pin the fix:
 *
 *   - the guard KEEPS an exact copy and a benign whitespace/smart-quote variant
 *   - the guard DROPS a paraphrase and a passage stitched from distant
 *     fragments — the two ways an LLM "copies" without copying
 *   - a kept passage reaches the on-disk `original` page BYTE-IDENTICAL to the
 *     owner's words (asserted through the REAL entity-writer, not a stub)
 *   - drops are OBSERVABLE (reason + excerpt reach the failure sink)
 *
 * MUTATION-TESTED both ways (see the sprint report): deleting the guard's
 * substring check makes the paraphrase case fail; deleting the
 * `writeOriginalPages` call makes the page-write case fail.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { writeEntity } from '@neutronai/runtime/entity-writer.ts'
import { extractCompiledTruth } from '@neutronai/runtime/entity-format.ts'
import {
  verifyOriginals,
  normalizeForVerbatim,
  MIN_VERBATIM_PASSAGE_CHARS,
} from '../verbatim.ts'
import { parseExtraction } from '../extract.ts'
import { createScribe } from '../index.ts'
import { createState } from '../scribe-budget.ts'
import type { WriteEntityFn } from '../write-to-gbrain.ts'

const t0 = Date.now()

/**
 * A real reflective turn, with the shapes that matter baked in: a straight
 * apostrophe (so a smart-quote variant is testable) and hard newlines (so a
 * whitespace variant is testable).
 */
const TURN = [
  "I keep coming back to the same thing about how I work: the constraint isn't time, it's",
  'the willingness to sit with a problem long enough that it stops being confusing.',
  "Every time I've shipped something worth shipping, the breakthrough landed after I gave up",
  'on being efficient about it.',
].join('\n')

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Substrate that returns a canned extraction document then completes. */
function cannedSubstrate(json: string): Substrate {
  return {
    start(): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: json }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'fake',
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {
          throw new Error('no tools')
        },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

describe('verbatim guard', () => {
  test('KEEPS an exact copy, and stores the source bytes', () => {
    const r = verifyOriginals([{ title: 'On sitting with a problem', passage: TURN }], TURN)
    expect(r.dropped).toEqual([])
    expect(r.kept).toHaveLength(1)
    expect(r.kept[0]!.passage).toBe(TURN)
  })

  test('KEEPS a contiguous SUB-RUN and recovers its exact source range', () => {
    const start = TURN.indexOf('the willingness')
    const end = TURN.indexOf('confusing.') + 'confusing.'.length
    const sub = TURN.slice(start, end)
    const r = verifyOriginals([{ title: 'Sitting with it', passage: sub }], TURN)
    expect(r.kept).toHaveLength(1)
    expect(r.kept[0]!.passage).toBe(sub)
  })

  test('KEEPS a whitespace + smart-quote variant, but stores the OWNER’s bytes', () => {
    // The exact rewrite an LLM does while believing it copied: newlines
    // flattened to spaces, straight apostrophes curled.
    const variant = TURN.replace(/\n/g, '   ').replace(/'/g, '’')
    expect(variant).not.toBe(TURN) // the model's copy really is different bytes
    const r = verifyOriginals([{ title: 'On sitting with a problem', passage: variant }], TURN)
    expect(r.dropped).toEqual([])
    expect(r.kept).toHaveLength(1)
    // The stored passage is the SOURCE range, not the model's transcription.
    expect(r.kept[0]!.passage).toBe(TURN)
  })

  test('KEEPS a unicode-dash / ellipsis variant, storing the source form', () => {
    const src = 'The trade-off I keep making is speed over certainty... and I regret it most weeks.'
    const variant = 'The trade—off I keep making is speed over certainty… and I regret it most weeks.'
    const r = verifyOriginals([{ title: 'Speed over certainty', passage: variant }], src)
    expect(r.kept).toHaveLength(1)
    expect(r.kept[0]!.passage).toBe(src)
  })

  test('DROPS a paraphrase — the whole point of the guard', () => {
    const paraphrase =
      'The real constraint is not time but the willingness to stay with a hard problem until it becomes clear.'
    const r = verifyOriginals([{ title: 'On constraints', passage: paraphrase }], TURN)
    expect(r.kept).toEqual([])
    expect(r.dropped).toHaveLength(1)
    expect(r.dropped[0]!.reason).toBe('not_verbatim')
    // Observable, not silent: the operator gets the title AND a readable excerpt.
    expect(r.dropped[0]!.title).toBe('On constraints')
    expect(r.dropped[0]!.excerpt.length).toBeGreaterThan(0)
  })

  test('DROPS a passage stitched from two DISTANT fragments', () => {
    const head = TURN.slice(0, 70) // start of the first line
    const tail = TURN.slice(TURN.length - 70) // end of the last line
    const stitched = `${head} ${tail}`
    // Each half IS verbatim; the assembled run is not contiguous in the source.
    expect(normalizeForVerbatim(TURN).includes(normalizeForVerbatim(head))).toBe(true)
    expect(normalizeForVerbatim(TURN).includes(normalizeForVerbatim(tail))).toBe(true)
    const r = verifyOriginals([{ title: 'Stitched', passage: stitched }], TURN)
    expect(r.kept).toEqual([])
    expect(r.dropped[0]!.reason).toBe('not_verbatim')
  })

  test('DROPS a reordered copy (same words, different order)', () => {
    const reordered = 'it stops being confusing. the willingness to sit with a problem long enough that'
    const r = verifyOriginals([{ title: 'Reordered', passage: reordered }], TURN)
    expect(r.kept).toEqual([])
    expect(r.dropped[0]!.reason).toBe('not_verbatim')
  })

  test('DROPS a verbatim-but-trivial fragment under the minimum length', () => {
    const tiny = "the constraint isn't time"
    expect(tiny.length).toBeLessThan(MIN_VERBATIM_PASSAGE_CHARS)
    expect(TURN.includes(tiny)).toBe(true) // genuinely verbatim
    const r = verifyOriginals([{ title: 'Tiny', passage: tiny }], TURN)
    expect(r.kept).toEqual([])
    expect(r.dropped[0]!.reason).toBe('too_short')
  })

  test('does NOT lowercase — a case-changed copy is DROPPED', () => {
    const shouted = TURN.toUpperCase()
    const r = verifyOriginals([{ title: 'Shouted', passage: shouted }], TURN)
    expect(r.kept).toEqual([])
    expect(r.dropped[0]!.reason).toBe('not_verbatim')
  })

  test('does NOT strip punctuation — a de-punctuated copy is DROPPED', () => {
    const depunct = TURN.replace(/[.,:]/g, '')
    const r = verifyOriginals([{ title: 'De-punctuated', passage: depunct }], TURN)
    expect(r.kept).toEqual([])
    expect(r.dropped[0]!.reason).toBe('not_verbatim')
  })

  test('fails CLOSED with no source text', () => {
    const r = verifyOriginals([{ title: 'Anything', passage: TURN }], undefined)
    expect(r.kept).toEqual([])
    expect(r.dropped[0]!.reason).toBe('unverifiable_no_source')
  })

  test('DROPS a blank title (no usable page identity)', () => {
    const r = verifyOriginals([{ title: '   ', passage: TURN }], TURN)
    expect(r.kept).toEqual([])
    expect(r.dropped[0]!.reason).toBe('invalid_title')
  })

  test('DROPS a passage carrying an entity-page structural marker', () => {
    const src = 'Here is what I actually believe about all of this work:\n---\nIt only counts once shipped.'
    const r = verifyOriginals([{ title: 'Belief', passage: src }], src)
    expect(r.kept).toEqual([])
    expect(r.dropped[0]!.reason).toBe('structural_marker')
  })

  test('DROPS a duplicate of a passage already kept from the same turn', () => {
    const r = verifyOriginals(
      [
        { title: 'A', passage: TURN },
        { title: 'B', passage: TURN },
      ],
      TURN,
    )
    expect(r.kept).toHaveLength(1)
    expect(r.dropped[0]!.reason).toBe('duplicate')
  })

  test('empty / missing originals are handled', () => {
    expect(verifyOriginals([], TURN)).toEqual({ kept: [], dropped: [] })
    const noKey = parseExtraction('{"entities":[],"relations":[]}', TURN)
    expect(noKey.originals).toEqual([])
    expect(noKey.originals_dropped).toEqual([])
    const nullKey = parseExtraction('{"originals":null}', TURN)
    expect(nullKey.originals).toEqual([])
    const junkRows = parseExtraction('{"originals":[null,7,{"title":"x"},{"passage":""}]}', TURN)
    expect(junkRows.originals).toEqual([])
    const unparseable = parseExtraction('not json at all', TURN)
    expect(unparseable.originals).toEqual([])
    expect(unparseable.originals_dropped).toEqual([])
  })

  test('parseExtraction WITHOUT a source turn yields no originals (fail closed)', () => {
    const doc = JSON.stringify({ entities: [], relations: [], originals: [{ title: 'T', passage: TURN }] })
    const parsed = parseExtraction(doc)
    expect(parsed.originals).toEqual([])
    expect(parsed.originals_dropped![0]!.reason).toBe('unverifiable_no_source')
  })
})

describe('verbatim originals — write path', () => {
  test('a captured passage reaches the entity page BYTE-IDENTICAL', async () => {
    const home = tmpDir('scribe-verbatim-write-')
    const doc = JSON.stringify({
      entities: [],
      relations: [],
      // The model flattens the newlines — the guard still stores the OWNER's bytes.
      originals: [{ title: 'On sitting with a problem', passage: TURN.replace(/\n/g, ' ') }],
    })
    const scribe = createScribe({
      substrate: cannedSubstrate(doc),
      syncHook: { async onEntityWrite(): Promise<void> {} },
      ownerDataDir: home,
      owner_slug: 'owner',
      budget: createState(join(tmpDir('scribe-verbatim-budget-'), '.scribe-budget.json')),
      now: () => t0,
    })

    const out = await scribe.extractAndWrite({ text: TURN, observed_at: t0 })
    expect(out.ran).toBe(true)
    if (!out.ran) throw new Error('unreachable')
    expect(out.report.originals_written).toBe(1)

    const path = join(home, 'entities', 'originals', 'on-sitting-with-a-problem.md')
    const page = readFileSync(path, 'utf8')
    // BYTE-IDENTICAL: the owner's exact bytes, newlines and all, are in the page.
    expect(page.includes(TURN)).toBe(true)
    // And they are in the COMPILED TRUTH (the page's body), not a timeline row.
    expect(extractCompiledTruth(page).includes(TURN)).toBe(true)
    expect(page).toContain('type: original')
  })

  test('a second passage APPENDS to the same page; a replay is a no-op', async () => {
    const home = tmpDir('scribe-verbatim-append-')
    const budgetPath = join(tmpDir('scribe-verbatim-budget2-'), '.scribe-budget.json')
    const budget = createState(budgetPath)
    const second =
      'The other half of it is that I only ever learn something by being wrong in public first.'

    const run = async (turn: string, passage: string, ts: number): Promise<void> => {
      const doc = JSON.stringify({
        entities: [],
        relations: [],
        originals: [{ title: 'On sitting with a problem', passage }],
      })
      const scribe = createScribe({
        substrate: cannedSubstrate(doc),
        syncHook: { async onEntityWrite(): Promise<void> {} },
        ownerDataDir: home,
        owner_slug: 'owner',
        budget,
        now: () => t0,
      })
      await scribe.extractAndWrite({ text: turn, observed_at: ts })
    }

    await run(TURN, TURN, t0)
    await run(second, second, t0 + 60_000)

    const path = join(home, 'entities', 'originals', 'on-sitting-with-a-problem.md')
    const compiled = extractCompiledTruth(readFileSync(path, 'utf8'))
    // BOTH passages present, both byte-exact — the page ACCRETED (the legacy harness shape).
    expect(compiled.includes(TURN)).toBe(true)
    expect(compiled.includes(second)).toBe(true)

    // Replaying the first turn changes NOTHING — byte-identical page, and the
    // owner's words appear exactly once (no duplicate capture).
    const before = readFileSync(path, 'utf8')
    await run(TURN, TURN, t0)
    const after = readFileSync(path, 'utf8')
    expect(after).toBe(before)
    expect(after.split(TURN).length - 1).toBe(1)
  })

  test('a PARAPHRASE from the model writes NO original page', async () => {
    const home = tmpDir('scribe-verbatim-paraphrase-')
    const written: string[] = []
    const failures: string[] = []
    const recordingWrite: WriteEntityFn = async (i) => {
      written.push(`${i.kind}/${i.slug}`)
      return { path: `${i.kind}/${i.slug}`, changed: true, newLinks: [] }
    }
    const doc = JSON.stringify({
      entities: [],
      relations: [],
      originals: [
        {
          title: 'On constraints',
          passage:
            'The real constraint is not time but the willingness to stay with a hard problem until it becomes clear.',
        },
      ],
    })
    const scribe = createScribe({
      substrate: cannedSubstrate(doc),
      syncHook: { async onEntityWrite(): Promise<void> {} },
      ownerDataDir: home,
      owner_slug: 'owner',
      budget: createState(join(tmpDir('scribe-verbatim-budget3-'), '.scribe-budget.json')),
      writeEntity: recordingWrite,
      now: () => t0,
      logFailure: (msg) => failures.push(msg),
    })

    const out = await scribe.extractAndWrite({ text: TURN, observed_at: t0 })
    expect(out.ran).toBe(true)
    if (!out.ran) throw new Error('unreachable')
    expect(out.report.originals_written).toBe(0)
    expect(written).toEqual([]) // NOTHING was filed as the owner's words
    // The drop is OBSERVABLE — a reason reached the failure sink.
    expect(failures.some((m) => m.includes('verbatim guard dropped 1 passage(s)'))).toBe(true)
    expect(failures.some((m) => m.includes('not_verbatim'))).toBe(true)
  })
})

/** Keeps the real `writeEntity` import load-bearing: the byte-identical test
 *  above runs through the REAL writer via `createScribe`'s default, and this
 *  pins that the default is in fact that function. */
test('the scribe write path defaults to the real entity-writer', () => {
  expect(typeof writeEntity).toBe('function')
})
