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
  conflictEvidence,
  truncationLog,
  collectionBudgetForTests,
  runWorktreePath,
  worktreeFingerprint,
  TridentBaseDriftHold,
  TridentMergeConflictEscalation,
  TridentMergeError,
} from './merge.ts'
import { ARBITER_PROMPT_BYTES_MAX, arbiterPrompt } from './arbiter-prompt.ts'
import type { TridentRun } from './store.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'

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

/**
 * WHICH STAGES THE INDEX ACTUALLY HOLDS for one path, ascending.
 *
 * #541 round 35. Both modify/delete fixtures asserted their own premise with
 * `expect(stages).not.toContain('\t2\t')` — AND THAT STRING CANNOT OCCUR. Real git emits
 * `<mode> <sha> <stage>\t<path>`, so the stage digit is preceded by a SPACE and followed by the
 * tab; measured directly against a modify/delete conflict in a scratch repo:
 *
 *   100644 df967b96… 1\tREADME.md
 *   100644 10f0759f… 3\tREADME.md
 *
 * The assertion passed for every index, including an index with a stage 2 in it, so the comment
 * above it — "the premise, asserted rather than assumed" — described something the code did not
 * do. AN ABSENCE ASSERTION THAT CAN NEVER FIRE IS INDISTINGUISHABLE FROM A PASSING ONE, which is
 * the subject of this entire branch, here in a test written to keep a fixture honest.
 *
 * So the field is PARSED, and callers assert the stages they expect to SURVIVE rather than only
 * the one they expect absent: `[1, 3]` is a claim a broken fixture fails, `not.toContain` was a
 * claim nothing could fail.
 */
function unmergedStages(out: string): number[] {
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => Number(/^[0-7]{6} [0-9a-f]{40} ([123])\t/.exec(line)?.[1] ?? NaN))
    .sort((a, b) => a - b)
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
  return makeTridentRun({
    id,
    slug: branch,
    project_slug: 'proj',
    phase: 'done',
    branch,
    subagent_run_id: null,
    subagent_status: 'completed',
    repo_path: repo,
    worktree: runWorktreePath(repo, { id, slug: branch }),
    task: `build ${branch}`,
    inner_checkpoint: 'argus-approved',
    inner_verdict: 'APPROVE',
  })
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

describe('REAL git — the gate works on a SHALLOW checkout instead of holding everything', () => {
  /** As above: two edited regions far enough apart that git reconciles them silently. */
  const lines = (mark1: string, mark20: string): string =>
    Array.from({ length: 20 }, (_, i) => (i === 0 ? mark1 : i === 19 ? mark20 : `L${i + 1}`)).join('\n') + '\n'

  /**
   * An `origin` whose fork point sits BELOW a depth-1 boundary, plus a
   * `--depth=1` clone of it — the shape of a CI checkout, and the shape of the
   * repository trident itself merges from.
   *
   * The clone is where the merge runs. `main` and the branch each arrive with
   * exactly one commit and NO shared ancestor in the object store, which is what
   * makes `git merge-base` come back empty.
   */
  async function shallowCloneOf(driftFile: string, driftContent: string): Promise<string> {
    const origin = await makeBaseRepo()
    writeFileSync(join(origin, 'mod.txt'), lines('L1', 'L20'))
    await git(origin, 'add', '.')
    await git(origin, ...GIT_ID, 'commit', '-q', '-m', 'add mod') // ← the fork point
    await fakeBuild(origin, 'trident/feat', 'mod.txt', lines('L1', 'L20-from-branch'))
    // The base moves AFTER the review, so the fork point is now history.
    await git(origin, 'checkout', '-q', 'main')
    writeFileSync(join(origin, driftFile), driftContent)
    await git(origin, 'add', '.')
    await git(origin, ...GIT_ID, 'commit', '-q', '-m', `main moves ${driftFile}`)

    const clone = mkdtempSync(join(tmpdir(), 'trident-shallow-'))
    created.push(clone)
    rmSync(clone, { recursive: true, force: true })
    // `file://` is load-bearing: git IGNORES --depth for a plain-path local clone.
    const cloned = await spawnCapture(
      ['git', 'clone', '-q', '--depth', '1', '--no-single-branch', `file://${origin}`, clone],
      tmpdir(),
    )
    if (!cloned.ok) throw new Error(`clone failed: ${cloned.stderr}`)
    await git(clone, 'config', 'user.email', 'trident-test@neutron.local')
    await git(clone, 'config', 'user.name', 'Trident Test')
    // The merge scores the LOCAL branch ref, as a build workspace would have it.
    await git(clone, 'branch', 'trident/feat', 'origin/trident/feat')
    return clone
  }

  test('a shallow clone LANDS an unrelated-drift merge — it does not hold every merge forever', async () => {
    const repo = await shallowCloneOf('UNRELATED.md', 'unrelated\n')

    // PROVE THE PREMISE on the real artifact, before trusting any verdict about
    // it: this checkout really is shallow, and git really cannot name a fork
    // point here. That empty answer is what used to read as "unassessable" and
    // hold — in BOTH modes, on every merge, with a message saying a re-run could
    // not clear it.
    expect((await gitOut(repo, 'rev-parse', '--is-shallow-repository')).trim()).toBe('true')
    const forkProbe = await spawnCapture(['git', '-C', repo, 'merge-base', 'main', 'trident/feat'], repo)
    expect(forkProbe.ok).toBe(false)
    expect(forkProbe.stdout.trim()).toBe('')

    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    await cleanupAfterMerge(localRun(repo, 'aaaa5501', 'trident/feat'), deps)

    // BEHAVIOUR: the merge LANDED (the drift was in another file), and it landed
    // because the missing history was fetched — not because the gate was skipped.
    await git(repo, 'checkout', '-q', 'main')
    expect(await gitOut(repo, 'show', 'main:mod.txt')).toContain('L20-from-branch')
    expect((await gitOut(repo, 'rev-parse', '--is-shallow-repository')).trim()).toBe('false')
    expect(await status(repo)).toBe('')
    expect(await worktreeCount(repo)).toBe(1)
  }, 60_000)

  test('deepening did not disarm the gate: the SAME shallow clone still HOLDS a real overlap', async () => {
    // The complement, and the one that matters: making the shallow case
    // assessable must not be a way of making it always-pass. Same clone shape,
    // but now the moved base edits the very file the reviewed diff edits, with
    // no textual conflict to catch it.
    const repo = await shallowCloneOf('mod.txt', lines('L1-from-main', 'L20'))
    expect((await gitOut(repo, 'rev-parse', '--is-shallow-repository')).trim()).toBe('true')
    const mainBeforeMerge = await gitOut(repo, 'rev-parse', 'main')
    const reviewedTip = await gitOut(repo, 'rev-parse', 'trident/feat')

    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    const held = (await cleanupAfterMerge(localRun(repo, 'aaaa5502', 'trident/feat'), deps).catch(
      (e: unknown) => e,
    )) as TridentBaseDriftHold
    expect(held).toBeInstanceOf(TridentBaseDriftHold)
    expect(held.detail.silent_overlap).toEqual(['mod.txt'])
    // The fork point it found is a REAL commit — the one below the old boundary —
    // not a fabricated stand-in for history it could not see.
    expect(held.detail.review_base_sha).not.toBeNull()
    expect(held.detail.review_base_sha).not.toBe(held.detail.current_base_sha)
    // …and nothing landed.
    await git(repo, 'checkout', '-q', 'main')
    expect(await gitOut(repo, 'rev-parse', 'main')).toBe(mainBeforeMerge)
    expect(await gitOut(repo, 'show', 'main:mod.txt')).not.toContain('L20-from-branch')
    expect(await gitOut(repo, 'rev-parse', 'trident/feat')).toBe(reviewedTip)
  }, 60_000)
})

