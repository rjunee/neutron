import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnCapture } from './git-mode.ts'
import { changedFilesOnBranch, resolveMergeHeadSha, runMutationProofGate } from './mutation-prover.ts'

/**
 * THE FETCH CONTRACT AND THE HOSTILE NAME, against REAL git.
 *
 * The mocked tests can only prove which argv the resolver BUILDS. What they
 * cannot prove is that the argv WORKS — that after the fetch,
 * `refs/remotes/origin/<branch>` actually names the commit that is on origin —
 * nor that a hostile name changes NOTHING in the repository. Review round 3
 * deleted the argv scan that stood in for the second claim: it scanned argv for
 * the literal strings `branch` and `update-ref`, so it passed while
 * `--upload-pack=…` was running a program and `x:refs/heads/y` was writing a
 * local branch. A test that cannot fail on the bug proves nothing.
 *
 * So the assertions here are REPOSITORY STATE: the resolved sha, the
 * `for-each-ref` snapshot before and after, and whether the marker file the
 * `--upload-pack` payload would have written exists.
 */

const GIT_ID = ['-c', 'user.name=Test Setup', '-c', 'user.email=setup@neutron.local', '-c', 'commit.gpgsign=false']
const BRANCH = 'trident/head-resolves-without-a-local-ref'
const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const result = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

interface World {
  root: string
  origin: string
  /** A clone whose remote has NO fetch refspec at all. */
  consumer: string
  /** The sha origin/<BRANCH> pointed at when the consumer last fetched. */
  stale: string
  /** The sha origin/<BRANCH> points at NOW. */
  current: string
}

async function seedWorld(label: string): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), `mutation-prover-realgit-${label}-`))
  created.push(root)
  const origin = join(root, 'origin.git')
  const author = join(root, 'author')
  const consumer = join(root, 'consumer')

  await spawnCapture(['git', 'init', '--bare', '-q', '--initial-branch=main', origin], root)
  await spawnCapture(['git', 'init', '-q', '--initial-branch=main', author], root)
  writeFileSync(join(author, 'a.txt'), 'base\n')
  await git(author, 'add', '-A')
  await git(author, ...GIT_ID, 'commit', '-q', '-m', 'base')
  await git(author, 'remote', 'add', 'origin', origin)
  await git(author, 'push', '-q', 'origin', 'main')
  await git(author, 'switch', '-q', '-c', BRANCH)
  writeFileSync(join(author, 'a.txt'), 'reviewed\n')
  await git(author, 'add', '-A')
  await git(author, ...GIT_ID, 'commit', '-q', '-m', 'the reviewed commit')
  await git(author, 'push', '-q', 'origin', BRANCH)
  const stale = await git(author, 'rev-parse', 'HEAD')

  const cloned = await spawnCapture(['git', 'clone', '-q', origin, consumer], root)
  if (!cloned.ok) throw new Error(`clone failed: ${cloned.stderr}`)
  await git(consumer, 'fetch', '-q', 'origin', BRANCH)
  await git(consumer, 'switch', '-q', '--detach', 'origin/main')
  // THE CLONE SHAPE UNDER TEST: no fetch refspec, so nothing auto-updates
  // `refs/remotes/origin/*` any more. The tracking ref is frozen at `stale`.
  await git(consumer, 'config', '--unset-all', 'remote.origin.fetch')

  // Origin advances (a rebase/force-push, or simply a later commit).
  writeFileSync(join(author, 'a.txt'), 'reviewed, then amended\n')
  await git(author, 'add', '-A')
  await git(author, ...GIT_ID, 'commit', '-q', '-m', 'the commit that would actually merge')
  await git(author, 'push', '-q', 'origin', BRANCH)
  const current = await git(author, 'rev-parse', 'HEAD')

  return { root, origin, consumer, stale, current }
}

