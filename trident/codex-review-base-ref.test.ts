/**
 * `codex-review.sh`'s BASE-REF PROMOTION, against real git (#546).
 *
 * The wrapper prefers `origin/<x>` over a stale local branch `<x>`. The first version of
 * that block promoted whenever `origin/${BASE_REF}` resolved — by STRING SHAPE — and its
 * own comment claimed a tag would be "kept verbatim". It would not have been: with a tag
 * `release` at one commit and a remote branch `origin/release` at another,
 * `codex-review.sh release` reviewed the wrong commit, silently.
 *
 * That is the shape these tests exist for, and it is the second time on this branch that
 * a correct-looking generalisation over-reached by substituting an available signal for
 * the one that matters — the merge-mode fallback inferred "no remote" from "merges
 * locally", and this inferred "branch" from "resolves". So the cases below are written as
 * KINDS OF ARGUMENT, and every one of them names the commit it must end up at.
 *
 * THE SHIPPED BLOCK IS WHAT RUNS. It is extracted from `codex-review.sh` by text rather
 * than retyped, so a test cannot pass against a promotion the wrapper does not have.
 * Running the whole wrapper would need codex auth and a review round; the promotion is
 * self-contained and the extraction below is checked to have found it.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnCapture } from './git-mode.ts'

const SCRIPT = join(import.meta.dir, 'codex-review.sh')
const GIT_ID = ['-c', 'user.name=Test Setup', '-c', 'user.email=setup@neutron.local', '-c', 'commit.gpgsign=false']

const created: string[] = []
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  return res.stdout.trim()
}

/**
 * The promotion block, lifted out of the shipped wrapper: from the `BASE_REF=` assignment
 * to the `fi` that closes the `if`. Asserted non-trivial, so a refactor that moves the
 * block fails loudly here instead of leaving these tests exercising an empty string.
 */
function promotionBlock(): string {
  const src = readFileSync(SCRIPT, 'utf8')
  const start = src.indexOf('BASE_REF="${1:-main}"')
  expect(start).toBeGreaterThan(-1)
  const fi = src.indexOf('\nfi\n', start)
  expect(fi).toBeGreaterThan(start)
  const block = src.slice(start, fi + 4)
  // It must actually contain the promotion, or these tests prove nothing about it.
  expect(block).toContain('refs/remotes/origin/${BASE_REF}')
  // The FULLY QUALIFIED form, which is what the block verifies one line above. It stored the
  // shorthand `origin/${BASE_REF}` until round seventeen, and a tag named `origin/main` wins
  // that name in git's disambiguation order — so the promotion resolved to the tag.
  expect(block).toContain('BASE_REF="refs/remotes/origin/${BASE_REF}"')
  return block
}

/** The shipped block's raw outcome for `arg` in `repo` — exit code and streams. */
async function runBlock(repo: string, arg: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const script = `set -uo pipefail\nset -- ${JSON.stringify(arg)}\n${promotionBlock()}\nprintf %s "$BASE_REF"\n`
  const res = await spawnCapture(['bash', '-c', script], repo)
  return { ok: res.ok, stdout: res.stdout.trim(), stderr: res.stderr }
}

/** What the shipped block leaves `BASE_REF` as, for `arg`, in `repo`. */
async function promote(repo: string, arg: string): Promise<string> {
  const res = await runBlock(repo, arg)
  if (!res.ok) throw new Error(`promotion block failed: ${res.stderr}`)
  return res.stdout
}

interface World {
  repo: string
  /** Where the local branch `main` and the tag `release` point. */
  local: string
  /** Where `origin/main` and `origin/release` point — a DIFFERENT commit. */
  remote: string
}

/**
 * One repository holding, deliberately, every collision at once: a local branch and a
 * remote-tracking branch of the same name at different commits (the case the promotion is
 * FOR), and a TAG whose name also exists as a remote-tracking branch (the case it must
 * not touch).
 */
async function seedWorld(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'codex-review-base-ref-'))
  created.push(root)
  const repo = join(root, 'repo')
  await spawnCapture(['git', 'init', '-q', '--initial-branch=main', repo], root)
  await spawnCapture(['bash', '-c', `cd ${JSON.stringify(repo)} && echo a > a.txt`], root)
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'A')
  const local = await git(repo, 'rev-parse', 'HEAD')

  // The tag sits at A, with the SAME NAME as a remote-tracking branch created below.
  await git(repo, 'tag', 'release', local)

  await spawnCapture(['bash', '-c', `cd ${JSON.stringify(repo)} && echo b > b.txt`], root)
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'B')
  const remote = await git(repo, 'rev-parse', 'HEAD')

  // Remote-tracking refs at B; local `main` moved back to A so the promotion has a real
  // staleness to correct.
  await git(repo, 'update-ref', 'refs/remotes/origin/main', remote)
  await git(repo, 'update-ref', 'refs/remotes/origin/release', remote)
  await git(repo, 'update-ref', 'refs/heads/main', local)

  expect(local).not.toBe(remote)
  return { repo, local, remote }
}

