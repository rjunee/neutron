/**
 * The production shard planner (`scripts/lib/shard-partition.ts`) on synthetic
 * inputs. `scripts/run-tests.sh` calls the same module for every sharded run,
 * and `run-tests-shard.test.ts` checks the real tree end to end; this file pins
 * the rule itself (docs/spec-items/host-test-suite-efficiency.md, "Measured CI
 * partition (#1447)"): exact-once coverage, the measured weight, the fallback,
 * deterministic ties, stale records, refusals, the heavy special-lane case and
 * the CLI contract the runner parses.
 *
 * Synthetic profiles are built through `serializeTestCostProfile`, so every one
 * of them is a valid profile under the real validator.
 *
 * Lane names are taken from `LANES` rather than spelled out: the runner sorts a
 * test FILE into its WASM quarantine lane by grepping the file's text for that
 * lane's name, and this file has no business in that lane.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BASE_COST_MS,
  MIG_COST_MS,
  ShardPlanError,
  estimateMicros,
  formatSeconds,
  lanePercentile90,
  planShards,
  type PlanEntry,
} from '../lib/shard-partition.ts'
import {
  LANES,
  parseTestCostProfile,
  serializeTestCostProfile,
  type Lane,
  type TestCostProfile,
} from '../lib/test-cost-profile.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const PLANNER = join(ROOT, 'scripts', 'lib', 'shard-partition.ts')
const COMMITTED_PROFILE = join(ROOT, 'scripts', 'lib', 'test-cost-profile.json')

const [GENERAL, WASM, DEVICE, HTTP] = LANES as unknown as [Lane, Lane, Lane, Lane]
/** A migration-replay call, assembled so this file's own text does not contain one. */
const MIGRATION_CALL_TEXT = 'applyMigrations'.concat('(')

interface Measured { path: string; lane: Lane; cost: number }
interface Unmeasured { path: string; lane: Lane }

/** A valid single-job profile, round-tripped through the real serializer and validator. */
function profileOf(files: Measured[], unmeasured: Unmeasured[] = []): TestCostProfile {
  const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const sortedFiles = files.slice().sort(byPath)
  const sortedUnmeasured = unmeasured.slice().sort(byPath)
  const profile: TestCostProfile = {
    schema: 'neutron-test-cost-profile/v1',
    unit: 'microseconds',
    aggregation: 'sum-of-bun-reported-case-durations-per-file-per-execution-section',
    source: {
      workflow: 'ci',
      runId: 7,
      headSha: 'a'.repeat(40),
      shardCount: 1,
      collector: 'scripts/ci/collect-test-cost-profile.ts',
      jobs: [{
        shard: 1,
        jobId: 11,
        logSha256: 'b'.repeat(64),
        measuredFiles: sortedFiles.length,
        unmeasuredFiles: sortedUnmeasured.length,
        costMicros: sortedFiles.reduce((sum, f) => sum + f.cost, 0),
      }],
    },
    files: sortedFiles.map((f) => ({ path: f.path, lane: f.lane, shard: 1, cases: 1, timedCases: 1, costMicros: f.cost })),
    unmeasured: sortedUnmeasured.map((u) => ({ path: u.path, lane: u.lane, shard: 1, cases: 1 })),
  }
  return parseTestCostProfile(serializeTestCostProfile(profile))
}

const p = (name: string) => `./pkg/${name}.test.ts`
const noRead = (path: string): string => {
  throw new Error(`unexpected read of ${path}`)
}

