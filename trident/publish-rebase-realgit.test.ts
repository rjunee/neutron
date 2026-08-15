/**
 * @neutronai/trident — the REAL-git guard for the Plan card "A build must rebase onto main
 * before review (a stale branch is not a rejected build)".
 *
 * This file exists because the two acceptance criteria that matter most are the two easiest to
 * FAKE:
 *   (a) "a branch behind main rebases" is faked with a branch that is already up to date — the
 *       rebase is a no-op and the test passes whether or not the code does anything. So here the
 *       branch is cut, `main` is MOVED by a real intervening commit afterwards, and the test
 *       PROVES the branch is behind (`merge-base --is-ancestor` refusing, evaluated in a FULL
 *       clone — never in the shallow one, which cannot be trusted to answer).
 *   (d) "it works on a shallow checkout" is faked on a normal clone, where the boundary that
 *       breaks `merge-base` simply is not there. So the build checkout here is a genuine
 *       `git clone --depth=1 file://…` and the test ASSERTS `.git/shallow` exists before it
 *       exercises anything. The `file://` URL is MANDATORY: a plain-path local clone silently
 *       IGNORES `--depth` and the whole test becomes the fake it is here to prevent.
 * The shallow boundary of the shared build checkout is governance #574/#571.
 *
 * Also proven against real git rather than a stubbed host:
 *   (b) a genuine content conflict with NO resolver configured is an ATTENTION state naming the
 *       path — `TridentRebaseConflict`, never `REQUEST_CHANGES`, branch ref unmoved, scratch
 *       worktree gone. And with a CONFIGURED resolver the same conflict is resolved IN the scratch
 *       worktree against real marker-bearing files, committed, and the branch moved by the
 *       unchanged compare-and-swap.
 *   (c) the re-push uses `--force-with-lease` pinned to an OBSERVED sha, so a branch a third party
 *       genuinely advanced REFUSES the push instead of destroying their commit — asserted against
 *       a real remote, not a fake host.
 *
 * NOTHING here runs `git rebase`: the function under test must do all the git work itself.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnCapture } from './git-mode.ts'
import { type MergeConflictResolver } from './merge.ts'
import { rebaseOntoObservedBase, TridentRebaseConflict } from './orchestrator.ts'
import type { TridentRun } from './store.ts'

const GIT_ID = ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false']
const BRANCH = 'trident/card-realgit'
const created: string[] = []

async function git(repo: string, ...args: string[]): Promise<void> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
}

async function gitOut(repo: string, ...args: string[]): Promise<string> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  return res.stdout
}

/** CI runners have NO ambient git identity (dev machines do). Every non-bare repo gets one. */
async function identify(repo: string): Promise<void> {
  await git(repo, 'config', 'user.email', 'trident-test@neutron.local')
  await git(repo, 'config', 'user.name', 'Trident Test')
}

function scratch(checkout: string, name: string): string {
  return join(checkout, '.trident-worktrees', `rebase-${name}`)
}

/** The sha origin currently holds for `ref`, read the way the lease reads it. */
async function observeRemote(repo: string, ref: string): Promise<string> {
  const res = await spawnCapture(['git', '-C', repo, 'ls-remote', '--heads', 'origin', ref], repo)
  return res.stdout.trim().split(/\s+/)[0] ?? ''
}

/** The EXACT push `publishBuiltCommit` issues: a lease pinned to an observed sha. */
async function leasePush(repo: string, branch: string, expected: string) {
  return spawnCapture(
    [
      'git',
      '-C',
      repo,
      'push',
      `--force-with-lease=refs/heads/${branch}:${expected}`,
      'origin',
      `refs/heads/${branch}:refs/heads/${branch}`,
    ],
    repo,
  )
}

interface World {
  root: string
  origin: string
  author: string
  checkout: string
  branch: string
  oldMainTip: string
  newMainTip: string
  branchTip: string
}

/**
 * A real origin, a real full author clone, and a real SHALLOW build checkout holding a branch
 * that is genuinely behind a `main` which moved after the branch was cut.
 */
