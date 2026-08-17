/**
 * Cross-runner sharding for `scripts/run-tests.sh` (`NEUTRON_TEST_SHARD=i/n`).
 *
 * WHY THIS SUITE IS LOAD-BEARING. Unsharded, the runner could prove coverage by
 * itself: it discovered N files, executed N files, done. Sharded, no single run
 * can make that claim — each proves only that it ran its own slice. The
 * whole-suite guarantee now rests on three things, and if any one of them
 * breaks, files stop running and NOTHING reports a failure:
 *
 *   1. every shard performs identical, deterministic discovery;
 *   2. the partition has no gaps and no overlap;
 *   3. CI requires every shard to report (the aggregator `test` job).
 *
 * (2) is a property of this script and is what these tests pin. (3) is pinned in
 * `ci-workflow.test.ts`. A silent coverage hole is the worst possible failure
 * mode for a test runner — it looks exactly like success — so the partition gets
 * asserted directly rather than trusted.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const RUN_TESTS = join(ROOT, 'scripts', 'run-tests.sh')
const TIMINGS = join(ROOT, 'scripts', 'test-timings.json')

/**
 * Ask the script which files a shard would execute, without executing them.
 * `NEUTRON_BUN_BIN` points at a stub that prints nothing and exits 0, so the
 * chunk runs are no-ops and only the planning output matters.
 */
// Each planner invocation costs ~15s, so any test that makes several blows bun's
// 5s per-test default. That default is exactly the kind of invisible inherited
// deadline that made ISSUES #364 look flaky, so the budget is stated EXPLICITLY
// at each slow test rather than left to be discovered from a timeout message.
const PLAN_BUDGET_MS = 180_000
// The synthetic-seam cases spawn ~4-12 bash planners each, which is milliseconds
// of work and seconds of it on a box running four other lanes. The default 5 s
// budget is exactly the inherited deadline that turned CPU contention into six
// "failures" on 2026-08-17, so it is stated rather than inherited here too.
const FIXTURE_BUDGET_MS = 60_000

function shardPlan(spec: string | null): { code: number; out: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NEUTRON_TEST_PLAN_ONLY: '1',
  }
  if (spec !== null) env['NEUTRON_TEST_SHARD'] = spec
  else delete env['NEUTRON_TEST_SHARD']
  const r = spawnSync('bash', [RUN_TESTS], { encoding: 'utf8', env, cwd: ROOT })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

/**
 * Plan a shard over a SYNTHETIC file list and a SYNTHETIC manifest.
 *
 * `NEUTRON_TEST_DISCOVER_OVERRIDE` (the seam in `scripts/lib/discover-test-files.sh`)
 * replaces the filesystem walk, so these cases cost milliseconds instead of the
 * ~15 s a real plan costs. The named files do not have to exist: the partition
 * reads the manifest for a COST and the file list for MEMBERSHIP, and never the
 * other way round — which is precisely the property being tested.
 */