/** A deterministic shuffle (mulberry32), so a failure reproduces. */
function shuffled<T>(items: T[], seed: number): T[] {
  let s = seed >>> 0
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** A mixed corpus: measured files in every lane, plus files that take the fallback. */
function corpus(size: number): { entries: PlanEntry[]; profile: TestCostProfile; texts: Map<string, string> } {
  const entries: PlanEntry[] = []
  const measured: Measured[] = []
  const unmeasured: Unmeasured[] = []
  const texts = new Map<string, string>()
  for (let i = 0; i < size; i++) {
    const lane = LANES[i % LANES.length]!
    const path = p(`c${String(i).padStart(3, '0')}`)
    entries.push({ lane, path })
    if (i % 5 === 4) {
      // A new file: no record at all.
      texts.set(path, i % 10 === 4 ? `${MIGRATION_CALL_TEXT}db)\n` : 'plain\n')
    } else if (i % 7 === 6) {
      unmeasured.push({ path, lane })
      texts.set(path, 'plain\n')
    } else {
      // Several equal weights, so the tie-break is exercised on every size.
      measured.push({ path, lane, cost: [5_000, 5_000, 120_000, 2_000_000, 0][i % 5]! })
    }
  }
  return { entries, profile: profileOf(measured, unmeasured), texts }
}

function readerOf(texts: Map<string, string>) {
  return (path: string): string => {
    const text = texts.get(path)
    if (text === undefined) throw new Error(`ENOENT ${path}`)
    return text
  }
}

describe('planShards — exact-once coverage', () => {
  for (const shards of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`${shards} shard(s): every entry assigned exactly once across sizes, including fewer files than shards`, () => {
      for (const size of [1, 3, 7, 8, 20, 57]) {
        const { entries, profile, texts } = corpus(size)
        const plan = planShards({ entries, profile, shards, read: readerOf(texts) })
        expect(plan.planned).toBe(size)
        expect(plan.shardOf).toHaveLength(size)
        expect(plan.weights).toHaveLength(size)
        expect(plan.table.map((r) => r.shard)).toEqual(Array.from({ length: shards }, (_, k) => k + 1))
        for (const s of plan.shardOf) {
          expect(Number.isInteger(s)).toBe(true)
          expect(s).toBeGreaterThanOrEqual(1)
          expect(s).toBeLessThanOrEqual(shards)
        }
        expect(plan.table.reduce((sum, r) => sum + r.files, 0)).toBe(size)
        for (const row of plan.table) {
          const mine = plan.shardOf.map((s, i) => [s, i] as const).filter(([s]) => s === row.shard).map(([, i]) => i)
          expect(row.files).toBe(mine.length)
          expect(row.measured + row.fallback).toBe(row.files)
          expect(row.weightMicros).toBe(mine.reduce((sum, i) => sum + plan.weights[i]!, 0))
          // A bin is empty only when there are fewer entries than shards.
          if (size >= shards) expect(row.files).toBeGreaterThan(0)
        }
        if (size < shards) expect(plan.table.filter((r) => r.files === 0)).toHaveLength(shards - size)
      }
    })
  }

  test('the assignment is a function of the set, not of its input order', () => {
    const { entries, profile, texts } = corpus(57)
    for (const shards of [2, 3, 4, 8]) {
      const base = planShards({ entries, profile, shards, read: readerOf(texts) })
      const want = new Map(entries.map((e, i) => [e.path, base.shardOf[i]]))
      for (const seed of [1, 2, 3, 99]) {
        const mixed = shuffled(entries, seed)
        const plan = planShards({ entries: mixed, profile, shards, read: readerOf(texts) })
        expect(new Map(mixed.map((e, i) => [e.path, plan.shardOf[i]]))).toEqual(want)
        expect(plan.table).toEqual(base.table)
      }
    }
  })
})

describe('planShards — deterministic ties', () => {
  test('equal weights are ordered by path, and equal loads go to the lower shard index', () => {
    const files = ['a', 'b', 'c', 'd'].map((n) => ({ path: p(n), lane: GENERAL, cost: 1_000 }))
    const profile = profileOf(files)
    // Input order reversed on purpose: only the path order may matter.
    const entries = files.slice().reverse().map(({ lane, path }) => ({ lane, path }))
    const plan = planShards({ entries, profile, shards: 2, read: noRead })
    const got = Object.fromEntries(entries.map((e, i) => [e.path, plan.shardOf[i]]))
    expect(got).toEqual({ [p('a')]: 1, [p('b')]: 2, [p('c')]: 1, [p('d')]: 2 })
  })

  test('equal loads resolve by file count before index, so zero weights still fill every shard', () => {
    const files = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ path: p(n), lane: GENERAL, cost: 0 }))
    const profile = profileOf(files)
    const entries = files.map(({ lane, path }) => ({ lane, path }))
    const plan = planShards({ entries, profile, shards: 3, read: noRead })
    const got = Object.fromEntries(entries.map((e, i) => [e.path, plan.shardOf[i]]))
    // An index-only tie-break would put all five on shard 1.
    expect(got).toEqual({ [p('a')]: 1, [p('b')]: 2, [p('c')]: 3, [p('d')]: 1, [p('e')]: 2 })
    expect(plan.table.map((r) => r.files)).toEqual([2, 2, 1])
  })

  test('the heaviest file goes first, to the emptiest shard', () => {
    const files = [
      { path: p('light'), lane: GENERAL, cost: 1 },
      { path: p('heavy'), lane: HTTP, cost: 100 },
      { path: p('mid'), lane: WASM, cost: 50 },
    ]
    const profile = profileOf(files)
    const entries = files.map(({ lane, path }) => ({ lane, path }))
    const plan = planShards({ entries, profile, shards: 2, read: noRead })
    expect(plan.shardOf).toEqual([2, 1, 2])
    expect(plan.table.map((r) => r.weightMicros)).toEqual([100, 51])
  })
})

