import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const roots: string[] = []
const guard = new URL('./commit-with-resolved-head.sh', import.meta.url).pathname

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function run(cwd: string, command: string, args: string[]) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' })
}

function git(cwd: string, ...args: string[]): string {
  const result = run(cwd, 'git', args)
  expect(result.status, result.stderr || result.stdout).toBe(0)
  return result.stdout.trim()
}

function fixture(): { repo: string; tree: string; branch: string; parent: string } {
  const root = mkdtempSync(join(tmpdir(), 'trident-head-guard-'))
  roots.push(root)
  const repo = join(root, 'repo')
  const tree = join(root, 'tree')
  git(root, 'init', '-b', 'main', repo)
  git(repo, 'config', 'user.email', 'test@example.test')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, 'add', 'base.txt')
  git(repo, 'commit', '-m', 'base')
  const parent = git(repo, 'rev-parse', 'HEAD')
  const branch = 'trident/head-guard'
  git(repo, 'worktree', 'add', '-b', branch, tree, parent)
  writeFileSync(join(tree, 'change.txt'), 'change\n')
  git(tree, 'add', 'change.txt')
  return { repo, tree, branch, parent }
}

test('a dangling symbolic HEAD is refused before a commit object is created', () => {
  const { repo, tree, branch } = fixture()
  const looseBefore = git(repo, 'count-objects', '-v').match(/^count: (\d+)$/m)?.[1]
  expect(looseBefore).toBeDefined()
  git(repo, 'update-ref', '-d', `refs/heads/${branch}`)

  const result = run(tree, 'bash', [guard, branch, '-m', 'must not land'])

  expect(result.status).toBe(65)
  expect(result.stderr).toContain(`HEAD does not resolve for branch '${branch}'`)
  expect(result.stderr).toContain('git rev-parse --verify HEAD exited')
  expect(git(repo, 'count-objects', '-v').match(/^count: (\d+)$/m)?.[1]).toBe(looseBefore)
  expect(run(tree, 'git', ['rev-parse', '--verify', 'HEAD']).status).not.toBe(0)
})

test('a resolving HEAD still commits with the expected parent, and leaves no scratch file', () => {
  const { tree, branch, parent } = fixture()
  // The probe's stderr capture is a temp file cleaned by an EXIT trap -- which `exec` skips,
  // because exec REPLACES the shell. Pointing TMPDIR at a directory we own turns "did the
  // success path tidy up" into an assertion instead of a habit.
  const scratch = mkdtempSync(join(tmpdir(), 'trident-head-tmpdir-'))
  roots.push(scratch)

  const result = spawnSync('bash', [guard, branch, '-m', 'guarded commit'], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: scratch },
  })

  expect(result.status, result.stderr || result.stdout).toBe(0)
  const words = git(tree, 'rev-list', '--parents', '-1', 'HEAD').split(' ')
  expect(words).toHaveLength(2)
  expect(words[1]).toBe(parent)
  expect(readdirSync(scratch)).toEqual([])
})

// THE OTHER TWO ANSWERS, AND WHY THEY NEED A SHIM.
//
// The refusal exists to keep three facts apart: the query FAILED, the query SUCCEEDED and
// named nothing, and the query SUCCEEDED and named something that is not an object. Only the
// first is reachable from real git — the other two are what a broken or wrapped `git` on PATH
// does, and they were unpinned: collapsing `exit 66` into `exit 65` left the suite fully green.
// A distinction no test holds is a distinction the next refactor is free to drop.
//
// The shim answers `rev-parse` from the environment and RECORDS whether `commit` was reached,
// so each case proves the wrapper stopped rather than merely that it exited nonzero. The
// resolvable case is the control: it runs through the SAME shim and must still commit, so a
// shim that simply broke everything could not be mistaken for a working guard.
function withShimmedGit(headAnswer: string): { status: number | null; stderr: string; committed: boolean } {
  const root = mkdtempSync(join(tmpdir(), 'trident-head-shim-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const marker = join(root, 'commit-was-reached')
  const realGit = run(root, 'sh', ['-c', 'command -v git']).stdout.trim()
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\n` +
      `if [ "$1" = "rev-parse" ]; then printf '%s' "$SHIM_HEAD"; exit 0; fi\n` +
      `if [ "$1" = "commit" ]; then : > "${marker}"; exit 0; fi\n` +
      `exec ${realGit} "$@"\n`,
    { mode: 0o755 },
  )
  const result = spawnSync('bash', [guard, 'trident/shimmed', '-m', 'shimmed'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SHIM_HEAD: headAnswer },
  })
  return { status: result.status, stderr: result.stderr, committed: existsSync(marker) }
}

test('a HEAD query that succeeds and names NOTHING is refused, and not as a failed query', () => {
  const { status, stderr, committed } = withShimmedGit('')
  expect(status).toBe(66)
  expect(stderr).toContain('HEAD resolution returned no object')
  // The point of the case: it must NOT be reported as the query having failed.
  expect(stderr).not.toContain('HEAD does not resolve')
  expect(committed).toBe(false)
})

test('a HEAD query that succeeds and names a NON-OBJECT is refused as unexpected', () => {
  const { status, stderr, committed } = withShimmedGit('refs/heads/trident/shimmed')
  expect(status).toBe(67)
  expect(stderr).toContain('HEAD resolved unexpectedly')
  expect(stderr).toContain('refs/heads/trident/shimmed')
  expect(committed).toBe(false)
})

test('THE CONTROL: through the same shim, a resolvable HEAD still reaches the commit', () => {
  const { status, stderr, committed } = withShimmedGit('a'.repeat(40))
  expect(status, stderr).toBe(0)
  expect(committed).toBe(true)
})

test('a missing expected-branch argument is refused before any git call', () => {
  const root = mkdtempSync(join(tmpdir(), 'trident-head-noarg-'))
  roots.push(root)
  const result = spawnSync('bash', [guard], { cwd: root, encoding: 'utf8' })
  expect(result.status).toBe(64)
  expect(result.stderr).toContain('expected branch was not supplied')
})