describe('the mutation-proof gate against real git', () => {
  test('the short form leaves the tracking ref STALE; the resolver returns the true origin tip anyway', async () => {
    const w = await seedWorld('stale-ref')
    expect(w.stale).not.toBe(w.current)
    expect(await git(w.consumer, 'rev-parse', `refs/remotes/origin/${BRANCH}`)).toBe(w.stale)

    // THE FAILURE, reproduced: `git fetch origin <branch>` SUCCEEDS and the
    // tracking ref does not move.
    const shortForm = await spawnCapture(['git', '-C', w.consumer, 'fetch', 'origin', BRANCH], w.consumer)
    expect(shortForm.ok).toBe(true)
    expect(await git(w.consumer, 'rev-parse', `refs/remotes/origin/${BRANCH}`)).toBe(w.stale)

    // THE FIX: no local branch exists at all (the #482 shape) and the resolver
    // still returns the CURRENT origin tip.
    expect(
      (await spawnCapture(['git', '-C', w.consumer, 'rev-parse', '--verify', '--quiet', BRANCH], w.consumer)).ok,
    ).toBe(false)
    const resolved = await resolveMergeHeadSha(spawnCapture, w.consumer, BRANCH, null)
    expect(resolved).toBe(w.current)
    expect(resolved).not.toBe(w.stale)
    expect(await git(w.consumer, 'rev-parse', `refs/remotes/origin/${BRANCH}`)).toBe(w.current)
  })

  test('the two reviewer payloads, verbatim: no ref is written, no program runs, and the gate REFUSES', async () => {
    const w = await seedWorld('hostile-name')
    const marker = join(w.root, 'upload-pack-executed')
    const before = await git(w.consumer, 'for-each-ref', '--format=%(refname) %(objectname)')
    // RUN FIRST, ASSERT AFTER, STATE BEFORE OUTCOME. An `expect` inside the loop
    // throws on the first failure and the repository-state assertions below —
    // the ones this test exists for — never execute, so a run with the
    // validation removed reported the wrong reason for its red.
    const resolved: (string | null)[] = []
    const refusals: { ok: boolean; reason: string }[] = []
    for (const hostile of [`--upload-pack=touch ${marker}`, 'feat-x:refs/heads/injected-by-branch']) {
      resolved.push(await resolveMergeHeadSha(spawnCapture, w.consumer, hostile, w.stale))
      const out = await runMutationProofGate({
        run: { id: 'run-h', slug: 'hostile', repo_path: w.consumer, branch: hostile },
        claim: null,
        base_branch: 'main',
        expected_head: w.stale,
        run_host: spawnCapture,
      })
      refusals.push({ ok: out.ok, reason: out.reason })
    }
    expect(existsSync(marker)).toBe(false)
    expect(await git(w.consumer, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(before)
    expect(
      (
        await spawnCapture(
          ['git', '-C', w.consumer, 'rev-parse', '--verify', '--quiet', 'refs/heads/injected-by-branch'],
          w.consumer,
        )
      ).ok,
    ).toBe(false)
    // …and only now, the outcomes.
    expect(resolved).toEqual([null, null])
    for (const r of refusals) {
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('is rejected')
    }
  })

  test('a SYMBOLIC tracking ref is NOT fetched into — the fetch would write through it and create a local branch', async () => {
    const w = await seedWorld('symbolic-dest')
    // The plant: the destination the resolver would fetch into is a POINTER at
    // a local branch that does not exist yet. Reproduced on git 2.43.0 —
    // `fetch … +refs/heads/<b>:refs/remotes/origin/<b>` follows it and creates
    // refs/heads/injected at the remote tip.
    await git(w.consumer, 'symbolic-ref', `refs/remotes/origin/${BRANCH}`, 'refs/heads/injected')
    const heads = () => git(w.consumer, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')
    const before = await heads()

    const sha = await resolveMergeHeadSha(spawnCapture, w.consumer, BRANCH, w.stale)

    // NO local ref was created — the invariant this whole resolver exists for.
    expect(await heads()).toBe(before)
    expect((await spawnCapture(['git', '-C', w.consumer, 'rev-parse', '--verify', '--quiet', 'refs/heads/injected'], w.consumer)).ok).toBe(false)
    // The remote step DECLINED rather than reading a ref it did not write, so
    // the object-verified expected_head answers — never the origin tip a fetch
    // through the pointer would have produced.
    expect(sha).toBe(w.stale)
    expect(sha).not.toBe(w.current)
  })

  test('a FORCE-PUSHED branch still resolves — the refspec is `+`, and without it the fetch is rejected', async () => {
    const w = await seedWorld('force-push')
    const author = join(w.root, 'author')
    // Origin is rewritten to a commit that is NOT a descendant of the tracking
    // ref: the shape a rebase or an amend leaves behind.
    await git(author, 'reset', '-q', '--hard', 'main')
    writeFileSync(join(author, 'a.txt'), 'rebased onto a new base\n')
    await git(author, 'add', '-A')
    await git(author, ...GIT_ID, 'commit', '-q', '-m', 'the rebased commit that would actually merge')
    await git(author, 'push', '-q', '--force', 'origin', BRANCH)
    const rewritten = await git(author, 'rev-parse', 'HEAD')
    expect(await git(w.consumer, 'rev-parse', `refs/remotes/origin/${BRANCH}`)).toBe(w.stale)

    // THE BOUNDARY: the same refspec WITHOUT the `+` is refused as non-fast-forward
    // and the tracking ref does not move.
    const unforced = await spawnCapture(
      ['git', '-C', w.consumer, 'fetch', '--no-tags', 'origin', `refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`],
      w.consumer,
    )
    expect(unforced.ok).toBe(false)
    expect(await git(w.consumer, 'rev-parse', `refs/remotes/origin/${BRANCH}`)).toBe(w.stale)

    expect(await resolveMergeHeadSha(spawnCapture, w.consumer, BRANCH, null)).toBe(rewritten)
  })

  test('a TAG of the branch name cannot answer for the branch — the local read is fully qualified', async () => {
    const w = await seedWorld('tag-shadow')
    // Both refs exist under the SAME name. Bare `rev-parse` prefers the tag.
    await git(w.consumer, 'branch', BRANCH, w.stale)
    await git(w.consumer, 'tag', BRANCH, 'refs/remotes/origin/main')
    const tagged = await git(w.consumer, 'rev-parse', 'refs/remotes/origin/main')
    expect(await git(w.consumer, 'rev-parse', '--verify', BRANCH)).toBe(tagged)
    expect(tagged).not.toBe(w.stale)

    // The merge takes refs/heads/<branch>, so the proof must bind to it.
    expect(await resolveMergeHeadSha(spawnCapture, w.consumer, BRANCH, null)).toBe(w.stale)
  })

  test('a name the allowlist cannot judge is judged by REAL git — delegated, and its no refuses', async () => {
    const w = await seedWorld('delegated')
    const out = await runMutationProofGate({
      run: { id: 'run-d', slug: 'delegated', repo_path: w.consumer, branch: 'a/.hidden' },
      claim: null,
      base_branch: 'main',
      expected_head: w.stale,
      run_host: spawnCapture,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('check-ref-format')
  })

  test('DIVERGED BASES, IN REAL GIT: the branch diff is the intersection, so no base-only file is certifiable', async () => {
    // The condition a mocked host can build but not PROVE: local `main` and
    // `origin/main` have each moved since they parted. pr mode lands the branch
    // on origin's tip, local mode merges into the local one — so a resolver that
    // picks EITHER hands the other mode a three-dot diff whose merge-base sits
    // back at the fork, carrying commits the branch never made. This asserts
    // what real git lists, and that the gate's own reader lists neither side's.
    const root = mkdtempSync(join(tmpdir(), 'mutation-prover-realgit-diverged-'))
    created.push(root)
    const origin = join(root, 'origin.git')
    const work = join(root, 'work')
    await spawnCapture(['git', 'init', '--bare', '-q', '--initial-branch=main', origin], root)
    await spawnCapture(['git', 'init', '-q', '--initial-branch=main', work], root)
    const commit = async (file: string, body: string, message: string): Promise<string> => {
      writeFileSync(join(work, file), body)
      await git(work, 'add', '-A')
      await git(work, ...GIT_ID, 'commit', '-q', '-m', message)
      return await git(work, 'rev-parse', 'HEAD')
    }

    const forkPoint = await commit('a.txt', 'base\n', 'base')
    await git(work, 'remote', 'add', 'origin', origin)
    await git(work, 'push', '-q', 'origin', 'main')
    await git(work, 'fetch', '-q', 'origin')
    // Local `main` gains a commit origin never sees…
    await commit('local-base-only.ts', 'export const x = 1\n', 'local base only')
    // …and the branch is cut from THAT, as a local-mode build's branch is.
    await git(work, 'switch', '-q', '-c', 'feat')
    const feat = await commit('feature.ts', 'export const y = 2\n', 'the feature')
    // …while origin's `main` advances differently from the same fork point.
    await git(work, 'switch', '-q', '--detach', forkPoint)
    await commit('origin-base-only.ts', 'export const z = 3\n', 'origin base only')
    await git(work, 'push', '-q', '-f', 'origin', 'HEAD:main')
    await git(work, 'fetch', '-q', 'origin')
    await git(work, 'switch', '-q', 'feat')

    const localMain = await git(work, 'rev-parse', 'refs/heads/main')
    const originMain = await git(work, 'rev-parse', 'refs/remotes/origin/main')
    expect(localMain).not.toBe(originMain) // the tips really did diverge
    const listed = async (from: string): Promise<string[]> =>
      (await git(work, 'diff', '--name-only', `${from}...${feat}`)).split('\n').filter((l) => l.length > 0).sort()
    // THE HOLE, in real git: origin's tip drags the merge-base back to the fork,
    // so a file only LOCAL `main` changed reads as one of the branch's own.
    expect(await listed('refs/remotes/origin/main')).toEqual(['feature.ts', 'local-base-only.ts'])
    expect(await listed('refs/heads/main')).toEqual(['feature.ts'])

    // What the gate reads: only what the branch itself changed, under either
    // merge target. `local-base-only.ts` can no longer be nominated, and neither
    // can `origin-base-only.ts` — which is on the base git would list from the
    // other side.
    expect(await changedFilesOnBranch(spawnCapture, work, 'main', feat)).toEqual(['feature.ts'])

    // POSITIVE CONTROL: a second file the BRANCH really changes IS listed, so
    // this is not an intersection that has collapsed to one entry by accident.
    await commit('feature-two.ts', 'export const w = 4\n', 'more of the feature')
    const two = await git(work, 'rev-parse', 'HEAD')
    expect((await changedFilesOnBranch(spawnCapture, work, 'main', two))?.sort()).toEqual([
      'feature-two.ts',
      'feature.ts',
    ])
  })

  test('an expected_head that names a TREE is refused — only the `^{commit}` peel says so', async () => {
    const w = await seedWorld('tree-sha')
    const tree = await git(w.consumer, 'rev-parse', `${w.stale}^{tree}`)
    // The object IS in this repo: a bare `cat-file -e` would wave it through.
    expect((await spawnCapture(['git', '-C', w.consumer, 'cat-file', '-e', tree], w.consumer)).ok).toBe(true)
    expect(await resolveMergeHeadSha(spawnCapture, w.consumer, 'no-such-branch-anywhere', tree)).toBeNull()
    expect(await resolveMergeHeadSha(spawnCapture, w.consumer, 'no-such-branch-anywhere', w.stale)).toBe(w.stale)
  })
})
