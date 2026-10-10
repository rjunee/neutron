/**
 * scripts/lib/test-cost-profile.ts — the measured test-cost profile contract.
 *
 * The profile (`scripts/lib/test-cost-profile.json`) records, for every test
 * file a real CI run executed, the exact sum of the case durations Bun printed
 * for it inside one runner execution section. It is the measured planning
 * weight the sharded runner uses (docs/spec-items/host-test-suite-efficiency.md,
 * "Measured CI partition (#1447)"). It is a MEASURED COST ESTIMATE: it excludes
 * process start, imports, setup outside a case and any overlap, so it is
 * neither a simulated makespan nor an observed CI wall time.
 *
 * This module is a runner input: it has no imports beyond the language, no side
 * effects on import, and it never reads the network, a credential or a log.
 *
 * Validation is all-or-nothing. `parseTestCostProfile` either returns a fully
 * checked profile or throws `TestCostProfileError` with a specific reason; it
 * never yields a partial profile. `serializeTestCostProfile` produces the
 * canonical bytes, so `serialize(parse(text)) === text` for a canonical file.
 */

export const SCHEMA = 'neutron-test-cost-profile/v1' as const
export const UNIT = 'microseconds' as const
export const AGGREGATION = 'sum-of-bun-reported-case-durations-per-file-per-execution-section' as const
export const WORKFLOW = 'ci' as const
export const COLLECTOR = 'scripts/ci/collect-test-cost-profile.ts' as const
export const LANES = ['general', 'pglite', 'device', 'http'] as const
export type Lane = (typeof LANES)[number]

/** Upper bound on a profile path's length; real paths are well under 200. */
export const MAX_PATH_LENGTH = 512
/** Upper bound on the shard count a profile may describe. */
export const MAX_SHARD_COUNT = 64

export interface TestCostProfileJob {
  shard: number
  jobId: number
  logSha256: string
  measuredFiles: number
  unmeasuredFiles: number
  costMicros: number
}

export interface TestCostProfileSource {
  workflow: typeof WORKFLOW
  runId: number
  headSha: string
  shardCount: number
  collector: typeof COLLECTOR
  jobs: TestCostProfileJob[]
}

export interface TestCostProfileFile {
  path: string
  lane: Lane
  shard: number
  cases: number
  timedCases: number
  costMicros: number
}

export interface TestCostProfileUnmeasured {
  path: string
  lane: Lane
  shard: number
  cases: number
}

export interface TestCostProfile {
  schema: typeof SCHEMA
  unit: typeof UNIT
  aggregation: typeof AGGREGATION
  source: TestCostProfileSource
  files: TestCostProfileFile[]
  unmeasured: TestCostProfileUnmeasured[]
}

export class TestCostProfileError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'TestCostProfileError'
  }
}

// Fixed key orders: validation refuses any other key set, and serialization
// writes exactly these keys in exactly this order.
const PROFILE_KEYS = ['schema', 'unit', 'aggregation', 'source', 'files', 'unmeasured'] as const
const SOURCE_KEYS = ['workflow', 'runId', 'headSha', 'shardCount', 'collector', 'jobs'] as const
const JOB_KEYS = ['shard', 'jobId', 'logSha256', 'measuredFiles', 'unmeasuredFiles', 'costMicros'] as const
const FILE_KEYS = ['path', 'lane', 'shard', 'cases', 'timedCases', 'costMicros'] as const
const UNMEASURED_KEYS = ['path', 'lane', 'shard', 'cases'] as const

/** The suffixes scripts/lib/discover-test-files.sh accepts, and nothing else. */
const TEST_SUFFIX = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/
/**
 * True when every character of `path` is printable ASCII other than space,
 * double quote, single quote or backslash. In that alphabet JavaScript's UTF-16
 * string order equals `LC_ALL=C sort` byte order, so "strictly ascending" means
 * the same thing to the runner and here.
 *
 * Deliberately a char-code loop, not a regex literal: an alphabet regex accepts
 * any identifier-shaped string, so the identity-env-readers registry guard
 * (tests/integration/identity-env-readers-registry.test.ts) would class this
 * file as naming the identity variables it never reads.
 */
function inPathAlphabet(path: string): boolean {
  if (path.length === 0) return false
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i)
    if (c < 0x21 || c > 0x7e) return false
    if (c === 0x22 || c === 0x27 || c === 0x5c) return false
  }
  return true
}

/**
 * True when `path` has the shape of a file discovery can return: `./`-relative,
 * confined (no empty, `.`, `..` or dot-leading segment, no node_modules), in the
 * restricted alphabet, bounded, and carrying a discovered test suffix.
 */
