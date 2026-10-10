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
 *
 * THE BALANCE IS MEASURED (#1447). The runner partitions every lane at once by
 * the committed measured profile (`scripts/lib/test-cost-profile.json`) through
 * `scripts/lib/shard-partition.ts`. These tests read what the REAL runner
 * dispatches (its PLAN-ONLY census) and the table it prints, and hold both to the
 * measured profile: the four-shard simulated makespan must be at most 80% of the
 * baseline run's largest measured shard sum, and within 10% of the best any
 * assignment could do. The weights are measured case-time cost estimates and the
 * makespan is simulated; neither is an observed CI wall time.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTestCostProfile } from '../lib/test-cost-profile.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const RUN_TESTS = join(ROOT, 'scripts', 'run-tests.sh')

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

function filesOf(out: string): string[] {
  const lines = out.split('\n')
  const start = lines.findIndex((l) => l === 'run-tests: PLAN-ONLY BEGIN')
  const end = lines.findIndex((l) => l === 'run-tests: PLAN-ONLY END')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return lines.slice(start + 1, end).filter((l) => l.length > 0)
}

interface TableRow {
  shard: number
  files: number
  measured: number
  fallback: number
  weightMicros: number
}

/**
 * The partition table, as the runner prints it.
 *
 * Every shard prints the WHOLE table (its own row marked), because the plan is
 * computed identically and independently on each runner — so any one shard's
 * output is enough, and seeing the same table from all of them is itself evidence
 * that they agree. Parsed out of the log rather than recomputed here on purpose: a
 * reimplementation of the planner in the test would pass while the runner's own
 * plan was broken, which is the one failure this is supposed to catch.
 */
function tableOf(out: string, n: number): { rows: TableRow[]; lines: string[]; makespan: number } {
  const byShard = new Map<number, TableRow>()
  const lines: string[] = []
  for (const l of out.split('\n')) {
    const m = l.match(/^run-tests: shard (\d+) est (\d+)\.(\d{6})s over (\d+) files \(measured (\d+), fallback (\d+)\)/)
    if (!m) continue
    lines.push(l.replace('  <= this shard', ''))
    byShard.set(Number(m[1]), {
      shard: Number(m[1]),
      weightMicros: Number(m[2]) * 1_000_000 + Number(m[3]),
      files: Number(m[4]),
      measured: Number(m[5]),
      fallback: Number(m[6]),
    })
  }
  const rows: TableRow[] = []
  for (let i = 1; i <= n; i++) {
    const row = byShard.get(i)
    // A missing row means the runner stopped printing the table — the balance
    // would then be unverifiable, and silently passing on an empty array is how a
    // regression to an unweighted split would sail through.
    expect(row).toBeDefined()
    rows.push(row as TableRow)
  }
  const span = out.match(/^run-tests: shard plan simulated makespan (\d+)\.(\d{6})s \(sum of measured case-time weights \+ fallbacks, not CI wall time\); profile run (\d+): (\d+) records used, (\d+) stale$/m)
  expect(span).not.toBeNull()
  expect(Number(span![3])).toBe(profile.source.runId)
  return { rows, lines, makespan: Number(span![1]) * 1_000_000 + Number(span![2]) }
}

/** The four lanes of one PLAN-ONLY census (printed general, PGLite, device, real-HTTP). */
function lanesOf(out: string, census: string[]): Record<'general' | 'wasm' | 'device' | 'http', string[]> {
  const m = out.match(/executing (\d+) general \+ (\d+) PGLite \+ (\d+) device \+ (\d+) real-HTTP of \d+ discovered/)
  expect(m).not.toBeNull()
  const [g, w, d, h] = [1, 2, 3, 4].map((k) => Number(m![k]))
  expect(g! + w! + d! + h!).toBe(census.length)
  return {
    general: census.slice(0, g),
    wasm: census.slice(g, g! + w!),
    device: census.slice(g! + w!, g! + w! + d!),
    http: census.slice(g! + w! + d!),
  }
}

// The committed measured profile — the same bytes the runner's planner reads.
const profile = parseTestCostProfile(readFileSync(join(ROOT, 'scripts', 'lib', 'test-cost-profile.json'), 'utf8'))
const measuredCost = new Map(profile.files.map((f) => [f.path, f.costMicros]))
/**
 * The FIXED historical baseline: the largest measured per-shard case-time sum of
 * run 38001520250 under the old round-robin plus estimate partition (486.16441 s).
 * Deliberately a constant, not derived from the committed profile's own jobs: a
 * profile regenerated from a run that already used this balanced partition has a
 * largest job near 350 s, and 80% of THAT is below the single ~295 s E2E file, so
 * a derived baseline would make the benchmark unsatisfiable after a routine
 * regeneration. See docs/testing-runner.md, "Provenance and regeneration".
 */
const BASELINE_MAX_MICROS = 486_164_410
const measuredSum = (paths: string[]) => paths.reduce((sum, path) => sum + (measuredCost.get(path) ?? 0), 0)
const HEAVY = './open/__tests__/project-build-e2e.test.ts'

