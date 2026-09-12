/**
 * THE REVIEW DIFF BASE, AGAINST REAL GIT, WITH A DELIBERATELY STALE LOCAL REF (#546).
 *
 * ── WHAT A WRONG IMPLEMENTATION WOULD GET RIGHT ───────────────────────
 * This is the trap this file exists to avoid. A test that builds a repo, diffs two
 * refs and checks the file count is satisfied by the BROKEN implementation on every
 * input where local `main` happens to be up to date — which is most inputs, and all
 * the easy ones. `git diff main..<head>` and `git diff origin/main..<head>` return
 * byte-identical answers in a freshly cloned fixture, so a fixture that does not go
 * out of its way to desynchronise the two refs cannot fail on the bug at all.
 *
 * So the world below is built so that THE TWO ANSWERS DIFFER, and by a pinned amount:
 *   * `refs/heads/main` sits at the commit the consumer cloned (B0);
 *   * `refs/remotes/origin/main` sits 4 commits later (B4), each of those commits
 *     touching a file this branch never sees;
 *   * the build branch is cut from B4 and changes exactly ONE file.
 * The correct answer is therefore 1 file and the buggy answer is 5 — asserted as
 * VALUES on both sides, plus the file NAMES, because "fewer than before" is a
 * relation and a relation against a constant survives the constant moving (#575).
 *
 * ── AND THE COMPLEMENT ────────────────────────────────────────────────
 * A fix that always preferred something-other-than-the-local-ref would pass the
 * stale case and still be wrong. So the fresh case is asserted too: fast-forward
 * local `main` onto `origin/main` and the composed command and the bare-local
 * command must agree, exactly. And local mode — where there is no origin to be
 * behind — must still compose the bare name, or the "fix" is a new bug in the one
 * world the old code was right about.
 *
 * ── REAL GIT, AND THE REAL COMMAND ────────────────────────────────────
 * Nothing here is mocked except the Workflow runtime's `agent()` seam, and that
 * seam does not FAKE the diff: it extracts the command `writeResumeDiff` composed
 * and RUNS it, in the fixture, with bash. So the assertions are about git's own
 * output for the workflow's own command — not about a string the workflow built.
 * The harness (read the un-importable `.mjs`, strip its single `export`, run the
 * body as an AsyncFunction with injected globals) is `inner-workflow-resume.test.ts`'s,
 * for the same reason: top-level `return` and Workflow-runtime globals.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { spawnCapture } from './git-mode.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

const GIT_ID = ['-c', 'user.name=Test Setup', '-c', 'user.email=setup@neutron.local', '-c', 'commit.gpgsign=false']
const BRANCH = 'trident/resume-run'
const SLUG = 'resume-run'

/** How far behind `origin/main` the consumer's local `main` is left. Each of these
 *  commits touches its own file, so it is also the number of files a bare-local-ref
 *  diff over-reports. */
const STALE_COMMITS = 4

/** The one file this branch actually changes. */
const BRANCH_FILE = 'src/widget.ts'

const created: string[] = []
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  return res.stdout.trim()
}

interface World {
  /** The checkout the workflow is pointed at (`repoPath`). */
  consumer: string
  /** The sha the consumer's local `refs/heads/main` is pinned at — STALE. */
  staleBase: string
  /** The sha `origin/main` is at, and the commit the branch was cut from. */
  currentBase: string
  /** The branch tip the reviewers are meant to read. */
  head: string
  /** The files the STALE-ONLY commits touched. Never part of this branch's work. */
  staleFiles: string[]
}

/**
 * origin ← author pushes B0, then 4 more commits, then a branch off the 4th.
 * consumer clones at B0 and only ever FETCHES afterwards, so its `refs/heads/main`
 * never moves — which is exactly the shape a shared build checkout is in when
 * nothing has pulled it.
 */
