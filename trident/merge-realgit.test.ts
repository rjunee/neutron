/**
 * @neutronai/trident — REAL-git integration coverage for build reliability
 * (#351 P1 + #352 P2). Deliberately NOT mocked: the existing `merge.test.ts`
 * stubs `RunHostCommand`, which is EXACTLY why the shared-checkout poisoning
 * bug shipped (the mock never exercised a real working tree / index / MERGE_HEAD).
 * These tests drive `mergeLocal` against actual temp git repos via `spawnCapture`,
 * so a regression in the worktree isolation or the stale-state recovery fails here.
 *
 * Covers the three Ryan-locked reliability guarantees:
 *   1. ISOLATION — N concurrent same-project builds each rebase/merge in their OWN
 *      worktree (distinct paths); all land; the base repo is CLEAN after (no
 *      MERGE_HEAD, no stray worktrees).
 *   2. STALE-STATE RECOVERY — a base repo poisoned with a real in-progress merge
 *      (`.git/MERGE_HEAD` present) is auto-healed before the build merges; the
 *      build completes instead of failing "resolve your current index first".
 *   3. FAILURE ISOLATION — an UNRECOVERABLE rebase conflict escalates a plain
 *      question WITHOUT raw git stderr, and — critically — leaves the shared base
 *      repo UNTOUCHED (the failed rebase happened in the throwaway worktree).
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnCapture } from './git-mode.ts'
import { cleanupAfterMerge } from './git-mode.ts'
import {
  buildMergeCleanupDeps,
  runWorktreePath,
  TridentBaseDriftHold,
  TridentMergeConflictEscalation,
  TridentMergeError,
} from './merge.ts'
import type { TridentRun } from './store.ts'

const GIT_ID = ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false']
const created: string[] = []

async function git(repo: string, ...args: string[]): Promise<void> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
}

async function gitOut(repo: string, ...args: string[]): Promise<string> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  return res.stdout
}

/** A fresh base repo on `main` with one committed file. */
async function makeBaseRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'trident-base-'))
  created.push(dir)
  await git(dir, 'init', '-q', '--initial-branch=main')
  // CI runners have NO ambient git identity (dev machines do), and the merge/
  // rebase under test creates commits (rebase --continue, merge --no-ff). Set a
  // LOCAL identity on the repo so every git op here — the test's own AND the
  // trident merge code operating on this repo — has a committer. Without this the
  // real-git tests pass on macOS but fail on Linux CI ("Committer identity unknown").
  await git(dir, 'config', 'user.email', 'trident-test@neutron.local')
  await git(dir, 'config', 'user.name', 'Trident Test')
  writeFileSync(join(dir, 'README.md'), 'base\n')
  await git(dir, 'add', '.')
  await git(dir, ...GIT_ID, 'commit', '-q', '-m', 'init')
  return dir
}

/**
 * Simulate a completed Forge build: create `branch` off main with a commit, using
 * a THROWAWAY worktree that we then remove — exactly the state the inner workflow
 * leaves (the branch lives in the base repo's refs; no worktree survives).
 */
async function fakeBuild(repo: string, branch: string, file: string, content: string): Promise<void> {
  const tmp = join(repo, `.build-${branch.replace(/\W/g, '_')}`)
  await git(repo, 'branch', branch, 'main')
  await git(repo, 'worktree', 'add', '-q', tmp, branch)
  writeFileSync(join(tmp, file), content)
  await git(tmp, 'add', '.')
  await git(tmp, ...GIT_ID, 'commit', '-q', '-m', `build ${branch}`)
  await git(repo, 'worktree', 'remove', '--force', tmp)
}

function localRun(repo: string, id: string, branch: string): TridentRun {
  return {
    id,
    slug: branch,
    project_slug: 'proj',
    phase: 'done',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch,
    pr: null,
    merge_mode: 'local',
    subagent_run_id: null,
    subagent_status: 'completed',
    repo_path: repo,
    worktree: runWorktreePath(repo, { id, slug: branch }),
    task: `build ${branch}`,
    chat_id: null,
    thread_id: null,
    channel_kind: 'telegram',
    failure_reason: null,
    workflow_run_id: null,
    inner_checkpoint: 'argus-approved',
    inner_verdict: 'APPROVE',
    inner_result: null,
    started_at: '2026-01-01T00:00:00.000Z',
    last_advanced_at: '2026-01-01T00:00:00.000Z',
    harvested_at: null,
  }
}

async function status(repo: string): Promise<string> {
  return (await gitOut(repo, 'status', '--porcelain')).trim()
}

