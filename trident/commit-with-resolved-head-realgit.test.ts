import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const roots: string[] = []
const guard = new URL('./commit-with-resolved-head.sh', import.meta.url).pathname
const hooks = new URL('../.githooks', import.meta.url).pathname

// Every git in this file -- the fixture's, the wrapper's, the shims' -- reads process.env, so
// pin the global and system config away here once: an operator whose ~/.gitconfig carries
// `commit.gpgsign=true` or a non-default `commit.cleanup` must not redden the strip, the
// gpg-count or the verbatim-cleanup tests locally while CI (a clean runner) stays green.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

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

test('a direct git commit that never saw the Forge prompt is refused by the installed hook', () => {
  const { repo, tree, branch } = fixture()
  git(repo, 'config', 'core.hooksPath', hooks)
  git(repo, 'update-ref', '-d', `refs/heads/${branch}`)

  const result = run(tree, 'git', ['commit', '-m', 'must not land'])

  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`commit refused: HEAD does not resolve for branch '${branch}'`)
  expect(run(tree, 'git', ['rev-parse', '--verify', 'HEAD']).status).not.toBe(0)
})

test('the installed hook allows an ordinary direct git commit', () => {
  const { repo, tree, parent } = fixture()
  git(repo, 'config', 'core.hooksPath', hooks)

  const result = run(tree, 'git', ['commit', '-m', 'ordinary direct commit'])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(git(tree, 'rev-list', '--parents', '-1', 'HEAD').split(' ')).toHaveLength(2)
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
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

// #1133 -- the wrapper is the one place every Forge commit passes through, so it is where
// "no loop-authored commit carries a `Claude-Session:` trailer" is enforced, whatever the
// model was told. These run the real script against real git: the trailer arrives exactly
// the way the CLI's attribution reminder makes the agent write it (its own `-m` paragraph),
// and the commit that lands must be the same single commit -- rebuilt in place from the
// object's own tree, parents, author and committer, Co-Authored-By byte-identical.
const CO_AUTHOR = 'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
const SESSION = 'Claude-Session: https://claude.ai/code/session_01TEST'

test("#1133: a Claude-Session trailer on the agent's message never reaches the commit", () => {
  const { tree, branch, parent } = fixture()

  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: subject', '-m', SESSION, '-m', CO_AUTHOR])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  const body = git(tree, 'log', '-1', '--format=%B')
  expect(body).not.toContain('Claude-Session')
  expect(body).toContain(CO_AUTHOR)
  expect(body.startsWith('feat: subject')).toBe(true)
  // One commit, rewritten in place: the parent is still the fixture's base commit, the
  // author survived the rewrite, and the tree is what the agent staged.
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%an')).toBe('Test')
  expect(git(tree, 'show', '--stat', '--format=', 'HEAD')).toContain('change.txt')
  // The strip REPLACES the commit, so git's `[branch sha] subject` line names a commit that
  // is no longer on the branch. The wrapper must name the commit that IS, in full, on stdout --
  // a Forge that copied the first line would trip the head-claim gate downstream.
  expect(result.stdout).toContain('HEAD is now')
  expect(result.stdout).toContain(git(tree, 'rev-parse', 'HEAD'))
})

test("#1133: --no-verify on the agent's commit cannot be undone by the strip (a refusing pre-commit hook cannot leave the trailer behind: the rebuild runs no hook)", () => {
  const { tree, branch, parent } = fixture()
  const refusing = mkdtempSync(join(tmpdir(), 'trident-head-refusing-hooks-'))
  roots.push(refusing)
  writeFileSync(join(refusing, 'pre-commit'), '#!/bin/sh\necho "hook refuses" >&2\nexit 1\n', { mode: 0o755 })
  git(tree, 'config', 'core.hooksPath', refusing)

  // Positive control: the hook really does refuse, so a commit WITHOUT --no-verify never
  // lands. Without this, a hooks dir git silently ignored would pass the assertion below.
  const refused = run(tree, 'bash', [guard, branch, '-m', 'refused'])
  expect(refused.status).not.toBe(0)
  expect(refused.stderr).toContain('hook refuses')
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)

  // The agent skipped the hook on its commit; the rebuild must not re-run it, or the commit
  // lands with the trailer still in it and the wrapper exits non-zero.
  const result = run(tree, 'bash', [guard, branch, '--no-verify', '-m', 'feat: subject', '-m', SESSION, '-m', CO_AUTHOR])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  const body = git(tree, 'log', '-1', '--format=%B')
  expect(body).not.toContain('Claude-Session')
  expect(body).toContain(CO_AUTHOR)
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(result.stdout).toContain(git(tree, 'rev-parse', 'HEAD'))
})

test('#1133: a session trailer that is NOT the last paragraph is still the only line removed', () => {
  const { tree, branch } = fixture()

  const result = run(tree, 'bash', [guard, branch, '-m', 'fix: middle', '-m', `${SESSION}\n${CO_AUTHOR}`, '-m', 'Refs #1133'])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  const body = git(tree, 'log', '-1', '--format=%B')
  expect(body).not.toContain('Claude-Session')
  expect(body).toContain(CO_AUTHOR)
  expect(body).toContain('Refs #1133')
  expect(body.startsWith('fix: middle')).toBe(true)
})

test('#1133: a message without the trailer is committed once and left untouched (no rewrite)', () => {
  const { tree, branch, parent } = fixture()

  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: plain', '-m', CO_AUTHOR])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  // Byte-equal to what git itself produces for the same -m arguments.
  expect(git(tree, 'log', '-1', '--format=%B')).toBe(`feat: plain\n\n${CO_AUTHOR}`)
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  // The strip path must be SKIPPED when there is nothing to strip: the branch reflog
  // holds the one commit and no strip entry.
  const reflog = git(tree, 'reflog', 'show', '--format=%gs', branch)
  expect(reflog).not.toContain('strip Claude-Session')
  expect(reflog.split('\n').filter((l) => l.startsWith('commit:'))).toHaveLength(1)
})

test("#1133: a failed commit propagates git's exit code, and nothing is rewritten", () => {
  const { tree, branch, parent } = fixture()
  git(tree, 'reset', '-q') // nothing staged -> git commit refuses
  const before = git(tree, 'rev-parse', 'HEAD')
  expect(before).toBe(parent)

  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: nothing staged', '-m', SESSION])

  expect(result.status).toBe(1)
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('base')
  expect(git(tree, 'reflog', 'show', '--format=%gs', branch)).not.toContain('strip Claude-Session')
})

test('#1133: the strip rewrites the MESSAGE only -- a pathspec commit does not absorb the other staged file', () => {
  const { tree, branch, parent } = fixture()
  writeFileSync(join(tree, 'second.txt'), 'second\n')
  git(tree, 'add', 'second.txt')

  // Positive control, plain git: a pathspec commit takes change.txt alone and leaves
  // second.txt staged. That commit's tree is exactly the tree the wrapper must land.
  expect(run(tree, 'git', ['commit', '-q', '-m', 'control', '--', 'change.txt']).status).toBe(0)
  const controlTree = git(tree, 'rev-parse', 'HEAD^{tree}')
  expect(git(tree, 'show', '--stat', '--format=', 'HEAD')).not.toContain('second.txt')
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('second.txt')
  git(tree, 'reset', '-q', '--soft', parent)

  // An amend without `--only` snapshotted the CURRENT index, so the strip folded second.txt
  // into the published commit with exit 0 and no marker; the rebuild reads no index at all.
  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: only change', '-m', SESSION, '-m', CO_AUTHOR, '--', 'change.txt'])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  const body = git(tree, 'log', '-1', '--format=%B')
  expect(body).not.toContain('Claude-Session')
  expect(body).toContain(CO_AUTHOR)
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(git(tree, 'rev-parse', 'HEAD^{tree}')).toBe(controlTree)
  expect(git(tree, 'show', '--stat', '--format=', 'HEAD')).not.toContain('second.txt')
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('second.txt')
})

// A guard that promises "no loop-authored commit carries the trailer" must fail CLOSED: the
// wrapper commits WITH the trailer and only then rebuilds it without, so a rebuild that
// fails for any reason must withdraw that commit rather than report an error and leave it
// on the branch, where the outer loop's publish would carry it to the PR.
test('#1133: a message that is only the trailer is refused and the trailer-bearing commit withdrawn (fail closed, real git)', () => {
  const { tree, branch, parent } = fixture()

  // A message that is ONLY the trailer strips to nothing. `commit-tree` would accept an
  // empty message, but `git commit` would not have without `--allow-empty-message`, so the
  // wrapper refuses exactly as git would (exit 1) and withdraws.
  const result = run(tree, 'bash', [guard, branch, '-m', SESSION])

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('could not be stripped')
  expect(result.stderr).toContain('was withdrawn')
  expect(result.stderr).toContain(`refs/heads/${branch} is back at ${parent}`)
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('base')
  // Forge can retry: the staged change is still staged, nothing was lost.
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('change.txt')
})

test('#1133: a rebuild that fails for ANY reason withdraws the commit and propagates the exit code (fail closed, shimmed commit-tree)', () => {
  const { tree, branch, parent } = fixture()
  const bin = mkdtempSync(join(tmpdir(), 'trident-head-rebuild-shim-'))
  roots.push(bin)
  const realGit = run(bin, 'sh', ['-c', 'command -v git']).stdout.trim()
  // Stands in for a signing or object-store failure: every git call is real EXCEPT `commit-tree`.
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\n` +
      `if [ "$1" = "commit-tree" ]; then echo "shim: commit-tree refused" >&2; exit 128; fi\n` +
      `exec ${realGit} "$@"\n`,
    { mode: 0o755 },
  )

  const result = spawnSync('bash', [guard, branch, '-m', 'feat: subject', '-m', SESSION, '-m', CO_AUTHOR], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  })

  expect(result.status).toBe(128)
  // The first commit DID land (the shim only refuses the rebuild) -- and was then withdrawn.
  expect(result.stderr).toContain('shim: commit-tree refused')
  expect(result.stderr).toContain('was withdrawn')
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('base')
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('change.txt')
  // Nothing with the trailer is reachable from the branch; the withdrawn commit survives
  // only in the reflog.
  expect(run(tree, 'git', ['log', '--format=%B', branch]).stdout).not.toContain('Claude-Session')
})

test('#1133: --allow-empty-message on the agent\'s commit is honoured by the strip', () => {
  const { tree, branch, parent } = fixture()

  // The same only-trailer message the fail-closed test refuses, now with the flag the agent
  // gave the first commit: the rebuild must honour it, or a commit git accepted is withdrawn.
  const result = run(tree, 'bash', [guard, branch, '--allow-empty-message', '-m', SESSION])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(result.stdout).toContain('HEAD is now')
})

test("#1133: an explicit --cleanup=<mode> on the agent's commit is what the rebuilt message keeps (the rebuild runs no cleanup of its own)", () => {
  const { tree, branch, parent } = fixture()

  // Positive control: under the default cleanup a `-m` paragraph loses its trailing spaces
  // on the FIRST commit, and the rebuild stores that cleaned message minus the trailer. (The
  // paragraph sits ABOVE Co-Authored-By so the spaces are interior to the body and the
  // helper's trim cannot eat them.)
  const control = run(tree, 'bash', [guard, branch, '-m', 'feat: v', '-m', 'trailing   ', '-m', SESSION, '-m', CO_AUTHOR])
  expect(control.status, control.stderr || control.stdout).toBe(0)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe(`feat: v\n\ntrailing\n\n${CO_AUTHOR}`)
  git(tree, 'reset', '-q', '--soft', parent)

  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: v', '-m', 'trailing   ', '-m', SESSION, '-m', CO_AUTHOR, '--cleanup=verbatim'])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  const body = git(tree, 'log', '-1', '--format=%B')
  expect(body).not.toContain('Claude-Session')
  expect(body).toContain(CO_AUTHOR)
  // Verbatim survived the rebuild: the trailing spaces the first commit stored are still there.
  expect(body).toContain('trailing   \n')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
})

test("#1133: a -m paragraph that begins with -S is a message, not a signing flag for the rebuild", () => {
  const { tree, branch, parent } = fixture()

  // A flag scan that cannot tell an option's VALUE from an option would read
  // `-Signed by hand` as `-S<keyid>`; the rebuild signs only when the object it rewrites is
  // signed, but a signed first commit would then be re-signed with a key id that is prose.
  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: s', '-m', '-Signed by hand', '-m', SESSION])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  const body = git(tree, 'log', '-1', '--format=%B')
  expect(body).not.toContain('Claude-Session')
  expect(body).toContain('-Signed by hand')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
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
      `if [ "$1" = "symbolic-ref" ]; then exit 1; fi\n` +
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

// The rewrite must be byte-exact except for the line it removes. These read the commit
// OBJECT back (`git cat-file commit`, one byte per latin1 char) rather than `git log`, so
// the assertions see the stored bytes and not a porcelain rendering of them.
function storedMessage(tree: string): string {
  const object = spawnSync('git', ['cat-file', 'commit', 'HEAD'], { cwd: tree, encoding: 'latin1' })
  expect(object.status, object.stderr).toBe(0)
  const headersEnd = object.stdout.indexOf('\n\n')
  expect(headersEnd).toBeGreaterThan(0)
  return object.stdout.slice(headersEnd + 2)
}

const latin1 = (utf8: string) => Buffer.from(utf8, 'utf8').toString('latin1')

test('#1133: the strip reads the raw object, not `git log` porcelain -- i18n.logOutputEncoding cannot re-encode the body', () => {
  const { tree, branch, parent } = fixture()
  git(tree, 'config', 'i18n.logOutputEncoding', 'ISO-8859-1')
  const subject = 'feat: café über'

  // Positive control: under that config `git log --format=%B` really does hand back a
  // re-encoded body (one latin1 byte per accented letter, not the two UTF-8 bytes the
  // object holds). A wrapper that read its message from there would store those bytes back.
  git(tree, 'commit', '-q', '-m', subject)
  const porcelain = spawnSync('git', ['log', '-1', '--format=%B'], { cwd: tree, encoding: 'latin1' })
  expect(porcelain.stdout).toContain('café über')
  expect(porcelain.stdout).not.toBe(latin1(subject) + '\n')
  expect(storedMessage(tree)).toBe(latin1(subject) + '\n')
  git(tree, 'reset', '-q', '--soft', parent)

  const result = run(tree, 'bash', [guard, branch, '-m', subject, '-m', `${SESSION}\n${CO_AUTHOR}`])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  // Exactly the bytes git stored for the first commit, minus the one trailer line.
  expect(storedMessage(tree)).toBe(latin1(`${subject}\n\n${CO_AUTHOR}\n`))
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
})

test('#1133: the filter is byte-safe -- a body that is not valid UTF-8 is not read as "binary" under a UTF-8 locale', () => {
  const { tree, branch, parent } = fixture()
  // A latin1 e-acute on its own is invalid UTF-8. With `i18n.commitEncoding` naming that
  // encoding, git stores the byte as is (and records the encoding on the object) instead of
  // transcoding it; the rebuild must carry that byte through untouched.
  git(tree, 'config', 'i18n.commitEncoding', 'ISO-8859-1')
  const bodyFile = join(tree, '..', 'message.txt')
  writeFileSync(bodyFile, Buffer.from(`fix: latin1\n\ncaf\xe9 body\n${SESSION}\n${CO_AUTHOR}\n`, 'latin1'))

  // Positive control: this host's grep, in the UTF-8 locale the test forces below, drops
  // the line holding the invalid byte and reports "binary file matches" in its place -- the
  // loss a text-mode filter would have baked into the amended message.
  const grepped = spawnSync('bash', ['-c', `LC_ALL=C.UTF-8 grep -v -e '^Claude-Session:' <"$0" 2>&1`, bodyFile], { encoding: 'latin1' })
  expect(grepped.stdout).not.toContain('caf\xe9 body')
  expect(grepped.stdout.toLowerCase()).toContain('binary')

  const result = spawnSync('bash', [guard, branch, '--cleanup=verbatim', '-F', bodyFile], {
    cwd: tree,
    encoding: 'latin1',
    env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' },
  })

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(storedMessage(tree)).toBe(`fix: latin1\n\ncaf\xe9 body\n${CO_AUTHOR}\n`)
  expect(spawnSync('git', ['cat-file', 'commit', 'HEAD'], { cwd: tree, encoding: 'latin1' }).stdout).toContain('\nencoding ISO-8859-1\n')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
})

test('#1133: the match is case-insensitive, as git trailer tokens are', () => {
  const { tree, branch, parent } = fixture()

  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: cased', '-m', `${CO_AUTHOR}\nclaude-session: https://claude.ai/code/session_01LOWER`])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(storedMessage(tree)).toBe(`feat: cased\n\n${CO_AUTHOR}\n`)
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
})

test('#1133: the rebuild stores the filtered bytes verbatim -- a config-level commit.cleanup is not overridden, and a missing final newline stays missing', () => {
  const { tree, branch, parent } = fixture()
  git(tree, 'config', 'commit.cleanup', 'verbatim')

  // Positive control: with that config and no --cleanup on argv, git keeps the trailing
  // spaces on the first commit. The rebuild must keep them too.
  const cleanup = run(tree, 'bash', [guard, branch, '-m', 'feat: v', '-m', 'trailing   ', '-m', SESSION, '-m', CO_AUTHOR])
  expect(cleanup.status, cleanup.stderr || cleanup.stdout).toBe(0)
  expect(storedMessage(tree)).toBe(`feat: v\n\ntrailing   \n\n${CO_AUTHOR}\n`)
  git(tree, 'reset', '-q', '--soft', parent)

  // The trailer in the MIDDLE of its paragraph is the only line removed; the paragraph's
  // other lines and the file's missing final newline are stored exactly as given.
  const bodyFile = join(tree, '..', 'no-final-newline.txt')
  writeFileSync(bodyFile, `feat: nl\n\n${CO_AUTHOR}\n${SESSION}\nRefs #1133`)
  const result = run(tree, 'bash', [guard, branch, '-F', bodyFile])
  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(storedMessage(tree)).toBe(`feat: nl\n\n${CO_AUTHOR}\nRefs #1133`)
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
})

// Round 11 (#1133). bash 3.2 is not installed on CI or on this host, so no real-git test above
// can see a bash-4-only construct: the script would run green here and die on stock macOS
// with `bad substitution` AFTER `git commit` landed and BEFORE the fail-closed withdrawal --
// on every wrapped commit. This static guard is what goes red if one returns; the
// case-insensitivity test above stays the behavioural guard for the bracket pattern that
// replaced `${x,,}`.
const BASH4_ONLY = /\$\{[^}]*(,,|\^\^|@[A-Za-z])\}|\bmapfile\b|\breadarray\b|declare -A|\[\[ -v /

test('#1133: the wrapper uses no bash-4-only construct (it must run on the bash 3.2 of stock macOS)', () => {
  // Positive control: the regex recognises the construct round 10 shipped.
  expect(BASH4_ONLY.test('case "${lines[i],,}" in')).toBe(true)
  expect(BASH4_ONLY.test('echo "${x^^}"')).toBe(true)
  expect(BASH4_ONLY.test('declare -A map')).toBe(true)

  const script = readFileSync(guard, 'utf8')
  expect(script).toContain('strip_session_trailer() {') // the right file was read
  expect(script.match(BASH4_ONLY)).toBeNull()
})

// A shim that is real git for everything except the one subcommand it fails, standing in for
// a corrupt object store, a permission error, or a ref lock; `failures` maps subcommand -> exit.
function shimmedGitFailing(failures: Record<string, number>): string {
  const bin = mkdtempSync(join(tmpdir(), 'trident-head-fault-shim-'))
  roots.push(bin)
  const realGit = run(bin, 'sh', ['-c', 'command -v git']).stdout.trim()
  const arms = Object.entries(failures)
    .map(([sub, code]) => `if [ "$1" = "${sub}" ]; then echo "shim: ${sub} refused" >&2; exit ${code}; fi\n`)
    .join('')
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${arms}exec ${realGit} "$@"\n`, { mode: 0o755 })
  return bin
}

test('#1133: a read-back that fails withdraws the commit (fail closed on the cat-file path, single fault)', () => {
  const { tree, branch, parent } = fixture()
  const bin = shimmedGitFailing({ 'cat-file': 3 })

  const result = spawnSync('bash', [guard, branch, '-m', 'feat: subject', '-m', SESSION, '-m', CO_AUTHOR], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  })

  expect(result.status).toBe(3)
  expect(result.stderr).toContain('shim: cat-file refused')
  expect(result.stderr).toContain('could not be read back')
  expect(result.stderr).toContain('was withdrawn')
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('change.txt')
  expect(run(tree, 'git', ['log', '--format=%B', branch]).stdout).not.toContain('Claude-Session')
})

test('#1133: a read-back that fails AND a withdrawal that fails is reported as the commit remaining, never as withdrawn (double fault)', () => {
  const { tree, branch, parent } = fixture()
  const bin = shimmedGitFailing({ 'cat-file': 3, 'update-ref': 9 })

  const result = spawnSync('bash', [guard, branch, '-m', 'feat: subject', '-m', SESSION, '-m', CO_AUTHOR], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  })

  expect(result.status).toBe(3)
  expect(result.stderr).toContain('shim: update-ref refused')
  expect(result.stderr).toContain('could not be withdrawn')
  expect(result.stderr).toContain('carries the trailer if the message had one')
  expect(result.stderr).not.toContain('was withdrawn')
  // The truth the message states: the commit really is still on the branch, trailer and all.
  expect(git(tree, 'rev-parse', 'HEAD')).not.toBe(parent)
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B')).toContain(SESSION)
})

test('#1133: a withdrawal after a merge in progress names the sequencer state it cannot restore (MERGE_HEAD is gone)', () => {
  const { repo, tree, branch, parent } = fixture()
  // A second branch to merge from, made in the main worktree so `tree` stays on the guarded branch.
  git(repo, 'branch', 'side', parent)
  git(repo, 'checkout', '-q', 'side')
  writeFileSync(join(repo, 'side.txt'), 'side\n')
  git(repo, 'add', 'side.txt')
  git(repo, 'commit', '-q', '-m', 'side')
  git(repo, 'checkout', '-q', 'main')
  git(tree, 'reset', '-q')
  rmSync(join(tree, 'change.txt'))
  git(tree, 'merge', '-q', '--no-commit', '--no-ff', 'side')
  // Positive control: the merge really is in progress before the wrapper runs.
  expect(run(tree, 'git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status).toBe(0)
  const bin = shimmedGitFailing({ 'commit-tree': 128 })

  const result = spawnSync('bash', [guard, branch, '-m', 'merge: side', '-m', SESSION], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  })

  expect(result.status).toBe(128)
  expect(result.stderr).toContain('was withdrawn')
  expect(result.stderr).toContain('is not restored')
  expect(result.stderr).toContain('MERGE_HEAD')
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)
  // The measured truth the sentence states: the merge the withdrawn commit concluded is gone,
  // while the merged tree is still staged for the retry.
  expect(run(tree, 'git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status).not.toBe(0)
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('side.txt')
})

test('#1133: a cluster of short options ending in -m (-am) hides its message from the flag scan', () => {
  const { tree, branch, parent } = fixture()

  // `-am <msg>` is one argv element the scan must read as `-a -m`: the paragraph beginning
  // `-S` is the VALUE of that -m, not a signing flag for the rebuild.
  const result = run(tree, 'bash', [guard, branch, '-am', `-Signed by hand\n\n${SESSION}`])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  const body = git(tree, 'log', '-1', '--format=%B')
  expect(body).not.toContain('Claude-Session')
  expect(body).toContain('-Signed by hand')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
})

test('#1133: an attached option value (-F<file>) is not a cluster -- an empty commit with the trailer in its -F file is rebuilt empty', () => {
  const { tree, branch, parent } = fixture()
  git(tree, 'reset', '-q') // nothing staged: the commit needs --allow-empty; the rebuild reads no index
  const bodyFile = join(tree, '..', 'attached.txt')
  writeFileSync(bodyFile, `feat: attached\n\n${SESSION}\n`)

  // A scan that read `-F<file>` as a cluster ending in a value-taking letter would skip
  // `--allow-empty` as its value. The rebuild needs no such flag (commit-tree takes the
  // object's own tree), so this pins that an attached value is not read as a cluster AND
  // that an empty commit is rebuilt as the same empty commit.
  const result = run(tree, 'bash', [guard, branch, `-F${bodyFile}`, '--allow-empty'])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('feat: attached')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
})

// A stand-in `gpg.program`: it answers the way git's gpg-interface expects (a
// `[GNUPG:] SIG_CREATED` status line on fd 2, the signature on stdout) and records the key
// id it was asked to sign with, so a test can tell WHICH commit was signed and with what
// key. No real key material, no gpg on PATH needed.
function fakeGpg(): { program: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'trident-head-fakegpg-'))
  roots.push(root)
  const program = join(root, 'gpg')
  const log = join(root, 'signed.log')
  writeFileSync(
    program,
    `#!/bin/sh\n` +
      `cat >/dev/null\n` +
      `echo "$*" >> "${log}"\n` +
      `printf '\\n[GNUPG:] SIG_CREATED D 1 8 00 1700000000 FAKEFINGERPRINT\\n' >&2\n` +
      `printf -- '-----BEGIN PGP SIGNATURE-----\\nfake\\n-----END PGP SIGNATURE-----\\n'\n`,
    { mode: 0o755 },
  )
  writeFileSync(log, '')
  return { program, log }
}

function gpgsigHeaders(tree: string, rev: string): number {
  return git(tree, 'cat-file', 'commit', rev).split('\n').filter((line) => line.startsWith('gpgsig ')).length
}

test('#1133: a signing letter inside a short-flag cluster (-aS) is forwarded, so the stripped commit is still signed', () => {
  const { tree, branch, parent } = fixture()
  const { program, log } = fakeGpg()
  git(tree, 'config', 'gpg.program', program)
  git(tree, 'config', 'user.signingkey', 'CLUSTERKEY')
  writeFileSync(join(tree, 'change.txt'), 'changed again\n') // -a has something to pick up

  // Positive control: the standalone form the scan already forwards. Signed once for the
  // first commit and once for the rebuild, and the commit on the branch carries the signature.
  const control = run(tree, 'bash', [guard, branch, '-a', '-S', '-m', 'feat: control', '-m', SESSION])
  expect(control.status, control.stderr || control.stdout).toBe(0)
  expect(gpgsigHeaders(tree, 'HEAD')).toBe(1)
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['--status-fd=2 -bsau CLUSTERKEY', '--status-fd=2 -bsau CLUSTERKEY'])
  git(tree, 'reset', '-q', '--soft', parent)
  writeFileSync(log, '')

  // Git reads `-aS` as `-a -S`: the first commit is signed. The rebuild signs because the
  // object is signed; a scan that only knows the standalone `-S` would sign with the
  // configured default key instead of the one argv named.
  const result = run(tree, 'bash', [guard, branch, '-aS', '-m', 'feat: clustered', '-m', SESSION])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  const body = git(tree, 'log', '-1', '--format=%B')
  expect(body).toBe('feat: clustered')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(gpgsigHeaders(tree, 'HEAD')).toBe(1)
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['--status-fd=2 -bsau CLUSTERKEY', '--status-fd=2 -bsau CLUSTERKEY'])
})

