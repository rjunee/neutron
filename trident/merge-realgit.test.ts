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
 *      repo PRISTINE (the failed rebase happened in the throwaway worktree).
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnCapture } from './git-mode.ts'
import { cleanupAfterMerge } from './git-mode.ts'
import { buildMergeCleanupDeps, runWorktreePath, TridentMergeConflictEscalation } from './merge.ts'
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
  test('a hard rebase conflict escalates a plain question AND leaves the shared checkout PRISTINE', async () => {
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

    // THE KEY INVARIANT: the shared base repo is PRISTINE despite the failed rebase
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
