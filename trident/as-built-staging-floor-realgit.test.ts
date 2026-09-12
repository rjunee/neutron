/**
 * THE PROPERTY THE STAGING FLOOR BUYS, PROVED WITH REAL MERGES.
 *
 * Not "the placeholder file exists" — that is a tautology a guard can assert. The
 * property is: after a promotion consumes the LAST staged record in a directory, a
 * concurrent branch holding a staged record in that same directory still merges
 * WITHOUT a directory-rename conflict.
 *
 * THE DEFECT, MEASURED 2026-09-12 rather than predicted. The promoter moves
 * `.trident/as-built/<branch>.md` to `docs/as-built/<slug>.md` on the base after
 * the merge lands (`trident/as-built-appender.ts:161`). When it takes the last
 * record out of a directory, that directory has no tracked file left and stops
 * existing in the tree — and the commit is, file for file, a move out of it into
 * `docs/as-built/`. Git reads the pair as a directory rename, and every open PR
 * staging a record there acquires `CONFLICT (file location) ... suggesting it
 * should perhaps be moved to docs/as-built/<name>.md`. Promoting the single
 * remaining record did exactly that, and two of the seven then-open PRs acquired
 * it. The suggestion is worse than the conflict: moving a staged record into
 * `docs/as-built/` writes a shard FROM A BRANCH, which the one-writer rule exists
 * to forbid.
 *
 * WHY THREE ARMS AND NOT ONE. A test that passes with and without the fix is
 * measuring the wrong thing, so the arms without the floor are part of the suite
 * rather than a one-off manual check — they are the positive control that this
 * instrument can observe the conflict at all:
 *
 *   per-directory floor  → merges clean            (the property)
 *   no floor             → the conflict            (the defect, reproduced)
 *   top-level floor ONLY → the conflict, STILL     (why the rule is per-directory)
 *
 * The third arm is the one that changed the fix. Git decides directory-rename
 * detection per directory, and branch names in this repo carry a slash, so records
 * land in `.trident/as-built/fix/` far more often than at the top — a lone
 * `.trident/as-built/.gitkeep` leaves the subdirectory free to vanish and the
 * conflict entirely intact.
 *
 * The drain is done by the REAL promoter, not by a hand-written `git mv`, so the
 * commit under test is the one the outer loop actually produces.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { foldStagedAsBuiltEntries } from './as-built-appender.ts'
import { spawnCapture } from './git-mode.ts'

const GIT_ID = ['-c', 'user.name=Test Setup', '-c', 'user.email=setup@neutron.local', '-c', 'commit.gpgsign=false']
const FROZEN_LOG = '# AS_BUILT\n\nFROZEN.\n\n## 2026-08-14 — history\n\nold body\n\n'
const FILE_LOCATION_CONFLICT = 'CONFLICT (file location)'
const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const result = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

/** git, but the failure is the ANSWER — a conflicting merge exits non-zero. */
async function attempt(repo: string, ...args: string[]): Promise<{ ok: boolean; output: string }> {
  const result = await spawnCapture(['git', '-C', repo, ...args], repo)
  return { ok: result.ok, output: `${result.stdout}\n${result.stderr}` }
}

function write(repo: string, relative: string, body: string): void {
  const absolute = join(repo, relative)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, body)
}

type Floor = 'none' | 'top-only' | 'per-directory'

interface Outcome {
  folded: number
  stagedAfterPromotion: string[]
  merged: boolean
  mergeOutput: string
  stagedPathAfterMerge: string
}

/**
 * One full round trip: stage, merge, promote with the real promoter, then merge a
 * concurrent branch that staged into the SAME directory the promotion drained.
 *
 * `directory` is the staged record's parent under `.trident/as-built/` — '' for a
 * record at the top, 'fix' for the shape this repo actually produces.
 */
