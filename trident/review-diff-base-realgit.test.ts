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
 * command must agree, exactly.
 *
 * ── AND NOT "LOCAL MODE GETS THE BARE NAME" ───────────────────────────
 * This header said, until the round that is writing this line, that local mode "has no
 * origin to be behind" and "must still compose the bare name". THAT IS THE SUPERSEDED
 * RULE, and the cases below never implemented it: `'LOCAL MODE, unpinned, WITH a remote'`
 * asserts `origin/main` and ONE file, which is the opposite. The explanation was written
 * during the rounds that REMOVED the merge-mode fallback, from the mental model the code
 * had already abandoned — a new narrative carrying an old rule, which is harder to spot
 * than a stale comment left behind, because nothing about it looks unmaintained.
 *
 * The rule the cases actually encode: `origin/<base>` whenever `refs/remotes/origin/<base>`
 * resolves, IN EITHER MERGE MODE, and the bare name only when it does not — asserted here
 * by three fixtures that differ in the REF, not in the mode (no remote at all, a configured
 * origin whose base ref is missing, and both modes against a resolving one).
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

/**
 * THE BASE THE COMPOSED COMMAND ACTUALLY RESOLVES TO, evaluated in the fixture.
 *
 * The unpinned arm of `diffBase` is a shell substitution — it asks the repository
 * whether `refs/remotes/origin/<base>` exists — so the base is not a literal in the
 * command text and cannot be asserted by reading it. This runs the same substitution in
 * the same repo and returns what git picked, which is what lets the tests below pin the
 * RESOLUTION as a value alongside the file list that pins the OUTCOME.
 */