describe('planShards — measured weights and the fallback', () => {
  // General lane measured at 1..10 s: nearest-rank P90 is the 9th value, 9 s.
  const generalCosts = Array.from({ length: 10 }, (_, i) => (i + 1) * 1_000_000)
  const measured: Measured[] = [
    ...generalCosts.map((cost, i) => ({ path: p(`g${i}`), lane: GENERAL, cost })),
    { path: p('h0'), lane: HTTP, cost: 40_000 },
    { path: p('h1'), lane: HTTP, cost: 60_000 },
  ]
  const profile = profileOf(measured, [{ path: p('was-untimed'), lane: GENERAL }])

  test('nearest-rank P90 per lane, falling back to every measured cost for a lane with none', () => {
    expect(lanePercentile90(profile, GENERAL)).toBe(9_000_000)
    expect(lanePercentile90(profile, HTTP)).toBe(60_000)
    const all = measured.map((m) => m.cost).sort((a, b) => a - b)
    expect(lanePercentile90(profile, DEVICE)).toBe(all[Math.ceil(0.9 * all.length) - 1]!)
    expect(lanePercentile90(profileOf([]), GENERAL)).toBe(0)
  })

  test('the content estimate is BASE_COST_MS + MIG_COST_MS per migration replay, in microseconds', () => {
    expect(estimateMicros('nothing here')).toBe(BASE_COST_MS * 1000)
    expect(estimateMicros(`${MIGRATION_CALL_TEXT}a)\n${'applyMigrationsToProjectDb'.concat('(')}b)\n`))
      .toBe((BASE_COST_MS + 2 * MIG_COST_MS) * 1000)
  })

  test('a measured file weighs its recorded cost and is never read', () => {
    const plan = planShards({ entries: [{ lane: GENERAL, path: p('g3') }], profile, shards: 1, read: noRead })
    expect(plan.weights).toEqual([4_000_000])
    expect(plan.table[0]).toMatchObject({ measured: 1, fallback: 0, weightMicros: 4_000_000 })
    expect(plan.used).toBe(1)
  })

  test('a new file takes max(estimate, lane P90): P90 when it is larger', () => {
    const plan = planShards({ entries: [{ lane: GENERAL, path: p('new') }], profile, shards: 1, read: () => 'plain\n' })
    expect(plan.weights).toEqual([9_000_000])
    expect(plan.table[0]).toMatchObject({ measured: 0, fallback: 1 })
  })

  test('a new heavy-migration file whose estimate exceeds the lane P90 takes the estimate', () => {
    const text = `${MIGRATION_CALL_TEXT}db)\n`.repeat(100)
    const plan = planShards({ entries: [{ lane: GENERAL, path: p('new') }], profile, shards: 1, read: () => text })
    expect(plan.weights).toEqual([(BASE_COST_MS + 100 * MIG_COST_MS) * 1000])
  })

  test('the estimate wins in a lane whose P90 is below it', () => {
    const plan = planShards({ entries: [{ lane: HTTP, path: p('new') }], profile, shards: 1, read: () => 'plain\n' })
    expect(plan.weights).toEqual([Math.max(BASE_COST_MS * 1000, 60_000)])
  })

  test('an unmeasured-record file is unknown, not zero: it takes the fallback', () => {
    const plan = planShards({ entries: [{ lane: GENERAL, path: p('was-untimed') }], profile, shards: 1, read: () => 'plain\n' })
    expect(plan.weights).toEqual([9_000_000])
    expect(plan.weights[0]).toBeGreaterThan(0)
    expect(plan.table[0]).toMatchObject({ measured: 0, fallback: 1 })
    expect(plan.used).toBe(0)
  })

  test('the fallback uses the file CURRENT lane, and a lane with no records uses the global P90', () => {
    // h0 is recorded in the http lane, but is measured, so its lane does not matter;
    // a new device-lane file has no lane records and takes the all-lane P90.
    const plan = planShards({ entries: [{ lane: DEVICE, path: p('new-device') }], profile, shards: 1, read: () => 'plain\n' })
    expect(plan.weights).toEqual([lanePercentile90(profile, DEVICE)])
    expect(plan.weights[0]).toBe(9_000_000)
  })

  test('profile records for files no longer discovered are counted as stale and never planned', () => {
    const entries = [{ lane: GENERAL, path: p('g0') }, { lane: HTTP, path: p('h1') }]
    const plan = planShards({ entries, profile, shards: 2, read: noRead })
    // 12 measured + 1 unmeasured records, 2 of them discovered.
    expect(plan.stale).toBe(11)
    expect(plan.used).toBe(2)
    expect(plan.planned).toBe(2)
  })
})

