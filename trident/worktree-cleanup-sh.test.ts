/**
 * REAL-git tests for `trident/worktree-cleanup.sh` — the deterministic
 * replacement for the inner workflow's force-removing cleanup agent (ISSUES
 * #541). Deliberately NOT mocked (the checkpoint-sh / merge-realgit discipline):
 * the script IS shell + git, and the bug it fixes — `git worktree remove --force`
 * plus `git branch -D` fired from a `finally{}` on a tree holding the only copy
 * of the work — is only observable against a real working tree.
 *
 * The load-bearing claims, each pinned below:
 *   1. DIRTY MEANS PRESERVE, and dirty INCLUDES untracked files. PR #171 lost 197
 *      insertions across 7 files; a status that ignores untracked files would
 *      have called that tree clean.
 *   2. PRESERVE IS LOUD — exit 3 and the paths printed, so the caller reports the
 *      work instead of silently orphaning it.
 *   3. CLEAN TREES ARE STILL REMOVED (the fix must not leak worktrees), and the
 *      removal never passes `--force`.
 *   4. THE BRANCH IS NOT A LOOPHOLE — `git branch -D` loses commits just as
 *      thoroughly, so it happens only when origin provably holds the same sha,
 *      and never in local mode.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./worktree-cleanup.sh', import.meta.url))
const BRANCH = 'trident/p0b-demo'
const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

/** Run git in `cwd`, throwing on failure (the fixture must never fail silently). */
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString() || p.stdout.toString()}`)
  }
  return p.stdout.toString()
}

function run(repo: string, branch: string, mode: string): { code: number; out: string } {
  const p = Bun.spawnSync(['bash', SCRIPT, repo, branch, mode], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}` }
}

/** Worktree paths git still lists for `branch`. */
function worktreesFor(repo: string, branch: string): string[] {
  const out = git(repo, 'worktree', 'list', '--porcelain')
  const paths: string[] = []
  let cur: string | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) cur = line.slice('worktree '.length).trim()
    else if (line.trim() === `branch refs/heads/${branch}` && cur !== null) paths.push(cur)
  }
  return paths
}

