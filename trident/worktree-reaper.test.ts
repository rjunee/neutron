import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { spawnCapture } from './git-mode.ts'
import type { RunHostCommand } from './merge.ts'
import { TERMINAL_PHASES } from './state-machine.ts'
import type { TridentBranchOwner, TridentPhase, TridentRun } from './store.ts'
import {
  buildWorktreeReaperLoop,
  DEFAULT_REAP_INTERVAL_MS,
  DEFAULT_WORKTREE_RETENTION_MS,
  deleteReapableRef,
  DEFERRED_PENDING_CLAIMANT_GUARD,
  MAX_REF_DELETIONS_PER_SWEEP,
  MAX_RESTORE_ATTEMPTS,
  type ReapableCandidate,
  SALVAGE_REF_PREFIX,
  TRIDENT_REF_PREFIX,
  sweepTridentWorktrees,
  type WorktreeReaperStore,
  type WorktreeReapReport,
} from './worktree-reaper.ts'

/**
 * THE SWEEP PLUS THE DESTRUCTIVE HALF — which production does NOT do, and that is the point.
 *
 * `#606` ships every gate, the measurement and the reporting; the `update-ref -d` itself waits
 * for `#635` (a run whose HEAD does not resolve must refuse to commit), because nothing deletes
 * these refs today and a destructive operation should not arrive ahead of the only check that
 * can settle its failure mode without a race. The sweep therefore records CANDIDATES — refs that
 * pass gates 1-10, an upper bound on what would be deleted rather than a measurement of it — in
 * `refs_candidates`, and calls nothing.
 *
 * Every test below that exercises the salvage, the claim probe, the compare-and-swap delete or
 * the repair drives it through here, so the code `#635` re-enables is code whose coverage never
 * lapsed — which is the whole reason the destructive half was extracted rather than short-
 * circuited. `#635`'s change is to delete the deferral and call this sequence from the sweep.
 *
 * For a refusal case this is a pure passthrough: nothing is reapable, so nothing is called and
 * the behaviour is the sweep's own.
 */
async function sweepAndReap(opts: Parameters<typeof sweepTridentWorktrees>[0]): Promise<WorktreeReapReport> {
  const report = await sweepTridentWorktrees(opts)
  const budget = { attempts: 0 }
  for (const minted of [...report.refs_candidates]) {
    // EACH CANDIDATE GOES TO THE REPOSITORY IT WAS MINTED FOR (#547 round 14). This used to
    // aim every candidate at the FIRST non-empty `listRepoPaths()` entry, which was invisible
    // while a candidate was `{ ref, sha }` and the attestation was repo-blind. Once the
    // attestation became repo-bound, that harness silently refused every candidate from the
    // second repository onward — so a multi-repository sweep's destructive path was not merely
    // untested, it was WRONG in the stand-in for the call structure #635 restores.
    //
    // THE CANDIDATE IS PASSED THROUGH, NOT REBUILT. `deleteReapableRef` only accepts a value
    // the gate chain minted, so a test that reconstructed `{ repo, ref, sha }` here would be
    // refused at gate 0 — which is exactly the property the negative tests below pin.
    await deleteReapableRef(opts, minted.repo, minted, report, budget)
  }
  return report
}

/**
 * The kept-reason a test means: the LAST one recorded for this ref, skipping the deferral note
 * the sweep always adds for a reapable ref. `find` picked that note up and hid the outcome the
 * test was actually asserting on.
 */
function keptReasonFor(report: WorktreeReapReport, full: string): string | undefined {
  return report.refs_kept
    .filter((k) => k.ref === full && k.reason !== DEFERRED_PENDING_CLAIMANT_GUARD)
    .at(-1)?.reason
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnCapture(['git', '-C', cwd, ...args], cwd)
  expect(result.ok, `git ${args.join(' ')}\n${result.stderr || result.stdout}`).toBe(true)
  return result.stdout.trim()
}

