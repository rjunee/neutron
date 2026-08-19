/**
 * The real as-built write guard against a throwaway git repository.
 *
 * The guard's boundary is git history, not the working tree: branch-side writes
 * to the canonical log fail, staged entries pass, renaming the log away still
 * fails, and invalid inputs refuse to skip. The final case pins the three-dot
 * diff: a legitimate fold on main after the branch fork must not red the branch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
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

  try {
    const stdout = execFileSync('bash', [GUARD_SH], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error: unknown) {
    const failure = error as {
      status?: number
      stdout?: string
      stderr?: string
    }
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    }
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

  test('a branch that edits docs/AS_BUILT.md fails with the rule and remedy', () => {
    const result = runGuard(repo, baseSha, violationSha)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('docs/AS_BUILT.md')
    expect(result.stderr).toContain('.trident/as-built/')
    expect(result.stderr).toContain('ONE writer')
  }, 30_000)

  test('renaming docs/AS_BUILT.md away is still a violation', () => {
    const result = runGuard(repo, baseSha, renameSha)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('docs/AS_BUILT.md')
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