async function worktreeCount(repo: string): Promise<number> {
  const out = await gitOut(repo, 'worktree', 'list', '--porcelain')
  return out.split(/\n/).filter((l) => l.startsWith('worktree ')).length
}

/** No leftover build worktree working-dirs (the parent `.trident-worktrees/` dir
 *  may linger EMPTY after `git worktree remove`; that is cosmetic — what matters is
 *  no worktree subdir survives). */
function noStrayWorktreeDirs(repo: string): boolean {
  const dir = join(repo, '.trident-worktrees')
  if (!existsSync(dir)) return true
  return readdirSync(dir).length === 0
}

afterAll(() => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

describe('REAL git — worktree isolation (#351)', () => {
  test('3 concurrent same-project builds each use their OWN worktree; all land; base repo CLEAN', async () => {
    const repo = await makeBaseRepo()
    // Three independent builds (distinct files → no content conflicts).
    await fakeBuild(repo, 'trident/a', 'a.txt', 'A\n')
    await fakeBuild(repo, 'trident/b', 'b.txt', 'B\n')
    await fakeBuild(repo, 'trident/c', 'c.txt', 'C\n')

    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    const runs = [
      localRun(repo, '11111111', 'trident/a'),
      localRun(repo, '22222222', 'trident/b'),
      localRun(repo, '33333333', 'trident/c'),
    ]
    // DISTINCT worktree paths — the isolation invariant (was: all shared ONE checkout).
    expect(new Set(runs.map((r) => r.worktree)).size).toBe(3)

    // Fire all three concurrently — the per-repo lock serializes the land.
    await Promise.all(runs.map((r) => cleanupAfterMerge(r, deps)))

    // All three files landed on main.
    await git(repo, 'checkout', '-q', 'main')
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
      expect(existsSync(join(repo, f))).toBe(true)
    }
    // Base repo is CLEAN: no leftover MERGE_HEAD / rebase state / dirty index.
    expect(await status(repo)).toBe('')
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false)
    expect(existsSync(join(repo, '.git', 'rebase-apply'))).toBe(false)
    // No stray worktrees remain (only the base checkout).
    expect(await worktreeCount(repo)).toBe(1)
    expect(noStrayWorktreeDirs(repo)).toBe(true)
  }, 30_000)
})

describe('REAL git — defensive stale-state recovery (#351/#352)', () => {
  test('a base repo poisoned with an in-progress merge (MERGE_HEAD) auto-heals; the build lands', async () => {
    const repo = await makeBaseRepo()
    // A build cut off the current main (a distinct file → will rebase clean).
    await fakeBuild(repo, 'trident/feat', 'feat.txt', 'feat\n')

    // POISON the shared checkout: leave a real, conflicted, in-progress merge —
    // exactly the pre-#342 dagcore failure that stranded kvwal.
    await git(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'README.md'), 'main-side\n')
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main edit')
    await git(repo, 'checkout', '-q', '-b', 'poison', 'HEAD~1')
    writeFileSync(join(repo, 'README.md'), 'poison-side\n')
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'poison edit')
    await git(repo, 'checkout', '-q', 'main')
    const merge = await spawnCapture(['git', '-C', repo, 'merge', 'poison'], repo)
    expect(merge.ok).toBe(false) // it conflicted
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true) // repo is POISONED

    // Now run a build through the real merge path. It MUST auto-recover, not fail
    // with "you need to resolve your current index first".
    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    await cleanupAfterMerge(localRun(repo, 'aaaaaaaa', 'trident/feat'), deps)

    // The stale merge was aborted + the build landed cleanly.
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    await git(repo, 'checkout', '-q', 'main')
    expect(existsSync(join(repo, 'feat.txt'))).toBe(true)
    expect(await status(repo)).toBe('')
  }, 30_000)

  test('a poisoned shared checkout left ON the feature branch (interrupted rebase) recovers onto base + lands (Codex P1)', async () => {
    // The legacy failure mode: the OLD mergeLocal ran `git checkout <branch>; git
    // rebase <base>` IN the shared checkout and a conflict left it mid-rebase, ON
    // the feature branch. If recovery only aborted the rebase (HEAD back on the
    // branch), the new merge worktree's `git checkout <branch>` would fail "already
    // checked out at <shared repo>". Recovery MUST move the shared checkout to base.
    const repo = await makeBaseRepo()
    // A feature branch that CONFLICTS with a later main edit on README.md.
    await git(repo, 'branch', 'trident/feat', 'main')
    const bwt = join(repo, '.mk-feat')
    await git(repo, 'worktree', 'add', '-q', bwt, 'trident/feat')
    writeFileSync(join(bwt, 'README.md'), 'feat-side\n')
    writeFileSync(join(bwt, 'feat.txt'), 'feat\n')
    await git(bwt, 'add', '.')
    await git(bwt, ...GIT_ID, 'commit', '-q', '-m', 'feat edit')
    await git(repo, 'worktree', 'remove', '--force', bwt)
    // Advance main so a rebase of feat conflicts.
    writeFileSync(join(repo, 'README.md'), 'main-side\n')
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main edit')
    // POISON: leave the shared checkout ON trident/feat, mid-rebase.
    await git(repo, 'checkout', '-q', 'trident/feat')
    const reb = await spawnCapture(['git', '-C', repo, ...GIT_ID, 'rebase', 'main'], repo)
    expect(reb.ok).toBe(false) // conflicted → shared checkout is now on feat, mid-rebase
    expect(existsSync(join(repo, '.git', 'rebase-merge')) || existsSync(join(repo, '.git', 'rebase-apply'))).toBe(true)

    // A real resolver: resolve every conflicted file + `git add` (never continue).
    const resolve = async (input: { repo_path: string; conflicted_files: string[] }) => {
      for (const f of input.conflicted_files) {
        writeFileSync(join(input.repo_path, f), 'resolved\n')
        await git(input.repo_path, 'add', f)
      }
      return { resolved: true as const }
    }
    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main', resolve_conflict: resolve })

    // The build recovers (aborts the rebase + moves the shared checkout to base),
    // then rebases feat in its OWN worktree (resolver fixes the README conflict) + lands.
    await cleanupAfterMerge(localRun(repo, 'ffffffff', 'trident/feat'), deps)

    await git(repo, 'checkout', '-q', 'main')
    expect(existsSync(join(repo, 'feat.txt'))).toBe(true)
    expect(await status(repo)).toBe('')
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false)
    expect(existsSync(join(repo, '.git', 'rebase-apply'))).toBe(false)
    expect(await worktreeCount(repo)).toBe(1)
  }, 30_000)
})

