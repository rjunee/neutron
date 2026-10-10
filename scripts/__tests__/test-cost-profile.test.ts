/**
 * The measured test-cost profile contract (scripts/lib/test-cost-profile.ts):
 * strict, all-or-nothing validation, canonical serialization, and the committed
 * evidence derived from CI run 38001520250
 * (docs/spec-items/host-test-suite-efficiency.md, "Measured CI partition").
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGGREGATION,
  COLLECTOR,
  LANES,
  SCHEMA,
  TestCostProfileError,
  isDiscoveredTestPath,
  parseTestCostProfile,
  serializeTestCostProfile,
} from '../lib/test-cost-profile.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const COMMITTED = join(ROOT, 'scripts', 'lib', 'test-cost-profile.json')

type Json = Record<string, unknown>

/** A minimal valid two-shard profile, as a plain JSON value. */
function minimal(): Json {
  return {
    schema: SCHEMA,
    unit: 'microseconds',
    aggregation: AGGREGATION,
    source: {
      workflow: 'ci',
      runId: 7,
      headSha: 'a'.repeat(40),
      shardCount: 2,
      collector: COLLECTOR,
      jobs: [
        { shard: 1, jobId: 11, logSha256: 'b'.repeat(64), measuredFiles: 2, unmeasuredFiles: 0, costMicros: 3500 },
        { shard: 2, jobId: 12, logSha256: 'c'.repeat(64), measuredFiles: 1, unmeasuredFiles: 1, costMicros: 250 },
      ],
    },
    files: [
      { path: './alpha/one.test.ts', lane: 'general', shard: 1, cases: 3, timedCases: 2, costMicros: 1500 },
      { path: './alpha/two.spec.tsx', lane: 'http', shard: 1, cases: 1, timedCases: 1, costMicros: 2000 },
      { path: './beta/three.test.mjs', lane: 'pglite', shard: 2, cases: 4, timedCases: 4, costMicros: 250 },
    ],
    unmeasured: [{ path: './beta/four.test.js', lane: 'device', shard: 2, cases: 2 }],
  }
}

