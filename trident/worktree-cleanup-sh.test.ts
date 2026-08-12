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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

function run(
  repo: string,
  branch: string,
  mode: string,
  env: Record<string, string> = {},
): { code: number; out: string } {
  const p = Bun.spawnSync(['bash', SCRIPT, repo, branch, mode], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
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
    // preserved counts ITEMS KEPT, not worktrees: the tree AND the branch whose
    // commits sit under it. Asserted exactly — a bare `RESULT preserved=` prefix
    // passes for every count including 0, which is the one that would be a bug.
    expect(res.out).toContain('RESULT preserved=2 removed=0')
    // Nothing was destroyed.
    expect(existsSync(join(wt, 'brand-new.ts'))).toBe(true)
    expect(readFileSync(join(wt, 'brand-new.ts'), 'utf8')).toContain('197')
    expect(worktreesFor(repo, BRANCH)).toEqual([wt])
    // …and the branch went with it (its commits are under the preserved tree).
    expect(branchExists(repo, BRANCH)).toBe(true)
    expect(res.out).toContain(`PRESERVED branch ${BRANCH} reason=worktree-preserved`)
    expect(res.out).not.toContain(`DELETED branch`)
  })

  test('untracked files inside an untracked DIRECTORY are named INDIVIDUALLY (what -uall buys)', () => {
    // This is the whole behavioral payload of `--untracked-files=all`, and the
    // only test that fails if the flag is dropped: plain `--porcelain` collapses
    // a brand-new directory to a single `?? feature/` line. The tree is "dirty"
    // either way — but this output IS the operator's recovery instructions, and
    // "feature/" does not tell them 197 insertions across 7 files are in there.
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    mkdirSync(join(wt, 'feature', 'deep'), { recursive: true })
    writeFileSync(join(wt, 'feature', 'router.ts'), 'export const a = 1\n')
    writeFileSync(join(wt, 'feature', 'deep', 'handler.ts'), 'export const b = 2\n')

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(3)
    expect(res.out).toContain(`PRESERVED worktree ${wt} reason=dirty`)
    expect(res.out).toContain('feature/router.ts')
    expect(res.out).toContain('feature/deep/handler.ts')
    expect(existsSync(join(wt, 'feature', 'deep', 'handler.ts'))).toBe(true)
  })

  test('a MODIFIED tracked file is preserved with its edit intact', () => {
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    writeFileSync(join(wt, 'built.txt'), 'edited, never committed\n')

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(3)
    expect(res.out).toContain('reason=dirty')
    expect(res.out).toContain('built.txt')
    expect(readFileSync(join(wt, 'built.txt'), 'utf8')).toBe('edited, never committed\n')
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

  test('the script SOURCE never spells --force (a grep, not a behaviour test)', async () => {
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

describe('worktree-cleanup.sh — git STDERR is diagnostics, never dirt', () => {
  // Only `git status`'s STDOUT decides dirtiness. Reading `2>&1` made every
  // warning git prints on a CLEAN tree parse as a dirty path: the worktree was
  // never removed, pr-mode branch teardown never ran, and "PRESERVED WORK" fired
  // on runs that had preserved nothing — a leak plus permanent alarm fatigue.

  test('a clean tree whose git writes to stderr (GIT_TRACE) is still REMOVED, exit 0', () => {
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    git(wt, 'push', '-q', 'origin', BRANCH)

    // GIT_TRACE makes every git command emit trace lines on stderr and exit 0 —
    // a clean, uid-independent stand-in for "git warned about something".
    const res = run(repo, BRANCH, 'delete-branch', { GIT_TRACE: '1' })

    expect(res.out).toContain(`REMOVED ${wt}`)
    expect(res.out).not.toContain('reason=dirty')
    expect(existsSync(wt)).toBe(false)
    // …and the same stderr does not poison the ls-remote sha comparison either:
    // a trace line as "line 1" would read as the remote sha and fake `unpushed`.
    expect(res.out).not.toContain('reason=unpushed')
    expect(res.out).toContain(`DELETED branch ${BRANCH}`)
    expect(res.code).toBe(0)
  })

  test.skipIf(process.getuid?.() === 0)(
    'a clean tree with an UNREADABLE subdirectory (git warns, exits 0) is still REMOVED',
    () => {
      const repo = makeRepo()
      const wt = addBuildWorktree(repo)
      // `warning: could not open directory 'locked/': Permission denied` on
      // stderr, rc=0, empty stdout. Skipped as root, where nothing is unreadable.
      const locked = join(wt, 'locked')
      mkdirSync(locked)
      chmodSync(locked, 0o000)
      try {
        const res = run(repo, BRANCH, 'keep-branch')
        expect(res.code).toBe(0)
        expect(res.out).toContain(`REMOVED ${wt}`)
      } finally {
        if (existsSync(locked)) chmodSync(locked, 0o755)
      }
    },
  )
})

describe('worktree-cleanup.sh — the SHARED CHECKOUT is never a candidate', () => {
  test('the main working tree ON the branch is left alone; teardown still resolves, exit 0', () => {
    // merge.ts legitimately leaves the shared checkout on a feature branch after
    // a stale-rebase recovery. `git worktree remove` refuses a main working tree
    // ("fatal: '<repo>' is a main working tree"), which used to be scored as an
    // unverifiable PRESERVATION — pinning the exit at 3 and blocking pr-mode
    // branch teardown for good.
    const repo = makeRepo()
    git(repo, 'checkout', '-q', '-b', BRANCH)
    writeFileSync(join(repo, 'in-shared-checkout.txt'), 'work in the shared checkout\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'on the branch in the shared checkout')
    git(repo, 'push', '-q', 'origin', BRANCH)

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(0)
    expect(res.out).not.toContain('PRESERVED worktree')
    expect(res.out).toContain('RESULT preserved=0 removed=0')
    // The shared checkout is intact — files, HEAD and all.
    expect(existsSync(join(repo, 'in-shared-checkout.txt'))).toBe(true)
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(BRANCH)
    // git refuses to delete a branch that is checked out there; origin holds the
    // exact sha, so nothing is at risk and it is reported WITHOUT the exit-3 alarm.
    expect(res.out).toContain(`KEPT branch ${BRANCH} reason=checked-out`)
    expect(branchExists(repo, BRANCH)).toBe(true)
  })

  test('a DIRTY shared checkout on the branch still does not block the run', () => {
    const repo = makeRepo()
    git(repo, 'checkout', '-q', '-b', BRANCH)
    git(repo, 'push', '-q', 'origin', BRANCH)
    writeFileSync(join(repo, 'operator-scratch.ts'), 'the human is mid-edit here\n')
    const wt = addBuildWorktree(repo, 'trident/linked')

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(0)
    // Untouched: not removed, not reported, not counted.
    expect(readFileSync(join(repo, 'operator-scratch.ts'), 'utf8')).toContain('mid-edit')
    expect(res.out).not.toContain(`PRESERVED worktree ${repo}`)
    // The unrelated linked worktree on ANOTHER branch is likewise untouched.
    expect(existsSync(wt)).toBe(true)
  })
})

describe('worktree-cleanup.sh — the probe must point at a WORKTREE ROOT', () => {
  test("a registered path that is no longer a worktree root is SKIPPED, not credited with the SHARED CHECKOUT's dirt", () => {
    // `git -C <dir> status` WALKS UP. A registered worktree directory that has
    // stopped being a worktree root — here its `.git` file is gone but the
    // directory survives INSIDE the checkout — therefore answers with the
    // enclosing repo's status. Without the `--show-toplevel` guard the operator
    // gets `PRESERVED worktree <wt> reason=dirty` listing files that are not in
    // <wt> at all, exit 3 on a run that preserved nothing, and pr-mode branch
    // teardown pinned at 3 for as long as the stale directory sits there.
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    git(wt, 'push', '-q', 'origin', BRANCH)
    rmSync(join(wt, '.git'), { force: true })
    // The dirt belongs to the SHARED CHECKOUT, and to nothing else.
    writeFileSync(join(repo, 'operator-scratch.ts'), 'the human is mid-edit here\n')

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.out).toContain(`SKIPPED ${wt} reason=not-a-worktree-root`)
    // The false preservation, in all three of its shapes.
    expect(res.out).not.toContain('reason=dirty')
    expect(res.out).not.toContain('operator-scratch.ts')
    expect(res.code).not.toBe(3)
    expect(res.code).toBe(0)
    // Nothing was destroyed on either side of the mistake.
    expect(existsSync(join(wt, 'built.txt'))).toBe(true)
    expect(readFileSync(join(repo, 'operator-scratch.ts'), 'utf8')).toContain('mid-edit')
  })

  test('a directory git cannot classify AT ALL is still preserved (absence of evidence is not evidence)', () => {
    // The other half of the guard, and the reason it checks for a DIFFERENT root
    // rather than "not exactly this one": a broken worktree outside any repo
    // makes `rev-parse` say nothing, which is not the same answer as "this
    // belongs to some other repo". It must still land on PRESERVE.
    const repo = makeRepo()
    const wt = addBuildWorktree(repo, BRANCH, true)
    rmSync(join(wt, '.git'), { force: true })

    const res = run(repo, BRANCH, 'delete-branch')

    expect(res.code).toBe(3)
    expect(res.out).toContain(`PRESERVED worktree ${wt} reason=unverifiable`)
    expect(res.out).not.toContain('SKIPPED')
    expect(existsSync(join(wt, 'built.txt'))).toBe(true)
  })
})

describe('worktree-cleanup.sh — the output is BOUNDED, so the RESULT line survives', () => {
  test('a huge dirty tree is summarised: the record, the RESULT line and the exit code all survive', () => {
    // This output is piped verbatim through a cheap transcribing agent in the
    // inner workflow. One un-ignored `dist/` is thousands of untracked paths,
    // and an unbounded list pushes the trailing RESULT line (and the caller's
    // `___EXIT=` marker) out of the reader's window — at which point the run
    // logs "NOTHING was inspected or removed", the exact inverse of the truth.
    const repo = makeRepo()
    const wt = addBuildWorktree(repo)
    mkdirSync(join(wt, 'dist'))
    for (let i = 0; i < 600; i++) writeFileSync(join(wt, 'dist', `chunk-${i}.js`), 'x\n')

    const res = run(repo, BRANCH, 'keep-branch')

    expect(res.code).toBe(3)
    expect(res.out).toContain(`PRESERVED worktree ${wt} reason=dirty`)
    // Named work, then a count and the command for the rest — never 600 lines.
    expect(res.out).toContain('dist/chunk-0.js')
    expect(res.out).toContain('and 550 more path(s)')
    expect(res.out).toContain(`git -C '${wt}' status --porcelain --untracked-files=all`)
    expect(res.out.split('\n').length).toBeLessThan(80)
    // The load-bearing tail is still there.
    expect(res.out.trimEnd().endsWith('RESULT preserved=1 removed=0')).toBe(true)
    expect(existsSync(join(wt, 'dist', 'chunk-599.js'))).toBe(true)
  })
})

describe('worktree-cleanup.sh — the one network call can never hang the finally{}', () => {
  /** An `origin` whose transport is an arbitrary command (git's `ext::` helper),
   *  so `ls-remote` can be made to hang, or to report the environment it ran in. */
  function extRemote(repo: string, script: string): string {
    const helper = join(repo, '..', `helper-${Math.random().toString(36).slice(2)}.sh`)
    writeFileSync(helper, `#!/bin/sh\n${script}\n`)
    chmodSync(helper, 0o755)
    git(repo, 'remote', 'add', 'origin', `ext::${helper}`)
    git(repo, 'config', 'protocol.ext.allow', 'always')
    return helper
  }

  test('an origin that never answers is CUT OFF and keeps the branch, instead of hanging forever', () => {
    // The cleanup runs from a `finally{}` that fires on throw and on abort, with
    // nobody at a keyboard. A black-holed origin used to take the whole block
    // with it. The deadline is dropped to 1s here purely so the test is fast —
    // the helper would otherwise sleep for 30.
    const repo = makeRepo({ withRemote: false })
    // The transport records that it RAN TO COMPLETION. Killed mid-sleep, it never
    // gets to — so "was it cut off?" is a file that does or does not exist, not a
    // stopwatch. (Ungated, this test would sit here for the full 30s and then
    // find the marker; the deadline is dropped to 1s so the green path is fast.)
    const finished = join(repo, '..', 'transport-ran-to-completion.txt')
    extRemote(repo, `sleep 30; printf ran > ${finished}; exit 1`)
    addBuildWorktree(repo)

    const res = run(repo, BRANCH, 'delete-branch', { TRIDENT_CLEANUP_LS_REMOTE_TIMEOUT: '1' })

    expect(existsSync(finished)).toBe(false)
    // Cut off ≠ proved pushed: the branch is KEPT, the safe direction.
    expect(res.code).toBe(3)
    expect(res.out).toContain(`PRESERVED branch ${BRANCH} reason=ls-remote-failed`)
    expect(branchExists(repo, BRANCH)).toBe(true)
  }, 60_000)

  test('git is run with terminal prompting DISABLED, so a credential prompt cannot block it', () => {
    // Observed, not grepped: the transport helper reports the environment git
    // actually handed it. Unset (the default) is what stalls on a username
    // prompt when origin is a bare-HTTPS URL with an expired credential helper.
    const repo = makeRepo({ withRemote: false })
    const seen = join(repo, '..', 'terminal-prompt.txt')
    extRemote(repo, `printf 'GIT_TERMINAL_PROMPT=[%s]' "\${GIT_TERMINAL_PROMPT-unset}" > ${seen}; exit 1`)
    addBuildWorktree(repo)

    run(repo, BRANCH, 'delete-branch')

    expect(readFileSync(seen, 'utf8')).toBe('GIT_TERMINAL_PROMPT=[0]')
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

  test('missing/empty arguments exit 2 EXACTLY — the documented usage code', () => {
    // Not merely "non-zero": the caller branches on the code. `${1:?}` exited 1,
    // which is indistinguishable from a crash, and only exit 3 may ever be read
    // as "work was preserved" (see inner-workflow.mjs).
    expect(Bun.spawnSync(['bash', SCRIPT]).exitCode).toBe(2)
    expect(Bun.spawnSync(['bash', SCRIPT, '/tmp']).exitCode).toBe(2)
    expect(Bun.spawnSync(['bash', SCRIPT, '/tmp', BRANCH]).exitCode).toBe(2)
    // An EMPTY branch would otherwise match `refs/heads/` prefixes loosely.
    expect(Bun.spawnSync(['bash', SCRIPT, '/tmp', '', 'keep-branch']).exitCode).toBe(2)
    // Extra arguments are a typo, not a mode to guess at.
    expect(Bun.spawnSync(['bash', SCRIPT, '/tmp', BRANCH, 'keep-branch', 'extra']).exitCode).toBe(2)
  })
})
