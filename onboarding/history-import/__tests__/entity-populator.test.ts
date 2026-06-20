/**
 * 2026-05-25 — entity-populator unit tests (sprint Part F.2).
 *
 * Per the import-pipeline-resilience sprint Part D, the populator
 * fans a Pass-2 ImportResult through `runtime/entity-writer.ts` so
 * the per-project `<ownerDataDir>/entities/<kind>/<slug>.md` tree
 * is populated from first use. These tests pin:
 *
 *   - 14 entity pages emitted from a 5 people / 3 companies /
 *     4 concepts / 2 interests fixture (plus 1 voice-signals page = 15
 *     total `writeEntity` calls).
 *   - Each page receives the expected (kind, slug, frontmatter,
 *     compiled-truth shape, timeline entry) tuple.
 *   - Re-running the populator emits zero new file writes (idempotent
 *     via `changed: false`).
 *   - Entities with `mention_count < 2` are skipped.
 *   - When `syncHook` is provided the writer wires it on every call;
 *     omitting the hook leaves the writer arity unchanged.
 */

import { describe, expect, test } from 'bun:test'
import {
  populateEntitiesFromImport,
  slugify,
  POPULATOR_MENTION_COUNT_MIN,
  type WriteEntityFn,
} from '../entity-populator.ts'
import type { ImportResult } from '../types.ts'
import type { SyncHook } from '../../../runtime/entity-writer.ts'

const OWNER = 't-test'
const JOB = 'job-abc'
const NOW = (): number => 1_700_000_000_000

function makeResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    entities: [
      { name: 'Casey Rivera', kind: 'person', mention_count: 12 },
      { name: 'Sam Lee', kind: 'person', mention_count: 8 },
      { name: 'Khan Nguyen', kind: 'person', mention_count: 5 },
      { name: 'Sam Taylor', kind: 'person', mention_count: 4 },
      { name: 'Morgan', kind: 'person', mention_count: 3 },
      // Below-threshold person — should be skipped.
      { name: 'OneShot', kind: 'person', mention_count: 1 },
      { name: 'Topline', kind: 'company', mention_count: 9 },
      { name: 'Acme', kind: 'company', mention_count: 7 },
      { name: 'Northwind Labs', kind: 'company', mention_count: 3 },
      { name: 'Contemplative Crossfit', kind: 'concept', mention_count: 6 },
      { name: 'Nova', kind: 'concept', mention_count: 5 },
      { name: 'agent-native architecture', kind: 'concept', mention_count: 4 },
      { name: 'compound engineering', kind: 'concept', mention_count: 2 },
      // Below-threshold concept — should be skipped.
      { name: 'BelowFloor', kind: 'concept', mention_count: 1 },
    ],
    topics: [],
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {
      tone: 'terse',
      verbosity: 'medium',
      structure_pref: 'bullets',
      signature_phrases: ['ship it', 'no fluff'],
    },
    facts: {
      key_people: [],
      companies: [],
    },
    inferred_interests: [
      { name: 'climbing', basis: 'mentioned 6 times in 90 days', cadence_hint: 'weekly' },
      { name: 'tea ceremony', basis: 'mentioned 3 times last month' },
    ],
    ...overrides,
  }
}

interface RecordedWrite {
  kind: string
  slug: string
  frontmatter: Record<string, unknown>
  compiledTruth: string
  timeline: { ts: string; source: string; body: string }
  syncHookProvided: boolean
}

function makeRecorder(opts: {
  changedAlways?: boolean
} = {}): {
  fn: WriteEntityFn
  writes: RecordedWrite[]
} {
  const writes: RecordedWrite[] = []
  const fn: WriteEntityFn = async (input, deps) => {
    writes.push({
      kind: input.kind,
      slug: input.slug,
      frontmatter: input.body.frontmatter,
      compiledTruth: input.body.compiledTruth,
      timeline: input.body.timelineAppend,
      syncHookProvided: deps?.syncHook !== undefined,
    })
    return {
      path: `/fake/${input.kind}/${input.slug}.md`,
      changed: opts.changedAlways ?? true,
      newLinks: [],
    }
  }
  return { fn, writes }
}