async function round(label: string, floor: Floor, directory: string): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), `as-built-floor-${label}-`))
  created.push(root)
  const origin = join(root, 'origin.git')
  const checkout = join(root, 'checkout')
  await git(root, 'init', '--bare', '-q', '--initial-branch=main', origin)
  await git(root, 'init', '-q', '--initial-branch=main', checkout)
  await git(checkout, 'remote', 'add', 'origin', origin)

  const stagingDir = directory === '' ? '.trident/as-built' : `.trident/as-built/${directory}`
  write(checkout, 'docs/AS_BUILT.md', FROZEN_LOG)
  write(checkout, 'docs/as-built/already-here.md', '## 2026-08-13 — already recorded\n\nprior body\n')
  if (floor !== 'none') write(checkout, '.trident/as-built/.gitkeep', '')
  if (floor === 'per-directory') write(checkout, `${stagingDir}/.gitkeep`, '')
  await git(checkout, 'add', '-A')
  await git(checkout, ...GIT_ID, 'commit', '-q', '-m', 'base')
  await git(checkout, 'push', '-q', '-u', 'origin', 'main')

  // The branch whose record will be the LAST one in the directory. It merges.
  const drained = `${stagingDir}/first-change.md`
  await git(checkout, 'switch', '-q', '-c', 'first')
  write(checkout, drained, '## 2026-09-11 — the record that gets promoted\n\nfirst body\n')
  await git(checkout, 'add', '-A')
  await git(checkout, ...GIT_ID, 'commit', '-q', '-m', 'stage the first record')
  await git(checkout, 'switch', '-q', 'main')
  await git(checkout, ...GIT_ID, 'merge', '-q', '--no-ff', '-m', 'merge first', 'first')
  await git(checkout, 'push', '-q', 'origin', 'main')

  // The concurrent branch: cut from the main that still has the directory, stages
  // its own record there, and is NOT merged before the promotion happens.
  const concurrent = `${stagingDir}/second-change.md`
  await git(checkout, 'switch', '-q', '-c', 'second')
  write(checkout, concurrent, '## 2026-09-12 — a record staged while the promotion ran\n\nsecond body\n')
  await git(checkout, 'add', '-A')
  await git(checkout, ...GIT_ID, 'commit', '-q', '-m', 'stage the second record')
  await git(checkout, 'switch', '-q', 'main')

  // The REAL promotion, which is what drains the directory.
  const fold = await foldStagedAsBuiltEntries(spawnCapture, checkout, 'pr', 'main')
  if (!fold.ok) throw new Error(`the promoter failed: ${fold.reason}`)
  await git(checkout, 'fetch', '-q', 'origin')
  await git(checkout, ...GIT_ID, 'merge', '-q', '--ff-only', 'origin/main')

  const listed = (await git(checkout, 'ls-tree', '-r', '--name-only', 'main', '--', '.trident/as-built/')).trim()
  const merge = await attempt(checkout, ...GIT_ID, 'merge', '--no-ff', '-m', 'merge second', 'second')
  const staged = (await attempt(checkout, 'ls-files', '--', concurrent)).output.trim()

  return {
    folded: fold.folded,
    stagedAfterPromotion: listed === '' ? [] : listed.split('\n'),
    merged: merge.ok,
    mergeOutput: merge.output,
    stagedPathAfterMerge: staged,
  }
}

describe('the as-built staging floor, against real merges', () => {
  test('WITH a per-directory floor, a concurrent staged record merges clean after the drain', async () => {
    const outcome = await round('per-dir', 'per-directory', 'fix')

    // The drain really happened — without this the whole assertion is vacuous.
    expect(outcome.folded).toBe(1)
    expect(outcome.stagedAfterPromotion).toEqual(['.trident/as-built/.gitkeep', '.trident/as-built/fix/.gitkeep'])

    expect(outcome.mergeOutput).not.toContain(FILE_LOCATION_CONFLICT)
    expect(outcome.merged).toBe(true)
    // And the record stayed where it was staged: it was not relocated into
    // docs/as-built/ by the merge, which is the resolution the conflict suggests
    // and the one the one-writer rule forbids.
    expect(outcome.stagedPathAfterMerge).toBe('.trident/as-built/fix/second-change.md')
  }, 120_000)

  test('with NO floor the conflict appears — the positive control for this instrument', async () => {
    const outcome = await round('no-floor', 'none', 'fix')

    expect(outcome.folded).toBe(1)
    expect(outcome.stagedAfterPromotion).toEqual([])
    expect(outcome.mergeOutput).toContain(FILE_LOCATION_CONFLICT)
    expect(outcome.mergeOutput).toContain('docs/as-built/second-change.md')
    expect(outcome.merged).toBe(false)
  }, 120_000)

  test('a TOP-LEVEL floor alone does NOT save a record staged in a subdirectory', async () => {
    // The measurement that made the rule per-directory. Git decides
    // directory-rename detection per directory: `.trident/as-built/` surviving
    // says nothing about `.trident/as-built/fix/`, and branch names in this repo
    // carry a slash, so that subdirectory is where records actually live.
    const outcome = await round('top-only-sub', 'top-only', 'fix')

    expect(outcome.folded).toBe(1)
    expect(outcome.stagedAfterPromotion).toEqual(['.trident/as-built/.gitkeep'])
    expect(outcome.mergeOutput).toContain(FILE_LOCATION_CONFLICT)
    expect(outcome.merged).toBe(false)
  }, 120_000)

  test('a top-level floor is exactly enough for a record staged at the top', async () => {
    // The other half of the same fact, so the rule is not read as "subdirectories
    // are special": for a record staged directly under `.trident/as-built/`, the
    // top-level floor IS the per-directory floor.
    const outcome = await round('top-only-flat', 'top-only', '')

    expect(outcome.folded).toBe(1)
    expect(outcome.stagedAfterPromotion).toEqual(['.trident/as-built/.gitkeep'])
    expect(outcome.mergeOutput).not.toContain(FILE_LOCATION_CONFLICT)
    expect(outcome.merged).toBe(true)
    expect(outcome.stagedPathAfterMerge).toBe('.trident/as-built/second-change.md')
  }, 120_000)
})