describe('REAL git — failure isolation: an unrecoverable conflict never poisons the base repo (#352)', () => {
  test('a hard rebase conflict escalates a plain question AND leaves the shared checkout UNTOUCHED', async () => {
    const repo = await makeBaseRepo()
    // Two builds that edit the SAME file incompatibly → the 2nd conflicts on rebase.
    await fakeBuild(repo, 'trident/x', 'shared.txt', 'from-x\n')
    await fakeBuild(repo, 'trident/y', 'shared.txt', 'from-y\n')

    // No resolver configured → the conflict escalates (never a silent hard-fail).
    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })

    // Build X lands clean.
    await cleanupAfterMerge(localRun(repo, 'xxxxxxxx', 'trident/x'), deps)
    await git(repo, 'checkout', '-q', 'main')
    const mainAfterX = await gitOut(repo, 'rev-parse', 'HEAD')

    // Build Y rebases onto the new main + conflicts on shared.txt → escalates.
    let escalated: unknown = null
    try {
      await cleanupAfterMerge(localRun(repo, 'yyyyyyyy', 'trident/y'), deps)
    } catch (e) {
      escalated = e
    }
    expect(escalated).toBeInstanceOf(TridentMergeConflictEscalation)
    const question = (escalated as TridentMergeConflictEscalation).question
    // The escalation question is PLAIN — no raw git stderr tokens.
    expect(question.toLowerCase()).not.toContain('conflict (content)')
    expect(question.toLowerCase()).not.toContain('error:')
    expect(question.toLowerCase()).not.toContain('git ')

    // THE KEY INVARIANT: the shared base repo is UNTOUCHED despite the failed rebase
    // (it happened in the throwaway worktree, never the shared checkout). Without
    // the isolation fix, main would be mid-rebase and every LATER build would trip
    // "resolve your current index first".
    await git(repo, 'checkout', '-q', 'main')
    expect(await gitOut(repo, 'rev-parse', 'HEAD')).toBe(mainAfterX) // unchanged by Y
    expect(await status(repo)).toBe('')
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false)
    expect(await worktreeCount(repo)).toBe(1) // Y's worktree was torn down
    expect(noStrayWorktreeDirs(repo)).toBe(true)

    // A LATER build still succeeds — the repo was never poisoned by Y's failure.
    await fakeBuild(repo, 'trident/z', 'z.txt', 'Z\n')
    await cleanupAfterMerge(localRun(repo, 'zzzzzzzz', 'trident/z'), deps)
    await git(repo, 'checkout', '-q', 'main')
    expect(existsSync(join(repo, 'z.txt'))).toBe(true)
  }, 30_000)
})