function text(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Apply `edit` to a fresh minimal profile and expect a specific refusal. */
function refuses(edit: (p: any) => void, reason: RegExp): void {
  const p = minimal()
  edit(p)
  let caught: unknown
  try {
    parseTestCostProfile(text(p))
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(TestCostProfileError)
  expect((caught as Error).message).toMatch(reason)
}

describe('test-cost profile — positive', () => {
  test('a minimal profile round-trips byte-identically', () => {
    const canonical = text(minimal())
    const parsed = parseTestCostProfile(canonical)
    expect(serializeTestCostProfile(parsed)).toBe(canonical)
    expect(serializeTestCostProfile(parseTestCostProfile(serializeTestCostProfile(parsed)))).toBe(canonical)
    expect(parsed.files.map((f) => f.path)).toEqual(['./alpha/one.test.ts', './alpha/two.spec.tsx', './beta/three.test.mjs'])
    expect(parsed.unmeasured).toEqual([{ path: './beta/four.test.js', lane: 'device', shard: 2, cases: 2 }])
  })

  test('serialization writes the fixed key order whatever the input order', () => {
    const p = minimal()
    const reordered = Object.fromEntries(Object.entries(p).reverse())
    expect(serializeTestCostProfile(parseTestCostProfile(JSON.stringify(reordered)))).toBe(text(p))
  })

  test('every lane and every discovered suffix is accepted', () => {
    expect([...LANES]).toEqual(['general', 'pglite', 'device', 'http'])
    for (const kind of ['test', 'spec']) {
      for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']) {
        expect(isDiscoveredTestPath(`./a/b.${kind}.${ext}`)).toBe(true)
      }
    }
  })
})

describe('test-cost profile — refusals (whole input, never partial)', () => {
  test('invalid JSON', () => {
    expect(() => parseTestCostProfile('{"schema":')).toThrow(TestCostProfileError)
    expect(() => parseTestCostProfile('')).toThrow(/not valid JSON/)
  })
  test('wrong schema, unit, aggregation, workflow or collector', () => {
    refuses((p) => { p.schema = 'neutron-test-cost-profile/v2' }, /^schema must be/)
    refuses((p) => { p.unit = 'milliseconds' }, /^unit must be/)
    refuses((p) => { p.aggregation = 'max' }, /^aggregation must be/)
    refuses((p) => { p.source.workflow = 'nightly' }, /source.workflow must be/)
    refuses((p) => { p.source.collector = 'other.ts' }, /source.collector must be/)
  })
  test('an unknown key at every level', () => {
    refuses((p) => { p.extra = 1 }, /profile has unknown key 'extra'/)
    refuses((p) => { p.source.extra = 1 }, /source has unknown key 'extra'/)
    refuses((p) => { p.source.jobs[0].extra = 1 }, /source.jobs\[0\] has unknown key 'extra'/)
    refuses((p) => { p.files[1].extra = 1 }, /files\[1\] has unknown key 'extra'/)
    refuses((p) => { p.unmeasured[0].timedCases = 0 }, /unmeasured\[0\] has unknown key 'timedCases'/)
  })
  test('a missing field', () => {
    refuses((p) => { delete p.unmeasured }, /profile is missing 'unmeasured'/)
    refuses((p) => { delete p.source.headSha }, /source is missing 'headSha'/)
    refuses((p) => { delete p.source.jobs[1].logSha256 }, /source.jobs\[1\] is missing 'logSha256'/)
    refuses((p) => { delete p.files[0].costMicros }, /files\[0\] is missing 'costMicros'/)
    refuses((p) => { delete p.unmeasured[0].cases }, /unmeasured\[0\] is missing 'cases'/)
  })
  test('non-integer, unsafe, non-finite, negative and string numbers', () => {
    refuses((p) => { p.files[0].costMicros = 1.5 }, /files\[0\].costMicros must be a non-negative safe integer/)
    refuses((p) => { p.files[0].costMicros = 2 ** 53 }, /files\[0\].costMicros must be a non-negative safe integer/)
    refuses((p) => { p.files[0].costMicros = -1 }, /files\[0\].costMicros must be a non-negative safe integer/)
    refuses((p) => { p.files[0].cases = '5' }, /files\[0\].cases must be a non-negative safe integer/)
    // JSON has no Infinity literal; 1e400 is how a non-finite value arrives.
    const p = minimal()
    const raw = text(p).replace('"costMicros": 1500', '"costMicros": 1e400')
    expect(raw).toContain('1e400')
    expect(() => parseTestCostProfile(raw)).toThrow(/files\[0\].costMicros must be a non-negative safe integer/)
  })
  test('duplicate, cross-set and unsorted paths', () => {
    refuses((p) => { p.files[1].path = p.files[0].path }, /files\[1\].path duplicates files\[0\].path/)
    refuses((p) => { p.unmeasured[0].path = './alpha/one.test.ts' }, /unmeasured\[0\].path is also in files/)
    refuses((p) => { p.files.reverse() }, /not in ascending byte order/)
  })
  test('every invalid path shape', () => {
    const shapes: Array<[string, RegExp]> = [
      ['/abs/one.test.ts', /does not start with '\.\/'/],
      ['alpha/one.test.ts', /does not start with '\.\/'/],
      ['./alpha/../one.test.ts', /contains a '\.\.' segment/],
      ['./alpha/./one.test.ts', /contains a '\.' segment/],
      ['./.claude/one.test.ts', /dot-leading segment/],
      ['./node_modules/x/one.test.ts', /node_modules segment/],
      ['./alpha\\one.test.ts', /outside printable ASCII/],
      ['./alpha/one two.test.ts', /outside printable ASCII/],
      ['./alpha/one.ts', /discovered test suffix/],
      ['./alpha//one.test.ts', /empty segment/],
      ['', /is empty/],
      [`./${'a'.repeat(600)}.test.ts`, /exceeds/],
    ]
    for (const [shape, reason] of shapes) {
      expect(isDiscoveredTestPath(shape)).toBe(false)
      refuses((p) => { p.unmeasured[0].path = shape }, reason)
    }
  })
  test('shard out of range and job count mismatch', () => {
    refuses((p) => { p.files[0].shard = 0 }, /files\[0\].shard 0 is outside 1..2/)
    refuses((p) => { p.unmeasured[0].shard = 3 }, /unmeasured\[0\].shard 3 is outside 1..2/)
    refuses((p) => { p.source.jobs.pop() }, /source.jobs has 1 entries for shardCount 2/)
    refuses((p) => { p.source.jobs.reverse() }, /source.jobs\[0\].shard must be 1/)
    refuses((p) => { p.files[0].lane = 'fast' }, /files\[0\].lane must be one of/)
  })
  test('per-job totals that disagree with the records', () => {
    refuses((p) => { p.source.jobs[0].costMicros = 3499 }, /source.jobs\[0\].costMicros 3499 != record sum 3500/)
    refuses((p) => { p.source.jobs[1].measuredFiles = 2 }, /source.jobs\[1\].measuredFiles 2 != 1 records/)
    refuses((p) => { p.source.jobs[1].unmeasuredFiles = 0 }, /source.jobs\[1\].unmeasuredFiles 0 != 1 records/)
  })
  test('timedCases above cases, or an untimed record in files', () => {
    refuses((p) => { p.files[0].timedCases = 4 }, /files\[0\].timedCases exceeds cases/)
    refuses((p) => { p.files[0].timedCases = 0 }, /files\[0\].timedCases must be at least 1/)
  })
  test('malformed provenance', () => {
    refuses((p) => { p.source.headSha = 'A'.repeat(40) }, /source.headSha must be 40 lowercase hex/)
    refuses((p) => { p.source.jobs[0].logSha256 = 'b'.repeat(63) }, /logSha256 must be 64 lowercase hex/)
    refuses((p) => { p.source.jobs[1].jobId = 11 }, /jobId 11 is duplicated/)
  })
})

describe('the committed profile (CI run 38001520250)', () => {
  const raw = readFileSync(COMMITTED, 'utf8')
  const profile = parseTestCostProfile(raw)

  test('is canonical and carries its provenance', () => {
    expect(serializeTestCostProfile(profile)).toBe(raw)
    expect(profile.source.runId).toBe(38001520250)
    expect(profile.source.headSha).toBe('b44be1e7dc1fd6b9cca1af5f52dd1ca020549f5f')
    expect(profile.source.shardCount).toBe(4)
    expect(profile.source.jobs.map((j) => j.jobId)).toEqual([114060452722, 114060452839, 114060452686, 114060452847])
  })

  test('reproduces the measured counts and per-shard case-time sums', () => {
    expect(profile.files.length + profile.unmeasured.length).toBe(1809)
    expect(profile.files.length).toBe(1803)
    expect(profile.unmeasured.length).toBe(6)
    expect(profile.source.jobs.map((j) => j.costMicros)).toEqual([486164410, 328018530, 282801420, 260589780])
    expect(profile.source.jobs.reduce((n, j) => n + j.measuredFiles + j.unmeasuredFiles, 0)).toBe(1809)
  })

  test('records the heavyweight real-HTTP E2E file on shard 1', () => {
    const e2e = profile.files.find((f) => f.path === './open/__tests__/project-build-e2e.test.ts')
    expect(e2e).toEqual({
      path: './open/__tests__/project-build-e2e.test.ts',
      lane: 'http',
      shard: 1,
      cases: 628,
      timedCases: 628,
      costMicros: 294584320,
    })
  })

  test('stores no host path, raw log text or case name', () => {
    expect(raw).not.toMatch(/"\/|\\\\|\(pass\)|##\[group\]|\bZ /)
  })
})
