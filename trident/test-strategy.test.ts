/**
 * TEST EXECUTION strategy — behavioural tests for `trident/test-strategy.ts`.
 *
 * THE DEFECTS THESE GUARD, all measured on the 2026-08-15 canary build (PR #263):
 *   - the build ran 1,273 files SEQUENTIALLY because it never set the knob the
 *     runner has always exposed (`computeTestJobs` + the knob branch of the render);
 *   - it waited ~20 minutes to learn about a typo in a file it had just edited
 *     (stage 1);
 *   - a stage-1-style partial pass must never be able to stand in for the audited
 *     full run (`FULL_SUITE_REQUIRED`, acceptance criterion 5);
 *   - `timeout 590 bash scripts/run-tests.sh` capped a ~20-minute suite at 10
 *     minutes and read the kill as a failure (`NO_TIMEOUT_WRAPPER`, criterion 7).
 *
 * And the PART 2 constraint, which is the one most likely to be silently broken:
 * this module runs in EVERY project trident deploys to, so it must never hardcode
 * neutron-open's runner and must NEVER EXECUTE a probed script. The
 * "no-execution proof" test below writes a runner that would leave a sentinel file
 * behind if it were ever run, and asserts the sentinel is not there.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildTestStrategy,
  computeTestJobs,
  probeParallelKnobs,
  renderTestStrategy,
  resolveTestCommand,
  FULL_SUITE_REQUIRED,
  NO_KNOBS_LINE,
  NO_TIMEOUT_WRAPPER,
  STAGE_1_REJECT_ONLY,
} from './test-strategy.ts'

const fixtures: string[] = []

function fixture(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'test-strategy-'))
  fixtures.push(dir)
  for (const [rel, contents] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  return dir
}

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true })
})

const GiB = 1024 ** 3

describe('resolveTestCommand', () => {
  test('tier 1 — package.json scripts.test wins, trimmed', () => {
    const repo = fixture({ 'package.json': JSON.stringify({ scripts: { test: '  bash scripts/run-tests.sh  ' } }) })
    expect(resolveTestCommand(repo)).toEqual({ command: 'bash scripts/run-tests.sh', source: 'package-json' })
  })

  test('tier 2 — a fenced block in CLAUDE.md when package.json cannot answer', () => {
    const repo = fixture({
      'package.json': JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }),
      'CLAUDE.md': ['# Project', '', 'Run the suite:', '', '```bash', 'bash scripts/run-tests.sh', '```', ''].join('\n'),
    })
    expect(resolveTestCommand(repo)).toEqual({ command: 'bash scripts/run-tests.sh', source: 'agent-docs' })
  })

  test('tier 2 — a repo whose only documented invocation is `bun test` also resolves', () => {
    const repo = fixture({ 'AGENTS.md': ['```', '$ bun test', '```'].join('\n') })
    expect(resolveTestCommand(repo)).toEqual({ command: 'bun test', source: 'agent-docs' })
  })

  test('tier 2 ignores prose outside fences', () => {
    const repo = fixture({ 'CLAUDE.md': 'bash scripts/run-tests.sh runs the suite.\n' })
    expect(resolveTestCommand(repo)).toEqual({ command: null, source: null })
  })

  test('an empty repo is unresolved, not an error', () => {
    expect(resolveTestCommand(fixture())).toEqual({ command: null, source: null })
  })

  test('malformed package.json does not throw and falls through to tier 2', () => {
    const repo = fixture({
      'package.json': '{ "scripts": { "test": ',
      'CONTRIBUTING.md': ['```sh', 'pytest -q', '```'].join('\n'),
    })
    expect(resolveTestCommand(repo)).toEqual({ command: 'pytest -q', source: 'agent-docs' })
  })

  test('a nonexistent repoRoot is unresolved, not an error', () => {
    expect(resolveTestCommand(join(tmpdir(), 'test-strategy-does-not-exist-9421'))).toEqual({
      command: null,
      source: null,
    })
  })
})

describe('probeParallelKnobs', () => {
  test('detects the knob in the referenced script and reports the probed file', () => {
    const repo = fixture({
      'scripts/run-tests.sh': '#!/usr/bin/env bash\nJOBS="${NEUTRON_TEST_JOBS:-1}"\n',
    })
    expect(probeParallelKnobs(repo, 'bash scripts/run-tests.sh')).toEqual({
      jobs_env: 'NEUTRON_TEST_JOBS',
      probed_file: 'scripts/run-tests.sh',
    })
  })

  test('a script without the knob probes cleanly to null', () => {
    const repo = fixture({ 'scripts/run-tests.sh': '#!/usr/bin/env bash\nbun test\n' })
    expect(probeParallelKnobs(repo, 'bash scripts/run-tests.sh')).toEqual({
      jobs_env: null,
      probed_file: 'scripts/run-tests.sh',
    })
  })

  test('a command referencing a missing file yields no knobs and no probed file', () => {
    expect(probeParallelKnobs(fixture(), 'bash scripts/nope.sh')).toEqual({ jobs_env: null, probed_file: null })
  })

  test('a null command is not probed', () => {
    expect(probeParallelKnobs(fixture(), null)).toEqual({ jobs_env: null, probed_file: null })
  })

  test('NO EXECUTION — probing an executable runner never runs it', () => {
    const repo = fixture()
    const sentinel = join(repo, 'RAN')
    const script = join(repo, 'scripts', 'run-tests.sh')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    writeFileSync(
      script,
      ['#!/usr/bin/env bash', `touch ${JSON.stringify(sentinel)}`, 'echo "NEUTRON_TEST_JOBS supported"', ''].join('\n'),
    )
    chmodSync(script, 0o755)

    const knobs = probeParallelKnobs(repo, 'bash scripts/run-tests.sh --help')

    expect(knobs.jobs_env).toBe('NEUTRON_TEST_JOBS') // read from the text…
    expect(existsSync(sentinel)).toBe(false) // …never by running it
  })
})

describe('computeTestJobs', () => {
  const box = { cores: 8, mem_available_bytes: 25 * GiB }

  // The reference-box table that goes verbatim into AS_BUILT.
  test.each([
    [1, 8],
    [2, 4],
    [4, 2],
    [8, 1],
    [9, 1],
  ])('8 cores / 25 GiB with %i active run(s) → %i jobs', (active_runs, expected) => {
    expect(computeTestJobs({ ...box, active_runs })).toBe(expected)
  })

  test('memory caps below the core budget', () => {
    expect(computeTestJobs({ cores: 8, active_runs: 1, mem_available_bytes: 3 * GiB })).toBe(1)
    expect(computeTestJobs({ cores: 8, active_runs: 1, mem_available_bytes: 6 * GiB })).toBe(2)
  })

  test('degenerate inputs degrade to sequential, never to zero or NaN', () => {
    expect(computeTestJobs({ cores: 0, active_runs: 1, mem_available_bytes: 25 * GiB })).toBe(1)
    expect(computeTestJobs({ cores: 8, active_runs: 1, mem_available_bytes: Number.NaN })).toBe(1)
    expect(computeTestJobs({ cores: 8, active_runs: -3, mem_available_bytes: 25 * GiB })).toBe(1)
  })
})

describe('renderTestStrategy', () => {
  const knobBranch = renderTestStrategy({
    resolution: { command: 'bash scripts/run-tests.sh', source: 'package-json' },
    knobs: { jobs_env: 'NEUTRON_TEST_JOBS', probed_file: 'scripts/run-tests.sh' },
    jobs: 4,
    base_branch: 'main',
  })
  const noKnobBranch = renderTestStrategy({
    resolution: { command: 'pytest -q', source: 'agent-docs' },
    knobs: { jobs_env: null, probed_file: null },
    jobs: 4,
    base_branch: 'main',
  })
  const unresolvedBranch = renderTestStrategy({
    resolution: { command: null, source: null },
    knobs: { jobs_env: null, probed_file: null },
    jobs: 1,
    base_branch: 'develop',
  })
  const branches = { knobBranch, noKnobBranch, unresolvedBranch }

  test('knob branch renders the budgeted full-suite command', () => {
    expect(knobBranch).toContain('NEUTRON_TEST_JOBS=4 bash scripts/run-tests.sh')
  })

  test('no-knob branch runs the command unchanged and says so, exactly once, without the knob', () => {
    expect(noKnobBranch).toContain('pytest -q')
    expect(noKnobBranch).toContain(NO_KNOBS_LINE)
    expect(noKnobBranch).not.toContain('NEUTRON_TEST_JOBS=')
  })

  test('unresolved branch tells the agent to resolve the command from the project docs', () => {
    expect(unresolvedBranch).toContain('could NOT be resolved')
    expect(unresolvedBranch).toContain('UNCHANGED')
    expect(unresolvedBranch).toContain(NO_KNOBS_LINE)
  })

  test('stage 1 is diff-scoped against the base branch', () => {
    expect(knobBranch).toContain('git diff --name-only main..HEAD')
    expect(unresolvedBranch).toContain('git diff --name-only develop..HEAD')
    expect(knobBranch).toContain('__tests__/')
  })

  test.each(Object.entries(branches))('%s carries every load-bearing rule', (_name, block) => {
    expect(block.length).toBeGreaterThan(0)
    expect(block).toContain('TEST EXECUTION')
    expect(block).toContain(STAGE_1_REJECT_ONLY)
    expect(block).toContain(FULL_SUITE_REQUIRED)
    expect(block).toContain(NO_TIMEOUT_WRAPPER)
  })
})

describe('buildTestStrategy', () => {
  test('composes the knob branch for a repo that declares a knob-aware runner', () => {
    const repo = fixture({
      'package.json': JSON.stringify({ scripts: { test: 'bash scripts/run-tests.sh' } }),
      'scripts/run-tests.sh': '#!/usr/bin/env bash\nJOBS="${NEUTRON_TEST_JOBS:-1}"\n',
    })
    const block = buildTestStrategy(repo, {
      cores: 8,
      active_runs: 2,
      mem_available_bytes: 25 * GiB,
      base_branch: 'main',
    })
    expect(block).toContain('NEUTRON_TEST_JOBS=4 bash scripts/run-tests.sh')
    expect(block).toContain(FULL_SUITE_REQUIRED)
  })

  test('a knob-less project still gets a usable block, sequentially, with no error', () => {
    const repo = fixture({ 'package.json': JSON.stringify({ scripts: { test: 'go test ./...' } }) })
    const block = buildTestStrategy(repo, {
      cores: 8,
      active_runs: 1,
      mem_available_bytes: 25 * GiB,
      base_branch: 'main',
    })
    expect(block).toContain('go test ./...')
    expect(block).toContain(NO_KNOBS_LINE)
    expect(block).not.toContain('NEUTRON_TEST_JOBS=')
  })

  test('a nonexistent repoRoot returns a usable block instead of throwing', () => {
    const block = buildTestStrategy(join(tmpdir(), 'test-strategy-missing-7731'), {
      cores: 8,
      active_runs: 1,
      mem_available_bytes: 25 * GiB,
      base_branch: 'main',
    })
    expect(block).toContain('TEST EXECUTION')
    expect(block).toContain('could NOT be resolved')
    expect(block).toContain(NO_TIMEOUT_WRAPPER)
  })
})
