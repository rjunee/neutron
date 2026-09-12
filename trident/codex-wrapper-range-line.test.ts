/**
 * WHAT EACH WRAPPER'S SHIPPED RANGE LINE DOES WITH THE BASE IT IS HANDED (#546).
 *
 * ── THE FILE NAME WAS A CLAIM, AND IT WENT STALE ──────────────────────
 * This was `codex-wrapper-bare-base.test.ts` until round twenty-one. The name asserted the
 * contract round nineteen deleted — that a bare base is something `diffBase` produces and the
 * wrappers receive — and a file name is the claim nobody audits, which is this branch's own
 * lesson about titles arriving at the level of the filesystem.
 *
 * What it tests is legitimately different and worth keeping: **the wrappers' shipped range
 * lines, driven with values THIS FILE supplies.** That distinction matters. A test that
 * supplies the value it claims the system produces is measuring the fixture, not the system —
 * which is exactly why the stale claims inside it read as true for two rounds. Nothing here
 * shows what `diffBase` composes; `review-diff-base-realgit.test.ts` and the parity table do
 * that. These tests show what the wrapper does with whatever argv carries, which is what makes
 * the composing side's choice load-bearing.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────
 * Every other wrapper assertion on this branch reads ARGV or SOURCE TEXT: that
 * `codex-build.sh` is invoked with `${diffBase}`, that the range line carries
 * `--end-of-options`, that `codex-review.sh`'s promotion block picks the right ref. None of
 * them runs a range. So the record could claim — and did, in four places — that a bare base
 * branch name is "unconstructable" at `codex-build.sh` because its argv default is empty
 * and an empty value skips the diff. That claim was FALSE when it was made: `diffBase` then
 * yielded a bare NAME whenever `refs/remotes/origin/<base>` did not resolve, and that name
 * was passed as argv `$2` and reached
 * `git diff --end-of-options "${BASE_DIFF_REF}..HEAD"`.
 *
 * IF A CLAIM SAYS SOMETHING CANNOT BE BUILT, IT HAS TO NAME THE MECHANISM THAT PREVENTS
 * IT. The mechanism named there — no base-branch-name binding, empty default — prevents the
 * wrapper CHOOSING a base; it never prevented a value ARRIVING at one. **Round nineteen
 * removed `diffBase`'s bare-name arm, so the trident path now hands this argv a sha or a
 * fully qualified ref — but that is a property of the CALLER, and argv comes from anyone.**
 * These tests run the range with whatever they hand it, which is the only way to show that
 * the wrapper cannot repair a bad base and therefore that the composing side's choice is
 * load-bearing.
 *
 * ── WHAT A WRONG IMPLEMENTATION WOULD GET RIGHT ───────────────────────
 * A test that hands the wrapper line a resolved ref in a fresh repository passes whatever
 * the value is, because a fresh clone's `main` and `origin/main` are the same commit. So
 * the stale world below is built so the two answers DIFFER by a pinned amount, and the
 * bare-name row asserts the INFLATED answer — the wrapper is shown to be incapable of
 * repairing a bad base, which is precisely why the composing side must not hand it one.
 *
 * ── THE SHIPPED LINES ARE WHAT RUNS ───────────────────────────────────
 * Both range lines are extracted from the scripts by text, never retyped, and the
 * extraction is asserted non-trivial. Running the whole of either wrapper needs codex auth
 * and a model round; the range lines are self-contained.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnCapture } from './git-mode.ts'

const BUILD_SH = join(import.meta.dir, 'codex-build.sh')
const REVIEW_SH = join(import.meta.dir, 'codex-review.sh')
const GIT_ID = ['-c', 'user.name=Test Setup', '-c', 'user.email=setup@neutron.local', '-c', 'commit.gpgsign=false']
/** The one file the build branch touches, in every world below. */
const OWN_WORK = 'src/widget.ts'
/** How far `origin/main` is ahead of local `main` in the stale world, and thus the inflation. */
const STALE_COMMITS = 4

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
 * `codex-build.sh`'s last-resort diff line, lifted out of the shipped script. Asserted to
 * contain the range and the marker, so a refactor that moves it reds here rather than
 * leaving these tests exercising an empty string.
 */
function buildRangeLine(): string {
  const src = readFileSync(BUILD_SH, 'utf8')
  const line = src.split('\n').find((l) => l.includes('git diff --end-of-options') && l.includes('BASE_DIFF_REF'))
  expect(line).toBeDefined()
  const found = (line as string).trim()
  expect(found).toContain('"${BASE_DIFF_REF}..HEAD"')
  expect(found).toContain('2>/dev/null')
  return found
}

