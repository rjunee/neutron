/**
 * scripts/ci/collect-test-cost-profile.ts — derive the measured test-cost
 * profile from the retained job logs of one sharded CI run.
 *
 *   bun scripts/ci/collect-test-cost-profile.ts --run-id <id> --head-sha <sha> \
 *     --shard-count <n> --job <shard>=<jobId>=<logfile> ... \
 *     (--out <profile> | --check <profile>)
 *
 * The logs are retrieved OUTSIDE this script (and outside the repository) with
 * the repository's authenticated GitHub helper, e.g.
 * `gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<id>/logs`.
 * This script never touches the network, and it never copies a raw line, a case
 * name or an absolute path into its output or its refusal messages.
 *
 * What counts. Only the runner's execution sections (scripts/run-tests.sh) are
 * read: a section starts at a general-chunk, PGLite, device-harness or real-HTTP
 * batch marker and ends at the next marker or the coverage audit. The Bun
 * discovery probe and any step before the runner print the same file headers;
 * counting them would duplicate files, so lines outside a section are ignored.
 *
 * Line shapes, as observed in the retained logs of run 38001520250:
 *   - every line carries GitHub's `<ISO-8601>Z ` timestamp prefix, and a line
 *     that starts a new stored log block also carries a UTF-8 BOM before it;
 *   - Bun (in GitHub Actions) prints a file header as `##[group]<path>:` and
 *     closes the file with `##[endgroup]`;
 *   - a case line is `(pass|fail|skip|todo) <name>`, with ` [<d>.<dd>ms]`
 *     appended when Bun timed it; fast cases carry no duration at all;
 *   - after the last file Bun prints a summary that can repeat skipped, failed
 *     or todo case lines under `<N> tests skipped:` (etc.), then the counts and
 *     `Ran <T> tests across <M> files. [<s>s]`;
 *   - the process-isolation preload replays each Bun invocation inside a PID
 *     namespace: the outer process prints Bun's banner and the FIRST file
 *     header, then the replayed process prints the banner and that same header
 *     again. The outer prelude carries no case line and is discarded.
 *
 * Aggregation. For each file, the exact sum of its timed case durations, in
 * integer microseconds, converted from the decimal text without floating point.
 * A file with no timed case is recorded as unmeasured, never as zero cost.
 */

import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  AGGREGATION,
  COLLECTOR,
  type Lane,
  MAX_SHARD_COUNT,
  SCHEMA,
  type TestCostProfile,
  type TestCostProfileFile,
  type TestCostProfileUnmeasured,
  UNIT,
  WORKFLOW,
  isDiscoveredTestPath,
  parseTestCostProfile,
  serializeTestCostProfile,
  validateTestCostProfile,
} from '../lib/test-cost-profile.ts'

export class CollectError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'CollectError'
  }
}

export interface CollectJobInput {
  shard: number
  jobId: number
  log: Uint8Array
}

export interface CollectInput {
  runId: number
  headSha: string
  shardCount: number
  jobs: CollectJobInput[]
}

/** The exact section markers scripts/run-tests.sh prints, and their lanes. */
const SECTION_MARKERS: ReadonlyArray<readonly [RegExp, Lane]> = [
  [/^==== chunk \d+\/\d+: /, 'general'],
  [/^==== PGLite quarantine lane: /, 'pglite'],
  [/^==== device-harness isolation lane: /, 'device'],
  [/^==== real-HTTP isolation lane batch \d+\/\d+: /, 'http'],
]
const AUDIT_MARKER = '---- run-tests coverage audit ----'
const SHARD_LINE = /^run-tests: SHARD (\d+)\/(\d+) — executing /
const DECLARED_LINE = /^declared files: (\d+)(?:\s|$)/
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /
// CSI sequences, then any other two-byte escape.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g
const BANNER = /^bun test v\S+ \([0-9a-f]+\)$/
const HEADER = /^##\[group\](.*):$/
const ENDGROUP = '##[endgroup]'
const CASE = /^\((pass|fail|skip|todo)\) /
const DURATION = / \[(\d+)(?:\.(\d+))?([^\]\d.\s][^\]\s]*)\]$/
const SUMMARY_INTRO = /^\d+ tests? (skipped|failed|todo):$/
const RAN = /^Ran \d+ tests? across (\d+) files?\. \[[^\]]+\]$/
/** Bun prints case durations in milliseconds; no other unit was observed. */
const ACCEPTED_UNITS = new Set(['ms'])
const MAX_FRACTION_DIGITS = 3

interface FileAcc {
  path: string
  lane: Lane
  shard: number
  cases: number
  timedCases: number
  costMicros: number
}