test('#1133: a clustered signing letter with an attached key id (-sSkey) forwards that key, and a value-taking letter before S (-mS) is not a signing flag', () => {
  const { tree, branch, parent } = fixture()
  const { program, log } = fakeGpg()
  git(tree, 'config', 'gpg.program', program)
  git(tree, 'config', 'user.signingkey', 'DEFAULTKEY')

  // `-sSARGVKEY` is `-s -SARGVKEY`: signoff, then sign with the key attached to the S. The
  // rebuild must sign with THAT key, not fall back to user.signingkey.
  const signed = run(tree, 'bash', [guard, branch, '-sSARGVKEY', '-m', 'feat: keyed', '-m', SESSION])
  expect(signed.status, signed.stderr || signed.stdout).toBe(0)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('feat: keyed\n\nSigned-off-by: Test <test@example.test>')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(gpgsigHeaders(tree, 'HEAD')).toBe(1)
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['--status-fd=2 -bsau ARGVKEY', '--status-fd=2 -bsau ARGVKEY'])
  git(tree, 'reset', '-q', '--soft', parent)
  writeFileSync(log, '')

  // `-mS` is `-m S`: the S is the message, not a signing flag. Nothing is signed, nothing
  // is forwarded, and the trailer paragraph after it is still stripped.
  const unsigned = run(tree, 'bash', [guard, branch, '-mS', '-m', SESSION])
  expect(unsigned.status, unsigned.stderr || unsigned.stdout).toBe(0)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('S')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(gpgsigHeaders(tree, 'HEAD')).toBe(0)
  expect(readFileSync(log, 'utf8')).toBe('')
})