describe('planShards — refusals', () => {
  const profile = profileOf([{ path: p('a'), lane: GENERAL, cost: 10 }])
  const ok: PlanEntry = { lane: GENERAL, path: p('a') }
  const refused: [string, { entries: PlanEntry[]; shards: number }][] = [
    ['empty input', { entries: [], shards: 2 }],
    ['a duplicate path', { entries: [ok, { lane: HTTP, path: p('a') }], shards: 2 }],
    ['a tab in a path', { entries: [ok, { lane: GENERAL, path: './pkg/x\ty.test.ts' }], shards: 2 }],
    ['a line break in a path', { entries: [ok, { lane: GENERAL, path: './pkg/x\ny.test.ts' }], shards: 2 }],
    ['an empty path', { entries: [ok, { lane: GENERAL, path: '' }], shards: 2 }],
    ['an unknown lane', { entries: [ok, { lane: 'gpu', path: p('b') }], shards: 2 }],
    ['zero shards', { entries: [ok], shards: 0 }],
    ['65 shards', { entries: [ok], shards: 65 }],
    ['a fractional shard count', { entries: [ok], shards: 1.5 }],
  ]
  for (const [name, input] of refused) {
    test(`refuses ${name}`, () => {
      expect(() => planShards({ ...input, profile, read: () => '' })).toThrow(ShardPlanError)
    })
  }

  test('refuses an unreadable fallback file instead of guessing its weight', () => {
    expect(() => planShards({
      entries: [ok, { lane: GENERAL, path: p('missing') }],
      profile,
      shards: 2,
      read: () => { throw new Error('ENOENT') },
    })).toThrow(/cannot read fallback file/)
  })
})

describe('planShards — a heavy special-lane file', () => {
  test('one real-HTTP file at 60% of the total gets a shard with the least other weight', () => {
    const general: Measured[] = Array.from({ length: 40 }, (_, i) => ({
      path: p(`g${String(i).padStart(2, '0')}`), lane: GENERAL, cost: 1_000_000 + (i % 3) * 250_000,
    }))
    const others = general.reduce((sum, f) => sum + f.cost, 0)
    // heavy / (heavy + others) = 0.6
    const heavy: Measured = { path: p('zz-heavy'), lane: HTTP, cost: Math.round((others * 3) / 2) }
    const profile = profileOf([...general, heavy])
    const entries = [...general, heavy].map(({ lane, path }) => ({ lane, path }))
    const plan = planShards({ entries, profile, shards: 4, read: noRead })
    const heavyShard = plan.shardOf[entries.length - 1]!
    const otherWeight = plan.table.map((r) => r.weightMicros - (r.shard === heavyShard ? heavy.cost : 0))
    expect(Math.min(...otherWeight)).toBe(otherWeight[heavyShard - 1]!)
    const total = others + heavy.cost
    const makespan = Math.max(...plan.table.map((r) => r.weightMicros))
    expect(makespan).toBeLessThanOrEqual(1.1 * Math.max(Math.ceil(total / 4), heavy.cost))
  })
})

describe('formatSeconds', () => {
  test('exact six-decimal seconds from integer microseconds', () => {
    expect(formatSeconds(0)).toBe('0.000000')
    expect(formatSeconds(486_164_410)).toBe('486.164410')
    expect(formatSeconds(1_000_001)).toBe('1.000001')
    expect(() => formatSeconds(-1)).toThrow()
    expect(() => formatSeconds(0.5)).toThrow()
  })
})

