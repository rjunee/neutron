/**
 * scripts/lib/shard-partition.ts — the one cross-runner shard planner.
 *
 * `scripts/run-tests.sh` calls this for every `NEUTRON_TEST_SHARD=<i>/<n>` run,
 * and the tests import the same functions, so there is exactly one partition
 * implementation (docs/spec-items/host-test-suite-efficiency.md, "Measured CI
 * partition (#1447)").
 *
 * The rule. Every discovered file of every lane enters ONE deterministic
 * computation. A file's weight is its measured cost from the committed profile
 * (`scripts/lib/test-cost-profile.json`). A file with no measured record (new,
 * renamed, or recorded as unmeasured) takes a conservative fallback: the larger
 * of the content estimate (`BASE_COST_MS + MIG_COST_MS ×` its migration-replay
 * calls, in microseconds) and the nearest-rank 90th percentile of the measured
 * costs recorded for its current lane (or of all measured costs when that lane
 * has none). Files are ordered by weight descending, then path, then input
 * index; each goes to the shard with the lowest (weight sum, file count, index).
 *
 * Three quantities stay distinct. The weights are MEASURED COST ESTIMATES (sums
 * of Bun-reported case durations; they exclude process start, imports and setup
 * outside a case). The largest per-shard weight sum is a SIMULATED MAKESPAN. Only
 * a real CI job's elapsed time is OBSERVED CI WALL TIME.
 *
 * Runner input rules: imports only `./test-cost-profile.ts` and `node:` builtins,
 * no side effects on import, never reads the network, a credential or a log.
 * Every number is an integer number of microseconds. The CLI computes the whole
 * plan before printing anything, so a failure never leaves a partial plan on
 * stdout.
 *
 * CLI (run with cwd = the checkout under test):
 *   bun scripts/lib/shard-partition.ts --profile <file> --validate
 *   bun scripts/lib/shard-partition.ts --profile <file> --shard <i>/<n> < manifest
 * The manifest is one `<lane>\t<path>` line per discovered file, in discovery
 * order. With --shard, stdout carries tab-separated records:
 *   shard\t<k>\t<files>\t<measured>\t<fallback>\t<weightMicros>   (every k)
 *   planned\t<inputCount>\t<assignedSum>
 *   profile\t<runId>\t<used>\t<stale>
 *   assign\t<lane>\t<path>                                         (shard i, input order)
 */
import { readFileSync } from 'node:fs'
import {
  LANES,
  MAX_SHARD_COUNT,
  TestCostProfileError,
  parseTestCostProfile,
  type Lane,
  type TestCostProfile,
} from './test-cost-profile.ts'

/** Content-estimate base cost per file (stand-in for import and setup), ms. */
export const BASE_COST_MS = 150
/** Measured cost of one whole-tree migration replay, ms. */
export const MIG_COST_MS = 137
/** A migration-replay call site; each occurrence adds MIG_COST_MS. */
export const MIGRATION_CALL = /applyMigrations(ToProjectDb)?\(/g

export class ShardPlanError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ShardPlanError'
  }
}

function fail(reason: string): never {
  throw new ShardPlanError(reason)
}

function safeAdd(a: number, b: number, what: string): number {
  const sum = a + b
  if (!Number.isSafeInteger(sum)) fail(`${what} exceeds the safe integer range`)
  return sum
}

/** The content estimate for a file's text, in integer microseconds. */
export function estimateMicros(text: string): number {
  const calls = text.match(MIGRATION_CALL)?.length ?? 0
  const micros = (BASE_COST_MS + MIG_COST_MS * calls) * 1000
  if (!Number.isSafeInteger(micros)) fail('content estimate exceeds the safe integer range')
  return micros
}

function nearestRank90(costs: number[]): number {
  if (costs.length === 0) return 0
  const sorted = costs.slice().sort((a, b) => a - b)
  // Nearest rank: the value at 1-based rank ceil(0.9 × N), computed exactly.
  const rank = Math.floor((9 * sorted.length + 9) / 10)
  return sorted[rank - 1]!
}

/**
 * Nearest-rank 90th percentile of the measured costs recorded for `lane`, or of
 * every measured cost when that lane has no measured record. 0 for a profile
 * with no measured record at all.
 */
