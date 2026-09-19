import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const roots: string[] = []
const guard = new URL('./commit-with-resolved-head.sh', import.meta.url).pathname
const hooks = new URL('../.githooks', import.meta.url).pathname

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
// and the commit that lands must be the same single commit -- amended in place, parent
// unchanged, author unchanged, Co-Authored-By byte-identical.
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
  // author survived the amend, and the tree is what the agent staged.
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%an')).toBe('Test')
  expect(git(tree, 'show', '--stat', '--format=', 'HEAD')).toContain('change.txt')
  // The strip AMENDS, so git's first `[branch sha] subject` line names a commit that is no
  // longer on the branch. The wrapper must name the commit that IS, in full, on stdout --
  // a Forge that copied the first line would trip the head-claim gate downstream.
  expect(result.stdout).toContain('HEAD is now')
  expect(result.stdout).toContain(git(tree, 'rev-parse', 'HEAD'))
})

test("#1133: --no-verify on the agent's commit is honoured by the strip amend (a refusing pre-commit hook cannot leave the trailer behind)", () => {
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

  // The agent skipped the hook on its commit; the amend must not re-run it, or the commit
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

test('#1133: a message without the trailer is committed once and left untouched (no amend)', () => {
  const { tree, branch, parent } = fixture()

  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: plain', '-m', CO_AUTHOR])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  // Byte-equal to what git itself produces for the same -m arguments.
  expect(git(tree, 'log', '-1', '--format=%B')).toBe(`feat: plain\n\n${CO_AUTHOR}`)
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  // The strip path must be SKIPPED when there is nothing to strip: the branch reflog
  // holds the one commit and no `commit (amend)` entry.
  const reflog = git(tree, 'reflog', 'show', '--format=%gs', branch)
  expect(reflog).not.toContain('commit (amend)')
  expect(reflog.split('\n').filter((l) => l.startsWith('commit:'))).toHaveLength(1)
})

test("#1133: a failed commit propagates git's exit code, and nothing is amended", () => {
  const { tree, branch, parent } = fixture()
  git(tree, 'reset', '-q') // nothing staged -> git commit refuses
  const before = git(tree, 'rev-parse', 'HEAD')
  expect(before).toBe(parent)

  const result = run(tree, 'bash', [guard, branch, '-m', 'feat: nothing staged', '-m', SESSION])

  expect(result.status).toBe(1)
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('base')
  expect(git(tree, 'reflog', 'show', '--format=%gs', branch)).not.toContain('commit (amend)')
})

test('#1133: the strip amend rewrites the MESSAGE only -- a pathspec commit does not absorb the other staged file', () => {
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

  // Without `--only`, `git commit --amend` snapshots the CURRENT index, so the strip would
  // fold second.txt into the published commit with exit 0 and no marker.
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
// wrapper commits WITH the trailer and only then amends it out, so an amend that fails for
// any reason must withdraw that commit rather than report an error and leave it at HEAD,
// where the outer loop's publish would carry it to the PR.
test('#1133: an amend that git refuses withdraws the trailer-bearing commit (fail closed, real git)', () => {
  const { tree, branch, parent } = fixture()

  // A message that is ONLY the trailer strips to nothing, and git refuses an empty amend.
  const result = run(tree, 'bash', [guard, branch, '-m', SESSION])

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('could not be stripped')
  expect(result.stderr).toContain('was withdrawn')
  expect(result.stderr).toContain(`HEAD is back at ${parent}`)
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('base')
  // Forge can retry: the staged change is still staged, nothing was lost.
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('change.txt')
})

test('#1133: an amend that fails for ANY reason withdraws the commit and propagates the exit code (fail closed, shimmed amend)', () => {
  const { tree, branch, parent } = fixture()
  const bin = mkdtempSync(join(tmpdir(), 'trident-head-amend-shim-'))
  roots.push(bin)
  const realGit = run(bin, 'sh', ['-c', 'command -v git']).stdout.trim()
  // Stands in for a signing or ref-lock failure: every git call is real EXCEPT `--amend`.
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\n` +
      `for a in "$@"; do if [ "$a" = "--amend" ]; then echo "shim: amend refused" >&2; exit 128; fi; done\n` +
      `exec ${realGit} "$@"\n`,
    { mode: 0o755 },
  )

  const result = spawnSync('bash', [guard, branch, '-m', 'feat: subject', '-m', SESSION, '-m', CO_AUTHOR], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  })

  expect(result.status).toBe(128)
  // The first commit DID land (the shim only refuses the amend) -- and was then withdrawn.
  expect(result.stderr).toContain('shim: amend refused')
  expect(result.stderr).toContain('was withdrawn')
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(parent)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('base')
  expect(git(tree, 'diff', '--cached', '--name-only')).toBe('change.txt')
  // Nothing with the trailer is reachable from the branch; the withdrawn commit survives
  // only in the reflog.
  expect(run(tree, 'git', ['log', '--format=%B', branch]).stdout).not.toContain('Claude-Session')
})

test('#1133: --allow-empty-message on the agent\'s commit is honoured by the strip amend', () => {
  const { tree, branch, parent } = fixture()

  // The same only-trailer message the fail-closed test refuses, now with the flag the agent
  // gave the first commit: the amend must repeat it, or a commit git accepted is withdrawn.
  const result = run(tree, 'bash', [guard, branch, '--allow-empty-message', '-m', SESSION])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
  expect(result.stdout).toContain('HEAD is now')
})

test("#1133: an explicit --cleanup=<mode> on the agent's commit is what the amended message keeps (the amend runs no cleanup of its own)", () => {
  const { tree, branch, parent } = fixture()

  // Positive control: under the default cleanup a `-m` paragraph loses its trailing spaces
  // on the FIRST commit, and the amend stores that cleaned message minus the trailer. (The
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
  // Verbatim survived the amend: the trailing spaces the first commit stored are still there.
  expect(body).toContain('trailing   \n')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
})

test("#1133: a -m paragraph that begins with -S is a message, not a signing flag for the amend", () => {
  const { tree, branch, parent } = fixture()

  // A flag scan that cannot tell an option's VALUE from an option would forward
  // `-Signed by hand` as `-S<keyid>`, the amend would try to gpg-sign, fail, and the
  // commit would be withdrawn (or, before fail-closed, left with the trailer).
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
  // transcoding it; the amend must carry that byte through untouched.
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

test('#1133: the amend stores the filtered bytes verbatim -- a config-level commit.cleanup is not overridden, and a missing final newline stays missing', () => {
  const { tree, branch, parent } = fixture()
  git(tree, 'config', 'commit.cleanup', 'verbatim')

  // Positive control: with that config and no --cleanup on argv, git keeps the trailing
  // spaces on the first commit. The amend must keep them too.
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
  const bin = shimmedGitFailing({ 'cat-file': 3, reset: 9 })

  const result = spawnSync('bash', [guard, branch, '-m', 'feat: subject', '-m', SESSION, '-m', CO_AUTHOR], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  })

  expect(result.status).toBe(3)
  expect(result.stderr).toContain('shim: reset refused')
  expect(result.stderr).toContain('could not be withdrawn')
  expect(result.stderr).toContain('may carry the trailer')
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
  const bin = shimmedGitFailing({})
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\n` +
      `for a in "$@"; do if [ "$a" = "--amend" ]; then echo "shim: amend refused" >&2; exit 128; fi; done\n` +
      `exec ${run(bin, 'sh', ['-c', 'command -v git']).stdout.trim()} "$@"\n`,
    { mode: 0o755 },
  )

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

test('#1133: a cluster of short options ending in -m (-am) hides its message from the amend-flag scan', () => {
  const { tree, branch, parent } = fixture()

  // `-am <msg>` is one argv element the scan must read as `-a -m`: the paragraph beginning
  // `-S` is the VALUE of that -m, not a signing flag for the amend.
  const result = run(tree, 'bash', [guard, branch, '-am', `-Signed by hand\n\n${SESSION}`])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  const body = git(tree, 'log', '-1', '--format=%B')
  expect(body).not.toContain('Claude-Session')
  expect(body).toContain('-Signed by hand')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
})

test('#1133: an attached option value (-F<file>) is not a cluster -- the flag after it is still forwarded to the amend', () => {
  const { tree, branch, parent } = fixture()
  git(tree, 'reset', '-q') // nothing staged: the commit needs --allow-empty, and so does the amend
  const bodyFile = join(tree, '..', 'attached.txt')
  writeFileSync(bodyFile, `feat: attached\n\n${SESSION}\n`)

  // A scan that read `-F<file>` as a cluster ending in a value-taking letter would skip
  // `--allow-empty` as its value; the amend would then refuse to make the commit empty and
  // the wrapper would withdraw a commit git had accepted.
  const result = run(tree, 'bash', [guard, branch, `-F${bodyFile}`, '--allow-empty'])

  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(git(tree, 'log', '-1', '--format=%B')).toBe('feat: attached')
  expect(git(tree, 'rev-parse', 'HEAD^')).toBe(parent)
})