// Round 13 (#1133). A shim that is real git except that the Nth `<sub>` it is asked for
// runs `arm` first (refuse, answer nothing, or land a commit of its own). The wrapper's FIRST
// rev-parse is the pre-commit probe and its SECOND the post-commit re-probe of the captured
// ref (there is no third: the compare-and-swap publish IS the post-condition on the ref), so
// N=2 faults exactly the re-probe and the commit has really landed by then. Its FIRST
// cat-file reads the commit it made, its SECOND the rebuilt candidate.
// The count file is the positive control: it must read N afterwards, proving the probe
// passed through the same shim and the fault hit the call it was aimed at. (git runs its own
// subcommands from GIT_EXEC_PATH, not PATH, so no internal call of git's own ever reaches
// this shim: a pass-through run counts exactly the wrapper's own.) `arm` sees REAL_GIT.
function shimmedGitFailingNth(sub: string, nth: number, arm: string, extra: Record<string, number> = {}): { bin: string; count: string } {
  const bin = mkdtempSync(join(tmpdir(), 'trident-head-nth-shim-'))
  roots.push(bin)
  const realGit = run(bin, 'sh', ['-c', 'command -v git']).stdout.trim()
  const count = join(bin, `${sub}.count`)
  const extraArms = Object.entries(extra)
    .map(([extraSub, code]) => `if [ "$1" = "${extraSub}" ]; then echo "shim: ${extraSub} refused" >&2; exit ${code}; fi\n`)
    .join('')
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\n` +
      `REAL_GIT=${realGit}\n` +
      `if [ "$1" = "${sub}" ]; then\n` +
      `  n=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${count}"\n` +
      `  if [ "$n" -eq ${nth} ]; then ${arm}; fi\n` +
      `fi\n` +
      `${extraArms}exec ${realGit} "$@"\n`,
    { mode: 0o755 },
  )
  return { bin, count }
}