describe('populateEntitiesFromImport', () => {
  test('emits one page per above-threshold entity + a voice-signals page', async () => {
    const { fn, writes } = makeRecorder()
    const report = await populateEntitiesFromImport(
      {
        ownerDataDir: '/tmp/project',
        project_slug: OWNER,
        job_id: JOB,
        source: 'chatgpt-zip',
        result: makeResult(),
        now: NOW,
      },
      { writeEntity: fn },
    )

    // 5 people (excluding below-threshold OneShot)
    //   + 3 companies
    //   + 4 concepts (excluding below-threshold BelowFloor)
    //   + 2 interests (rendered as kind=concept)
    //   + 1 voice-signals
    //   = 15 page writes
    expect(report.pages_written).toBe(15)
    // 1 below-threshold person + 1 below-threshold concept = 2 skips
    expect(report.pages_skipped).toBe(2)
    // syncHook not wired → 0 edges counted
    expect(report.memory_edges).toBe(0)
    expect(writes).toHaveLength(15)
  })

  test('person bodies cite source + mention count + timeline entry cites job_id', async () => {
    const { fn, writes } = makeRecorder()
    await populateEntitiesFromImport(
      {
        ownerDataDir: '/tmp/project',
        project_slug: OWNER,
        job_id: JOB,
        source: 'chatgpt-zip',
        result: makeResult(),
        now: NOW,
      },
      { writeEntity: fn },
    )
    const casey = writes.find((w) => w.slug === 'casey-rivera')
    expect(casey).toBeDefined()
    expect(casey?.kind).toBe('person')
    expect(casey?.compiledTruth).toContain('Casey Rivera')
    expect(casey?.compiledTruth).toContain('ChatGPT')
    expect(casey?.compiledTruth).toContain('12')
    expect(casey?.frontmatter['type']).toBe('person')
    expect(casey?.frontmatter['mention_count']).toBe(12)
    expect(casey?.timeline.source).toBe('import:chatgpt-zip')
    expect(casey?.timeline.body).toContain(`job=${JOB}`)
  })

  test('interests render as kind=concept with inferred_interest category', async () => {
    const { fn, writes } = makeRecorder()
    await populateEntitiesFromImport(
      {
        ownerDataDir: '/tmp/project',
        project_slug: OWNER,
        job_id: JOB,
        source: 'chatgpt-zip',
        result: makeResult(),
        now: NOW,
      },
      { writeEntity: fn },
    )
    const climbing = writes.find((w) => w.slug === 'climbing')
    expect(climbing).toBeDefined()
    expect(climbing?.kind).toBe('concept')
    expect(climbing?.frontmatter['category']).toBe('inferred_interest')
    expect(climbing?.frontmatter['cadence_hint']).toBe('weekly')
    expect(climbing?.compiledTruth).toContain('Basis: mentioned 6 times in 90 days')
    expect(climbing?.timeline.body).toContain('Inferred from conversation patterns')
  })

  test('voice-signals page renders tone/verbosity/structure/signature phrases', async () => {
    const { fn, writes } = makeRecorder()
    await populateEntitiesFromImport(
      {
        ownerDataDir: '/tmp/project',
        project_slug: OWNER,
        job_id: JOB,
        source: 'chatgpt-zip',
        result: makeResult(),
        now: NOW,
      },
      { writeEntity: fn },
    )
    const vs = writes.find((w) => w.slug === 'voice-signals')
    expect(vs).toBeDefined()
    expect(vs?.kind).toBe('concept')
    expect(vs?.frontmatter['category']).toBe('voice_signals')
    expect(vs?.compiledTruth).toContain('Tone: terse')
    expect(vs?.compiledTruth).toContain('Verbosity: medium')
    expect(vs?.compiledTruth).toContain('Structure preference: bullets')
    expect(vs?.compiledTruth).toContain('ship it')
    expect(vs?.compiledTruth).toContain('no fluff')
  })

  test('voice-signals page is skipped when every voice-signal field is empty', async () => {
    const { fn } = makeRecorder()
    const report = await populateEntitiesFromImport(
      {
        ownerDataDir: '/tmp/project',
        project_slug: OWNER,
        job_id: JOB,
        source: 'chatgpt-zip',
        result: makeResult({ voice_signals: {} }),
        now: NOW,
      },
      { writeEntity: fn },
    )
    // 15 - 1 voice-signals = 14 written, skips unchanged at 2
    expect(report.pages_written).toBe(14)
  })

  test('re-run with changed:false everywhere counts as pages_skipped', async () => {
    const { fn } = makeRecorder({ changedAlways: false })
    const report = await populateEntitiesFromImport(
      {
        ownerDataDir: '/tmp/project',
        project_slug: OWNER,
        job_id: JOB,
        source: 'chatgpt-zip',
        result: makeResult(),
        now: NOW,
      },
      { writeEntity: fn },
    )
    expect(report.pages_written).toBe(0)
    // 15 byte-equal writes + 2 below-threshold = 17 skipped
    expect(report.pages_skipped).toBe(17)
  })

  test('syncHook is forwarded on every writeEntity call when wired', async () => {
    const { fn, writes } = makeRecorder()
    const fakeHook: SyncHook = { onEntityWrite: async () => undefined }
    const report = await populateEntitiesFromImport(
      {
        ownerDataDir: '/tmp/project',
        project_slug: OWNER,
        job_id: JOB,
        source: 'chatgpt-zip',
        result: makeResult(),
        now: NOW,
      },
      { writeEntity: fn, syncHook: fakeHook },
    )
    expect(report.memory_edges).toBe(15)
    for (const w of writes) {
      expect(w.syncHookProvided).toBe(true)
    }
  })

  test('individual writeEntity throws are swallowed and counted as skips', async () => {
    let calls = 0
    const fn: WriteEntityFn = async (input) => {
      calls += 1
      if (input.slug === 'topline') throw new Error('disk full')
      return { path: 'p', changed: true, newLinks: [] }
    }
    const captured: Array<{ kind: string; slug: string }> = []
    const report = await populateEntitiesFromImport(
      {
        ownerDataDir: '/tmp/project',
        project_slug: OWNER,
        job_id: JOB,
        source: 'chatgpt-zip',
        result: makeResult(),
        now: NOW,
      },
      {
        writeEntity: fn,
        logFailure: (_err, ctx) => {
          captured.push({ kind: ctx.kind, slug: ctx.slug })
        },
      },
    )
    expect(calls).toBe(15)
    expect(report.pages_written).toBe(14)
    expect(report.pages_skipped).toBe(3) // 2 below-threshold + 1 failed
    expect(captured).toEqual([{ kind: 'company', slug: 'topline' }])
  })

  test('facts.key_people / facts.companies merge with entities dedupe by slug', async () => {
    const { fn, writes } = makeRecorder()
    await populateEntitiesFromImport(
      {
        ownerDataDir: '/tmp/project',
        project_slug: OWNER,
        job_id: JOB,
        source: 'chatgpt-zip',
        result: makeResult({
          facts: {
            key_people: ['Casey Rivera', 'NewPersonFromFacts'],
            companies: ['Topline', 'NewCompanyFromFacts'],
          },
        }),
        now: NOW,
      },
      { writeEntity: fn },
    )
    const casey = writes.find((w) => w.slug === 'casey-rivera')
    // mention_count = 12 (entities) + 1 (facts add) = 13
    expect(casey?.frontmatter['mention_count']).toBe(13)
    // NewPersonFromFacts has mention_count=1 (below threshold) → skipped
    expect(writes.find((w) => w.slug === 'newpersonfromfacts')).toBeUndefined()
    // NewCompanyFromFacts same — single facts mention only.
    expect(writes.find((w) => w.slug === 'newcompanyfromfacts')).toBeUndefined()
  })
})

describe('slugify', () => {
  test('lower-cases + replaces non-alphanumeric with hyphens', () => {
    expect(slugify('Casey Rivera')).toBe('casey-rivera')
    expect(slugify('Compound Engineering!')).toBe('compound-engineering')
    expect(slugify("DHH's Rails Style")).toBe('dhh-s-rails-style')
  })

  test('strips leading + trailing hyphens', () => {
    expect(slugify('  spaces  ')).toBe('spaces')
    expect(slugify('!!!hi!!!')).toBe('hi')
  })

  test('returns null for inputs that sanitize to empty', () => {
    expect(slugify('---')).toBeNull()
    expect(slugify('')).toBeNull()
    expect(slugify('!!!')).toBeNull()
  })

  test('caps long slugs at 80 chars', () => {
    const long = 'a'.repeat(200)
    expect(slugify(long)?.length).toBeLessThanOrEqual(80)
  })
})

describe('threshold constant', () => {
  test('POPULATOR_MENTION_COUNT_MIN === 2', () => {
    expect(POPULATOR_MENTION_COUNT_MIN).toBe(2)
  })
})
