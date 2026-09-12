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
  expect(block).toContain('BASE_REF="origin/${BASE_REF}"')
  return block
}

/** What the shipped block leaves `BASE_REF` as, for `arg`, in `repo`. */
async function promote(repo: string, arg: string): Promise<string> {
  const script = `set -uo pipefail\nset -- ${JSON.stringify(arg)}\n${promotionBlock()}\nprintf %s "$BASE_REF"\n`
  const res = await spawnCapture(['bash', '-c', script], repo)
  if (!res.ok) throw new Error(`promotion block failed: ${res.stderr}`)
  return res.stdout.trim()
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
    expect(await promote(w.repo, 'main')).toBe('origin/main')
    // Pinned as the COMMIT, not just the name: promotion is only worth anything if the
    // ref it picks resolves somewhere different from the one it refused.
    expect(await git(w.repo, 'rev-parse', await promote(w.repo, 'main'))).toBe(w.remote)
    expect(await git(w.repo, 'rev-parse', 'main')).toBe(w.local)
  })

  test('A TAG IS NOT PROMOTED, even when origin/<same-name> exists — the regression', async () => {
    // `origin/release` resolves, so the string-shaped promotion rewrote this and the
    // review ran against B. The argument is a tag; `refs/heads/release` does not exist;
    // the answer must be the tag, at A.
    const w = await seedWorld()
    expect(await promote(w.repo, 'release')).toBe('release')
    expect(await git(w.repo, 'rev-parse', 'release')).toBe(w.local)
  })

  test('an AMBIGUOUS name — both a branch and a tag — is left alone', async () => {
    // git itself refuses to guess between `refs/heads/x` and `refs/tags/x`; so does this.
    const w = await seedWorld()
    await git(w.repo, 'update-ref', 'refs/heads/release', w.local)
    expect(await promote(w.repo, 'release')).toBe('release')
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

  test('a local branch with NO remote counterpart is kept — there is nothing to promote to', async () => {
    const w = await seedWorld()
    await git(w.repo, 'branch', 'solo', w.local)
    expect(await promote(w.repo, 'solo')).toBe('solo')
  })

  test('a repository with no remote-tracking refs at all promotes nothing', async () => {
    const w = await seedWorld()
    for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/release']) {
      await git(w.repo, 'update-ref', '-d', ref)
    }
    expect(await promote(w.repo, 'main')).toBe('main')
  })
})
