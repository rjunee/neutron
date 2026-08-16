/**
 * REAL-GIT proof that two concurrent builds can both publish.
 *
 * WHAT WAS MEASURED, AND WHY A MOCK CANNOT PROVE IT FIXED. On 2026-08-15T23:20Z three concurrent
 * builds failed at publish on `docs/AS_BUILT.md` and nothing else. The cause is structural: the log
 * is newest-first, so every build prepends its entry at the SAME OFFSET under the SAME three header
 * lines, and git's three-way merge sees two different insertions against identical context. A
 * stubbed merge would prove nothing about that — the whole question is what REAL git does. So this
 * file uses a real repository, real commits, a real moved base, and the publisher's own replay
 * mechanism (`git apply --3way --index`, `trident/orchestrator.ts:758`), the way
 * `trident/publish-rebase-realgit.test.ts` does.
 *
 * THE FAILURE IS PROVEN BEFORE THE FIX IS. `replay()` is run twice over the identical scenario:
 * once with the merge driver NOT installed, which MUST conflict, and once with it installed, which
 * MUST merge. The first half is the control. Without it "the driver works" is unfalsifiable — a
 * test that only ever runs the fixed configuration passes just as happily when the scenario it
 * describes was never conflicting in the first place.
 *
 * THE SCENARIO CARRIES THE TRACKED `.gitattributes`, BECAUSE THAT IS NOW THE MECHANISM. An earlier
 * cut of this file copied only the three scripts, which meant it measured a repository layout the
 * real one does not have. `docs/AS_BUILT.md merge=<driver>` is a committed line, so the fixture
 * commits it too — and the `union` half of `describe('union is not safe here')` below points that
 * same tracked line at git's built-in driver to show what #308 actually does to two entries.
 *
 * BOTH FILES THE TASK NAMES ARE IN PLAY. Each branch writes its own plan at
 * `.trident/plans/<branch>.md` AND prepends its own log entry, because the acceptance criterion is
 * two builds that do both landing together — not two builds that touch one file each.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
function scenario(mergeAttribute = 'as-built-log'): { repo: string; forkPoint: string } {
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

  // THE BINDING IS TRACKED, so the fixture commits it exactly as the real repo does. Parameterised
  // only so the `union` comparison below can point the same line at git's built-in driver.
  writeFileSync(join(repo, '.gitattributes'), `docs/AS_BUILT.md merge=${mergeAttribute}\n`)

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

// ----------------------------------------------------------------------------------------------
// WHY NOT `merge=union` — the question this PR has to answer, because #308 already put that line in
// the tracked `.gitattributes` on main. Union is right about the goal and wrong about the UNIT.
// ----------------------------------------------------------------------------------------------

/** A line BOTH entries write. This is the line union loses. */
const SIGN_OFF = 'Verified with a control.'

/**
 * The same two concurrent builds, but their entries share a line — a sign-off both of them write.
 * Real entries in this log share plenty: a lead-in, a sign-off, a blank line. That is not a
 * contrived fixture, it is what a generated entry looks like.
 */
function sharedBoilerplateScenario(mergeAttribute: string): { repo: string; forkPoint: string } {
  const repo = mkdtempSync(join(tmpdir(), 'as-built-union-'))
  created.push(repo)

  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'trident-test@neutron.local')
  git(repo, 'config', 'user.name', 'Trident Test')
  git(repo, 'config', 'commit.gpgsign', 'false')

  mkdirSync(join(repo, 'docs'), { recursive: true })
  mkdirSync(join(repo, 'scripts', 'git'), { recursive: true })
  cpSync(join(REPO_ROOT, 'scripts', 'install-merge-drivers.sh'), join(repo, 'scripts', 'install-merge-drivers.sh'))
  cpSync(join(REPO_ROOT, 'scripts', 'git', 'as-built-merge-driver.ts'), join(repo, 'scripts', 'git', 'as-built-merge-driver.ts'))
  cpSync(join(REPO_ROOT, 'scripts', 'git', 'as-built-log-merge.ts'), join(repo, 'scripts', 'git', 'as-built-log-merge.ts'))
  writeFileSync(join(repo, '.gitattributes'), `docs/AS_BUILT.md merge=${mergeAttribute}\n`)

  const shared = (date: string, who: string): string[] => [
    `## ${date} — ${who} shipped`,
    '',
    'What changed:',
    '',
    `- ${who} detail`,
    '',
    SIGN_OFF,
    '',
  ]

  writeLog(repo, HISTORY)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  const forkPoint = git(repo, 'rev-parse', 'HEAD').stdout.trim()

  git(repo, 'checkout', '-q', '-b', 'build-one')
  writeLog(repo, [...shared('2026-08-15', 'build one'), ...HISTORY])
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'build one')

  git(repo, 'checkout', '-q', '-b', 'build-two', forkPoint)
  writeLog(repo, [...shared('2026-08-17', 'build two'), ...HISTORY])
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'build two')

  git(repo, 'checkout', '-q', 'main')
  git(repo, 'merge', '-q', '--no-edit', 'build-one')

  return { repo, forkPoint }
}