function shimmedGitFailingNthRevParse(nth: number, arm: string, extra: Record<string, number> = {}): { bin: string; count: string } {
  return shimmedGitFailingNth('rev-parse', nth, arm, extra)
}

function runGuardWithShim(tree: string, branch: string, bin: string) {
  return spawnSync('bash', [guard, branch, '-m', 'feat: subject', '-m', SESSION, '-m', CO_AUTHOR], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  })
}

// Lands one more commit on the branch from INSIDE a shim arm -- another writer advancing the
// ref between the wrapper's commit and its next git call. Real git, so the shim's own count
// is not disturbed.
const CONCURRENT = 'concurrent advance by another writer'
const CONCURRENT_ARM = `$REAL_GIT commit -q --allow-empty --no-verify -m "${CONCURRENT}"`

function subjects(tree: string, branch: string): string[] {
  return git(tree, 'log', '--format=%s', branch).split('\n')
}

test('#1133: THE CONTROL for the counting shim: with no fault armed, the wrapper makes exactly two rev-parse calls and strips the trailer', () => {
  const { tree, branch, parent } = fixture()
  const { bin, count } = shimmedGitFailingNthRevParse(0, 'exit 5')

  const result = runGuardWithShim(tree, branch, bin)

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe(`feat: subject\n\n${CO_AUTHOR}`)
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  // Probe, re-probe: the second one is the post-commit re-probe of the captured ref. The
  // publish is a compare-and-swap against the object that re-probe named, so nothing is
  // re-read afterwards.
  expect(readFileSync(count, 'utf8').trim()).toBe('2')
})

