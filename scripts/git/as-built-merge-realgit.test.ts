/**
 * REAL-GIT proof that two concurrent builds can both publish.
 *
 * WHAT WAS MEASURED, AND WHY A MOCK CANNOT PROVE IT FIXED. On 2026-08-15T23:20Z three concurrent
 * builds failed at publish on `docs/AS_BUILT.md` and nothing else. The cause is structural: the log
 * is newest-first, so every build prepends its entry at the SAME OFFSET under the SAME three header
 * lines, and git's three-way merge sees two different insertions against identical context. A
 * stubbed merge would prove nothing about that — the whole question is what REAL git does. So this
 * file uses a real repository, real commits, a real moved base, and the publisher's own replay
 * mechanism (`git apply --3way`, `trident/orchestrator.ts:715`), the way
 * `trident/publish-rebase-realgit.test.ts` does.
 *
 * THE FAILURE IS PROVEN BEFORE THE FIX IS. `replay()` is run twice over the identical scenario:
 * once with the merge driver NOT installed, which MUST conflict, and once with it installed, which
 * MUST merge. The first half is the control. Without it "the driver works" is unfalsifiable — a
 * test that only ever runs the fixed configuration passes just as happily when the scenario it
 * describes was never conflicting in the first place.
 *
 * BOTH FILES THE TASK NAMES ARE IN PLAY. Each branch writes its own plan at
 * `.trident/plans/<branch>.md` AND prepends its own log entry, because the acceptance criterion is
 * two builds that do both landing together — not two builds that touch one file each.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..')
const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

interface Ran {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

function run(cwd: string, cmd: string[]): Ran {
  const res = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return {
    ok: res.exitCode === 0,
    code: res.exitCode,
    stdout: new TextDecoder().decode(res.stdout),
    stderr: new TextDecoder().decode(res.stderr),
  }
}

function git(repo: string, ...args: string[]): Ran {
  const res = run(repo, ['git', ...args])
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  return res
}

const HEADER = ['# AS_BUILT', '', 'Running log of what shipped, newest first. One entry per merged change.', '']

function entry(date: string, title: string, bodyLine: string): string[] {
  return [`## ${date} — ${title}`, '', bodyLine, '']
}

/** The log as it stands before either build touches it — a header and some history to preserve. */
const HISTORY = [
  ...entry('2026-08-14', 'the by-path build brief is proven in lockstep', 'History that must survive.'),
  ...entry('2026-08-13', 'an earlier thing shipped', 'More history that must survive.'),
]

function writeLog(repo: string, entries: string[]): void {
  writeFileSync(join(repo, 'docs', 'AS_BUILT.md'), [...HEADER, ...entries].join('\n'))
}

/**
 * A repository holding the log plus the scripts that merge it, with two branches that each wrote a
 * plan and prepended a log entry, and `main` already advanced by the first of them.
 *
 * Returns the paths the replay needs: the fork point both branches share, and the second branch.
 */