export function isDiscoveredTestPath(path: unknown): path is string {
  return discoveredPathProblem(path) === null
}

function discoveredPathProblem(path: unknown): string | null {
  if (typeof path !== 'string') return 'is not a string'
  if (path.length === 0) return 'is empty'
  if (path.length > MAX_PATH_LENGTH) return `exceeds ${MAX_PATH_LENGTH} characters`
  if (!inPathAlphabet(path)) return 'contains a character outside printable ASCII without space, quote or backslash'
  if (!path.startsWith('./')) return "does not start with './'"
  const segments = path.slice(2).split('/')
  for (const segment of segments) {
    if (segment === '') return "contains an empty segment ('//' or a trailing '/')"
    if (segment === '.' || segment === '..') return `contains a '${segment}' segment`
    if (segment.startsWith('.')) return 'contains a dot-leading segment'
    if (segment === 'node_modules') return 'contains a node_modules segment'
  }
  if (!TEST_SUFFIX.test(path)) return 'does not end with a discovered test suffix'
  return null
}

function fail(reason: string): never {
  throw new TestCostProfileError(reason)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function closedObject(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${where} is not an object`)
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${where} has unknown key '${key}'`)
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${where} is missing '${key}'`)
  }
  return value
}

function count(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${where} must be a non-negative safe integer`)
  }
  return value
}

function literal<T extends string>(value: unknown, expected: T, where: string): T {
  if (value !== expected) fail(`${where} must be '${expected}'`)
  return expected
}

function hex(value: unknown, length: number, where: string): string {
  if (typeof value !== 'string' || value.length !== length || !/^[0-9a-f]+$/.test(value)) {
    fail(`${where} must be ${length} lowercase hex characters`)
  }
  return value
}

function shardOf(value: unknown, shardCount: number, where: string): number {
  const shard = count(value, where)
  if (shard < 1 || shard > shardCount) fail(`${where} ${shard} is outside 1..${shardCount}`)
  return shard
}

function laneOf(value: unknown, where: string): Lane {
  if (typeof value !== 'string' || !(LANES as readonly string[]).includes(value)) {
    fail(`${where} must be one of ${LANES.join(', ')}`)
  }
  return value as Lane
}

function pathOf(value: unknown, where: string): string {
  const problem = discoveredPathProblem(value)
  if (problem !== null) fail(`${where} ${problem}`)
  return value as string
}

