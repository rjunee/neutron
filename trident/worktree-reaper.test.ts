import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { spawnCapture } from './git-mode.ts'
import { TERMINAL_PHASES } from './state-machine.ts'
import type { TridentBranchOwner, TridentPhase, TridentRun } from './store.ts'
import {
  buildWorktreeReaperLoop,
  DEFAULT_REAP_INTERVAL_MS,
  DEFAULT_WORKTREE_RETENTION_MS,
  MAX_REF_DELETIONS_PER_SWEEP,
  SALVAGE_REF_PREFIX,
  TRIDENT_REF_PREFIX,
  sweepTridentWorktrees,
  type WorktreeReaperStore,
} from './worktree-reaper.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnCapture(['git', '-C', cwd, ...args], cwd)
  expect(result.ok, `git ${args.join(' ')}\n${result.stderr || result.stdout}`).toBe(true)
  return result.stdout.trim()
}

async function makeRepo(): Promise<{ root: string; repo: string }> {
  const root = mkdtempSync(join(tmpdir(), 'trident-worktree-reaper-'))
  roots.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  await git(repo, 'init', '-b', 'main')
  await git(repo, 'config', 'user.email', 'trident@example.test')
  await git(repo, 'config', 'user.name', 'Trident Test')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  await git(repo, 'add', 'README.md')
  await git(repo, 'commit', '-m', 'base')
  return { root, repo }
}

async function addWorktree(
  repo: string,
  name: string,
  branch?: string,
): Promise<string> {
  const worktree = join(repo, '.claude', 'worktrees', name)
  mkdirSync(dirname(worktree), { recursive: true })
  if (branch === undefined) await git(repo, 'worktree', 'add', '--detach', worktree)
  else await git(repo, 'worktree', 'add', '-b', branch, worktree)
  return worktree
}

function makeProc(root: string): string {
  const proc = join(root, 'proc')
  mkdirSync(proc)
  return proc
}

function addProcCwd(proc: string, pid: number, cwd: string): void {
  const pidDir = join(proc, String(pid))
  mkdirSync(pidDir)
  symlinkSync(cwd, join(pidDir, 'cwd'), 'dir')
}

function backdate(worktree: string, now: number): void {
  const old = new Date(now - DEFAULT_WORKTREE_RETENTION_MS - 60_000)
  utimesSync(worktree, old, old)
  utimesSync(join(worktree, '.git'), old, old)
}

type NonTerminalRun = Pick<
  TridentRun,
  'worktree' | 'branch' | 'repo_path' | 'workflow_run_id'
>

function stubStore(
  repo: string,
  runs: NonTerminalRun[] = [],
  owners: TridentBranchOwner[] = [],
): WorktreeReaperStore {
  return {
    listRepoPaths: () => [repo],
    listNonTerminal: () => runs,
    // #547 — NO owner rows by default, which is the answer that KEEPS a ref. Every
    // pre-#547 case below therefore asserts the ref survives for a real reason (gate 5,
    // "no run row names this branch") rather than because the sweep was switched off.
    listBranchOwners: () => owners,
  }
}

/** A terminal owner row: the only shape that can authorise a ref delete. */
function owner(
  branch: string,
  over: Partial<TridentBranchOwner> = {},
): TridentBranchOwner {
  return { branch, phase: 'failed', worktree: null, workflow_run_id: null, ...over }
}