function scenario(): { repo: string; forkPoint: string } {
  const repo = mkdtempSync(join(tmpdir(), 'as-built-realgit-'))
  created.push(repo)

  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'trident-test@neutron.local')
  git(repo, 'config', 'user.name', 'Trident Test')
  git(repo, 'config', 'commit.gpgsign', 'false')

  // The real installer and the real driver — not a re-implementation of them.
  mkdirSync(join(repo, 'docs'), { recursive: true })
  mkdirSync(join(repo, 'scripts', 'git'), { recursive: true })
  cpSync(join(REPO_ROOT, 'scripts', 'install-merge-drivers.sh'), join(repo, 'scripts', 'install-merge-drivers.sh'))
  cpSync(join(REPO_ROOT, 'scripts', 'git', 'as-built-merge-driver.ts'), join(repo, 'scripts', 'git', 'as-built-merge-driver.ts'))
  cpSync(join(REPO_ROOT, 'scripts', 'git', 'as-built-log-merge.ts'), join(repo, 'scripts', 'git', 'as-built-log-merge.ts'))

  writeLog(repo, HISTORY)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  const forkPoint = git(repo, 'rev-parse', 'HEAD').stdout.trim()

  // Build ONE: its own plan, its own entry at the top.
  git(repo, 'checkout', '-q', '-b', 'build-one')
  mkdirSync(join(repo, '.trident', 'plans'), { recursive: true })
  writeFileSync(join(repo, '.trident', 'plans', 'build-one.md'), '# plan for build one\n')
  writeLog(repo, [...entry('2026-08-16', 'build one shipped', 'Written by build one.'), ...HISTORY])
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'build one')

  // Build TWO branched from the SAME fork point — it never saw build one's entry.
  git(repo, 'checkout', '-q', '-b', 'build-two', forkPoint)
  mkdirSync(join(repo, '.trident', 'plans'), { recursive: true })
  writeFileSync(join(repo, '.trident', 'plans', 'build-two.md'), '# plan for build two\n')
  writeLog(repo, [...entry('2026-08-16', 'build two shipped', 'Written by build two.'), ...HISTORY])
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'build two')

  // Build one publishes first: the base MOVES underneath build two. This is the whole scenario —
  // without it the replay is a no-op that passes no matter what the code does.
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'merge', '-q', '--no-edit', 'build-one')

  return { repo, forkPoint }
}

/**
 * Replay build two onto the moved `main` exactly as the publisher does: take the branch's own diff
 * from its fork point and `git apply --3way` it in a throwaway detached worktree.
 */