/** Normalize one raw log line: CR, BOMs, GitHub timestamp, ANSI escapes. */
export function normalizeLogLine(raw: string): string {
  let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  while (line.startsWith('﻿')) line = line.slice(1)
  line = line.replace(TIMESTAMP_PREFIX, '')
  return line.replace(ANSI, '')
}

/** Decimal millisecond text -> integer microseconds, without floating point. */
export function durationMicros(intPart: string, fraction: string | undefined, unit: string, where: string): number {
  if (!ACCEPTED_UNITS.has(unit)) throw new CollectError(`${where}: unknown case duration unit`)
  const frac = fraction ?? ''
  if (frac.length > MAX_FRACTION_DIGITS) {
    throw new CollectError(`${where}: case duration has more than ${MAX_FRACTION_DIGITS} fractional millisecond digits`)
  }
  const micros = Number(intPart) * 1000 + Number(frac.padEnd(MAX_FRACTION_DIGITS, '0'))
  if (!Number.isSafeInteger(micros)) throw new CollectError(`${where}: case duration is out of range`)
  return micros
}

interface Section {
  lane: Lane
  startLine: number
  /** Headers of the current (non-discarded) Bun process, in order. */
  headers: string[]
  /** A discarded prelude header the replayed process must start with. */
  replayOf: string | null
  current: FileAcc | null
  groupOpen: boolean
  cases: number
  inSummary: boolean
  ranFiles: number | null
}

function parseJob(job: CollectJobInput, shardCount: number, seen: Map<string, FileAcc>): { declared: number } {
  const tag = `shard ${job.shard}`
  const text = new TextDecoder('utf-8').decode(job.log)
  const lines = text.split('\n')
  let shardLine: { i: number; n: number } | null = null
  let declared: number | null = null
  let afterAudit = false
  let section: Section | null = null

  const closeSection = (lineNo: number): void => {
    if (section === null) return
    const where = `${tag} line ${lineNo}`
    if (section.ranFiles === null) {
      throw new CollectError(`${where}: the ${section.lane} section opened at line ${section.startLine} ended without Bun's 'Ran ... across M files' line`)
    }
    if (section.headers.length !== section.ranFiles) {
      throw new CollectError(
        `${where}: the ${section.lane} section opened at line ${section.startLine} has ${section.headers.length} file headers but Bun reported ${section.ranFiles} files`,
      )
    }
    section = null
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1
    const where = `${tag} line ${lineNo}`
    const line = normalizeLogLine(lines[idx]!)

    const lane = SECTION_MARKERS.find(([re]) => re.test(line))?.[1]
    if (lane !== undefined) {
      if (afterAudit) throw new CollectError(`${where}: a runner section starts after the coverage audit`)
      closeSection(lineNo)
      section = {
        lane, startLine: lineNo, headers: [], replayOf: null, current: null,
        groupOpen: false, cases: 0, inSummary: false, ranFiles: null,
      }
      continue
    }
    if (line === AUDIT_MARKER) {
      if (afterAudit) throw new CollectError(`${where}: a second coverage audit`)
      closeSection(lineNo)
      afterAudit = true
      continue
    }
    if (section === null) {
      const shard = SHARD_LINE.exec(line)
      if (shard !== null) {
        if (shardLine !== null) throw new CollectError(`${where}: a second 'run-tests: SHARD' line`)
        shardLine = { i: Number(shard[1]), n: Number(shard[2]) }
        continue
      }
      if (afterAudit) {
        const decl = DECLARED_LINE.exec(line)
        if (decl !== null) {
          if (declared !== null) throw new CollectError(`${where}: a second 'declared files' line`)
          declared = Number(decl[1])
        }
      }
      continue
    }

    const sec: Section = section
    if (BANNER.test(line)) {
      // A new Bun process inside one section. Only the isolation preload's
      // replay is legitimate: the superseded process printed at most its
      // first header and no case line. Anything else would double-count.
      if (sec.cases > 0 || sec.headers.length > 1 || sec.inSummary || sec.ranFiles !== null) {
        throw new CollectError(`${where}: a second Bun process starts after the first produced case output`)
      }
      if (sec.headers.length === 1) {
        const prelude = sec.headers[0]!
        seen.delete(prelude)
        sec.replayOf = prelude
      }
      sec.headers = []
      sec.current = null
      sec.groupOpen = false
      continue
    }
    if (sec.ranFiles !== null) {
      if (CASE.test(line) || HEADER.test(line)) {
        throw new CollectError(`${where}: test output after Bun's 'Ran' line in the same section`)
      }
      continue
    }
    const header = HEADER.exec(line)
    if (header !== null) {
      const path = `./${header[1]}`
      if (!isDiscoveredTestPath(path)) throw new CollectError(`${where}: file header is not a valid discovered test path`)
      if (sec.inSummary) throw new CollectError(`${where}: file header inside Bun's end-of-run summary`)
      if (sec.groupOpen) throw new CollectError(`${where}: file header before the previous file's group closed`)
      if (sec.replayOf !== null) {
        if (sec.headers.length === 0 && path !== sec.replayOf) {
          throw new CollectError(`${where}: the replayed Bun process does not start with the superseded prelude's file`)
        }
      }
      const prior = seen.get(path)
      if (prior !== undefined) {
        throw new CollectError(`${where}: file header duplicates a file already executed on shard ${prior.shard}`)
      }
      const acc: FileAcc = { path, lane: sec.lane, shard: job.shard, cases: 0, timedCases: 0, costMicros: 0 }
      seen.set(path, acc)
      sec.headers.push(path)
      sec.current = acc
      sec.groupOpen = true
      continue
    }
    if (line === ENDGROUP) {
      if (!sec.groupOpen) throw new CollectError(`${where}: '##[endgroup]' with no open file group`)
      sec.groupOpen = false
      continue
    }
    if (SUMMARY_INTRO.test(line)) {
      if (sec.groupOpen) throw new CollectError(`${where}: Bun's summary starts inside an open file group`)
      if (sec.headers.length === 0) throw new CollectError(`${where}: Bun's summary before any file header`)
      sec.inSummary = true
      continue
    }
    const ran = RAN.exec(line)
    if (ran !== null) {
      if (sec.groupOpen) throw new CollectError(`${where}: Bun's 'Ran' line inside an open file group`)
      sec.ranFiles = Number(ran[1])
      continue
    }
    if (CASE.test(line)) {
      if (sec.inSummary) continue // Bun repeating a case already attributed
      if (sec.headers.length === 0) throw new CollectError(`${where}: orphan case line before any file header`)
      if (!sec.groupOpen || sec.current === null) {
        throw new CollectError(`${where}: case line outside a file group and outside Bun's summary`)
      }
      sec.cases += 1
      const acc = sec.current
      acc.cases += 1
      const d = DURATION.exec(line)
      if (d !== null) {
        acc.timedCases += 1
        acc.costMicros += durationMicros(d[1]!, d[2], d[3]!, where)
        if (!Number.isSafeInteger(acc.costMicros)) throw new CollectError(`${where}: file cost is out of range`)
      }
      continue
    }
  }
  closeSection(lines.length)

  if (shardLine === null) throw new CollectError(`${tag}: no 'run-tests: SHARD k/n' line`)
  if (shardLine.i !== job.shard || shardLine.n !== shardCount) {
    throw new CollectError(`${tag}: log reports SHARD ${shardLine.i}/${shardLine.n}, expected ${job.shard}/${shardCount}`)
  }
  if (declared === null) throw new CollectError(`${tag}: no coverage-audit 'declared files' line`)
  return { declared }
}

