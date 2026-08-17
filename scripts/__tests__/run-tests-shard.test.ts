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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/**
 * The per-shard estimated general-lane cost, as the runner reports it.
 *
 * Every shard prints the WHOLE table (its own line marked), because the packing is
 * computed identically and independently on each runner — so any one shard's
 * output is enough, and seeing the same table from all of them is itself evidence
 * that they agree. Parsed out of the log rather than recomputed here on purpose: a
 * reimplementation of the cost model in the test would pass while the script's own
 * model was broken, which is the one failure this is supposed to catch.
 */
function weightsOf(out: string, n: number): number[] {
  const byShard = new Map<number, number>()
  for (const l of out.split('\n')) {
    const m = l.match(/run-tests: shard (\d+) general est (\d+)ms over (\d+) files/)
    if (m) byShard.set(Number(m[1]), Number(m[2]))
  }
  const weights: number[] = []
  for (let i = 1; i <= n; i++) {
    const w = byShard.get(i)
    // A missing line means the runner stopped printing the table — the balance
    // would then be unverifiable, and silently passing on an empty array is how a
    // regression to round-robin would sail through.
    expect(w).toBeDefined()
    weights.push(w as number)
  }
  return weights
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
      const plans: { code: number; out: string }[] = []
      for (let i = 1; i <= n; i++) {
        const r = shardPlan(`${i}/${n}`)
        expect(r.code).toBe(0)
        plans.push(r)
        slices.push(filesOf(r.out))
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

      // BALANCED BY COST, NOT BY COUNT. This assertion used to require the file
      // counts to be within one of each other, which is the right check only if
      // every file costs the same — and they do not: 334 test call sites replay
      // the whole migration tree at ~137ms each, so a file can cost multiple
      // seconds or almost nothing. Balancing the count while ignoring the cost is
      // how one runner ends up the long pole, and a PR waits on the long pole.
      //
      // So the runner now bin-packs the general lane by estimated cost and prints
      // what each shard drew; this asserts on THAT. Counts are deliberately NOT
      // asserted — an uneven count is the expected shape of a cost-balanced split
      // and pinning it would forbid the fix.
      const weights = weightsOf(
        slices.map((_, i) => plans[i]!.out).join('\n'),
        n,
      )
      expect(weights).toHaveLength(n)
      const spread = Math.max(...weights) - Math.min(...weights)
      // 2% of the heaviest shard. Generous on purpose: the exact figure depends on
      // the tree's file mix, and the property worth pinning is "no shard is the
      // long pole", not a specific packing. On this tree the real spread is ~0.3%,
      // so a regression to round-robin (measured 12.9% at eight legs) fails loudly
      // while an ordinary change in the file mix does not.
      expect(spread).toBeLessThanOrEqual(Math.max(...weights) * 0.02)
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