function replay(repo: string, forkPoint: string, label: string): { applied: Ran; worktree: string; unmerged: string[] } {
  const diff = join(repo, `${label}.diff`)
  const out = Bun.spawnSync(['git', 'diff', `${forkPoint}..build-two`], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
  writeFileSync(diff, new TextDecoder().decode(out.stdout))

  const worktree = join(repo, `.replay-${label}`)
  git(repo, 'worktree', 'add', '-q', '--detach', worktree, 'main')
  const applied = run(worktree, ['git', 'apply', '--3way', '--index', diff])
  const unmergedOut = run(worktree, ['git', 'diff', '--name-only', '--diff-filter=U'])
  const unmerged = unmergedOut.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  return { applied, worktree, unmerged }
}

describe('two concurrent builds publishing against a moved base', () => {
  const { repo, forkPoint } = scenario()

  test('CONTROL — without the merge driver the log conflicts, and ONLY the log does', () => {
    // Nothing installed: this is the repository exactly as it ships today.
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(false)

    const { applied, unmerged, worktree } = replay(repo, forkPoint, 'control')

    // The measured production failure, reproduced: the publish fails, on this file and no other.
    expect(applied.ok).toBe(false)
    expect(unmerged).toEqual(['docs/AS_BUILT.md'])
    expect(readFileSync(join(worktree, 'docs', 'AS_BUILT.md'), 'utf8')).toContain('<<<<<<<')

    // The plan files never collide — #302 already gave each build its own path. Both are present,
    // which is what makes the log the SOLE remaining blocker.
    expect(readFileSync(join(worktree, '.trident', 'plans', 'build-one.md'), 'utf8')).toContain('build one')
    expect(readFileSync(join(worktree, '.trident', 'plans', 'build-two.md'), 'utf8')).toContain('build two')
  }, 30_000)

  test('with the driver installed, both builds land — no conflict, both entries, history intact', () => {
    const install = run(repo, ['bash', 'scripts/install-merge-drivers.sh'])
    expect(install.ok).toBe(true)
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)

    const { applied, unmerged, worktree } = replay(repo, forkPoint, 'treatment')

    expect(applied.stderr + applied.stdout).not.toContain('fatal')
    expect(applied.ok).toBe(true)
    expect(unmerged).toEqual([])

    const merged = readFileSync(join(worktree, 'docs', 'AS_BUILT.md'), 'utf8')
    expect(merged).not.toContain('<<<<<<<')

    // ACCEPTANCE 1 — both builds' entries survived the merge.
    expect(merged).toContain('## 2026-08-16 — build one shipped')
    expect(merged).toContain('## 2026-08-16 — build two shipped')
    expect(merged).toContain('Written by build one.')
    expect(merged).toContain('Written by build two.')

    // ACCEPTANCE 4 — existing history preserved, not discarded.
    expect(merged).toContain('## 2026-08-14 — the by-path build brief is proven in lockstep')
    expect(merged).toContain('## 2026-08-13 — an earlier thing shipped')
    expect(merged).toContain('# AS_BUILT')

    // ACCEPTANCE 3 — newest first, and WHOLE entries: each heading is immediately followed by its
    // own body, so nothing was interleaved into anything else.
    const headings = merged.split('\n').filter((l) => l.startsWith('## '))
    expect(headings).toEqual([
      '## 2026-08-16 — build one shipped',
      '## 2026-08-16 — build two shipped',
      '## 2026-08-14 — the by-path build brief is proven in lockstep',
      '## 2026-08-13 — an earlier thing shipped',
    ])
    const lines = merged.split('\n')
    for (const [heading, expectedBody] of [
      ['## 2026-08-16 — build one shipped', 'Written by build one.'],
      ['## 2026-08-16 — build two shipped', 'Written by build two.'],
    ] as const) {
      const at = lines.indexOf(heading)
      expect(lines[at + 1]).toBe('')
      expect(lines[at + 2]).toBe(expectedBody)
    }

    // Both plans are still there alongside the merged log.
    expect(readFileSync(join(worktree, '.trident', 'plans', 'build-one.md'), 'utf8')).toContain('build one')
    expect(readFileSync(join(worktree, '.trident', 'plans', 'build-two.md'), 'utf8')).toContain('build two')
  }, 30_000)

  test('MUTATION — uninstalling the driver brings the conflict straight back', () => {
    // Proves the passing test above depends on the mechanism under test and not on some incidental
    // property of the scenario: remove only the driver, change nothing else, and the failure returns.
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--uninstall']).ok).toBe(true)
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(false)

    const { applied, unmerged } = replay(repo, forkPoint, 'mutation')
    expect(applied.ok).toBe(false)
    expect(unmerged).toEqual(['docs/AS_BUILT.md'])
  }, 30_000)
})

/**
 * The installer must never report success over a HALF-INSTALL.
 *
 * `install-merge-drivers.sh` runs under `set -uo pipefail` with no `-e`, so an
 * unchecked failure used to fall through to `echo "merge drivers: installed"`
 * and exit 0. The state that mattered is the one its own header calls fatal, and
 * it was one step wide.
 *
 * MEASURED HERE, on this machine, with two branches conflicting on a path bound
 * to `merge=as-built-log` — the asymmetry is the whole design input:
 *
 *   `.driver` set, `.name` UNSET  → the merge SUCCEEDS, the driver runs.
 *   `.name` set, `.driver` UNSET  → fatal: custom merge driver as-built-log
 *                                   lacks command line.  (exit 128)
 *
 * So the fix is an ordering, not just a check: `.driver` goes in first, and an
 * interruption between the two leaves a clone that merges rather than one that
 * cannot merge at all.
 */