async function resolvedBase(repo: string, command: string): Promise<string> {
  const at = command.indexOf('"$(')
  if (at === -1) {
    // A pinned base is a literal, not a substitution: read it straight out of the range.
    const lit = /git diff (?:--end-of-options )?'([^']+)'\.\./.exec(command)
    return lit?.[1] ?? ''
  }
  const end = command.indexOf(')"', at)
  const expr = command.slice(at + 1, end + 1)
  const res = await spawnCapture(['bash', '-c', `printf %s ${expr}`], repo)
  return res.stdout.trim()
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

    // THE RESOLUTION, as a value — which ref the substitution actually picked…
    expect(await resolvedBase(w.consumer, out.resumeDiffCommand)).toBe('origin/main')
    // …and THE OUTCOME, which is the claim that matters: one file, named. `bytes > 0`
    // because 0 is how `writeResumeDiff` reports failure, and a command that silently
    // did nothing would otherwise satisfy a file-list assertion over an empty diff.
    expect(filesInDiffFile(out.diffFile)).toEqual([BRANCH_FILE])
    expect(out.bytes).toBeGreaterThan(0)
  })

  test('PINNED: the launch-observed base sha wins over every ref, and still gives ONE file', async () => {
    const w = await seedWorld('pinned')
    const out = await runResumeDiff(w, { pr: true, baseSha: w.currentBase })
    expect(out.resumeDiffCommand).toContain(`git diff --end-of-options '${w.currentBase}'..'${w.head}'`)
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
    expect(out.resumeDiffCommand).toContain(`git diff --end-of-options '${w.staleBase}'..'${w.head}'`)
    expect(filesInDiffFile(out.diffFile)).toEqual([BRANCH_FILE, ...w.staleFiles].sort())
  })

  test('LOCAL MODE, unpinned, WITH a remote: same stale ref, same ONE file', async () => {
    // THE DEFECT LIVED HERE UNTIL THE FIFTH ROUND OF REVIEW, and the reason it survived
    // is instructive: this test asserted the COMMAND SHAPE (`toContain("git diff
    // 'main'..")`) and never the files. The fixture it runs against is the same one in
    // which the pr-mode test above proves that exact range yields FIVE files where the
    // branch changed ONE — so the evidence of the bug sat a few lines above the test
    // that could not see it. Proxy versus claim, in the last place the defect lived.
    //
    // `merge_mode: 'local'` means the OUTER LOOP MERGES LOCALLY. It does NOT mean the
    // repository has no remote, which is what the old fallback assumed.
    const w = await seedWorld('local-with-remote')
    const out = await runResumeDiff(w, { pr: false })

    expect(await resolvedBase(w.consumer, out.resumeDiffCommand)).toBe('origin/main')
    expect(filesInDiffFile(out.diffFile)).toEqual([BRANCH_FILE])
    expect(out.bytes).toBeGreaterThan(0)

    // THE BOUNDARY, stated as the numbers: the bare local ref this used to take would
    // have produced five. Asserted from git in the same repo, so the contrast is
    // measured rather than remembered.
    expect(await filesInRange(w.consumer, `main..${w.head}`)).toEqual(
      [BRANCH_FILE, ...w.staleFiles].sort(),
    )
    expect((await filesInRange(w.consumer, `main..${w.head}`)).length).toBe(STALE_COMMITS + 1)
  })

  test('NO REMOTE: the bare name is the fallback — one of the two worlds that reach it', async () => {
    // The genuine no-remote world. This name said "the only case left" and the comment
    // said "the ONLY case the bare name is used in" — contradicted by the test TWENTY LINES
    // BELOW, which reaches the same fallback with `origin` configured and only the base ref
    // missing. The condition is the REF, so there are two worlds, and a test title is a
    // claim like any other.
    // Without this the fix would be "always prefer origin/", which breaks every repo
    // that has none — and nothing in the with-remote tests above could detect that.
    const w = await seedWorld('no-remote')
    await git(w.consumer, 'remote', 'remove', 'origin')
    const refs = await git(w.consumer, 'for-each-ref', '--format=%(refname)', 'refs/remotes/')
    for (const ref of refs.split('\n').filter((r) => r !== '')) {
      await git(w.consumer, 'update-ref', '-d', ref)
    }
    expect(await git(w.consumer, 'for-each-ref', '--format=%(refname)', 'refs/remotes/')).toBe('')

    const out = await runResumeDiff(w, { pr: false })
    // The substitution asked, git said no such ref, and the bare name is what is left.
    expect(await resolvedBase(w.consumer, out.resumeDiffCommand)).toBe('main')
    // And it still produces a real diff rather than failing closed — in a repo with no
    // origin, `refs/heads/main` IS the base of record and there is no better answer.
    expect(out.bytes).toBeGreaterThan(0)
    expect(filesInDiffFile(out.diffFile)).toEqual([BRANCH_FILE, ...w.staleFiles].sort())
  })

  test('CONFIGURED ORIGIN, MISSING BASE REF: still the bare name — the condition is the REF', async () => {
    // THE SIXTH OVERCLAIM ON THIS BRANCH, and the one the no-remote fixture steps over.
    // The spec said the bare name is taken "only when the repository has no remote"; the
    // code tests whether ONE REF RESOLVES. Those are different states, and this is the
    // gap between them: `origin` configured and reachable, `refs/remotes/origin/main`
    // simply absent — the ordinary state of a worktree that has not fetched.
    //
    // Deliberately NO FETCH, here or in the product: a build worktree should not reach the
    // network to answer a diff-base question, so `refs/heads/main` is the best available
    // base and the bare name is correct.
    const w = await seedWorld('configured-origin-missing-ref')
    await git(w.consumer, 'update-ref', '-d', 'refs/remotes/origin/main')
    // The remote is STILL CONFIGURED — this is the whole point of the fixture, so assert
    // it rather than assume it, or the test silently becomes a second no-remote case.
    expect(await git(w.consumer, 'remote')).toContain('origin')
    expect(
      (await spawnCapture(['git', '-C', w.consumer, 'rev-parse', '--verify', 'refs/remotes/origin/main'], w.consumer))
        .ok,
    ).toBe(false)

    const out = await runResumeDiff(w, { pr: false })
    expect(await resolvedBase(w.consumer, out.resumeDiffCommand)).toBe('main')
    expect(out.bytes).toBeGreaterThan(0)
    expect(filesInDiffFile(out.diffFile)).toEqual([BRANCH_FILE, ...w.staleFiles].sort())
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
    expect(await resolvedBase(w.consumer, out.resumeDiffCommand)).toBe('origin/main')
    expect(filesInDiffFile(out.diffFile)).toEqual([BRANCH_FILE])
  })
})