describe('union is not safe here, and the difference is measured rather than argued', () => {
  test('UNION silently drops a line the two entries share, and inverts the date order', () => {
    // No driver is installed and none is needed — `union` is built into git, so this is exactly
    // what main does today under #308, and what GitHub's server-side merge would do.
    const { repo, forkPoint } = sharedBoilerplateScenario('union')
    const { applied, unmerged, worktree } = replay(repo, forkPoint, 'union')

    // Union NEVER conflicts. That is the whole danger: there is nothing to review.
    expect(applied.ok).toBe(true)
    expect(unmerged).toEqual([])

    const merged = readFileSync(join(worktree, 'docs', 'AS_BUILT.md'), 'utf8')
    const lines = merged.split('\n')
    expect(merged).toContain('## 2026-08-15 — build one shipped')
    expect(merged).toContain('## 2026-08-17 — build two shipped')

    // THE CORRUPTION. Both entries were written with the sign-off; the merged file has ONE copy,
    // because union emits the lines the two sides SHARE only once. Build one's entry lost its last
    // line to build two's, at exit 0, with no marker and nothing to review.
    expect(lines.filter((l) => l === SIGN_OFF).length).toBe(1)

    // and it is specifically the FIRST entry that was truncated — the sign-off now sits below the
    // second heading, inside an entry that is not the one that wrote it.
    const firstHeading = lines.indexOf('## 2026-08-15 — build one shipped')
    const secondHeading = lines.indexOf('## 2026-08-17 — build two shipped')
    expect(lines.indexOf(SIGN_OFF)).toBeGreaterThan(secondHeading)

    // ACCEPTANCE 3, violated: the file promises newest-first and union emits ours-then-theirs
    // regardless of date, so the OLDER entry is on top.
    expect(firstHeading).toBeLessThan(secondHeading)
  }, 30_000)

  test('the ENTRY-AWARE driver keeps both copies and orders them newest-first', () => {
    // The identical scenario, the identical shared line — only the driver differs. This is the
    // A/B that makes the previous test a finding about `union` rather than about the fixture.
    const { repo, forkPoint } = sharedBoilerplateScenario('as-built-log')
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)

    const { applied, unmerged, worktree } = replay(repo, forkPoint, 'entry-aware')
    expect(applied.ok).toBe(true)
    expect(unmerged).toEqual([])

    const merged = readFileSync(join(worktree, 'docs', 'AS_BUILT.md'), 'utf8')
    const lines = merged.split('\n')

    // BOTH entries keep their own sign-off — nothing was absorbed into anything else.
    expect(lines.filter((l) => l === SIGN_OFF).length).toBe(2)

    // Newest first, as the file's own first line promises.
    expect(lines.filter((l) => l.startsWith('## '))).toEqual([
      '## 2026-08-17 — build two shipped',
      '## 2026-08-15 — build one shipped',
      '## 2026-08-14 — the by-path build brief is proven in lockstep',
      '## 2026-08-13 — an earlier thing shipped',
    ])
  }, 30_000)
})

// ----------------------------------------------------------------------------------------------
// The installer's own safety properties. Each of these was a review finding, and each is a state
// the installer could previously reach.
// ----------------------------------------------------------------------------------------------