/** Validate an already-decoded value against the closed v1 schema. */
export function validateTestCostProfile(value: unknown): TestCostProfile {
  const top = closedObject(value, PROFILE_KEYS, 'profile')
  const schema = literal(top.schema, SCHEMA, 'schema')
  const unit = literal(top.unit, UNIT, 'unit')
  const aggregation = literal(top.aggregation, AGGREGATION, 'aggregation')

  const src = closedObject(top.source, SOURCE_KEYS, 'source')
  const workflow = literal(src.workflow, WORKFLOW, 'source.workflow')
  const runId = count(src.runId, 'source.runId')
  if (runId < 1) fail('source.runId must be positive')
  const headSha = hex(src.headSha, 40, 'source.headSha')
  const shardCount = count(src.shardCount, 'source.shardCount')
  if (shardCount < 1 || shardCount > MAX_SHARD_COUNT) fail(`source.shardCount must be within 1..${MAX_SHARD_COUNT}`)
  const collector = literal(src.collector, COLLECTOR, 'source.collector')
  if (!Array.isArray(src.jobs)) fail('source.jobs is not an array')
  if (src.jobs.length !== shardCount) fail(`source.jobs has ${src.jobs.length} entries for shardCount ${shardCount}`)
  const jobIds = new Set<number>()
  const jobs: TestCostProfileJob[] = src.jobs.map((raw, i) => {
    const where = `source.jobs[${i}]`
    const job = closedObject(raw, JOB_KEYS, where)
    const shard = count(job.shard, `${where}.shard`)
    if (shard !== i + 1) fail(`${where}.shard must be ${i + 1} (shards 1..n ascending)`)
    const jobId = count(job.jobId, `${where}.jobId`)
    if (jobId < 1) fail(`${where}.jobId must be positive`)
    if (jobIds.has(jobId)) fail(`${where}.jobId ${jobId} is duplicated`)
    jobIds.add(jobId)
    return {
      shard,
      jobId,
      logSha256: hex(job.logSha256, 64, `${where}.logSha256`),
      measuredFiles: count(job.measuredFiles, `${where}.measuredFiles`),
      unmeasuredFiles: count(job.unmeasuredFiles, `${where}.unmeasuredFiles`),
      costMicros: count(job.costMicros, `${where}.costMicros`),
    }
  })

  if (!Array.isArray(top.files)) fail('files is not an array')
  if (!Array.isArray(top.unmeasured)) fail('unmeasured is not an array')

  const files: TestCostProfileFile[] = top.files.map((raw, i) => {
    const where = `files[${i}]`
    const rec = closedObject(raw, FILE_KEYS, where)
    const cases = count(rec.cases, `${where}.cases`)
    const timedCases = count(rec.timedCases, `${where}.timedCases`)
    if (timedCases < 1) fail(`${where}.timedCases must be at least 1 (an untimed file belongs in unmeasured)`)
    if (timedCases > cases) fail(`${where}.timedCases exceeds cases`)
    return {
      path: pathOf(rec.path, `${where}.path`),
      lane: laneOf(rec.lane, `${where}.lane`),
      shard: shardOf(rec.shard, shardCount, `${where}.shard`),
      cases,
      timedCases,
      costMicros: count(rec.costMicros, `${where}.costMicros`),
    }
  })
  const unmeasured: TestCostProfileUnmeasured[] = top.unmeasured.map((raw, i) => {
    const where = `unmeasured[${i}]`
    const rec = closedObject(raw, UNMEASURED_KEYS, where)
    return {
      path: pathOf(rec.path, `${where}.path`),
      lane: laneOf(rec.lane, `${where}.lane`),
      shard: shardOf(rec.shard, shardCount, `${where}.shard`),
      cases: count(rec.cases, `${where}.cases`),
    }
  })

  // Strictly ascending within each set, and unique across both.
  for (const [name, list] of [['files', files], ['unmeasured', unmeasured]] as const) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!.path
      const cur = list[i]!.path
      if (prev === cur) fail(`${name}[${i}].path duplicates ${name}[${i - 1}].path`)
      if (prev > cur) fail(`${name}[${i}].path is not in ascending byte order`)
    }
  }
  const measuredPaths = new Set(files.map((f) => f.path))
  unmeasured.forEach((u, i) => {
    if (measuredPaths.has(u.path)) fail(`unmeasured[${i}].path is also in files`)
  })

  // Per-job consistency: the provenance totals must equal the records.
  const perShard = jobs.map(() => ({ measured: 0, unmeasured: 0, cost: 0 }))
  for (const f of files) {
    const acc = perShard[f.shard - 1]!
    acc.measured += 1
    acc.cost += f.costMicros
    if (!Number.isSafeInteger(acc.cost)) fail(`shard ${f.shard} cost sum exceeds the safe integer range`)
  }
  for (const u of unmeasured) perShard[u.shard - 1]!.unmeasured += 1
  jobs.forEach((job, i) => {
    const acc = perShard[i]!
    if (acc.measured !== job.measuredFiles) fail(`source.jobs[${i}].measuredFiles ${job.measuredFiles} != ${acc.measured} records`)
    if (acc.unmeasured !== job.unmeasuredFiles) fail(`source.jobs[${i}].unmeasuredFiles ${job.unmeasuredFiles} != ${acc.unmeasured} records`)
    if (acc.cost !== job.costMicros) fail(`source.jobs[${i}].costMicros ${job.costMicros} != record sum ${acc.cost}`)
  })

  return {
    schema,
    unit,
    aggregation,
    source: { workflow, runId, headSha, shardCount, collector, jobs },
    files,
    unmeasured,
  }
}

/** Parse and fully validate profile text. Throws TestCostProfileError. */
export function parseTestCostProfile(text: string): TestCostProfile {
  if (typeof text !== 'string') fail('profile text is not a string')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    fail(`profile is not valid JSON: ${(err as Error).message}`)
  }
  return validateTestCostProfile(value)
}

function ordered<K extends string>(value: Record<K, unknown>, keys: readonly K[]): Record<K, unknown> {
  const out = {} as Record<K, unknown>
  for (const key of keys) out[key] = value[key]
  return out
}

/**
 * Canonical text: validated first (so it can never emit an invalid profile),
 * then 2-space JSON with the fixed key order and a trailing newline.
 */
export function serializeTestCostProfile(profile: TestCostProfile): string {
  const p = validateTestCostProfile(profile)
  const canonical = {
    ...ordered(p, PROFILE_KEYS),
    source: {
      ...ordered(p.source, SOURCE_KEYS),
      jobs: p.source.jobs.map((j) => ordered(j, JOB_KEYS)),
    },
    files: p.files.map((f) => ordered(f, FILE_KEYS)),
    unmeasured: p.unmeasured.map((u) => ordered(u, UNMEASURED_KEYS)),
  }
  return `${JSON.stringify(canonical, null, 2)}\n`
}
