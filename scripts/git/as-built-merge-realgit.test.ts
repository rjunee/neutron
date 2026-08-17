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

function sameHeadingScenario(): string {
  const repo = mkdtempSync(join(tmpdir(), 'as-built-same-heading-realgit-'))
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
  writeLog(repo, HISTORY)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'checkout', '-q', '-b', 'ours')
  writeLog(repo, [...entry('2026-08-16', 'same concurrent title', 'Body from ours.'), ...HISTORY])
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'ours')
  git(repo, 'checkout', '-q', '-b', 'theirs', 'main')
  writeLog(repo, [...entry('2026-08-16', 'same concurrent title', 'Body from theirs.'), ...HISTORY])
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'theirs')
  git(repo, 'checkout', '-q', 'ours')
  return repo
}

test('real git unions different additions under one heading without conflict markers', () => {
  const repo = sameHeadingScenario()
  expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
  const merged = run(repo, ['git', 'merge', '--no-edit', 'theirs'])
  expect(merged.ok).toBe(true)
  const text = readFileSync(join(repo, 'docs', 'AS_BUILT.md'), 'utf8')
  expect(text).not.toContain('<<<<<<<')
  expect(text).toContain('## 2026-08-16 — same concurrent title\n\nBody from ours.')
  expect(text).toContain('## 2026-08-16 — same concurrent title (2)\n\nBody from theirs.')
  for (const body of ['History that must survive.', 'More history that must survive.']) expect(text).toContain(body)
}, 30_000)

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
 * THE REFUSAL HAS TO SURVIVE THE TRIP THROUGH GIT, WHICH IS A DIFFERENT CLAIM FROM "IT REFUSES".
 *
 * The merge function returning `{ ok: false }` is worth nothing on its own: what git DOES with a
 * refusal is decided by the driver, and delegating one to `git merge-file` throws it away. A
 * one-sided deletion is a clean hunk to a line-based merge — git resolves it, exits 0, writes no
 * markers — so a refusal that names a missing entry and then delegates deletes the entry anyway,
 * loudly on stderr and silently in the file. Measured with the real installer through a real
 * `git merge` below, both halves in the same test.
 */