function branchExists(repo: string, branch: string): boolean {
  return Bun.spawnSync(['git', '-C', repo, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`])
    .exitCode === 0
}

/**
 * A repo with `main` committed, plus (unless `withRemote` is false) a BARE origin
 * it can push to — `ls-remote` is the branch gate's evidence, so it has to be a
 * real remote.
 */
function makeRepo(opts: { withRemote?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'trident-wtclean-'))
  created.push(dir)
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'trident-test@neutron.local')
  git(repo, 'config', 'user.name', 'Trident Test')
  git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  writeFileSync(join(repo, '.gitignore'), 'ignored/\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  if (opts.withRemote !== false) {
    const origin = join(dir, 'origin.git')
    git(repo, 'init', '-q', '--bare', origin)
    git(repo, 'remote', 'add', 'origin', origin)
  }
  return repo
}

/** A build worktree on `BRANCH` with one commit — what a finished Forge leaves.
 *  `outside` puts it beside the repo instead of inside it (the only way to make a
 *  broken worktree's `git status` actually FAIL — from a path inside the repo git
 *  just walks up to the enclosing checkout). */
function addBuildWorktree(repo: string, branch = BRANCH, outside = false): string {
  const wt = outside
    ? join(repo, '..', `wt-${branch.replace(/\W/g, '_')}`)
    : join(repo, `.wt-${branch.replace(/\W/g, '_')}`)
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main')
  writeFileSync(join(wt, 'built.txt'), 'committed work\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-q', '-m', 'build')
  return wt
}

describe('worktree-cleanup.sh — a DIRTY worktree is PRESERVED (the #541 incident)', () => {
  test('UNTRACKED-ONLY work is preserved: exit 3, files intact, worktree still registered', () => {
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    // The #171 shape: brand-new files git has never seen. `git status` without
    // --untracked-files=all reports this tree as CLEAN.
    writeFileSync(join(wt, 'brand-new.ts'), 'export const lost = 197\n')

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(3)
    expect(res.out).toContain(`PRESERVED worktree ${wt} reason=dirty`)
    // The PATHS are printed — the operator must not have to guess what survived.
    expect(res.out).toContain('brand-new.ts')
    expect(res.out).toContain('RESULT preserved=')
    // Nothing was destroyed.
    expect(existsSync(join(wt, 'brand-new.ts'))).toBe(true)
    expect(Bun.file(join(wt, 'brand-new.ts')).text()).resolves.toContain('197')
    expect(worktreesFor(repo, BRANCH)).toEqual([wt])
    // …and the branch went with it (its commits are under the preserved tree).
    expect(branchExists(repo, BRANCH)).toBe(true)
    expect(res.out).toContain(`PRESERVED branch ${BRANCH} reason=worktree-preserved`)
    expect(res.out).not.toContain(`DELETED branch`)
  })

  test('a MODIFIED tracked file is preserved with its edit intact', () => {
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    writeFileSync(join(wt, 'built.txt'), 'edited, never committed\n')

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(3)
    expect(res.out).toContain('reason=dirty')
    expect(res.out).toContain('built.txt')
    expect(Bun.file(join(wt, 'built.txt')).text()).resolves.toBe('edited, never committed\n')
    expect(worktreesFor(repo, BRANCH)).toEqual([wt])
  })

  test('STAGED-but-uncommitted work is preserved', () => {
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    writeFileSync(join(wt, 'staged.ts'), 'staged\n')
    git(wt, 'add', 'staged.ts')

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(3)
    expect(existsSync(join(wt, 'staged.ts'))).toBe(true)
  })

  test('a worktree whose git status cannot be read at all is preserved, not removed', () => {
    const repo = makeRepo()
    const wt = addBuildWorktree(repo, BRANCH, true)
    // Break the worktree's link to the repo: `git status` now fails there. We
    // cannot prove the tree is clean, so it must survive.
    rmSync(join(wt, '.git'), { force: true })

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(3)
    expect(res.out).toContain(`PRESERVED worktree ${wt} reason=unverifiable`)
    expect(existsSync(join(wt, 'built.txt'))).toBe(true)
  })
})

describe('worktree-cleanup.sh — a CLEAN worktree is still removed', () => {
  test('clean tree: removed, exit 0, no worktree left on the branch', () => {
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)

    const res = run(repo, BRANCH, 'keep-branch')

    expect(res.code).toBe(0)
    expect(res.out).toContain(`REMOVED ${wt}`)
    expect(res.out).toContain('RESULT preserved=0 removed=1')
    expect(existsSync(wt)).toBe(false)
    expect(worktreesFor(repo, BRANCH)).toEqual([])
  })

  test('IGNORED files do not block removal (node_modules is not work)', () => {
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    mkdirSync(join(wt, 'ignored'))
    writeFileSync(join(wt, 'ignored', 'artifact.bin'), 'build output\n')

    const res = run(repo, BRANCH, 'keep-branch')

    expect(res.code).toBe(0)
    expect(existsSync(wt)).toBe(false)
  })

  test('the removal NEVER passes --force (git refuses a dirty tree as a second gate)', async () => {
    // The script's own CODE is the contract here: a future edit that reintroduces
    // `--force` on a remove would re-open #541 even if every behavioral test above
    // still passed (a `--force` remove of a CLEAN tree succeeds identically).
    // Comment lines are stripped — the header quotes the old command it replaced.
    const code = (await Bun.file(SCRIPT).text())
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    expect(code).toContain('worktree remove "$wt"')
    expect(code).not.toContain('--force')
  })

  test('a worktree whose directory is already gone is pruned, not reported', () => {
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    rmSync(wt, { recursive: true, force: true })

    const res = run(repo, BRANCH, 'keep-branch')

    expect(res.code).toBe(0)
    expect(res.out).toContain('RESULT preserved=0 removed=0')
    expect(worktreesFor(repo, BRANCH)).toEqual([])
  })

  test('no worktree on the branch at all is a clean no-op', () => {
    const repo = makeRepo()
    const res = run(repo, 'trident/never-built', 'keep-branch')
    expect(res.code).toBe(0)
    expect(res.out).toContain('RESULT preserved=0 removed=0')
  })

  test('a DIRTY worktree on a DIFFERENT branch is not even looked at', () => {
    const repo = makeRepo()
    const mine = addBuildWorktree(repo)
    const other = addBuildWorktree(repo, 'trident/other')
    writeFileSync(join(other, 'someone-elses.ts'), 'not mine\n')

    const res = run(repo, BRANCH, 'keep-branch')

    expect(res.code).toBe(0)
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(join(other, 'someone-elses.ts'))).toBe(true)
    expect(worktreesFor(repo, 'trident/other')).toEqual([other])
  })
})

describe('worktree-cleanup.sh — branch teardown is gated on the work being elsewhere', () => {
  test('delete-branch + clean tree + origin has the SAME sha → branch deleted, exit 0', () => {
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    git(wt, 'push', '-q', 'origin', BRANCH)

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(0)
    expect(res.out).toContain(`DELETED branch ${BRANCH}`)
    expect(branchExists(repo, BRANCH)).toBe(false)
    expect(existsSync(wt)).toBe(false)
  })

  test('delete-branch + commits NEVER pushed → branch KEPT, exit 3 (they exist nowhere else)', () => {
    const repo = makeRepo()
    addBuildWorktree(repo)

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(3)
    expect(res.out).toContain(`PRESERVED branch ${BRANCH} reason=not-on-origin`)
    expect(branchExists(repo, BRANCH)).toBe(true)
  })

  test('delete-branch + local AHEAD of origin → branch KEPT, exit 3', () => {
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    git(wt, 'push', '-q', 'origin', BRANCH)
    writeFileSync(join(wt, 'later.txt'), 'a commit that never got pushed\n')
    git(wt, 'add', '.')
    git(wt, 'commit', '-q', '-m', 'unpushed')

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(3)
    expect(res.out).toContain(`PRESERVED branch ${BRANCH} reason=unpushed`)
    expect(branchExists(repo, BRANCH)).toBe(true)
  })

  test('delete-branch with origin UNREACHABLE → branch KEPT, exit 3', () => {
    const repo = makeRepo({ withRemote: false })
    addBuildWorktree(repo)

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(3)
    expect(res.out).toContain(`PRESERVED branch ${BRANCH} reason=ls-remote-failed`)
    expect(branchExists(repo, BRANCH)).toBe(true)
  })

  test('keep-branch (LOCAL mode) never deletes the branch even when everything is clean', () => {
    // Local mode: this branch is the ONLY copy of the build and the OUTER loop
    // merges it. Deleting it here stranded every local-mode merge.
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)

    const res = run(repo, BRANCH, 'keep-branch')

    expect(res.code).toBe(0)
    expect(existsSync(wt)).toBe(false)
    expect(branchExists(repo, BRANCH)).toBe(true)
    expect(res.out).not.toContain('DELETED branch')
  })
})

describe('worktree-cleanup.sh — usage contract', () => {
  test('an unknown mode is a usage error (exit 2), and NOTHING is touched', () => {
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    const res = run(repo, BRANCH, 'force')
    expect(res.code).toBe(2)
    expect(existsSync(wt)).toBe(true)
  })

  test('a non-repo path is a usage error (exit 2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trident-wtclean-norepo-'))
    created.push(dir)
    expect(run(dir, BRANCH, 'keep-branch').code).toBe(2)
  })

  test('missing arguments are a usage error, never a silent success', () => {
    const p = Bun.spawnSync(['bash', SCRIPT])
    expect(p.exitCode).not.toBe(0)
  })
})