async function seedWorld(opts: { conflicting: boolean }): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'trident-rebase-'))
  created.push(root)
  const origin = join(root, 'origin.git')
  const author = join(root, 'author')
  const checkout = join(root, 'checkout')

  // 1. The remote.
  const init = await spawnCapture(['git', 'init', '--bare', '-q', '--initial-branch=main', origin], root)
  if (!init.ok) throw new Error(`bare init failed: ${init.stderr}`)

  // 2. The author's FULL repo. (`git clone` of an empty bare repo leaves no usable branch, so the
  //    first history is authored locally and pushed.)
  const authorInit = await spawnCapture(['git', 'init', '-q', '--initial-branch=main', author], root)
  if (!authorInit.ok) throw new Error(`author init failed: ${authorInit.stderr}`)
  await identify(author)
  await git(author, 'remote', 'add', 'origin', `file://${origin}`)
  writeFileSync(join(author, 'README.md'), 'base\n')
  writeFileSync(join(author, 'lib.txt'), 'line1\nline2\nline3\n')
  await git(author, 'add', '.')
  await git(author, ...GIT_ID, 'commit', '-q', '-m', 'init')
  await git(author, 'push', '-q', 'origin', 'main')
  const oldMainTip = (await gitOut(author, 'rev-parse', 'HEAD')).trim()

  // 3. The build checkout — SHALLOW, exactly like the shared one (#574/#571).
  const clone = await spawnCapture(['git', 'clone', '-q', '--depth=1', `file://${origin}`, checkout], root)
  if (!clone.ok) throw new Error(`shallow clone failed: ${clone.stderr}`)
  // THE ANTI-FAKE GUARD FOR (d): without this boundary the test proves nothing about the
  // environment this code actually runs in.
  expect(existsSync(join(checkout, '.git', 'shallow'))).toBe(true)
  await identify(checkout)

  // 4. The Forge build: a branch cut off main, committed in a throwaway worktree that is then
  //    removed — the exact state the inner workflow leaves behind.
  const tmp = join(checkout, `.build-${BRANCH.replace(/\W/g, '_')}`)
  await git(checkout, 'branch', BRANCH, 'main')
  await git(checkout, 'worktree', 'add', '-q', tmp, BRANCH)
  if (opts.conflicting) {
    writeFileSync(join(tmp, 'lib.txt'), 'line1\nline2-from-branch\nline3\n')
  } else {
    writeFileSync(join(tmp, 'feature.txt'), 'feature\n')
  }
  await git(tmp, 'add', '.')
  await git(tmp, ...GIT_ID, 'commit', '-q', '-m', `build ${BRANCH}`)
  await git(checkout, 'worktree', 'remove', '--force', tmp)
  const branchTip = (await gitOut(checkout, 'rev-parse', `refs/heads/${BRANCH}`)).trim()
  await git(checkout, 'push', '-q', 'origin', `refs/heads/${BRANCH}:refs/heads/${BRANCH}`)

  // 5. THE ANTI-FAKE SEED FOR (a): `main` moves AFTER the branch was cut.
  if (opts.conflicting) {
    writeFileSync(join(author, 'lib.txt'), 'line1\nline2-from-main\nline3\n')
  } else {
    writeFileSync(join(author, 'docs.txt'), 'intervening\n')
  }
  await git(author, 'add', '.')
  await git(author, ...GIT_ID, 'commit', '-q', '-m', 'intervening main commit')
  await git(author, 'push', '-q', 'origin', 'main')
  const newMainTip = (await gitOut(author, 'rev-parse', 'HEAD')).trim()

  // 6. PROVE the branch is behind — in the FULL repo, because the shallow one cannot be trusted
  //    to answer. If this ever passes, a no-op rebase would satisfy the suite and the suite is a lie.
  await git(author, 'fetch', '-q', 'origin', BRANCH)
  const behind = await spawnCapture(
    ['git', '-C', author, 'merge-base', '--is-ancestor', newMainTip, 'FETCH_HEAD'],
    author,
  )
  expect(behind.ok).toBe(false)

  return { root, origin, author, checkout, branch: BRANCH, oldMainTip, newMainTip, branchTip }
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