describe('codex-review.sh promotes a base ref BY KIND, not by string shape', () => {
  test('a LOCAL BRANCH with a remote counterpart is promoted — the case this is for', async () => {
    const w = await seedWorld()
    expect(await promote(w.repo, 'main')).toBe('refs/remotes/origin/main')
    // Pinned as the COMMIT, not just the name: promotion is only worth anything if the
    // ref it picks resolves somewhere different from the one it refused.
    expect(await git(w.repo, 'rev-parse', await promote(w.repo, 'main'))).toBe(w.remote)
    expect(await git(w.repo, 'rev-parse', 'main')).toBe(w.local)
  })

  test('A TAG NAMED `origin/main` DOES NOT CAPTURE THE PROMOTED REF — the return form', async () => {
    // THE COLLISION AGAINST THE RETURNED FORM, not against the argument. The block verifies
    // `refs/remotes/origin/main^{commit}` and used to STORE the shorthand `origin/main` —
    // and git prefers `refs/tags/` over `refs/remotes/` when disambiguating, so a tag by that
    // name silently captured the base the wrapper had just proved. Measured on git 2.43: the
    // shorthand resolves to the tag with only a `warning: refname … is ambiguous` on stderr
    // and exit 0, and this wrapper sends its diff's stderr to /dev/null.
    //
    // The sibling test above covers a tag named `release` — a collision against the ARGUMENT.
    // This is the other end: same mechanism, the value the check hands back.
    const w = await seedWorld()
    await git(w.repo, 'tag', 'origin/main', w.local)
    // The collision is real here, and the two names disagree — or this proves nothing.
    expect(await git(w.repo, 'rev-parse', 'refs/tags/origin/main')).toBe(w.local)
    expect(await git(w.repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(w.remote)

    const promoted = await promote(w.repo, 'main')
    expect(promoted).toBe('refs/remotes/origin/main')
    // THE COMMIT, which is the claim: the promoted ref resolves to the REMOTE tip even with
    // the tag present. The shorthand would resolve to `w.local` — asserted here so the
    // difference is a measured value, not an argument about git's precedence rules.
    expect(await git(w.repo, 'rev-parse', promoted)).toBe(w.remote)
    expect(await git(w.repo, 'rev-parse', 'origin/main')).toBe(w.local)
  })

  test('A TAG IS NOT PROMOTED to origin/<same-name> — and a BARE tag-only name is now REFUSED', async () => {
    // THE ORIGINAL REGRESSION: `origin/release` resolves, so the string-shaped promotion
    // rewrote this and the review ran against B — a different commit, silently. That must
    // still not happen.
    //
    // AND THE NEW HALF: the old answer was to keep `release` VERBATIM, which is a bare word
    // that resolves only as a tag. This repository has a live instance of exactly that shape
    // (`archive/agent-replies-prior-iter-3b35767`), and a tag is not a base branch — so the
    // bare form is refused, with the explicit `refs/tags/release` still accepted below.
    const w = await seedWorld()
    const res = await runBlock(w.repo, 'release')
    expect({ ok: res.ok, stdout: res.stdout }).toEqual({ ok: false, stdout: '' })
    expect(res.stderr).toContain('refs/tags/release')
    expect(res.stderr).toContain('a tag is not a base branch')
    // NOT promoted to the remote-tracking ref — the refusal must not be the promotion in
    // disguise, so the commit the name would have reached is named here too.
    expect(res.stderr).not.toContain('refs/remotes/origin/release')
    expect(await git(w.repo, 'rev-parse', 'refs/tags/release')).toBe(w.local)
    expect(await git(w.repo, 'rev-parse', 'refs/remotes/origin/release')).toBe(w.remote)
    // THE WAY OUT, kept working: an operator who means the tag says so explicitly.
    expect(await promote(w.repo, 'refs/tags/release')).toBe('refs/tags/release')
    expect(await git(w.repo, 'rev-parse', await promote(w.repo, 'refs/tags/release'))).toBe(w.local)
  })

  test('an AMBIGUOUS name — both a branch and a tag — is REFUSED, not passed through', async () => {
    // THIS USED TO BE "left alone", on the reasoning that promoting would be a guess.
    // Leaving it alone is also a guess — GIT's — and git prefers `refs/tags/` over
    // `refs/heads/`, so the review would have run against the TAG with only a
    // `warning: refname … is ambiguous` on a stderr this wrapper sends to /dev/null.
    const w = await seedWorld()
    // THE BRANCH AND THE TAG AT DIFFERENT COMMITS. Both were seeded at `w.local` until this
    // round, so the two assertions below compared a value with itself: the fixture could not
    // show that git's choice CHANGES the reviewed commit, which is the only reason the
    // refusal exists. A test whose two arms are the same value cannot fail for the reason it
    // exists.
    await git(w.repo, 'update-ref', 'refs/heads/release', w.remote)
    expect(await git(w.repo, 'rev-parse', 'refs/tags/release')).toBe(w.local)
    expect(await git(w.repo, 'rev-parse', 'refs/heads/release')).toBe(w.remote)
    expect(w.local).not.toBe(w.remote)
    // AND THE STAKES, measured: the bare word resolves to the TAG, so a review that accepted
    // it would have run against `w.local` while the branch the operator named is at
    // `w.remote`. That is the commit the refusal is protecting.
    expect(await git(w.repo, 'rev-parse', 'release')).toBe(w.local)
    const res = await runBlock(w.repo, 'release')
    expect({ ok: res.ok, stdout: res.stdout }).toEqual({ ok: false, stdout: '' })
    // The message has to name BOTH refs and the way out, or the operator is left with an
    // exit code and a guess of their own.
    expect(res.stderr).toContain('refs/heads/release')
    expect(res.stderr).toContain('refs/tags/release')
    expect(res.stderr).toContain('AMBIGUOUS')
    // …and the unambiguous sibling still passes, so the refusal is not "refuse everything".
    expect(await promote(w.repo, 'main')).toBe('refs/remotes/origin/main')
  })

  test('every other kind of argument is kept VERBATIM', async () => {
    const w = await seedWorld()
    for (const arg of [
      w.remote, // a 40-hex sha
      'origin/main', // already qualified — `origin/origin/main` must not be reached for
      'HEAD~1', // a revision expression, not a ref name
      'no-such-branch', // a name with nothing behind it
    ]) {
      expect({ arg, got: await promote(w.repo, arg) }).toEqual({ arg, got: arg })
    }
  })

  test('a local branch with NO remote counterpart is QUALIFIED — the fallback, same rigour', async () => {
    // It used to be "kept" — the bare word, which is exactly what a tag of that name would
    // capture later. There is nothing to promote TO, but there is still a ref to NAME.
    const w = await seedWorld()
    await git(w.repo, 'branch', 'solo', w.local)
    expect(await promote(w.repo, 'solo')).toBe('refs/heads/solo')
    expect(await git(w.repo, 'rev-parse', await promote(w.repo, 'solo'))).toBe(w.local)
  })

  test('a repository with no remote-tracking refs at all still names the local branch in full', async () => {
    const w = await seedWorld()
    for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/release']) {
      await git(w.repo, 'update-ref', '-d', ref)
    }
    expect(await promote(w.repo, 'main')).toBe('refs/heads/main')
  })

  test('A TAG PLANTED LATER CANNOT CAPTURE THE FALLBACK — the degraded world, measured', async () => {
    // The fallback runs when the environment is already unusual, which is where a stray tag
    // is likeliest. With `refs/heads/solo` qualified, a tag `solo` appearing afterwards
    // changes nothing about what the review diffs against — the bare word would have moved.
    const w = await seedWorld()
    await git(w.repo, 'branch', 'solo', w.local)
    await git(w.repo, 'tag', 'solo-tag-target', w.remote)
    const qualified = await promote(w.repo, 'solo')
    expect(qualified).toBe('refs/heads/solo')
    // git resolves the QUALIFIED name to the branch even with a same-named tag present…
    await git(w.repo, 'update-ref', 'refs/tags/solo', w.remote)
    expect(await git(w.repo, 'rev-parse', qualified)).toBe(w.local)
    // …while the bare word it used to hand back now resolves to the TAG: a different commit.
    expect(await git(w.repo, 'rev-parse', 'solo')).toBe(w.remote)
  })
})
