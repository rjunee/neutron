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

  test('A HOSTILE BASE WRITES A FILE THROUGH REAL git diff — and never reaches it from here', async () => {
    // What a mock cannot show: `git diff --name-only <base>...<ref>` takes its
    // range as a BARE OPERAND, so a base spelled `--output=<path>` is parsed as
    // an option and git creates that path. The base arrives from an operator
    // flag or from `origin/HEAD` (`detectBaseBranch`), and `check-ref-format`
    // accepts a ref of that spelling — so this is reachable, and the filter has
    // to live at the consumer.
    const root = mkdtempSync(join(tmpdir(), 'mutation-prover-realgit-hostile-base-'))
    created.push(root)
    const work = join(root, 'work')
    await spawnCapture(['git', 'init', '-q', '--initial-branch=main', work], root)
    writeFileSync(join(work, 'a.txt'), 'base\n')
    await git(work, 'add', '-A')
    await git(work, ...GIT_ID, 'commit', '-q', '-m', 'base')
    await git(work, 'switch', '-q', '-c', 'feat')
    writeFileSync(join(work, 'feature.ts'), 'export const y = 2\n')
    await git(work, 'add', '-A')
    await git(work, ...GIT_ID, 'commit', '-q', '-m', 'the feature')
    const feat = await git(work, 'rev-parse', 'HEAD')

    // THE VECTOR, demonstrated on this machine's real git: the hostile base is
    // interpolated into `<base>...<ref>` and the WHOLE operand is parsed as
    // `--output=<file>`, so git exits 0 and creates a file whose name the base
    // chose. Nothing about the range survives as a revision.
    const demo = join(root, 'written-by-raw-git')
    const demoWritten = `${demo}...${feat}`
    expect(existsSync(demoWritten)).toBe(false)
    const raw = await spawnCapture(['git', '-C', work, 'diff', '--name-only', `--output=${demo}...${feat}`], work)
    expect({ ok: raw.ok, wrote: existsSync(demoWritten) }).toEqual({ ok: true, wrote: true })

    // THE GATE'S READER refuses the same name: no file anywhere, and null —
    // which the gate turns into "require the proof", never into a pass.
    const target = join(root, 'written-through-the-gate')
    expect(await changedFilesOnBranch(spawnCapture, work, `--output=${target}`, feat)).toBeNull()
    expect(existsSync(target)).toBe(false)
    expect(existsSync(`${target}...${feat}`)).toBe(false)

    // POSITIVE CONTROL: the ordinary base still reads the branch's own file, so
    // the refusal above is the NAME being rejected and not a reader that has
    // stopped working.
    expect(await changedFilesOnBranch(spawnCapture, work, 'main', feat)).toEqual(['feature.ts'])
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