async function makeRepo(
  objectFormat?: 'sha1' | 'sha256',
): Promise<{ root: string; repo: string }> {
  const root = mkdtempSync(join(tmpdir(), 'trident-worktree-reaper-'))
  roots.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  // The default spelling stays EXACTLY as it was, so every existing case is untouched; the
  // sha256 path is opt-in and exists because this module composes a ref NAME out of an object
  // name and so has to know how long one is.
  if (objectFormat === undefined) await git(repo, 'init', '-b', 'main')
  else await git(repo, 'init', '-b', 'main', `--object-format=${objectFormat}`)
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

/**
 * A store spanning SEVERAL repositories, with per-repository owner rows.
 *
 * `listBranchOwners` is called once per repository by the sweep, so a multi-repository case has
 * to answer per repository or every repo sees every repo's owners — which would make a
 * cross-repository mistake look like success.
 */
function stubMultiStore(
  byRepo: Record<string, TridentBranchOwner[]>,
): WorktreeReaperStore {
  return {
    listRepoPaths: () => Object.keys(byRepo),
    listNonTerminal: () => [],
    listBranchOwners: (repo) => byRepo[repo] ?? [],
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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
  expect(source.match(/'update-ref', '--no-deref', '-d'/g) ?? []).toHaveLength(1)
  expect(source).toContain("['git', '-C', repo, 'update-ref', '--no-deref', '-d', ref, sha]")
  // `--no-deref` IS THE FLAG, and its absence is what made the delete able to remove
  // `refs/heads/main` through a symref. Banned in its dereferencing form outright so the
  // flag cannot be dropped back out (proven against real git below).
  expect(source).not.toContain("'update-ref', '-d'")
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

  const report = await sweepAndReap({
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

/**
 * A zeroed report, for the cases that call the destructive half directly.
 *
 * Shared rather than re-declared per describe: the shape is the module's, so one copy means one
 * place to update when a field is added and no chance of two cases disagreeing about the start
 * state they are asserting against.
 */
function emptyReapReport(): WorktreeReapReport {
  return {
    repos_swept: 0,
    candidates: 0,
    live_skipped: 0,
    detached: [],
    removed: [],
    preserved: [],
    protected_nonterminal: [],
    skipped_no_liveness: false,
    refs_examined: 0,
    refs_deleted: [],
    refs_kept: [],
    refs_stood_down: 0,
    refs_restored: [],
    refs_restore_failed: [],
    refs_candidates: [],
  }
}

/**
 * The canonical spelling of a repository path, which is what a minted candidate carries.
 *
 * Asserted through `realpathSync` rather than against the raw path, so these cases do not
 * quietly depend on the test root having no symlink in it — on a host where `/tmp` is itself a
 * link, a raw comparison would pass or fail for a reason that has nothing to do with the code.
 */
function canonical(repo: string): string {
  return realpathSync(repo)
}

/** The full ref for a short branch name, so the tests read the way the module does. */
function ref(branch: string): string {
  return `refs/heads/${branch}`
}

/** Every spelling of "delete this ref" a sweep could reach for. */
function isADelete(cmd: readonly string[]): boolean {
  const joined = cmd.join(' ')
  return /update-ref (--no-deref )?-d/.test(joined) || joined.includes('branch -D')
}

/**
 * The one candidate a sweep minted, non-optional.
 *
 * Tests take candidates the way production will — out of the report the gate chain filled —
 * and `deleteReapableRef` accepts nothing else. This asserts the inventory rather than
 * cast away the `undefined`, so a sweep that minted nothing fails HERE, loudly, instead of
 * further down where a boundary refusal would look like the behaviour under test.
 */
function onlyCandidate(report: WorktreeReapReport): ReapableCandidate {
  expect(report.refs_candidates).toHaveLength(1)
  const minted = report.refs_candidates[0]
  if (minted === undefined) throw new Error('the sweep minted no candidate')
  return minted
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

      const report = await sweepAndReap({
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

      const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

  test('TWO SWEEPS: a DIRTY tree detached by sweep 1 still holds its ref on sweep 2', async () => {
    // THE DEFECT THIS TEST EXISTS FOR (adversarial review of PR #606, escalated to a
    // tiebreak and confirmed). `detachedThisSweep` is per-sweep memory: on sweep 2 the
    // tree is ALREADY detached, `entry.branch` is null, the detach block never runs, the
    // map is empty — and the ref of a tree sweep 1 deliberately preserved was deleted.
    // The one-sweep test that shipped could not see it. Gate 4c matches the ref's COMMIT
    // against the HEAD of every linked tree still on disk, which is durable across sweeps.
    const { root, repo } = await makeRepo()
    const holder = await addWorktree(repo, 'wf_dirty-two-sweeps', 'trident/dirty-two')
    // A real build commit, so the branch tip is NOT main's — otherwise the tip would
    // coincide with the shared checkout's HEAD and the test could pass by accident.
    writeFileSync(join(holder, 'built.txt'), 'built\n')
    await git(holder, 'add', '-A')
    await git(holder, 'commit', '-m', 'the build')
    writeFileSync(join(holder, 'only-copy.txt'), 'nowhere else\n')
    const tip = await git(repo, 'rev-parse', 'refs/heads/trident/dirty-two')
    expect(tip).not.toBe(await git(repo, 'rev-parse', 'refs/heads/main'))
    const now = Date.now()
    backdate(holder, now)
    const store = stubStore(repo, [], [owner('trident/dirty-two', { phase: 'failed' })])
    const proc = makeProc(root)

    const first = await sweepAndReap({
      store, run_host: spawnCapture, proc_root: proc, now: () => now,
    })
    expect(first.detached).toContain(holder)
    expect(first.refs_deleted).toEqual([])
    expect(await refExists(repo, 'refs/heads/trident/dirty-two')).toBe(true)

    // SWEEP 2 — nothing about the tree changed; it is simply already detached.
    const second = await sweepAndReap({
      store, run_host: spawnCapture, proc_root: proc, now: () => now,
    })

    expect(second.detached).toEqual([])
    expect(second.refs_deleted).toEqual([])
    expect(second.refs_kept).toEqual(
      expect.arrayContaining([
        { ref: 'refs/heads/trident/dirty-two', reason: `held-by-detached-worktree: ${holder}` },
      ]),
    )
    expect(await git(repo, 'rev-parse', 'refs/heads/trident/dirty-two')).toBe(tip)
    expect(readFileSync(join(holder, 'only-copy.txt'), 'utf8')).toBe('nowhere else\n')
    // Still held on a third, so this is a property and not an off-by-one.
    const third = await sweepAndReap({
      store, run_host: spawnCapture, proc_root: proc, now: () => now,
    })
    expect(third.refs_deleted).toEqual([])
    expect(await refExists(repo, 'refs/heads/trident/dirty-two')).toBe(true)
  }, 60_000)

  test('TWO SWEEPS: a tree WITHIN RETENTION detached by sweep 1 still holds its ref', async () => {
    // The other half of the same defect. Nothing here is dirty — the tree is simply too
    // young to remove, so sweep 1 detaches it and keeps it, and on sweep 2 the only thing
    // standing between its ref and a delete is gate 4c.
    const { root, repo } = await makeRepo()
    const holder = await addWorktree(repo, 'wf_young-two-sweeps', 'trident/young-two')
    writeFileSync(join(holder, 'built.txt'), 'built\n')
    await git(holder, 'add', '-A')
    await git(holder, 'commit', '-m', 'the build')
    const tip = await git(repo, 'rev-parse', 'refs/heads/trident/young-two')
    expect(tip).not.toBe(await git(repo, 'rev-parse', 'refs/heads/main'))
    const now = Date.now()
    const store = stubStore(repo, [], [owner('trident/young-two', { phase: 'stopped' })])
    const proc = makeProc(root)

    const first = await sweepAndReap({
      store, run_host: spawnCapture, proc_root: proc, now: () => now,
    })
    expect(first.detached).toContain(holder)
    expect(first.preserved.some((e) => e.path === holder && e.reason === 'within retention')).toBe(true)
    expect(first.refs_deleted).toEqual([])

    const second = await sweepAndReap({
      store, run_host: spawnCapture, proc_root: proc, now: () => now,
    })

    expect(second.refs_deleted).toEqual([])
    expect(second.refs_kept).toEqual(
      expect.arrayContaining([
        { ref: 'refs/heads/trident/young-two', reason: `held-by-detached-worktree: ${holder}` },
      ]),
    )
    expect(await git(repo, 'rev-parse', 'refs/heads/trident/young-two')).toBe(tip)
    expect(existsSync(holder)).toBe(true)
  }, 60_000)

  test('once the worktree is GONE, the same sweep may take the ref', async () => {
    // The other half of the rule above: a tree the pass actually removed no longer
    // holds anything, so its ref is free in that very sweep rather than 15 minutes on.
    const { root, repo } = await makeRepo()
    const holder = await addWorktree(repo, 'wf_removable', 'trident/removable')
    const now = Date.now()
    backdate(holder, now)

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

  test('REAL GIT: a conflicted rebase holds the ref, with nothing injected', async () => {
    // The shipped rebase test INJECTED `rebase_head`, so it proved the plumbing and not
    // the fact. This drives a real conflicted rebase and passes no seam at all, so
    // `readRebaseHead` must read `rebase-merge/head-name` off disk for itself.
    //
    // GATE 4c CANNOT SAVE THIS ONE, which is why both gates are kept: mid-rebase git parks
    // HEAD on the `onto` commit, not on the branch tip, so the commit-keyed gate sees
    // nothing and the name-keyed gate is the only one that can answer.
    const { root, repo } = await makeRepo()
    const branch = 'trident/rebasing-for-real'
    writeFileSync(join(repo, 'f.txt'), 'base\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-m', 'f base')
    // `rb_` and not `wf_`, so the worktree pass skips it and gate 4 is measured alone.
    const tree = await addWorktree(repo, 'rb_conflict', branch)
    writeFileSync(join(tree, 'f.txt'), 'from the build\n')
    await git(tree, 'commit', '-am', 'build side')
    const tip = await git(repo, 'rev-parse', `refs/heads/${branch}`)
    writeFileSync(join(repo, 'f.txt'), 'from main\n')
    await git(repo, 'commit', '-am', 'main side')
    const rebase = await spawnCapture(['git', '-C', tree, 'rebase', 'main'], tree)
    expect(rebase.ok, 'the rebase must CONFLICT for this test to mean anything').toBe(false)
    // git now reports the tree as DETACHED with no branch attribute, parked on `onto`.
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toContain('detached')
    expect(await git(tree, 'rev-parse', 'HEAD')).not.toBe(tip)

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      // NOTHING INJECTED.
    })

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual(
      expect.arrayContaining([{ ref: `refs/heads/${branch}`, reason: `held-by-worktree: ${tree}` }]),
    )
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(tip)
  }, 60_000)

  test('REAL GIT: a detached bisect holds the ref, with nothing injected', async () => {
    // `git bisect` detaches HEAD onto a MIDDLE commit and records the branch it left in
    // `BISECT_START`. So, like the rebase above, the listing says detached, gate 4c sees a
    // sha that is not the tip, and only `readRebaseHead`'s BISECT_START read answers.
    const { root, repo } = await makeRepo()
    const branch = 'trident/bisecting-for-real'
    const tree = await addWorktree(repo, 'bs_bisect', branch)
    for (const n of [1, 2, 3, 4, 5]) {
      writeFileSync(join(tree, `c${n}.txt`), `${n}\n`)
      await git(tree, 'add', '-A')
      await git(tree, 'commit', '-m', `c${n}`)
    }
    const tip = await git(repo, 'rev-parse', `refs/heads/${branch}`)
    await git(tree, 'bisect', 'start')
    await git(tree, 'bisect', 'bad', 'HEAD')
    await git(tree, 'bisect', 'good', 'HEAD~4')
    expect(await git(tree, 'rev-parse', 'HEAD')).not.toBe(tip)
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toContain('detached')

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'done' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      // NOTHING INJECTED.
    })

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual(
      expect.arrayContaining([{ ref: `refs/heads/${branch}`, reason: `held-by-worktree: ${tree}` }]),
    )
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(tip)
  }, 60_000)

  test('a PLAINLY checked-out holder is refused by gate 4, which update-ref -d would not be', async () => {
    // `git branch -D` used to be the delete and carried git's own refusal for this case
    // for free. `update-ref -d` does NOT, so the refusal has to come from gate 4 — and
    // this test is what proves gate 4 supplies it rather than assuming so.
    const { root, repo } = await makeRepo()
    const branch = 'trident/plainly-checked-out'
    // `co_` not `wf_`: the worktree pass must not detach it, so gate 4 is measured alone.
    const tree = await addWorktree(repo, 'co_plain', branch)
    const tip = await git(repo, 'rev-parse', `refs/heads/${branch}`)

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual(
      expect.arrayContaining([{ ref: `refs/heads/${branch}`, reason: `held-by-worktree: ${tree}` }]),
    )
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(tip)
    expect(await git(tree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch)
    // THE PREMISE, measured rather than asserted: the delete primitive would have gone
    // through. If a future git starts refusing this, the gate is belt-and-braces and this
    // line is what will say so.
    const direct = await spawnCapture(
      ['git', '-C', repo, 'update-ref', '-d', `refs/heads/${branch}`, tip],
      repo,
    )
    expect(direct.ok, 'update-ref -d is expected NOT to refuse a checked-out branch').toBe(true)
  }, 60_000)

  test('a listed worktree whose DIRECTORY is gone stands the whole repo down', async () => {
    // What actually happens to a stale admin entry, pinned because it is the scenario the
    // stand-down logging exists for, and because it is why gate 4c's `existsSync` cannot be
    // distinguished by any test (see the note at that line). Normally `worktree prune` drops
    // such an entry before the ref pass sees it; here prune is denied, so it survives into
    // the listing — detached, with no directory to read a rebase state out of. That reads as
    // 'unknown', and unknown freezes every ref in the repo rather than guessing.
    const { root, repo } = await makeRepo()
    const branch = 'trident/stale-admin-entry'
    const tree = await addWorktree(repo, 'wf_stale-admin', branch)
    writeFileSync(join(tree, 'built.txt'), 'built\n')
    await git(tree, 'add', '-A')
    await git(tree, 'commit', '-m', 'the build')
    const tip = await git(repo, 'rev-parse', `refs/heads/${branch}`)
    const store = stubStore(repo, [], [owner(branch, { phase: 'failed' })])
    const proc = makeProc(root)
    const denyPrune: RunHostCommand = async (cmd, cwd) => {
      if (cmd.includes('prune')) return { ok: false, stdout: '', stderr: 'prune denied', exit_code: 1 }
      return spawnCapture(cmd, cwd)
    }

    // Sweep 1 detaches it while the directory is still there.
    await sweepAndReap({ store, run_host: denyPrune, proc_root: proc })
    rmSync(tree, { recursive: true, force: true })

    const report = await sweepAndReap({ store, run_host: denyPrune, proc_root: proc })

    expect(report.refs_stood_down).toBe(1)
    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some((k) => k.reason.startsWith('holder-unprovable:')),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(tip)
  }, 60_000)

  test('a FAILED salvage verify is not evidence, even when its stdout says the right thing', async () => {
    // The `!confirmed.ok` half of the salvage check, which the sha compare alone does not
    // cover: a host that exits non-zero while still printing the expected sha. A command
    // that failed established nothing, so its output is not proof the salvage landed — and
    // the salvage is the whole no-data-loss argument.
    const { root, repo } = await makeRepo()
    const branch = 'trident/lying-host'
    const sha = await seedRef(repo, branch, 'lyinghost')

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        // Break the salvage WRITE so the verify is reached at all...
        if (cmd.includes('update-ref') && !cmd.includes('-d')) {
          return { ok: false, stdout: '', stderr: 'write denied', exit_code: 1 }
        }
        // ...then have the verify fail while printing exactly the sha being looked for.
        if (cmd.includes('rev-parse') && cmd.some((a) => a.startsWith(SALVAGE_REF_PREFIX))) {
          return { ok: false, stdout: `${sha}\n`, stderr: 'verify denied', exit_code: 1 }
        }
        return spawnCapture(cmd, cwd)
      },
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
  }, 60_000)

  test('gates 7 and 8 read EVERY claimant, not just the first', async () => {
    // A re-launched card has several owner rows on one branch. The gates use `find` over
    // all of them; a first-owner-only read would delete a ref whose SECOND owner is the
    // one with the surviving tree or the live process.
    const { root, repo } = await makeRepo()
    const treeBranch = 'trident/second-owner-tree'
    const procBranch = 'trident/third-owner-proc'
    const treeTip = await seedRef(repo, treeBranch, 'secondtree')
    const procTip = await seedRef(repo, procBranch, 'thirdproc')
    const stranded = join(root, 'stranded-for-second')
    mkdirSync(stranded)
    const generation = '5c1f0d21'
    const busy = join(root, `wf_${generation}-7`)
    mkdirSync(busy)
    const proc = makeProc(root)
    addProcCwd(proc, 801, busy)

    const report = await sweepAndReap({
      store: stubStore(repo, [], [
        owner(treeBranch, { phase: 'failed' }),
        owner(treeBranch, { phase: 'stopped', worktree: stranded }),
        owner(procBranch, { phase: 'failed' }),
        owner(procBranch, { phase: 'failed' }),
        owner(procBranch, { phase: 'stopped', workflow_run_id: generation }),
      ]),
      run_host: spawnCapture,
      proc_root: proc,
    })

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual(
      expect.arrayContaining([
        { ref: `refs/heads/${treeBranch}`, reason: `run-worktree-present: ${stranded}` },
      ]),
    )
    expect(
      report.refs_kept.some(
        (k) => k.ref === `refs/heads/${procBranch}` && k.reason.startsWith('run-process-live:'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${treeBranch}`)).toBe(treeTip)
    expect(await git(repo, 'rev-parse', `refs/heads/${procBranch}`)).toBe(procTip)
  }, 60_000)

  test('a holder whose rebase state cannot be READ freezes every ref in the repo', async () => {
    const { root, repo } = await makeRepo()
    const a = await seedRef(repo, 'trident/unprovable-a', 'unprova')
    const b = await seedRef(repo, 'trident/unprovable-b', 'unprovb')
    await addWorktree(repo, 'wf_opaque-1')

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const first = await sweepAndReap({ store, run_host: spawnCapture, proc_root: proc })
    expect(first.refs_deleted.map((e) => e.ref)).toContain(`refs/heads/${branch}`)

    // The card is dispatched again and fails again at the very same commit.
    await git(repo, 'branch', branch, sha)
    const second = await sweepAndReap({ store, run_host: spawnCapture, proc_root: proc })

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

    const report = await sweepAndReap({
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

    const interrupted = await sweepAndReap({
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
    const resumed = await sweepAndReap({ store, run_host: spawnCapture, proc_root: proc })
    expect(resumed.refs_deleted.map((e) => e.ref)).toContain(`refs/heads/${branch}`)
    expect(await refExists(repo, `refs/heads/${branch}`)).toBe(false)
    expect(await git(repo, 'rev-parse', `refs/trident-reaped/half-done/${sha}`)).toBe(sha)
  }, 30_000)

  test('THE OWNERSHIP RACE: a worktree added at the UNCHANGED tip just before the delete', async () => {
    // THE REVIEWER'S EXACT INTERLEAVING (#547 round 3). The CAS protects the ref's VALUE,
    // so a claim that does NOT move the sha sails straight through it: pause immediately
    // before the delete, `git worktree add` the branch at the already-enumerated tip,
    // resume. The expected sha still matches, the delete succeeds — and a branch a live run
    // is standing on is gone. `update-ref -d` will not refuse a checked-out branch (proven
    // by "a PLAINLY checked-out holder…" above), which is what makes this bite.
    const { root, repo } = await makeRepo()
    const branch = 'trident/claimed-mid-sweep'
    const sha = await seedRef(repo, branch, 'claimed')
    const claimant = join(repo, '.claude', 'worktrees', 'wf_the-next-run')
    mkdirSync(dirname(claimant), { recursive: true })
    let claimed = false

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        // Fire at the LAST possible moment: the delete command itself.
        if (!claimed && cmd.includes('update-ref') && cmd.includes('-d')) {
          claimed = true
          const added = await spawnCapture(
            ['git', '-C', repo, 'worktree', 'add', claimant, branch],
            repo,
          )
          expect(added.ok, added.stderr).toBe(true)
          // THE PREMISE: the tip has NOT moved, so the CAS cannot refuse on value.
          expect(await (await spawnCapture(['git', '-C', repo, 'rev-parse', `refs/heads/${branch}`], repo)).stdout.trim()).toBe(sha)
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(claimed).toBe(true)
    // The ref is NOT reported as reaped, and it is BACK at exactly the sha it had.
    expect(report.refs_deleted).toEqual([])
    expect(report.refs_restored).toEqual([{ ref: `refs/heads/${branch}`, sha }])
    expect(
      report.refs_kept.some(
        (k) => k.ref === `refs/heads/${branch}` && k.reason.startsWith('raced-a-change:'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
    // AND THE CLAIMANT IS WHOLE: its worktree still resolves the branch to that commit.
    expect(await git(claimant, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch)
    expect(await git(claimant, 'rev-parse', 'HEAD')).toBe(sha)
    expect(await git(claimant, 'show', `${branch}:claimed.txt`)).toBe('claimed')
  }, 60_000)

  test('a claim that lands BEFORE the delete means the delete never happens', async () => {
    // The ordinary case, and the one that must not even perform the destructive act. The
    // claim commits between the per-ref gates and the delete — here, on the salvage write.
    const { root, repo } = await makeRepo()
    const branch = 'trident/claimed-early'
    const sha = await seedRef(repo, branch, 'early')
    const claimant = join(repo, '.claude', 'worktrees', 'wf_early-run')
    mkdirSync(dirname(claimant), { recursive: true })
    let deleteAttempted = false

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (cmd.includes('update-ref') && cmd.includes('-d')) deleteAttempted = true
        const result = await spawnCapture(cmd, cwd)
        if (cmd.includes('update-ref') && cmd.some((a) => a.startsWith(SALVAGE_REF_PREFIX))) {
          await spawnCapture(['git', '-C', repo, 'worktree', 'add', claimant, branch], repo)
        }
        return result
      },
      proc_root: makeProc(root),
    })

    expect(deleteAttempted).toBe(false)
    expect(report.refs_restored).toEqual([])
    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some(
        (k) => k.ref === `refs/heads/${branch}` && k.reason.startsWith('refuses-now:'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 60_000)

  test('a LIVE RUN ROW appearing mid-sweep also stops the reap', async () => {
    // The other half of a claim: the dispatch INSERTs a non-terminal row. The store read is
    // re-taken, so a row that appears after the ownership snapshot is seen.
    const { root, repo } = await makeRepo()
    const branch = 'trident/row-claimed'
    const sha = await seedRef(repo, branch, 'rowclaim')
    const rows: TridentBranchOwner[] = [owner(branch, { phase: 'failed' })]
    const store: WorktreeReaperStore = {
      listRepoPaths: () => [repo],
      listNonTerminal: () => [],
      listBranchOwners: () => [...rows],
    }

    const report = await sweepAndReap({
      store,
      run_host: async (cmd, cwd) => {
        if (cmd.includes('update-ref') && cmd.some((a) => a.startsWith(SALVAGE_REF_PREFIX))) {
          // The next launch of this card claims the slug.
          rows.push(owner(branch, { phase: 'forge-init' }))
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some(
        (k) =>
          k.ref === `refs/heads/${branch}` &&
          k.reason === "refuses-now: a run in phase 'forge-init' claims it",
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 60_000)

  test('the restore is CREATE-ONLY, so a claimant that made its own branch wins', async () => {
    // The repair must never clobber. If the claimant reacts to the missing ref by creating
    // the branch itself — at its own, different sha — that branch is the live one, and
    // putting the old tip back over it would destroy the claimant's starting point.
    const { root, repo } = await makeRepo()
    const branch = 'trident/claimant-remade-it'
    const sha = await seedRef(repo, branch, 'remade')
    let theirSha = ''

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        const result = await spawnCapture(cmd, cwd)
        if (cmd.includes('update-ref') && cmd.includes('-d')) {
          // The next run creates the branch itself, at main's tip, and stands on it.
          theirSha = (await spawnCapture(['git', '-C', repo, 'rev-parse', 'refs/heads/main'], repo)).stdout.trim()
          expect(theirSha).not.toBe(sha)
          await spawnCapture(['git', '-C', repo, 'branch', branch, theirSha], repo)
          await spawnCapture(
            ['git', '-C', repo, 'worktree', 'add', join(repo, '.claude', 'worktrees', 'wf_theirs'), branch],
            repo,
          )
        }
        return result
      },
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([])
    // THEIR ref survives untouched; ours is not forced back over it.
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(theirSha)
    expect(
      report.refs_kept.some(
        (k) =>
          k.ref === `refs/heads/${branch}` && k.reason.includes('the claimant holds its own ref'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    // NEITHER counter claims anything: we did not put a ref back, and nothing failed in a
    // way that left one absent. This is the benign create-only refusal and only that.
    expect(report.refs_restored).toEqual([])
    expect(report.refs_restore_failed).toEqual([])
    // And our tip is still reachable, because the salvage was written before any of this.
    expect(await git(repo, 'rev-parse', `refs/trident-reaped/claimant-remade-it/${sha}`)).toBe(sha)
  }, 60_000)

  test('A RESTORE THAT SIMPLY FAILED is loud and is NOT reported as restored', async () => {
    // THE ROUND-4 BLOCKER, and it is this file's own doctrine broken in the newest code: ANY
    // failure of the create-only restore was read as "the claimant recreated the branch, so
    // ours losing is correct", and `refs_restored` was pushed unconditionally. A lock
    // failure, a permission error or a transient host fault therefore left the ref ABSENT —
    // the claimant's symbolic HEAD dangling, which is the one outcome gate 9b exists to
    // prevent — while the summary said it had been put back.
    //
    // A command that failed establishes that it did not succeed and nothing else. Only an
    // EEXIST refusal proves the ref is there; everything else is loud and unrestored.
    const { root, repo } = await makeRepo()
    const branch = 'trident/restore-cannot-land'
    const sha = await seedRef(repo, branch, 'norestore')
    const claimant = join(repo, '.claude', 'worktrees', 'wf_claimed-then-stuck')
    mkdirSync(dirname(claimant), { recursive: true })
    let deleted = false

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        // A claimant appears during the delete, exactly as in the ownership-race test: the
        // worktree is added BEFORE the ref is unlinked, because `worktree add <path>
        // <branch>` needs the branch to still exist — which is the real ordering anyway.
        if (!deleted && cmd.includes('update-ref') && cmd.includes('-d')) {
          deleted = true
          const added = await spawnCapture(['git', '-C', repo, 'worktree', 'add', claimant, branch], repo)
          expect(added.ok, added.stderr).toBe(true)
          return spawnCapture(cmd, cwd)
        }
        // ...and ONLY the restore that follows fails, for a reason that is not EEXIST.
        if (deleted && cmd.includes('update-ref') && cmd.includes(`refs/heads/${branch}`)) {
          return { ok: false, stdout: '', stderr: 'fatal: cannot lock ref: lock failure', exit_code: 1 }
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(deleted).toBe(true)
    // THE REPORT MUST NOT CLAIM A RESTORE.
    expect(report.refs_restored).toEqual([])
    expect(report.refs_deleted).toEqual([])
    expect(report.refs_restore_failed).toEqual([{ ref: `refs/heads/${branch}`, sha }])
    const record = keptReasonFor(report, `refs/heads/${branch}`)
    expect(record, JSON.stringify(report.refs_kept)).toContain('RESTORE FAILED')
    expect(record).toContain('is ABSENT')
    // The recovery command names the branch and the exact sha, because nothing else will.
    expect(record).toContain(`git branch ${branch} ${sha}`)
    // THE GROUND TRUTH: the ref really is gone, which is why this must be loud.
    expect(await refExists(repo, `refs/heads/${branch}`)).toBe(false)
    // And the tip is still reachable, so the recovery line above actually works.
    expect(await git(repo, 'rev-parse', `refs/trident-reaped/restore-cannot-land/${sha}`)).toBe(sha)
  }, 60_000)

  // ONLY BOTH HALVES TOGETHER MEAN "THE REF IS ALREADY THERE". Real git answers exit 128 AND
  // "reference already exists", so either half alone classifies the real case correctly — which
  // is precisely why each half needs an adversarial shape to be worth having. The claim in the
  // predicate's comment is that a tighter match is the safe direction; these two pin it.
  for (const shape of [
    {
      what: 'exit 128 with some OTHER fatal message',
      why: 'a fatal that is not an existing-ref conflict leaves the ref absent',
      result: { ok: false, stdout: '', stderr: 'fatal: cannot lock ref: permission denied', exit_code: 128 },
    },
    {
      what: "a non-fatal exit that happens to SAY 'reference already exists'",
      why: 'the message alone is not the outcome; a host that exits 1 established nothing',
      result: { ok: false, stdout: 'reference already exists', stderr: '', exit_code: 1 },
    },
  ]) {
    test(`a restore failing with ${shape.what} is LOUD, not benign`, async () => {
      const { root, repo } = await makeRepo()
      const branch = 'trident/restore-shape-probe'
      const sha = await seedRef(repo, branch, 'shapeprobe')
      const claimant = join(repo, '.claude', 'worktrees', 'wf_shape-claimant')
      mkdirSync(dirname(claimant), { recursive: true })
      let deleted = false

      const report = await sweepAndReap({
        store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
        run_host: async (cmd, cwd) => {
          if (!deleted && cmd.includes('update-ref') && cmd.includes('-d')) {
            deleted = true
            await spawnCapture(['git', '-C', repo, 'worktree', 'add', claimant, branch], repo)
            return spawnCapture(cmd, cwd)
          }
          if (deleted && cmd.includes('update-ref') && cmd.includes(`refs/heads/${branch}`)) {
            return shape.result
          }
          return spawnCapture(cmd, cwd)
        },
        proc_root: makeProc(root),
      })

      expect(deleted).toBe(true)
      expect(report.refs_restored, shape.why).toEqual([])
      expect(report.refs_restore_failed, shape.why).toEqual([{ ref: `refs/heads/${branch}`, sha }])
      expect(
        report.refs_kept.some((k) => k.reason.startsWith('RESTORE FAILED')),
        JSON.stringify(report.refs_kept),
      ).toBe(true)
      expect(await refExists(repo, `refs/heads/${branch}`)).toBe(false)
    }, 60_000)
  }

  test('a restore failure breaks the summary log silence', () => {
    // A sweep whose only event was a failed restore must not be indistinguishable from a
    // sweep with nothing to do — same argument as `refs_stood_down`, and the reason this has
    // its own counter rather than being folded into that one: the name has to say what
    // happened, because the operator reading it has a dangling HEAD to fix.
    const source = readFileSync(new URL('./worktree-reaper.ts', import.meta.url), 'utf8')
    const guard = source.slice(source.indexOf('function logSummaryIfActed'))
    const condition = guard.slice(0, guard.indexOf('return'))
    expect(condition).toContain('report.refs_restore_failed.length === 0')
    expect(guard).toContain('refs_restore_failed: report.refs_restore_failed.length')
    // A sweep that found REAPABLE refs is the most interesting sweep there is while the
    // deletion is deferred — it is the dry-run inventory #635 is waiting on — so it must not
    // be silent either.
    expect(condition).toContain('report.refs_candidates.length === 0')
    expect(guard).toContain('refs_candidates: report.refs_candidates.length')
  })

  test('a DETACHED worktree appearing on the tip mid-sweep stops the reap', async () => {
    // A claimant need not check the branch out by name to be standing on it: `merge.ts` and
    // `review-run.ts` both add DETACHED worktrees at a head. The commit-keyed witness in the
    // claim probe is what sees that, and it is the same witness gate 4c uses.
    const { root, repo } = await makeRepo()
    const branch = 'trident/detached-claimant'
    const sha = await seedRef(repo, branch, 'detclaim')

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        const result = await spawnCapture(cmd, cwd)
        if (cmd.includes('update-ref') && cmd.some((a) => a.startsWith(SALVAGE_REF_PREFIX))) {
          await spawnCapture(
            ['git', '-C', repo, 'worktree', 'add', '--detach', join(root, 'scratch-at-tip'), sha],
            repo,
          )
        }
        return result
      },
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some(
        (k) => k.ref === `refs/heads/${branch}` && k.reason.includes('a detached worktree stands on the tip'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 60_000)

  test('a claim probe that cannot READ the holders refuses, it does not assume none', async () => {
    // The probe's own failure is the absence of a measurement, not the measurement that
    // nothing claims the ref. Gate 3's listing is allowed through; the PROBE's is denied.
    const { root, repo } = await makeRepo()
    const branch = 'trident/probe-blinded'
    const sha = await seedRef(repo, branch, 'probeblind')
    let listings = 0

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (cmd.includes('-z') && cmd.includes('list')) {
          listings += 1
          // The FIRST listing is gate 3's; every later one is the claim probe's.
          if (listings > 1) return { ok: false, stdout: '', stderr: 'listing denied', exit_code: 128 }
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(listings).toBeGreaterThan(1)
    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some(
        (k) => k.ref === `refs/heads/${branch}` && k.reason.includes('holders-unreadable:'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 60_000)

  test('a rebase state that goes unreadable mid-sweep refuses, it does not read as clear', async () => {
    // The probe re-asks `readRebaseHead` for every detached entry, and an 'unknown' there is
    // as disqualifying inside the probe as it is in gate 4 — a rebase whose state cannot be
    // read may be standing on this very ref.
    const { root, repo } = await makeRepo()
    const branch = 'trident/probe-rebase-dark'
    const sha = await seedRef(repo, branch, 'probereb')
    await addWorktree(repo, 'rb_darkening')
    let deleting = false

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (cmd.includes('update-ref') && cmd.some((a) => a.startsWith(SALVAGE_REF_PREFIX))) {
          deleting = true
        }
        return spawnCapture(cmd, cwd)
      },
      // Readable while gate 4 asks, unreadable by the time the claim probe does.
      rebase_head: () => (deleting ? { kind: 'unknown' } : { kind: 'none' }),
      proc_root: makeProc(root),
    })

    expect(deleting).toBe(true)
    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some(
        (k) => k.ref === `refs/heads/${branch}` && k.reason.includes('rebase/bisect state unreadable'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 60_000)

  test('a claim probe that cannot READ the owners refuses too', async () => {
    // The store side of the probe has the same contract as the git side: a read that threw
    // established nothing. The ownership snapshot earlier in the sweep succeeded, so this
    // store fails only on the probe's re-read — which is exactly the shape of a database
    // that became unreadable partway through a sweep.
    const { root, repo } = await makeRepo()
    const branch = 'trident/owners-went-dark'
    const sha = await seedRef(repo, branch, 'ownersdark')
    let reads = 0
    const store: WorktreeReaperStore = {
      listRepoPaths: () => [repo],
      listNonTerminal: () => [],
      listBranchOwners: () => {
        reads += 1
        if (reads > 1) throw new Error('the owners table is unreadable')
        return [owner(branch, { phase: 'failed' })]
      },
    }

    const report = await sweepAndReap({
      store,
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    expect(reads).toBeGreaterThan(1)
    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some(
        (k) => k.ref === `refs/heads/${branch}` && k.reason.includes('owners-unreadable:'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 60_000)

  test('REAL GIT: a symref under refs/heads/trident/ does not take refs/heads/main with it', async () => {
    // MEASURED, NOT HYPOTHETICAL. `update-ref -d` FOLLOWS a symref and deletes what it
    // points AT, leaving the symref standing. With `refs/heads/trident/evil` a symref to
    // `refs/heads/main`, every gate here passes on the symref's own name — gate 14 included,
    // since `holder.branch === ref` never matches — so without `--no-deref` the delete
    // removed `refs/heads/main`. Nothing in trident makes a symref under `refs/heads/` and
    // there are none on the repo of record; the flag is here anyway, because "unreachable in
    // this tree" was the wrong answer twice in this change already, and the blast radius of
    // being wrong a third time is the default branch.
    const { root, repo } = await makeRepo()
    const branch = 'trident/evil-symref'
    const mainTip = await git(repo, 'rev-parse', 'refs/heads/main')
    await git(repo, 'symbolic-ref', `refs/heads/${branch}`, 'refs/heads/main')
    // THE PREMISE: it resolves to main's tip, so every sha-keyed gate and the CAS agree.
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(mainTip)

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    // MAIN SURVIVES. That is the whole test.
    expect(await git(repo, 'rev-parse', 'refs/heads/main')).toBe(mainTip)
    expect(await refExists(repo, 'refs/heads/main')).toBe(true)
    // The symref itself is what got reaped, and it is gone rather than left dangling.
    expect(report.refs_deleted.map((e) => e.ref)).toContain(`refs/heads/${branch}`)
    const stillSym = await spawnCapture(
      ['git', '-C', repo, 'symbolic-ref', '-q', `refs/heads/${branch}`],
      repo,
    )
    expect(stillSym.ok).toBe(false)
  }, 60_000)

  test('the restore is RETRIED, a bounded number of times, create-only every time', async () => {
    // A transient ref-lock contention must not be the difference between a repaired ref and
    // a claimant committing onto no history at all. The bound is pinned by VALUE below, not
    // merely by "more than once": a relation that tracks behaviour against a constant is
    // blind to the constant moving.
    const { root, repo } = await makeRepo()
    const branch = 'trident/restore-flaky'
    const sha = await seedRef(repo, branch, 'flaky')
    const claimant = join(repo, '.claude', 'worktrees', 'wf_flaky-claimant')
    mkdirSync(dirname(claimant), { recursive: true })
    let deleted = false
    let restoreCalls = 0
    const createOnly: string[][] = []

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (!deleted && /update-ref (--no-deref )?-d/.test(cmd.join(' '))) {
          deleted = true
          await spawnCapture(['git', '-C', repo, 'worktree', 'add', claimant, branch], repo)
          return spawnCapture(cmd, cwd)
        }
        if (deleted && cmd.includes('update-ref') && cmd.includes(`refs/heads/${branch}`)) {
          restoreCalls += 1
          createOnly.push([...cmd])
          // Fail once with a lock error, then let the real command through.
          if (restoreCalls === 1) {
            return { ok: false, stdout: '', stderr: 'fatal: cannot lock ref: lock failure', exit_code: 1 }
          }
          return spawnCapture(cmd, cwd)
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(restoreCalls).toBe(2)
    // THE REF IS BACK, which a single-shot restore would not have managed.
    expect(report.refs_restored).toEqual([{ ref: `refs/heads/${branch}`, sha }])
    expect(report.refs_restore_failed).toEqual([])
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
    // EVERY attempt kept the create-only empty old-value. A retry that degraded to a
    // force-create would clobber a claimant that made its own branch between attempts.
    expect(createOnly.length).toBe(2)
    for (const attempt of createOnly) expect(attempt[attempt.length - 1]).toBe('')
  }, 60_000)

  test('the restore pins LC_ALL=C, because its outcome is read off a git MESSAGE', async () => {
    // `refAlreadyExists` is the only branch in this module that turns on a git message, and
    // `spawnCapture` merges `process.env` — so a localised environment would translate the
    // string it matches. No translations exist on this host, which is exactly why this is
    // asserted on the ARGUMENT rather than on behaviour: an outcome test cannot see a hidden
    // input that happens to be benign today.
    const { root, repo } = await makeRepo()
    const branch = 'trident/locale-pinned'
    const sha = await seedRef(repo, branch, 'locale')
    const claimant = join(repo, '.claude', 'worktrees', 'wf_locale-claimant')
    mkdirSync(dirname(claimant), { recursive: true })
    let deleted = false
    const restoreEnvs: (Record<string, string> | undefined)[] = []

    await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd, extraEnv) => {
        if (!deleted && /update-ref (--no-deref )?-d/.test(cmd.join(' '))) {
          deleted = true
          await spawnCapture(['git', '-C', repo, 'worktree', 'add', claimant, branch], repo)
          return spawnCapture(cmd, cwd)
        }
        if (deleted && cmd.includes('update-ref') && cmd.includes(`refs/heads/${branch}`)) {
          restoreEnvs.push(extraEnv)
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(restoreEnvs.length).toBeGreaterThan(0)
    for (const env of restoreEnvs) expect(env?.LC_ALL).toBe('C')
  }, 60_000)

  test('the retry bound is a fixed small number, and its VALUE is pinned', async () => {
    // Both halves: the constant is what it is, and the code actually stops there rather than
    // retrying forever. A test asserting only "it retried" cannot see this number change.
    expect(MAX_RESTORE_ATTEMPTS).toBe(3)
    const { root, repo } = await makeRepo()
    const branch = 'trident/restore-never-lands'
    const sha = await seedRef(repo, branch, 'neverlands')
    const claimant = join(repo, '.claude', 'worktrees', 'wf_never-claimant')
    mkdirSync(dirname(claimant), { recursive: true })
    let deleted = false
    let restoreCalls = 0

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (!deleted && /update-ref (--no-deref )?-d/.test(cmd.join(' '))) {
          deleted = true
          await spawnCapture(['git', '-C', repo, 'worktree', 'add', claimant, branch], repo)
          return spawnCapture(cmd, cwd)
        }
        if (deleted && cmd.includes('update-ref') && cmd.includes(`refs/heads/${branch}`)) {
          restoreCalls += 1
          return { ok: false, stdout: '', stderr: 'fatal: cannot lock ref: lock failure', exit_code: 1 }
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(restoreCalls).toBe(MAX_RESTORE_ATTEMPTS)
    expect(report.refs_restore_failed).toEqual([{ ref: `refs/heads/${branch}`, sha }])
    expect(report.refs_restored).toEqual([])
  }, 60_000)

  test('a DELETE THAT TIMED OUT is indeterminate, so the repair still runs', async () => {
    // `spawnCapture` kills the child on its watchdog and reports ok:false WITH
    // timed_out:true. A kill that lands after the ref lock committed leaves the ref gone
    // while the result says it failed — read as a refusal, that skipped the repair entirely
    // and reported the ref as kept, with a claimant standing on it.
    const { root, repo } = await makeRepo()
    const branch = 'trident/delete-timed-out'
    const sha = await seedRef(repo, branch, 'timedout')
    const claimant = join(repo, '.claude', 'worktrees', 'wf_timeout-claimant')
    mkdirSync(dirname(claimant), { recursive: true })
    let deleted = false

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (!deleted && /update-ref (--no-deref )?-d/.test(cmd.join(' '))) {
          deleted = true
          await spawnCapture(['git', '-C', repo, 'worktree', 'add', claimant, branch], repo)
          // The ref lock COMMITS, and only then does the watchdog kill report.
          const real = await spawnCapture(cmd, cwd)
          expect(real.ok).toBe(true)
          return { ok: false, stdout: '', stderr: 'killed by watchdog', exit_code: 143, timed_out: true }
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(deleted).toBe(true)
    // NOT reported as a plain refusal, and the repair DID run: the ref is back.
    expect(report.refs_kept.some((k) => k.reason.startsWith('delete-refused:'))).toBe(false)
    expect(report.refs_restored).toEqual([{ ref: `refs/heads/${branch}`, sha }])
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
    expect(await git(claimant, 'rev-parse', 'HEAD')).toBe(sha)
  }, 60_000)

  test('A TIMEOUT BEFORE THE LOCK COMMITTED is not recorded as a deletion', async () => {
    // THE HALF THE FIRST TIMEOUT TEST MISSED, and the one that produced a false report.
    // Making a timeout indeterminate rather than a refusal was right; what was wrong was
    // what happened next — the indeterminate path fell through and appended to
    // `refs_deleted` because the claim probe found no claimant. "Nobody is standing on this
    // ref" is a different question from "does this ref still exist". `deleted.ok` was false
    // and the report said the ref was reaped.
    //
    // Here the watchdog kill lands BEFORE the ref lock commits: the delete never runs, the
    // ref is untouched, and there is no claimant either — so nothing but measuring the ref
    // can tell the two timeout orderings apart.
    const { root, repo } = await makeRepo()
    const branch = 'trident/timeout-before-commit'
    const sha = await seedRef(repo, branch, 'beforecommit')
    let attempted = false

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (!attempted && /update-ref (--no-deref )?-d/.test(cmd.join(' '))) {
          attempted = true
          // The command is NEVER run: killed before it took the lock.
          return { ok: false, stdout: '', stderr: 'killed by watchdog', exit_code: 143, timed_out: true }
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(attempted).toBe(true)
    // THE REPORT MUST NOT CLAIM A DELETION, and the ref must still be there.
    expect(report.refs_deleted).toEqual([])
    expect(report.refs_restored).toEqual([])
    expect(
      report.refs_kept.some(
        (k) => k.ref === `refs/heads/${branch}` && k.reason.startsWith('delete-timed-out:'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 60_000)

  // THE PRESENCE READ IS KEYED ON THE EXIT CODE, NOT ON `ok`, and all four classes are
  // exercised against the same code path. Measured on git 2.43: a ref that resolves exits 0,
  // one that does not exits 1, a hard failure exits 128 — so exit 1 is the ONLY value that
  // means absent, and `!ok` folds 1 and 128 together. The 128 case is the one that recorded a
  // DELETION with no evidence the ref was gone.
  //
  // The pairing matters as much as the refusals: without the exit-1 and the
  // ordinary-success cases below, a guard that stood down on EVERYTHING would satisfy the
  // 128 case on its own.
  for (const shape of [
    {
      what: 'exit 1 (absent) → the reap is real and IS recorded',
      result: { ok: false, stdout: '', stderr: '', exit_code: 1 },
      expect: 'deleted' as const,
    },
    {
      what: 'exit 0 (present) → nothing was deleted, reported as kept',
      result: { ok: true, stdout: 'TIP\n', stderr: '', exit_code: 0 },
      expect: 'present' as const,
    },
    {
      what: 'exit 128 (hard error) → indeterminate, never a deletion',
      result: { ok: false, stdout: '', stderr: 'fatal: permission denied', exit_code: 128 },
      expect: 'unknown' as const,
    },
  ]) {
    test(`after an indeterminate delete, ${shape.what}`, async () => {
      const { root, repo } = await makeRepo()
      const branch = 'trident/presence-by-exit-code'
      const sha = await seedRef(repo, branch, 'presence')
      let attempted = false

      const report = await sweepAndReap({
        store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
        run_host: async (cmd, cwd) => {
          if (!attempted && /update-ref (--no-deref )?-d/.test(cmd.join(' '))) {
            attempted = true
            // Really delete it, so the ref's actual state cannot be what the assertions
            // below are reading — only the stubbed presence answer can be.
            await spawnCapture(cmd, cwd)
            return { ok: false, stdout: '', stderr: 'killed by watchdog', exit_code: 143, timed_out: true }
          }
          if (attempted && cmd.includes('rev-parse') && cmd.includes(ref(branch))) {
            return { ...shape.result, stdout: shape.result.stdout.replace('TIP', sha) }
          }
          return spawnCapture(cmd, cwd)
        },
        proc_root: makeProc(root),
      })

      expect(attempted).toBe(true)
      if (shape.expect === 'deleted') {
        expect(report.refs_deleted.map((e) => e.ref)).toContain(ref(branch))
        expect(report.refs_stood_down).toBe(0)
      } else {
        expect(report.refs_deleted, JSON.stringify(report.refs_kept)).toEqual([])
        const kept = keptReasonFor(report, ref(branch))
        expect(kept, JSON.stringify(report.refs_kept)).toStartWith(
          shape.expect === 'present' ? 'delete-timed-out:' : 'delete-indeterminate:',
        )
        // Only the UNKNOWN class is a stand-down; a present ref is an ordinary refusal.
        expect(report.refs_stood_down).toBe(shape.expect === 'unknown' ? 1 : 0)
      }
    }, 60_000)
  }

  test('an ORDINARY successful delete is still recorded, with no presence read at all', async () => {
    // The other half of the pairing: the exit-code classification must not have turned the
    // normal path into a stand-down. A delete that reports success is not re-read — there is
    // nothing indeterminate about it.
    const { root, repo } = await makeRepo()
    const branch = 'trident/ordinary-delete'
    const sha = await seedRef(repo, branch, 'ordinary')
    let presenceReads = 0

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (cmd.includes('rev-parse') && cmd.includes(ref(branch))) presenceReads += 1
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([{ ref: ref(branch), sha, salvage: `refs/trident-reaped/ordinary-delete/${sha}` }])
    expect(report.refs_stood_down).toBe(0)
    expect(presenceReads).toBe(0)
    expect(await refExists(repo, ref(branch))).toBe(false)
  }, 60_000)

  test('A DELETE THAT SUCCEEDED AND THEN THREW is repaired, not reported as refused', async () => {
    // INSTANCE FOUR of the same mistake, by a route the `.ok` audit did not cover: a thrown
    // exception is not an `.ok` decision, and a throw AFTER the command had its chance is
    // *unknown*, not *false*. The runner performs the delete and then throws — a broken pipe,
    // a harness fault, a kill surfaced as an exception rather than as `timed_out` — and the
    // catch used to record `delete-refused` and `continue`, so gate 14 and the restore were
    // never reached: the ref stayed deleted and the claimant's HEAD dangled while the report
    // said the ref was kept.
    const { root, repo } = await makeRepo()
    const branch = 'trident/delete-threw-after-doing-it'
    const sha = await seedRef(repo, branch, 'threwafter')
    const claimant = join(repo, '.claude', 'worktrees', 'wf_threw-claimant')
    mkdirSync(dirname(claimant), { recursive: true })
    let threw = false

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (!threw && /update-ref (--no-deref )?-d/.test(cmd.join(' '))) {
          threw = true
          await spawnCapture(['git', '-C', repo, 'worktree', 'add', claimant, branch], repo)
          // THE DELETE REALLY HAPPENS...
          const real = await spawnCapture(cmd, cwd)
          expect(real.ok, real.stderr).toBe(true)
          // ...and only then does the call blow up.
          throw new Error('the host died after the ref lock committed')
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(threw).toBe(true)
    // NOT a refusal: the repair ran, so the ref is back and the claimant is whole.
    expect(report.refs_kept.some((k) => k.reason.startsWith('delete-refused:'))).toBe(false)
    expect(report.refs_restored).toEqual([{ ref: ref(branch), sha }])
    expect(await git(repo, 'rev-parse', ref(branch))).toBe(sha)
    expect(await git(claimant, 'rev-parse', 'HEAD')).toBe(sha)
    expect(await git(claimant, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch)
  }, 60_000)

  test('a delete that threw WITHOUT doing it is still measured, not assumed', async () => {
    // The other side of the same throw: nothing happened, no claimant. The outcome must come
    // from reading the ref, not from the exception — and the ref is still there, so this is a
    // kept ref and not a deletion.
    const { root, repo } = await makeRepo()
    const branch = 'trident/delete-threw-before-doing-it'
    const sha = await seedRef(repo, branch, 'threwbefore')
    let threw = false

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (!threw && /update-ref (--no-deref )?-d/.test(cmd.join(' '))) {
          threw = true
          throw new Error('the host died before the ref lock committed')
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(threw).toBe(true)
    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some(
        (k) => k.ref === ref(branch) && k.reason.startsWith('delete-timed-out:'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', ref(branch))).toBe(sha)
  }, 60_000)

  test('a timeout whose ref cannot be RE-READ is unknown, and unknown is not a deletion', async () => {
    // The third answer. A rev-parse that will not answer leaves the outcome unmeasured, and
    // an unmeasured outcome is not a deletion — it is a stand-down, so it is also logged.
    const { root, repo } = await makeRepo()
    const branch = 'trident/timeout-unreadable'
    const sha = await seedRef(repo, branch, 'unreadable')
    let attempted = false

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (!attempted && /update-ref (--no-deref )?-d/.test(cmd.join(' '))) {
          attempted = true
          return { ok: false, stdout: '', stderr: 'killed by watchdog', exit_code: 143, timed_out: true }
        }
        if (attempted && cmd.includes('rev-parse') && cmd.includes(`refs/heads/${branch}`)) {
          throw new Error('the ref database is unreadable')
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_stood_down).toBeGreaterThan(0)
    expect(
      report.refs_kept.some(
        (k) => k.ref === `refs/heads/${branch}` && k.reason.startsWith('delete-indeterminate:'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
  }, 60_000)

  // A COMMAND THAT SUCCEEDED WHOSE OUTPUT CANNOT BE WHAT IT SAYS — the third route into the
  // same mistake, and the least visible: `ok` is true, nothing threw, there is no error string.
  // `git worktree list` ALWAYS reports the main working tree, so a listing that parses to zero
  // records is not an empty repository — it is an answer that did not arrive. Reading "no
  // claimants" out of it is what permits a delete.
  //
  // THE SHAPES ARE MEASURED, not assumed: `parseHoldersZ` yields zero records from an empty
  // string, from bare NULs, from records carrying no `worktree` field, and from arbitrary
  // non-porcelain text. A `stdout === ''` check would have caught one of the four, which is why
  // the guard is on the parse result.
  for (const shape of [
    { what: 'empty stdout', stdout: '' },
    { what: 'bare NULs', stdout: '\0\0\0' },
    { what: 'records with no worktree field', stdout: 'HEAD abc\0branch refs/heads/x\0\0' },
    { what: 'non-porcelain text', stdout: 'fatal: not a git repository\n' },
  ]) {
    test(`a holder listing of ${shape.what} refuses BEFORE the delete`, async () => {
      // The pre-delete probe. The gate named both probes, so both are pinned.
      const { root, repo } = await makeRepo()
      const branch = 'trident/impossible-listing-pre'
      const sha = await seedRef(repo, branch, 'imposspre')
      let listings = 0
      let deleteAttempted = false

      const report = await sweepAndReap({
        store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
        run_host: async (cmd, cwd) => {
          if (/update-ref (--no-deref )?-d/.test(cmd.join(' '))) deleteAttempted = true
          if (cmd.includes('-z') && cmd.includes('list')) {
            listings += 1
            // The FIRST listing is the holder map's; later ones are the probe's. Let the map
            // through so the refusal below is unambiguously the PROBE's.
            if (listings > 1) return { ok: true, stdout: shape.stdout, stderr: '', exit_code: 0 }
          }
          return spawnCapture(cmd, cwd)
        },
        proc_root: makeProc(root),
      })

      expect(listings).toBeGreaterThan(1)
      expect(deleteAttempted, 'a delete must never be attempted on an unreadable listing').toBe(false)
      expect(report.refs_deleted).toEqual([])
      expect(
        report.refs_kept.some((k) => k.reason.includes('holders-unreadable')),
        JSON.stringify(report.refs_kept),
      ).toBe(true)
      expect(await git(repo, 'rev-parse', ref(branch))).toBe(sha)
    }, 60_000)
  }

  test('an impossible HOLDER MAP listing stands the whole repo down', async () => {
    // The other listing. The holder map is built once per repo and feeds gates 4 and 5, so an
    // impossible payload there means nothing is known about who holds what — and unlike the
    // probe's, this refusal covers EVERY ref in the repository rather than one.
    const { root, repo } = await makeRepo()
    const a = await seedRef(repo, 'trident/map-dark-a', 'mapdarka')
    const b = await seedRef(repo, 'trident/map-dark-b', 'mapdarkb')
    let listings = 0

    const report = await sweepAndReap({
      store: stubStore(repo, [], [
        owner('trident/map-dark-a', { phase: 'failed' }),
        owner('trident/map-dark-b', { phase: 'done' }),
      ]),
      run_host: async (cmd, cwd) => {
        if (cmd.includes('-z') && cmd.includes('list')) {
          listings += 1
          // The FIRST `-z` listing is the holder map's — succeed, but say something impossible.
          if (listings === 1) return { ok: true, stdout: '', stderr: '', exit_code: 0 }
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(listings).toBeGreaterThan(0)
    expect(report.refs_deleted).toEqual([])
    expect(report.refs_candidates).toEqual([])
    expect(report.refs_stood_down).toBe(1)
    expect(
      report.refs_kept.some((k) => k.reason.includes('holders-unenumerable')),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    // BOTH refs survive, which is what "the whole repo" means.
    expect(await git(repo, 'rev-parse', 'refs/heads/trident/map-dark-a')).toBe(a)
    expect(await git(repo, 'rev-parse', 'refs/heads/trident/map-dark-b')).toBe(b)
  }, 60_000)

  test('a holder listing that becomes impossible AFTER the delete refuses, and repairs', async () => {
    // The post-delete probe. The ref really is gone by the time the listing goes bad, so the
    // only safe reading of an unreadable listing is "something claims it" — which routes to the
    // repair and puts the ref back.
    const { root, repo } = await makeRepo()
    const branch = 'trident/impossible-listing-post'
    const sha = await seedRef(repo, branch, 'imposspost')
    let deleted = false

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (!deleted && /update-ref (--no-deref )?-d/.test(cmd.join(' '))) {
          deleted = true
          return spawnCapture(cmd, cwd)
        }
        // Only the listings AFTER the delete go bad.
        if (deleted && cmd.includes('-z') && cmd.includes('list')) {
          return { ok: true, stdout: '', stderr: '', exit_code: 0 }
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(deleted).toBe(true)
    expect(report.refs_deleted).toEqual([])
    expect(report.refs_restored).toEqual([{ ref: ref(branch), sha }])
    // THE REF IS BACK, because an unreadable listing answers "claimed" rather than "clear".
    expect(await git(repo, 'rev-parse', ref(branch))).toBe(sha)
  }, 60_000)

  test('THE COMPLEMENT: a well-formed listing with a claimant still restores', async () => {
    // Without this and the next, a probe that refused on EVERY listing would pass the four
    // above. This is the real-claimant path, unchanged.
    const { root, repo } = await makeRepo()
    const branch = 'trident/wellformed-with-claimant'
    const sha = await seedRef(repo, branch, 'wfclaim')
    const claimant = join(repo, '.claude', 'worktrees', 'wf_wellformed-claimant')
    mkdirSync(dirname(claimant), { recursive: true })
    let deleted = false

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (!deleted && /update-ref (--no-deref )?-d/.test(cmd.join(' '))) {
          deleted = true
          await spawnCapture(['git', '-C', repo, 'worktree', 'add', claimant, branch], repo)
          return spawnCapture(cmd, cwd)
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    expect(report.refs_restored).toEqual([{ ref: ref(branch), sha }])
    expect(await git(repo, 'rev-parse', ref(branch))).toBe(sha)
    expect(await git(claimant, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch)
  }, 60_000)

  test('THE COMPLEMENT: a well-formed listing with NO claimant still permits the reap', async () => {
    // The other half. A guard that refuses everything satisfies all five refusals above on its
    // own; this is what stops that.
    const { root, repo } = await makeRepo()
    const branch = 'trident/wellformed-no-claimant'
    const sha = await seedRef(repo, branch, 'wfnoclaim')

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([
      { ref: ref(branch), sha, salvage: `refs/trident-reaped/wellformed-no-claimant/${sha}` },
    ])
    expect(report.refs_restored).toEqual([])
    expect(await refExists(repo, ref(branch))).toBe(false)
  }, 60_000)

  test('a salvage that cannot be written blocks the delete', async () => {
    // Only the salvage WRITE is broken, not the delete: a stub that broke both would let
    // the ref survive for the wrong reason and prove nothing about the ordering.
    const { root, repo } = await makeRepo()
    const branch = 'trident/no-salvage'
    const sha = await seedRef(repo, branch, 'nosalv')
    let deleteAttempted = false

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const report = await sweepAndReap({
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

    const waiting = await sweepAndReap({
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
    const after = await sweepAndReap({
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

    const report = await sweepAndReap({
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

describe('branch-ref reap — the deletion is DEFERRED to #635 (#547)', () => {
  // `#606` ships every gate, the measurement and the reporting; it performs no deletions.
  // Nothing deletes these refs today, so shipping the write would introduce a destructive
  // operation ahead of the only check that can settle its failure mode without a race — and
  // that check is on the claimant's side (`#635`), where a build's commit is the agent running
  // `git commit`, so it is not buildable in this lane at all.
  test('a SWEEP issues NO delete and NO salvage write — zero writes, both pinned', async () => {
    // BOTH absences are asserted. Pinning only the delete would leave "zero writes" unpinned,
    // and the salvage half is a real claim: not seeding `refs/trident-reaped/` for deletions
    // that are not happening is why the deferral is an improvement and not just a smaller change.
    const { root, repo } = await makeRepo()
    const branch = 'trident/deferred-not-reaped'
    const sha = await seedRef(repo, branch, 'deferred')
    const writes: string[][] = []

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        if (cmd.includes('update-ref')) writes.push([...cmd])
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    })

    // NOT A WRITE OF ANY KIND.
    expect(writes, `unexpected writes: ${JSON.stringify(writes)}`).toEqual([])
    expect(report.refs_deleted).toEqual([])
    expect(report.refs_restored).toEqual([])
    expect(report.refs_restore_failed).toEqual([])
    // The ref and the salvage namespace are both untouched.
    expect(await git(repo, 'rev-parse', ref(branch))).toBe(sha)
    expect(await git(repo, 'for-each-ref', '--format=%(refname)', SALVAGE_REF_PREFIX)).toBe('')

    // AND THE DRY-RUN INVENTORY IS THE POINT: it says exactly what #635 will unlock.
    expect(report.refs_candidates).toEqual([{ repo, ref: ref(branch), sha }])
    expect(
      report.refs_kept.some(
        (k) => k.ref === ref(branch) && k.reason === DEFERRED_PENDING_CLAIMANT_GUARD,
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
  }, 60_000)

  test('A CANDIDATE IS AN UPPER BOUND: gate 11 can still refuse one, and the report says so', async () => {
    // THE SEMANTICS, MADE PROVABLE. `refs_candidates` means "passed gates 1-10", not "would be
    // deleted" — gates 11-14 run only at deletion time, and gate 11 IS the salvage write, so a
    // dry sweep cannot evaluate it without ceasing to be dry.
    //
    // The earlier name (`refs_reapable`) promised the stronger thing, and the count taken from
    // it was quoted upward as "what exactly would this delete". It was an upper bound on that.
    // This test is what makes the weaker, true claim checkable: the ref IS a candidate, it is
    // NOT deleted, and the report carries both facts separately rather than collapsing them.
    const { root, repo } = await makeRepo()
    const branch = 'trident/candidate-refused-at-salvage'
    const sha = await seedRef(repo, branch, 'candrefused')
    const opts = {
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: async (cmd: string[], cwd?: string) => {
        // Only the salvage WRITE is rejected — gate 11, the first gate a dry run cannot reach.
        if (cmd.includes('update-ref') && cmd.some((a) => a.startsWith(SALVAGE_REF_PREFIX))) {
          return { ok: false, stdout: '', stderr: 'the host refuses to write', exit_code: 1 }
        }
        return spawnCapture(cmd, cwd)
      },
      proc_root: makeProc(root),
    }

    // THE DRY SWEEP lists it as a candidate, because gates 1-10 all pass.
    const report = await sweepTridentWorktrees(opts)
    expect(report.refs_candidates).toEqual([{ repo, ref: ref(branch), sha }])
    expect(report.refs_deleted).toEqual([])

    // AND DELETION TIME REFUSES IT, on the gate the dry run could not evaluate. The candidate
    // the sweep minted is handed straight back — the only value the boundary accepts.
    await deleteReapableRef(opts, repo, onlyCandidate(report), report, { attempts: 0 })

    // BOTH FACTS SURVIVE IN THE REPORT, separately: still a candidate, still not deleted.
    expect(report.refs_candidates).toEqual([{ repo, ref: ref(branch), sha }])
    expect(report.refs_deleted).toEqual([])
    expect(
      report.refs_kept.some(
        (k) => k.ref === ref(branch) && k.reason.startsWith('salvage-unverified:'),
      ),
      JSON.stringify(report.refs_kept),
    ).toBe(true)
    expect(await git(repo, 'rev-parse', ref(branch))).toBe(sha)
    // So a candidate count is an UPPER BOUND on a deletion count, and here they differ by one.
    expect(report.refs_candidates.length).toBeGreaterThan(report.refs_deleted.length)
  }, 60_000)

  test('the REASON AN OPERATOR READS says candidate, not reapable', async () => {
    // THE ASSERTION THAT WAS MISSING (#547 round 18). The rename tests below inspect the field
    // NAME and the source text; none of them ever read the emitted VALUE. That is exactly how a
    // user-visible string drifts while the suite stays green: the field was renamed
    // `refs_reapable` -> `refs_candidates` and every document was corrected, while the reason
    // handed to an operator still opened "every gate passed and this ref IS reapable".
    //
    // So this reads the string out of a REAL sweep's report, not out of the constant, and pins
    // both directions: the claim it must make, and the claims it must not.
    const { root, repo } = await makeRepo()
    const branch = 'trident/operator-facing-reason'
    await seedRef(repo, branch, 'operatorreason')

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    const emitted = report.refs_kept.filter((k) => k.ref === ref(branch)).map((k) => k.reason)
    expect(emitted).toHaveLength(1)
    const reason = emitted[0] ?? ''
    // It came from the sweep, not from the test importing a constant.
    expect(reason).toBe(DEFERRED_PENDING_CLAIMANT_GUARD)

    // WHAT IT MUST SAY: candidate, the gate range, and that the range is an upper bound.
    expect(reason).toContain('CANDIDATE')
    expect(reason).toContain('gates 1-10')
    expect(reason).toContain('upper bound')
    expect(reason).toContain('#635')

    // WHAT IT MUST NOT SAY. Each of these is a claim the sweep has not established, and the
    // first two are the exact words that shipped.
    for (const overclaim of [
      'IS reapable',
      'every gate passed',
      'all gates passed',
      'all fourteen',
      'will be deleted',
      'would be deleted',
    ]) {
      expect(reason.toLowerCase(), overclaim).not.toContain(overclaim.toLowerCase())
    }
  }, 60_000)

  test('NO emitted reason in the module claims a ref is reapable or will be deleted', () => {
    // The generalisation, because fixing one string is not a guard. Every `reason:` literal in
    // the module is scanned for the overclaiming phrases — a new refusal reason that says "will
    // be deleted" reds here even though no existing test mentions it.
    const source = readFileSync(new URL('./worktree-reaper.ts', import.meta.url), 'utf8')
    // The emitted strings only: reason literals plus the deferral constant's own text. Comments
    // are deliberately out of scope — two of them quote the retired wording to explain it.
    const reasonLines = source
      .split('\n')
      .filter((line) => /reason:|^  '(deferred|deferred-pending)/.test(line) || /^\s+'[a-z-]+: /.test(line))
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    expect(reasonLines.length).toBeGreaterThan(20)
    for (const line of reasonLines) {
      for (const overclaim of ['IS reapable', 'every gate passed', 'all gates passed']) {
        expect(line, line.trim()).not.toContain(overclaim)
      }
    }
    // POSITIVE CONTROL on the scan: the phrase is detectable by this method when present.
    expect(["  reason: 'x IS reapable'"].some((l) => l.includes('IS reapable'))).toBe(true)
  })

  test('the field and the log line both say CANDIDATE, not reapable', () => {
    // The rename is the fix, so it is pinned. A field called `refs_reapable` promised that
    // gates 11-14 had been evaluated; nothing in a dry sweep can evaluate them, and the name
    // is what made the overclaim easy to quote onward.
    const source = readFileSync(new URL('./worktree-reaper.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('refs_reapable')
    expect(source).toContain('refs_candidates')
    // And the field documents the gap rather than leaving the reader to find it.
    const declaration = 'refs_candidates: ReapableCandidate[]'
    // POSITIVE CONTROL: an `indexOf` that missed would slice to -1 and hand the assertions
    // below the whole file, which contains both strings and would pass for the wrong reason.
    expect(source).toContain(declaration)
    const doc = source.slice(0, source.indexOf(declaration))
    expect(doc).toContain('GATES 11-14 ARE NOT IN THIS COUNT AND CANNOT BE')
    expect(doc).toContain('UPPER BOUND')
  })

  test('THE COMPLEMENT: called directly, the destructive half still does the whole sequence', async () => {
    // Without this the deferral test above would be satisfied by a reaper that can no longer
    // delete anything at all. `deleteReapableRef` is what `#635` re-enables, so it has to be
    // demonstrably intact — salvage written, ref gone, inventory honoured.
    const { root, repo } = await makeRepo()
    const branch = 'trident/deferred-but-intact'
    const sha = await seedRef(repo, branch, 'intact')
    const opts = {
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    }

    const report = await sweepTridentWorktrees(opts)
    expect(report.refs_candidates).toEqual([{ repo, ref: ref(branch), sha }])
    expect(await refExists(repo, ref(branch))).toBe(true)

    await deleteReapableRef(opts, repo, onlyCandidate(report), report, { attempts: 0 })

    expect(report.refs_deleted).toEqual([
      { ref: ref(branch), sha, salvage: `refs/trident-reaped/deferred-but-intact/${sha}` },
    ])
    expect(await refExists(repo, ref(branch))).toBe(false)
    expect(await git(repo, 'rev-parse', `refs/trident-reaped/deferred-but-intact/${sha}`)).toBe(sha)
  }, 60_000)

  test('the sweep has exactly ONE non-call of the destructive half, and it names #635', () => {
    // One place to find when asking "why is nothing being reaped". The sweep must not reference
    // `deleteReapableRef` at all — a commented-out call or a guarded one is two answers.
    const source = readFileSync(new URL('./worktree-reaper.ts', import.meta.url), 'utf8')
    // Asserted on the CALL, not on the name. The deferral comment inside the sweep names
    // `deleteReapableRef` deliberately — that is how a reader finds the other half — so a
    // mention-based assertion would be testing the prose instead of the behaviour.
    const sweep = source.slice(
      source.indexOf('async function reapBranchRefs('),
      source.indexOf(' * THE DESTRUCTIVE HALF, extracted'),
    )
    expect(sweep).not.toMatch(/(await |void )deleteReapableRef\s*\(/)
    expect(sweep.match(/DEFERRED_PENDING_CLAIMANT_GUARD/g) ?? []).toHaveLength(1)
    // And the whole module calls it from nowhere: production reaches it only once #635 lands.
    expect(source).not.toMatch(/(await |void )deleteReapableRef\s*\(/)
    // POSITIVE CONTROL on the regex, so "no call found" cannot mean "pattern never matches".
    expect('  await deleteReapableRef(opts, repo,').toMatch(/(await |void )deleteReapableRef\s*\(/)
    expect(DEFERRED_PENDING_CLAIMANT_GUARD).toContain('#635')
  })
})

describe('branch-ref reap — a stand-down is never silent (#547)', () => {
  // `logSummaryIfActed` returns early unless something was ACTED on, so a ref sweep that
  // refused every ref logged nothing at all — indistinguishable from a repo with nothing
  // to reap. That is exactly the state a boot-rescue latch that never lifts, or one
  // unreadable rebase state file, produces: the whole ref half goes quiet forever. Ordinary
  // per-ref refusals stay quiet on purpose (`owner-unknown` is the steady state), so the
  // distinction is carried by `refs_stood_down` rather than by `refs_kept`.
  test('the latch still shut counts as a stand-down', async () => {
    const { root, repo } = await makeRepo()
    await seedRef(repo, 'trident/latched', 'latched')

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner('trident/latched', { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      refs_ready: () => false,
    })

    expect(report.refs_stood_down).toBe(1)
  }, 30_000)

  test('an unreadable rebase state counts as a stand-down', async () => {
    const { root, repo } = await makeRepo()
    await seedRef(repo, 'trident/opaque-state', 'opaquestate')
    await addWorktree(repo, 'rb_opaque')

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner('trident/opaque-state', { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      rebase_head: () => ({ kind: 'unknown' }),
    })

    expect(report.refs_stood_down).toBe(1)
    expect(report.refs_deleted).toEqual([])
  }, 30_000)

  test('an enumeration that will not answer counts as a stand-down', async () => {
    const { root, repo } = await makeRepo()
    await seedRef(repo, 'trident/dark-refs', 'darkrefs')

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner('trident/dark-refs', { phase: 'failed' })]),
      run_host: async (cmd, cwd) => {
        const result = await spawnCapture(cmd, cwd)
        if (cmd.includes('for-each-ref')) return { ...result, ok: false, exit_code: 128 }
        return result
      },
      proc_root: makeProc(root),
    })

    expect(report.refs_stood_down).toBe(1)
  }, 30_000)

  for (const shape of [
    { what: 'a `worktree list` that THREW', stub: 'throw' as const },
    { what: 'a `worktree list` that exited non-zero', stub: 'fail' as const },
    { what: 'a `worktree list` that named NO worktrees at all', stub: 'empty' as const },
  ]) {
    test(`${shape.what} is a counted stand-down, not silence`, async () => {
      // These three `continue`s predate the ref reap and are right for the WORKTREE half.
      // What was wrong was the silence: they also skip the REF half, so a repo that would
      // not answer was indistinguishable from one with nothing to reap — the exact mode the
      // header and the record claim is fixed. A claim is worth no more than its counter.
      const { root, repo } = await makeRepo()
      const sha = await seedRef(repo, 'trident/repo-went-dark', 'repodark')

      const report = await sweepAndReap({
        store: stubStore(repo, [], [owner('trident/repo-went-dark', { phase: 'failed' })]),
        run_host: async (cmd, cwd) => {
          const isPlainList =
            cmd.includes('worktree') && cmd.includes('list') && !cmd.includes('-z')
          if (isPlainList) {
            if (shape.stub === 'throw') throw new Error('the worktree list is unreadable')
            if (shape.stub === 'fail') {
              return { ok: false, stdout: '', stderr: 'listing denied', exit_code: 128 }
            }
            return { ok: true, stdout: '', stderr: '', exit_code: 0 }
          }
          return spawnCapture(cmd, cwd)
        },
        proc_root: makeProc(root),
      })

      expect(report.refs_stood_down).toBe(1)
      expect(report.refs_deleted).toEqual([])
      expect(
        report.refs_kept.some((k) => k.reason.startsWith('repo-unenumerable:')),
        JSON.stringify(report.refs_kept),
      ).toBe(true)
      expect(await git(repo, 'rev-parse', 'refs/heads/trident/repo-went-dark')).toBe(sha)
    }, 30_000)
  }

  test('ORDINARY per-ref refusals are NOT stand-downs, so they stay quiet', async () => {
    // The other half of the contract: an unowned ref is refused every fifteen minutes for
    // the life of the process, and must not log every fifteen minutes with it.
    const { root, repo } = await makeRepo()
    await seedRef(repo, 'trident/hand-made', 'handmade')

    const report = await sweepAndReap({
      store: stubStore(repo),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    expect(report.refs_kept.length).toBeGreaterThan(0)
    expect(report.refs_stood_down).toBe(0)
  }, 30_000)

  test('the composition lifts the latch BEFORE starting the reaper, not after', () => {
    // `SupervisedLoop.start()` fires its first tick SYNCHRONOUSLY with `immediate: true`
    // (`loop/index.ts`: `void this.runOnce()` inside `start`), so a latch set AFTER
    // `start()` is still unset when the boot sweep reads it. The no-rescue branch therefore
    // stood the boot sweep's REF half down on the one branch whose entire premise is that
    // there is no rescue to wait for — the opposite of what its comment claimed.
    //
    // Asserted on ORDER in the composition source, because the defect is an ordering and a
    // behavioural test would have to reach into module init to see it.
    const src = readFileSync(
      new URL('../gateway/composition/build-core-modules.ts', import.meta.url),
      'utf8',
    )
    const lift = src.indexOf('if (reconcileStranded === undefined) strandedSweepSettled = true')
    const start = src.indexOf('reaper?.start()')
    expect(lift, 'the pre-start lift must exist').toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(-1)
    expect(lift, 'the latch must be lifted BEFORE reaper.start()').toBeLessThan(start)
    // And `immediate: true` is what makes the ordering matter, so pin that too rather than
    // leaving this test resting on a property of the loop that could quietly change.
    const reaperSrc = readFileSync(new URL('./worktree-reaper.ts', import.meta.url), 'utf8')
    expect(reaperSrc).toContain('immediate: true')
  })

  test('the summary log fires for a stand-down and not for a quiet sweep', () => {
    // The condition itself, since the log call is a side effect this suite cannot observe:
    // `refs_stood_down` must be one of the things that makes a sweep worth reporting.
    const source = readFileSync(new URL('./worktree-reaper.ts', import.meta.url), 'utf8')
    const guard = source.slice(source.indexOf('function logSummaryIfActed'))
    const condition = guard.slice(0, guard.indexOf('return'))
    expect(condition).toContain('report.refs_stood_down === 0')
    expect(condition).toContain('report.refs_deleted.length === 0')
    // And `refs_kept` is deliberately absent, or the steady state would log forever.
    expect(condition).not.toContain('refs_kept')
  })
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

    const first = await sweepAndReap({
      store: stubStore(repo, [], owners),
      run_host: spawnCapture,
      proc_root: proc,
    })

    expect(first.refs_deleted).toHaveLength(MAX_REF_DELETIONS_PER_SWEEP)
    expect(first.refs_kept.some((k) => k.reason === 'deletion limit reached')).toBe(true)
    // The unprovable one is never in the drain, this sweep or any other.
    expect(first.refs_deleted.some((e) => e.ref === `refs/heads/${unowned}`)).toBe(false)

    const second = await sweepAndReap({
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

    await sweepAndReap({
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

/**
 * THE DESTRUCTIVE BOUNDARY — what `deleteReapableRef` refuses when it is called directly
 * (#547 round 12).
 *
 * The extraction that keeps the destructive half under test also made it an exported entry
 * point, and an exported destructive primitive whose preconditions live in its doc comment is
 * a bypass with documentation. These tests pin the fix from the outside: a forged value is
 * refused before anything is written, and a value the gate chain actually minted still
 * deletes. Every forgery below needs an `as` cast, which is itself the finding — there is no
 * honest expression that produces one.
 */
describe('the destructive boundary refuses what the gates did not mint (#547)', () => {
  const budget = (): { attempts: number } => ({ attempts: 0 })
  const emptyReport = emptyReapReport

  // `makeProc` creates the directory, so it is called ONCE per repo and the result reused.
  //
  // THE OWNER ROWS ARE PASSED AT DELETE TIME TOO (#547 round 16). Gate 7 is re-measured inside
  // `refClaimedNow`, so a store that answers with NO rows refuses — correctly, since a ref with
  // no owner is unprovable ownership. These cases are about the BOUNDARY, so they supply the
  // ownership that would otherwise be the reason for refusal and let the boundary be the reason.
  const opts = (
    repo: string,
    proc: string,
    owners: TridentBranchOwner[] = [],
  ): Parameters<typeof deleteReapableRef>[0] => ({
    store: stubStore(repo, [], owners),
    run_host: spawnCapture,
    proc_root: proc,
  })

  test('an out-of-namespace ref is refused, even with a real sha and a terminal owner row', async () => {
    const { root, repo } = await makeRepo()
    const proc = makeProc(root)
    // A branch that is NOT trident's: the exact shape the unguarded primitive would have
    // deleted — a matching short name and the ref's true tip.
    const branch = 'feature/abcdefgh'
    const sha = await seedRef(repo, branch, 'notours')
    const report = emptyReport()
    const attempts = budget()

    await deleteReapableRef(
      opts(repo, proc),
      repo,
      { ref: ref(branch), sha } as ReapableCandidate,
      report,
      attempts,
    )

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual([
      {
        ref: ref(branch),
        reason: `not-a-reapable-candidate: ${ref(branch)} is outside ${TRIDENT_REF_PREFIX}`,
      },
    ])
    expect(await refExists(repo, ref(branch))).toBe(true)
    expect(await git(repo, 'rev-parse', ref(branch))).toBe(sha)
    // Nothing was written at all — not even the salvage, which is the FIRST write.
    expect(await git(repo, 'for-each-ref', '--format=%(refname)', SALVAGE_REF_PREFIX)).toBe('')
    // And a refusal does not spend the sweep's deletion allowance.
    expect(attempts.attempts).toBe(0)
  }, 30_000)

  test('an IN-namespace forgery is refused too — the namespace string is not the proof', async () => {
    const { root, repo } = await makeRepo()
    const proc = makeProc(root)
    const branch = 'trident/forged'
    const sha = await seedRef(repo, branch, 'forged')
    const report = emptyReport()

    await deleteReapableRef(
      opts(repo, proc),
      repo,
      { ref: ref(branch), sha } as ReapableCandidate,
      report,
      budget(),
    )

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual([
      { ref: ref(branch), reason: 'not-a-reapable-candidate: it was not minted by the gate chain' },
    ])
    expect(await refExists(repo, ref(branch))).toBe(true)
  }, 30_000)

  test('a COPY of a real minted candidate is not a candidate — the proof is identity', async () => {
    const { root, repo } = await makeRepo()
    const proc = makeProc(root)
    const branch = 'trident/copied'
    const sha = await seedRef(repo, branch, 'copied')

    // Minted for real, by the gate chain, with a terminal owner row: this value would delete.
    const sweep = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: proc,
    })
    const minted = onlyCandidate(sweep)
    expect(minted).toEqual({ repo, ref: ref(branch), sha })

    const owners = [owner(branch, { phase: 'failed' })]
    const report = emptyReport()
    await deleteReapableRef(
      opts(repo, proc, owners),
      repo,
      { ...minted } as ReapableCandidate,
      report,
      budget(),
    )

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toEqual([
      { ref: ref(branch), reason: 'not-a-reapable-candidate: it was not minted by the gate chain' },
    ])
    expect(await refExists(repo, ref(branch))).toBe(true)

    // THE COMPLEMENT, on the same ref in the same repo: the object the gates produced still
    // deletes. Without this the tests above would also pass if the boundary refused
    // everything.
    const real = emptyReport()
    const attempts = budget()
    await deleteReapableRef(opts(repo, proc, owners), repo, minted, real, attempts)

    expect(real.refs_deleted).toEqual([
      { ref: ref(branch), sha, salvage: `${SALVAGE_REF_PREFIX}copied/${sha}` },
    ])
    expect(await refExists(repo, ref(branch))).toBe(false)
    expect(attempts.attempts).toBe(1)
  }, 60_000)

  test('a truncated sha is refused before the salvage name is composed', async () => {
    const { root, repo } = await makeRepo()
    const proc = makeProc(root)
    const branch = 'trident/shortsha'
    const sha = await seedRef(repo, branch, 'shortsha')
    const abbreviated = sha.slice(0, 8)
    const report = emptyReport()

    await deleteReapableRef(
      opts(repo, proc),
      repo,
      { ref: ref(branch), sha: abbreviated } as ReapableCandidate,
      report,
      budget(),
    )

    expect(report.refs_kept).toEqual([
      {
        ref: ref(branch),
        reason: `not-a-reapable-candidate: ${abbreviated} is not a full object name`,
      },
    ])
    expect(await refExists(repo, ref(branch))).toBe(true)
  }, 30_000)
})

/**
 * THE ATTESTATION'S COVERAGE — every input the destructive operation consumes (#547 round 13).
 *
 * The first boundary bound `(ref, sha)` while `deleteReapableRef` took `repo` separately and
 * aimed the delete at it, and the tests only ever forged within ONE repository, so the free
 * axis was never crossed. These cases cross it, and pin the object-name check in the direction
 * that breaks users rather than only the direction that rejects.
 */
describe('the attestation covers the repository too, and both object formats (#547)', () => {
  const emptyReport = emptyReapReport

  test('a candidate minted in one repo cannot delete the same ref in another', async () => {
    const branch = 'trident/same-name-same-sha'
    // REPO A: gates run here, so this is where the candidate is minted.
    const a = await makeRepo()
    const procA = makeProc(a.root)
    const sha = await seedRef(a.repo, branch, 'shared')

    // REPO B: a clone, so it carries the SAME ref at the SAME commit — the sha check, the
    // namespace check and `refExists` all agree with A, and only the repository differs.
    const b = { root: a.root, repo: join(a.root, 'clone') }
    await git(a.root, 'clone', '--no-local', a.repo, b.repo)
    await git(b.repo, 'fetch', 'origin', `${branch}:${branch}`)
    expect(await git(b.repo, 'rev-parse', ref(branch))).toBe(sha)

    const sweepA = await sweepTridentWorktrees({
      store: stubStore(a.repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: procA,
    })
    const mintedForA = onlyCandidate(sweepA)

    // THE CROSS-REPOSITORY CALL: A's attestation, B's repository. B's gates never ran.
    const report = emptyReport()
    await deleteReapableRef(
      { store: stubStore(b.repo), run_host: spawnCapture, proc_root: procA },
      b.repo,
      mintedForA,
      report,
      { attempts: 0 },
    )

    expect(report.refs_deleted).toEqual([])
    expect(report.refs_kept).toHaveLength(1)
    expect(report.refs_kept[0]?.reason).toStartWith('not-a-reapable-candidate: its gates ran against ')
    // B's ref survives, and nothing was written into B at all — not even a salvage.
    expect(await refExists(b.repo, ref(branch))).toBe(true)
    expect(await git(b.repo, 'for-each-ref', '--format=%(refname)', SALVAGE_REF_PREFIX)).toBe('')

    // THE COMPLEMENT: the same attestation against the repository it was minted for deletes.
    const home = emptyReport()
    await deleteReapableRef(
      {
        store: stubStore(a.repo, [], [owner(branch, { phase: 'failed' })]),
        run_host: spawnCapture,
        proc_root: procA,
      },
      a.repo,
      mintedForA,
      home,
      { attempts: 0 },
    )
    expect(home.refs_deleted).toEqual([
      { ref: ref(branch), sha, salvage: `${SALVAGE_REF_PREFIX}same-name-same-sha/${sha}` },
    ])
    expect(await refExists(a.repo, ref(branch))).toBe(false)
    // And B is STILL untouched after A's delete succeeded.
    expect(await refExists(b.repo, ref(branch))).toBe(true)
  }, 120_000)

  test('a symlinked spelling of the SAME repo still deletes — canonical, not literal', async () => {
    // The mismatch check must not fire on two names for one repository, or an operator path
    // with a symlink in it would silently stop the reap while reporting a refusal.
    const branch = 'trident/symlinked-spelling'
    const { root, repo } = await makeRepo()
    const proc = makeProc(root)
    const sha = await seedRef(repo, branch, 'symlinked')
    const alias = join(root, 'alias')
    symlinkSync(repo, alias, 'dir')

    // Minted under the REAL path, acted on under the SYMLINKED one.
    const sweep = await sweepTridentWorktrees({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: proc,
    })
    const minted = onlyCandidate(sweep)

    const report = emptyReport()
    await deleteReapableRef(
      { store: stubStore(alias, [], [owner(branch, { phase: 'failed' })]), run_host: spawnCapture, proc_root: proc },
      alias,
      minted,
      report,
      { attempts: 0 },
    )

    expect(report.refs_kept.map((k) => k.reason)).not.toContainEqual(
      expect.stringContaining('not-a-reapable-candidate'),
    )
    expect(report.refs_deleted).toEqual([
      { ref: ref(branch), sha, salvage: `${SALVAGE_REF_PREFIX}symlinked-spelling/${sha}` },
    ])
    expect(await refExists(repo, ref(branch))).toBe(false)
  }, 60_000)

  test('REAL GIT, SHA-256: a 64-character object name is reaped, not refused as malformed', async () => {
    // `trident/codex-build.sh`'s `sha_or_empty` already warned that hard-coding 40 collapses
    // every measured sha on a sha256 repository. The first cut of the boundary hard-coded 40,
    // so the destructive half refused its OWN minted candidate here and the reap did nothing.
    const { root, repo } = await makeRepo('sha256')
    const branch = 'trident/wide-object-name'
    const sha = await seedRef(repo, branch, 'wide')
    expect(sha).toHaveLength(64)
    expect(await git(repo, 'rev-parse', '--show-object-format')).toBe('sha256')

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([
      { ref: ref(branch), sha, salvage: `${SALVAGE_REF_PREFIX}wide-object-name/${sha}` },
    ])
    expect(await refExists(repo, ref(branch))).toBe(false)
    // The salvage names the full 64-character tip and still resolves to it.
    expect(await git(repo, 'rev-parse', `${SALVAGE_REF_PREFIX}wide-object-name/${sha}`)).toBe(sha)
  }, 60_000)

  test('REAL GIT, SHA-1: the 40-character positive case, asserted on the WIDTH', async () => {
    // The complement of the case above, so "both widths" is proven and not assumed from one.
    const { root, repo } = await makeRepo()
    const branch = 'trident/narrow-object-name'
    const sha = await seedRef(repo, branch, 'narrow')
    expect(sha).toHaveLength(40)

    const report = await sweepAndReap({
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    expect(report.refs_deleted).toEqual([
      { ref: ref(branch), sha, salvage: `${SALVAGE_REF_PREFIX}narrow-object-name/${sha}` },
    ])
  }, 60_000)

  test('the widths BETWEEN and BEYOND the two are still refused', async () => {
    // Widening to "40 or 64" must not become "40 or more" or "anything hex": the salvage ref
    // embeds this value in its NAME, so a malformed sha composes a salvage that names something
    // other than the tip it claims to keep.
    const { root, repo } = await makeRepo()
    const proc = makeProc(root)
    const branch = 'trident/malformed-widths'
    const sha = await seedRef(repo, branch, 'malformed')
    const opts = { store: stubStore(repo), run_host: spawnCapture, proc_root: proc }

    const malformed = [
      sha.slice(0, 39), // one short of sha1
      `${sha}0`, // one long
      `${sha}${sha.slice(0, 23)}`, // 63, one short of sha256
      `${sha}${sha.slice(0, 25)}`, // 65, one long
      sha.toUpperCase(), // right width, wrong charset
    ]
    for (const candidate of malformed) {
      const report = emptyReport()
      await deleteReapableRef(
        opts,
        repo,
        { ref: ref(branch), sha: candidate } as ReapableCandidate,
        report,
        { attempts: 0 },
      )
      expect(report.refs_kept, candidate).toEqual([
        {
          ref: ref(branch),
          reason: `not-a-reapable-candidate: ${candidate} is not a full object name`,
        },
      ])
    }
    // POSITIVE CONTROL on the loop: the real 40-character sha is NOT in that list, and the
    // two accepted widths are exactly 40 and 64.
    expect(malformed.map((m) => m.length)).toEqual([39, 41, 63, 65, 40])
    expect(malformed).not.toContain(sha)
    expect(await refExists(repo, ref(branch))).toBe(true)
  }, 60_000)
})

/**
 * TWO REPOSITORIES IN ONE SWEEP, through the call shape `#635` restores (#547 round 14).
 *
 * The harness used to aim every minted candidate at the FIRST non-empty `listRepoPaths()` entry.
 * While a candidate was `{ ref, sha }` and the attestation was repo-blind that was merely
 * sloppy; once the attestation became repo-bound it made the second repository's candidates
 * refuse — so the destructive path across repositories was WRONG in the very harness that
 * stands in for production's call structure, and no test could see it because no test drove two
 * repositories through the destructive half.
 */
describe('a sweep spanning two repositories reaps in each of them (#547)', () => {
  test('both repositories are reaped, each candidate against its own', async () => {
    const first = await makeRepo()
    const second = await makeRepo()
    const branchOne = 'trident/in-the-first'
    const branchTwo = 'trident/in-the-second'
    const shaOne = await seedRef(first.repo, branchOne, 'firstrepo')
    const shaTwo = await seedRef(second.repo, branchTwo, 'secondrepo')

    const report = await sweepAndReap({
      store: stubMultiStore({
        [first.repo]: [owner(branchOne, { phase: 'failed' })],
        [second.repo]: [owner(branchTwo, { phase: 'done' })],
      }),
      run_host: spawnCapture,
      proc_root: makeProc(first.root),
    })

    // Each candidate carries the repository its gates ran against, so the inventory alone is
    // enough to route the destructive call — which is what the harness now does.
    expect(report.refs_candidates).toEqual([
      { repo: canonical(first.repo), ref: ref(branchOne), sha: shaOne },
      { repo: canonical(second.repo), ref: ref(branchTwo), sha: shaTwo },
    ])

    // BOTH are deleted. Before this round the second was refused at the boundary.
    expect(report.refs_deleted).toEqual([
      { ref: ref(branchOne), sha: shaOne, salvage: `${SALVAGE_REF_PREFIX}in-the-first/${shaOne}` },
      { ref: ref(branchTwo), sha: shaTwo, salvage: `${SALVAGE_REF_PREFIX}in-the-second/${shaTwo}` },
    ])
    expect(await refExists(first.repo, ref(branchOne))).toBe(false)
    expect(await refExists(second.repo, ref(branchTwo))).toBe(false)

    // And each salvage landed in ITS OWN repository, not both in the first.
    expect(await git(first.repo, 'for-each-ref', '--format=%(refname)', SALVAGE_REF_PREFIX)).toBe(
      `${SALVAGE_REF_PREFIX}in-the-first/${shaOne}`,
    )
    expect(await git(second.repo, 'for-each-ref', '--format=%(refname)', SALVAGE_REF_PREFIX)).toBe(
      `${SALVAGE_REF_PREFIX}in-the-second/${shaTwo}`,
    )

    // No boundary refusal anywhere: the routing is right, not merely lucky.
    expect(report.refs_kept.map((k) => k.reason).join('\n')).not.toContain('not-a-reapable-candidate')
  }, 120_000)

  test('the SAME branch name in both repos is judged by each repo OWN rows', async () => {
    // The cross-repository ownership confusion this routing has to survive. `trident/<slug>` is
    // derived from the card, so two repositories genuinely can hold the same branch name — and
    // an owner row is matched by that short name. If ownership were read across repositories
    // rather than per repository, the first repo's terminal row would authorise deleting the
    // SECOND repo's ref, which no gate ran against.
    const owned = await makeRepo()
    const unowned = await makeRepo()
    const branch = 'trident/same-slug-both-repos'
    const shaOwned = await seedRef(owned.repo, branch, 'ownedone')
    const shaUnowned = await seedRef(unowned.repo, branch, 'unownedone')
    expect(shaOwned).not.toBe(shaUnowned)

    const report = await sweepAndReap({
      store: stubMultiStore({
        [owned.repo]: [owner(branch, { phase: 'failed' })],
        [unowned.repo]: [],
      }),
      run_host: spawnCapture,
      proc_root: makeProc(owned.root),
    })

    expect(report.refs_deleted).toEqual([
      { ref: ref(branch), sha: shaOwned, salvage: `${SALVAGE_REF_PREFIX}same-slug-both-repos/${shaOwned}` },
    ])
    expect(await refExists(owned.repo, ref(branch))).toBe(false)
    // The unowned repo keeps its ref, for its OWN reason, and gets no salvage written.
    expect(await git(unowned.repo, 'rev-parse', ref(branch))).toBe(shaUnowned)
    expect(await git(unowned.repo, 'for-each-ref', '--format=%(refname)', SALVAGE_REF_PREFIX)).toBe('')
    expect(report.refs_kept).toEqual(
      expect.arrayContaining([
        { ref: ref(branch), reason: 'owner-unknown: no run row names this branch' },
      ]),
    )
  }, 120_000)

  test('a sweep through a SYMLINKED repo path routes by the spelling the STORE is keyed by', async () => {
    // WHY THE ROUTING KEY IS NOT CANONICALISED (#547 round 16). It was, for one round, and that
    // broke this: `listBranchOwners(repo_path)` is keyed by the path STRING it is given, so a
    // store configured with the symlinked spelling answers NOTHING for the resolved one. With a
    // canonical routing key the delete-time owner read came back empty and the re-measured gate 7
    // refused every ref in such a repository — fail-closed, but silently never reaping.
    //
    // So the candidate carries the sweep's own spelling, which is the key to both `git -C` and
    // the store, while the ATTESTATION stays canonical (proven by the sibling case in the
    // boundary suite, where minting and acting use different spellings and the delete still
    // happens). Faithful for routing, resolved for comparison.
    const { root, repo } = await makeRepo()
    const branch = 'trident/swept-through-a-link'
    const sha = await seedRef(repo, branch, 'throughlink')
    const alias = join(root, 'via-link')
    symlinkSync(repo, alias, 'dir')

    const report = await sweepAndReap({
      store: stubMultiStore({ [alias]: [owner(branch, { phase: 'failed' })] }),
      run_host: spawnCapture,
      proc_root: makeProc(root),
    })

    // The candidate names the path the sweep was given — the one the store can answer for.
    expect(report.refs_candidates).toEqual([{ repo: alias, ref: ref(branch), sha }])
    // And the delete went through, which it can only do if the delete-time owner read found the
    // row: gate 7 is re-measured, so an unanswerable store would have refused here.
    expect(report.refs_deleted).toEqual([
      { ref: ref(branch), sha, salvage: `${SALVAGE_REF_PREFIX}swept-through-a-link/${sha}` },
    ])
    expect(await refExists(repo, ref(branch))).toBe(false)
    // Same repository either way — the alias is not a second repo that happened to work.
    expect(canonical(alias)).toBe(canonical(repo))
  }, 60_000)

  test('one repository being unreapable does not stop the other', async () => {
    // The per-repository independence the deletion budget and a mid-sweep death rely on, across
    // repositories rather than across refs: the first repo's ref is held by a live worktree, the
    // second's is free, and the free one is still reaped.
    const first = await makeRepo()
    const second = await makeRepo()
    const held = 'trident/held-in-the-first'
    const free = 'trident/free-in-the-second'
    const heldWorktree = await addWorktree(first.repo, 'wf_live-1', held)
    const shaFree = await seedRef(second.repo, free, 'freeone')
    const proc = makeProc(first.root)
    addProcCwd(proc, 4242, heldWorktree)

    const report = await sweepAndReap({
      store: stubMultiStore({
        [first.repo]: [owner(held, { phase: 'failed' })],
        [second.repo]: [owner(free, { phase: 'failed' })],
      }),
      run_host: spawnCapture,
      proc_root: proc,
      now: () => Date.now(),
    })

    expect(report.refs_deleted).toEqual([
      { ref: ref(free), sha: shaFree, salvage: `${SALVAGE_REF_PREFIX}free-in-the-second/${shaFree}` },
    ])
    expect(await refExists(first.repo, ref(held))).toBe(true)
    expect(await refExists(second.repo, ref(free))).toBe(false)
    expect(keptReasonFor(report, ref(held))).toStartWith('held-by-worktree:')
  }, 120_000)
})

/**
 * FRESHNESS: AN ATTESTATION PROVES THE GATES RAN, NOT THAT THEY STILL HOLD (#547 round 15).
 *
 * `refClaimedNow` refreshed the holder listing and the owner rows and reused the sweep's
 * one-time `/proc` snapshot, so gate 10 was HISTORICAL while 4, 5 and 8 were current. A
 * process that starts inside an owning run's recorded worktree after the sweep changes nothing
 * about the holder listing (an ordinary directory is not a worktree git knows) and nothing
 * about the phase (the row is still terminal) — so the candidate stays genuinely minted and the
 * ref was deleted beneath it.
 */
describe('gate 10 is re-measured at delete time, not remembered (#547)', () => {
  /** An owning run whose recorded worktree is an ordinary directory: no git registration. */
  async function mintedWithARecordedTree(
    marker: string,
  ): Promise<{
    repo: string
    proc: string
    branch: string
    sha: string
    tree: string
    ownerRow: TridentBranchOwner
    opts: Parameters<typeof deleteReapableRef>[0]
    minted: ReapableCandidate
  }> {
    const { root, repo } = await makeRepo()
    const proc = makeProc(root)
    const branch = `trident/${marker}`
    const sha = await seedRef(repo, branch, marker)
    // The run's recorded tree, which must NOT exist at mint time or gate 9 keeps the ref.
    const tree = join(root, `wf_${marker}-1`)
    const ownerRow = owner(branch, { phase: 'failed', worktree: tree })
    const opts = {
      store: stubStore(repo, [], [ownerRow]),
      run_host: spawnCapture,
      proc_root: proc,
    }
    const sweep = await sweepTridentWorktrees(opts)
    return { repo, proc, branch, sha, tree, ownerRow, opts, minted: onlyCandidate(sweep) }
  }

  test('a process that appears AFTER minting stops the delete', async () => {
    const m = await mintedWithARecordedTree('liveness-after-mint')

    // The recorded tree comes into existence and something starts running in it — after the
    // gates, before the delete. No worktree is registered and the row is still terminal.
    mkdirSync(m.tree, { recursive: true })
    addProcCwd(m.proc, 9101, m.tree)

    const report = emptyReapReport()
    await deleteReapableRef(m.opts, m.repo, m.minted, report, { attempts: 0 })

    expect(report.refs_deleted).toEqual([])
    expect(keptReasonFor(report, ref(m.branch))).toBe(
      `refuses-now: a process stands in ${m.tree}`,
    )
    expect(await refExists(m.repo, ref(m.branch))).toBe(true)
    // THE SALVAGE IS ALREADY WRITTEN AT THIS POINT, and that is the real ordering rather than
    // an oversight: gate 11 precedes the claim probe, because the tip must be preserved before
    // anything is attempted. A refusal at gate 12 therefore leaves a salvage behind, which is
    // harmless (create-only, named for the sha it carries, outside `refs/heads`) and is one of
    // the reasons the deferral ships ZERO writes rather than "writes that do no harm".
    expect(await git(m.repo, 'for-each-ref', '--format=%(refname)', SALVAGE_REF_PREFIX)).toBe(
      `${SALVAGE_REF_PREFIX}liveness-after-mint/${m.sha}`,
    )
  }, 60_000)

  test('a RECORDED WORKTREE that appears after minting stops the delete, with no process at all', async () => {
    // THE DESTRUCTIVE DEFECT THIS CASE EXISTS FOR (#547 round 19). `store.ts` documents
    // `TridentBranchOwner.worktree` as "its continued EXISTENCE keeps the ref", and the initial
    // sweep enforces it — but `refClaimedNow` rechecked holders, owners and processes and never
    // re-asked this one. A directory created between minting and the delete is invisible to every
    // other cell: it is not a worktree git knows, the row is still terminal, and nothing need be
    // running in it. The path reached the CAS and deleted the branch over UNCOMMITTED WORK.
    //
    // THIS TEST PREVIOUSLY ASSERTED THE OPPOSITE. It created the recorded directory after minting
    // and expected DELETION, on the reasoning that a boundary refusing whenever a recorded
    // worktree exists "refuses everything". That reasoning was wrong: refusing exactly then is
    // gate 9's contract. A test that asserts the unsafe side of a boundary is worse than no test,
    // because it is why nobody noticed.
    const m = await mintedWithARecordedTree('worktree-after-mint')

    // THE FIXTURE MUST NOT HAVE PERFORMED THE STEP UNDER TEST. A setup richer than production's
    // turns a missing implementation into a passing test silently: if the recorded directory
    // already existed at mint time, gate 9 would have refused in the SWEEP, no candidate would
    // exist, and a boundary that rechecks nothing would still "refuse" — for the wrong reason.
    // So the absence at mint time is asserted, not assumed, and `onlyCandidate` above has already
    // proven a candidate was genuinely minted THROUGH gate 9.
    expect(existsSync(m.tree)).toBe(false)

    // The tree comes into existence with uncommitted work in it, unregistered with git, and with
    // no process standing anywhere near it.
    mkdirSync(m.tree, { recursive: true })
    writeFileSync(join(m.tree, 'uncommitted.txt'), 'work that exists nowhere else\n')

    const report = emptyReapReport()
    await deleteReapableRef(m.opts, m.repo, m.minted, report, { attempts: 0 })

    expect(report.refs_deleted).toEqual([])
    expect(keptReasonFor(report, ref(m.branch))).toBe(
      `refuses-now: the run's recorded worktree exists at ${m.tree}`,
    )
    expect(await refExists(m.repo, ref(m.branch))).toBe(true)
    expect(await git(m.repo, 'rev-parse', ref(m.branch))).toBe(m.sha)
    // AND THE REFUSAL CAME FROM THE RECHECK, not from git noticing a worktree: the directory is
    // unregistered, so it appears in no `worktree list`, and the reason above names gate 9's cell
    // rather than a holder. Pinning the REASON is what stops this passing for the wrong cause.
    expect(await git(m.repo, 'worktree', 'list', '--porcelain')).not.toContain(m.tree)
    // And the work is still there, which is the whole point.
    expect(readFileSync(join(m.tree, 'uncommitted.txt'), 'utf8')).toContain('nowhere else')
  }, 60_000)

  test('THE COMPLEMENT: a recorded path that is STILL ABSENT still deletes', async () => {
    // The pair that distinguishes "rechecks existence" from "refuses whenever a worktree is
    // recorded". Same owner row, same recorded path, and the directory is never created — so the
    // gate has nothing to find and the reap proceeds.
    const m = await mintedWithARecordedTree('worktree-still-absent')
    expect(existsSync(m.tree)).toBe(false)
    // A live process elsewhere in the repo, to prove the refusal below is not merely "no processes
    // exist at all".
    addProcCwd(m.proc, 9102, join(m.repo, '.claude'))

    const report = emptyReapReport()
    await deleteReapableRef(m.opts, m.repo, m.minted, report, { attempts: 0 })

    expect(report.refs_deleted).toEqual([
      {
        ref: ref(m.branch),
        sha: m.sha,
        salvage: `${SALVAGE_REF_PREFIX}worktree-still-absent/${m.sha}`,
      },
    ])
    expect(await refExists(m.repo, ref(m.branch))).toBe(false)
  }, 60_000)

  test('a process under the GENERATION path is seen at delete time too', async () => {
    // Gate 10's second witness, re-measured: a cwd bearing the run's `workflow_run_id`, which
    // is what catches a build whose worktree the row never recorded.
    const { root, repo } = await makeRepo()
    const proc = makeProc(root)
    const branch = 'trident/generation-after-mint'
    const sha = await seedRef(repo, branch, 'genafter')
    const generation = 'wf_abcdef12-999-3'
    const opts = {
      store: stubStore(repo, [], [owner(branch, { phase: 'stopped', workflow_run_id: generation })]),
      run_host: spawnCapture,
      proc_root: proc,
    }
    const minted = onlyCandidate(await sweepTridentWorktrees(opts))

    const late = join(root, generation)
    mkdirSync(late, { recursive: true })
    addProcCwd(proc, 9103, late)

    const report = emptyReapReport()
    await deleteReapableRef(opts, repo, minted, report, { attempts: 0 })

    expect(report.refs_deleted).toEqual([])
    expect(keptReasonFor(report, ref(branch))).toBe(`refuses-now: a process stands in ${generation}`)
    expect(await refExists(repo, ref(branch))).toBe(true)
  }, 60_000)

  test('a /proc that becomes UNREADABLE between mint and delete refuses', async () => {
    // Gate 1's posture at the SECOND measurement. The sweep aborts wholesale when `/proc`
    // cannot be read; if it stops being readable afterwards, "is anything running in there"
    // has no answer, and an unanswered question is never an absence of claimants.
    const { root, repo } = await makeRepo()
    const proc = makeProc(root)
    const branch = 'trident/proc-vanishes'
    const sha = await seedRef(repo, branch, 'procgone')
    const opts = {
      store: stubStore(repo, [], [owner(branch, { phase: 'failed' })]),
      run_host: spawnCapture,
      proc_root: proc,
    }
    const minted = onlyCandidate(await sweepTridentWorktrees(opts))

    rmSync(proc, { recursive: true, force: true })

    const report = emptyReapReport()
    await deleteReapableRef(opts, repo, minted, report, { attempts: 0 })

    expect(report.refs_deleted).toEqual([])
    expect(keptReasonFor(report, ref(branch))).toBe(
      'refuses-now: liveness-unreadable: /proc could not be read at delete time',
    )
    expect(await refExists(repo, ref(branch))).toBe(true)
    // Salvage first, claim probe second — see the note in the case above.
    expect(await git(repo, 'for-each-ref', '--format=%(refname)', SALVAGE_REF_PREFIX)).toBe(
      `${SALVAGE_REF_PREFIX}proc-vanishes/${sha}`,
    )
  }, 60_000)

  test('an owner row that DISAPPEARS after minting stops the delete', async () => {
    // THE OTHER HALF OF THE OWNER AXIS (#547 round 16). An owner APPEARING was covered from the
    // start; an owner VANISHING was not, because the audit had classified gate 7 as immutable on
    // the belief that rows are never deleted. `store.ts`'s `delete(id)` — `/trident stop`'s
    // hard-delete, `DELETE FROM code_trident_runs WHERE id = ?` — is that path.
    //
    // Without the re-measured gate 7 both `find` calls miss on an empty list, `refClaimedNow`
    // falls through to null, and the ref is deleted on NO ownership evidence at all: the exact
    // condition the sweep itself refuses as `owner-unknown`.
    const { root, repo } = await makeRepo()
    const proc = makeProc(root)
    const branch = 'trident/owner-vanishes'
    const sha = await seedRef(repo, branch, 'ownergone')

    // A mutable owner list, so the row can be removed between minting and the delete exactly as
    // a concurrent `/trident stop` would remove it.
    let rows: TridentBranchOwner[] = [owner(branch, { phase: 'failed' })]
    const opts = {
      store: {
        listRepoPaths: () => [repo],
        listNonTerminal: () => [],
        listBranchOwners: () => rows,
      },
      run_host: spawnCapture,
      proc_root: proc,
    }
    const minted = onlyCandidate(await sweepTridentWorktrees(opts))

    rows = []

    const report = emptyReapReport()
    await deleteReapableRef(opts, repo, minted, report, { attempts: 0 })

    expect(report.refs_deleted).toEqual([])
    expect(keptReasonFor(report, ref(branch))).toBe(
      'refuses-now: ownership-no-longer-provable: no run row names this branch any more',
    )
    expect(await refExists(repo, ref(branch))).toBe(true)
    expect(await git(repo, 'rev-parse', ref(branch))).toBe(sha)
  }, 60_000)

  test('THE COMPLEMENT: an owner row that stays put still deletes', async () => {
    // Same shape, same mutable list, nothing removed — so the case above cannot be satisfied by a
    // boundary that refuses whenever the store is consulted twice.
    const { root, repo } = await makeRepo()
    const proc = makeProc(root)
    const branch = 'trident/owner-stays'
    const sha = await seedRef(repo, branch, 'ownerstays')
    const rows: TridentBranchOwner[] = [owner(branch, { phase: 'done' })]
    const opts = {
      store: {
        listRepoPaths: () => [repo],
        listNonTerminal: () => [],
        listBranchOwners: () => rows,
      },
      run_host: spawnCapture,
      proc_root: proc,
    }
    const minted = onlyCandidate(await sweepTridentWorktrees(opts))

    const report = emptyReapReport()
    await deleteReapableRef(opts, repo, minted, report, { attempts: 0 })

    expect(report.refs_deleted).toEqual([
      { ref: ref(branch), sha, salvage: `${SALVAGE_REF_PREFIX}owner-stays/${sha}` },
    ])
    expect(await refExists(repo, ref(branch))).toBe(false)
  }, 60_000)

  test('the hard-delete path this gate defends against really exists', () => {
    // THE CELL THAT WAS WRONG WAS A CLAIM ABOUT ANOTHER MODULE, believed rather than measured.
    // So the claim is now measured here, and if `/trident stop`'s hard delete is ever replaced by
    // a soft one this test says so instead of the classification quietly going stale.
    const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')
    expect(store).toContain('DELETE FROM code_trident_runs')
    // POSITIVE CONTROL on the read: a string that must be there, so "not found" cannot mean
    // "wrong file" or "unreadable".
    expect(store).toContain('listBranchOwners')
  })

  test('the freshness audit in the header names gate 10 as re-measured', () => {
    // The list the next person reads before enabling deletion. Pinned because its whole value
    // is being accurate about which gates are current, and a stale list is worse than none.
    const source = readFileSync(new URL('./worktree-reaper.ts', import.meta.url), 'utf8')
    const audit = source.slice(
      source.indexOf('WHICH GATES ARE CURRENT AND WHICH ARE HISTORICAL'),
      source.indexOf('import {'),
    )
    expect(audit).not.toBe('')
    expect(audit).toContain('MUTABLE AND RE-MEASURED')
    expect(audit).toContain('RE-MEASURED SINCE ROUND 15')
    expect(audit).toContain('An attestation proves the gates ran'.toUpperCase())
    // And the re-measurement it describes is really in `refClaimedNow`, not just claimed here.
    const probe = source.slice(
      source.indexOf('async function refClaimedNow('),
      source.indexOf('async function reapBranchRefs('),
    )
    expect(probe).toContain('snapshotProcessCwds(')
    expect(probe).toContain('ownerProcessLive(')
    // POSITIVE CONTROL: the sweep's own gate-10 call is a DIFFERENT site, so finding these in
    // the probe cannot be the loop's copy being matched by a too-wide slice.
    expect(probe).not.toContain('async function reapBranchRefs(')
  })
})