async function seedWorld(label: string): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), `review-diff-base-${label}-`))
  created.push(root)
  const origin = join(root, 'origin.git')
  const author = join(root, 'author')
  const consumer = join(root, 'consumer')

  await spawnCapture(['git', 'init', '--bare', '-q', '--initial-branch=main', origin], root)
  await spawnCapture(['git', 'init', '-q', '--initial-branch=main', author], root)
  writeFileSync(join(author, 'README.md'), 'base\n')
  await git(author, 'add', '-A')
  await git(author, ...GIT_ID, 'commit', '-q', '-m', 'B0')
  await git(author, 'remote', 'add', 'origin', origin)
  await git(author, 'push', '-q', 'origin', 'main')
  const staleBase = await git(author, 'rev-parse', 'HEAD')

  // THE CONSUMER CLONES HERE — at B0. Everything after this is invisible to its
  // local `main` and visible to its `origin/main`.
  const cloned = await spawnCapture(['git', 'clone', '-q', origin, consumer], root)
  if (!cloned.ok) throw new Error(`clone failed: ${cloned.stderr}`)

  const staleFiles: string[] = []
  for (let i = 1; i <= STALE_COMMITS; i++) {
    const path = `base-only-${i}.md`
    staleFiles.push(path)
    writeFileSync(join(author, path), `merged into the base after the consumer cloned (${i})\n`)
    await git(author, 'add', '-A')
    await git(author, ...GIT_ID, 'commit', '-q', '-m', `base moves on (${i})`)
  }
  await git(author, 'push', '-q', 'origin', 'main')
  const currentBase = await git(author, 'rev-parse', 'HEAD')

  // THE BUILD BRANCH, cut from CURRENT origin/main, changing exactly one file.
  await git(author, 'switch', '-q', '-c', BRANCH)
  await spawnCapture(['mkdir', '-p', join(author, 'src')], author)
  writeFileSync(join(author, BRANCH_FILE), 'export const widget = 1\n')
  await git(author, 'add', '-A')
  await git(author, ...GIT_ID, 'commit', '-q', '-m', 'the branch does one thing')
  await git(author, 'push', '-q', 'origin', BRANCH)
  const head = await git(author, 'rev-parse', 'HEAD')

  // The consumer FETCHES — remote-tracking refs move, `refs/heads/main` does not.
  await git(consumer, 'fetch', '-q', 'origin')
  await git(consumer, 'fetch', '-q', 'origin', BRANCH)

  // The premise, asserted rather than assumed: if the fixture failed to
  // desynchronise the two refs, every assertion below would be vacuous.
  expect(await git(consumer, 'rev-parse', 'refs/heads/main')).toBe(staleBase)
  expect(await git(consumer, 'rev-parse', 'refs/remotes/origin/main')).toBe(currentBase)
  expect(staleBase).not.toBe(currentBase)

  return { consumer, staleBase, currentBase, head, staleFiles }
}

/** The files a rev-range names, sorted. Real git, in the consumer checkout. */
async function filesInRange(repo: string, range: string): Promise<string[]> {
  const out = await git(repo, 'diff', '--name-only', range)
  return out === '' ? [] : out.split('\n').sort()
}

/** The `+++`/`---` file headers of a materialised diff file, sorted. */
function filesInDiffFile(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('+++ b/'))
    .map((l) => l.slice('+++ b/'.length))
    .sort()
}

interface RunOut {
  /** The exact Bash command `writeResumeDiff` composed. */
  resumeDiffCommand: string
  /** The path that command wrote its diff to. */
  diffFile: string
  /** What `wc -c` actually printed for it. */
  bytes: number
}

/**
 * Drive the REAL workflow body through a `forge-done` resume against `world`, and
 * EXECUTE the resume-diff command it composes.
 */
