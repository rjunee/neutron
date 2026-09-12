/**
 * The real as-built write guard against a throwaway git repository.
 *
 * The guard's boundary is git history, not the working tree: branch-side writes
 * to the frozen log FAIL, staged entries pass, renaming the log away is still a
 * write, and invalid inputs refuse to skip. One case pins the three-dot diff — a
 * legitimate promotion commit on main after the branch fork must not red the
 * branch.
 *
 * THE VERDICT IS A VETO AGAIN, AND THE REFUSALS ARE STILL SEPARATE. The advisory
 * downgrade rested on a 2026-08-19 measurement of a backlog where 31 of 45 open
 * PRs were legitimately APPENDING to an append-only log. The log is frozen now,
 * so the number of correct PRs a veto costs is zero by construction, and the
 * `merge=union` attribute that was absorbing the overlap is gone. An UNREADABLE
 * input is still exit 2 — "I looked and found a write" and "I could not look"
 * remain different failures.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD_SH = fileURLToPath(new URL('./as-built-write-guard.sh', import.meta.url))
const REAL_LOG = fileURLToPath(new URL('../../docs/AS_BUILT.md', import.meta.url))
const UNRESOLVABLE_SHA = '0123456789abcdef0123456789abcdef01234567'
const FROZEN_LOG = '# As-built log\n\n> **FROZEN as of 2026-09-12.**\n\n## 2026-01-01 — base entry\n\nbase\n'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function commit(repo: string, message: string): void {
  git(
    repo,
    '-c',
    'user.name=Test Setup',
    '-c',
    'user.email=setup@neutron.local',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    message,
  )
}

type GuardResult = { status: number; stdout: string; stderr: string }

function runGuard(repo: string, base?: string, head?: string): GuardResult {
  const env = { ...process.env }
  delete env.GUARD_BASE_SHA
  delete env.GUARD_HEAD_SHA
  env.AS_BUILT_GUARD_ROOT = repo
  if (base !== undefined) env.GUARD_BASE_SHA = base
  if (head !== undefined) env.GUARD_HEAD_SHA = head

  // `spawnSync`, NOT `execFileSync`. The previous helper read stderr only from
  // the THROWN error, so a zero-exit run reported `stderr: ''` by construction.
  // That was invisible while every violation exited 1; the moment the verdict
  // became advisory, three tests failed for a reason that had nothing to do with
  // the guard. A harness that can only observe failures cannot test a check
  // whose whole point is that it now succeeds while still saying something.
  const result = spawnSync('bash', [GUARD_SH], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

describe('as-built write guard (real git)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'as-built-guard-'))
  let baseSha = ''
  let cleanSha = ''
  let violationSha = ''
  let renameSha = ''
  let recordSha = ''
  let foldedMainSha = ''

  beforeAll(() => {
    git(repo, 'init', '-q', '--initial-branch=main')
    mkdirSync(join(repo, 'docs'), { recursive: true })
    // The base carries the freeze note, which is the precondition the guard
    // reads before it vetoes anything.
    writeFileSync(join(repo, 'docs', 'AS_BUILT.md'), FROZEN_LOG)
    writeFileSync(join(repo, 'code.ts'), 'export const value = 1\n')
    git(repo, 'add', '-A')
    commit(repo, 'base')
    baseSha = git(repo, 'rev-parse', 'HEAD')

    git(repo, 'switch', '-q', '-c', 'clean', baseSha)
    mkdirSync(join(repo, '.trident', 'as-built', 'trident'), {
      recursive: true,
    })
    writeFileSync(
      join(repo, '.trident', 'as-built', 'trident', 'some-branch.md'),
      '## 2026-08-18 — staged entry\n\nClean branch entry.\n',
    )
    writeFileSync(join(repo, 'code.ts'), 'export const value = 2\n')
    git(repo, 'add', '-A')
    commit(repo, 'clean branch')
    cleanSha = git(repo, 'rev-parse', 'HEAD')

    git(repo, 'switch', '-q', '-c', 'violation', baseSha)
    writeFileSync(join(repo, 'docs', 'AS_BUILT.md'), `${FROZEN_LOG}\n## 2026-09-13 — branch write\n\nnope\n`)
    git(repo, 'add', '-A')
    commit(repo, 'write canonical log')
    violationSha = git(repo, 'rev-parse', 'HEAD')

    git(repo, 'switch', '-q', '-c', 'adds-record', baseSha)
    mkdirSync(join(repo, 'docs', 'as-built'), { recursive: true })
    writeFileSync(
      join(repo, 'docs', 'as-built', 'a-shipped-change.md'),
      '## 2026-09-12 — a shipped change\n\nRecorded in its own file.\n',
    )
    git(repo, 'add', '-A')
    commit(repo, 'record a change')
    recordSha = git(repo, 'rev-parse', 'HEAD')

    git(repo, 'switch', '-q', '-c', 'rename-away', baseSha)
    git(repo, 'mv', 'docs/AS_BUILT.md', 'docs/RENAMED.md')
    commit(repo, 'rename canonical log')
    renameSha = git(repo, 'rev-parse', 'HEAD')

    git(repo, 'switch', '-q', 'main')
    writeFileSync(join(repo, 'docs', 'AS_BUILT.md'), `${FROZEN_LOG}\nedited on main\n`)
    git(repo, 'add', '-A')
    commit(repo, 'a main-side edit of the frozen log, before the freeze landed')
    foldedMainSha = git(repo, 'rev-parse', 'HEAD')
  }, 30_000)

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test('a clean branch stages its entry and passes', () => {
    const result = runGuard(repo, baseSha, cleanSha)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('as-built-write-guard: OK')
  }, 30_000)

  // ADVISORY, NOT A VETO — and the two halves are asserted separately on
  // purpose. Measured against the live backlog (2026-08-19), 0 of 34
  // conflicting open PRs were blocked SOLELY by docs/AS_BUILT.md; every one had
  // a real code conflict elsewhere. A hard failure would have refused 31 of 45
  // open PRs for a benefit measured at zero. So the DETECTION must keep working
  // exactly as before, and the EXIT CODE must not stop anyone — a test that only
  // checked `status === 0` would also pass if the detection were deleted.
  test('a branch that edits docs/AS_BUILT.md is DETECTED, with the rule and remedy', () => {
    const result = runGuard(repo, baseSha, violationSha)
    expect(result.stderr).toContain('FAILED')
    expect(result.stderr).toContain('docs/AS_BUILT.md')
    expect(result.stderr).toContain('FROZEN')
    expect(result.stderr).toContain('.trident/as-built/')
    expect(result.stderr).toContain('docs/as-built/README.md')
  }, 30_000)

  test('…and FAILS the build', () => {
    // The half that changed. Asserted apart from the detection above on purpose:
    // a test checking only the exit code would also pass if the message were
    // deleted, and one checking only the message would also pass if the veto were
    // dropped again.
    const result = runGuard(repo, baseSha, violationSha)
    expect(result.status).toBe(1)
  }, 30_000)

  test('the failure is distinguishable from the clean pass', () => {
    const violation = runGuard(repo, baseSha, violationSha)
    const clean = runGuard(repo, baseSha, cleanSha)
    expect(violation.status).not.toBe(clean.status)
    expect(clean.status).toBe(0)
    expect(clean.stdout).toContain('as-built-write-guard: OK')
    expect(clean.stderr).not.toContain('FAILED')
    expect(violation.stdout).not.toContain('as-built-write-guard: OK')
  }, 30_000)

  test('a branch adding a NEW docs/as-built/ record passes — that is the sanctioned place', () => {
    // The mirror of the veto: the guard must veto the frozen path and NOTHING
    // else, or it would block the very thing it tells people to do instead.
    const result = runGuard(repo, baseSha, recordSha)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('as-built-write-guard: OK')
  }, 30_000)

  test('renaming docs/AS_BUILT.md away is a write too, and fails', () => {
    const result = runGuard(repo, baseSha, renameSha)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('docs/AS_BUILT.md')
  }, 30_000)

  test('THIS REPO\'s log carries the freeze note the veto is conditioned on', () => {
    // The one thing that could disarm the veto silently: the guard only vetoes
    // when the base's log carries this note, so a reformat that dropped it would
    // turn the gate off with nothing red. It reds here instead.
    expect(readFileSync(REAL_LOG, 'utf8')).toContain('FROZEN as of')
  }, 30_000)

  test('the veto fires on a LOG THE SIZE OF THE REAL ONE, not just a small fixture', () => {
    // THE REGRESSION THIS PINS. The freeze check first read the base's log with
    // `git show … | grep -q`. Under `set -o pipefail`, grep exits on the match,
    // the pipe closes under a still-writing git, git dies of SIGPIPE, and the
    // PIPELINE reports failure — so the guard answered "not frozen" for a file
    // that is. On a small fixture git finishes first and the bug is invisible;
    // measured against this repo's real 2.0 MB log, the veto did not fire at all.
    // Hence the padding: a fixture small enough to pass this test by luck proves
    // nothing about the only file the gate protects.
    const big = mkdtempSync(join(tmpdir(), 'as-built-guard-big-'))
    try {
      git(big, 'init', '-q', '--initial-branch=main')
      mkdirSync(join(big, 'docs'), { recursive: true })
      const padded = `${FROZEN_LOG}${'padding line that makes this log megabyte-sized\n'.repeat(40_000)}`
      expect(padded.length).toBeGreaterThan(1_000_000)
      writeFileSync(join(big, 'docs', 'AS_BUILT.md'), padded)
      git(big, 'add', '-A')
      commit(big, 'frozen base, real size')
      const base = git(big, 'rev-parse', 'HEAD')

      git(big, 'switch', '-q', '-c', 'writes-it', base)
      writeFileSync(join(big, 'docs', 'AS_BUILT.md'), `${padded}\n## 2026-09-13 — appended anyway\n\nnope\n`)
      git(big, 'add', '-A')
      commit(big, 'append to the frozen log')

      const result = runGuard(big, base, git(big, 'rev-parse', 'HEAD'))
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('FAILED')
    } finally {
      rmSync(big, { recursive: true, force: true })
    }
  }, 60_000)

  test('a branch touching a log the BASE has NOT frozen passes, and says why', () => {
    // The bootstrap: the change that installs the freeze necessarily writes this
    // file, and is judged against a base that is not yet frozen. Nothing silent
    // about it — the guard states that it is passing this one diff.
    const unfrozen = mkdtempSync(join(tmpdir(), 'as-built-guard-unfrozen-'))
    try {
      git(unfrozen, 'init', '-q', '--initial-branch=main')
      mkdirSync(join(unfrozen, 'docs'), { recursive: true })
      writeFileSync(join(unfrozen, 'docs', 'AS_BUILT.md'), '# As-built log\n\n## 2026-01-01 — e\n\nbody\n')
      git(unfrozen, 'add', '-A')
      commit(unfrozen, 'append-only base')
      const base = git(unfrozen, 'rev-parse', 'HEAD')

      git(unfrozen, 'switch', '-q', '-c', 'freeze', base)
      writeFileSync(join(unfrozen, 'docs', 'AS_BUILT.md'), FROZEN_LOG)
      git(unfrozen, 'add', '-A')
      commit(unfrozen, 'freeze the log')
      const head = git(unfrozen, 'rev-parse', 'HEAD')

      const result = runGuard(unfrozen, base, head)
      expect(result.status).toBe(0)
      expect(result.stderr).toContain('carries no freeze note')
      expect(result.stderr).not.toContain('FAILED')
    } finally {
      rmSync(unfrozen, { recursive: true, force: true })
    }
  }, 30_000)

  test('the unreadable-event refusals are UNCHANGED — advisory applies only to the verdict', () => {
    // Downgrading the verdict must not downgrade the guard's refusal to run
    // blind. "I looked and found a write" is now advice; "I could not look" is
    // still exit 2, and these are different failures.
    const result = runGuard(repo, UNRESOLVABLE_SHA, cleanSha)
    expect(result.status).toBe(2)
  }, 30_000)

  test('missing either required SHA exits 2 rather than skipping', () => {
    const missingBase = runGuard(repo, undefined, cleanSha)
    expect(missingBase.status).toBe(2)
    expect(missingBase.stderr).toContain('GUARD_BASE_SHA')

    const missingHead = runGuard(repo, baseSha, undefined)
    expect(missingHead.status).toBe(2)
    expect(missingHead.stderr).toContain('GUARD_HEAD_SHA')
  }, 30_000)

  test('an unresolvable SHA exits 2 and names the bad value', () => {
    const result = runGuard(repo, UNRESOLVABLE_SHA, cleanSha)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(UNRESOLVABLE_SHA)
  }, 30_000)

  test('a main-side commit touching the log after the fork does not red the clean branch', () => {
    // The three-dot diff pin: the guard asks what the BRANCH did, not what main
    // did since the fork.
    const result = runGuard(repo, foldedMainSha, cleanSha)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('as-built-write-guard: OK')
  }, 30_000)
})
