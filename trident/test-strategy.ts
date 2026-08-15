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
 * CONTRACT OF THIS MODULE: pure-ish (reads files, writes nothing), NEVER throws into
 * a launch path, NEVER spawns a process anywhere, and has NO import-time side
 * effects. A build must never fail because the strategy could not be derived.
 */

import { readFileSync, statSync } from 'node:fs'
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
        if (typeof declared === 'string' && declared.trim().length > 0) {
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
    if (match) return match[1].trim()
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Probe the resolved runner for parallel knobs — STATICALLY
// ─────────────────────────────────────────────────────────────────────────────

export interface ParallelKnobs {
  /** `'NEUTRON_TEST_JOBS'` when the runner is known to honour it, else null. */
  jobs_env: string | null
  /** Repo-relative (or absolute) script file whose text was scanned, or null. */
  probed_file: string | null
}

const NO_KNOBS: ParallelKnobs = { jobs_env: null, probed_file: null }

const JOBS_ENV = 'NEUTRON_TEST_JOBS'

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
 */
export function probeParallelKnobs(repoRoot: string, command: string | null): ParallelKnobs {
  try {
    if (typeof command !== 'string' || command.trim().length === 0) return NO_KNOBS
    const jobsPattern = new RegExp(`\\b${JOBS_ENV}\\b`)

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

    const found = jobsPattern.test(command) || (scriptText !== null && jobsPattern.test(scriptText))
    return { jobs_env: found ? JOBS_ENV : null, probed_file }
  } catch {
    return NO_KNOBS
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The concurrency-aware jobs budget
// ─────────────────────────────────────────────────────────────────────────────

export interface TestJobsInput {
  cores: number
  /** Non-terminal trident runs, INCLUDING this one — the live fan-out. */
  active_runs: number
  mem_available_bytes: number
  /** The runner's `NEUTRON_TEST_CHUNK_SIZE` default. */
  chunk_size?: number
  /** Conservative per-file working set, per `docs/testing-runner.md`'s RSS model. */
  per_file_rss_bytes?: number
}

const DEFAULT_CHUNK_SIZE = 100
const DEFAULT_PER_FILE_RSS = 24 * 2 ** 20 // 24 MiB
/** Leave a fifth of available RAM for everything else on a shared box. */
const MEM_HEADROOM = 0.8

/**
 * Split the box across the runs that are actually in flight, then cap by RAM.
 *
 * Why divide at all: trident fans several builds out at once, and four concurrent
 * builds each asking for `JOBS=4` is sixteen bun processes on eight cores — slower
 * than sequential, and a plausible OOM.
 *
 * Reference box (8 cores, 25 GiB available, defaults → memory allows 8):
 *
 *   active_runs │ 1 │ 2 │ 4 │ 8+ │
 *   jobs        │ 8 │ 4 │ 2 │  1 │
 *
 * (These numbers go verbatim into AS_BUILT.) Any unusable input degrades to 1 —
 * sequential, i.e. exactly the runner's own default, which is always safe.
 */
export function computeTestJobs(input: TestJobsInput): number {
  const chunkSize = positiveOr(input.chunk_size, DEFAULT_CHUNK_SIZE)
  const perFileRss = positiveOr(input.per_file_rss_bytes, DEFAULT_PER_FILE_RSS)
  if (!isPositive(input.cores) || !isPositive(input.mem_available_bytes)) return 1
  if (!isPositive(input.active_runs)) return 1

  const byCores = Math.max(1, Math.floor(input.cores / Math.max(1, input.active_runs)))
  const byMem = Math.max(1, Math.floor((input.mem_available_bytes * MEM_HEADROOM) / (chunkSize * perFileRss)))
  return Math.min(byCores, byMem)
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
  base_branch: string
}

/**
 * The one line a knob-less project gets. It is a LOG LINE, not an error: the suite
 * still runs, unchanged and sequential. Exact text is pinned by a test because it is
 * the honest-degradation proof point for PART 2 (enterprise).
 */
export const NO_KNOBS_LINE = 'parallel knobs not found in the project test runner — running it unchanged (sequential)'

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

  const commandLines: string[] = []
  if (command === null) {
    commandLines.push(
      'The project test command could NOT be resolved from its package.json or agent docs.',
      "Resolve it yourself from the project's own documentation (README / CLAUDE.md / AGENTS.md /",
      'CONTRIBUTING.md / package.json) and then run it UNCHANGED — do not invent flags, do not',
      'substitute a narrower command, and do not add environment variables it does not document.',
      NO_KNOBS_LINE,
    )
  } else if (hasKnob) {
    commandLines.push(
      'Full suite (stage 2), run exactly this:',
      '',
      `  ${knobs.jobs_env}=${jobCount} ${command}`,
      '',
      `The runner honours ${knobs.jobs_env} (found by static scan${knobs.probed_file ? ` of ${knobs.probed_file}` : ''}). The value`,
      'above is this box’s core/RAM budget divided across the trident runs currently in flight —',
      'do NOT raise it; other builds are sharing these cores. Everything else about the command',
      'stays as the project wrote it.',
    )
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
    `After your edits, list what you changed: \`git diff --name-only ${baseBranch}..HEAD\`. The stage-1`,
    'set is: (a) the changed files that are themselves test files, (b) the test files in each',
    "changed file's own directory or its adjacent `__tests__/`, and (c) test files that name a",
    "changed module's basename (`grep -l <basename> <test files>`). Run ONLY that set, using the",
    "project's file-scoped test invocation (e.g. `bun test <file> …`). A stage-1 failure is fixed",
    `IMMEDIATELY, before anything else — do not start the full suite on a red stage 1. ${STAGE_1_REJECT_ONLY}`,
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
    return renderTestStrategy({ resolution, knobs, jobs, base_branch: env?.base_branch })
  } catch {
    return renderTestStrategy({
      resolution: UNRESOLVED,
      knobs: NO_KNOBS,
      jobs: 1,
      base_branch: typeof env?.base_branch === 'string' ? env.base_branch : 'main',
    })
  }
}