async function runResumeDiff(world: World, opts: { pr: boolean; baseSha?: string }): Promise<RunOut> {
  let resumeDiffCommand = ''
  let bytes = 0

  const agent = async (prompt: string, o?: { label?: string }): Promise<unknown> => {
    const label = o?.label ?? ''
    if (label === 'head-probe-round-resume') return { head: world.head }
    if (label.startsWith('head-probe-round-')) return { head: world.head }
    if (label === 'resume-diff') {
      // THE COMMAND IS RUN, NOT READ. The prompt's last non-empty line is the single
      // Bash command the workflow tells its subagent to run verbatim; running it here
      // is what makes every assertion below an assertion about git's behaviour.
      const lines = prompt.split('\n').filter((l) => l.trim() !== '')
      resumeDiffCommand = lines[lines.length - 1] ?? ''
      const res = await spawnCapture(['bash', '-c', resumeDiffCommand], world.consumer)
      bytes = Number.parseInt(res.stdout.trim(), 10)
      return { bytes: Number.isFinite(bytes) ? bytes : 0 }
    }
    if (label.startsWith('ci-probe-round-')) {
      return { raw: '[{"name":"test","state":"SUCCESS","link":"https://x/1"}]\n___EXIT=0', exit_code: 0 }
    }
    if (label.startsWith('required-checks-r')) {
      return {
        raw:
          'gh: Not Found (HTTP 404)\n___PROT_EXIT=1\n' +
          '___SECTION=BRANCH\n{"protected":false,"protectionEnabled":false}\n___BRANCH_EXIT=0\n' +
          '___SECTION=RULES\n[]\n___RULES_EXIT=0\n' +
          '___SECTION=RUNS\n{"n":1,"names":["test"]}\n___RUNS_EXIT=0\n' +
          '___SECTION=STATUSES\n{"n":0,"names":[]}\n___STATUSES_EXIT=0\n___EXIT=0',
        exit_code: 0,
      }
    }
    if (label.startsWith('review-readiness-r')) {
      return {
        raw: JSON.stringify({
          mergeable: 'MERGEABLE',
          statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }),
        exit_code: 0,
      }
    }
    if (label.startsWith('merge-probe-round-')) return { raw: '{"state":"OPEN","mergedAt":""}\n___EXIT=0', exit_code: 0 }
    if (label === 'argus:claude' || label === 'argus:adversarial') return { verdict: 'APPROVE', findings: [] }
    if (label === 'argus:synthesis') return { verdict: 'APPROVE', findings: [] }
    return ''
  }

  const parallel = async (fns: Array<() => Promise<unknown>>): Promise<unknown[]> => Promise.all(fns.map((f) => f()))
  const phase = (): void => {}
  const log = (): void => {}
  const budget = { total: 0, spent: (): number => 0 }

  const args = {
    repoPath: world.consumer,
    task: 'Ship the widget',
    baseBranch: 'main',
    slug: SLUG,
    maxRounds: 10,
    mergeMode: opts.pr ? 'pr' : 'local',
    prNumber: opts.pr ? 7 : null,
    branch: BRANCH,
    dbPath: '/tmp/does-not-exist.db',
    runId: 'run-546-realgit',
    resumeCheckpoint: 'forge-done',
    resumeCheckpointHead: world.head,
    resumeLiveHead: world.head,
    resumeFindings: null,
    codexHome: null,
    checkpointScript: '/repo/trident/checkpoint.sh',
    worktreeCleanupScript: '/repo/trident/worktree-cleanup.sh',
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    reflectionGuidance: '',
    ...(opts.baseSha !== undefined ? { baseSha: opts.baseSha } : {}),
  }

  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  await fn(agent, parallel, phase, log, budget, args)

  const diffFile = `/tmp/trident-${SLUG}-resume-${world.head.slice(0, 12)}.diff`
  created.push(diffFile)
  return { resumeDiffCommand, diffFile, bytes }
}