async function listedWorktrees(repo: string): Promise<string[]> {
  return (await git(repo, 'worktree', 'list', '--porcelain'))
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

describe('sweepTridentWorktrees — real git', () => {
  test('frees a dead holder so the branch is switchable again', async () => {
    const { root, repo } = await makeRepo()
    const holder = await addWorktree(repo, 'wf_dead-1', 'trident/x')
    const second = await addWorktree(repo, 'wf_second-2')
    const proc = makeProc(root)
    const unrelated = join(root, 'unrelated')
    mkdirSync(unrelated)
    addProcCwd(proc, 101, unrelated)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo),
      run_host: spawnCapture,
      proc_root: proc,
    })

    expect(report.detached).toContain(holder)
    expect(await git(holder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(existsSync(holder)).toBe(true)
    await git(second, 'switch', 'trident/x')
    expect(await git(second, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trident/x')
    expect(await git(repo, 'show-ref', '--verify', 'refs/heads/trident/x')).not.toBe('')
  }, 30_000)

  test('a live worktree is completely untouched', async () => {
    const { root, repo } = await makeRepo()
    const worktree = await addWorktree(repo, 'wf_live-1', 'trident/x')
    const nested = join(worktree, 'nested')
    mkdirSync(nested)
    const now = Date.now()
    backdate(worktree, now)
    const proc = makeProc(root)
    addProcCwd(proc, 201, worktree)
    addProcCwd(proc, 202, nested)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo),
      run_host: spawnCapture,
      proc_root: proc,
      now: () => now,
    })

    expect(report.live_skipped).toBeGreaterThanOrEqual(1)
    expect(report.detached).toEqual([])
    expect(report.removed).toEqual([])
    expect(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trident/x')
    expect(await listedWorktrees(repo)).toContain(worktree)
  }, 30_000)

  test('the shared main checkout is never detached or removed', async () => {
    const { root, repo } = await makeRepo()
    await git(repo, 'switch', '-c', 'trident/y')
    const candidate = await addWorktree(repo, 'wf_old-1')
    const now = Date.now()
    backdate(repo, now)
    backdate(candidate, now)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      now: () => now,
    })

    expect(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trident/y')
    expect((await listedWorktrees(repo))[0]).toBe(repo)
    expect(report.detached).not.toContain(repo)
    expect(report.removed).not.toContain(repo)
    expect(existsSync(repo)).toBe(true)
  }, 30_000)

  test("a non-terminal run's worktree survives even process-free and old", async () => {
    const { root, repo } = await makeRepo()
    const exact = await addWorktree(repo, 'wf_active-1', 'trident/z')
    const branchOnly = await addWorktree(repo, 'wf_branch-2', 'trident/branch-only')
    const now = Date.now()
    backdate(exact, now)
    backdate(branchOnly, now)
    const runs: NonTerminalRun[] = [
      { worktree: exact, branch: 'trident/z', repo_path: repo, workflow_run_id: null },
      {
        worktree: null,
        branch: 'trident/branch-only',
        repo_path: repo,
        workflow_run_id: null,
      },
    ]

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, runs),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      now: () => now,
    })

    expect(report.detached).toEqual(expect.arrayContaining([exact, branchOnly]))
    expect(report.protected_nonterminal).toEqual(expect.arrayContaining([exact, branchOnly]))
    expect(await git(exact, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(await git(branchOnly, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(await listedWorktrees(repo)).toEqual(expect.arrayContaining([exact, branchOnly]))
    expect(existsSync(exact)).toBe(true)
    expect(existsSync(branchOnly)).toBe(true)
  }, 30_000)

  test('retention removes only old, clean, unclaimed trees', async () => {
    const { root, repo } = await makeRepo()
    const old = await addWorktree(repo, 'wf_old-1')
    const young = await addWorktree(repo, 'wf_new-1')
    const dirty = await addWorktree(repo, 'wf_dirty-1')
    writeFileSync(join(dirty, 'untracked.txt'), 'rescue me\n')
    const now = Date.now()
    backdate(old, now)
    backdate(dirty, now)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      now: () => now,
    })

    expect(report.removed).toContain(old)
    expect(existsSync(old)).toBe(false)
    expect(await listedWorktrees(repo)).not.toContain(old)
    expect(existsSync(young)).toBe(true)
    expect(await listedWorktrees(repo)).toContain(young)
    expect(existsSync(dirty)).toBe(true)
    expect(readFileSync(join(dirty, 'untracked.txt'), 'utf8')).toBe('rescue me\n')
    expect(report.preserved.some((entry) => entry.path === dirty)).toBe(true)
  }, 30_000)

  test('no /proc means no action', async () => {
    const { root, repo } = await makeRepo()
    const worktree = await addWorktree(repo, 'wf_unverified-1', 'trident/unverified')
    const now = Date.now()
    backdate(worktree, now)
    let storeCalls = 0
    const store: WorktreeReaperStore = {
      listRepoPaths: () => {
        storeCalls += 1
        return [repo]
      },
      listNonTerminal: () => [],
      listBranchOwners: () => {
        storeCalls += 1
        return [owner('trident/unverified')]
      },
    }

    const report = await sweepTridentWorktrees({
      store,
      run_host: spawnCapture,
      proc_root: join(root, 'missing-proc'),
      now: () => now,
    })

    expect(report.skipped_no_liveness).toBe(true)
    expect(report.detached).toEqual([])
    expect(report.removed).toEqual([])
    expect(report.preserved).toEqual([])
    expect(report.protected_nonterminal).toEqual([])
    expect(storeCalls).toBe(0)
    expect(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'trident/unverified',
    )
    expect(existsSync(worktree)).toBe(true)
  }, 30_000)
})

/**
 * #547 CHANGED ONE CLAUSE OF THIS INVARIANT AND HARDENED THE REST.
 *
 * The reaper now deletes a branch ref, so "never delete a branch" is the behaviour the
 * issue ordered reversed — it cannot stand, and pretending it does by hiding the delete
 * in a sibling module would leave a test asserting the opposite of what the module does.
 * The two bans that were never in question stay (force removal, killing a process).
 *
 * WHAT REPLACES THE DELETE BAN IS A BAN ON THE NON-ATOMIC PRIMITIVE. The first cut used
 * `git branch -D` after a separate `rev-parse`, which is a read-then-delete window an
 * arriving commit can be lost in (see the call site). `git branch -D` can never be
 * compare-and-swapped, so its absence from this file is now itself an invariant — and
 * there is EXACTLY ONE deletion, so a second, unguarded one cannot be added silently.
 * That the one deletion is the GUARDED one is proven by the refusal cases below.
 */
test('the reaper can never force or kill, and its ONE delete is an atomic CAS', () => {
  const source = readFileSync(new URL('./worktree-reaper.ts', import.meta.url), 'utf8')
  expect(source).not.toContain('--force')
  expect(source).not.toContain('--delete')
  expect(source).not.toContain("'kill'")
  // `git branch -D` cannot carry an expected old value, so it is banned outright — as a
  // command and as a bare flag, since `-D` reaches nothing else here.
  expect(source).not.toContain("'branch', '-D'")
  expect(source).not.toContain("'-D'")
  // ONE deletion, and it names the expected sha (the CAS) rather than just the ref.
  expect(source.match(/'update-ref', '-d'/g) ?? []).toHaveLength(1)
  expect(source).toContain("['git', '-C', repo, 'update-ref', '-d', ref, sha]")
  // The salvage write is create-only: the trailing '' is `update-ref`'s "must not exist".
  expect(source).toContain("['git', '-C', repo, 'update-ref', salvage, sha, '']")
})