export function lanePercentile90(profile: TestCostProfile, lane: Lane): number {
  const inLane = profile.files.filter((f) => f.lane === lane).map((f) => f.costMicros)
  return nearestRank90(inLane.length > 0 ? inLane : profile.files.map((f) => f.costMicros))
}

export interface PlanEntry {
  lane: string
  path: string
}

export interface PlanTableRow {
  shard: number
  files: number
  measured: number
  fallback: number
  weightMicros: number
}

export interface ShardPlan {
  /** 1-based shard of each entry, parallel to the input entries. */
  shardOf: number[]
  /** One row per shard, 1..n. */
  table: PlanTableRow[]
  /** Number of input entries. */
  planned: number
  /** Entries whose exact path has a measured profile record. */
  used: number
  /** Profile records (measured or unmeasured) whose path was not an input. */
  stale: number
  /** The weight given to each entry, parallel to the input entries. */
  weights: number[]
}

export interface PlanInput {
  entries: PlanEntry[]
  profile: TestCostProfile
  shards: number
  /** Reads a file's text; called only for entries that take the fallback. */
  read: (path: string) => string
}

function isLane(value: unknown): value is Lane {
  return typeof value === 'string' && (LANES as readonly string[]).includes(value)
}

/** Plan the partition. Throws ShardPlanError on any invalid input. */
export function planShards(input: PlanInput): ShardPlan {
  const { entries, profile, shards, read } = input
  if (!Array.isArray(entries) || entries.length === 0) fail('no files to plan')
  if (!Number.isSafeInteger(shards) || shards < 1 || shards > MAX_SHARD_COUNT) {
    fail(`shard count ${String(shards)} is outside 1..${MAX_SHARD_COUNT}`)
  }
  const seen = new Set<string>()
  entries.forEach((entry, i) => {
    if (!isLane(entry.lane)) fail(`entry ${i + 1} has unknown lane '${String(entry.lane)}'`)
    if (typeof entry.path !== 'string' || entry.path.length === 0) fail(`entry ${i + 1} has an empty path`)
    if (/[\t\r\n]/.test(entry.path)) fail(`entry ${i + 1} path contains a tab or line break`)
    if (seen.has(entry.path)) fail(`entry ${i + 1} duplicates path ${entry.path}`)
    seen.add(entry.path)
  })

  const measuredCost = new Map<string, number>()
  for (const f of profile.files) measuredCost.set(f.path, f.costMicros)
  const p90 = new Map<Lane, number>()
  for (const lane of LANES) p90.set(lane, lanePercentile90(profile, lane))

  let stale = 0
  for (const rec of [...profile.files, ...profile.unmeasured]) if (!seen.has(rec.path)) stale += 1

  const weights: number[] = []
  const measured: boolean[] = []
  let used = 0
  entries.forEach((entry) => {
    const cost = measuredCost.get(entry.path)
    if (cost !== undefined) {
      weights.push(cost)
      measured.push(true)
      used += 1
      return
    }
    let text: string
    try {
      text = read(entry.path)
    } catch (err) {
      fail(`cannot read fallback file ${entry.path}: ${(err as Error).message}`)
    }
    weights.push(Math.max(estimateMicros(text), p90.get(entry.lane as Lane)!))
    measured.push(false)
  })

  // Total order: weight desc, then path asc (plain JS comparison), then index.
  const order = entries.map((_, i) => i)
  order.sort((a, b) => {
    const wa = weights[a]!
    const wb = weights[b]!
    if (wa !== wb) return wb - wa
    const pa = entries[a]!.path
    const pb = entries[b]!.path
    if (pa !== pb) return pa < pb ? -1 : 1
    return a - b
  })

  const table: PlanTableRow[] = []
  for (let k = 1; k <= shards; k++) table.push({ shard: k, files: 0, measured: 0, fallback: 0, weightMicros: 0 })
  const shardOf: number[] = new Array(entries.length).fill(0)
  for (const i of order) {
    // Lowest (weight sum, file count, index). The count tie-break fills an
    // empty shard before doubling up while entries >= shards, even at weight 0.
    let pick = table[0]!
    for (let k = 1; k < shards; k++) {
      const row = table[k]!
      if (row.weightMicros < pick.weightMicros || (row.weightMicros === pick.weightMicros && row.files < pick.files)) {
        pick = row
      }
    }
    pick.weightMicros = safeAdd(pick.weightMicros, weights[i]!, `shard ${pick.shard} weight`)
    pick.files += 1
    if (measured[i]) pick.measured += 1
    else pick.fallback += 1
    shardOf[i] = pick.shard
  }

  return { shardOf, table, planned: entries.length, used, stale, weights }
}