describe('the review diff is taken against the resolved base, not the stale local ref (#546)', () => {
  test('THE BUGGY ANSWER AND THE CORRECT ANSWER DIFFER — 5 files against 1', async () => {
    // The premise of every other test here, measured with git rather than argued.
    // If these two ranges agreed, nothing below could fail on the bug.
    const w = await seedWorld('premise')
    expect(await filesInRange(w.consumer, `main..${w.head}`)).toEqual(
      [BRANCH_FILE, ...w.staleFiles].sort(),
    )
    expect(await filesInRange(w.consumer, `origin/main..${w.head}`)).toEqual([BRANCH_FILE])
    expect((await filesInRange(w.consumer, `main..${w.head}`)).length).toBe(STALE_COMMITS + 1)
    expect((await filesInRange(w.consumer, `${w.currentBase}..${w.head}`)).length).toBe(1)
  })

  test('UNPINNED, pr mode: the composed command uses origin/main and materialises ONE file', async () => {
    const w = await seedWorld('unpinned-pr')
    const out = await runResumeDiff(w, { pr: true })

    // The RANGE FORM is pinned as a value, both halves: the base it chose AND the
    // base it refused. `not.toContain` alone would pass on a command that diffed
    // nothing at all.
    expect(out.resumeDiffCommand).toContain(`git diff 'origin/main'..'${w.head}'`)
    expect(out.resumeDiffCommand).not.toContain(`git diff 'main'..'${w.head}'`)

    // …and what git actually produced for it: one file, named, and a non-empty diff
    // (bytes==0 is how `writeResumeDiff` reports failure, which would otherwise make
    // the assertion above true of a command that silently did nothing).
    expect(filesInDiffFile(out.diffFile)).toEqual([BRANCH_FILE])
    expect(out.bytes).toBeGreaterThan(0)
  })

  test('PINNED: the launch-observed base sha wins over every ref, and still gives ONE file', async () => {
    const w = await seedWorld('pinned')
    const out = await runResumeDiff(w, { pr: true, baseSha: w.currentBase })
    expect(out.resumeDiffCommand).toContain(`git diff '${w.currentBase}'..'${w.head}'`)
    expect(filesInDiffFile(out.diffFile)).toEqual([BRANCH_FILE])
  })

  test('A PINNED BASE THAT IS THE STALE SHA IS STILL HONOURED — the pin is evidence, not a guess', async () => {
    // The complement of the test above, and the one that shows the resolution is an
    // ORDER over real inputs rather than a hard-wired preference for `origin/<base>`:
    // pin the stale sha and the range must be the stale sha, over-reporting included.
    // A "fix" that always reached for `origin/<base>` would pass every other test here
    // and silently ignore the launcher's own observation.
    const w = await seedWorld('pinned-stale')
    const out = await runResumeDiff(w, { pr: true, baseSha: w.staleBase })
    expect(out.resumeDiffCommand).toContain(`git diff '${w.staleBase}'..'${w.head}'`)
    expect(filesInDiffFile(out.diffFile)).toEqual([BRANCH_FILE, ...w.staleFiles].sort())
  })

  test('LOCAL MODE, unpinned: the bare name is kept — there is no origin to be behind', async () => {
    // The one world where the bare local name is RIGHT rather than tolerated. Without
    // this, a fix that unconditionally prefixed `origin/` would look correct and would
    // have broken every local-mode run in a repo with no remote.
    const w = await seedWorld('local-mode')
    const out = await runResumeDiff(w, { pr: false })
    expect(out.resumeDiffCommand).toContain(`git diff 'main'..'${w.head}'`)
    expect(out.resumeDiffCommand).not.toContain('origin/main')
  })

  test('FRESH local ref: the resolved base and the bare name AGREE, file for file', async () => {
    // THE COMPLEMENT, and it is deliberately stated WITHOUT reference to the composed
    // command: it is a claim about git, and it must hold whichever base the workflow
    // picks. The fix is not "always prefer something else" — when nothing is stale the
    // two answers are the same answer, so the change costs nothing on the common path.
    // (Asserted on its own so that reverting the fix leaves THIS test green: a
    // complement that reddens under the mutation is not telling you anything the
    // stale-case tests did not already say.)
    const w = await seedWorld('fresh-agree')
    await git(w.consumer, 'switch', '-q', 'main')
    await git(w.consumer, 'merge', '-q', '--ff-only', 'origin/main')
    expect(await git(w.consumer, 'rev-parse', 'refs/heads/main')).toBe(w.currentBase)

    expect(await filesInRange(w.consumer, `main..${w.head}`)).toEqual([BRANCH_FILE])
    expect(await filesInRange(w.consumer, `origin/main..${w.head}`)).toEqual([BRANCH_FILE])
    expect(await filesInRange(w.consumer, `${w.currentBase}..${w.head}`)).toEqual([BRANCH_FILE])
  })

  test('FRESH local ref: the workflow still composes the resolved base, and still gets ONE file', async () => {
    const w = await seedWorld('fresh-composed')
    await git(w.consumer, 'switch', '-q', 'main')
    await git(w.consumer, 'merge', '-q', '--ff-only', 'origin/main')

    const out = await runResumeDiff(w, { pr: true })
    expect(out.resumeDiffCommand).toContain(`git diff 'origin/main'..'${w.head}'`)
    expect(filesInDiffFile(out.diffFile)).toEqual([BRANCH_FILE])
  })
})