test('buildWorktreeReaperLoop is immediate and uses the default descriptor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trident-worktree-reaper-loop-'))
  roots.push(root)
  const proc = makeProc(root)
  let repoCalls = 0
  let timerMs = 0
  let cleared = false
  const options = {
    store: {
      listRepoPaths: () => {
        repoCalls += 1
        return []
      },
      listNonTerminal: () => [],
      listBranchOwners: () => [],
    },
    run_host: spawnCapture,
    proc_root: proc,
    setTimer: (_fn: () => void, ms: number) => {
      timerMs = ms
      return 17
    },
    clearTimer: (handle: unknown) => {
      expect(handle).toBe(17)
      cleared = true
    },
  }
  const loop = buildWorktreeReaperLoop(options)

  expect(loop.describe().name).toBe('trident-worktree-reaper')
  expect(loop.describe().cadenceMs).toBe(DEFAULT_REAP_INTERVAL_MS)
  loop.start()
  const deadline = Date.now() + 1_000
  while (repoCalls === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(repoCalls).toBe(1)
  expect(timerMs).toBe(DEFAULT_REAP_INTERVAL_MS)
  await loop.stop()
  expect(cleared).toBe(true)
})

test('workflow generation claims a matching worktree basename', async () => {
  const { root, repo } = await makeRepo()
  const generation = '37d8c538'
  const worktree = await addWorktree(repo, `wf_${generation}-2`)
  const now = Date.now()
  backdate(worktree, now)

  const report = await sweepTridentWorktrees({
    store: stubStore(repo, [
      { worktree: null, branch: null, repo_path: '/elsewhere', workflow_run_id: generation },
    ]),
    run_host: spawnCapture,
    proc_root: makeProc(root),
    now: () => now,
  })

  expect(report.protected_nonterminal).toContain(worktree)
  expect(existsSync(worktree)).toBe(true)
  expect(basename(worktree)).toContain(generation)
}, 30_000)

// ════════════════════════════════════════════════════════════════════════════════
// THE BRANCH-REF REAP (#547)
//
// A run's branch ref used to survive its own run on every terminal path but the
// completion one, and the surviving ref then re-entered the card's NEXT launch on a
// stale base. The reap is keyed on the STORE (every run owning the ref is terminal),
// so it covers every terminal path including the ones that run no code at all.
//
// The refusals matter more than the deletions: an orphaned ref is a nuisance, a ref
// deleted under a live lane destroys work (`docs/as-built/
// wrong-base-guard-prints-a-destructi.md`, 2026-09-01). Each one is a separate test.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * EVERY PHASE THE DB ACCEPTS, read out of the shipped schema rather than typed here
 * from memory. `migrations/expected-schema.txt` is the CI-enforced picture of the
 * live table, so a phase added there and forgotten here fails this parse instead of
 * silently narrowing the enumeration below. The TERMINAL/non-terminal split then comes
 * from `TERMINAL_PHASES` — the module under test's own answer, never a guess.
 */
function schemaPhases(): TridentPhase[] {
  const schema = readFileSync(new URL('../migrations/expected-schema.txt', import.meta.url), 'utf8')
  const start = schema.indexOf('[table] code_trident_runs ')
  expect(start, 'the code_trident_runs table must be in expected-schema.txt').toBeGreaterThan(-1)
  const table = schema.slice(start)
  const check = /CHECK \(phase IN \(([^)]*)\)\)/.exec(table)
  expect(check, 'the phase CHECK constraint must be findable in expected-schema.txt').not.toBeNull()
  const phases = [...(check?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as TridentPhase)
  expect(phases.length).toBeGreaterThan(3)
  return phases
}

const SCHEMA_PHASES = schemaPhases()
const TERMINAL = SCHEMA_PHASES.filter((p) => (TERMINAL_PHASES as readonly string[]).includes(p))
const NON_TERMINAL = SCHEMA_PHASES.filter((p) => !(TERMINAL_PHASES as readonly string[]).includes(p))

/** A `trident/*` ref carrying a commit that exists nowhere else, and no worktree. */
async function seedRef(repo: string, branch: string, marker: string): Promise<string> {
  const seed = join(repo, '.claude', 'worktrees', `seed_${marker}`)
  mkdirSync(dirname(seed), { recursive: true })
  await git(repo, 'worktree', 'add', '-b', branch, seed)
  writeFileSync(join(seed, `${marker}.txt`), `${marker}\n`)
  await git(seed, 'add', '-A')
  await git(seed, 'commit', '-m', `work ${marker}`)
  const sha = await git(seed, 'rev-parse', 'HEAD')
  await git(repo, 'worktree', 'remove', seed)
  return sha
}