describe('run-tests.sh shard partition', () => {
  const full = shardPlan(null)
  const all = filesOf(full.out)

  test('the unsharded plan is the whole discovered set, with no partition table', () => {
    expect(full.code).toBe(0)
    // Sanity floor: this repo has hundreds of test files. A tiny number here
    // would mean discovery broke and every assertion below would be vacuous.
    expect(all.length).toBeGreaterThan(100)
    expect(new Set(all).size).toBe(all.length)
    // …AND IT IS AS LONG AS THE RUNNER SAYS IT IS. The gap/overlap assertions
    // below compare the shard slices against THIS list, so they cannot see a whole
    // LANE dropped from the plan output — the reference and the slices would lose
    // the same files and agree perfectly. `declared files:` is counted before the
    // lane split, so it is the independent number.
    const declared = full.out.match(/^declared files: (\d+)$/m)
    expect(declared).not.toBeNull()
    expect(all.length).toBe(Number(declared?.[1]))
    // Unsharded runs never read the profile or plan a partition.
    expect(full.out).not.toContain('simulated makespan')
    expect(full.out).not.toContain('test cost profile')
  }, PLAN_BUDGET_MS)

  // Each planner invocation costs seconds (discovery + the lane content greps over
  // ~1800 files), so the shard counts are chosen, not exhaustive: 2 and 4 pin the
  // partition property on the real tree, and the degenerate 1/1 pins the
  // no-sharding case. 1 through 8 shards are covered on synthetic inputs by
  // scripts/__tests__/shard-partition.test.ts against the same planner module.
  const outs4: string[] = []
  const censuses4: string[][] = []
  for (const n of [2, 4]) {
    test(`${n} shards partition the set exactly, and the measured plan balances it`, () => {
      const slices: string[][] = []
      const plans: { code: number; out: string }[] = []
      for (let i = 1; i <= n; i++) {
        const r = shardPlan(`${i}/${n}`)
        expect(r.code).toBe(0)
        plans.push(r)
        slices.push(filesOf(r.out))
      }
      if (n === 4) {
        outs4.push(...plans.map((r) => r.out))
        censuses4.push(...slices)
      }
      const union = slices.flat()

      // NO OVERLAP — a duplicated file wastes a runner; worse, it hides the
      // fact that some other file is missing when only the total is checked.
      expect(new Set(union).size).toBe(union.length)

      // NO GAPS — the union must be exactly the full set. This is THE assertion
      // the sharded coverage guarantee depends on.
      expect(union.slice().sort()).toEqual(all.slice().sort())

      // BENCHMARK FIRST, from the dispatched census alone, before any table is
      // parsed: a runner that ignores the profile, or the old round-robin plus
      // estimate split, prints no honest table and must fail HERE, on what it
      // actually dispatches. The baseline is the fixed historical constant above:
      // the largest measured shard sum of run 38001520250 (486.16441 s), not
      // whatever the currently committed profile's jobs happen to sum to.
      const censusSums = slices.map(measuredSum)
      if (n === 4) {
        expect(Math.max(...censusSums)).toBeLessThanOrEqual(0.8 * BASELINE_MAX_MICROS)
      }

      // EVERY SHARD PRINTS THE SAME TABLE — the runners agree without talking.
      const tables = plans.map((r) => tableOf(r.out, n))
      for (const t of tables) expect(t.lines).toEqual(tables[0]!.lines)
      const { rows, makespan } = tables[0]!

      // ACCOUNTING. The table must describe exactly what each shard dispatched:
      // its file count is the census length, its measured count is the census
      // files that have a measured record, and its weight covers at least their
      // measured cost (exactly, when nothing fell back). A table that reports
      // zero weight for measured files, or drops a file, fails here.
      for (let i = 0; i < n; i++) {
        const census = slices[i]!
        const row = rows[i]!
        expect(row.files).toBe(census.length)
        expect(row.measured).toBe(census.filter((path) => measuredCost.has(path)).length)
        expect(row.measured + row.fallback).toBe(row.files)
        expect(row.weightMicros).toBeGreaterThanOrEqual(censusSums[i]!)
        if (row.fallback === 0) expect(row.weightMicros).toBe(censusSums[i]!)
      }
      expect(rows.reduce((sum, r) => sum + r.files, 0)).toBe(all.length)

      // NEAR-OPTIMAL. No assignment can beat the larger of the mean shard weight
      // and the heaviest single file; the plan must be within 10% of that.
      const total = rows.reduce((sum, r) => sum + r.weightMicros, 0)
      const heaviest = Math.max(...all.map((path) => measuredCost.get(path) ?? 0))
      expect(makespan).toBe(Math.max(...rows.map((r) => r.weightMicros)))
      expect(makespan).toBeLessThanOrEqual(1.1 * Math.max(Math.ceil(total / n), heaviest))
    }, PLAN_BUDGET_MS)
  }

  test('1/1 is exactly the unsharded set — the degenerate case is not special', () => {
    const r = shardPlan('1/1')
    expect(r.code).toBe(0)
    expect(filesOf(r.out).slice().sort()).toEqual(all.slice().sort())
    const { rows } = tableOf(r.out, 1)
    expect(rows[0]!.files).toBe(all.length)
  }, PLAN_BUDGET_MS)

  test('the heaviest special-lane file is weighed with everything else, not dealt by index', () => {
    // The measured imbalance this partition exists to fix: the Open build E2E file
    // reported ~295 s of case time in a serial real-HTTP lane, and a lane split by
    // index gave its shard an ordinary share of everything else too. Reuses the
    // n=4 outputs captured above rather than re-planning.
    expect(outs4).toHaveLength(4)
    // HEAVY is a literal path. If that file is renamed or split, its stale profile
    // record still passes the weight check below but no shard dispatches it, so
    // say what to do instead of failing an opaque length assertion.
    if (!all.includes(HEAVY)) {
      throw new Error(
        `${HEAVY} is no longer discovered (renamed or split?). Regenerate scripts/lib/test-cost-profile.json ` +
          'with scripts/ci/collect-test-cost-profile.ts from a green CI run and update HEAVY here; ' +
          'see docs/testing-runner.md, "Provenance and regeneration".',
      )
    }
    expect(measuredCost.get(HEAVY)).toBeGreaterThan(0.5 * BASELINE_MAX_MICROS)
    const owners = censuses4.map((c, i) => (c.includes(HEAVY) ? i : -1)).filter((i) => i >= 0)
    if (owners.length !== 1) {
      throw new Error(
        `${HEAVY} is dispatched by ${owners.length} of 4 shards, expected exactly 1. If the file was renamed or ` +
          'split, regenerate scripts/lib/test-cost-profile.json (docs/testing-runner.md, "Provenance and regeneration").',
      )
    }
    const owner = owners[0]!
    // Still in its own lane on the shard that runs it.
    expect(lanesOf(outs4[owner]!, censuses4[owner]!).http).toContain(HEAVY)
    // And that shard carries the least OTHER measured weight of the four.
    const others = censuses4.map((c) => measuredSum(c.filter((path) => path !== HEAVY)))
    expect(Math.min(...others)).toBe(others[owner]!)
    // And the heavy file's shard is no long pole: within 10% of the best any
    // assignment could do (an index-dealt lane put ~477 s of measured case time
    // there, against a bound of ~373 s).
    const totals = censuses4.map(measuredSum)
    const total = totals.reduce((sum, t) => sum + t, 0)
    expect(totals[owner]!).toBeLessThanOrEqual(1.1 * Math.max(Math.ceil(total / 4), measuredCost.get(HEAVY)!))
  })

  test('a ONE-FILE scratch root still plans that file — the planner round trip keeps its path', () => {
    // A cross-model review of the earlier cost packer caught a one-file lane that
    // planned ZERO tests and exited 0: `grep -c` over exactly one file printed no
    // path, so nothing matched a discovered file. A green run that executed nothing
    // is the worst outcome this script has, and one file is a REACHABLE input — a
    // `NEUTRON_TEST_ROOT`-scoped run at shard 1/1 gets there. Kept for the planner
    // round trip that replaced it: the path is not in the profile, so it also
    // exercises the fallback weight, and it must come back out of the plan intact.
    //
    // Written against a scratch root rather than the repo so it costs milliseconds
    // instead of a real discovery pass.
    const root = mkdtempSync(join(tmpdir(), 'neutron-onefile-'))
    try {
      const dir = join(root, 'pkg', '__tests__')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'solo.test.ts'),
        "import { test, expect } from 'bun:test'\ntest('solo', () => { expect(1).toBe(1) })\n",
      )
      const r = spawnSync('bash', [RUN_TESTS], {
        encoding: 'utf8',
        cwd: ROOT,
        env: {
          ...(process.env as Record<string, string>),
          NEUTRON_TEST_ROOT: root,
          NEUTRON_TEST_PLAN_ONLY: '1',
          NEUTRON_TEST_SHARD: '1/1',
          // The scratch root has no bun project, so bun's discovery probe reports
          // nothing; this is the documented opt-in that downgrades that to a warning.
          NEUTRON_TEST_ALLOW_EMPTY_BUN_DISC: '1',
        },
      })
      const out = `${r.stdout}${r.stderr}`
      expect(r.status).toBe(0)
      expect(filesOf(out)).toEqual(['./pkg/__tests__/solo.test.ts'])
      const { rows } = tableOf(out, 1)
      expect(rows[0]).toMatchObject({ files: 1, measured: 0, fallback: 1 })
      expect(rows[0]!.weightMicros).toBeGreaterThan(0)
      expect(out).toMatch(/: 0 records used, \d+ stale$/m)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