describe('the installer cannot leave a clone in a state that is worse than no install', () => {
  test('THE FATAL STATE IS UNREACHABLE — `.name` is never written, so it can never outlive `.driver`', () => {
    // `merge.<d>.name` set with `merge.<d>.driver` unset is the ONE config git treats as fatal:
    //     fatal: custom merge driver as-built-log lacks command line.   (exit 128)
    // The old installer wrote `.name` FIRST, unchecked, with no `set -e` — so a failed or
    // interrupted install left exactly that, and every merge of the log died at 128 while the
    // script printed "installed" and exited 0. Not writing `.name` at all removes the state by
    // construction rather than guarding against it.
    const { repo } = scenario()
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)

    expect(run(repo, ['git', 'config', '--get', 'merge.as-built-log.driver']).stdout.trim()).not.toBe('')
    expect(run(repo, ['git', 'config', '--get', 'merge.as-built-log.name']).stdout.trim()).toBe('')

    // CONTROL — git is genuinely fatal in that state, so the assertion above is protecting against
    // something real. Set `.name`, drop `.driver`, and the merge dies at 128.
    git(repo, 'config', 'merge.as-built-log.name', 'entry-aware')
    git(repo, 'config', '--unset', 'merge.as-built-log.driver')
    git(repo, 'checkout', '-q', 'build-two')
    const fatal = run(repo, ['git', 'merge', '--no-edit', 'main'])
    expect(fatal.code).toBe(128)
    expect(fatal.stderr).toContain('lacks command line')
  }, 30_000)

  test('the configured driver path survives the worktree that installed it', () => {
    // The config is COMMON to every worktree, so an absolute path into whichever worktree ran the
    // install is a time bomb: trident installs from a throwaway linked worktree, that worktree is
    // removed, and every other worktree is left pointing at a script that no longer exists. This
    // was observed in the real repo — a rebase failed with "Module not found" from a config naming
    // a deleted `.worktrees/...` path.
    const { repo } = scenario()
    const linked = join(repo, '.installer-worktree')
    git(repo, 'worktree', 'add', '-q', '--detach', linked, 'main')

    expect(run(linked, ['bash', join(linked, 'scripts', 'install-merge-drivers.sh')]).ok).toBe(true)
    const configured = run(repo, ['git', 'config', '--get', 'merge.as-built-log.driver']).stdout.trim()
    expect(configured).not.toContain('.installer-worktree')
    expect(configured).toContain(join(repo, 'scripts', 'git', 'as-built-merge-driver.ts'))

    // and it still works after that worktree is gone, which is the property that actually matters
    git(repo, 'worktree', 'remove', '--force', linked)
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)
  }, 30_000)

  test('--check reports NOT usable when the configured script has been deleted', () => {
    // A nonempty config value is not a working one. `--check` used to test only that the string
    // was set, which is exactly the state that produced "Module not found" mid-rebase.
    const { repo } = scenario()
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)

    rmSync(join(repo, 'scripts', 'git', 'as-built-merge-driver.ts'))
    const check = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
    expect(check.ok).toBe(false)
    expect(check.stderr).toContain('no driver script at')
  }, 30_000)

  test('a path containing a space is quoted, so the driver still runs', () => {
    // git expands `merge.<d>.driver` through a shell. An unquoted path with a space word-splits and
    // the driver dies on every merge — a real hazard on macOS ("Application Support") and for any
    // checkout under a directory a user named with a space.
    const spaced = mkdtempSync(join(tmpdir(), 'as built spaced-'))
    created.push(spaced)
    const { repo, forkPoint } = scenario()
    const moved = join(spaced, 'repo')
    cpSync(repo, moved, { recursive: true })

    expect(run(moved, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
    const { applied, unmerged, worktree } = replay(moved, forkPoint, 'spaced')
    expect(applied.ok).toBe(true)
    expect(unmerged).toEqual([])
    const merged = readFileSync(join(worktree, 'docs', 'AS_BUILT.md'), 'utf8')
    expect(merged).toContain('## 2026-08-16 — build one shipped')
    expect(merged).toContain('## 2026-08-16 — build two shipped')
  }, 30_000)
})