function fixturePlan(files: string[], manifestPath: string, spec: string): { code: number; out: string } {
  const r = spawnSync('bash', [RUN_TESTS], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...(process.env as Record<string, string>),
      NEUTRON_TEST_PLAN_ONLY: '1',
      NEUTRON_TEST_DISCOVER_OVERRIDE: files.join(' '),
      NEUTRON_TEST_TIMINGS: manifestPath,
      NEUTRON_TEST_SHARD: spec,
    },
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

/** Write a manifest into a scratch dir and hand back its path. */
function manifest(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-timings-'))
  const path = join(dir, 'test-timings.json')
  writeFileSync(path, body)
  return path
}

/** The per-shard predicted seconds the runner prints, e.g. `1:120s 2:118s`. */
function predictedTotals(out: string): number[] {
  const line = out.split('\n').find((l) => l.startsWith('run-tests: predicted shard seconds'))
  if (line === undefined) return []
  return [...line.matchAll(/\b\d+:(\d+)s/g)].map((m) => Number(m[1]))
}

/**
 * The largest single-file cost in the COMMITTED manifest — the bound the greedy
 * partition guarantees the spread cannot exceed. Read from the shipped file so
 * the bound tracks the real suite instead of a number frozen in a test.
 */
function heaviestFileCost(): number {
  const parsed = JSON.parse(readFileSync(TIMINGS, 'utf8')) as Record<string, number>
  const values = Object.values(parsed).filter((v) => typeof v === 'number' && Number.isFinite(v))
  expect(values.length).toBeGreaterThan(0)
  return Math.max(...values)
}

/** Union of every shard's plan, for the synthetic cases. */
function unionOverShards(files: string[], manifestPath: string, n: number): string[] {
  const out: string[] = []
  for (let i = 1; i <= n; i++) {
    const r = fixturePlan(files, manifestPath, `${i}/${n}`)
    expect(r.code).toBe(0)
    out.push(...filesOf(r.out))
  }
  return out
}

function filesOf(out: string): string[] {
  const lines = out.split('\n')
  const start = lines.findIndex((l) => l === 'run-tests: PLAN-ONLY BEGIN')
  const end = lines.findIndex((l) => l === 'run-tests: PLAN-ONLY END')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return lines.slice(start + 1, end).filter((l) => l.length > 0)
}

describe('run-tests.sh shard partition', () => {
  const full = shardPlan(null)
  const all = filesOf(full.out)

  test('the unsharded plan is the whole discovered set', () => {
    expect(full.code).toBe(0)
    // Sanity floor: this repo has hundreds of test files. A tiny number here
    // would mean discovery broke and every assertion below would be vacuous.
    expect(all.length).toBeGreaterThan(100)
    expect(new Set(all).size).toBe(all.length)
  }, PLAN_BUDGET_MS)

  // Each planner invocation costs ~15s (discovery + the pglite content grep over
  // ~1000 files), so the shard counts are chosen, not exhaustive: 2 and 4 pin the
  // partition property, and the degenerate 1/1 pins the no-sharding case. Adding
  // 3 and 6 would cost another ~90s to re-test the same modular arithmetic.
  const laneCounts: number[] = []
  for (const n of [2, 4]) {
    test(`${n} shards partition the set exactly — no gaps, no overlap`, () => {
      const slices: string[][] = []
      const outs: string[] = []
      for (let i = 1; i <= n; i++) {
        const r = shardPlan(`${i}/${n}`)
        expect(r.code).toBe(0)
        slices.push(filesOf(r.out))
        outs.push(r.out)
        if (n === 4) {
          const m = r.out.match(/executing \d+ general \+ (\d+) PGLite/)
          laneCounts.push(m ? Number(m[1]) : 0)
        }
      }
      const union = slices.flat()

      // NO OVERLAP — a duplicated file wastes a runner; worse, it hides the
      // fact that some other file is missing when only the total is checked.
      expect(new Set(union).size).toBe(union.length)

      // NO GAPS — the union must be exactly the full set. This is THE assertion
      // the sharded coverage guarantee depends on.
      expect(union.slice().sort()).toEqual(all.slice().sort())

      // BALANCE IS NOW MEASURED IN SECONDS, NOT IN FILES — deliberately, and this
      // is the one assertion in this suite that CHANGED rather than being added.
      // The old form was `max(files) - min(files) <= 1`, which is exactly the
      // property that let CI shards come out at 204 s / 304 s / 412 s: equal file
      // counts over a suite where a handful of files dominate. Asserting it now
      // would FORBID the fix. What replaces it is strictly stronger, because it
      // is a bound on the thing wall-clock is actually made of.
      //
      // The bound is not a tuned constant, it is the guarantee greedy
      // longest-first gives: the last file placed on the heaviest shard went
      // there because that shard was the LIGHTEST at the time, so
      //   max_final <= (that shard's load before) + cost(file)
      //             <= min_final + max cost of any single file.
      // A partition that violates it is not merely unbalanced — it is not
      // greedy-longest-first any more.
      // Every shard computes the SAME bucket loads (that is what makes the
      // partition a partition), so the prediction line is read off the run
      // already made rather than costing another ~15 s planner invocation.
      const totals = predictedTotals(outs[0] ?? '')
      expect(totals).toHaveLength(n)
      expect(new Set(outs.map((o) => predictedTotals(o).join(',')))).toHaveLength(1)
      expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(heaviestFileCost())
    }, PLAN_BUDGET_MS)
  }

  test('1/1 is exactly the unsharded set — the degenerate case is not special', () => {
    expect(filesOf(shardPlan('1/1').out).slice().sort()).toEqual(all.slice().sort())
  }, PLAN_BUDGET_MS)

  test('the PGLite lane is spread across shards, not dumped on one', () => {
    // The lane is serial with a retry budget, so concentrating it would make one
    // runner the long pole and cancel most of the benefit of sharding. Reuses the
    // n=4 outputs captured above rather than re-planning (another ~60s).
    expect(laneCounts).toHaveLength(4)
    const total = laneCounts.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(0)
    expect(Math.max(...laneCounts)).toBeLessThan(total)
  })

  for (const bad of ['0/4', '5/4', '1/0', 'x/4', '4', '1/y', '-1/4']) {
    test(`a malformed shard spec "${bad}" FAILS LOUD rather than running a subset`, () => {
      // Silently treating a bad spec as "run everything" would be tolerable;
      // silently treating it as "run nothing" would be a green CI that tested
      // zero files. Refusing to start is the only safe behaviour.
      const r = shardPlan(bad)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('NEUTRON_TEST_SHARD')
    })
  }

  // ── THE MANIFEST IS AN OPTIMISATION, NEVER AN AUTHORITY ────────────────────
  // The partition now reads `scripts/test-timings.json` for a COST. A cost table
  // is data that ROTS: files are added, deleted and renamed between the run that
  // measured it and the run that reads it. The one thing that must survive every
  // state of that rot is the partition property itself — every discovered file in
  // exactly one shard — because a coverage hole looks exactly like success.
  //
  // These cases drive the synthetic seam, so they cost milliseconds and can
  // afford to be exhaustive about the rot instead of picking one example.
  describe('a rotten manifest degrades BALANCE and never CORRECTNESS', () => {
    const FILES = ['./a.test.ts', './b.test.ts', './c.test.ts', './d.test.ts', './e.test.ts', './f.test.ts', './g.test.ts']

    const cases: Array<[string, string]> = [
      ['EMPTY — the manifest exists but names nothing', '{}'],
      [
        'PARTIAL — only some files are priced',
        JSON.stringify({ './a.test.ts': 90, './b.test.ts': 40 }, null, 2),
      ],
      [
        'STALE — it prices files that no longer exist, and misses ones that do',
        JSON.stringify({ './a.test.ts': 90, './deleted.test.ts': 500, './also-gone.test.ts': 300 }, null, 2),
      ],
      ['CORRUPT — not JSON at all', 'this is not json {{{ 12'],
      ['ABSENT — there is no manifest file', ''],
    ]

    for (const [label, body] of cases) {
      test(`${label}: 4 shards still partition the set exactly`, () => {
        const path = body === '' ? join(tmpdir(), 'run-tests-timings-absent', 'nope.json') : manifest(body)
        const union = unionOverShards(FILES, path, 4)

        // No overlap.
        expect(new Set(union).size).toBe(union.length)
        // No gaps — every discovered file ran on exactly one shard.
        expect(union.slice().sort()).toEqual(FILES.slice().sort())
      }, FIXTURE_BUDGET_MS)
    }

    test('a file the manifest does not name is still assigned — a new test needs no manifest bump', () => {
      // The point of failure this guards: an implementation that walked the
      // MANIFEST and emitted its entries would silently drop every file added
      // since the manifest was generated. Here only `a` is priced, and all seven
      // must still run.
      const path = manifest(JSON.stringify({ './a.test.ts': 90 }))
      expect(unionOverShards(FILES, path, 3).slice().sort()).toEqual(FILES.slice().sort())
    }, FIXTURE_BUDGET_MS)

    test('a manifest entry for a file that no longer exists cannot conjure one INTO a shard', () => {
      const path = manifest(JSON.stringify({ './deleted.test.ts': 900, './a.test.ts': 5 }))
      const union = unionOverShards(FILES, path, 2)
      expect(union).not.toContain('./deleted.test.ts')
      expect(union.slice().sort()).toEqual(FILES.slice().sort())
    }, FIXTURE_BUDGET_MS)

    test('the durations actually STEER the split — the dominant file gets a shard to itself', () => {
      // The whole point of the change, asserted directly: with one file costing
      // more than all the others put together, a count-balanced partition would
      // still hand its shard two more files. A duration-balanced one does not.
      const path = manifest(JSON.stringify({ './a.test.ts': 500 }))
      const heavy = filesOf(fixturePlan(FILES, path, '1/3').out)
      expect(heavy).toEqual(['./a.test.ts'])
      const totals = predictedTotals(fixturePlan(FILES, path, '1/3').out)
      expect(totals[0]).toBe(500)
    }, FIXTURE_BUDGET_MS)

    test('every shard predicts the SAME loads, which is what makes the partition agree', () => {
      // Each runner computes the partition independently and never talks to the
      // others, so identical predictions are the observable proof they agreed.
      const path = manifest(JSON.stringify({ './a.test.ts': 90, './c.test.ts': 30 }))
      const seen = new Set<string>()
      for (let i = 1; i <= 4; i++) seen.add(predictedTotals(fixturePlan(FILES, path, `${i}/4`).out).join(','))
      expect(seen.size).toBe(1)
    }, FIXTURE_BUDGET_MS)

    test('more shards than files leaves the extra shards empty, never duplicated', () => {
      const path = manifest('{}')
      const union = unionOverShards(FILES, path, 12)
      expect(union.slice().sort()).toEqual(FILES.slice().sort())
    }, FIXTURE_BUDGET_MS)
  })

  test('the committed manifest is well-formed and prices the real suite', () => {
    // A manifest that parsed but was empty would make the partition silently
    // count-based again — the exact regression this change exists to undo, and
    // invisible without an assertion, because everything would still be green.
    const parsed = JSON.parse(readFileSync(TIMINGS, 'utf8')) as Record<string, number>
    const entries = Object.entries(parsed)
    expect(entries.length).toBeGreaterThan(100)
    for (const [path, seconds] of entries) {
      expect(path.startsWith('./')).toBe(true)
      expect(typeof seconds).toBe('number')
      expect(seconds).toBeGreaterThan(0)
    }
    // It has to price files this suite actually contains, or it is describing a
    // repo that no longer exists. Deliberately a FLOOR on live entries and not a
    // RATIO: a ratio would go red on a large rename, and "the manifest drifted"
    // must never be able to fail a PR — drift costs wall-clock, by construction,
    // and the fix is to regenerate it, not to block on it. This catches only the
    // gross case, which is the manifest having nothing to do with this tree.
    const live = new Set(all)
    expect(entries.filter(([p]) => live.has(p)).length).toBeGreaterThan(100)
  }, PLAN_BUDGET_MS)

  test('the slice happens AFTER the full-set cross-check, so no shard is blind to drift', async () => {
    // Structural, deliberately. In PLAN-ONLY mode the bun cross-check is skipped
    // for speed, so a runtime assertion here would prove nothing about the real
    // path. What must hold is an ORDERING in the script: discovery and the
    // cross-check operate on the full set BEFORE any slicing, so every shard
    // still detects a repo-wide discovery drift affecting files it does not own.
    const src = await Bun.file(RUN_TESTS).text()
    const crossCheck = src.indexOf("# --- 2. Cross-check coverage against bun's OWN discovery")
    const slice = src.indexOf('# --- 2c. Cross-runner shard slice')
    expect(crossCheck).toBeGreaterThan(-1)
    expect(slice).toBeGreaterThan(crossCheck)
  })
})
