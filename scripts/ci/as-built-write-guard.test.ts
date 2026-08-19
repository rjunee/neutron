/**
 * The real as-built write guard against a throwaway git repository.
 *
 * The guard's boundary is git history, not the working tree: branch-side writes
 * to the canonical log are DETECTED and warned about, staged entries pass,
 * renaming the log away is still detected, and invalid inputs refuse to skip.
 * One case pins the three-dot diff — a legitimate fold on main after the branch
 * fork must not red the branch.
 *
 * THE VERDICT IS ADVISORY; THE REFUSALS ARE NOT. A detected write exits 0 with a
 * warning (measured 2026-08-19: 0 of 34 conflicting open PRs were blocked solely
 * by this file, so a veto would have cost 31 of 45 PRs for no measured benefit).
 * An UNREADABLE input still exits 2 — "I looked and found a write" and "I could
 * not look" are different failures, and only the first was downgraded.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD_SH = fileURLToPath(new URL('./as-built-write-guard.sh', import.meta.url))
const UNRESOLVABLE_SHA = '0123456789abcdef0123456789abcdef01234567'

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
  let foldedMainSha = ''

  beforeAll(() => {
    git(repo, 'init', '-q', '--initial-branch=main')
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'AS_BUILT.md'), '# As-built log\n\nbase\n')
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
    writeFileSync(join(repo, 'docs', 'AS_BUILT.md'), '# As-built log\n\nbranch write\n')
    git(repo, 'add', '-A')
    commit(repo, 'write canonical log')
    violationSha = git(repo, 'rev-parse', 'HEAD')

    git(repo, 'switch', '-q', '-c', 'rename-away', baseSha)
    git(repo, 'mv', 'docs/AS_BUILT.md', 'docs/RENAMED.md')
    commit(repo, 'rename canonical log')
    renameSha = git(repo, 'rev-parse', 'HEAD')

    git(repo, 'switch', '-q', 'main')
    writeFileSync(join(repo, 'docs', 'AS_BUILT.md'), '# As-built log\n\nfolded on main\n')
    git(repo, 'add', '-A')
    commit(repo, 'fold staged entry on main')
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
    expect(result.stderr).toContain('WARNING')
    expect(result.stderr).toContain('docs/AS_BUILT.md')
    expect(result.stderr).toContain('.trident/as-built/')
    expect(result.stderr).toContain('ONE writer')
  }, 30_000)

  test('…and does NOT fail the build', () => {
    const result = runGuard(repo, baseSha, violationSha)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('does not fail the build')
  }, 30_000)

  test('the warning is distinguishable from the clean pass', () => {
    // Without this, "warns" and "says OK" are the same observation to any caller
    // reading the exit code, and a detection regression would look identical to
    // a clean branch.
    const violation = runGuard(repo, baseSha, violationSha)
    const clean = runGuard(repo, baseSha, cleanSha)
    expect(violation.status).toBe(clean.status)
    expect(clean.stdout).toContain('as-built-write-guard: OK')
    expect(clean.stderr).not.toContain('WARNING')
    expect(violation.stdout).not.toContain('as-built-write-guard: OK')
  }, 30_000)

  test('renaming docs/AS_BUILT.md away is still detected', () => {
    const result = runGuard(repo, baseSha, renameSha)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('WARNING')
    expect(result.stderr).toContain('docs/AS_BUILT.md')
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

  test('a fold committed on main after the fork does not red the clean branch', () => {
    const result = runGuard(repo, foldedMainSha, cleanSha)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('as-built-write-guard: OK')
  }, 30_000)
})