test('#1133: a post-commit HEAD re-probe that FAILS is refused WITHOUT rewriting the branch (fail closed, no blind reset; second rev-parse only)', () => {
  const { tree, branch, parent } = fixture()
  const { bin, count } = shimmedGitFailingNthRevParse(2, 'echo "shim: rev-parse refused" >&2; exit 5')

  const result = runGuardWithShim(tree, branch, bin)

  expect(result.status).toBe(69)
  expect(result.stderr).toContain('shim: rev-parse refused')
  expect(result.stderr).toContain('could not be re-read')
  expect(result.stderr).toContain('exited 5')
  expect(result.stderr).toContain('was NOT reset')
  expect(result.stderr).toContain(`is on refs/heads/${branch} and carries the trailer if the message had one`)
  expect(result.stderr).not.toContain('may carry')
  expect(result.stderr).not.toContain('was withdrawn')
  // The pre-commit probe's own refusal (exit 65) never fired: the fault hit the re-probe.
  expect(result.stderr).not.toContain('HEAD does not resolve')
  // With no readable value there is nothing to compare against, so the wrapper refuses and
  // touches nothing: the commit it made is exactly where git put it, trailer and all, and
  // the caller is told so, naming the ref. The index was consumed by that commit and is clean.
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B')).toContain(SESSION)
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('')
  expect(readFileSync(count, 'utf8').trim()).toBe('2')
})

test('#1133: a post-commit HEAD re-probe that succeeds and names NOTHING is refused, distinctly from a failed re-probe, and rewrites nothing', () => {
  const { tree, branch, parent } = fixture()
  const { bin, count } = shimmedGitFailingNthRevParse(2, 'exit 0')

  const result = runGuardWithShim(tree, branch, bin)

  expect(result.status).toBe(70)
  expect(result.stderr).toContain('named no object')
  expect(result.stderr).toContain('was NOT reset')
  expect(result.stderr).not.toContain('was withdrawn')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B')).toContain(SESSION)
  expect(readFileSync(count, 'utf8').trim()).toBe('2')
})

// Round 14 (#1133). The withdrawal is a compare-and-swap, never a blind `reset --soft`. Each
// test below first lands a commit from ANOTHER writer between the wrapper's commit and the
// git call that fails, and asserts that commit survives: a blind reset withdrew whatever HEAD
// named, the other writer's commit included (measured on the round-13 script: `git log` after
// the reset showed only the base).

test('#1133: a failed re-probe never rewrites the branch -- a commit another writer landed in the gap survives', () => {
  const { tree, branch, parent } = fixture()
  const { bin, count } = shimmedGitFailingNthRevParse(2, `${CONCURRENT_ARM}; echo "shim: rev-parse refused" >&2; exit 128`)

  const result = runGuardWithShim(tree, branch, bin)

  expect(result.status).toBe(69)
  expect(result.stderr).toContain('was NOT reset')
  expect(result.stderr).not.toContain('was withdrawn')
  // Both commits are still on the branch, in order, on top of the fixture's base.
  expect(subjects(tree, branch)).toEqual([CONCURRENT, 'feat: subject', 'base'])
  expect(git(tree, 'rev-parse', `${branch}^^`)).toBe(parent)
  expect(readFileSync(count, 'utf8').trim()).toBe('2')
})

test('#1133: a HEAD that became a dangling symref after the commit neither conjures the missing branch nor stops the strip -- the CAPTURED ref is rewritten', () => {
  const { tree, branch, parent } = fixture()
  // The measured hazard: after the agent's commit HEAD points at a branch that does not
  // exist. Round 13's `git reset --soft <probed>` SUCCEEDED by creating that branch at the
  // probed oid while the real branch kept the trailer commit; round 14 refused (exit 69)
  // and left the trailer on the branch. The wrapper now reads and rewrites the ref it
  // captured BEFORE the commit, so where HEAD points afterwards does not matter.
  const { bin, count } = shimmedGitFailingNthRevParse(2, '$REAL_GIT symbolic-ref HEAD refs/heads/orphan')

  const result = runGuardWithShim(tree, branch, bin)

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(result.stdout).toContain(`refs/heads/${branch} moved from`)
  expect(run(tree, 'git', ['rev-parse', '--verify', '-q', 'refs/heads/orphan']).status).not.toBe(0)
  expect(git(tree, 'rev-parse', `${branch}^`)).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B', branch)).toBe(`feat: subject\n\n${CO_AUTHOR}`)
  expect(readFileSync(count, 'utf8').trim()).toBe('2')
})

test('#1133: a read-back that fails withdraws by compare-and-swap -- a commit another writer landed first is refused, not reset away', () => {
  const { tree, branch, parent } = fixture()
  const { bin, count } = shimmedGitFailingNth('cat-file', 1, `${CONCURRENT_ARM}; echo "shim: cat-file refused" >&2; exit 3`)

  const result = runGuardWithShim(tree, branch, bin)

  expect(result.status).toBe(3)
  expect(result.stderr).toContain('shim: cat-file refused')
  expect(result.stderr).toContain('could not be withdrawn')
  expect(result.stderr).toContain('nothing was rewritten')
  expect(result.stderr).toContain('carries the trailer if the message had one')
  expect(result.stderr).not.toContain('was withdrawn')
  expect(subjects(tree, branch)).toEqual([CONCURRENT, 'feat: subject', 'base'])
  expect(git(tree, 'rev-parse', `${branch}^^`)).toBe(parent)
  expect(readFileSync(count, 'utf8').trim()).toBe('1')
})