/** Pure: derive and validate the profile. Throws CollectError / TestCostProfileError. */
export function collectTestCostProfile(input: CollectInput): TestCostProfile {
  const { runId, headSha, shardCount } = input
  if (!Number.isSafeInteger(runId) || runId < 1) throw new CollectError('run id must be a positive integer')
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new CollectError('head sha must be 40 lowercase hex characters')
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > MAX_SHARD_COUNT) {
    throw new CollectError(`shard count must be within 1..${MAX_SHARD_COUNT}`)
  }
  const jobs = [...input.jobs].sort((a, b) => a.shard - b.shard)
  if (jobs.length !== shardCount || jobs.some((j, i) => j.shard !== i + 1)) {
    throw new CollectError(`expected exactly one job log for each shard 1..${shardCount}`)
  }

  const seen = new Map<string, FileAcc>()
  const declaredByShard: number[] = []
  for (const job of jobs) {
    declaredByShard.push(parseJob(job, shardCount, seen).declared)
  }
  declaredByShard.forEach((declared, i) => {
    if (declared !== seen.size) {
      throw new CollectError(`shard ${i + 1}: declared files ${declared} != ${seen.size} unique files executed across all shards`)
    }
  })

  const all = [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const files: TestCostProfileFile[] = []
  const unmeasured: TestCostProfileUnmeasured[] = []
  for (const f of all) {
    if (f.timedCases > 0) {
      files.push({ path: f.path, lane: f.lane, shard: f.shard, cases: f.cases, timedCases: f.timedCases, costMicros: f.costMicros })
    } else {
      unmeasured.push({ path: f.path, lane: f.lane, shard: f.shard, cases: f.cases })
    }
  }
  return validateTestCostProfile({
    schema: SCHEMA,
    unit: UNIT,
    aggregation: AGGREGATION,
    source: {
      workflow: WORKFLOW,
      runId,
      headSha,
      shardCount,
      collector: COLLECTOR,
      jobs: jobs.map((job) => {
        const mine = all.filter((f) => f.shard === job.shard)
        const measured = mine.filter((f) => f.timedCases > 0)
        return {
          shard: job.shard,
          jobId: job.jobId,
          logSha256: createHash('sha256').update(job.log).digest('hex'),
          measuredFiles: measured.length,
          unmeasuredFiles: mine.length - measured.length,
          costMicros: measured.reduce((sum, f) => sum + f.costMicros, 0),
        }
      }),
    },
    files,
    unmeasured,
  })
}