describe('REAL git + REAL shallow — the publish-time rebase onto main', () => {
  test('a branch behind main is replayed onto main OBSERVED tip, re-pushed under a lease, and reads MERGEABLE (acceptance a + d)', async () => {
    const world = await seedWorld({ conflicting: false })
    const scratchDir = scratch(world.checkout, 't1')

    const res = await rebaseOntoObservedBase(spawnCapture, world.checkout, world.branch, 'main', null, scratchDir)

    // A NO-OP CANNOT PASS THIS: the branch was genuinely behind, so the head must have moved.
    expect(res.rebased).toBe(true)
    expect(res.head).not.toBe(world.branchTip)
    // The compare-and-swap actually moved the ref (not just returned a sha).
    expect((await gitOut(world.checkout, 'rev-parse', `refs/heads/${world.branch}`)).trim()).toBe(res.head)
    // The throwaway worktree is gone — the shared checkout is left clean for the other lanes.
    expect(existsSync(scratchDir)).toBe(false)

    // THE REPLAYED TREE HOLDS BOTH SIDES: the branch's file AND main's intervening file. A rebase
    // that dropped either would still be "rebased: true" — this is what makes it a real rebase.
    const tree = await gitOut(world.checkout, 'ls-tree', '--name-only', res.head)
    expect(tree).toContain('feature.txt')
    expect(tree).toContain('docs.txt')
    expect(tree).toContain('README.md')

    // The re-push, in the EXACT pinned-lease form `publishBuiltCommit` uses.
    const expected = await observeRemote(world.checkout, `refs/heads/${world.branch}`)
    expect(expected).toBe(world.branchTip)
    const pushed = await leasePush(world.checkout, world.branch, expected)
    expect(pushed.ok).toBe(true)

    // THE MERGEABLE FACT the readiness probe will read — proven in the FULL repo, where
    // `merge-base` is honest.
    await git(world.author, 'fetch', '-q', 'origin', world.branch)
    const contains = await spawnCapture(
      ['git', '-C', world.author, 'merge-base', '--is-ancestor', world.newMainTip, 'FETCH_HEAD'],
      world.author,
    )
    expect(contains.ok).toBe(true)

    // IDEMPOTENCE: a second publish of an already-rebased branch is a no-op, not a second squash.
    const again = await rebaseOntoObservedBase(
      spawnCapture,
      world.checkout,
      world.branch,
      'main',
      null,
      scratch(world.checkout, 't1b'),
    )
    expect(again.rebased).toBe(false)
    expect(again.head).toBe(res.head)
    expect((await gitOut(world.checkout, 'rev-parse', `refs/heads/${world.branch}`)).trim()).toBe(res.head)
  }, 60_000)

  test('a genuine conflict with NO resolver configured is an ATTENTION state naming the path — never REQUEST_CHANGES (acceptance b)', async () => {
    const world = await seedWorld({ conflicting: true })
    const scratchDir = scratch(world.checkout, 't3')

    let caught: unknown = null
    try {
      await rebaseOntoObservedBase(spawnCapture, world.checkout, world.branch, 'main', null, scratchDir)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TridentRebaseConflict)
    const err = caught as TridentRebaseConflict
    expect(err.paths).toContain('lib.txt')
    expect(err.message.startsWith('REBASE CONFLICT — needs attention:')).toBe(true)
    expect(err.message).toContain('lib.txt')
    // A mergeability fact is NOT a verdict on the code.
    expect(err.message.includes('REQUEST_CHANGES')).toBe(false)

    // NOTHING MOVED AND NOTHING LEAKED: the branch is untouched and the shared checkout has no
    // half-applied worktree left in it.
    expect((await gitOut(world.checkout, 'rev-parse', `refs/heads/${world.branch}`)).trim()).toBe(world.branchTip)
    expect(existsSync(scratchDir)).toBe(false)
    const worktrees = (await gitOut(world.checkout, 'worktree', 'list')).trim().split(/\n/).filter((l) => l !== '')
    expect(worktrees.length).toBe(1)
  }, 60_000)

  test('a configured resolver resolves a REAL conflict in the scratch worktree; the resolution commits and the CAS moves the branch', async () => {
    const world = await seedWorld({ conflicting: true })
    const scratchDir = scratch(world.checkout, 't5')

    // The publish path only forwards `run` to the resolver seam; no store row exists in this
    // real-git world, so a minimal cast stands in for it.
    const run = {
      id: 'realgit-resolve',
      slug: 'realgit',
      repo_path: world.checkout,
      branch: world.branch,
      merge_mode: 'pr',
    } as unknown as TridentRun

    const RESOLUTION = 'line1\nline2-merged-by-resolver\nline3\n'
    let calls = 0
    const resolve_conflict: MergeConflictResolver = async (input) => {
      calls += 1
      expect(input.repo_path).toBe(scratchDir)
      expect(input.conflicted_files).toEqual(['lib.txt'])

      // THE ANTI-FAKE GUARD: the markers are REAL, from a REAL 3-way apply, not synthesized here.
      const raw = readFileSync(join(input.repo_path, 'lib.txt'), 'utf8')
      expect(raw).toContain('<<<<<<<')
      expect(raw).toContain('line2-from-branch')
      expect(raw).toContain('line2-from-main')

      writeFileSync(join(input.repo_path, 'lib.txt'), RESOLUTION)
      await git(input.repo_path, 'add', 'lib.txt')
      return { resolved: true }
    }

    const res = await rebaseOntoObservedBase(spawnCapture, world.checkout, world.branch, 'main', null, scratchDir, {
      run,
      resolve_conflict,
    })

    expect(calls).toBe(1)
    expect(res.rebased).toBe(true)
    expect(res.head).not.toBe(world.branchTip)

    // The compare-and-swap really moved the ref.
    expect((await gitOut(world.checkout, 'rev-parse', `refs/heads/${world.branch}`)).trim()).toBe(res.head)

    // The committed tree holds the RESOLUTION and neither side's text. `spawnCapture` TRIMS
    // output, so compare trimmed to trimmed.
    const merged = await gitOut(world.checkout, 'show', `${res.head}:lib.txt`)
    expect(merged.trim()).toBe(RESOLUTION.trim())
    expect(merged).not.toContain('<<<<<<<')

    // The replay sits ON the moved main.
    expect((await gitOut(world.checkout, 'rev-parse', `${res.head}^`)).trim()).toBe(world.newMainTip)

    expect(existsSync(scratchDir)).toBe(false)
    const worktrees = (await gitOut(world.checkout, 'worktree', 'list')).trim().split(/\n/).filter((l) => l !== '')
    expect(worktrees.length).toBe(1)

    // Criterion 4 (a resolved conflict still faces the full review gate) is proven in the
    // stub-host suite (`trident/orchestrator.test.ts`, second-fire test) — this real-git suite
    // exercises `rebaseOntoObservedBase` directly, below the orchestrator.
  }, 60_000)

  test('a resolver that DECLINES leaves a REAL conflict an attention state — branch unmoved, scratch worktree gone', async () => {
    const world = await seedWorld({ conflicting: true })
    const scratchDir = scratch(world.checkout, 't6')

    const run = {
      id: 'realgit-decline',
      slug: 'realgit',
      repo_path: world.checkout,
      branch: world.branch,
      merge_mode: 'pr',
    } as unknown as TridentRun

    let calls = 0
    const resolve_conflict: MergeConflictResolver = async (input) => {
      calls += 1
      const raw = readFileSync(join(input.repo_path, 'lib.txt'), 'utf8')
      expect(raw).toContain('<<<<<<<')
      return { resolved: false, question: 'which line2 wins' }
    }

    let caught: unknown = null
    try {
      await rebaseOntoObservedBase(spawnCapture, world.checkout, world.branch, 'main', null, scratchDir, {
        run,
        resolve_conflict,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TridentRebaseConflict)
    const err = caught as TridentRebaseConflict
    expect(err.paths).toContain('lib.txt')
    expect(err.message.startsWith('REBASE CONFLICT — needs attention:')).toBe(true)
    // The attention state keeps its OWN message — the resolver's decline reason is not folded in.
    expect(err.message.includes('REQUEST_CHANGES')).toBe(false)
    expect(err.message.includes('which line2 wins')).toBe(false)

    expect(calls).toBe(1)
    expect((await gitOut(world.checkout, 'rev-parse', `refs/heads/${world.branch}`)).trim()).toBe(world.branchTip)
    expect(existsSync(scratchDir)).toBe(false)
    const worktrees = (await gitOut(world.checkout, 'worktree', 'list')).trim().split(/\n/).filter((l) => l !== '')
    expect(worktrees.length).toBe(1)
  }, 60_000)

  test('a branch a third party advanced REFUSES the pinned lease push instead of overwriting it (acceptance c, real remote)', async () => {
    const world = await seedWorld({ conflicting: false })

    // A genuinely divergent head to push.
    const res = await rebaseOntoObservedBase(
      spawnCapture,
      world.checkout,
      world.branch,
      'main',
      null,
      scratch(world.checkout, 't4'),
    )
    expect(res.rebased).toBe(true)

    // The lease is pinned to what we OBSERVED here, BEFORE the third party exists.
    const expected = await observeRemote(world.checkout, `refs/heads/${world.branch}`)
    expect(expected).toBe(world.branchTip)

    // THE THIRD PARTY: a separate clone advances the branch on the real remote.
    const thirdparty = join(world.root, 'thirdparty')
    const cloned = await spawnCapture(['git', 'clone', '-q', `file://${world.origin}`, thirdparty], world.root)
    expect(cloned.ok).toBe(true)
    await identify(thirdparty)
    await git(thirdparty, 'fetch', '-q', 'origin', world.branch)
    await git(thirdparty, 'checkout', '-q', '-b', 'tp', 'FETCH_HEAD')
    writeFileSync(join(thirdparty, 'theirs.txt'), 'theirs\n')
    await git(thirdparty, 'add', '.')
    await git(thirdparty, ...GIT_ID, 'commit', '-q', '-m', 'third party work')
    await git(thirdparty, 'push', '-q', 'origin', `tp:refs/heads/${world.branch}`)
    const theirsTip = (await gitOut(thirdparty, 'rev-parse', 'HEAD')).trim()

    // The lease now certifies a state that no longer holds → REFUSED, in git's own words.
    const pushed = await leasePush(world.checkout, world.branch, expected)
    expect(pushed.ok).toBe(false)
    expect(`${pushed.stderr}${pushed.stdout}`).toMatch(/stale info|rejected/)

    // AND THEIR WORK SURVIVED — the lease refused rather than overwrote.
    expect(await observeRemote(world.author, `refs/heads/${world.branch}`)).toBe(theirsTip)
  }, 60_000)
})