test('#1133: a rebuild that fails withdraws by compare-and-swap -- a commit another writer landed first is refused, not reset away', () => {
  const { tree, branch, parent } = fixture()
  const { bin } = shimmedGitFailingNth('commit-tree', 1, `${CONCURRENT_ARM}; echo "shim: commit-tree refused" >&2; exit 128`)

  const result = runGuardWithShim(tree, branch, bin)

  expect(result.status).toBe(128)
  expect(result.stderr).toContain('shim: commit-tree refused')
  expect(result.stderr).toContain('could not be withdrawn')
  expect(result.stderr).toContain('nothing was rewritten')
  expect(result.stderr).toContain('WITH the trailer')
  expect(result.stderr).not.toContain('was withdrawn')
  expect(subjects(tree, branch)).toEqual([CONCURRENT, 'feat: subject', 'base'])
  expect(git(tree, 'rev-parse', `${branch}^^`)).toBe(parent)
})

// Round 14 (#1133) measured the strip's post-condition after an amend, because `--no-verify`
// skips pre-commit and commit-msg only and a `prepare-commit-msg` hook still ran on the
// amend and put the trailer straight back. Round 15 removed the amend: the stripped commit
// is built with `commit-tree`, on which no hook of any kind runs, so the hook cannot fire
// on the rewrite at all. The positive control below stays, to show the hook IS live on a
// plain `--amend --no-verify`.

function trailerRestoringHooks(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trident-head-restoring-hooks-'))
  roots.push(dir)
  writeFileSync(join(dir, 'prepare-commit-msg'), `#!/bin/sh\nprintf '\\n%s\\n' '${SESSION}' >> "$1"\n`, { mode: 0o755 })
  return dir
}

test('#1133: a prepare-commit-msg hook that put the trailer back on the amend cannot reach the rebuild -- exit 0 and the branch is clean', () => {
  const { tree, branch, parent } = fixture()
  git(tree, 'config', 'core.hooksPath', trailerRestoringHooks())

  // Positive control, measured on plain git: a `--no-verify` amend still runs the hook, so
  // the message it stores carries the trailer the -F file did not have.
  git(tree, 'commit', '-q', '--no-verify', '-m', 'control')
  const clean = join(tree, '..', 'clean-message.txt')
  writeFileSync(clean, 'control\n')
  git(tree, 'commit', '--amend', '--only', '--no-verify', '--cleanup=verbatim', '-q', '-F', clean)
  expect(git(tree, 'log', '-1', '--format=%B')).toContain(SESSION)
  git(tree, 'reset', '-q', '--soft', parent)

  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: subject', '-m', CO_AUTHOR])

  // Round 13 exited 0 with the trailer on the branch; round 14 caught it and withdrew with
  // exit 73 (the agent's commit was lost to the hook). Now the hook fires once, on the
  // agent's commit, and the rebuilt commit is exactly that commit minus the line it added.
  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(result.stdout).toContain('trailer stripped')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe(`feat: subject\n\n${CO_AUTHOR}`)
  expect(run(tree, 'git', ['log', '--format=%B', branch]).stdout).not.toContain('Claude-Session')
})

test('#1133: a candidate read-back that fails withdraws the trailer commit by compare-and-swap and references the candidate by nothing (second cat-file only)', () => {
  const { tree, branch, parent } = fixture()
  const { bin, count } = shimmedGitFailingNth('cat-file', 2, 'echo "shim: cat-file refused" >&2; exit 4')

  const result = runGuardWithShim(tree, branch, bin)

  expect(result.status).toBe(4)
  expect(result.stderr).toContain('shim: cat-file refused')
  expect(result.stderr).toContain('to verify the Claude-Session strip')
  expect(result.stderr).toContain('was withdrawn')
  expect(result.stderr).toContain('referenced by nothing')
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('change.txt')
  expect(run(tree, 'git', ['log', '--format=%B', branch]).stdout).not.toContain('Claude-Session')
  expect(readFileSync(count, 'utf8').trim()).toBe('2')
  // The candidate was built (it is a real object) and nothing names it.
  const candidate = result.stderr.match(/the rebuilt commit ([0-9a-f]{40})/)?.[1]
  expect(candidate).toBeDefined()
  expect(git(tree, 'cat-file', '-t', candidate!)).toBe('commit')
  expect(git(tree, 'for-each-ref', '--points-at', candidate!)).toBe('')
})

// Round 15 (#1133). The wrapper acts on the REF it committed on and the OBJECT it created,
// never on "whatever HEAD names now". Each test below is one mode of the reviewer's
// adversarial fixture: another writer, a hook, or a branch switch between the agent's
// commit and the strip. The rewrite is `commit-tree` + a compare-and-swap `update-ref`;
// the CAS's expected-value argument is the nominated mutation (drop it and the swap goes
// blind: the lost-swap test below sees exit 0 and the other writer's commit gone).

function readBack(tree: string, rev: string): string {
  return git(tree, 'cat-file', 'commit', rev)
}

test('#1133: a commit another writer landed on top BEFORE the re-probe is recognised by its parent and refused without any rewrite (exit 76)', () => {
  const { tree, branch, parent } = fixture()
  const { bin, count } = shimmedGitFailingNthRevParse(2, CONCURRENT_ARM)

  const result = runGuardWithShim(tree, branch, bin)

  // The ref now names the other writer's commit, whose first parent is the wrapper's
  // commit, not the probed HEAD. Round 14 read that commit as its own and stripped it
  // (exit 73 when it carried a trailer, both commits withdrawn). Nothing is touched now.
  expect(result.status).toBe(76)
  expect(result.stderr).toContain('made by another writer')
  expect(result.stderr).toContain('nothing was rewritten and nothing was withdrawn')
  expect(result.stderr).toContain('carries the trailer if the message had one')
  expect(result.stdout).not.toContain('trailer stripped')
  expect(subjects(tree, branch)).toEqual([CONCURRENT, 'feat: subject', 'base'])
  expect(git(tree, 'rev-parse', `${branch}^^`)).toBe(parent)
  // The truth stderr states: the wrapper's own commit is still there, trailer and all.
  expect(git(tree, 'log', '-1', '--format=%B', `${branch}^`)).toContain(SESSION)
  expect(git(tree, 'log', '-1', '--format=%B', branch)).toBe(CONCURRENT)
  expect(readFileSync(count, 'utf8').trim()).toBe('2')
})

test('#1133: a commit another writer landed INSIDE the read-back loses the publish compare-and-swap: exit 74, both commits survive, the candidate is referenced by nothing', () => {
  const { tree, branch, parent } = fixture()

  // Positive control: the same counting shim with no arm lands the stripped commit.
  const control = shimmedGitFailingNth('cat-file', 0, CONCURRENT_ARM)
  const clean = runGuardWithShim(tree, branch, control.bin)
  expect(clean.status, clean.stderr || clean.stdout).toBe(0)
  expect(subjects(tree, branch)).toEqual(['feat: subject', 'base'])
  expect(git(tree, 'log', '-1', '--format=%B')).toBe(`feat: subject\n\n${CO_AUTHOR}`)
  expect(readFileSync(control.count, 'utf8').trim()).toBe('2')
  git(tree, 'reset', '-q', '--soft', parent)

  // The other writer lands between the wrapper's read of its own commit and the swap. The
  // amend at this point rewrote THEIR commit's message over their tree (round 14); the CAS
  // names the exact object it read and is refused.
  const { bin, count } = shimmedGitFailingNth('cat-file', 1, CONCURRENT_ARM)
  const result = runGuardWithShim(tree, branch, bin)

  expect(result.status).toBe(74)
  expect(result.stderr).toContain('moved while the Claude-Session strip was being built')
  expect(result.stderr).toContain('nothing was rewritten and nothing was withdrawn')
  expect(result.stderr).toContain('referenced by nothing')
  expect(result.stdout).not.toContain('trailer stripped')
  expect(subjects(tree, branch)).toEqual([CONCURRENT, 'feat: subject', 'base'])
  expect(git(tree, 'rev-parse', `${branch}^^`)).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B', `${branch}^`)).toContain(SESSION)
  // stderr names all three objects: the candidate (built, unreferenced), the wrapper's own
  // commit (still reachable, with the trailer) and what the ref names now.
  const candidate = result.stderr.match(/the stripped commit ([0-9a-f]{40}) was built/)?.[1]
  expect(candidate).toBeDefined()
  expect(git(tree, 'cat-file', '-t', candidate!)).toBe('commit')
  expect(git(tree, 'for-each-ref', '--points-at', candidate!)).toBe('')
  expect(readBack(tree, candidate!)).not.toContain('Claude-Session')
  expect(result.stderr).toContain(`the commit ${git(tree, 'rev-parse', `${branch}^`)} this invocation created`)
  expect(result.stderr).toContain(`now names ${git(tree, 'rev-parse', branch)}`)
  expect(readFileSync(count, 'utf8').trim()).toBe('2')
})