describe('half-installing the merge driver', () => {
  /** A throwaway repo with one path bound to the driver and two conflicting branches. */
  function conflictRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'as-built-halfinstall-'))
    created.push(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'trident-test@neutron.local')
    git(repo, 'config', 'user.name', 'Trident Test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, '.gitattributes'), 'log.txt merge=as-built-log\n')
    writeFileSync(join(repo, 'log.txt'), 'base\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'checkout', '-qb', 'other')
    writeFileSync(join(repo, 'log.txt'), 'THEIRS\nbase\n')
    git(repo, 'commit', '-qam', 'theirs')
    git(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'log.txt'), 'OURS\nbase\n')
    git(repo, 'commit', '-qam', 'ours')
    return repo
  }

  test('MEASUREMENT — .name without .driver is the fatal state; .driver without .name is not', () => {
    const fatal = conflictRepo()
    git(fatal, 'config', 'merge.as-built-log.name', 'entry-aware')
    const fatalMerge = run(fatal, ['git', 'merge', 'other'])
    expect(fatalMerge.code).toBe(128)
    expect(fatalMerge.stderr + fatalMerge.stdout).toContain('lacks command line')

    // The other half. Without this control the ordering fix is a guess: it is
    // only safer to write `.driver` first if `.driver` alone actually works.
    const fine = conflictRepo()
    git(fine, 'config', 'merge.as-built-log.driver', 'cat %A %B > %A.m && mv %A.m %A')
    const fineMerge = run(fine, ['git', 'merge', 'other'])
    expect(fineMerge.code).toBe(0)
    expect(readFileSync(join(fine, 'log.txt'), 'utf8')).toContain('THEIRS')
  }, 30_000)

  test('the installer writes .driver BEFORE .name, so no interruption can wedge a clone', () => {
    // Read from the script itself: the ordering is the safety property, and it
    // is invisible in the installed result (both keys are present when it
    // finishes). Only the SOURCE can show which one lands first.
    const sh = readFileSync(join(REPO_ROOT, 'scripts', 'install-merge-drivers.sh'), 'utf8')
    const driverAt = sh.indexOf('config "merge.$DRIVER_NAME.driver"')
    const nameAt = sh.indexOf('config "merge.$DRIVER_NAME.name"')
    expect(driverAt).toBeGreaterThan(-1)
    expect(nameAt).toBeGreaterThan(-1)
    expect(driverAt).toBeLessThan(nameAt)
  })

  test('a failing config write ROLLS BACK and exits non-zero instead of printing success', () => {
    // The reachable version of the blocker, forced deterministically: make the
    // repo config unwritable so the very first `git config` fails. Before the
    // fix this printed "merge drivers: installed" and exited 0.
    const repo = conflictRepo()
    // The scripts the installer requires must exist, or it exits 2 for an
    // unrelated reason and this test proves nothing.
    mkdirSync(join(repo, 'scripts', 'git'), { recursive: true })
    cpSync(join(REPO_ROOT, 'scripts', 'install-merge-drivers.sh'), join(repo, 'scripts', 'install-merge-drivers.sh'))
    cpSync(
      join(REPO_ROOT, 'scripts', 'git', 'as-built-merge-driver.ts'),
      join(repo, 'scripts', 'git', 'as-built-merge-driver.ts'),
    )

    // Read-only `.git` DIRECTORY, not a read-only `config` file: `git config`
    // writes through `.git/config.lock` and renames, so the file's own mode
    // never comes into it. Measured — `error: could not lock config file
    // .git/config: Permission denied`, exit 255.
    const gitDir = join(repo, '.git')
    chmodSync(gitDir, 0o555)
    const installed = run(repo, ['bash', 'scripts/install-merge-drivers.sh'])
    chmodSync(gitDir, 0o755)

    // Control: the write really was refused, so the failure under test is the
    // one being described.
    expect(installed.stderr).toContain('FAILED')
    expect(installed.ok).toBe(false)
    expect(installed.stdout).not.toContain('merge drivers: installed')

    // And nothing was left behind — in particular not `.name` without `.driver`.
    expect(run(repo, ['git', 'config', '--get', 'merge.as-built-log.name']).stdout.trim()).toBe('')
    expect(run(repo, ['git', 'config', '--get', 'merge.as-built-log.driver']).stdout.trim()).toBe('')
    // Which means the repo still MERGES, rather than aborting with exit 128.
    expect(run(repo, ['git', 'merge', 'other']).code).not.toBe(128)
  }, 30_000)
})
