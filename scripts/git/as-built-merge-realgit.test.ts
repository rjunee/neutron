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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 * THE CHECKOUT SUPPLIES THE FILES BEING MERGED. IT MUST NOT ALSO SUPPLY THE INTERPRETER'S CONFIG.
 *
 * git runs a merge driver with its cwd at the top of the working tree being merged, and bun reads
 * `bunfig.toml` from its cwd. So a repository that commits a `bunfig.toml` carrying
 * `preload = ["./anything.ts"]` gets that file executed INSIDE the driver process, before any of our
 * code, on every merge of this path. The driver is a child of the publisher's `run_host`, whose
 * environment carries `GH_TOKEN` (`open/composer.ts` `makeLazyCredentialedHostRunner` →
 * `github/credential.ts` `githubProcessEnv`), so the payload reads the owner's credential out of
 * `process.env`.
 *
 * Round 1 fixed WHICH SCRIPT runs and left this open, which is the same mistake one layer down: the
 * interpreter's configuration is part of what an untrusted checkout supplies. The fix is
 * `--config=/dev/null` in the configured command; the test below proves it by running the attack
 * both ways against real git.
 */
describe('a checkout cannot inject code into the driver through bunfig.toml', () => {
  /** The scenario, plus a hostile `bunfig.toml` + payload committed at the base like any other file. */
  function hostileScenario(): { repo: string; forkPoint: string; canary: string } {
    const { repo, forkPoint } = scenario()
    const canary = join(repo, 'exfiltrated.txt')
    git(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'bunfig.toml'), 'preload = ["./exfil.ts"]\n')
    writeFileSync(
      join(repo, 'exfil.ts'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(canary)}, String(process.env.GH_TOKEN))\n`,
    )
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'a repo that ships its own bun configuration')
    return { repo, forkPoint, canary }
  }

  /** `replay`, but with a credential in the environment for the payload to reach for. */
  function replayWithToken(repo: string, forkPoint: string, label: string): Ran {
    const diff = join(repo, `${label}.diff`)
    const out = Bun.spawnSync(['git', 'diff', `${forkPoint}..build-two`], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
    writeFileSync(diff, new TextDecoder().decode(out.stdout))
    const worktree = join(repo, `.replay-${label}`)
    git(repo, 'worktree', 'add', '-q', '--detach', worktree, 'main')
    const res = Bun.spawnSync(['git', 'apply', '--3way', '--index', diff], {
      cwd: worktree,
      env: { ...process.env, GH_TOKEN: 'sentinel-credential-value' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      ok: res.exitCode === 0,
      code: res.exitCode,
      stdout: new TextDecoder().decode(res.stdout),
      stderr: new TextDecoder().decode(res.stderr),
    }
  }

  test('the payload fires WITHOUT the flag and is inert WITH it — same repo, same merge, one flag apart', () => {
    const { repo, forkPoint, canary } = hostileScenario()
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)

    const installed = run(repo, ['git', 'config', '--get', 'merge.as-built-log.driver']).stdout.trim()
    expect(installed).toContain('--config=/dev/null')

    // CONTROL FIRST — prove the attack is real and this scenario reaches it. The ONLY change is
    // removing the flag from the configured command; a test asserting "no canary" is worthless
    // without the half that shows a canary is producible at all.
    git(repo, 'config', 'merge.as-built-log.driver', installed.replace(' --config=/dev/null', ''))
    const unprotected = replayWithToken(repo, forkPoint, 'exfil-control')
    expect(unprotected.ok).toBe(true) // the merge still worked — the payload is silent, which is the point
    expect(existsSync(canary)).toBe(true)
    expect(readFileSync(canary, 'utf8')).toBe('sentinel-credential-value')
    rmSync(canary)

    // …and now the command the installer actually writes.
    git(repo, 'config', 'merge.as-built-log.driver', installed)
    const protectedRun = replayWithToken(repo, forkPoint, 'exfil-treatment')

    // THE PROPERTY: nothing from the checkout ran.
    expect(existsSync(canary)).toBe(false)

    // …and it did not buy that by breaking the merge, which would be a different bug wearing the
    // same green tick.
    expect(protectedRun.ok).toBe(true)
    const merged = readFileSync(join(repo, '.replay-exfil-treatment', 'docs', 'AS_BUILT.md'), 'utf8')
    expect(merged).not.toContain('<<<<<<<')
    expect(merged).toContain('## 2026-08-16 — build one shipped')
    expect(merged).toContain('## 2026-08-16 — build two shipped')
  }, 60_000)
})

/**
 * The installer's own header promises the two halves arrive "together or not at all". It has no
 * `errexit` and cannot safely take one — a `--unset` of an absent key exits 5 and a `grep -v` with
 * no output exits 1, both normal here — so that promise is kept by hand, and therefore has to be
 * tested by hand.
 *
 * TWO DISTINCT BAD STATES, MEASURED ON git 2.50.1 RATHER THAN ASSUMED:
 *
 *   • `merge.<name>.name` set with no `.driver` — git finds a declared driver with no command and
 *     REFUSES the merge outright:
 *
 *         fatal: custom merge driver as-built-log lacks command line.   (exit 128)
 *
 *     A clone in this state believes it is installed and cannot merge this path at all, which is
 *     strictly worse than the conflict the driver removes. Reachable in the unfixed script whenever
 *     the first config write lands and the second does not.
 *
 *   • the attribute written with NO config at all — git falls back to its built-in merge silently,
 *     so the clone reports "merge drivers: installed" and goes on conflicting exactly as before.
 *     Quieter, still a lie. Reachable in the unfixed script whenever the config is unwritable: the
 *     writes failed, nothing checked them, and the attribute was appended anyway on exit 0.
 */
describe('the installer under a locked config — the half-installed state must be impossible', () => {
  function freshRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'as-built-lock-'))
    created.push(repo)
    git(repo, 'init', '-q', '-b', 'main')
    mkdirSync(join(repo, 'scripts', 'git'), { recursive: true })
    cpSync(join(REPO_ROOT, 'scripts', 'install-merge-drivers.sh'), join(repo, 'scripts', 'install-merge-drivers.sh'))
    cpSync(join(REPO_ROOT, 'scripts', 'git', 'as-built-merge-driver.ts'), join(repo, 'scripts', 'git', 'as-built-merge-driver.ts'))
    cpSync(join(REPO_ROOT, 'scripts', 'git', 'as-built-log-merge.ts'), join(repo, 'scripts', 'git', 'as-built-log-merge.ts'))
    return repo
  }

  function commonDir(repo: string): string {
    return git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.trim()
  }

  function attributes(repo: string): string {
    const path = join(commonDir(repo), 'info', 'attributes')
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  test('a config write it cannot make is LOUD, and writes no attribute', () => {
    const repo = freshRepo()
    const lock = join(commonDir(repo), 'config.lock')
    writeFileSync(lock, '')

    const install = run(repo, ['bash', 'scripts/install-merge-drivers.sh'])

    // Loud: the old script exited 0 here, having written the fatal half.
    expect(install.ok).toBe(false)
    expect(install.stderr).toContain('NOT INSTALLED')

    // And the state it left is the SAFE one, not the fatal one.
    expect(attributes(repo)).not.toContain('merge=as-built-log')
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(false)

    // CONTROL — the lock is what stopped it, not something incidental about this repo: remove it,
    // change nothing else, and the same command installs both halves.
    rmSync(lock)
    const retry = run(repo, ['bash', 'scripts/install-merge-drivers.sh'])
    expect(retry.ok).toBe(true)
    expect(attributes(repo)).toContain('merge=as-built-log')
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)
  }, 30_000)

  test('a lock arriving AFTER a successful install cannot leave an orphaned attribute behind', () => {
    // The attribute is already present and correct; a re-run that cannot confirm the driver must
    // not be the thing that strands it. (Re-running an installer is routine — every build does.)
    const repo = freshRepo()
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)

    const lock = join(commonDir(repo), 'config.lock')
    writeFileSync(lock, '')
    const rerun = run(repo, ['bash', 'scripts/install-merge-drivers.sh'])
    expect(rerun.ok).toBe(false)
    rmSync(lock)

    // Whatever the re-run did, the clone is never left with an attribute git has no driver for:
    // either both halves are present, or neither is.
    const hasAttribute = attributes(repo).includes('merge=as-built-log')
    const hasDriver = run(repo, ['git', 'config', '--get', 'merge.as-built-log.driver']).stdout.trim() !== ''
    expect(hasAttribute).toBe(hasDriver)
  }, 30_000)

  test('a lone .driver with NO .name is a WORKING driver — which is why ordering can replace a rollback', () => {
    // The measurement the ordering rests on, pinned rather than asserted in a comment. If git ever
    // started requiring `.name`, writing `.driver` first would stop being safe and this goes red.
    const repo = freshRepo()
    const realGit = Bun.which('git')
    expect(realGit).not.toBeNull()

    const bin = join(repo, 'shim-bin')
    mkdirSync(bin, { recursive: true })
    const shim = join(bin, 'git')
    writeFileSync(
      shim,
      [
        '#!/usr/bin/env bash',
        'for arg in "$@"; do',
        '  if [ "$arg" = "merge.as-built-log.name" ]; then',
        '    echo "error: could not lock config file .git/config: File exists" >&2',
        '    exit 255',
        '  fi',
        'done',
        `exec ${JSON.stringify(realGit)} "$@"`,
        '',
      ].join('\n'),
    )
    chmodSync(shim, 0o755)

    const res = Bun.spawnSync(['bash', 'scripts/install-merge-drivers.sh'], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // The cosmetic half failed; the install still succeeded and both load-bearing halves are there.
    expect(res.exitCode).toBe(0)
    expect(run(repo, ['git', 'config', '--get', 'merge.as-built-log.name']).stdout.trim()).toBe('')
    expect(run(repo, ['git', 'config', '--get', 'merge.as-built-log.driver']).stdout.trim()).not.toBe('')
    expect(attributes(repo)).toContain('merge=as-built-log')
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)

    // …and git AGREES it is a usable driver: a real three-way merge through it, with no `.name` set.
    git(repo, 'config', 'user.email', 'trident-test@neutron.local')
    git(repo, 'config', 'user.name', 'Trident Test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeLog(repo, HISTORY)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'checkout', '-q', '-b', 'other')
    writeLog(repo, [...entry('2026-08-16', 'theirs', 'Written by theirs.'), ...HISTORY])
    git(repo, 'commit', '-qam', 'theirs')
    git(repo, 'checkout', '-q', 'main')
    writeLog(repo, [...entry('2026-08-16', 'ours', 'Written by ours.'), ...HISTORY])
    git(repo, 'commit', '-qam', 'ours')
    const merge = run(repo, ['git', 'merge', '--no-edit', 'other'])
    expect(merge.stderr).not.toContain('lacks command line')
    expect(merge.ok).toBe(true)
    const merged = readFileSync(join(repo, 'docs', 'AS_BUILT.md'), 'utf8')
    expect(merged).toContain('Written by ours.')
    expect(merged).toContain('Written by theirs.')
  }, 30_000)

  test('the DRIVER config write failing leaves no declared-but-commandless driver behind', () => {
    // The exit-128 state is `merge.<name>.name` set with `merge.<name>.driver` unset. The script
    // now writes `.driver` FIRST and stops there on failure, so a shim rejecting that key must
    // leave the config completely empty — not merely rolled back. A whole-config lock cannot
    // distinguish those two outcomes, which is why this uses a key-specific shim.
    const repo = freshRepo()
    const realGit = Bun.which('git')
    expect(realGit).not.toBeNull()

    const bin = join(repo, 'shim-bin')
    mkdirSync(bin, { recursive: true })
    const shim = join(bin, 'git')
    writeFileSync(
      shim,
      [
        '#!/usr/bin/env bash',
        'for arg in "$@"; do',
        '  if [ "$arg" = "merge.as-built-log.driver" ]; then',
        '    echo "error: could not lock config file .git/config: File exists" >&2',
        '    exit 255',
        '  fi',
        'done',
        `exec ${JSON.stringify(realGit)} "$@"`,
        '',
      ].join('\n'),
    )
    chmodSync(shim, 0o755)

    const res = Bun.spawnSync(['bash', 'scripts/install-merge-drivers.sh'], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(res.exitCode).not.toBe(0)

    // The lone `.name` — the thing that makes git refuse the merge with exit 128 — was never
    // written in the first place, and neither was the attribute that would point at it.
    const name = run(repo, ['git', 'config', '--get', 'merge.as-built-log.name'])
    expect(name.stdout.trim()).toBe('')
    expect(attributes(repo)).not.toContain('merge=as-built-log')
    // No `--unset` was needed to get there — the earlier version's rollback was a THIRD write that
    // the same held lock would have blocked, so its absence here is the fix, not an omission.
    expect(new TextDecoder().decode(res.stderr)).not.toContain('--unset')

    // CONTROL — the shim is what stopped it: the identical command without it installs both halves.
    const clean = run(repo, ['bash', 'scripts/install-merge-drivers.sh'])
    expect(clean.ok).toBe(true)
    expect(run(repo, ['git', 'config', '--get', 'merge.as-built-log.name']).stdout.trim()).not.toBe('')
    expect(attributes(repo)).toContain('merge=as-built-log')
  }, 30_000)
})
