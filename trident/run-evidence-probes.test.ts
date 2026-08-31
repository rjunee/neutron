/**
 * THE PRODUCTION PROBES, against the REAL host wherever the real host is what is
 * in doubt: a real spawned child in the real process table, real files with real
 * mtimes in a real scratch directory, a real git repository with a real reflog.
 *
 * WHY NOT ALL DOUBLES. The defect being fixed is that the watchdog measured
 * bookkeeping instead of liveness, and doubles are bookkeeping. A test that
 * asserts "given a canned `ps` line, the probe reports activity" cannot fail when
 * the `ps` flags are wrong, when the wrapper stops putting the run id in argv, or
 * when a reflog format changes — which are exactly the ways this can silently go
 * back to killing live builds. So the ground-truth paths are exercised for real,
 * and doubles are reserved for the failure modes a test may not manufacture on a
 * shared host (an unreadable directory, a missing `ps`, a timed-out command).
 *
 * SAFETY RULES OBSERVED HERE. Every test uses its OWN temporary directory as
 * scratch/worktree/repo and removes it afterwards; the only process ever killed
 * is a handle this file spawned itself (`proc.kill()` on the returned handle),
 * never a name and never a pattern — this box runs many build lanes and a
 * pattern kill would take all of them.
 *
 * Assertions run through T1's `decideHang`/`describeRunEvidence` wherever the
 * point is a WATCHDOG consequence, so the tests prove what the run's fate would
 * be, not merely what a struct contains.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnCapture, type HostCommandResult } from './git-mode.ts'
import { buildRunEvidenceGatherer, type RunEvidenceFs } from './run-evidence-probes.ts'
import { decideHang, describeRunEvidence, type RunEvidenceGatherer } from './run-evidence.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'

/** The production hang window: what the watchdog actually compares against. */
const WINDOW = 90 * 60_000

/** Every temp dir this file creates, removed after each test. */
const created: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trident-probe-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop() as string
    await rm(dir, { recursive: true, force: true })
  }
})

async function setAgeMinutes(path: string, minutes: number): Promise<void> {
  const at = new Date(Date.now() - minutes * 60_000)
  await utimes(path, at, at)
}

// ---- canned host results ----------------------------------------------------

const PS_QUIET: HostCommandResult = {
  ok: true,
  stdout: '      1 /usr/lib/systemd/systemd --system\n      2 [kthreadd]',
  stderr: '',
  exit_code: 0,
}
const PS_UNREADABLE: HostCommandResult = {
  ok: false,
  stdout: '',
  stderr: 'ps: command not found',
  exit_code: 127,
}
const PS_TIMED_OUT: HostCommandResult = { ok: true, stdout: '', stderr: '', exit_code: 0, timed_out: true }
const GIT_NO_SUCH_REF: HostCommandResult = {
  ok: false,
  stdout: '',
  stderr: "fatal: ambiguous argument 'refs/heads/x': unknown revision or path not in the working tree.",
  exit_code: 128,
}

/** Route on the executable: these probes only ever run `ps` or `git`. */
function cannedHost(ps: HostCommandResult, git: HostCommandResult = GIT_NO_SUCH_REF) {
  return async (cmd: string[]): Promise<HostCommandResult> => (cmd[0] === 'ps' ? ps : git)
}