describe('REAL git — a FAILED land puts the branch ref back, so the next attempt still sees the drift', () => {
  test('the ref returns to the reviewed commit when `git merge` refuses at the land step', async () => {
    // THE FAIL-OPEN THIS CLOSES. The rebase moves the SHARED ref
    // `refs/heads/<branch>` onto the base tip. Only the HOLD path used to put it
    // back, so any other exit between the rebase and a successful land left the
    // branch sitting on the tip — and a fork point equal to the tip reads as
    // "nothing drifted", permanently, for that branch. The damage is invisible
    // by construction (the evidence is what gets destroyed), so this asserts on
    // the evidence itself: the ref, and the fork point git derives from it.
    const repo = await makeBaseRepo()
    writeFileSync(join(repo, 'mod.txt'), 'base\n')
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'add mod')
    const forkPoint = (await gitOut(repo, 'rev-parse', 'main')).trim()
    // The reviewed build adds a NEW file...
    await fakeBuild(repo, 'trident/feat', 'new.txt', 'from the build\n')
    const reviewedTip = (await gitOut(repo, 'rev-parse', 'trident/feat')).trim()
    // ...the base then moves elsewhere (drift, but no overlap → the gate lets it
    // through to the land, which is the only way to reach the failure below)...
    await git(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'UNRELATED.md'), 'unrelated\n')
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main moves')
    const mainBeforeMerge = (await gitOut(repo, 'rev-parse', 'main')).trim()
    // ...and the shared checkout holds an UNTRACKED `new.txt`, which makes the
    // real `git merge --no-ff` in step (3) refuse. A genuine git failure, not a
    // stubbed one.
    writeFileSync(join(repo, 'new.txt'), 'somebody else was here\n')

    const deps = buildMergeCleanupDeps(spawnCapture, { base_branch: 'main' })
    const err = await cleanupAfterMerge(localRun(repo, 'bbbb7701', 'trident/feat'), deps).then(
      () => null,
      (e: unknown) => e,
    )
    // The land really did fail (otherwise this test proves nothing).
    expect(err).toBeInstanceOf(TridentMergeError)
    expect((await gitOut(repo, 'rev-parse', 'main')).trim()).toBe(mainBeforeMerge)

    // THE INVARIANT: the branch is back on the commit the review read, and the
    // fork point is the pre-drift commit again — NOT main's tip, which is what
    // a left-behind rebase would have made it.
    expect((await gitOut(repo, 'rev-parse', 'trident/feat')).trim()).toBe(reviewedTip)
    const fork = await spawnCapture(['git', '-C', repo, 'merge-base', 'main', 'trident/feat'], repo)
    expect(fork.stdout.trim()).toBe(forkPoint)
    expect(fork.stdout.trim()).not.toBe(mainBeforeMerge)

    // And the retry is not wedged: clear what blocked the land and it lands.
    rmSync(join(repo, 'new.txt'), { force: true })
    await cleanupAfterMerge(localRun(repo, 'bbbb7702', 'trident/feat'), deps)
    await git(repo, 'checkout', '-q', 'main')
    expect(await gitOut(repo, 'show', 'main:new.txt')).toContain('from the build')
    expect(await status(repo)).toBe('')
    expect(await worktreeCount(repo)).toBe(1)
    expect(noStrayWorktreeDirs(repo)).toBe(true)
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

describe('REAL git — the arbiter integrity baseline actually SEES a mutation (#541)', () => {
  /**
   * WHY THIS IS A REAL-GIT TEST. The scripted-host tests in `arbiter-wiring.test.ts`
   * prove the merge seam CONSULTS `worktreeFingerprint` and refuses a retry when the
   * value changes. None of them proves the function can see anything: they script the
   * `diff` output themselves. If the probe set were wrong — if `git diff` printed
   * nothing for an unmerged path, which is the single most important case, since a
   * conflicted file is what the arbiter is looking at — every one of those tests would
   * stay green while the guard detected nothing in production. That is the same
   * unfalsifiable shape the guard itself exists to prevent, so the probe set is
   * pinned against real git here.
   */
  test('editing a conflicted file changes the fingerprint; touching nothing leaves it identical', async () => {
    const repo = await makeBaseRepo()
    // Two incompatible edits to README.md so a rebase leaves a real `UU` path.
    await git(repo, 'branch', 'feat', 'main')
    const fwt = join(repo, '.fp-feat')
    await git(repo, 'worktree', 'add', '-q', fwt, 'feat')
    writeFileSync(join(fwt, 'README.md'), 'feat-side\n')
    await git(fwt, 'add', '.')
    await git(fwt, ...GIT_ID, 'commit', '-q', '-m', 'feat edit')
    await git(repo, 'worktree', 'remove', '--force', fwt)
    writeFileSync(join(repo, 'README.md'), 'main-side\n')
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main edit')

    await git(repo, 'checkout', '-q', 'feat')
    const reb = await spawnCapture(['git', '-C', repo, ...GIT_ID, 'rebase', 'main'], repo)
    expect(reb.ok).toBe(false)
    // A genuinely unmerged path — the state the arbiter turn is rooted in.
    expect(await gitOut(repo, 'diff', '--name-only', '--diff-filter=U')).toContain('README.md')

    const before = await worktreeFingerprint(spawnCapture, repo)
    expect(before).not.toBeNull()

    // IDEMPOTENT: a turn that only READ leaves the fingerprint identical, or the
    // guard would refuse every retry and the feature would be dead while green.
    expect(await worktreeFingerprint(spawnCapture, repo)).toBe(before)

    // AN EDIT IS SEEN — and note the status letter does NOT change (still UU), which
    // is exactly why the fingerprint hashes CONTENT and not just `status`.
    writeFileSync(join(repo, 'README.md'), 'an edit the arbiter made\n')
    const afterEdit = await worktreeFingerprint(spawnCapture, repo)
    expect(afterEdit).not.toBeNull()
    expect(afterEdit).not.toBe(before)

    // A `git add` IS SEEN TOO.
    await git(repo, 'add', 'README.md')
    const afterStage = await worktreeFingerprint(spawnCapture, repo)
    expect(afterStage).not.toBe(before)
    expect(afterStage).not.toBe(afterEdit)

    // THE STAGED PROBE, ISOLATED. The step above does not actually prove
    // `diff --cached` is pulling its weight: staging also empties the UNSTAGED diff,
    // so the change is visible to the other probe and dropping `--cached` left this
    // test green (verified by mutation). This is the case only `diff --cached` can
    // see — re-staging DIFFERENT content over an already-staged resolution. The
    // status letters do not move (`M ` before and after) and the unstaged diff is
    // empty both times; the only difference is the staged CONTENT, which is exactly
    // what an arbiter smuggling an edit into the merge would leave behind.
    const statusBeforeRestage = await gitOut(repo, 'status', '--porcelain')
    const unstagedBeforeRestage = await gitOut(repo, 'diff')
    writeFileSync(join(repo, 'README.md'), 'different staged content\n')
    await git(repo, 'add', 'README.md')
    expect(await gitOut(repo, 'status', '--porcelain')).toBe(statusBeforeRestage)
    expect(await gitOut(repo, 'diff')).toBe(unstagedBeforeRestage)
    const afterRestage = await worktreeFingerprint(spawnCapture, repo)
    expect(afterRestage).not.toBe(afterStage)

    // And a brand-new untracked file is seen (`status --untracked-files=all`).
    writeFileSync(join(repo, 'smuggled.ts'), 'export const x = 1\n')
    expect(await worktreeFingerprint(spawnCapture, repo)).not.toBe(afterRestage)

    await spawnCapture(['git', '-C', repo, 'rebase', '--abort'], repo)
  }, 30_000)

  test('a path that is not a git worktree fingerprints as null (fail-closed input)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trident-fp-nonrepo-'))
    created.push(dir)
    expect(await worktreeFingerprint(spawnCapture, dir)).toBeNull()
  }, 20_000)
})