/** `codex-review.sh`'s own diff line, same treatment. */
function reviewRangeLine(): string {
  const src = readFileSync(REVIEW_SH, 'utf8')
  // THE WHOLE STATEMENT, not one line: the diff now captures its own failure, so the read is
  // an `if ! FULL_DIFF=$(…); then … exit 3; fi` block. A one-line extractor would have
  // silently dropped the status check and gone on testing the happy path.
  const start = src.indexOf('DIFF_ERR_FILE=$(mktemp')
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf('rm -f "$DIFF_ERR_FILE"', src.indexOf('exit 3', start))
  expect(end).toBeGreaterThan(start)
  const found = src
    .slice(start, end + 'rm -f "$DIFF_ERR_FILE"'.length)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .join('\n')
  expect(found).toContain('"${BASE_REF}..HEAD"')
  // …and the failure path, which is the half a line-based extraction could not see.
  expect(found).toContain('exit 3')
  return found
}

/** Run the shipped build line with `base` as `$BASE_DIFF_REF`; return the diff file's paths. */
async function buildDiffPaths(repo: string, base: string, out: string): Promise<string[]> {
  writeFileSync(out, '')
  const script = `set -uo pipefail\nBASE_DIFF_REF=${JSON.stringify(base)}\nNEUTRON_CODEX_BUILD_DIFF_FILE=${JSON.stringify(out)}\n${buildRangeLine()}\n`
  const res = await spawnCapture(['bash', '-c', script], repo)
  // `|| true` in the shipped line: it never fails, which is half the point.
  expect(res.ok).toBe(true)
  return diffPaths(readFileSync(out, 'utf8'))
}

/** Run the shipped review line with `base` as `$BASE_REF`; return the diff's paths. */
async function reviewDiffPaths(repo: string, base: string): Promise<string[]> {
  const script = `set -uo pipefail\nBASE_REF=${JSON.stringify(base)}\n${reviewRangeLine()}\nprintf %s "$FULL_DIFF"\n`
  const res = await spawnCapture(['bash', '-c', script], repo)
  expect(res.ok).toBe(true)
  return diffPaths(res.stdout)
}

/** The `b/` paths of a unified diff, sorted — the assertion is the FILE LIST, not a count. */
function diffPaths(diff: string): string[] {
  return diff
    .split('\n')
    .filter((l) => l.startsWith('+++ b/'))
    .map((l) => l.slice('+++ b/'.length))
    .sort()
}

interface World {
  repo: string
  out: string
  /** Paths the four base-moving commits touch; never the branch's own work. */
  others: string[]
}

/**
 * A repository where local `main` is `STALE_COMMITS` behind `origin/main` and the build
 * branch is cut from `origin/main`, changing exactly one file. `remote: false` builds the
 * same shape with NO remote-tracking refs at all — the world where the bare name is the
 * only answer there is, and the one this file was asked for.
 */
async function seed(label: string, opts: { remote: boolean }): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), `wrapper-bare-base-${label}-`))
  created.push(root)
  const repo = join(root, 'repo')
  await spawnCapture(['git', 'init', '-q', '--initial-branch=main', repo], root)
  await spawnCapture(['mkdir', '-p', join(repo, 'src')], root)
  writeFileSync(join(repo, 'src', 'base.ts'), 'export const v = 0\n')
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'B0')
  const b0 = await git(repo, 'rev-parse', 'HEAD')

  // Four commits the branch never sees. They advance `main` locally first, so the tip can
  // be recorded as `origin/main`, and `main` is then RESET back to B0 — which is exactly
  // the stale-checkout shape #546 measured.
  const others: string[] = []
  for (let i = 1; i <= STALE_COMMITS; i += 1) {
    const path = `src/other${i}.ts`
    others.push(path)
    writeFileSync(join(repo, path), `export const o${i} = ${i}\n`)
    await git(repo, 'add', '-A')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', `base ${i}`)
  }
  const tip = await git(repo, 'rev-parse', 'HEAD')
  if (opts.remote) await git(repo, 'update-ref', 'refs/remotes/origin/main', tip)
  await git(repo, 'reset', '-q', '--hard', opts.remote ? b0 : tip)

  // The build branch: cut from the freshest base this world HAS, changing one file.
  await git(repo, 'switch', '-q', '-c', 'trident/work', opts.remote ? tip : 'HEAD')
  writeFileSync(join(repo, OWN_WORK), 'export const w = 1\n')
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'the branch own work')

  return { repo, out: join(root, 'diff.patch'), others: others.sort() }
}