describe('shard-partition CLI', () => {
  function cli(args: string[], stdin: string, cwd: string) {
    const r = spawnSync(process.execPath, [PLANNER, ...args], { cwd, input: stdin, encoding: 'utf8' })
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
  }
  function withDir(body: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'shard-partition-cli-'))
    try { body(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const files: Measured[] = [
    { path: p('a'), lane: GENERAL, cost: 3_000_000 },
    { path: p('b'), lane: HTTP, cost: 2_000_000 },
    { path: p('c'), lane: WASM, cost: 1_000_000 },
  ]
  const valid = serializeTestCostProfile(profileOf(files, [{ path: p('stale'), lane: DEVICE }]))

  test('--shard prints the whole table, the totals, the profile line and only this shard, in input order', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'profile.json'), valid)
      mkdirSync(join(dir, 'pkg'))
      writeFileSync(join(dir, 'pkg', 'new.test.ts'), 'plain\n')
      const manifest = [`${GENERAL}\t${p('a')}`, `${HTTP}\t${p('b')}`, `${GENERAL}\t${p('new')}`, `${WASM}\t${p('c')}`].join('\n') + '\n'
      const r = cli(['--profile', 'profile.json', '--shard', '2/2'], manifest, dir)
      expect(r.stderr).toBe('')
      expect(r.code).toBe(0)
      // Weights: a 3 s, b 2 s, new = max(0.15 s, general P90 = 3 s) = 3 s, c 1 s.
      // Order a, new (equal weight, path order), b, c. a:1, new:2, b:1 (equal
      // load and count, lower index), c:2.
      expect(r.stdout).toBe([
        'shard\t1\t2\t2\t0\t5000000',
        'shard\t2\t2\t1\t1\t4000000',
        'planned\t4\t4',
        'profile\t7\t3\t1',
        `assign\t${GENERAL}\t${p('new')}`,
        `assign\t${WASM}\t${p('c')}`,
      ].join('\n') + '\n')
    })
  })

  for (const [name, mutate] of [
    ['bad JSON', (text: string) => text.slice(0, -3)],
    ['a negative cost', (text: string) => text.replace('"costMicros": 3000000', '"costMicros": -3000000')],
    ['an unknown key', (text: string) => text.replace('"schema":', '"extra": 1,\n  "schema":')],
  ] as const) {
    test(`a profile with ${name} refuses with no stdout`, () => {
      withDir((dir) => {
        const corrupt = mutate(valid)
        expect(corrupt).not.toBe(valid)
        writeFileSync(join(dir, 'profile.json'), corrupt)
        for (const args of [['--validate'], ['--shard', '1/2']]) {
          const r = cli(['--profile', 'profile.json', ...args], `${GENERAL}\t${p('a')}\n`, dir)
          expect(r.code).not.toBe(0)
          expect(r.stderr).toContain('run-tests: FATAL — test cost profile invalid: ')
          expect(r.stdout).toBe('')
        }
      })
    })
  }

  test('a planner refusal (duplicate path, unreadable fallback) has no stdout', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'profile.json'), valid)
      for (const manifest of [`${GENERAL}\t${p('a')}\n${HTTP}\t${p('a')}\n`, `${GENERAL}\t${p('absent')}\n`, '', 'no-tab-here\n']) {
        const r = cli(['--profile', 'profile.json', '--shard', '1/1'], manifest, dir)
        expect(r.code).not.toBe(0)
        expect(r.stderr).toContain('run-tests: FATAL — shard planner: ')
        expect(r.stdout).toBe('')
      }
    })
  })

  test('a missing profile and bad arguments refuse', () => {
    withDir((dir) => {
      const missing = cli(['--profile', 'nope.json', '--validate'], '', dir)
      expect(missing.code).not.toBe(0)
      expect(missing.stderr).toContain('test cost profile invalid')
      writeFileSync(join(dir, 'profile.json'), valid)
      for (const args of [[], ['--profile', 'profile.json'], ['--profile', 'profile.json', '--shard', '3/2'],
        ['--profile', 'profile.json', '--shard', '1/65'], ['--profile', 'profile.json', '--validate', '--shard', '1/1']]) {
        const r = cli(args, `${GENERAL}\t${p('a')}\n`, dir)
        expect(r.code).not.toBe(0)
        expect(r.stdout).toBe('')
        expect(r.stderr).toContain('run-tests: FATAL — ')
      }
    })
  })

  test('--validate accepts the committed profile', () => {
    const r = cli(['--profile', COMMITTED_PROFILE, '--validate'], '', ROOT)
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('')
    expect(r.code).toBe(0)
    // And it is the canonical text the validator itself would write.
    expect(serializeTestCostProfile(parseTestCostProfile(readFileSync(COMMITTED_PROFILE, 'utf8'))))
      .toBe(readFileSync(COMMITTED_PROFILE, 'utf8'))
  })
})
