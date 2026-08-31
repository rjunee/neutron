import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnCapture } from './git-mode.ts'
import { resolveMergeHeadSha, runMutationProofGate } from './mutation-prover.ts'

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
    for (const hostile of [`--upload-pack=touch ${marker}`, 'feat-x:refs/heads/injected-by-branch']) {
      expect(await resolveMergeHeadSha(spawnCapture, w.consumer, hostile, w.stale)).toBeNull()
      const out = await runMutationProofGate({
        run: { id: 'run-h', slug: 'hostile', repo_path: w.consumer, branch: hostile },
        claim: null,
        base_branch: 'main',
        expected_head: w.stale,
        run_host: spawnCapture,
      })
      expect(out.ok).toBe(false)
      expect(out.reason).toContain('is rejected')
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

  test('an expected_head that names a TREE is refused — only the `^{commit}` peel says so', async () => {
    const w = await seedWorld('tree-sha')
    const tree = await git(w.consumer, 'rev-parse', `${w.stale}^{tree}`)
    // The object IS in this repo: a bare `cat-file -e` would wave it through.
    expect((await spawnCapture(['git', '-C', w.consumer, 'cat-file', '-e', tree], w.consumer)).ok).toBe(true)
    expect(await resolveMergeHeadSha(spawnCapture, w.consumer, 'no-such-branch-anywhere', tree)).toBeNull()
    expect(await resolveMergeHeadSha(spawnCapture, w.consumer, 'no-such-branch-anywhere', w.stale)).toBe(w.stale)
  })
})