describe('codex-build.sh: whatever argv carries DOES reach the range, and the wrapper cannot repair it', () => {
  test('NO REMOTE: a bare name handed in DOES range, and the answer is the branch', async () => {
    // THE CLAIM THIS REPLACES: "codex-build.sh holds no base-branch-name binding, so a
    // bare-base range is unconstructable there". The wrapper cannot CHOOSE a base — true —
    // but it cannot refuse one either, and here a bare name reaches the shipped line and
    // produces a diff. **THE VALUE IS SUPPLIED BY THIS TEST, not by `diffBase`**, which since
    // round nineteen has no arm that produces one; what this measures is the WRAPPER's
    // behaviour for whatever argv carries, which is what makes the composing side's choice
    // load-bearing. Correct in this world in the sense that `refs/heads/main` is the base —
    // and `diffBase` would name it in full.
    const w = await seed('build-no-remote', { remote: false })
    expect(await git(w.repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/')).toBe('')
    expect(await buildDiffPaths(w.repo, 'main', w.out)).toEqual([OWN_WORK])
  })

  test('STALE LOCAL REF: the same line handed the bare name produces the INFLATED answer', async () => {
    // The wrapper is not a safety net. Handed `main` where `origin/main` is 4 commits ahead,
    // the shipped line reports the branch's one file PLUS four it never touched — asserted as
    // the file LIST, because "more files" is a relation and a relation survives the constant
    // moving (#575). This is the measurement that makes the argv load-bearing.
    const w = await seed('build-stale', { remote: true })
    const bare = await buildDiffPaths(w.repo, 'main', w.out)
    expect(bare).toEqual([...w.others, OWN_WORK].sort())
    expect(bare.length).toBe(STALE_COMMITS + 1)
    // …and the resolved ref, through the same line, in the same repository.
    expect(await buildDiffPaths(w.repo, 'origin/main', w.out)).toEqual([OWN_WORK])
    // …as does the pin, which is what a real dispatch usually carries.
    const pin = await git(w.repo, 'rev-parse', 'refs/remotes/origin/main')
    expect(await buildDiffPaths(w.repo, pin, w.out)).toEqual([OWN_WORK])
  })

  test('A PADDED NAME becomes an EMPTY diff here — why the binding refuses one', async () => {
    // git is loud about ` main ..HEAD` (fatal, exit 128 — measured on 2.43). The shipped
    // line is `2>/dev/null || true`, so the loudness is swallowed and the wrapper writes an
    // EMPTY diff file, which is the "unbuilt branch" signal rather than an error. That is
    // the whole argument for refusing a padded base at the composing binding instead of
    // trusting git to complain: measured here, not asserted.
    const w = await seed('build-padded', { remote: true })
    expect(await buildDiffPaths(w.repo, ' main ', w.out)).toEqual([])
    expect(existsSync(w.out)).toBe(true)
    expect(statSync(w.out).size).toBe(0)
    // The complement, in the same repository: the unpadded name is not empty at all.
    expect((await buildDiffPaths(w.repo, 'main', w.out)).length).toBeGreaterThan(0)
  })
})

describe('codex-review.sh: same range, and its own qualification is what keeps a bare argument correct', () => {
  test('NO REMOTE: a bare name handed to the RANGE LINE still ranges — the wrapper qualifies earlier', async () => {
    const w = await seed('review-no-remote', { remote: false })
    expect(await reviewDiffPaths(w.repo, 'main')).toEqual([OWN_WORK])
  })

  test('STALE LOCAL REF: the range line itself is not protected — the promotion above it is', async () => {
    // `codex-review.sh` has a promotion block, tested for KIND in
    // `codex-review-base-ref.test.ts`. This asserts the other half: the range line it feeds
    // has no opinion of its own, so a bare `main` that reached it unpromoted would read the
    // inflated diff. Both halves are needed — the promotion is load-bearing precisely
    // because this line is not.
    const w = await seed('review-stale', { remote: true })
    expect(await reviewDiffPaths(w.repo, 'main')).toEqual([...w.others, OWN_WORK].sort())
    expect(await reviewDiffPaths(w.repo, 'origin/main')).toEqual([OWN_WORK])
  })
})