describe('REAL git — base-drift hold: a same-file silent reconciliation never lands (#542)', () => {
  /** A file with enough distance between its two edited regions that git merges
   *  both sides with NO textual conflict — the SEMANTIC-conflict shape. */
  const lines = (mark1: string, mark20: string): string =>
    Array.from({ length: 20 }, (_, i) => (i === 0 ? mark1 : i === 19 ? mark20 : `L${i + 1}`)).join('\n') + '\n'

  async function baseRepoWithModule(): Promise<string> {
    const repo = await makeBaseRepo()
    writeFileSync(join(repo, 'mod.txt'), lines('L1', 'L20'))
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'add mod')
    return repo
  }

  /** Advance main by ONE commit editing `file`. */
  async function advanceMain(repo: string, file: string, content: string): Promise<void> {
    await git(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, file), content)
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', `main moves ${file}`)
  }

  test('HOLDS the merge when the moved base edited the SAME file with no conflict', async () => {
    const repo = await baseRepoWithModule()
    // The reviewed build edits the BOTTOM of mod.txt...
    await fakeBuild(repo, 'trident/feat', 'mod.txt', lines('L1', 'L20-from-branch'))
    // ...and AFTER the review, main edits the TOP of the same file. Far enough
    // apart that the rebase applies cleanly: nothing textual to catch it.
    await advanceMain(repo, 'mod.txt', lines('L1-from-main', 'L20'))
    const mainBeforeMerge = await gitOut(repo, 'rev-parse', 'main')

    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    let held: unknown = null
    try {
      await cleanupAfterMerge(localRun(repo, 'dddddddd', 'trident/feat'), deps)
    } catch (e) {
      held = e
    }
    expect(held).toBeInstanceOf(TridentBaseDriftHold)
    const hold = held as TridentBaseDriftHold
    expect(hold.detail.silent_overlap).toEqual(['mod.txt'])
    expect(hold.detail.review_base_sha).not.toBe(hold.detail.current_base_sha)
    // LOUD but plain — the owner-facing text names the file, not git stderr.
    expect(hold.message).toContain('mod.txt')
    expect(hold.message.toLowerCase()).not.toContain('fatal:')

    // NOTHING LANDED: main is exactly where it was, and the branch still exists
    // so the build can be re-reviewed against the new base.
    await git(repo, 'checkout', '-q', 'main')
    expect(await gitOut(repo, 'rev-parse', 'main')).toBe(mainBeforeMerge)
    expect((await gitOut(repo, 'branch', '--list', 'trident/feat')).trim()).not.toBe('')
    // The shared checkout is clean and the throwaway worktree is gone.
    expect(await status(repo)).toBe('')
    expect(await worktreeCount(repo)).toBe(1)
    expect(noStrayWorktreeDirs(repo)).toBe(true)
  }, 30_000)

  test('the HOLD leaves the branch exactly where the review left it — a RETRY holds too', async () => {
    const repo = await baseRepoWithModule()
    await fakeBuild(repo, 'trident/feat', 'mod.txt', lines('L1', 'L20-from-branch'))
    await advanceMain(repo, 'mod.txt', lines('L1-from-main', 'L20'))
    const reviewedTip = await gitOut(repo, 'rev-parse', 'trident/feat')
    const mainBeforeMerge = await gitOut(repo, 'rev-parse', 'main')

    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    const run = localRun(repo, 'dddddd42', 'trident/feat')
    await expect(cleanupAfterMerge(run, deps)).rejects.toBeInstanceOf(TridentBaseDriftHold)

    // The rebase inside the hold MOVED refs/heads/trident/feat onto main's tip.
    // If it stays there the drift is gone from the repo itself: attempt 2 forks
    // from the tip, measures nothing, and lands the un-reviewed combination.
    expect(await gitOut(repo, 'rev-parse', 'trident/feat')).toBe(reviewedTip)

    // So: run the SAME merge again, exactly as a resume/retry would.
    await expect(cleanupAfterMerge(run, deps)).rejects.toBeInstanceOf(TridentBaseDriftHold)
    await git(repo, 'checkout', '-q', 'main')
    expect(await gitOut(repo, 'rev-parse', 'main')).toBe(mainBeforeMerge)
    expect(await gitOut(repo, 'show', 'main:mod.txt')).not.toContain('L20-from-branch')
    expect(await status(repo)).toBe('')
    expect(await worktreeCount(repo)).toBe(1)
    expect(noStrayWorktreeDirs(repo)).toBe(true)
  }, 30_000)

  test('HOLDS when the base RENAMED the reviewed file out from under the branch', async () => {
    const repo = await baseRepoWithModule()
    // The branch edits the bottom of mod.txt...
    await fakeBuild(repo, 'trident/feat', 'mod.txt', lines('L1', 'L20-from-branch'))
    // ...and main renames mod.txt → renamed.txt while editing its top. With
    // git's rename detection the base side reports only `renamed.txt`, the path
    // sets miss each other, and both edits reconcile silently.
    await git(repo, 'checkout', '-q', 'main')
    await git(repo, 'mv', 'mod.txt', 'renamed.txt')
    writeFileSync(join(repo, 'renamed.txt'), lines('L1-from-main', 'L20'))
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main renames mod.txt')
    const mainBeforeMerge = await gitOut(repo, 'rev-parse', 'main')

    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    const held = (await cleanupAfterMerge(localRun(repo, 'dddddd43', 'trident/feat'), deps).catch(
      (e: unknown) => e,
    )) as TridentBaseDriftHold
    expect(held).toBeInstanceOf(TridentBaseDriftHold)
    expect(held.detail.silent_overlap).toContain('mod.txt')
    await git(repo, 'checkout', '-q', 'main')
    expect(await gitOut(repo, 'rev-parse', 'main')).toBe(mainBeforeMerge)
  }, 30_000)

  test('HOLDS when only the FIRST of two commits to the file conflicted', async () => {
    const repo = await baseRepoWithModule()
    // C1 edits the top of mod.txt (conflicts with main), C2 then edits the
    // bottom (replays silently on top of the resolution). The resolver sees
    // base-vs-C1 only; nothing ever sees base-vs-(C1+C2), so exempting the file
    // on the strength of that one conflict would land an unreviewed combination.
    await fakeBuild(repo, 'trident/feat', 'mod.txt', lines('L1-from-branch', 'L20'))
    const tmp = join(repo, '.build-second')
    await git(repo, 'worktree', 'add', '-q', tmp, 'trident/feat')
    writeFileSync(join(tmp, 'mod.txt'), lines('L1-from-branch', 'L20-from-branch'))
    await git(tmp, 'add', '.')
    await git(tmp, ...GIT_ID, 'commit', '-q', '-m', 'build second commit')
    await git(repo, 'worktree', 'remove', '--force', tmp)
    await advanceMain(repo, 'mod.txt', lines('L1-from-main', 'L20'))
    const mainBeforeMerge = await gitOut(repo, 'rev-parse', 'main')

    const resolve = async (input: { repo_path: string; conflicted_files: string[] }) => {
      for (const f of input.conflicted_files) {
        writeFileSync(join(input.repo_path, f), lines('L1-resolved', 'L20'))
        await git(input.repo_path, 'add', f)
      }
      return { resolved: true as const }
    }
    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main', resolve_conflict: resolve })
    const held = (await cleanupAfterMerge(localRun(repo, 'dddddd44', 'trident/feat'), deps).catch(
      (e: unknown) => e,
    )) as TridentBaseDriftHold
    expect(held).toBeInstanceOf(TridentBaseDriftHold)
    expect(held.detail.silent_overlap).toEqual(['mod.txt'])
    await git(repo, 'checkout', '-q', 'main')
    expect(await gitOut(repo, 'rev-parse', 'main')).toBe(mainBeforeMerge)
  }, 30_000)

  test('HOLDS when a resolver that stages NOTHING makes git re-offer the same commit', async () => {
    // THE ROUND-vs-COMMIT INFLATION, end to end on real git. Same two-commit
    // shape as the test above, but the resolver forgets to `git add` on its
    // first call: `rebase --continue` refuses ("needs merge"/"resolve all
    // conflicts"), git re-reports the IDENTICAL conflict, and the loop comes
    // round a second time ON THE SAME COMMIT. Counting ROUNDS scored that as 2
    // — exactly `touches` for a file 2 branch commits edit — so the file was
    // "covered", the hold was skipped, and C2's un-reviewed bottom-of-file edit
    // LANDED on main. Counting COMMIT IDENTITIES sees one commit, and holds.
    const repo = await baseRepoWithModule()
    await fakeBuild(repo, 'trident/feat', 'mod.txt', lines('L1-from-branch', 'L20'))
    const tmp = join(repo, '.build-second')
    await git(repo, 'worktree', 'add', '-q', tmp, 'trident/feat')
    writeFileSync(join(tmp, 'mod.txt'), lines('L1-from-branch', 'L20-from-branch'))
    await git(tmp, 'add', '.')
    await git(tmp, ...GIT_ID, 'commit', '-q', '-m', 'build second commit')
    await git(repo, 'worktree', 'remove', '--force', tmp)
    await advanceMain(repo, 'mod.txt', lines('L1-from-main', 'L20'))
    const mainBeforeMerge = await gitOut(repo, 'rev-parse', 'main')

    let calls = 0
    const resolve = async (input: { repo_path: string; conflicted_files: string[] }) => {
      calls++
      for (const f of input.conflicted_files) {
        writeFileSync(join(input.repo_path, f), lines('L1-resolved', 'L20'))
        // Round 1 deliberately does NOT stage — the whole point of the repro.
        if (calls > 1) await git(input.repo_path, 'add', f)
      }
      return { resolved: true as const }
    }
    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main', resolve_conflict: resolve })
    const held = (await cleanupAfterMerge(localRun(repo, 'dddddd55', 'trident/feat'), deps).catch(
      (e: unknown) => e,
    )) as TridentBaseDriftHold
    expect(calls).toBeGreaterThan(1)
    expect(held).toBeInstanceOf(TridentBaseDriftHold)
    expect(held.detail.silent_overlap).toEqual(['mod.txt'])
    // main is untouched, and C2's edit did NOT sneak in.
    await git(repo, 'checkout', '-q', 'main')
    expect(await gitOut(repo, 'rev-parse', 'main')).toBe(mainBeforeMerge)
    expect(await gitOut(repo, 'show', 'main:mod.txt')).not.toContain('L20-from-branch')
  }, 30_000)

  test('DOCUMENTED LIMIT: a conflicted file is exempted WHOLE, silently-merged hunks included', async () => {
    // This pins a DECISION, not an accident — see the "WHAT THIS DELIBERATELY
    // DOES NOT CATCH" block in merge.ts. The exemption is per PATH, not per
    // hunk: base and branch collide at line 1 (the resolver is handed that),
    // while main's line-10 edit and the branch's line-20 edit reconcile
    // silently. Both land, on the reasoning that the resolver is given the
    // WHOLE FILE mid-rebase with both sides present, so "a reviewer looked at
    // this file against this base" is true of the file, not just the hunk.
    // If that ever proves too generous this test is the one that must change,
    // and it will say so loudly instead of a hole being discovered in prod.
    const repo = await makeBaseRepo()
    const wide = (l1: string, l10: string, l20: string): string =>
      Array.from({ length: 20 }, (_, i) => (i === 0 ? l1 : i === 9 ? l10 : i === 19 ? l20 : `L${i + 1}`)).join('\n') +
      '\n'
    writeFileSync(join(repo, 'mod.txt'), wide('L1', 'L10', 'L20'))
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'add mod')
    // One branch commit: collides at line 1, and separately edits line 20.
    await fakeBuild(repo, 'trident/feat', 'mod.txt', wide('L1-from-branch', 'L10', 'L20-from-branch'))
    // Main collides at line 1, and separately edits line 10.
    await advanceMain(repo, 'mod.txt', wide('L1-from-main', 'L10-from-main', 'L20'))

    const resolve = async (input: { repo_path: string; conflicted_files: string[] }) => {
      for (const f of input.conflicted_files) {
        // The resolver settles line 1 and keeps BOTH silently-merged edits.
        writeFileSync(join(input.repo_path, f), wide('L1-resolved', 'L10-from-main', 'L20-from-branch'))
        await git(input.repo_path, 'add', f)
      }
      return { resolved: true as const }
    }
    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main', resolve_conflict: resolve })
    await cleanupAfterMerge(localRun(repo, 'dddddd66', 'trident/feat'), deps)

    await git(repo, 'checkout', '-q', 'main')
    const landed = await gitOut(repo, 'show', 'main:mod.txt')
    expect(landed).toContain('L1-resolved')
    // The two hunks nothing compared against each other — landed, by design.
    expect(landed).toContain('L10-from-main')
    expect(landed).toContain('L20-from-branch')
  }, 30_000)

  test('LANDS when the moved base touched a DIFFERENT file than the reviewed diff', async () => {
    const repo = await baseRepoWithModule()
    await fakeBuild(repo, 'trident/feat', 'mod.txt', lines('L1', 'L20-from-branch'))
    // Same amount of drift — a whole commit — but nowhere near the reviewed diff.
    await advanceMain(repo, 'UNRELATED.md', 'unrelated\n')

    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    await cleanupAfterMerge(localRun(repo, 'eeeeeeee', 'trident/feat'), deps)

    await git(repo, 'checkout', '-q', 'main')
    expect(await gitOut(repo, 'show', 'main:mod.txt')).toContain('L20-from-branch')
    expect(existsSync(join(repo, 'UNRELATED.md'))).toBe(true)
    expect(await status(repo)).toBe('')
    expect(await worktreeCount(repo)).toBe(1)
  }, 30_000)

  test('LANDS when the base did not move at all', async () => {
    const repo = await baseRepoWithModule()
    await fakeBuild(repo, 'trident/feat', 'mod.txt', lines('L1', 'L20-from-branch'))
    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    await cleanupAfterMerge(localRun(repo, 'ffffff11', 'trident/feat'), deps)
    await git(repo, 'checkout', '-q', 'main')
    expect(await gitOut(repo, 'show', 'main:mod.txt')).toContain('L20-from-branch')
  }, 30_000)

  test('LANDS when the same-file drift DID conflict — the resolver, not the hold, owns that case', async () => {
    const repo = await baseRepoWithModule()
    // Both sides edit the SAME line → a real textual conflict on rebase, which the
    // bounded resolver fixes. The #542 hold must NOT pre-empt that path.
    await fakeBuild(repo, 'trident/feat', 'mod.txt', lines('L1-from-branch', 'L20'))
    await advanceMain(repo, 'mod.txt', lines('L1-from-main', 'L20'))

    const resolve = async (input: { repo_path: string; conflicted_files: string[] }) => {
      for (const f of input.conflicted_files) {
        writeFileSync(join(input.repo_path, f), lines('L1-resolved', 'L20'))
        await git(input.repo_path, 'add', f)
      }
      return { resolved: true as const }
    }
    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main', resolve_conflict: resolve })
    await cleanupAfterMerge(localRun(repo, 'ffffff22', 'trident/feat'), deps)

    await git(repo, 'checkout', '-q', 'main')
    expect(await gitOut(repo, 'show', 'main:mod.txt')).toContain('L1-resolved')
  }, 30_000)
})