/** Every spelling of "delete this ref" a sweep could reach for. */
function isADelete(cmd: readonly string[]): boolean {
  const joined = cmd.join(' ')
  return joined.includes('update-ref -d') || joined.includes('branch -D')
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  const result = await spawnCapture(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', ref], repo)
  return result.ok && result.stdout.trim() !== ''
}

describe('branch-ref reap — every terminal path (#547)', () => {
  test('the enumeration is the schema’s, and it splits into 3 terminal + 5 active', () => {
    // Guards the two tables below against a silently truncated parse: if this ever
    // reads fewer phases than the schema has, the coverage claim is false.
    expect(TERMINAL.sort()).toEqual(['done', 'failed', 'stopped'])
    expect(NON_TERMINAL.length).toBe(SCHEMA_PHASES.length - 3)
    expect(NON_TERMINAL).not.toContain('done')
  })

  for (const phase of TERMINAL) {
    test(`a dead, clean run in phase '${phase}' loses its ref`, async () => {
      const { root, repo } = await makeRepo()
      const branch = `trident/end-${phase}`
      const sha = await seedRef(repo, branch, `end${phase}`)

      const report = await sweepTridentWorktrees({
        store: stubStore(repo, [], [owner(branch, { phase })]),
        run_host: spawnCapture,
        proc_root: makeProc(root),
      })

      expect(report.refs_deleted.map((entry) => entry.ref)).toContain(`refs/heads/${branch}`)
      expect(await refExists(repo, `refs/heads/${branch}`)).toBe(false)
      // And the work is still reachable: recovery is one command.
      const salvage = report.refs_deleted.find((e) => e.ref === `refs/heads/${branch}`)?.salvage ?? ''
      expect(salvage).toBe(`refs/trident-reaped/end-${phase}/${sha}`)
      expect(await git(repo, 'rev-parse', salvage)).toBe(sha)
      await git(repo, 'branch', branch, sha)
      expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
    }, 30_000)
  }

  for (const phase of NON_TERMINAL) {
    test(`a run still in phase '${phase}' keeps its ref`, async () => {
      const { root, repo } = await makeRepo()
      const branch = `trident/live-${phase}`
      const sha = await seedRef(repo, branch, `live${phase}`)

      const report = await sweepTridentWorktrees({
        store: stubStore(repo, [], [owner(branch, { phase })]),
        run_host: spawnCapture,
        proc_root: makeProc(root),
      })

      expect(report.refs_deleted).toEqual([])
      expect(report.refs_kept).toEqual(
        expect.arrayContaining([
          { ref: `refs/heads/${branch}`, reason: `owner-not-terminal: a run is in phase '${phase}'` },
        ]),
      )
      expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
    }, 30_000)
  }

  test('ONE non-terminal owner keeps a ref every other owner has finished with', async () => {
    // Re-launches share the branch name, so a ref can have many owners. The rule is
    // ALL of them, not the newest — which is why `listBranchOwners` is unbounded.
    const { root, repo } = await makeRepo()
    const branch = 'trident/many-owners'
    const sha = await seedRef(repo, branch, 'many')

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [
        owner(branch, { phase: 'failed' }),
        owner(branch, { phase: 'stopped' }),
        owner(branch, { phase: 'argus' }),
        owner(branch, { phase: 'done' }),
      ]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([])
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 30_000)
})

describe('branch-ref reap — the refusals (#547)', () => {
  test('a ref a LIVE worktree holds is not deleted, even with a terminal owner', async () => {
    const { root, repo } = await makeRepo()
    const holder = await addWorktree(repo, 'wf_live-holder', 'trident/held-live')
    const proc = makeProc(root)
    addProcCwd(proc, 501, holder)
    const before = await git(repo, 'rev-parse', 'refs/heads/trident/held-live')

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner('trident/held-live', { phase: 'failed', worktree: holder })]),
      run_host: spawnCapture,
      proc_root: proc,
    })

    expect(report.live_skipped).toBeGreaterThanOrEqual(1)
    expect(report.detached).toEqual([])
    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual(
      expect.arrayContaining([
        { ref: 'refs/heads/trident/held-live', reason: `held-by-worktree: ${holder}` },
      ]),
    )
    expect(await git(repo, 'rev-parse', 'refs/heads/trident/held-live')).toBe(before)
    expect(await git(holder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trident/held-live')
  }, 30_000)

  test('a LIVE holder hidden from the listing is still caught by the run-process gate', async () => {
    // The holder listing is rewritten to drop the entry, so gate 4 is blinded and the
    // sweep believes the ref is unheld. It must still refuse — and it does, one gate
    // later, because a process is standing in the worktree the owning run recorded.
    //
    // This test used to assert that `git branch -D`'s own holder refusal caught it. That
    // refusal is real but it cannot be compare-and-swapped, and the delete had to become
    // a CAS (see THE BOUNDARY above), so the backstop is now a gate of ours rather than
    // git's. The owner row names the worktree, which is what the real store records.
    const { root, repo } = await makeRepo()
    const holder = await addWorktree(repo, 'wf_hidden-holder', 'trident/hidden')
    const proc = makeProc(root)
    addProcCwd(proc, 701, holder)
    const before = await git(repo, 'rev-parse', 'refs/heads/trident/hidden')

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner('trident/hidden', { phase: 'failed', worktree: holder })]),
      run_host: async (cmd, cwd) => {
        const result = await spawnCapture(cmd, cwd)
        if (cmd.includes('-z') && cmd.includes('list')) {
          const records = result.stdout.split('\0\0').filter((r) => r !== '')
          return { ...result, stdout: `${records[0] ?? ''}\0\0` }
        }
        return result
      },
      proc_root: proc,
    })

    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some(
        (k) =>
          k.ref === 'refs/heads/trident/hidden' &&
          (k.reason.startsWith('run-worktree-present:') || k.reason.startsWith('run-process-live:')),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', 'refs/heads/trident/hidden')).toBe(before)
    expect(await git(holder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trident/hidden')
  }, 30_000)

  test('a worktree this sweep DETACHED but PRESERVED keeps its ref', async () => {
    // The trap this test was written to catch, and it caught it. The worktree pass
    // detaches a process-free `trident/*` holder BEFORE it decides whether the tree may
    // be removed — so a tree preserved right afterwards (inside the retention window,
    // or dirty) has had its ref freed without its work going anywhere. The ref is the
    // history that work sits on top of, so it is kept until the tree itself is gone.
    const { root, repo } = await makeRepo()
    const holder = await addWorktree(repo, 'wf_clean-holder', 'trident/held-clean')
    const now = Date.now()

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner('trident/held-clean', { phase: 'stopped' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      now: () => now,
    })

    expect(report.detached).toContain(holder)
    expect(existsSync(holder)).toBe(true)
    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual(
      expect.arrayContaining([
        { ref: 'refs/heads/trident/held-clean', reason: `held-by-preserved-worktree: ${holder}` },
      ]),
    )
    expect(await refExists(repo, 'refs/heads/trident/held-clean')).toBe(true)
  }, 30_000)

  test('a DIRTY worktree past retention keeps its ref too — removal was refused', async () => {
    const { root, repo } = await makeRepo()
    const holder = await addWorktree(repo, 'wf_dirty-past', 'trident/dirty-past')
    writeFileSync(join(holder, 'only-copy.txt'), 'nowhere else\n')
    const now = Date.now()
    backdate(holder, now)

    const report = await sweepTridentWorktrees({
      // No worktree recorded on the owner row, so nothing but the sweep's own memory of
      // the detach stands between this ref and a delete.
      store: stubStore(repo, [], [owner('trident/dirty-past', { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      now: () => now,
    })

    expect(report.preserved.some((entry) => entry.path === holder)).toBe(true)
    expect(readFileSync(join(holder, 'only-copy.txt'), 'utf8')).toBe('nowhere else\n')
    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual(
      expect.arrayContaining([
        { ref: 'refs/heads/trident/dirty-past', reason: `held-by-preserved-worktree: ${holder}` },
      ]),
    )
    expect(await refExists(repo, 'refs/heads/trident/dirty-past')).toBe(true)
  }, 30_000)

  test('once the worktree is GONE, the same sweep may take the ref', async () => {
    // The other half of the rule above: a tree the pass actually removed no longer
    // holds anything, so its ref is free in that very sweep rather than 15 minutes on.
    const { root, repo } = await makeRepo()
    const holder = await addWorktree(repo, 'wf_removable', 'trident/removable')
    const now = Date.now()
    backdate(holder, now)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner('trident/removable', { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      now: () => now,
    })

    expect(report.removed).toContain(holder)
    expect(existsSync(holder)).toBe(false)
    expect(report.refs_deleted.map((e) => e.ref)).toContain('refs/heads/trident/removable')
    expect(await refExists(repo, 'refs/heads/trident/removable')).toBe(false)
  }, 30_000)

  test('a ref a REBASE is standing on is not deleted, though git calls that tree detached', async () => {
    // git prints no `branch` attribute for a worktree mid-rebase, so the listing alone
    // reads this ref as unheld (`wrong-base-remedy.ts` `readRebaseHead`).
    const { root, repo } = await makeRepo()
    const branch = 'trident/rebasing'
    await seedRef(repo, branch, 'rebasing')
    const tree = await addWorktree(repo, 'wf_rebase-1')

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      rebase_head: (worktree) =>
        worktree === tree ? { kind: 'branch', ref: `refs/heads/${branch}`, state: 'rebase' } : { kind: 'none' },
    })

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual(
      expect.arrayContaining([{ ref: `refs/heads/${branch}`, reason: `held-by-worktree: ${tree}` }]),
    )
    expect(await refExists(repo, `refs/heads/${branch}`)).toBe(true)
  }, 30_000)

  test('a holder whose rebase state cannot be READ freezes every ref in the repo', async () => {
    const { root, repo } = await makeRepo()
    const a = await seedRef(repo, 'trident/unprovable-a', 'unprova')
    const b = await seedRef(repo, 'trident/unprovable-b', 'unprovb')
    await addWorktree(repo, 'wf_opaque-1')

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [
        owner('trident/unprovable-a', { phase: 'failed' }),
        owner('trident/unprovable-b', { phase: 'done' }),
      ]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      rebase_head: () => ({ kind: 'unknown' }),
    })

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept.some((k) => k.reason.startsWith('holder-unprovable:'))).toBe(true)
    expect(await git(repo, 'rev-parse', 'refs/heads/trident/unprovable-a')).toBe(a)
    expect(await git(repo, 'rev-parse', 'refs/heads/trident/unprovable-b')).toBe(b)
  }, 30_000)

  test('no /proc means no ref is examined at all', async () => {
    const { root, repo } = await makeRepo()
    const branch = 'trident/no-proc'
    const sha = await seedRef(repo, branch, 'noproc')

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: join(root, 'absent-proc'),
    })

    expect(report.skipped_no_liveness).toBe(true)
    expect(report.refs_examined).toBe(0)
    expect(report.refs_deleted).toEqual([])
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 30_000)

  test('a ref no run row names is never deleted — the hand-made-branch rule', async () => {
    const { root, repo } = await makeRepo()
    const mine = await seedRef(repo, 'trident/somebody-elses', 'mine')

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner('trident/unrelated', { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual(
      expect.arrayContaining([
        {
          ref: 'refs/heads/trident/somebody-elses',
          reason: 'owner-unknown: no run row names this branch',
        },
      ]),
    )
    expect(await git(repo, 'rev-parse', 'refs/heads/trident/somebody-elses')).toBe(mine)
  }, 30_000)

  test("a terminal run whose worktree still EXISTS keeps its ref", async () => {
    const { root, repo } = await makeRepo()
    const branch = 'trident/tree-standing'
    const sha = await seedRef(repo, branch, 'standing')
    // A directory the run recorded that cleanup never got to remove. Not a registered
    // worktree, so only the OWNER row points at it — which is the point.
    const stranded = join(root, 'stranded-tree')
    mkdirSync(stranded)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed', worktree: stranded })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual(
      expect.arrayContaining([
        { ref: `refs/heads/${branch}`, reason: `run-worktree-present: ${stranded}` },
      ]),
    )
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 30_000)

  test("a live process under the run's generation key keeps its ref", async () => {
    // The row is terminal (hang watchdog, cancel, crash latch) but the detached
    // workflow is still running. The store cannot see that; /proc can.
    const { root, repo } = await makeRepo()
    const branch = 'trident/generation-live'
    const sha = await seedRef(repo, branch, 'genlive')
    const generation = '9f3ac142'
    const elsewhere = join(root, `wf_${generation}-3`)
    mkdirSync(elsewhere)
    const proc = makeProc(root)
    addProcCwd(proc, 601, elsewhere)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed', workflow_run_id: generation })]),
      run_host: spawnCapture,
      proc_root: proc,
    })

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept.some((k) => k.reason.startsWith('run-process-live:'))).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 30_000)

  test('THE BOUNDARY: a commit arriving in the instant before the delete survives', async () => {
    // THE TEST THAT WAS MISSING, and the reason the delete is a CAS.
    //
    // The first cut read the sha with `rev-parse` and then deleted with `git branch -D`,
    // and the test for it moved the ref before the RE-READ — the harmless side of the
    // window. This moves it on the other side: the branch advances after every gate has
    // passed and immediately before the delete command runs, which is exactly what a
    // concurrent lane committing to its own branch does. With a non-atomic `branch -D`
    // the arriving commit is deleted and the sweep reports success; with
    // `update-ref -d <ref> <expected-sha>` git refuses under its own ref lock.
    const { root, repo } = await makeRepo()
    const branch = 'trident/raced-at-the-boundary'
    const before = await seedRef(repo, branch, 'raced')
    let raced: string | null = null

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        // Fire on the DELETE itself — the last possible moment, so no amount of
        // re-checking earlier in the sweep could have seen it.
        //
        // THE TRIGGER IS PRIMITIVE-AGNOSTIC ON PURPOSE. Keyed on `update-ref -d` alone it
        // would never fire against a `git branch -D` implementation, so the test would
        // "catch" that mutation only by noticing the trigger never ran — passing over the
        // very loss it exists to demonstrate. Matching either spelling means the branch
        // really does advance in the window under both, and the assertions below then
        // measure what happened to the arriving commit.
        if (raced === null && isADelete(cmd)) {
          await spawnCapture(['git', '-C', repo, 'commit', '--allow-empty', '-m', 'raced in'], repo)
          await spawnCapture(['git', '-C', repo, 'branch', '-f', branch, 'HEAD'], repo)
          raced = (await spawnCapture(['git', '-C', repo, 'rev-parse', `refs/heads/${branch}`], repo)).stdout.trim()
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    // Narrowed rather than asserted-and-reused: `raced` is `string | null` because the
    // trigger may not have fired, and "it fired" is itself part of what this test claims.
    const arrived = raced
    if (arrived === null) throw new Error('the delete was never reached, so nothing was raced')
    expect(arrived).not.toBe(before)
    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some(
        (k) => k.ref === `refs/heads/${branch}` && k.reason.startsWith('delete-refused:'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    // THE ARRIVING COMMIT IS STILL THERE, on the branch, not merely in the object store.
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(arrived)
    expect(await git(repo, 'log', '-1', '--format=%s', `refs/heads/${branch}`)).toBe('raced in')
  }, 30_000)

  test('the salvage is create-only and idempotent, so two sweeps cannot clobber one another', async () => {
    // `refs/trident-reaped/<slug>/<sha>` is named by the value it holds, so a second
    // sweep of the same slug at the same tip writes the SAME ref and one at a different
    // tip writes a SIBLING. Neither can overwrite the other's salvage. Proven by reaping,
    // restoring the branch to the identical tip, and reaping again.
    const { root, repo } = await makeRepo()
    const branch = 'trident/twice-reaped'
    const sha = await seedRef(repo, branch, 'twice')
    const store = stubStore(repo, [], [owner(branch, { phase: 'failed' })])
    const proc = makeProc(root)

    const first = await sweepTridentWorktrees({ store, run_host: spawnCapture, proc_root: proc })
    expect(first.refs_deleted.map((e) => e.ref)).toContain(`refs/heads/${branch}`)

    // The card is dispatched again and fails again at the very same commit.
    await git(repo, 'branch', branch, sha)
    const second = await sweepTridentWorktrees({ store, run_host: spawnCapture, proc_root: proc })

    expect(second.refs_deleted.map((e) => e.ref)).toContain(`refs/heads/${branch}`)
    expect(await refExists(repo, `refs/heads/${branch}`)).toBe(false)
    // ONE salvage ref, still carrying the tip — not clobbered, not duplicated.
    expect(await git(repo, 'for-each-ref', '--format=%(refname)', SALVAGE_REF_PREFIX)).toBe(
      `refs/trident-reaped/twice-reaped/${sha}`,
    )
    expect(await git(repo, 'rev-parse', `refs/trident-reaped/twice-reaped/${sha}`)).toBe(sha)
  }, 30_000)

  test('a salvage standing at some OTHER sha is refused, never clobbered', async () => {
    // The one case the sha-in-the-name cannot rule out. Planted by hand, because only a
    // hash collision could produce it for real — and refusing beats overwriting whatever
    // is actually under that name.
    const { root, repo } = await makeRepo()
    const branch = 'trident/impostor'
    const sha = await seedRef(repo, branch, 'impostor')
    const other = await git(repo, 'rev-parse', 'refs/heads/main')
    await git(repo, 'update-ref', `refs/trident-reaped/impostor/${sha}`, other)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some(
        (k) => k.ref === `refs/heads/${branch}` && k.reason.startsWith('salvage-unverified:'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
    expect(await git(repo, 'rev-parse', `refs/trident-reaped/impostor/${sha}`)).toBe(other)
  }, 30_000)

  test('a death between the salvage and the delete leaves the branch intact and finishes next sweep', async () => {
    // Each ref's work is exactly two steps, and nothing spans two refs — which is what
    // makes MAX_REF_DELETIONS_PER_SWEEP and a mid-sweep death harmless. Simulated by
    // failing the delete outright after the salvage has landed.
    const { root, repo } = await makeRepo()
    const branch = 'trident/half-done'
    const sha = await seedRef(repo, branch, 'halfdone')
    const store = stubStore(repo, [], [owner(branch, { phase: 'failed' })])
    const proc = makeProc(root)

    const interrupted = await sweepTridentWorktrees({
      store,
      run_host: async (cmd, cwd) => {
        if (cmd.includes('update-ref') && cmd.includes('-d')) {
          return { ok: false, stdout: '', stderr: 'the process died here', exit_code: 1 }
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: proc,
    })

    expect(interrupted.refs_deleted).toEqual([])
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
    expect(await git(repo, 'rev-parse', `refs/trident-reaped/half-done/${sha}`)).toBe(sha)

    // The next sweep confirms the existing salvage and finishes the job.
    const resumed = await sweepTridentWorktrees({ store, run_host: spawnCapture, proc_root: proc })
    expect(resumed.refs_deleted.map((e) => e.ref)).toContain(`refs/heads/${branch}`)
    expect(await refExists(repo, `refs/heads/${branch}`)).toBe(false)
    expect(await git(repo, 'rev-parse', `refs/trident-reaped/half-done/${sha}`)).toBe(sha)
  }, 30_000)

  test('a salvage that cannot be written blocks the delete', async () => {
    // Only the salvage WRITE is broken, not the delete: a stub that broke both would let
    // the ref survive for the wrong reason and prove nothing about the ordering.
    const { root, repo } = await makeRepo()
    const branch = 'trident/no-salvage'
    const sha = await seedRef(repo, branch, 'nosalv')
    let deleteAttempted = false

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (cmd.includes('update-ref') && cmd.includes('-d')) deleteAttempted = true
        if (cmd.includes('update-ref') && !cmd.includes('-d')) {
          return { ok: false, stdout: '', stderr: 'refusing to write the salvage ref', exit_code: 1 }
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    // A failed write falls through to a read, which finds nothing — so the tip is not
    // proven reachable anywhere else and the delete is never even attempted.
    expect(deleteAttempted).toBe(false)
    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some(
        (k) =>
          k.ref === `refs/heads/${branch}` &&
          k.reason.startsWith('salvage-unverified:') &&
          k.reason.includes('refusing to write the salvage ref'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
    expect(await refExists(repo, `refs/trident-reaped/no-salvage/${sha}`)).toBe(false)
  }, 30_000)

  test('refs cannot be enumerated → nothing in that repo is touched', async () => {
    const { root, repo } = await makeRepo()
    const branch = 'trident/unenumerable'
    const sha = await seedRef(repo, branch, 'unenum')

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        const result = await spawnCapture(cmd, cwd)
        // A FAILING enumeration that still wrote output, which is the shape that makes
        // this a real gate rather than a comment: a mutant that records the failure and
        // carries on would parse this list and reach the delete.
        if (cmd.includes('for-each-ref')) {
          return { ...result, ok: false, stderr: 'cannot read refs', exit_code: 128 }
        }
        return result
      },
      proc_root: makeProc(root),
    })

    expect(report.refs_examined).toBe(0)
    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept.some((k) => k.reason.startsWith('refs-unenumerable:'))).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 30_000)

  test('holders cannot be enumerated → nothing in that repo is touched', async () => {
    const { root, repo } = await makeRepo()
    const branch = 'trident/holders-dark'
    const sha = await seedRef(repo, branch, 'holddark')

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (cmd.includes('-z') && cmd.includes('list')) {
          return { ok: false, stdout: '', stderr: 'cannot list worktrees', exit_code: 128 }
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept.some((k) => k.reason.startsWith('holders-unenumerable:'))).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 30_000)

  test('a DIRTY worktree is still preserved, and so is the ref underneath it', async () => {
    // The #541 property, extended: preserving a tree that holds the only copy of some
    // work and then deleting the branch its work sits on top of would preserve nothing.
    const { root, repo } = await makeRepo()
    const dirty = await addWorktree(repo, 'wf_dirty-ref', 'trident/dirty-ref')
    writeFileSync(join(dirty, 'rescue-me.txt'), 'the only copy\n')
    const now = Date.now()
    backdate(dirty, now)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner('trident/dirty-ref', { phase: 'failed', worktree: dirty })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      now: () => now,
    })

    expect(report.refs_deleted).toEqual([])
    expect(existsSync(dirty)).toBe(true)
    expect(readFileSync(join(dirty, 'rescue-me.txt'), 'utf8')).toBe('the only copy\n')
    expect(await refExists(repo, 'refs/heads/trident/dirty-ref')).toBe(true)
  }, 30_000)

  test('the ref pass stands down while the boot rescue has not settled', async () => {
    // Found by CI, not by reasoning (`build-core-modules-trident-stranded-sweep.test.ts`):
    // the boot rescue for a stranded failed PR run publishes its commits by PUSHING ITS
    // BRANCH, and on the boot where both fire the reaper deleted the ref first, leaving
    // the rescue nothing to push. The WORKTREE half still runs — only refs wait.
    const { root, repo } = await makeRepo()
    const branch = 'trident/rescue-pending'
    const sha = await seedRef(repo, branch, 'rescue')
    const removable = await addWorktree(repo, 'wf_removable-too')
    const now = Date.now()
    backdate(removable, now)

    const waiting = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      now: () => now,
      refs_ready: () => false,
    })

    expect(waiting.refs_examined).toBe(0)
    expect(waiting.refs_deleted).toEqual([])
    expect(waiting.refs_kept).toEqual(
      expect.arrayContaining([
        {
          ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
          reason: 'awaiting-boot-rescue: the stranded-failure sweep has not settled yet',
        },
      ]),
    )
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
    // The worktree half is NOT deferred with it.
    expect(waiting.removed).toContain(removable)

    const secondRoot = join(root, 'second')
    mkdirSync(secondRoot)
    const after = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(secondRoot),
      now: () => now,
      refs_ready: () => true,
    })

    expect(after.refs_deleted.map((e) => e.ref)).toContain(`refs/heads/${branch}`)
    expect(await refExists(repo, `refs/heads/${branch}`)).toBe(false)
  }, 30_000)

  test('a branch outside refs/heads/trident/ is never even looked at', async () => {
    const { root, repo } = await makeRepo()
    const mine = await seedRef(repo, 'feature/mine', 'feature')
    const pinned = await seedRef(repo, 'member/pinned-lane', 'member')

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [
        owner('feature/mine', { phase: 'failed' }),
        owner('member/pinned-lane', { phase: 'done' }),
        owner('main', { phase: 'done' }),
      ]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    expect(report.refs_examined).toBe(0)
    expect(report.refs_deleted).toEqual([])
    expect(await git(repo, 'rev-parse', 'refs/heads/feature/mine')).toBe(mine)
    expect(await git(repo, 'rev-parse', 'refs/heads/member/pinned-lane')).toBe(pinned)
    expect(await refExists(repo, 'refs/heads/main')).toBe(true)
  }, 30_000)
})