/** Canonical text, re-parsed once more so only a round-trip-stable profile is emitted. */
export function renderTestCostProfile(input: CollectInput): string {
  const text = serializeTestCostProfile(collectTestCostProfile(input))
  if (serializeTestCostProfile(parseTestCostProfile(text)) !== text) {
    throw new CollectError('the canonical profile does not round-trip')
  }
  return text
}

const USAGE =
  'usage: collect-test-cost-profile.ts --run-id <id> --head-sha <sha> --shard-count <n> ' +
  '--job <shard>=<jobId>=<logfile> ... (--out <profile> | --check <profile>)'

interface CliArgs {
  runId: number
  headSha: string
  shardCount: number
  jobs: Array<{ shard: number; jobId: number; file: string }>
  mode: 'out' | 'check'
  target: string
}

function positiveInt(text: string | undefined, what: string): number {
  if (text === undefined || !/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new CollectError(`${what} must be a positive integer`)
  }
  return Number(text)
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let runId: number | undefined
  let headSha: string | undefined
  let shardCount: number | undefined
  const jobs: CliArgs['jobs'] = []
  let mode: CliArgs['mode'] | undefined
  let target: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) throw new CollectError(`${flag} needs a value`)
    i++
    switch (flag) {
      case '--run-id': runId = positiveInt(value, '--run-id'); break
      case '--head-sha': headSha = value; break
      case '--shard-count': shardCount = positiveInt(value, '--shard-count'); break
      case '--job': {
        const m = /^(\d+)=(\d+)=(.+)$/.exec(value)
        if (m === null) throw new CollectError('--job must be <shard>=<jobId>=<logfile>')
        jobs.push({ shard: positiveInt(m[1], '--job shard'), jobId: positiveInt(m[2], '--job id'), file: m[3]! })
        break
      }
      case '--out':
      case '--check':
        if (mode !== undefined) throw new CollectError('pass exactly one of --out or --check')
        mode = flag === '--out' ? 'out' : 'check'
        target = value
        break
      default:
        throw new CollectError(`unknown argument ${flag}`)
    }
  }
  if (runId === undefined || headSha === undefined || shardCount === undefined || mode === undefined || target === undefined) {
    throw new CollectError(USAGE)
  }
  return { runId, headSha, shardCount, jobs, mode, target }
}

/** CLI entry. Returns the exit code; writes nothing unless the profile is valid. */
export function main(argv: readonly string[], log: (line: string) => void = (l) => console.error(l)): number {
  try {
    const args = parseCliArgs(argv)
    const text = renderTestCostProfile({
      runId: args.runId,
      headSha: args.headSha,
      shardCount: args.shardCount,
      jobs: args.jobs.map((j) => ({ shard: j.shard, jobId: j.jobId, log: new Uint8Array(readFileSync(j.file)) })),
    })
    if (args.mode === 'check') {
      let committed: string
      try {
        committed = readFileSync(args.target, 'utf8')
      } catch {
        log('collect-test-cost-profile: CHECK FAILED — the committed profile is unreadable')
        return 1
      }
      if (committed !== text) {
        log('collect-test-cost-profile: CHECK FAILED — the logs do not reproduce the committed profile byte-for-byte')
        return 1
      }
      log('collect-test-cost-profile: check OK — the logs reproduce the committed profile byte-for-byte')
      return 0
    }
    const tmp = join(dirname(args.target), `.${basename(args.target)}.${process.pid}.tmp`)
    try {
      writeFileSync(tmp, text, { flag: 'wx' })
      renameSync(tmp, args.target)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
    log(`collect-test-cost-profile: wrote ${text.length} bytes`)
    return 0
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log(`collect-test-cost-profile: REFUSED — ${reason}`)
    return 1
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