test('#1133: a branch switch after the commit cannot redirect the withdrawal -- the CAPTURED branch is withdrawn and the other branch left alone', () => {
  const { tree, branch, parent } = fixture()
  // The reviewer's `switched-before-withdraw` mode: inside the read-back, HEAD is moved
  // to a new branch at the same commit, then the read-back fails. Round 14 withdrew
  // `HEAD`, i.e. rolled back the WRONG branch while the original kept the trailer.
  const { bin, count } = shimmedGitFailingNth('cat-file', 1, '$REAL_GIT checkout -q -b other HEAD; echo "shim: cat-file refused" >&2; exit 8')

  const result = runGuardWithShim(tree, branch, bin)

  expect(result.status).toBe(8)
  expect(result.stderr).toContain('shim: cat-file refused')
  expect(result.stderr).toContain(`was withdrawn, refs/heads/${branch} is back at ${parent}`)
  expect(git(tree, 'rev-parse', branch)).toBe(parent)
  // `other` is where the switch left it: at the trailer commit, which is not the wrapper's
  // ref and not its business. HEAD still points there.
  expect(git(tree, 'symbolic-ref', 'HEAD')).toBe('refs/heads/other')
  expect(git(tree, 'rev-parse', 'other^')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B', 'other')).toContain(SESSION)
  expect(run(tree, 'git', ['log', '--format=%B', branch]).stdout).not.toContain('Claude-Session')
  expect(readFileSync(count, 'utf8').trim()).toBe('1')
})

// The reviewer's `hook-clean-followup` mode: a prepare-commit-msg hook that re-adds the
// trailer whenever it is missing, plus a post-commit hook that lands a clean follow-up
// commit on its Nth firing. `nested` keeps the follow-up from re-triggering either hook.
function followupHooks(fireOn: number): { dir: string; count: string } {
  const dir = mkdtempSync(join(tmpdir(), 'trident-head-followup-hooks-'))
  roots.push(dir)
  const count = join(dir, 'post-commit.count')
  writeFileSync(
    join(dir, 'prepare-commit-msg'),
    `#!/bin/sh\nif [ -z "$HOOK_NESTED" ] && ! grep -q '^Claude-Session:' "$1"; then printf '\\n%s\\n' '${SESSION}' >> "$1"; fi\n`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(dir, 'post-commit'),
    `#!/bin/sh\n` +
      `if [ -n "$HOOK_NESTED" ]; then exit 0; fi\n` +
      `n=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${count}"\n` +
      `if [ "$n" -eq ${fireOn} ]; then HOOK_NESTED=1 git commit -q --allow-empty -m 'legitimate followup'; fi\n`,
    { mode: 0o755 },
  )
  return { dir, count }
}

test('#1133: a post-commit hook that fired on the amend no longer fires -- the rebuild runs no hook, exit 0 and nothing reachable carries the trailer', () => {
  const { tree, branch, parent } = fixture()
  const { dir, count } = followupHooks(2)
  git(tree, 'config', 'core.hooksPath', dir)

  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: subject', '-m', CO_AUTHOR])

  // Round 14: the amend re-ran prepare-commit-msg (trailer back) AND post-commit (second
  // firing, follow-up landed on top), the wrapper's read-back saw the clean follow-up at
  // HEAD and exited 0 with its own trailer commit as the follow-up's parent.
  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(readFileSync(count, 'utf8').trim()).toBe('1')
  expect(subjects(tree, branch)).toEqual(['feat: subject', 'base'])
  expect(git(tree, 'rev-parse', `${branch}^`)).toBe(parent)
  expect(run(tree, 'git', ['log', '--format=%B', branch]).stdout).not.toContain('Claude-Session')
})

test("#1133: a post-commit hook that lands a follow-up on the agent's OWN commit is refused by provenance (exit 76) -- the wrapper never exits 0 with its trailer reachable", () => {
  const { tree, branch, parent } = fixture()
  const { dir, count } = followupHooks(1)
  git(tree, 'config', 'core.hooksPath', dir)

  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: subject', '-m', CO_AUTHOR])

  expect(result.status).toBe(76)
  expect(result.stderr).toContain('made by another writer')
  expect(result.stdout).not.toContain('trailer stripped')
  expect(readFileSync(count, 'utf8').trim()).toBe('1')
  expect(subjects(tree, branch)).toEqual(['legitimate followup', 'feat: subject', 'base'])
  expect(git(tree, 'rev-parse', `${branch}^^`)).toBe(parent)
  // The truth stderr states: the hook-restored trailer is reachable from the branch, in
  // the wrapper's own commit, and the wrapper said so instead of exiting 0.
  expect(git(tree, 'log', '-1', '--format=%B', `${branch}^`)).toContain(SESSION)
})

test('#1133: a candidate that still carries the trailer is never referenced -- the trailer commit is withdrawn (exit 73, shimmed commit-tree)', () => {
  const { tree, branch, parent } = fixture()
  // A commit-tree that appends the trailer to whatever message it is given stands in for
  // any way the rebuilt object could differ from the bytes the wrapper meant to store.
  const { bin, count } = shimmedGitFailingNth('commit-tree', 1, `exec $REAL_GIT "$@" -m '${SESSION}'`)

  const result = runGuardWithShim(tree, branch, bin)

  expect(result.status).toBe(73)
  expect(result.stderr).toContain('STILL on the rebuilt commit')
  expect(result.stderr).toContain('was withdrawn')
  expect(result.stderr).toContain('referenced by nothing')
  expect(result.stdout).not.toContain('trailer stripped')
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('change.txt')
  expect(run(tree, 'git', ['log', '--format=%B', branch]).stdout).not.toContain('Claude-Session')
  const candidate = result.stderr.match(/STILL on the rebuilt commit ([0-9a-f]{40})/)?.[1]
  expect(candidate).toBeDefined()
  expect(readBack(tree, candidate!)).toContain(SESSION)
  expect(git(tree, 'for-each-ref', '--points-at', candidate!)).toBe('')
  expect(readFileSync(count, 'utf8').trim()).toBe('1')
})

test('#1133: a config-signed first commit (commit.gpgsign) is rebuilt signed -- the signature is decided by the object, not by argv', () => {
  const { tree, branch, parent } = fixture()
  const { program, log } = fakeGpg()
  git(tree, 'config', 'gpg.program', program)
  git(tree, 'config', 'user.signingkey', 'CONFIGKEY')
  git(tree, 'config', 'commit.gpgsign', 'true')

  // Positive control: `commit-tree` ignores commit.gpgsign (that is why the wrapper must
  // decide from the object). A plain commit-tree under this config stores no signature.
  const treeOid = git(tree, 'write-tree')
  const plain = git(tree, 'commit-tree', treeOid, '-p', parent, '-m', 'control')
  expect(gpgsigHeaders(tree, plain)).toBe(0)
  expect(readFileSync(log, 'utf8')).toBe('')

  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: config-signed', '-m', SESSION])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('feat: config-signed')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(gpgsigHeaders(tree, 'HEAD')).toBe(1)
  // Signed twice with the configured key: the first commit and the rebuild.
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['--status-fd=2 -bsau CONFIGKEY', '--status-fd=2 -bsau CONFIGKEY'])
})