describe('branch-ref reap — the backlog sweep (#547)', () => {
  test('many finished refs drain, capped per sweep, with the unprovable ones left behind', async () => {
    const { root, repo } = await makeRepo()
    const owners: TridentBranchOwner[] = []
    const dead: string[] = []
    for (let i = 0; i < MAX_REF_DELETIONS_PER_SWEEP + 3; i++) {
      const branch = `trident/backlog-${i}`
      await seedRef(repo, branch, `backlog${i}`)
      dead.push(branch)
      owners.push(owner(branch, { phase: i % 2 === 0 ? 'failed' : 'stopped' }))
    }
    const unowned = 'trident/backlog-unowned'
    const unownedSha = await seedRef(repo, unowned, 'backlogun')
    const proc = makeProc(root)

    const first = await sweepTridentWorktrees({
      store: stubStore(repo, [], owners),
      run_host: spawnCapture,
      proc_root: proc,
    })

    expect(first.refs_deleted).toHaveLength(MAX_REF_DELETIONS_PER_SWEEP)
    expect(first.refs_kept.some((k) => k.reason === 'deletion limit reached')).toBe(true)
    // The unprovable one is never in the drain, this sweep or any other.
    expect(first.refs_deleted.some((e) => e.ref === `refs/heads/${unowned}`)).toBe(false)

    const second = await sweepTridentWorktrees({
      store: stubStore(repo, [], owners),
      run_host: spawnCapture,
      proc_root: proc,
    })

    expect(first.refs_deleted.length + second.refs_deleted.length).toBe(dead.length)
    for (const branch of dead) expect(await refExists(repo, `refs/heads/${branch}`)).toBe(false)
    expect(await git(repo, 'rev-parse', `refs/heads/${unowned}`)).toBe(unownedSha)
    expect(second.refs_kept).toEqual(
      expect.arrayContaining([
        { ref: `refs/heads/${unowned}`, reason: 'owner-unknown: no run row names this branch' },
      ]),
    )
  }, 120_000)

  test('every reaped tip stays reachable under refs/trident-reaped/', async () => {
    const { root, repo } = await makeRepo()
    const branch = 'trident/reachable'
    const sha = await seedRef(repo, branch, 'reachable')

    await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    expect(await refExists(repo, `refs/heads/${branch}`)).toBe(false)
    const salvaged = await git(repo, 'for-each-ref', '--format=%(refname)', SALVAGE_REF_PREFIX)
    expect(salvaged).toBe(`refs/trident-reaped/reachable/${sha}`)
    // Reachable means git will not collect it, and the content is still there.
    expect(await git(repo, 'cat-file', '-t', sha)).toBe('commit')
    expect(await git(repo, 'show', `${sha}:reachable.txt`)).toBe('reachable')
  }, 30_000)
})