/** A run id long enough to be scannable but guaranteed not to collide. */
function runId(): string {
  return crypto.randomUUID()
}

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr}`)
}

// ---- PROBE 1: PROCESS -------------------------------------------------------

describe('process probe — the ground truth', () => {
  test('REAL: a live child carrying the run id in argv stands a stale run down', async () => {
    const id = runId()
    const scratch = await tempDir()
    // The extra argument becomes the child's $0, so the run id lands in argv
    // exactly as the detached build wrapper's supervisor carries it. Two
    // commands, so bash does NOT exec-optimise itself away and lose the argv.
    const proc = Bun.spawn(['bash', '-c', 'sleep 20; exit 0', `trident-run-${id}`], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    try {
      const gather = buildRunEvidenceGatherer({ scratch_dirs: [scratch] })
      const run = makeTridentRun({
        id,
        // Stale bookkeeping: three hours since the last phase transition. This
        // is the exact shape of all 17 false kills.
        last_advanced_at: new Date(Date.now() - 180 * 60_000).toISOString(),
        worktree: join(scratch, 'no-such-worktree'),
        branch: null,
      })
      // The child may not be in the table the instant spawn returns.
      let evidence = await gather(run, WINDOW)
      for (let i = 0; i < 40 && evidence.process.observed !== 'activity'; i += 1) {
        await Bun.sleep(50)
        evidence = await gather(run, WINDOW)
      }
      expect(evidence.process).toMatchObject({ observed: 'activity', age_ms: 0 })
      expect(evidence.process.detail).toContain('carry the run id in argv')
      // The watchdog-level consequence: a live process is not a hang.
      expect(decideHang(evidence, WINDOW).action).toBe('stand-down')
    } finally {
      // Only the handle this test created — never a name, never a pattern.
      proc.kill()
      await proc.exited
    }
  })

  test('a fully read process table with no match is positively quiet', async () => {
    const scratch = await tempDir()
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_QUIET), scratch_dirs: [scratch] })
    const evidence = await gather(makeTridentRun({ id: runId() }), WINDOW)
    expect(evidence.process.observed).toBe('nothing')
    expect(evidence.process.detail).toContain('0 pid file(s) checked')
  })

  test('an UNREADABLE process table is unknown and DEFERS the kill', async () => {
    const scratch = await tempDir()
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_UNREADABLE), scratch_dirs: [scratch] })
    const evidence = await gather(makeTridentRun({ id: runId() }), WINDOW)
    expect(evidence.process.observed).toBe('unknown')
    expect(evidence.process.detail).toContain('exit 127')
    // Artifacts and ref are both positively quiet here, so this asserts the rule
    // that matters: an unqueryable process table alone blocks the reap.
    expect(evidence.artifacts.observed).toBe('nothing')
    expect(evidence.ref.observed).toBe('nothing')
    expect(decideHang(evidence, WINDOW).action).toBe('defer')
  })

  test('a TIMED-OUT process table is unknown even though the exit code says ok', async () => {
    const scratch = await tempDir()
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_TIMED_OUT), scratch_dirs: [scratch] })
    const evidence = await gather(makeTridentRun({ id: runId() }), WINDOW)
    expect(evidence.process.observed).toBe('unknown')
    expect(evidence.process.detail).toContain('timed out')
  })

  test('a run id too short to scan REFUSES rather than matching everything', async () => {
    const scratch = await tempDir()
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_QUIET), scratch_dirs: [scratch] })
    const evidence = await gather(makeTridentRun({ id: 'r1' }), WINDOW)
    expect(evidence.process.observed).toBe('unknown')
    expect(evidence.process.detail).toContain('too short')
  })

  test('REAL: the pid-file fallback finds a live pid when the process table cannot be read', async () => {
    const id = runId()
    const scratch = await tempDir()
    await writeFile(join(scratch, `trident-codex-build-${id}-1.pid`), `${process.pid}\n`)
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_UNREADABLE), scratch_dirs: [scratch] })
    const evidence = await gather(makeTridentRun({ id }), WINDOW)
    expect(evidence.process).toMatchObject({ observed: 'activity', age_ms: 0 })
    expect(decideHang(evidence, WINDOW).action).toBe('stand-down')
  })

  test('REAL: a positively DEAD pid is a real observation, not a blind one', async () => {
    const id = runId()
    const scratch = await tempDir()
    const proc = Bun.spawn(['bash', '-c', 'exit 0'], { stdout: 'ignore', stderr: 'ignore' })
    const deadPid = proc.pid
    await proc.exited
    await writeFile(join(scratch, `trident-codex-build-${id}-1.pid`), String(deadPid))
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_QUIET), scratch_dirs: [scratch] })
    const evidence = await gather(makeTridentRun({ id }), WINDOW)
    expect(evidence.process.observed).toBe('nothing')
  })

  test('a GARBAGE pid file is unknown and names the file', async () => {
    const id = runId()
    const scratch = await tempDir()
    await writeFile(join(scratch, `trident-codex-build-${id}-1.pid`), 'not-a-pid')
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_QUIET), scratch_dirs: [scratch] })
    const evidence = await gather(makeTridentRun({ id }), WINDOW)
    expect(evidence.process.observed).toBe('unknown')
    expect(evidence.process.detail).toContain(`trident-codex-build-${id}-1.pid`)
  })

  test('a pid file holding 1 or 0 is never handed to the existence check', async () => {
    const id = runId()
    const scratch = await tempDir()
    await writeFile(join(scratch, `trident-codex-build-${id}-1.pid`), '1')
    await writeFile(join(scratch, `trident-codex-build-${id}-2.pid`), '0')
    const asked: number[] = []
    const gather = buildRunEvidenceGatherer({
      run_host: cannedHost(PS_QUIET),
      scratch_dirs: [scratch],
      probe_pid_alive: (pid) => {
        asked.push(pid)
        return 'alive'
      },
    })
    const evidence = await gather(makeTridentRun({ id }), WINDOW)
    expect(asked).toEqual([])
    expect(evidence.process.observed).toBe('unknown')
  })
})

// ---- PROBE 2: ARTIFACTS -----------------------------------------------------

describe('artifact probe — mtimes on the run’s own files', () => {
  test('REAL: a freshly written stream file spares a run whose bookkeeping is stale', async () => {
    const id = runId()
    const scratch = await tempDir()
    await writeFile(join(scratch, `trident-codex-build-${id}-1.err`), 'writing right now\n')
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_QUIET), scratch_dirs: [scratch] })
    const run = makeTridentRun({
      id,
      last_advanced_at: new Date(Date.now() - 100 * 60_000).toISOString(),
      worktree: join(scratch, 'no-such-worktree'),
    })
    const evidence = await gather(run, WINDOW)
    expect(evidence.artifacts.observed).toBe('activity')
    if (evidence.artifacts.observed === 'activity') expect(evidence.artifacts.age_ms).toBeLessThan(60_000)
    expect(evidence.artifacts.detail).toContain(`trident-codex-build-${id}-1.err`)
    expect(decideHang(evidence, WINDOW).action).toBe('stand-down')
  })

  test('REAL positive control: a two-hour-old artifact is disclosed but does NOT spare the run', async () => {
    const id = runId()
    const scratch = await tempDir()
    const artifact = join(scratch, `trident-codex-build-${id}-1.err`)
    await writeFile(artifact, 'last written two hours ago\n')
    await setAgeMinutes(artifact, 120)
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_QUIET), scratch_dirs: [scratch] })
    const evidence = await gather(
      makeTridentRun({ id, worktree: join(scratch, 'no-such-worktree') }),
      WINDOW,
    )
    expect(evidence.artifacts.observed).toBe('activity')
    if (evidence.artifacts.observed === 'activity') {
      expect(evidence.artifacts.age_ms).toBeGreaterThan(WINDOW)
      expect(evidence.artifacts.age_ms).toBeLessThan(130 * 60_000)
    }
    expect(decideHang(evidence, WINDOW).action).toBe('reap')
    expect(describeRunEvidence(evidence)).toContain('newest artifact 120 min old')
  })

  test('REAL: fresh churn inside node_modules and .git does not count as run activity', async () => {
    const id = runId()
    const scratch = await tempDir()
    const worktree = join(scratch, 'wt')
    await mkdir(join(worktree, 'node_modules'), { recursive: true })
    await mkdir(join(worktree, '.git'), { recursive: true })
    await mkdir(join(worktree, 'src'), { recursive: true })
    await writeFile(join(worktree, 'node_modules', 'installed.js'), 'fresh')
    await writeFile(join(worktree, '.git', 'FETCH_HEAD'), 'fresh')
    await writeFile(join(worktree, 'src', 'a.ts'), 'old')
    // Backdate everything the walk is allowed to look at, INCLUDING the roots —
    // creating the excluded directories bumped their parent's mtime.
    for (const p of [worktree, join(worktree, 'src'), join(worktree, 'src', 'a.ts')]) {
      await setAgeMinutes(p, 120)
    }
    const gather = buildRunEvidenceGatherer({
      run_host: cannedHost(PS_QUIET),
      scratch_dirs: [await tempDir()],
    })
    const evidence = await gather(makeTridentRun({ id, worktree }), WINDOW)
    expect(evidence.artifacts.observed).toBe('activity')
    if (evidence.artifacts.observed === 'activity') expect(evidence.artifacts.age_ms).toBeGreaterThan(WINDOW)
    expect(decideHang(evidence, WINDOW).action).toBe('reap')
  })

  test('REAL: a fresh file DEEP in the worktree is found (the early-exit path)', async () => {
    const id = runId()
    const scratch = await tempDir()
    const worktree = join(scratch, 'wt')
    const deep = join(worktree, 'a', 'b', 'c')
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'written-now.ts'), 'work')
    for (const p of [worktree, join(worktree, 'a'), join(worktree, 'a', 'b'), deep]) {
      await setAgeMinutes(p, 120)
    }
    const gather = buildRunEvidenceGatherer({
      run_host: cannedHost(PS_QUIET),
      scratch_dirs: [await tempDir()],
    })
    const evidence = await gather(makeTridentRun({ id, worktree }), WINDOW)
    expect(evidence.artifacts.observed).toBe('activity')
    if (evidence.artifacts.observed === 'activity') expect(evidence.artifacts.age_ms).toBeLessThan(60_000)
    expect(evidence.artifacts.detail).toContain('written-now.ts')
    expect(decideHang(evidence, WINDOW).action).toBe('stand-down')
  })

  test('an absent worktree and an empty scratch dir are positively quiet', async () => {
    const scratch = await tempDir()
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_QUIET), scratch_dirs: [scratch] })
    const evidence = await gather(
      makeTridentRun({ id: runId(), worktree: join(scratch, 'never-created') }),
      WINDOW,
    )
    expect(evidence.artifacts.observed).toBe('nothing')
  })

  test('an unreadable scratch directory is unknown, never quiet', async () => {
    const denied: RunEvidenceFs = {
      readdir: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      },
      lstat: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
      readFile: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    }
    const gather = buildRunEvidenceGatherer({
      run_host: cannedHost(PS_QUIET),
      scratch_dirs: ['/does-not-matter'],
      fs: denied,
    })
    const evidence = await gather(makeTridentRun({ id: runId() }), WINDOW)
    expect(evidence.artifacts.observed).toBe('unknown')
    expect(evidence.artifacts.detail).toContain('EACCES')
    expect(decideHang(evidence, WINDOW).action).toBe('defer')
  })

  test('REAL: a CAPPED worktree scan is unknown — an incomplete look is not a quiet one', async () => {
    const id = runId()
    const scratch = await tempDir()
    const worktree = join(scratch, 'wt')
    await mkdir(worktree, { recursive: true })
    for (let i = 0; i < 10; i += 1) await writeFile(join(worktree, `old-${i}.ts`), 'old')
    await setAgeMinutes(worktree, 120)
    for (let i = 0; i < 10; i += 1) await setAgeMinutes(join(worktree, `old-${i}.ts`), 120)
    const gather = buildRunEvidenceGatherer({
      run_host: cannedHost(PS_QUIET),
      scratch_dirs: [await tempDir()],
      max_worktree_entries: 3,
    })
    const evidence = await gather(makeTridentRun({ id, worktree }), WINDOW)
    expect(evidence.artifacts.observed).toBe('unknown')
    expect(evidence.artifacts.detail).toContain('capped')
    expect(decideHang(evidence, WINDOW).action).toBe('defer')
  })

  test('a future mtime (clock skew) clamps to age 0 instead of deferring', async () => {
    const id = runId()
    const scratch = await tempDir()
    const artifact = join(scratch, `trident-codex-build-${id}-1.out`)
    await writeFile(artifact, 'skewed')
    await setAgeMinutes(artifact, -5)
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_QUIET), scratch_dirs: [scratch] })
    const evidence = await gather(
      makeTridentRun({ id, worktree: join(scratch, 'never-created') }),
      WINDOW,
    )
    expect(evidence.artifacts).toMatchObject({ observed: 'activity', age_ms: 0 })
    expect(decideHang(evidence, WINDOW).action).toBe('stand-down')
  })
})

// ---- PROBE 3: BRANCH REF ----------------------------------------------------

describe('branch-ref probe — real repositories', () => {
  async function repoWithCommit(env: Record<string, string> = {}): Promise<string> {
    const repo = await tempDir()
    await git(repo, ['init', '-q', '-b', 'main', '.'])
    await git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], env)
    return repo
  }

  /** Only the ref probe is under test here, so `ps` is canned and git is real. */
  function refGatherer(repo: string, scratch: string): RunEvidenceGatherer {
    return buildRunEvidenceGatherer({
      run_host: async (cmd, cwd) => (cmd[0] === 'ps' ? PS_QUIET : await spawnCapture(cmd, cwd, undefined, 15_000)),
      scratch_dirs: [scratch],
    })
  }

  test('REAL: a just-updated branch reports recent reflog movement', async () => {
    const repo = await repoWithCommit()
    const scratch = await tempDir()
    const evidence = await refGatherer(repo, scratch)(
      makeTridentRun({ id: runId(), repo_path: repo, branch: 'main', worktree: join(scratch, 'none') }),
      WINDOW,
    )
    expect(evidence.ref.observed).toBe('activity')
    if (evidence.ref.observed === 'activity') expect(evidence.ref.age_ms).toBeLessThan(5 * 60_000)
    expect(evidence.ref.detail).toBe('branch reflog')
  })

  test('REAL: a two-hour-old ref update is activity OUTSIDE the window (positive control)', async () => {
    const old = new Date(Date.now() - 120 * 60_000).toISOString()
    const repo = await repoWithCommit({ GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old })
    const scratch = await tempDir()
    const evidence = await refGatherer(repo, scratch)(
      makeTridentRun({ id: runId(), repo_path: repo, branch: 'main', worktree: join(scratch, 'none') }),
      WINDOW,
    )
    expect(evidence.ref.observed).toBe('activity')
    if (evidence.ref.observed === 'activity') {
      expect(evidence.ref.age_ms).toBeGreaterThan(WINDOW)
      expect(evidence.ref.age_ms).toBeLessThan(130 * 60_000)
    }
    expect(decideHang(evidence, WINDOW).action).toBe('reap')
  })

  test('REAL: a branch that never existed is positively nothing', async () => {
    const repo = await repoWithCommit()
    const scratch = await tempDir()
    const evidence = await refGatherer(repo, scratch)(
      makeTridentRun({
        id: runId(),
        repo_path: repo,
        branch: 'trident/never-created',
        worktree: join(scratch, 'none'),
      }),
      WINDOW,
    )
    expect(evidence.ref).toMatchObject({ observed: 'nothing' })
    expect(evidence.ref.detail).toContain('does not exist')
  })

  test('REAL: a pruned reflog falls back to the tip committer date', async () => {
    const repo = await repoWithCommit()
    await rm(join(repo, '.git', 'logs'), { recursive: true, force: true })
    const scratch = await tempDir()
    const evidence = await refGatherer(repo, scratch)(
      makeTridentRun({ id: runId(), repo_path: repo, branch: 'main', worktree: join(scratch, 'none') }),
      WINDOW,
    )
    expect(evidence.ref.observed).toBe('activity')
    expect(evidence.ref.detail).toContain('no reflog')
  })

  test('REAL: a directory that is not a repository is UNKNOWN, not quiet', async () => {
    const notARepo = await tempDir()
    const scratch = await tempDir()
    const evidence = await refGatherer(notARepo, scratch)(
      makeTridentRun({ id: runId(), repo_path: notARepo, branch: 'main', worktree: join(scratch, 'none') }),
      WINDOW,
    )
    expect(evidence.ref.observed).toBe('unknown')
    expect(evidence.ref.detail).toContain('not a git repository')
    expect(decideHang(evidence, WINDOW).action).toBe('defer')
  })

  test('a run with no branch yet is positively nothing', async () => {
    const scratch = await tempDir()
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_QUIET), scratch_dirs: [scratch] })
    const evidence = await gather(makeTridentRun({ id: runId(), branch: null }), WINDOW)
    expect(evidence.ref).toMatchObject({ observed: 'nothing', detail: 'run has no branch' })
  })
})

// ---- THE WHOLE GATHERER -----------------------------------------------------

describe('the gatherer as a whole', () => {
  test('POSITIVE CONTROL: an all-quiet run still reaps, and the reason names all three probes', async () => {
    const scratch = await tempDir()
    const gather = buildRunEvidenceGatherer({ run_host: cannedHost(PS_QUIET), scratch_dirs: [scratch] })
    const evidence = await gather(
      makeTridentRun({
        id: runId(),
        branch: null,
        worktree: join(scratch, 'never-created'),
        last_advanced_at: new Date(Date.now() - 120 * 60_000).toISOString(),
      }),
      WINDOW,
    )
    expect(evidence.process.observed).toBe('nothing')
    expect(evidence.artifacts.observed).toBe('nothing')
    expect(evidence.ref.observed).toBe('nothing')
    expect(decideHang(evidence, WINDOW).action).toBe('reap')
    const disclosure = describeRunEvidence(evidence)
    expect(disclosure).toContain('run process=none observed')
    expect(disclosure).toContain('no run artifacts found')
    expect(disclosure).toContain('no branch ref movement recorded')
  })

  test('every seam failing at once RESOLVES to all-unknown and defers — it never rejects', async () => {
    const exploding: RunEvidenceFs = {
      readdir: async () => {
        throw new Error('fs is gone')
      },
      lstat: async () => {
        throw new Error('fs is gone')
      },
      readFile: async () => {
        throw new Error('fs is gone')
      },
    }
    const gather = buildRunEvidenceGatherer({
      run_host: async () => {
        throw new Error('spawn refused')
      },
      scratch_dirs: ['/does-not-matter'],
      fs: exploding,
    })
    const evidence = await gather(makeTridentRun({ id: runId(), branch: 'main' }), WINDOW)
    expect(evidence.process.observed).toBe('unknown')
    expect(evidence.artifacts.observed).toBe('unknown')
    expect(evidence.ref.observed).toBe('unknown')
    expect(decideHang(evidence, WINDOW).action).toBe('defer')
  })

  test('the built gatherer satisfies the orchestrator seam type', () => {
    const gather: RunEvidenceGatherer = buildRunEvidenceGatherer({ run_host: cannedHost(PS_QUIET) })
    expect(typeof gather).toBe('function')
  })
})