describe('an entry that exists on one side and not the other stops the merge, through real git', () => {
  /** A log deep enough that the deletion and the addition are separate hunks — the ordinary shape. */
  const DEEP = Array.from({ length: 20 }, (_, i) => {
    const n = 20 - i
    return entry(`2026-07-${String(n).padStart(2, '0')}`, `entry ${n}`, `body of entry ${n}`)
  })

  function truncationScenario(): string {
    const repo = mkdtempSync(join(tmpdir(), 'as-built-truncation-'))
    created.push(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'trident-test@neutron.local')
    git(repo, 'config', 'user.name', 'Trident Test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    mkdirSync(join(repo, 'docs'), { recursive: true })
    mkdirSync(join(repo, 'scripts', 'git'), { recursive: true })
    for (const rel of [
      ['scripts', 'install-merge-drivers.sh'],
      ['scripts', 'git', 'as-built-merge-driver.ts'],
      ['scripts', 'git', 'as-built-log-merge.ts'],
    ]) {
      cpSync(join(REPO_ROOT, ...rel), join(repo, ...rel))
    }

    writeLog(repo, DEEP.flat())
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')

    // `other` is an ordinary concurrent build: it prepends its entry and touches nothing else.
    git(repo, 'checkout', '-q', '-b', 'other')
    writeLog(repo, [...entry('2026-08-16', 'an ordinary concurrent build', 'Written by the other build.'), ...DEEP.flat()])
    git(repo, 'commit', '-qam', 'other')

    // `main` arrives having lost one entry from the middle — a bad apply, a partial checkout, a
    // hand-edit. Every one of those presents exactly like a deliberate deletion.
    git(repo, 'checkout', '-q', 'main')
    writeLog(repo, DEEP.filter((_, i) => i !== 10).flat())
    git(repo, 'commit', '-qam', 'a side that arrived one entry short')
    return repo
  }

  test('CONTROL — git alone calls it clean and the entry leaves without a word', () => {
    // Not a hypothetical fallback: this is what the driver used to hand the case to.
    const repo = truncationScenario()
    const merged = run(repo, ['git', 'merge', '--no-edit', 'other'])
    expect(merged.ok).toBe(true)
    const log = readFileSync(join(repo, 'docs', 'AS_BUILT.md'), 'utf8')
    expect(log).not.toContain('<<<<<<<')
    expect(log).not.toContain('body of entry 10')
  }, 30_000)

  test('with the driver installed the merge STOPS, and both sides are still readable in the file', () => {
    const repo = truncationScenario()
    expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)

    const merged = run(repo, ['git', 'merge', '--no-edit', 'other'])
    expect(merged.ok).toBe(false)
    expect(merged.stderr + merged.stdout).not.toContain('fatal')

    // git is left holding a real conflict — the path is unmerged, so nothing commits by accident.
    const unmerged = run(repo, ['git', 'diff', '--name-only', '--diff-filter=U'])
    expect(unmerged.stdout.trim()).toBe('docs/AS_BUILT.md')

    const log = readFileSync(join(repo, 'docs', 'AS_BUILT.md'), 'utf8')
    expect(log).toContain('<<<<<<< ours')
    expect(log).toContain('>>>>>>> theirs')
    // NOTHING WAS LOST ON THE WAY TO THE CONFLICT. Every entry from both sides is present, including
    // the one this merge would have deleted, and the new entry the other build wrote.
    expect(log).toContain('body of entry 10')
    expect(log).toContain('Written by the other build.')
    for (const [, , body] of DEEP) expect(log).toContain(body as string)
    // …and the marker line says why, so the file explains itself without the stderr.
    expect(log).toContain('append-only')
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

    // CONTROL FIRST — prove the attack is real and this scenario reaches it. Both controls are
    // removed and nothing else changes; a test asserting "no canary" is worthless without the half
    // that shows a canary is producible at all.
    const undefended = installed.replace(' --config=/dev/null', '').replace(/^\S*env(?: -u \S+)+ /, '')
    expect(undefended).not.toContain('-u GH_TOKEN')
    git(repo, 'config', 'merge.as-built-log.driver', undefended)
    const unprotected = replayWithToken(repo, forkPoint, 'exfil-control')
    expect(unprotected.ok).toBe(true) // the merge still worked — the payload is silent, which is the point
    expect(existsSync(canary)).toBe(true)
    expect(readFileSync(canary, 'utf8')).toBe('sentinel-credential-value')
    rmSync(canary)

    // THE SECOND CONTROL IS THE POINT OF HAVING TWO: with the interpreter still unconfigured but
    // the credential scrubbed, the payload STILL RUNS — and finds nothing. Each control fails
    // independently of the other, which is why both are installed rather than whichever one was
    // discovered first.
    git(repo, 'config', 'merge.as-built-log.driver', installed.replace(' --config=/dev/null', ''))
    expect(replayWithToken(repo, forkPoint, 'exfil-scrubbed').ok).toBe(true)
    expect(existsSync(canary)).toBe(true)
    expect(readFileSync(canary, 'utf8')).toBe('undefined')
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
 * The installer's own header promises "never the FATAL half, always loudly" — deliberately NOT
 * "never a half", because driver-without-attribute is inert and IS reachable. Only the fatal half
 * is claimed impossible, and that is what these tests bound. It has no `errexit` and cannot safely
 * take one — a `--unset` of an absent key exits 5 and a `grep -v` with no output exits 1, both
 * normal here — so the promise is kept by hand, and therefore has to be tested by hand.
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
describe('the installer under a locked config — the FATAL half-state must be impossible', () => {
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

  /**
   * `--check` HAS TO VERIFY WHAT IS INSTALLED, NOT MERELY THAT SOMETHING IS.
   *
   * The check used to ask two yes/no questions — driver config non-empty, attribute line present —
   * and answer "installed" to ANY command. So a clone that ran an earlier version of the installer
   * reported success while still holding that version's command, and none of the hardening ever
   * reached it. MEASURED on git 2.50.1 before the fix: install, replace the config value with the
   * predecessor's `bun <driver> %O %A %B %L %P` and leave the attribute alone, and `--check`
   * printed "merge drivers: installed" and exited 0.
   *
   * That is the same false-pass class the driver itself exists to close, one layer out: a check
   * that cannot tell the hardened driver from its predecessor is exactly what keeps an
   * already-installed clone on the vulnerable one, silently and indefinitely.
   */
  describe('--check against the command actually installed', () => {
    /** The command the installer wrote into this repo, which is the reference for every mutation. */
    function installed(repo: string): string {
      return run(repo, ['git', 'config', '--get', 'merge.as-built-log.driver']).stdout.trim()
    }

    /**
     * The two absolute paths the installed command carries, read back out of it.
     *
     * Taken from the command rather than resolved independently so the fixtures below reproduce
     * what the installer ACTUALLY wrote. The predecessor fixture used to hardcode a bare `bun`,
     * which no version of this script has ever written — `origin/main` wrote `"$BUN $DRIVER_SCRIPT
     * …"` with `$BUN` already resolved by `command -v`. A fixture that is not the thing it names
     * still goes red for the right reason here, but it proves the check rejects a command nobody
     * has, which is a weaker claim than the one the test makes.
     */
    function words(command: string): { bun: string; driver: string } {
      const m = command.match(/'([^']*)' --config=\/dev\/null --env-file=\/dev\/null '([^']*)'/)
      if (!m) throw new Error(`could not read the two paths out of: ${command}`)
      return { bun: m[1]!, driver: m[2]! }
    }

    test('the PREDECESSOR command is reported STALE, and the hardened one still passes', () => {
      const repo = freshRepo()
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)

      const hardened = installed(repo)
      // The command as it stood before this change: no credential scrub, no `--config`, no
      // `--env-file`. Everything else about the clone — attribute, driver name, script path — is
      // left exactly as the installer left it, so the command is the ONLY thing under test.
      //
      // Spelled with the RESOLVED bun and driver paths, because that is what the predecessor
      // actually wrote (`origin/main` scripts/install-merge-drivers.sh:145 — `"$BUN $DRIVER_SCRIPT
      // %O %A %B %L %P"`, both already absolute). A literal `bun` here would be a command no
      // release of this script has ever installed.
      const { bun, driver } = words(hardened)
      const predecessor = `${bun} ${driver} %O %A %B %L %P`
      expect(predecessor).not.toBe(hardened)
      git(repo, 'config', 'merge.as-built-log.driver', predecessor)
      expect(attributes(repo)).toContain('merge=as-built-log')

      const stale = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
      expect(stale.ok).toBe(false)
      expect(stale.stderr).toContain('STALE')
      // It names both commands, because "stale" with nothing to compare is not actionable.
      expect(stale.stderr).toContain(predecessor)
      expect(stale.stderr).toContain(hardened)

      // CONTROL — the replaced command is what made it stale, not something incidental about this
      // repo or about running `--check` twice. Put the hardened command back, change nothing else.
      git(repo, 'config', 'merge.as-built-log.driver', hardened)
      const restored = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
      expect(restored.ok).toBe(true)
      expect(restored.stdout).toContain('merge drivers: installed')
    }, 30_000)

    test('MUTATION — dropping ANY ONE hardening element is caught, not just a wholesale swap', () => {
      // A check that only recognises the predecessor verbatim would pass every command that is
      // hardened in three ways out of four. Each mutation below removes exactly one property and
      // leaves the rest of the command byte-identical, so a pass here means the check is sensitive
      // to that property specifically.
      const repo = freshRepo()
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
      const hardened = installed(repo)

      // EVERY separable element, one at a time. The five `-u` names are five independent removals
      // in the emitted command (scripts/install-merge-drivers.sh `driver_command`), so mutating
      // two of them and claiming "ANY ONE" was an overclaim: a check keyed on `GH_TOKEN` alone
      // would have passed a command still leaking `GITHUB_TOKEN` and this table would have been
      // green. They are enumerated rather than looped so a name added to the scrub without a line
      // added here shows up as an untested element.
      const mutations: Array<[string, string]> = [
        ['the bunfig preload guard', hardened.replace(' --config=/dev/null', '')],
        ['the .env autoload guard', hardened.replace(' --env-file=/dev/null', '')],
        ['the GH_TOKEN scrub', hardened.replace('-u GH_TOKEN ', '')],
        ['the GITHUB_TOKEN scrub', hardened.replace('-u GITHUB_TOKEN ', '')],
        ['the GIT_CONFIG_COUNT scrub', hardened.replace('-u GIT_CONFIG_COUNT ', '')],
        ['the GIT_CONFIG_KEY_0 scrub', hardened.replace('-u GIT_CONFIG_KEY_0 ', '')],
        ['the GIT_CONFIG_VALUE_0 scrub', hardened.replace('-u GIT_CONFIG_VALUE_0 ', '')],
        ['the env wrapper entirely', hardened.replace(/^\S*env(\s+-u\s+\S+)+\s+/, '')],
        ['the merge placeholders git substitutes', hardened.replace(' %O %A %B %L %P', '')],
      ]

      for (const [what, mutated] of mutations) {
        // The mutation LANDED — `String.replace` is a no-op on a miss, and a no-op mutation would
        // make the assertion below pass for the wrong reason.
        expect(mutated, `mutation did not change the command: ${what}`).not.toBe(hardened)
        git(repo, 'config', 'merge.as-built-log.driver', mutated)
        const checked = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
        expect(checked.ok, `--check accepted a command missing ${what}`).toBe(false)
        expect(checked.stderr).toContain('STALE')
      }

      // CONTROL — every one of those failed on its mutation and not on the loop itself.
      git(repo, 'config', 'merge.as-built-log.driver', hardened)
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)
    }, 60_000)

    test('a stale clone is self-healed by the ordinary re-run — the remedy the message names', () => {
      // The check is only worth its exit code if the fix it prints actually fixes it. The installer
      // is idempotent, so the remedy for a stale clone is the same command a fresh one runs.
      const repo = freshRepo()
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
      const hardened = installed(repo)

      git(repo, 'config', 'merge.as-built-log.driver', 'bun as-built-merge-driver.ts %O %A %B %L %P')
      const stale = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
      expect(stale.ok).toBe(false)
      expect(stale.stderr).toContain("Re-run 'bash scripts/install-merge-drivers.sh'")

      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
      expect(installed(repo)).toBe(hardened)
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)
    }, 30_000)

    test('a clone whose two halves are BOTH missing still reports NOT installed, not STALE', () => {
      // The stale verdict must not swallow the two states that were already reported. A clone that
      // never ran the installer is not "running an older driver" and telling it so would send the
      // reader looking for a driver that was never there.
      const repo = freshRepo()
      const virgin = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
      expect(virgin.ok).toBe(false)
      expect(virgin.stderr).toContain('NOT installed')
      expect(virgin.stderr).not.toContain('STALE')

      // …and so does a clone with the right driver and no attribute, which is the inert half.
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
      const attrs = join(commonDir(repo), 'info', 'attributes')
      writeFileSync(attrs, '')
      const inert = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
      expect(inert.ok).toBe(false)
      expect(inert.stderr).toContain('NOT installed')
      expect(inert.stderr).not.toContain('STALE')
    }, 30_000)

    test('MUTATION — an interpreter that is EXECUTABLE but is not bun is STALE, not installed', () => {
      // The check used to gate the interpreter on `[ -x ]` alone, which says "some file here can be
      // executed" — true of nearly everything on a unix box. Each entry below is a real path on the
      // host, differs from the installed command in the bun word and NOTHING else, and false-passed
      // as `merge drivers: installed` before this fix.
      const repo = freshRepo()
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
      const hardened = installed(repo)
      const { bun } = words(hardened)

      const impostors: Array<[string, string]> = [
        // Executable, a regular file, exits 0 without writing %A — see the end-to-end below.
        ['an ordinary executable that is not bun', '/usr/bin/true'],
        // A DIRECTORY passes `-x`, where the bit means "searchable" rather than "runnable".
        ['a directory', '/usr/bin'],
        // A real interpreter, just not this one — the name is the only thing separating them.
        ['a different interpreter', '/bin/sh'],
      ]
      for (const [label, impostor] of impostors) {
        expect(existsSync(impostor)).toBe(true)
        const mutated = hardened.replace(`'${bun}'`, `'${impostor}'`)
        expect(mutated).not.toBe(hardened)
        git(repo, 'config', 'merge.as-built-log.driver', mutated)
        const checked = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
        expect(`${label}: exit ${checked.code}`).toBe(`${label}: exit 1`)
        expect(`${label}: ${checked.stderr}`).toContain('STALE')
      }

      // EACH PREDICATE ON ITS OWN. Every impostor above also fails the NAME test, so the three of
      // them together would stay green with `-f` or `-x` deleted — the check would be resting
      // entirely on the basename and the table would not notice. A cross-model reviewer caught
      // exactly that. These two are NAMED `bun` and fail on one predicate each.
      const named = mkdtempSync(join(tmpdir(), 'as-built-named-bun-'))
      created.push(named)

      // `-f` alone: a directory called `bun`. `-x` passes on it (the bit means "searchable"), and
      // so does the name, so this is red only while `-f` is there.
      const dirBun = join(named, 'dir', 'bun')
      mkdirSync(dirBun, { recursive: true })
      // `-x` alone: a regular file called `bun` with no execute bit. `-f` and the name both pass.
      const dullBun = join(named, 'plain', 'bun')
      mkdirSync(dirname(dullBun), { recursive: true })
      writeFileSync(dullBun, '#!/bin/sh\n')
      chmodSync(dullBun, 0o644)

      for (const [label, impostor] of [
        ['a DIRECTORY named bun — only `-f` rejects it', dirBun],
        ['a NON-EXECUTABLE file named bun — only `-x` rejects it', dullBun],
      ] as Array<[string, string]>) {
        const mutated = hardened.replace(`'${bun}'`, `'${impostor}'`)
        expect(mutated).not.toBe(hardened)
        git(repo, 'config', 'merge.as-built-log.driver', mutated)
        const checked = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
        expect(`${label}: exit ${checked.code}`).toBe(`${label}: exit 1`)
        expect(`${label}: ${checked.stderr}`).toContain('STALE')
      }

      // CONTROL — the interpreter word is what made each of those stale. Put the real one back,
      // change nothing else, and the same check passes.
      git(repo, 'config', 'merge.as-built-log.driver', hardened)
      const restored = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
      expect(restored.ok).toBe(true)
      expect(restored.stdout).toContain('merge drivers: installed')
    }, 30_000)

    test('WHY that matters — a non-bun interpreter makes git report a SUCCESSFUL merge that lost a side', () => {
      // The consequence, through real git, because "the check was too loose" understates it. A
      // driver that exits 0 without writing `%A` is a driver git believes: it takes the merge as
      // clean, keeps `%A` as it found it, and the other side's entries are gone with no conflict
      // and no message. `/usr/bin/true` is exactly that driver.
      // Two identical repositories differing in ONE word of the driver command, so the comparison
      // below is about the interpreter and about nothing else in the fixture.
      function twoBranchLog(interpreter: 'bun' | 'impostor'): { merged: Ran; log: string } {
        const repo = freshRepo()
        git(repo, 'config', 'user.email', 'trident-test@neutron.local')
        git(repo, 'config', 'user.name', 'Trident Test')
        git(repo, 'config', 'commit.gpgsign', 'false')
        mkdirSync(join(repo, 'docs'), { recursive: true })
        expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
        const hardened = installed(repo)
        if (interpreter === 'impostor') {
          const { bun } = words(hardened)
          git(repo, 'config', 'merge.as-built-log.driver', hardened.replace(`'${bun}'`, `'/usr/bin/true'`))
        }

        writeLog(repo, HISTORY)
        git(repo, 'add', '-A')
        git(repo, 'commit', '-qm', 'base')
        git(repo, 'checkout', '-q', '-b', 'side')
        writeLog(repo, [...entry('2026-08-16', 'the side build', 'Side entry.'), ...HISTORY])
        git(repo, 'commit', '-qam', 'side')
        git(repo, 'checkout', '-q', 'main')
        writeLog(repo, [...entry('2026-08-16', 'the mainline build', 'Mainline entry.'), ...HISTORY])
        git(repo, 'commit', '-qam', 'mainline')

        const merged = run(repo, ['git', 'merge', 'side', '--no-edit'])
        return { merged, log: readFileSync(join(repo, 'docs', 'AS_BUILT.md'), 'utf8') }
      }

      // git is HAPPY, and the side's entry is simply not there. Both halves matter: a conflict
      // would at least have been visible.
      const lost = twoBranchLog('impostor')
      expect(lost.merged.ok).toBe(true)
      expect(lost.log).toContain('the mainline build')
      expect(lost.log).not.toContain('the side build')

      // CONTROL — the real interpreter, same scenario, one word apart: both entries survive. So
      // the silent loss above is the impostor's doing and not something about this fixture.
      const kept = twoBranchLog('bun')
      expect(kept.merged.ok).toBe(true)
      expect(kept.log).toContain('the mainline build')
      expect(kept.log).toContain('the side build')
    }, 60_000)

    test('the attribute LINE being present is not the path being BOUND to the driver', () => {
      // `presence is not authorization`, applied to this script's own check. Attributes are
      // last-match-wins, so a later line reassigns `merge` while the grep for the installed line
      // still succeeds — the driver is configured, named, and never runs.
      const repo = freshRepo()
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)

      const attrs = join(commonDir(repo), 'info', 'attributes')
      writeFileSync(attrs, `${readFileSync(attrs, 'utf8')}docs/AS_BUILT.md merge=union\n`)

      // The installed line is still right there — which is precisely why grepping for it is not an
      // answer — and git nonetheless resolves the path to something else.
      expect(readFileSync(attrs, 'utf8')).toContain('docs/AS_BUILT.md merge=as-built-log')
      expect(git(repo, 'check-attr', 'merge', '--', 'docs/AS_BUILT.md').stdout).toContain('merge: union')

      const overridden = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
      expect(overridden.ok).toBe(false)
      expect(overridden.stderr).toContain('OVERRIDDEN')
      expect(overridden.stderr).toContain('merge=union')

      // CONTROL — the override is what did it. Drop that one line, touch nothing else.
      writeFileSync(attrs, 'docs/AS_BUILT.md merge=as-built-log\n')
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)
    }, 30_000)

    test('MEASUREMENT — a tracked .gitattributes cannot cause that override, in either direction', () => {
      // The message above deliberately does NOT send the reader to look in a tracked
      // `.gitattributes`, and that is a claim about git rather than a style choice:
      // `$GIT_DIR/info/attributes` outranks every other attributes source, so the tracked file
      // loses to it whichever way round the two are. Pinned here because the message asserts it,
      // and an assertion in a message is the thing that goes stale first.
      //
      // It is also the property the INSTALL depends on: this repository's tracked `.gitattributes`
      // binds this same path to `merge=union`, and a successful install has to displace it.
      const repo = freshRepo()
      git(repo, 'config', 'user.email', 'trident-test@neutron.local')
      git(repo, 'config', 'user.name', 'Trident Test')
      git(repo, 'config', 'commit.gpgsign', 'false')
      mkdirSync(join(repo, 'docs'), { recursive: true })
      writeFileSync(join(repo, 'docs', 'AS_BUILT.md'), '# AS_BUILT\n')
      const attrs = join(commonDir(repo), 'info', 'attributes')
      mkdirSync(dirname(attrs), { recursive: true })

      function resolved(): string {
        git(repo, 'add', '-A')
        git(repo, 'commit', '-qm', 'attrs')
        return git(repo, 'check-attr', 'merge', '--', 'docs/AS_BUILT.md').stdout.trim()
      }

      writeFileSync(attrs, 'docs/AS_BUILT.md merge=as-built-log\n')
      writeFileSync(join(repo, '.gitattributes'), 'docs/AS_BUILT.md merge=union\n')
      expect(resolved()).toContain('merge: as-built-log')

      // The REVERSE pairing, which is the half that makes this a precedence result rather than a
      // preference for one of the two values.
      writeFileSync(attrs, 'docs/AS_BUILT.md merge=union\n')
      writeFileSync(join(repo, '.gitattributes'), 'docs/AS_BUILT.md merge=as-built-log\n')
      expect(resolved()).toContain('merge: union')
    }, 30_000)

    test('the driver at the named path must be THIS checkout\'s driver, not merely a file at that path', () => {
      // The command deliberately names the MAIN worktree's copy, so the path can be current while
      // the CODE behind it is an older revision — one predating `MAX_MARKER_SIZE` or the entry-loss
      // refusal. Every other check passes on that clone: the command rebuilds byte-for-byte, the
      // path has the right shape, the file exists. The same false pass, one file deeper.
      const repo = freshRepo()
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
      const hardened = installed(repo)
      const { driver } = words(hardened)

      const other = mkdtempSync(join(tmpdir(), 'as-built-older-driver-'))
      created.push(other)
      mkdirSync(join(other, 'scripts', 'git'), { recursive: true })
      const otherDriver = join(other, 'scripts', 'git', 'as-built-merge-driver.ts')
      // A genuinely different revision of the same file, not a differently-named one: the path
      // shape check must not be what catches this.
      writeFileSync(otherDriver, readFileSync(driver, 'utf8').replace(/MAX_MARKER_SIZE/g, 'OLD_MARKER_CAP'))
      expect(readFileSync(otherDriver, 'utf8')).not.toBe(readFileSync(driver, 'utf8'))

      git(repo, 'config', 'merge.as-built-log.driver', hardened.replace(driver, otherDriver))
      const diverged = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
      expect(diverged.ok).toBe(false)
      expect(diverged.stderr).toContain('STALE')
      expect(diverged.stderr).toContain('NOT this checkout')
      // The remedy it prints must not be the one that cannot work: re-running rewrites the same
      // main-worktree path, so telling the reader to re-run would loop them.
      expect(diverged.stderr).toContain('RE-RUNNING THIS SCRIPT WILL NOT CHANGE IT')

      // CONTROL — it is the CONTENTS and not the foreign path. Make the other copy byte-identical,
      // leave the config naming it, and the same check passes: a linked worktree of the same
      // revision is the ordinary case and must not be called stale.
      cpSync(driver, otherDriver)
      const identical = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
      expect(identical.ok).toBe(true)
      expect(identical.stdout).toContain('merge drivers: installed')
    }, 30_000)

    test('a checkout path containing a single quote yields a command the shell can still parse', () => {
      // The command is a string git hands to `/bin/sh -c`, and the wrapping used to be a bare
      // `'$ROOT/...'` — correct for every path without a quote in it and unparseable for any path
      // with one. `$ROOT` is wherever the clone happens to live, so it is not the installer's to
      // promise. This is the one case where the emitted bytes differ from the old spelling.
      const parent = mkdtempSync(join(tmpdir(), 'as-built-quote-'))
      created.push(parent)
      const repo = join(parent, "it's a clone")
      mkdirSync(join(repo, 'scripts', 'git'), { recursive: true })
      git(repo, 'init', '-q', '-b', 'main')
      for (const rel of [
        ['scripts', 'install-merge-drivers.sh'],
        ['scripts', 'git', 'as-built-merge-driver.ts'],
        ['scripts', 'git', 'as-built-log-merge.ts'],
      ]) {
        cpSync(join(REPO_ROOT, ...rel), join(repo, ...rel))
      }

      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
      const command = installed(repo)
      // The quote is ESCAPED rather than passed through — `it's` becomes `it'\''s` inside the
      // single-quoted word — which is the whole point, so the raw directory name is NOT a substring.
      expect(command).toContain("it'\\''s a clone")
      expect(command).not.toContain("'it's a clone'")

      // The proof is `/bin/sh` itself, not a regex over the quoting: run the command with the
      // driver's five placeholders replaced by a harmless `--version`-style probe and confirm the
      // shell parses it into words instead of dying on an unterminated quote.
      const parsed = run(repo, ['sh', '-c', `set -- ${command.replace(/%[OABLP]/g, 'X')}; printf '%s\\n' "$#"`])
      expect(parsed.stderr).not.toContain('unexpected EOF')
      expect(parsed.ok).toBe(true)

      // CONTROL — the old spelling on this same path does NOT parse, so the assertion above is
      // measuring the escape and not something `sh` would have accepted either way.
      const naive = `'${join(repo, 'scripts', 'git', 'as-built-merge-driver.ts')}' X X X X X`
      const broken = run(repo, ['sh', '-c', `set -- ${naive}; printf '%s\\n' "$#"`])
      expect(broken.ok).toBe(false)

      // AND THE CHECK HAS TO READ IT BACK. Writing an escaped command and never parsing one is
      // half the round trip: `--check` splits the configured string and un-escapes both free words
      // (`unsq`, scripts/install-merge-drivers.sh), and until this ran on a quoted path that
      // function was exercised by nothing. A regression in it would leave every test above green
      // while every quoted clone reported STALE.
      const checked = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
      expect(checked.stderr).not.toContain('STALE')
      expect(checked.ok).toBe(true)

      // MUTATION — the quoted path does not make the check blind. A genuinely wrong command on
      // this same awkward path is still caught, so the pass above is a verdict and not a shrug.
      const command2 = installed(repo)
      git(repo, 'config', 'merge.as-built-log.driver', command2.replace(' --env-file=/dev/null', ''))
      const caught = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
      expect(caught.ok).toBe(false)
      expect(caught.stderr).toContain('STALE')

      // …and the escape survives a round trip: put it back and the check passes again.
      git(repo, 'config', 'merge.as-built-log.driver', command2)
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)
    }, 30_000)

    /**
     * THE BOUNDARY THE REST OF THIS FILE NEVER CROSSES: every other `--check` above runs from the
     * install root with the PATH it inherited. Both of the command's absolute paths come from the
     * invoking shell, and the config they are compared against is shared by the whole clone, so
     * "where is the check run from" is exactly where a byte-for-byte comparison goes wrong — and
     * it did. These tests run the check from somewhere else.
     */
    describe('--check from somewhere other than the shell that installed', () => {
      /** A repo with a commit, so linked worktrees can be added to it. */
      function committedRepo(): string {
        const repo = freshRepo()
        git(repo, 'config', 'user.email', 'trident-test@neutron.local')
        git(repo, 'config', 'user.name', 'Trident Test')
        git(repo, 'config', 'commit.gpgsign', 'false')
        mkdirSync(join(repo, 'docs'), { recursive: true })
        writeFileSync(join(repo, 'docs', 'AS_BUILT.md'), '# AS_BUILT\n')
        git(repo, 'add', '-A')
        git(repo, 'commit', '-qm', 'base')
        return repo
      }

      test('a LINKED WORKTREE reports the shared install as installed, not stale', () => {
        // REGRESSION. The header promises "installing once serves every worktree", and the first
        // cut of the WHAT-is-installed comparison quietly broke it: the expected command was built
        // from `${BASH_SOURCE[0]}`, so the worktree asking rebuilt a DIFFERENT driver path and
        // called the clone stale. MEASURED on git 2.50.1 at the commit before this fix: exit 1,
        // the two printed commands differing in nothing but which checkout hosts the driver.
        const repo = committedRepo()
        expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
        expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)

        const wt = join(repo, '.linked-worktree')
        git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
        const fromWorktree = run(wt, ['bash', join(wt, 'scripts', 'install-merge-drivers.sh'), '--check'])
        expect(fromWorktree.stderr).not.toContain('STALE')
        expect(fromWorktree.ok).toBe(true)

        // CONTROL — the check is still capable of saying STALE from in here, so the pass above is
        // a verdict and not a check that stopped looking once it left its own root.
        git(repo, 'config', 'merge.as-built-log.driver', 'bun driver.ts %O %A %B %L %P')
        const mutated = run(wt, ['bash', join(wt, 'scripts', 'install-merge-drivers.sh'), '--check'])
        expect(mutated.ok).toBe(false)
        expect(mutated.stderr).toContain('STALE')
      }, 30_000)

      test('installing FROM a throwaway worktree leaves a path that outlives it', () => {
        // The publisher installs from a detached rebase worktree it then removes. Deriving the
        // driver from the invoking checkout wrote THAT path into the clone-wide config, so
        // `git worktree remove` left every later merge pointing at a driver that is gone — and a
        // driver git cannot execute is the silent one-side-wins merge this change exists to stop.
        const repo = committedRepo()
        const wt = join(repo, '.throwaway')
        git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
        expect(run(wt, ['bash', join(wt, 'scripts', 'install-merge-drivers.sh')]).ok).toBe(true)

        // The path written names the MAIN checkout, which is the one that outlives the worktree.
        expect(installed(repo)).toContain(join(repo, 'scripts', 'git', 'as-built-merge-driver.ts'))
        expect(installed(repo)).not.toContain(join(wt, 'scripts'))

        git(repo, 'worktree', 'remove', '--force', wt)
        expect(existsSync(wt)).toBe(false)
        expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)
      }, 30_000)

      test('a driver path that no longer exists is STALE, not installed', () => {
        // The other half of the same hazard: a clone that took the dangling path from an older
        // installer must be TOLD, because the command parses perfectly and simply cannot run.
        const repo = committedRepo()
        expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
        const hardened = installed(repo)
        const { driver } = words(hardened)

        const dangling = hardened.replace(driver, join(tmpdir(), 'removed-worktree', 'scripts', 'git', 'as-built-merge-driver.ts'))
        expect(dangling).not.toBe(hardened)
        git(repo, 'config', 'merge.as-built-log.driver', dangling)
        const gone = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
        expect(gone.ok).toBe(false)
        expect(gone.stderr).toContain('STALE')

        // …and a path that exists but is not this driver is refused too, so the free word cannot
        // become "any file at all".
        const elsewhere = join(repo, 'scripts', 'git', 'as-built-log-merge.ts')
        expect(existsSync(elsewhere)).toBe(true)
        git(repo, 'config', 'merge.as-built-log.driver', hardened.replace(driver, elsewhere))
        const wrongScript = run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check'])
        expect(wrongScript.ok).toBe(false)
        expect(wrongScript.stderr).toContain('STALE')

        // CONTROL — restoring the real path restores the pass, so both verdicts are about the
        // path and not about having written the config twice.
        git(repo, 'config', 'merge.as-built-log.driver', hardened)
        expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh', '--check']).ok).toBe(true)
      }, 30_000)

      test('a DIFFERENT PATH order at check time is not staleness', () => {
        // `command -v bun` at check time answered a different absolute path from the one install
        // resolved, and the byte comparison called that an out-of-date driver. A git hook, a CI
        // step and a login shell do not share a PATH order, so this fires on a correct clone.
        const repo = committedRepo()
        expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
        const hardened = installed(repo)
        const { bun } = words(hardened)

        // A second, equally real bun ahead of the first on PATH — same binary, different path.
        const shadow = mkdtempSync(join(tmpdir(), 'as-built-shadow-bun-'))
        created.push(shadow)
        Bun.spawnSync(['ln', '-s', bun, join(shadow, 'bun')])
        expect(existsSync(join(shadow, 'bun'))).toBe(true)

        const shadowed = Bun.spawnSync(['bash', 'scripts/install-merge-drivers.sh', '--check'], {
          cwd: repo,
          env: { ...process.env, PATH: `${shadow}:${process.env.PATH ?? ''}` },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        expect(new TextDecoder().decode(shadowed.stderr)).not.toContain('STALE')
        expect(shadowed.exitCode).toBe(0)

        // CONTROL — that same altered PATH does NOT make the check blind: a genuinely wrong
        // command is still caught through it.
        git(repo, 'config', 'merge.as-built-log.driver', hardened.replace(' --env-file=/dev/null', ''))
        const stillCaught = Bun.spawnSync(['bash', 'scripts/install-merge-drivers.sh', '--check'], {
          cwd: repo,
          env: { ...process.env, PATH: `${shadow}:${process.env.PATH ?? ''}` },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        expect(stillCaught.exitCode).not.toBe(0)
        expect(new TextDecoder().decode(stillCaught.stderr)).toContain('STALE')
      }, 30_000)
    })

    test('the two derivations of the driver command agree', () => {
      // There are exactly two places that build this string: `driver_command` in the installer,
      // and `asBuiltDriverCommand` in `trident/orchestrator.ts`. The second exists because the
      // publisher must NOT execute an installer script found in a checkout it does not control —
      // the credential exposure this whole change is named for — so it cannot simply shell out to
      // the first. The installer's docblock used to claim there was "deliberately no second copy",
      // which was false about the repository even while it was true about the file.
      //
      // Two derivations that must agree need a test, not a comment: pin them together here so a
      // flag added to one and not the other fails rather than silently splitting the fleet in two.
      const repo = freshRepo()
      expect(run(repo, ['bash', 'scripts/install-merge-drivers.sh']).ok).toBe(true)
      const fromScript = installed(repo)

      const orchestrator = readFileSync(join(REPO_ROOT, 'trident', 'orchestrator.ts'), 'utf8')
      const template = orchestrator.match(/return `(\$\{env\}[^`]*%O %A %B %L %P)`/)
      expect(template, 'asBuiltDriverCommand no longer builds the command from a template literal').not.toBeNull()

      // Reduce both to their SHAPE — the interpolations on one side, the quoted absolute paths on
      // the other — so the comparison is about the hardening and not about this machine's paths.
      const shapeFromOrchestrator = template![1]!
        .replace('${env}', '<env>')
        .replace('${scrubbed}', '<scrubbed>')
        .replace('${shellQuote(process.execPath)}', '<bun>')
        .replace('${shellQuote(driver)}', '<driver>')
      const { bun, driver } = words(fromScript)
      const shapeFromScript = fromScript
        .replace(`'${bun}'`, '<bun>')
        .replace(`'${driver}'`, '<driver>')
        .replace(/^\S*env /, '<env> ')
        .replace(/-u \S+( -u \S+)*/, '<scrubbed>')

      expect(shapeFromScript).toBe(shapeFromOrchestrator)

      // …and the scrub lists themselves, which the shapes above deliberately collapsed.
      const scrubbed = fromScript.match(/(-u \S+( -u \S+)*)/)![1]!.split(' -u ').map((s) => s.replace('-u ', ''))
      const credentialEnv = orchestrator.match(/const CREDENTIAL_ENV = \[([^\]]*)\]/s)
      expect(credentialEnv, 'CREDENTIAL_ENV is no longer a literal array').not.toBeNull()
      const names = [...credentialEnv![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
      expect(scrubbed).toEqual(names)
    }, 30_000)
  })
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

  test('a failing config write LEAVES NOTHING BEHIND and exits non-zero instead of printing success', () => {
    // The reachable version of the blocker, forced deterministically: make the
    // repo config unwritable so the very first `git config` fails. Before the
    // fix this printed "merge drivers: installed" and exited 0.
    //
    // The installer reached this state by ROLLBACK when this test was written and reaches it by
    // ORDERING now: `.driver` is written first and nothing else runs if it fails, so there is no
    // half-state to undo. The assertions are on the resulting STATE rather than the route, which is
    // why they survived that change unaltered — only the failure string below is route-specific.
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
    expect(installed.stderr).toContain('NOT INSTALLED')
    expect(installed.ok).toBe(false)
    expect(installed.stdout).not.toContain('merge drivers: installed')

    // And nothing was left behind — in particular not `.name` without `.driver`.
    expect(run(repo, ['git', 'config', '--get', 'merge.as-built-log.name']).stdout.trim()).toBe('')
    expect(run(repo, ['git', 'config', '--get', 'merge.as-built-log.driver']).stdout.trim()).toBe('')
    // Which means the repo still MERGES, rather than aborting with exit 128.
    expect(run(repo, ['git', 'merge', 'other']).code).not.toBe(128)
  }, 30_000)
})