describe('REAL git — a dirty lingering build worktree is PRESERVED (#541)', () => {
  test('mergeLocal never force-removes it: the uncommitted work survives and the merge fails loudly', async () => {
    const repo = await makeBaseRepo()
    const branch = 'trident/mid-edit'
    // A build that committed once and then DIED mid-edit: its worktree is still
    // registered on the branch and holds an untracked file that exists nowhere
    // else. This is the PR #171 state — 197 insertions that only lived here.
    const wt = join(repo, '.build-mid-edit')
    await git(repo, 'branch', branch, 'main')
    await git(repo, 'worktree', 'add', '-q', wt, branch)
    writeFileSync(join(wt, 'committed.txt'), 'landed\n')
    await git(wt, 'add', '.')
    await git(wt, ...GIT_ID, 'commit', '-q', '-m', 'build')
    writeFileSync(join(wt, 'never-committed.ts'), 'export const insertions = 197\n')

    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    // The merge cannot check the branch out (it is held by the preserved
    // worktree), so it fails — LOUDLY, which is the correct trade: an operator
    // recovers the work, and nothing was destroyed to make the merge convenient.
    const err = await cleanupAfterMerge(localRun(repo, 'dddddddd', branch), deps).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(TridentMergeError)
    // …and the failure the OPERATOR reads says trident kept their work and WHERE
    // it is — not git's raw "already checked out at <path>", which reads like a
    // trident bug and names no remedy.
    const msg = err instanceof Error ? err.message : String(err)
    expect(msg).toContain('trident PRESERVED uncommitted work')
    expect(msg).toContain(wt)
    expect(msg).toContain('re-run the merge')

    // THE POINT: the uncommitted work is still there, byte for byte.
    expect(existsSync(join(wt, 'never-committed.ts'))).toBe(true)
    expect(await Bun.file(join(wt, 'never-committed.ts')).text()).toBe(
      'export const insertions = 197\n',
    )
    // …and git still knows about the worktree + the branch (nothing was pruned
    // out from under it, nothing was `branch -D`'d).
    const list = await gitOut(repo, 'worktree', 'list', '--porcelain')
    expect(list).toContain(`worktree ${wt}`)
    expect((await gitOut(repo, 'branch', '--list', branch)).trim()).toContain(branch)
  }, 30_000)

  test('a CLEAN lingering build worktree is still freed, so the merge lands', async () => {
    const repo = await makeBaseRepo()
    const branch = 'trident/clean-linger'
    const wt = join(repo, '.build-clean-linger')
    await git(repo, 'branch', branch, 'main')
    await git(repo, 'worktree', 'add', '-q', wt, branch)
    writeFileSync(join(wt, 'clean.txt'), 'all committed\n')
    await git(wt, 'add', '.')
    await git(wt, ...GIT_ID, 'commit', '-q', '-m', 'build')

    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    await cleanupAfterMerge(localRun(repo, 'eeeeeeee', branch), deps)

    await git(repo, 'checkout', '-q', 'main')
    expect(existsSync(join(repo, 'clean.txt'))).toBe(true)
    expect(existsSync(wt)).toBe(false)
    expect(await worktreeCount(repo)).toBe(1)
  }, 30_000)

  test('a CLEAN worktree git REFUSES to remove is preserved, not reported as removed', async () => {
    // A refused removal is not a removal. The tree probes CLEAN, so the dirt gate
    // lets it through — but `git worktree remove` still declines (locked here;
    // in the wild also submodules, or the tree being dirtied in the window between
    // the probe and the call, which the plain — never `--force` — remove catches).
    // Ignoring the command result scored the survivor as removed, so the merge
    // skipped its preservation error and died three lines later on git's raw
    // "already checked out at <path>". Found by the codex cross-model reviewer.
    const repo = await makeBaseRepo()
    const branch = 'trident/locked-linger'
    const wt = join(repo, '.build-locked')
    await git(repo, 'branch', branch, 'main')
    await git(repo, 'worktree', 'add', '-q', wt, branch)
    writeFileSync(join(wt, 'clean.txt'), 'all committed\n')
    await git(wt, 'add', '.')
    await git(wt, ...GIT_ID, 'commit', '-q', '-m', 'build')
    await git(repo, 'worktree', 'lock', wt)
    // Prove the premise: the tree really is CLEAN (so this is the removal gate
    // being exercised, not the dirt gate) and git really does refuse it.
    expect((await gitOut(wt, 'status', '--porcelain', '--untracked-files=all')).trim()).toBe('')
    const refused = await spawnCapture(['git', '-C', repo, 'worktree', 'remove', wt], repo)
    expect(refused.ok).toBe(false)

    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    const err = await cleanupAfterMerge(localRun(repo, 'cccccccc', branch), deps).then(
      () => null,
      (e: unknown) => e,
    )

    // BEHAVIOUR, not bookkeeping: the merge is refused, it names the path, and the
    // tree is demonstrably still on disk and still registered with git.
    expect(err).toBeInstanceOf(TridentMergeError)
    const msg = err instanceof Error ? err.message : String(err)
    expect(msg).toContain('trident PRESERVED uncommitted work')
    expect(msg).toContain(wt)
    expect(existsSync(join(wt, 'clean.txt'))).toBe(true)
    expect(await gitOut(repo, 'worktree', 'list', '--porcelain')).toContain(`worktree ${wt}`)

    await git(repo, 'worktree', 'unlock', wt)
  }, 30_000)

  test('a leftover PLAIN DIRECTORY at the merge-worktree path never fakes preserved work', async () => {
    // `git -C <dir> status` walks UP to the enclosing repo, so an empty leftover
    // directory INSIDE the checkout reports the SHARED checkout's untracked files
    // as its own. Guarded only by existsSync, that empty dir looked like precious
    // work and made every merge for this run throw "refusing to reuse".
    const repo = await makeBaseRepo()
    const branch = 'trident/plain-dir'
    await fakeBuild(repo, branch, 'feature.txt', 'shipped\n')
    const run = localRun(repo, 'ffffffff', branch)
    const wt = run.worktree as string
    mkdirSync(wt, { recursive: true })
    // Untracked dirt in the SHARED checkout — what the plain dir would inherit.
    writeFileSync(join(repo, 'operator-scratch.txt'), 'the human is mid-edit\n')
    // Prove the premise (this is why the guard exists, not just that it is there).
    expect((await gitOut(wt, 'status', '--porcelain', '--untracked-files=all')).trim()).not.toBe('')

    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    await cleanupAfterMerge(run, deps)

    await git(repo, 'checkout', '-q', 'main')
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true)
    // The operator's real scratch file in the shared checkout was never touched.
    expect(existsSync(join(repo, 'operator-scratch.txt'))).toBe(true)
  }, 30_000)
})