/** Exact `<seconds>.<6 digits>` text for integer microseconds. */
export function formatSeconds(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros < 0) fail(`cannot format ${String(micros)} microseconds`)
  const whole = Math.floor(micros / 1_000_000)
  const frac = micros - whole * 1_000_000
  return `${whole}.${String(frac).padStart(6, '0')}`
}

/** Parse the runner's `<lane>\t<path>` manifest. */
export function parseManifest(text: string): PlanEntry[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((line, i) => {
    const tab = line.indexOf('\t')
    if (tab < 0) fail(`manifest line ${i + 1} has no '<lane>\\t<path>' shape`)
    return { lane: line.slice(0, tab), path: line.slice(tab + 1) }
  })
}

function parseShardSpec(spec: string | undefined): { index: number; count: number } {
  const m = /^([0-9]+)\/([0-9]+)$/.exec(spec ?? '')
  if (!m) fail(`--shard '${spec ?? ''}' must be <i>/<n>`)
  const index = Number(m[1])
  const count = Number(m[2])
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || count > MAX_SHARD_COUNT
    || index < 1 || index > count) {
    fail(`--shard '${spec}' needs 1 <= i <= n <= ${MAX_SHARD_COUNT}`)
  }
  return { index, count }
}

/** The CLI body. Returns { code, stdout, stderr } without touching the process. */
export function runCli(argv: string[], readStdin: () => string, readFile: (path: string) => string):
  { code: number; stdout: string; stderr: string } {
  let profilePath: string | undefined
  let shardSpec: string | undefined
  let validate = false
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === '--profile' && i + 1 < argv.length) profilePath = argv[++i]
      else if (arg === '--shard' && i + 1 < argv.length) shardSpec = argv[++i]
      else if (arg === '--validate') validate = true
      else fail(`unknown or incomplete argument '${String(arg)}'`)
    }
    if (profilePath === undefined) fail('--profile <file> is required')
    if (validate === (shardSpec !== undefined)) fail('exactly one of --validate or --shard <i>/<n> is required')
  } catch (err) {
    return { code: 2, stdout: '', stderr: `run-tests: FATAL — shard planner: ${(err as Error).message}\n` }
  }

  let profile: TestCostProfile
  try {
    let text: string
    try {
      text = readFile(profilePath!)
    } catch (err) {
      throw new TestCostProfileError(`cannot read ${profilePath}: ${(err as Error).message}`)
    }
    profile = parseTestCostProfile(text)
  } catch (err) {
    return { code: 1, stdout: '', stderr: `run-tests: FATAL — test cost profile invalid: ${(err as Error).message}\n` }
  }
  if (validate) return { code: 0, stdout: '', stderr: '' }

  try {
    const { index, count } = parseShardSpec(shardSpec)
    const entries = parseManifest(readStdin())
    const plan = planShards({ entries, profile, shards: count, read: readFile })
    let assigned = 0
    const out: string[] = []
    for (const row of plan.table) {
      assigned += row.files
      out.push(['shard', row.shard, row.files, row.measured, row.fallback, row.weightMicros].join('\t'))
    }
    out.push(['planned', plan.planned, assigned].join('\t'))
    out.push(['profile', profile.source.runId, plan.used, plan.stale].join('\t'))
    entries.forEach((entry, i) => {
      if (plan.shardOf[i] === index) out.push(['assign', entry.lane, entry.path].join('\t'))
    })
    return { code: 0, stdout: `${out.join('\n')}\n`, stderr: '' }
  } catch (err) {
    return { code: 1, stdout: '', stderr: `run-tests: FATAL — shard planner: ${(err as Error).message}\n` }
  }
}

if (import.meta.main) {
  const result = runCli(
    process.argv.slice(2),
    () => readFileSync(0, 'utf8'),
    (path) => readFileSync(path, 'utf8'),
  )
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exitCode = result.code
}