test('#1133: the rebuilt commit keeps the author and committer lines byte-for-byte (no committer-date bump)', () => {
  const { tree, branch, parent } = fixture()
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Ada Author',
    GIT_AUTHOR_EMAIL: 'ada@example.test',
    GIT_AUTHOR_DATE: '1700000000 +0130',
    GIT_COMMITTER_NAME: 'Cy Committer',
    GIT_COMMITTER_EMAIL: 'cy@example.test',
    GIT_COMMITTER_DATE: '1700000001 -0500',
  }

  const result = spawnSync('bash', [guard, branch, '-m', 'feat: idents', '-m', SESSION], { cwd: tree, encoding: 'utf8', env })

  expect(result.status, result.stderr || result.stdout).toBe(0)
  const object = readBack(tree, 'HEAD')
  expect(object).toContain('\nauthor Ada Author <ada@example.test> 1700000000 +0130\n')
  expect(object).toContain('\ncommitter Cy Committer <cy@example.test> 1700000001 -0500\n')
  expect(object).not.toContain('Claude-Session')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
})

test('#1133: --amend through the wrapper: the expected parent is the amended commit\'s parent, and the strip lands', () => {
  const { tree, branch, parent } = fixture()
  git(tree, 'commit', '-q', '-m', 'first')
  const first = git(tree, 'rev-parse', 'HEAD')
  writeFileSync(join(tree, 'change.txt'), 'changed again\n')
  git(tree, 'add', 'change.txt')

  const result = run(tree, 'bash', [guard, branch, '--amend', '-m', 'feat: amended', '-m', SESSION, '-m', CO_AUTHOR])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(subjects(tree, branch)).toEqual(['feat: amended', 'base'])
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe(`feat: amended\n\n${CO_AUTHOR}`)
  expect(git(tree, 'show', '--format=', 'HEAD:change.txt')).toBe('changed again')
  expect(git(tree, 'for-each-ref', '--points-at', first)).toBe('')
})

test('#1133: a merge in progress concluded through the wrapper keeps BOTH parents on the stripped commit', () => {
  const { repo, tree, branch, parent } = fixture()
  git(repo, 'branch', 'side', parent)
  git(repo, 'checkout', '-q', 'side')
  writeFileSync(join(repo, 'side.txt'), 'side\n')
  git(repo, 'add', 'side.txt')
  git(repo, 'commit', '-q', '-m', 'side')
  const side = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', 'main')
  git(tree, 'reset', '-q')
  rmSync(join(tree, 'change.txt'))
  git(tree, 'merge', '-q', '--no-commit', '--no-ff', 'side')
  expect(run(tree, 'git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status).toBe(0)

  const result = run(tree, 'bash', [guard, branch, '-m', 'merge: side', '-m', SESSION])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(git(tree, 'rev-list', '--parents', '-1', 'HEAD').split(' ').slice(1)).toEqual([parent, side])
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('merge: side')
  expect(run(tree, 'git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status).not.toBe(0)
  expect(git(tree, 'show', '--format=', 'HEAD:side.txt')).toBe('side')
})

test('#1133: a commit with a header the rebuild cannot carry (mergetag) is refused and withdrawn (exit 75)', () => {
  const { tree, branch, parent } = fixture()
  const bin = shimmedGitFailing({})
  const realGit = run(bin, 'sh', ['-c', 'command -v git']).stdout.trim()
  // The shim lets the agent's commit land, then replaces it on the ref with the same commit
  // plus a `mergetag` header (what a signed-tag merge produces), written with hash-object.
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\n` +
      `if [ "$1" = "commit" ]; then\n` +
      `  ${realGit} "$@" || exit $?\n` +
      `  oid=$(${realGit} cat-file commit HEAD | awk 'BEGIN{h=1} h&&/^$/{print "mergetag object 0000000000000000000000000000000000000000"; print " type commit"; print " tag v1"; print " tagger T <t@t> 1700000000 +0000"; print " "; print " v1"; h=0} {print}' | ${realGit} hash-object -t commit -w --stdin --literally)\n` +
      `  exec ${realGit} update-ref HEAD "$oid"\n` +
      `fi\n` +
      `exec ${realGit} "$@"\n`,
    { mode: 0o755 },
  )

  const result = runGuardWithShim(tree, branch, bin)

  expect(result.status).toBe(75)
  expect(result.stderr).toContain("'mergetag' header")
  expect(result.stderr).toContain('was withdrawn')
  expect(result.stdout).not.toContain('trailer stripped')
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('change.txt')
  expect(run(tree, 'git', ['log', '--format=%B', branch]).stdout).not.toContain('Claude-Session')
})

test('#1133: a detached HEAD is rewritten in place and no branch is touched', () => {
  const { tree, branch, parent } = fixture()
  git(tree, 'checkout', '-q', '--detach')

  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: detached', '-m', SESSION, '-m', CO_AUTHOR])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(result.stdout).toContain('HEAD is now')
  expect(result.stdout).toContain('(HEAD moved from')
  expect(run(tree, 'git', ['symbolic-ref', '-q', 'HEAD']).status).toBe(1)
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe(`feat: detached\n\n${CO_AUTHOR}`)
  expect(git(tree, 'rev-parse', branch)).toBe(parent)
})

test("#1133: a message paragraph that is literally '--amend' is a VALUE, not the flag -- the commit is provenance-checked against the probed HEAD and lands stripped", () => {
  const { tree, branch, parent } = fixture()
  // Positive control for the scan: the same paragraph delivered where git reads it as the
  // flag (bare, no `-m` before it) turns the invocation into an amend of `parent`, and the
  // wrapper's expected parent is then `parent`'s own first parent (none: it is the root).
  const asFlag = run(tree, 'bash', [guard, branch, '--amend', '--no-edit', '-m', 'amended base', '-m', SESSION])
  expect(asFlag.status, asFlag.stderr || asFlag.stdout).toBe(0)
  expect(git(tree, 'rev-list', '--parents', '-1', 'HEAD').split(' ')).toHaveLength(1)
  git(tree, 'reset', '-q', '--soft', parent)
  git(tree, 'update-ref', `refs/heads/${branch}`, parent)
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('change.txt')

  // Now the paragraph is the VALUE of `-m`: an ordinary commit on top of `parent`. A scan that
  // read every argv element as an option would set amending=1, expect a root commit, see
  // `parent` as the first parent instead, and refuse with exit 76 -- trailer left on the ref.
  const result = run(tree, 'bash', [guard, branch, '-m', '--amend', '-m', SESSION, '-m', CO_AUTHOR])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(result.stdout).toContain('HEAD is now')
  expect(git(tree, 'rev-list', '--parents', '-1', 'HEAD').split(' ').slice(1)).toEqual([parent])
  expect(git(tree, 'log', '-1', '--format=%B')).toBe(`--amend\n\n${CO_AUTHOR}`)
  expect(run(tree, 'git', ['log', '--format=%B', branch]).stdout).not.toContain('Claude-Session')
})