describe('REAL git — the arbiter is actually SHOWN both sides of the conflict (#541)', () => {
  /** Length of the `| ` quote prefix, so a test can compare the CONTENT of two quoted lines. */
  const QUOTE_LEN = 2

  /**
   * WHY REAL GIT. Round 8 removed every tool from the arbiter on the stated ground that the
   * caller already supplied everything it needed. That was asserted rather than checked, and
   * it was false — the caller sent filenames and histories, not the conflict. A scripted-host
   * test cannot catch that class: it would happily confirm that whatever I chose to script
   * arrives. Only real git can say whether a diff of the two conflict stages yields the two
   * sides at all, which is the assumption the whole design rests on. (The stages were
   * addressed as `:2:<path>`/`:3:<path>` when this was written and by object id since round
   * 34; the assumption under test is the same either way, which is why this comment now
   * names the stages rather than the spelling.)
   */
  test('both sides of a real conflicted file reach the evidence, labelled and quoted', async () => {
    const repo = await makeBaseRepo()
    // Two incompatible edits to the SAME line, so a rebase leaves real stages 2 and 3.
    await git(repo, 'branch', 'feat', 'main')
    const fwt = join(repo, '.hunk-feat')
    await git(repo, 'worktree', 'add', '-q', fwt, 'feat')
    writeFileSync(join(fwt, 'README.md'), 'flush: DROP-THE-OLDEST-ENTRY\n')
    await git(fwt, 'add', '.')
    await git(fwt, ...GIT_ID, 'commit', '-q', '-m', 'feat edit')
    await git(repo, 'worktree', 'remove', '--force', fwt)
    writeFileSync(join(repo, 'README.md'), 'flush: BLOCK-UNTIL-SPACE\n')
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main edit')

    await git(repo, 'checkout', '-q', 'feat')
    const reb = await spawnCapture(['git', '-C', repo, ...GIT_ID, 'rebase', 'main'], repo)
    expect(reb.ok).toBe(false)
    expect(await gitOut(repo, 'diff', '--name-only', '--diff-filter=U')).toContain('README.md')

    const evidence = await conflictEvidence(spawnCapture, repo, { readable: true, paths: ['README.md'] }, truncationLog(), collectionBudgetForTests())
    // A SMALL CONFLICT IS SHOWN WHOLE. There is no longer a `truncated` field to assert
    // against: the two states are "complete" and "not asked" (#541 round 13).
    expect(evidence.kind).toBe('complete')
    const hunks = evidence.kind === 'complete' ? evidence.body : ''

    // BOTH SIDES ARE PRESENT — this is the assertion round 8 shipped without.
    expect(hunks).toContain('BLOCK-UNTIL-SPACE') // the base's version (`-`)
    expect(hunks).toContain('DROP-THE-OLDEST-ENTRY') // the branch's version (`+`)
    // Labelled so the judge knows which is which.
    expect(hunks).toContain('README.md')
    expect(hunks).toContain('= base')
    // EVERY line is quote-prefixed: no untrusted line begins a line of the prompt.
    for (const line of hunks.split('\n')) {
      expect(line.startsWith('| '), line.slice(0, 60)).toBe(true)
    }
    await spawnCapture(['git', '-C', repo, 'rebase', '--abort'], repo)
  }, 30_000)

  test('REAL GIT: the history render produces EXACTLY ONE record per requested commit id', async () => {
    // THE PLATFORM FACT THE PRODUCTION CHECK RESTS ON (#541 round 36). `sideHistory` now refuses
    // a render that does not return one record per oid it resolved and weighed. That equality is
    // only correct if git's framing really is one record per id, and the framing is NOT obvious:
    //
    //   raw:  'h1 subject\nbody\n\x00\nh2 subject\nbody\n\x00\n'
    //
    // git writes a newline BETWEEN entries, so `%x00` is NOT the last byte and a naive split
    // yields N+1 elements whose last is '\n'. It is `spawnCapture`'s trim of the trailing
    // newline that turns the final element into '' — the delimiter artifact the parser pops.
    // Reasoning about `--format` alone gets this wrong, which is why it is measured here rather
    // than asserted in a comment, and why `sideHistory` says so at the check.
    const repo = await makeBaseRepo()
    for (const n of [1, 2, 3]) {
      writeFileSync(join(repo, `f${n}.txt`), `${n}\n`)
      await git(repo, 'add', '.')
      await git(repo, ...GIT_ID, 'commit', '-q', '-m', `commit ${n}\n\nbody line for ${n}`)
    }
    // A commit with NO body and one whose subject could be mistaken for framing, because both
    // are shapes a real repository produces.
    await git(repo, ...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'subject only')
    await git(repo, ...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'a subject with\n\nblank lines\n\n\nin the body')

    const ids = await gitOut(repo, 'log', '--format=%H')
    const oids = ids.split('\n').map((x) => x.trim()).filter((x) => x.length > 0)
    expect(oids.length, 'the fixture really has this many commits').toBe(6)

    const res = await spawnCapture(
      ['git', '-C', repo, '-c', 'core.quotePath=false', 'log', '--no-color', '--no-decorate', '-s',
       '--format=%h %s%n%b%x00', '--no-walk=unsorted', ...oids],
      repo,
    )
    expect(res.ok).toBe(true)
    // THE EXACT PARSE `sideHistory` PERFORMS — copied in shape deliberately, because what is
    // under test is that this parse yields N for N.
    const framed = res.stdout.split('\u0000')
    while (framed.length > 0 && framed[framed.length - 1] === '') framed.pop()
    expect(framed.length, 'one record per requested oid').toBe(oids.length)
    // NOT VACUOUS: each record carries its own abbreviated sha, so these are six DISTINCT
    // commits and not one record counted six times.
    const shas = framed.map((r) => /([0-9a-f]{7,})/.exec(r)?.[1] ?? '')
    expect(new Set(shas).size, 'six distinct commits').toBe(6)
    // AND THE CONTROL ON THE PARSE ITSELF: asking for fewer ids yields fewer records, so the
    // equality tracks the request rather than being a property of any output.
    const two = await spawnCapture(
      ['git', '-C', repo, 'log', '--no-color', '--no-decorate', '-s', '--format=%h %s%n%b%x00',
       '--no-walk=unsorted', ...oids.slice(0, 2)],
      repo,
    )
    const framedTwo = two.stdout.split('\u0000')
    while (framedTwo.length > 0 && framedTwo[framedTwo.length - 1] === '') framedTwo.pop()
    expect(framedTwo.length, 'two ids in, two records out').toBe(2)
  }, 30_000)

  test('a REAL modify/delete conflict is complete evidence, and names which side exists', async () => {
    // THE FIXTURE THIS REPLACES NEVER MODELLED WHAT IT WAS NAMED FOR: it asked for
    // `never-existed.ts` in a repo with no conflict at all, so it exercised "a path the index
    // does not list" while claiming to test "a path on only one side". The two are different
    // facts — the first is unknown, the second is definite — and the old code returned the
    // same sentence for both, which is precisely why the fixture could not tell.
    //
    // Real git, measured: a modify/delete conflict carries index stages 1 and 3 only, and
    // `git diff :2:<p> :3:<p>` exits 128 on it with `fatal: path '<p>' is in the index, but
    // not at stage 2` — THE SAME OBSERVABLE AS A BROKEN READ. So this case can only be
    // established from the index, and that is what the production code now does.
    // THE FILE MUST EXIST AT THE BRANCH POINT, or there is nothing to clash: my first
    // fixture branched BEFORE the path existed, so the rebase applied cleanly and the test
    // failed on its own premise rather than on the code. Base has README.md; main deletes
    // it; the branch modifies it.
    const repo = await makeBaseRepo()
    await git(repo, 'branch', 'feat', 'main')
    const fwt = join(repo, '.one-sided')
    await git(repo, 'worktree', 'add', '-q', fwt, 'feat')
    // A DISTINCTIVE TOKEN IN THE SURVIVING SIDE, so the assertion is about CONTENT rather
    // than about the descriptive sentence — which is true whether or not the content is
    // shown, and is therefore worthless as a detector.
    writeFileSync(join(fwt, 'README.md'), 'the branch still wants this file\nKEEP-THE-FLUSH-GUARD\n')
    await git(fwt, 'add', '.')
    await git(fwt, ...GIT_ID, 'commit', '-q', '-m', 'feat edits README')
    await git(repo, 'worktree', 'remove', '--force', fwt)
    await git(repo, 'rm', '-q', 'README.md')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main deletes README')

    await git(repo, 'checkout', '-q', 'feat')
    await spawnCapture(['git', '-C', repo, ...GIT_ID, 'rebase', 'main'], repo)
    const conflicted = await gitOut(repo, 'diff', '--name-only', '--diff-filter=U')
    expect(conflicted).toContain('README.md')
    // THE PREMISE, NOW ACTUALLY ASSERTED: the index holds the merge base and the branch and
    // NOTHING FROM `main`, which is what makes this the one-sided case rather than an ordinary
    // content conflict. Stated as the whole stage set, so a fixture that stopped conflicting
    // (`[]`), or one that produced a two-sided conflict instead (`[1, 2, 3]`), fails here —
    // neither of which the old `not.toContain` could distinguish from success.
    const stages = await gitOut(repo, 'ls-files', '--unmerged', '--', 'README.md')
    expect(unmergedStages(stages), 'base and branch only — main deleted the file').toEqual([1, 3])

    const evidence = await conflictEvidence(spawnCapture, repo, { readable: true, paths: ['README.md'] }, truncationLog(), collectionBudgetForTests())
    // ESTABLISHED, so the judge is asked — refusing here would make the tier inert for every
    // modify/delete conflict.
    expect(evidence.kind).toBe('complete')
    const body = evidence.kind === 'complete' ? evidence.body : ''
    expect(body).toContain('no two-sided diff')
    // IT SAYS WHICH SIDE. The sentence this replaces could not, because it did not know
    // whether it was describing a fact or an error.
    expect(body).toMatch(/only the (BASE|BRANCH)'s version of this path exists/)
    expect(body).not.toContain('could not read')
    // AND IT SHOWS THAT SIDE — the load-bearing assertion (#541 round 17). Labelling the
    // evidence `complete` while emitting only a sentence meant the judge could grant a retry
    // on a modify/delete conflict WITHOUT SEEING THE CHANGE, under a prompt that tells it
    // nothing has been left out. The earlier version of this test asserted the marker and
    // never the blob, so it protected exactly that.
    expect(body).toContain('KEEP-THE-FLUSH-GUARD')
    // Still quoted, still not a crash, still not silence.
    expect(body.split('\n').every((l) => l.startsWith('| '))).toBe(true)
    await spawnCapture(['git', '-C', repo, 'rebase', '--abort'], repo)
  }, 30_000)

  test('a REAL BINARY conflict is never passed off as shown evidence', async () => {
    // THE FINDING TURNS ENTIRELY ON WHAT GIT EMITS, so this is real git and not a stub.
    // Verified against this repository's own PNGs before writing the fix: `git diff` between
    // two differing binary blobs EXITS 0 and prints only
    //   `Binary files a/<sha> and b/<sha> differ`
    // — no content at all. `ok && stdout.length > 0` had been standing in for "the diff is
    // readable", and a binary blob satisfies both while telling you nothing, so the judge
    // would have been handed a one-line notice under a prompt promising the conflict was
    // shown complete.
    //
    // Third variant of one sentence on this branch: AN EXIT CODE IS NOT THE EVIDENCE.
    const repo = await makeBaseRepo()
    // Two PNG-signature files differing after the header — NUL bytes early, which is exactly
    // git's own binary heuristic.
    const png = (tail: string): Buffer =>
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]), Buffer.from(tail)])
    await git(repo, 'branch', 'feat', 'main')
    const fwt = join(repo, '.bin-feat')
    await git(repo, 'worktree', 'add', '-q', fwt, 'feat')
    writeFileSync(join(fwt, 'logo.png'), png('FEAT-SIDE-PIXELS'))
    await git(fwt, 'add', '.')
    await git(fwt, ...GIT_ID, 'commit', '-q', '-m', 'feat logo')
    await git(repo, 'worktree', 'remove', '--force', fwt)
    writeFileSync(join(repo, 'logo.png'), png('MAIN-SIDE-PIXELS'))
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main logo')
    await git(repo, 'checkout', '-q', 'feat')
    await spawnCapture(['git', '-C', repo, ...GIT_ID, 'rebase', 'main'], repo)
    expect(await gitOut(repo, 'diff', '--name-only', '--diff-filter=U')).toContain('logo.png')

    // THE PREMISE, ASSERTED: git really does succeed here while producing no content. If this
    // ever stops being true the test below is measuring something else.
    const raw = await spawnCapture(
      ['git', '-C', repo, 'diff', '--no-color', ':2:logo.png', ':3:logo.png'],
      repo,
    )
    expect(raw.ok, 'git exits 0 on a binary pair').toBe(true)
    expect(raw.stdout).toContain('Binary files')
    expect(raw.stdout).not.toContain('FEAT-SIDE-PIXELS')

    const evidence = await conflictEvidence(spawnCapture, repo, { readable: true, paths: ['logo.png'] }, truncationLog(), collectionBudgetForTests())
    expect(evidence.kind).toBe('binary')
    await spawnCapture(['git', '-C', repo, 'rebase', '--abort'], repo)
  }, 30_000)

  test('a ONE-SIDED binary conflict is not laundered into pseudo-text either', async () => {
    // The surviving side of a modify/delete is read with `cat-file` and quoted, and `defang`
    // would turn a PNG's bytes into a wall of spaces — binary made to LOOK like evidence.
    // `--numstat` cannot help here (one blob, not a pair), so this uses git's own heuristic:
    // a NUL byte in the content.
    const repo = await makeBaseRepo()
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
      Buffer.from('ONLY-ON-THE-BRANCH'),
    ])
    writeFileSync(join(repo, 'art.png'), png)
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'base art')
    await git(repo, 'branch', 'feat', 'main')
    const fwt = join(repo, '.bin-one')
    await git(repo, 'worktree', 'add', '-q', fwt, 'feat')
    writeFileSync(join(fwt, 'art.png'), Buffer.concat([png, Buffer.from('-EDITED')]))
    await git(fwt, 'add', '.')
    await git(fwt, ...GIT_ID, 'commit', '-q', '-m', 'feat edits art')
    await git(repo, 'worktree', 'remove', '--force', fwt)
    await git(repo, 'rm', '-q', 'art.png')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main deletes art')
    await git(repo, 'checkout', '-q', 'feat')
    await spawnCapture(['git', '-C', repo, ...GIT_ID, 'rebase', 'main'], repo)
    // THE SAME PREMISE, THE SAME WAY: a binary modify/delete, so stage 2 is absent and the
    // other two are present. `toEqual` on the set is what makes that a falsifiable claim.
    const stages = await gitOut(repo, 'ls-files', '--unmerged', '--', 'art.png')
    expect(unmergedStages(stages), 'base and branch only — main deleted the file').toEqual([1, 3])

    const evidence = await conflictEvidence(spawnCapture, repo, { readable: true, paths: ['art.png'] }, truncationLog(), collectionBudgetForTests())
    expect(evidence.kind).toBe('binary')
    await spawnCapture(['git', '-C', repo, 'rebase', '--abort'], repo)
  }, 30_000)

  test('a TEXT file whose CONTENT says "Binary files ... differ" is still shown', async () => {
    // THE CONTROL FOR THE DETECTOR, and the reason it asks `--numstat` instead of matching the
    // sentence: a text file may legitimately contain that line — this repository's own test
    // files now do. Prose-matching would classify it binary and silently stop arbitrating on
    // it, which is the same mistake as trusting the exit code, one layer up.
    const repo = await makeBaseRepo()
    await git(repo, 'branch', 'feat', 'main')
    const fwt = join(repo, '.bin-text')
    await git(repo, 'worktree', 'add', '-q', fwt, 'feat')
    writeFileSync(join(fwt, 'README.md'), 'Binary files a/x and b/y differ\nFEAT-TEXT-TOKEN\n')
    await git(fwt, 'add', '.')
    await git(fwt, ...GIT_ID, 'commit', '-q', '-m', 'feat text')
    await git(repo, 'worktree', 'remove', '--force', fwt)
    writeFileSync(join(repo, 'README.md'), 'Binary files a/x and b/y differ\nMAIN-TEXT-TOKEN\n')
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main text')
    await git(repo, 'checkout', '-q', 'feat')
    await spawnCapture(['git', '-C', repo, ...GIT_ID, 'rebase', 'main'], repo)

    const evidence = await conflictEvidence(spawnCapture, repo, { readable: true, paths: ['README.md'] }, truncationLog(), collectionBudgetForTests())
    expect(evidence.kind).toBe('complete')
    const body = evidence.kind === 'complete' ? evidence.body : ''
    expect(body).toContain('FEAT-TEXT-TOKEN')
    expect(body).toContain('MAIN-TEXT-TOKEN')
    await spawnCapture(['git', '-C', repo, 'rebase', '--abort'], repo)
  }, 30_000)

  test('A WHITESPACE-ONLY CONFLICT REACHES THE JUDGE WITH THE DISPUTED BYTES INTACT', async () => {
    // THE CASE THE OLD RENDERING ERASED ENTIRELY. Evidence lines went through `defang` (which
    // rewrites every run of \u0000-\u001f — TAB INCLUDED — to one space) and then `.trim()`.
    // A conflict whose two sides differ ONLY in indentation therefore arrived as two
    // identical-looking lines, and the judge was asked to choose between them under a sentence
    // promising nothing had been shortened. Makefiles, Python and YAML conflict about exactly
    // this.
    const repo = await makeBaseRepo()
    await git(repo, 'branch', 'feat', 'main')
    const fwt = join(repo, '.ws-feat')
    await git(repo, 'worktree', 'add', '-q', fwt, 'feat')
    // Tab-indented (the Makefile spelling).
    // EACH SIDE ALSO CHANGES A DISTINCT LINE, and that is load-bearing rather than decoration:
    // `git patch-id` IGNORES WHITESPACE, so two branches whose only difference is indentation
    // are seen as the same patch and the rebase SKIPS the commit entirely — "Successfully
    // rebased", no conflict, nothing to test. Measured while writing this. The disputed line
    // below still differs ONLY in whitespace, which is the thing under test.
    writeFileSync(join(fwt, 'README.md'), 'all:\n\tgcc -O2 main.c\ntail: FEAT\n')
    await git(fwt, 'add', '.')
    await git(fwt, ...GIT_ID, 'commit', '-q', '-m', 'feat tabs')
    await git(repo, 'worktree', 'remove', '--force', fwt)
    // Space-indented, otherwise identical.
    writeFileSync(join(repo, 'README.md'), 'all:\n    gcc -O2 main.c\ntail: MAIN\n')
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main spaces')
    await git(repo, 'checkout', '-q', 'feat')
    await spawnCapture(['git', '-C', repo, ...GIT_ID, 'rebase', 'main'], repo)
    // THE PREMISE, ASSERTED. A fixture that fails to conflict would make every assertion
    // below vacuous, and the first draft of this test did exactly that.
    expect(await gitOut(repo, 'diff', '--name-only', '--diff-filter=U')).toContain('README.md')

    const evidence = await conflictEvidence(spawnCapture, repo, { readable: true, paths: ['README.md'] }, truncationLog(), collectionBudgetForTests())
    expect(evidence.kind).toBe('complete')
    const body = evidence.kind === 'complete' ? evidence.body : ''
    // THE TAB SURVIVES. Without it the two sides are the same string.
    expect(body).toContain('\tgcc -O2 main.c')
    // And so does the space-indented side.
    expect(body).toContain('    gcc -O2 main.c')
    // The two disputed lines are DIFFERENT in the evidence — the property the old rendering
    // destroyed, asserted directly rather than inferred from the two `toContain`s above.
    const disputed = body
      .split('\n')
      .filter((l) => l.includes('gcc -O2 main.c'))
      .map((l) => l.slice(QUOTE_LEN))
    expect(disputed.length).toBeGreaterThanOrEqual(2)
    expect(new Set(disputed).size, 'both sides must not render identically').toBeGreaterThan(1)
    await spawnCapture(['git', '-C', repo, 'rebase', '--abort'], repo)
  }, 30_000)

  test('LEADING, TRAILING AND DIFF-MARKER WHITESPACE all survive rendering', async () => {
    // The unified-diff CONTEXT MARKER is a single leading space, so `.trim()` removed the one
    // character that says "this line is unchanged" — a context line ` \tcommand` arrived as
    // `| command`, indistinguishable from an added or removed line at a different indent.
    const repo = await makeBaseRepo()
    await git(repo, 'branch', 'feat', 'main')
    const fwt = join(repo, '.ws2-feat')
    await git(repo, 'worktree', 'add', '-q', fwt, 'feat')
    // A TRAILING LINE AFTER the disputed one, deliberately: `spawnCapture` trims the whole of
    // git's stdout (`git-mode.ts:1223`), so trailing whitespace on the LAST line of a diff is
    // gone before this code ever sees it. That residual is disclosed rather than papered over
    // — see the note in `quoteLine` — and this fixture keeps the whitespace under test where
    // the guarantee actually holds.
    writeFileSync(join(fwt, 'cfg.yml'), 'ctx: keep\n  indented: FEAT   \ntail: end\n')
    await git(fwt, 'add', '.')
    await git(fwt, ...GIT_ID, 'commit', '-q', '-m', 'feat cfg')
    await git(repo, 'worktree', 'remove', '--force', fwt)
    writeFileSync(join(repo, 'cfg.yml'), 'ctx: keep\n  indented: MAIN\ntail: end\n')
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main cfg')
    await git(repo, 'checkout', '-q', 'feat')
    await spawnCapture(['git', '-C', repo, ...GIT_ID, 'rebase', 'main'], repo)

    expect(await gitOut(repo, 'diff', '--name-only', '--diff-filter=U')).toContain('cfg.yml')

    const evidence = await conflictEvidence(spawnCapture, repo, { readable: true, paths: ['cfg.yml'] }, truncationLog(), collectionBudgetForTests())
    expect(evidence.kind).toBe('complete')
    const body = evidence.kind === 'complete' ? evidence.body : ''
    // Two-space indentation intact on both sides.
    expect(body).toContain('  indented: FEAT')
    expect(body).toContain('  indented: MAIN')
    // TRAILING whitespace intact — it is a real difference and a common cause of conflicts.
    expect(body).toContain('  indented: FEAT   ')
    // git's own leading marker survives: some quoted line begins with a diff marker followed
    // by the unchanged context line.
    expect(body).toMatch(/\n\| [ +-]ctx: keep/)
    await spawnCapture(['git', '-C', repo, 'rebase', '--abort'], repo)
  }, 30_000)

  test('REAL GIT: a conflict whose FINAL diff line is disputed is not judged', async () => {
    // THE BOUNDARY THE OTHER FIDELITY TESTS AVOID, and avoid for a reason: they place a line
    // AFTER the whitespace-bearing one, so the runner's trim never touches it. Here the change
    // reaches EOF, so the diff's last line IS the disputed one — and `spawnCapture` trims every
    // command's stdout (`git-mode.ts:1223`), taking that line's trailing whitespace before this
    // code can see it.
    //
    // The claim the judge reads says nothing that differs between the sides has been shortened.
    // Rather than qualify the sentence, the conflict is simply not arbitrated: the same rule
    // the rest of this function follows.
    const repo = await makeBaseRepo()
    await git(repo, 'branch', 'feat', 'main')
    const fwt = join(repo, '.eof')
    await git(repo, 'worktree', 'add', '-q', fwt, 'feat')
    // Last line of the file, differing ONLY in trailing whitespace, plus a distinct earlier
    // line so the two patches are not whitespace-identical (git's patch-id ignores whitespace).
    writeFileSync(join(fwt, 'README.md'), 'tag: FEAT\nrecipe   \n')
    await git(fwt, 'add', '.')
    await git(fwt, ...GIT_ID, 'commit', '-q', '-m', 'feat eof')
    await git(repo, 'worktree', 'remove', '--force', fwt)
    writeFileSync(join(repo, 'README.md'), 'tag: MAIN\nrecipe\n')
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main eof')
    await git(repo, 'checkout', '-q', 'feat')
    await spawnCapture(['git', '-C', repo, ...GIT_ID, 'rebase', 'main'], repo)
    expect(await gitOut(repo, 'diff', '--name-only', '--diff-filter=U')).toContain('README.md')

    // THE PREMISE, MEASURED: git really does emit a diff ending on a +/- line here, and the
    // runner really does trim its trailing whitespace away.
    const raw = await spawnCapture(
      ['git', '-C', repo, 'diff', '--no-color', ':2:README.md', ':3:README.md'],
      repo,
    )
    const lastLine = raw.stdout.split('\n').filter((l) => l.length > 0).pop() ?? ''
    expect(lastLine.startsWith('+') || lastLine.startsWith('-'), 'the diff ends on a disputed line').toBe(true)
    expect(lastLine.endsWith(' '), 'and its trailing whitespace is already gone').toBe(false)

    const evidence = await conflictEvidence(
      spawnCapture,
      repo,
      { readable: true, paths: ['README.md'] },
      truncationLog(),
      collectionBudgetForTests(),
    )
    // The evidence itself is still assembled — the loss is recorded on the truncation channel,
    // which `assembleEvidence` consults, so the refusal happens where every other one does.
    expect(evidence.kind).toBe('complete')
    await spawnCapture(['git', '-C', repo, 'rebase', '--abort'], repo)
  }, 30_000)

  test('a path the INDEX does not list as unmerged is UNKNOWN, never complete', async () => {
    // The old fixture's real subject, now named and asserted correctly. Our own two views of
    // the tree disagree — the caller says this path is conflicted, the index does not list it
    // — and a disagreement about our reading is not a fact about the conflict.
    const repo = await makeBaseRepo()
    const evidence = await conflictEvidence(spawnCapture, repo, { readable: true, paths: ['never-existed.ts'] }, truncationLog(), collectionBudgetForTests())
    expect(evidence.kind).toBe('unreadable')
    expect(evidence.kind === 'unreadable' ? evidence.why : '').toBe('not-in-index')
  }, 20_000)

  test('an ENORMOUS conflict is NOT shown in part — it is over-budget, so the judge is never asked', async () => {
    const repo = await makeBaseRepo()
    await git(repo, 'branch', 'feat', 'main')
    const fwt = join(repo, '.hunk-big')
    await git(repo, 'worktree', 'add', '-q', fwt, 'feat')
    // ~200 KB of differing content on each side of the same file.
    writeFileSync(join(fwt, 'README.md'), Array.from({ length: 4000 }, (_, k) => `feat line ${k}`).join('\n'))
    await git(fwt, 'add', '.')
    await git(fwt, ...GIT_ID, 'commit', '-q', '-m', 'feat big')
    await git(repo, 'worktree', 'remove', '--force', fwt)
    writeFileSync(join(repo, 'README.md'), Array.from({ length: 4000 }, (_, k) => `main line ${k}`).join('\n'))
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main big')
    await git(repo, 'checkout', '-q', 'feat')
    await spawnCapture(['git', '-C', repo, ...GIT_ID, 'rebase', 'main'], repo)

    const evidence = await conflictEvidence(spawnCapture, repo, { readable: true, paths: ['README.md'] }, truncationLog(), collectionBudgetForTests())
    // THE WHOLE POINT OF ROUND 13. This case used to return a 4 KiB fragment plus a notice
    // saying it was a fragment — the shape that produced five defects in five rounds, twice
    // AFTER the refactor built to make them impossible. There is now no partial value to
    // get wrong: the only thing this returns is the decision not to ask.
    expect(evidence.kind).toBe('over-budget')
    // And there is NO body and NO byte count on that arm — a number here would mean "at
    // least this much" while reading as a total, which is verbatim the round-12 defect.
    expect(Object.keys(evidence)).toEqual(['kind'])
    await spawnCapture(['git', '-C', repo, 'rebase', '--abort'], repo)
  }, 30_000)

  test('a conflict that JUST fits is still shown, so the budget is a threshold and not a wall', async () => {
    // THE OTHER DIRECTION, and it is the one that stops "escalate always" passing as a fix.
    // A test suite that only proves big conflicts escalate is satisfied by a `conflictEvidence`
    // that never returns `complete`; this pins that the budget admits real conflicts.
    const repo = await makeBaseRepo()
    await git(repo, 'branch', 'feat', 'main')
    const fwt = join(repo, '.hunk-fits')
    await git(repo, 'worktree', 'add', '-q', fwt, 'feat')
    writeFileSync(join(fwt, 'README.md'), Array.from({ length: 20 }, (_, k) => `feat line ${k}`).join('\n'))
    await git(fwt, 'add', '.')
    await git(fwt, ...GIT_ID, 'commit', '-q', '-m', 'feat modest')
    await git(repo, 'worktree', 'remove', '--force', fwt)
    writeFileSync(join(repo, 'README.md'), Array.from({ length: 20 }, (_, k) => `main line ${k}`).join('\n'))
    await git(repo, 'add', '.')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'main modest')
    await git(repo, 'checkout', '-q', 'feat')
    await spawnCapture(['git', '-C', repo, ...GIT_ID, 'rebase', 'main'], repo)

    const evidence = await conflictEvidence(spawnCapture, repo, { readable: true, paths: ['README.md'] }, truncationLog(), collectionBudgetForTests())
    expect(evidence.kind).toBe('complete')
    const body = evidence.kind === 'complete' ? evidence.body : ''
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(ARBITER_PROMPT_BYTES_MAX)
    expect(body).toContain('feat line 19')
    expect(body).toContain('main line 19')
    await spawnCapture(['git', '-C', repo, 'rebase', '--abort'], repo)
  }, 30_000)
})
