/**
 * AN OPTION-SHAPED BASE REF, at the binding and at every consumer (#546).
 *
 * ── THE DEFECT, AND WHY IT WAS SELF-INFLICTED ─────────────────────────
 * `originBaseResolves` declined to PROBE a name beginning with `-`. That read as a safety
 * measure and was the opposite: declining to probe returns false, false selected the
 * bare-name branch, and the bare name is the one that reaches git unguarded. A base of
 * `--output=<path>` produced the operand `--output=<path>..<head>`, which git parses as
 * the `--output` OPTION.
 *
 * **Refusing to examine a dangerous input is not refusing the input.** The guard's intent
 * was right and its placement inverted the outcome — a different failure from inferring
 * "no remote" from "merges locally" or "branch" from "resolves", where the signal itself
 * was wrong.
 *
 * ── WHAT IS ASSERTED, AND WHY IN TWO LAYERS ───────────────────────────
 *  1. THE BINDING REFUSES. `diffBaseRef` throws, so the value cannot become a rev-range
 *     operand THROUGH THAT BINDING. Not "at all" — a value that never passed through it
 *     still can, which is the whole reason layer 2 exists. This is the fix; everything
 *     below is defence in depth.
 *  2. EVERY CONSUMER CARRIES `--end-of-options`. Asserted against the SHIPPED source of
 *     `orchestrator.ts`, `inner-workflow.mjs` and the two wrappers — extracted by text,
 *     with a positive control that the extraction found the call sites, so a consumer
 *     added later without the marker fails here.
 *  3. THE MARKER IS LOAD-BEARING, proved against REAL GIT per command family: the same
 *     argv without it writes the file, with it refuses and writes nothing, and an
 *     ordinary range still works either way. Without that third layer, (2) would be a
 *     string assertion about a flag nobody had shown does anything.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fileURLToPath } from 'node:url'

import { spawnCapture } from './git-mode.ts'
import {
  diffBaseRef,
  originBaseResolves,
  TridentEmptyBaseError,
  TridentOptionShapedBaseError,
  TridentPaddedBaseError,
} from './merge.ts'

const WORKFLOW_SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

/**
 * `inner-workflow.mjs`'s `diffBase`, evaluated for one set of launch args.
 *
 * THE RULE IS IMPLEMENTED TWICE — here and in `diffBaseRef` — because the workflow script
 * takes no imports (its globals are injected by the Workflow runtime and its own header
 * says it "is NOT runnable with plain node/bun"), so the two cannot share a module. They
 * have now diverged twice: once on the merge-mode fallback, once on ORDER. This harness
 * exists so the parity table below can hold them to the same answers, which is the
 * strongest single source of truth available when the code itself cannot be one.
 *
 * Returns the base operand the workflow composed, or throws whatever the workflow threw.
 */
async function workflowDiffBase(args: {
  baseBranch: string
  baseSha?: string
  mergeMode?: 'pr' | 'local'
  repoPath?: string
}): Promise<string> {
  const RECORDED = 'a'.repeat(40)
  let captured = ''
  const agent = async (prompt: string, o?: { label?: string }): Promise<unknown> => {
    const label = o?.label ?? ''
    if (label.startsWith('head-probe-round-')) return { head: RECORDED }
    if (label === 'resume-diff') {
      captured = prompt
      // Everything after this is irrelevant to the base; stop the run rather than mock
      // the whole panel.
      throw new Error('__CAPTURED__')
    }
    return ''
  }
  const body = WORKFLOW_SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  try {
    await fn(
      agent,
      async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())),
      () => {},
      () => {},
      { total: 0, spent: () => 0 },
      {
        repoPath: args.repoPath ?? '/repo',
        task: 'x',
        baseBranch: args.baseBranch,
        slug: 'ord',
        maxRounds: 10,
        mergeMode: args.mergeMode ?? 'pr',
        prNumber: args.mergeMode === 'local' ? null : 7,
        branch: 'trident/ord',
        dbPath: '/tmp/none.db',
        runId: 'ord-1',
        resumeCheckpoint: 'forge-done',
        resumeCheckpointHead: RECORDED,
        resumeLiveHead: RECORDED,
        resumeFindings: null,
        codexHome: null,
        checkpointScript: '/repo/trident/checkpoint.sh',
        worktreeCleanupScript: '/repo/trident/worktree-cleanup.sh',
        models: { fable: 'f', opus: 'o', sonnet: 's', fast: 'h' },
        reflectionGuidance: '',
        ...(args.baseSha === undefined ? {} : { baseSha: args.baseSha }),
      },
    )
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__CAPTURED__') throw err
  }
  const m = /git diff --end-of-options (.+?)\.\.'/.exec(captured)
  if (m === null) throw new Error(`no resume-diff command captured: ${captured.slice(0, 200)}`)
  return m[1] as string
}

const GIT_ID = ['-c', 'user.name=Test Setup', '-c', 'user.email=setup@neutron.local', '-c', 'commit.gpgsign=false']

/** A probe thunk that answers `value`, and records whether it was ever invoked. */
function probe(value: boolean): (() => Promise<boolean>) & { calls: number } {
  const fn = async (): Promise<boolean> => {
    fn.calls += 1
    return value
  }
  fn.calls = 0
  return fn
}
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
  repo: string
  /** Somewhere nothing should ever be written; empty unless git was tricked. */
  target: string
  base: string
  head: string
}

async function seedWorld(label: string): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), `diff-base-option-${label}-`))
  created.push(root)
  const repo = join(root, 'repo')
  const target = join(root, 'target')
  await spawnCapture(['git', 'init', '-q', '--initial-branch=main', repo], root)
  await spawnCapture(['mkdir', '-p', target, join(repo, 'src')], root)
  writeFileSync(join(repo, 'src', 'a.txt'), 'a\n')
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'A')
  const base = await git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'src', 'a.txt'), 'b\n')
  await git(repo, ...GIT_ID, 'commit', '-qam', 'B')
  const head = await git(repo, 'rev-parse', 'HEAD')
  expect(readdirSync(target)).toEqual([])
  return { repo, target, base, head }
}

describe('the BINDING refuses an option-shaped base — it is not routed past', () => {
  test('diffBaseRef throws, whatever the probe said and whatever else is in hand', async () => {
    for (const bad of ['--output=/tmp/x', '-x', '--upload-pack=touch', '--output=/tmp/y']) {
      // Both probe answers, because the defect was that `false` selected the bare branch:
      // neither value may produce a returned string.
      for (const resolves of [true, false]) {
        await expect(diffBaseRef(bad, null, probe(resolves))).rejects.toThrow(TridentOptionShapedBaseError)
      }
      // …and a pinned sha still wins outright, since it is read before the name at all.
      expect(await diffBaseRef(bad, 'a'.repeat(40), probe(false))).toBe('a'.repeat(40))
    }
    // A PADDED option-shaped name is refused as PADDED, not as option-shaped, because the
    // whitespace guard now comes first — and this list used to contain `'  --output=/tmp/y  '`
    // asserting the option-shaped class, which only passed because the function trimmed
    // before looking. What matters is that it is refused in both implementations; which
    // refusal fires is pinned here so the ORDER of the two guards is not free to drift.
    await expect(diffBaseRef('  --output=/tmp/y  ', null, probe(false))).rejects.toThrow(
      TridentPaddedBaseError,
    )
    await expect(workflowDiffBase({ baseBranch: '  --output=/tmp/y  ' })).rejects.toThrow(
      /refusing a base branch with surrounding whitespace/,
    )
  })

  test('AN EMPTY BASE IS REFUSED — `..<head>` is a plausible wrong answer, not an error', async () => {
    // MEASURED, which the previous mitigation was not: it returned the empty value and
    // asserted "the caller's own diff will fail loudly". On git 2.43
    //   `git diff --name-only --no-renames --end-of-options '..HEAD'` → exit 0, NO OUTPUT
    //   `git rev-list --count --end-of-options '..HEAD'`              → exit 0, prints "0"
    // so nothing fails and every consumer gets a well-formed wrong answer. Asserted below
    // against real git, because a test that only checked the throw would be resting on the
    // same unmeasured belief the fix is replacing.
    const w = await seedWorld('empty-base')
    const diff = await spawnCapture(
      ['git', '-C', w.repo, 'diff', '--name-only', '--no-renames', '--end-of-options', `..${w.head}`],
      w.repo,
    )
    expect({ ok: diff.ok, out: diff.stdout.trim() }).toEqual({ ok: true, out: '' })
    const count = await spawnCapture(
      ['git', '-C', w.repo, 'rev-list', '--count', '--end-of-options', `..${w.head}`],
      w.repo,
    )
    expect({ ok: count.ok, out: count.stdout.trim() }).toEqual({ ok: true, out: '0' })

    // So it is refused at the binding — in BOTH implementations, and for whitespace too.
    for (const empty of ['', '   ', '\t']) {
      for (const resolves of [true, false]) {
        await expect(diffBaseRef(empty, null, probe(resolves))).rejects.toThrow(TridentEmptyBaseError)
      }
    }
    await expect(workflowDiffBase({ baseBranch: '', repoPath: w.repo })).rejects.toThrow(
      /refusing an empty base branch/,
    )

    // …and a PIN still wins, because the pin is read before the name. Same ordering the
    // option-shaped case needed.
    const sha = 'e'.repeat(40)
    expect(await diffBaseRef('', sha, probe(false))).toBe(sha)
    expect(await workflowDiffBase({ baseBranch: '', baseSha: sha, repoPath: w.repo })).toBe(`'${sha}'`)
  })

  test('ORDER: a valid PIN wins before the name is examined — in BOTH implementations', async () => {
    // THE REGRESSION THIS PINS. The first version of the `.mjs` guard threw at module
    // scope, BEFORE `pinnedBase` was consulted — so a run with a valid 40-hex pin and an
    // option-shaped base branch failed, even though the pin means the name is never read
    // and never reaches git. `diffBaseRef` returned the pin first; the same rule,
    // implemented twice, disagreed about ORDER.
    //
    // That is the mirror of the defect the guard was added for: there a `-` check refused
    // to EXAMINE a value and let it through; here it refused the whole call over a value
    // already superseded. Validate on the path where the value is used.
    //
    // Asserted in BOTH implementations in one test, because covering only `diffBaseRef`
    // is precisely how the divergence survived.
    const sha = 'b'.repeat(40)
    expect(await diffBaseRef('--output=/tmp/x', sha, probe(false))).toBe(sha)
    expect(await workflowDiffBase({ baseBranch: '--output=/tmp/x', baseSha: sha })).toBe(`'${sha}'`)
  })

  test('ORDER: with NO pin, both refuse the same name', async () => {
    await expect(diffBaseRef('--output=/tmp/x', null, probe(false))).rejects.toThrow(
      TridentOptionShapedBaseError,
    )
    await expect(workflowDiffBase({ baseBranch: '--output=/tmp/x' })).rejects.toThrow(
      /would read as an option, not a revision/,
    )
  })

  test('THE COMPLEMENT: an ordinary name is unaffected in both directions', async () => {
    expect(await diffBaseRef('main', null, probe(true))).toBe('origin/main')
    expect(await diffBaseRef('main', null, probe(false))).toBe('main')
    expect(await diffBaseRef('release/1.x', null, probe(true))).toBe('origin/release/1.x')
  })

  test('THE PROBE IS NOT EVEN CALLED when the pin is valid — asserted as an ABSENT side effect', async () => {
    // THE ROUND-ELEVEN DEFECT, one layer out from round eight's. The third parameter was a
    // `boolean`, so every caller wrote `diffBaseRef(base, sha, await originBaseResolves(…))`
    // and JavaScript evaluated that BEFORE the function could return the pin: the probe
    // fired on every pinned dispatch, and a pinned dispatch failed whenever the probe did —
    // having already held everything it needed.
    //
    // The result stayed correct, so no value assertion could see it. An ordering over
    // inputs is only visible from outside as a side effect that did NOT happen, which is
    // what these two assert.
    const pinned = probe(true)
    expect(await diffBaseRef('main', 'd'.repeat(40), pinned)).toBe('d'.repeat(40))
    expect(pinned.calls).toBe(0)

    // …and both refusals also short-circuit it: a name that cannot be a revision is not
    // worth a subprocess.
    for (const bad of ['', '--output=/tmp/x']) {
      const skipped = probe(true)
      await expect(diffBaseRef(bad, null, skipped)).rejects.toThrow()
      expect({ bad, calls: skipped.calls }).toEqual({ bad, calls: 0 })
    }

    // THE COMPLEMENT: with no pin and a usable name, the probe IS issued — exactly once.
    const used = probe(false)
    expect(await diffBaseRef('main', null, used)).toBe('main')
    expect(used.calls).toBe(1)
  })

  test('the probe still declines to spend a subprocess on such a name', async () => {
    // Kept, but no longer load-bearing for safety — and asserted so that a future reader
    // does not restore the old belief that THIS is what protects the consumers.
    let calls = 0
    const spy = async (): Promise<never> => {
      calls += 1
      throw new Error('should not be reached')
    }
    expect(await originBaseResolves(spy, '/repo', '--output=/tmp/x')).toBe(false)
    expect(calls).toBe(0)
  })
})

describe('THE TWO IMPLEMENTATIONS OF THE RULE AGREE — a parity table', () => {
  /**
   * `diffBaseRef` (TS) and `diffBase` (.mjs) encode the same rule and cannot share a
   * module: the workflow script takes no imports. They have diverged twice — the
   * merge-mode fallback, then the pin/validate ORDER — each time caught by review rather
   * than by a test, because each implementation was only ever tested on its own.
   *
   * This table is the answer to "can they be made one": not as code, but they can be held
   * to one set of answers. Every row asserts BOTH, so a change to either alone reds here.
   *
   * The `.mjs` answer is a SHELL WORD, so it is evaluated in a real repository to compare
   * with the TS answer — which is also the only way to check that the substitution resolves
   * to what the TS branch would have picked.
   */
  async function bothAgree(
    w: World,
    row: { baseBranch: string; baseSha?: string; originResolves: boolean; mergeMode?: 'pr' | 'local' },
  ): Promise<{ ts: string; mjs: string }> {
    const ts = await diffBaseRef(row.baseBranch, row.baseSha ?? null, probe(row.originResolves))
    const composed = await workflowDiffBase({
      baseBranch: row.baseBranch,
      repoPath: w.repo,
      ...(row.mergeMode === undefined ? {} : { mergeMode: row.mergeMode }),
      ...(row.baseSha === undefined ? {} : { baseSha: row.baseSha }),
    })
    // Evaluate the composed word in the fixture — a quoted literal for the pinned arm, a
    // substitution for the unpinned one.
    const res = await spawnCapture(['bash', '-c', `printf %s ${composed}`], w.repo)
    return { ts, mjs: res.stdout.trim() }
  }

  test('pinned sha wins for every name, including one the unpinned arm would refuse', async () => {
    const w = await seedWorld('parity-pinned')
    await git(w.repo, 'update-ref', 'refs/remotes/origin/main', w.base)
    const sha = 'c'.repeat(40)
    for (const baseBranch of ['main', 'release/1.x', '--output=/tmp/x']) {
      const got = await bothAgree(w, { baseBranch, baseSha: sha, originResolves: true })
      expect({ baseBranch, ...got }).toEqual({ baseBranch, ts: sha, mjs: sha })
    }
  })

  test('unpinned, origin/<base> RESOLVES: both pick origin/<base>, IN EITHER MERGE MODE', async () => {
    // BOTH MODES, because the FIRST divergence between these two implementations was
    // exactly a merge-mode-keyed fallback in the `.mjs` — and a table that only ran `pr`
    // would not have caught it. Verified by mutation: reintroducing that fallback reds
    // this row.
    const w = await seedWorld('parity-origin')
    await git(w.repo, 'update-ref', 'refs/remotes/origin/main', w.base)
    for (const mergeMode of ['pr', 'local'] as const) {
      const got = await bothAgree(w, { baseBranch: 'main', originResolves: true, mergeMode })
      expect({ mergeMode, ...got }).toEqual({ mergeMode, ts: 'origin/main', mjs: 'origin/main' })
    }
  })

  test('unpinned, origin/<base> MISSING: both fall back to the bare name, in either mode', async () => {
    const w = await seedWorld('parity-no-origin')
    // No `refs/remotes/origin/main` in this fixture at all.
    for (const mergeMode of ['pr', 'local'] as const) {
      const got = await bothAgree(w, { baseBranch: 'main', originResolves: false, mergeMode })
      expect({ mergeMode, ...got }).toEqual({ mergeMode, ts: 'main', mjs: 'main' })
    }
  })

  test('unpinned, EMPTY: both REFUSE — the axis the option-shaped rows stepped over', async () => {
    // The option-shaped rows vary HOSTILE vs ORDINARY and hold EMPTY constant, which is
    // exactly the blind spot the axes lesson names: a matrix proves nothing about an axis
    // it holds constant, and the axis you hold constant is usually the one you did not
    // notice you were choosing.
    const w = await seedWorld('parity-empty')
    await expect(diffBaseRef('', null, probe(false))).rejects.toThrow(TridentEmptyBaseError)
    await expect(workflowDiffBase({ baseBranch: '', repoPath: w.repo })).rejects.toThrow(
      /refusing an empty base branch/,
    )
  })

  test('unpinned, SURROUNDING WHITESPACE: both REFUSE — the axis this table held constant', async () => {
    // THE THIRD DIVERGENCE, and the one this table was built to catch and did not.
    //
    // `diffBaseRef` trimmed before probing and returning; the `.mjs` trimmed only to
    // validate and built its probe and its fallback from the value as given. So `" main "`
    // used to answer `origin/main` in TS and `" main "` in the workflow — a production input,
    // since `resolveBase()` returns `opts.base_branch` verbatim. The rows above vary
    // pinned/unpinned, resolves/missing, both merge modes, empty and option-shaped, AND HOLD
    // WHITESPACE CONSTANT: a matrix proves nothing about an axis it holds constant, and the
    // axis you hold constant is usually the one you did not notice you were choosing. The
    // instrument built to catch divergence had the same blind spot as the code.
    //
    // Neither side trims now, so this row asserts a REFUSAL rather than a normalised answer.
    // Mutation: restore `const name = base_branch.trim()` in `diffBaseRef` and this reds on
    // the TS side; drop the workflow's whitespace guard and it reds on the mjs side.
    const w = await seedWorld('parity-padded')
    await git(w.repo, 'update-ref', 'refs/remotes/origin/main', w.base)
    for (const padded of [' main', 'main ', ' main ', '\tmain', 'main\n']) {
      for (const resolves of [true, false]) {
        await expect(diffBaseRef(padded, null, probe(resolves))).rejects.toThrow(TridentPaddedBaseError)
      }
      for (const mergeMode of ['pr', 'local'] as const) {
        await expect(workflowDiffBase({ baseBranch: padded, repoPath: w.repo, mergeMode })).rejects.toThrow(
          /refusing a base branch with surrounding whitespace/,
        )
      }
    }
    // THE COMPLEMENT, so this is not just "everything throws": the same name unpadded is
    // answered, identically, by both — in the same fixture, where `origin/main` resolves.
    const got = await bothAgree(w, { baseBranch: 'main', originResolves: true })
    expect(got).toEqual({ ts: 'origin/main', mjs: 'origin/main' })
    // …and a PIN still wins over a padded name in both, because the pin is read first.
    const sha = 'f'.repeat(40)
    expect(await diffBaseRef(' main ', sha, probe(false))).toBe(sha)
    expect(await workflowDiffBase({ baseBranch: ' main ', baseSha: sha, repoPath: w.repo })).toBe(`'${sha}'`)
  })

  test('unpinned, option-shaped: both REFUSE rather than answering', async () => {
    const w = await seedWorld('parity-refuse')
    await expect(diffBaseRef('--output=/tmp/x', null, probe(false))).rejects.toThrow(
      TridentOptionShapedBaseError,
    )
    await expect(workflowDiffBase({ baseBranch: '--output=/tmp/x', repoPath: w.repo })).rejects.toThrow(
      /would read as an option, not a revision/,
    )
  })
})

describe('EVERY interpolated git rev-range in the shipped modules carries --end-of-options', () => {
  /**
   * ── WHY THIS IS KEYED TO BEHAVIOUR AND NOT TO A NAME ──────────────────
   * The version that shipped for thirteen rounds searched `orchestrator.ts` for
   * `${baseRef}..` and pinned FOUR call sites. `computeDiffLineCount` spells the same value
   * `base_ref`, so it was invisible to the coverage test that existed to find it — and it
   * went to review with no `--end-of-options`, which means an operand of `--output=/tmp/pwn`
   * made git write that file and exit 0. `mutation-prover.ts` escaped twice over: a
   * THREE-dot range, spread across its own argv lines.
   *
   * So the rule is a `..`/`...` RANGE OPERATOR adjacent to an INTERPOLATION, in any of the
   * shipped modules, with no reference to what the operand is called.
   *
   * ── AND WHY ATTRIBUTION IS PARSED, NOT GUESSED FROM PROXIMITY ─────────
   * The first version of THAT fix decided a range was shielded if `--end-of-options`
   * appeared anywhere in the twelve preceding lines. A protected command one to twelve lines
   * above an unprotected one therefore shielded it — the marker was attributed to a command
   * it does not belong to, and the acceptance claim went back to being unenforced. **A
   * coverage test that infers structure from line proximity is measuring LAYOUT, not
   * syntax**; twelve lines is a guess about formatting, and formatting is not a property of
   * the call.
   *
   * The attribution here is the command itself: from the nearest preceding `git` TOKEN to
   * the range operand — which is the argv array for
   * `['git', …, '--end-of-options', `${x}..${y}`]`, including the multi-line form, and the
   * shell command for a range inside a prompt string. A hit with no `git` token within
   * `MAX_ATTRIBUTION` characters is UNATTRIBUTABLE and fails: an unattributable case is a
   * failure, never a pass.
   *
   * Comments are blanked first (length-preserving, so offsets and line numbers survive),
   * because the round that shielded these sites wrote `--end-of-options` in the comment
   * above each one — an instrument that reads its own documentation as evidence measures
   * nothing, and that is not hypothetical: it is why the first three mutations passed.
   */
  const MODULES = [
    'orchestrator.ts',
    'inner-workflow.mjs',
    'merge.ts',
    'mutation-prover.ts',
    'mutation-claim-artifact.ts',
    'codex-build.sh',
    'codex-review.sh',
  ] as const

  /**
   * An interpolated operand touching the range operator: `` `${x}..` `` or `` `..${x}` ``.
   * Spelling-independent by construction. It also matches `...`, since `}..` is a prefix of
   * `}...` (how `mutation-prover.ts` spells its blast-radius range).
   */
  const RANGE = /\}\.\.|\.\.\$\{/

  /**
   * How far back a `git` token may be and still be this range's command. The real maximum in
   * the tree is 468 characters (`mutation-prover.ts`'s multi-line argv); the three
   * operator-facing NOTES that merely describe a range sit 1205-1587 characters from any
   * `git`, so the bound also separates prose from commands on evidence rather than by
   * assertion.
   */
  const MAX_ATTRIBUTION = 600

  /**
   * Hits that are NOT git invocations, each argued. A hit that is neither shielded nor
   * listed here fails, so adding prose about a range is also a deliberate act.
   */
  const NON_INVOCATIONS: ReadonlyArray<{ file: string; needle: string; why: string }> = [
    {
      file: 'mutation-claim-artifact.ts',
      needle: 'could not be read',
      why: 'an operator-facing note naming the range that failed; never argv',
    },
    {
      file: 'mutation-claim-artifact.ts',
      needle: 'is empty — this branch changes no file',
      why: 'the same note for the empty-diff answer',
    },
    {
      file: 'mutation-claim-artifact.ts',
      needle: 'is not in the diff',
      why: 'the same note for a path outside the diff',
    },
    {
      file: 'codex-review.sh',
      needle: 'DIFF_SRC=',
      why: 'a label recorded for the trailer; the invocation is the line above it',
    },
  ]

  interface Hit {
    file: string
    line: number
    text: string
    /** The marker is in THIS range's own command. */
    shielded: boolean
    /** No `git` token close enough to attribute the range to a command at all. */
    attributed: boolean
    excused: string | null
  }

  /**
   * `line` with its comment blanked to spaces — same length, so offsets stay aligned.
   *
   * A `//` or `#` inside a string literal is not a comment opener, so quotes are tracked;
   * this is the same hazard `scripts/ci/diff-base-check.mjs` has for its exemption marker,
   * where a `" //` in data used to satisfy the opener test.
   */
  function blankComment(line: string): string {
    const pad = (from: number): string => line.slice(0, from) + ' '.repeat(line.length - from)
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return pad(0)
    let quote: string | null = null
    for (let i = 0; i < line.length; i++) {
      const c = line[i] as string
      if (c === '\\') {
        i += 1
        continue
      }
      if (quote !== null) {
        if (c === quote) quote = null
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        quote = c
        continue
      }
      const boundary = i === 0 || /\s/.test(line[i - 1] as string)
      if (c === '/' && line[i + 1] === '/' && boundary) return pad(i)
      if (c === '#' && boundary) return pad(i)
    }
    return line
  }

  /** Every interpolated range in `source`, each attributed to its own git command. */
  function scan(file: string, source: string): Hit[] {
    const blanked = source.split('\n').map(blankComment)
    const text = blanked.join('\n')
    const offsets: number[] = []
    let at = 0
    for (const l of blanked) {
      offsets.push(at)
      at += l.length + 1
    }
    const hits: Hit[] = []
    blanked.forEach((line, i) => {
      const m = RANGE.exec(line)
      if (m === null) return
      const index = (offsets[i] as number) + m.index
      // THE COMMAND, found by parsing backwards for its `git` token rather than by counting
      // lines. `lastIndexOf` over the blanked text, so a `git` inside a comment cannot be it.
      const before = text.slice(0, index)
      let gitAt = -1
      for (const g of before.matchAll(/\bgit\b/g)) gitAt = g.index
      const attributed = gitAt !== -1 && index - gitAt <= MAX_ATTRIBUTION
      const command = attributed ? text.slice(gitAt, index) : ''
      hits.push({
        file,
        line: i + 1,
        text: line.trim(),
        shielded: attributed && command.includes('--end-of-options'),
        attributed,
        excused: NON_INVOCATIONS.find((n) => n.file === file && line.includes(n.needle))?.why ?? null,
      })
    })
    return hits
  }

  /** The shipped tree. */
  function rangeHits(): Hit[] {
    return MODULES.flatMap((file) => scan(file, readFileSync(join(import.meta.dir, file), 'utf8')))
  }

  /** Offenders as the test reports them: unshielded or unattributable, and not excused. */
  function offenders(hits: Hit[]): string[] {
    return hits
      .filter((h) => h.excused === null && (!h.attributed || !h.shielded))
      .map((h) => `${h.file}:${h.line} ${h.attributed ? 'UNSHIELDED' : 'UNATTRIBUTABLE'} ${h.text.slice(0, 70)}`)
  }

  test('every hit is either shielded in its OWN command or an argued non-invocation', () => {
    const hits = rangeHits()
    // PINNED COUNTS, per file, because "all of them are shielded" is vacuous if the matcher
    // found none — and because the comment blanking could otherwise swallow a range
    // silently. The old block pinned 4 in one file; this is the whole surface.
    const perFile: Record<string, number> = {}
    for (const h of hits) perFile[h.file] = (perFile[h.file] ?? 0) + 1
    expect(perFile).toEqual({
      'orchestrator.ts': 9,
      'inner-workflow.mjs': 4,
      'merge.ts': 1,
      'mutation-prover.ts': 1,
      'mutation-claim-artifact.ts': 3,
      'codex-build.sh': 1,
      'codex-review.sh': 2,
    })
    expect(offenders(hits)).toEqual([])
    // Every excused hit carries a stated reason, so the escape hatch cannot be used silently.
    for (const h of hits.filter((x) => x.excused !== null)) {
      expect({ site: `${h.file}:${h.line}`, why: (h.excused ?? '').length > 20 }).toEqual({
        site: `${h.file}:${h.line}`,
        why: true,
      })
    }
  })

  test('A PROTECTED COMMAND DOES NOT SHIELD THE NEXT ONE — through the real detector', () => {
    // THE CONTROL THE PROXIMITY VERSION DID NOT HAVE, and could not have had: its control
    // used a separate per-line filter, so it proved that *a* detector works, not that *this*
    // detector does. Two different code paths, and only one of them is the guard. This
    // fixture goes through `scan()` itself.
    const fixture = [
      'const first = await run_host(',
      "  ['git', '-C', repo, 'diff', '--name-only', '--end-of-options', `${goodBase}..HEAD`],",
      '  repo,',
      ')',
      'const second = await run_host(',
      "  ['git', '-C', repo, 'diff', '--numstat', `${otherBase}..HEAD`],",
      '  repo,',
      ')',
    ].join('\n')
    const hits = scan('fixture.ts', fixture)
    expect(hits.map((h) => ({ line: h.line, shielded: h.shielded }))).toEqual([
      { line: 2, shielded: true },
      { line: 6, shielded: false },
    ])
    expect(offenders(hits)).toEqual(['fixture.ts:6 UNSHIELDED ' + "['git', '-C', repo, 'diff', '--numstat', `${otherBase}..HEAD`],"])

    // THE COMPLEMENT, so a detector that refuses everything cannot pass: shield the second
    // command and the same fixture is clean.
    const fixed = fixture.replace("'--numstat',", "'--numstat', '--end-of-options',")
    expect(offenders(scan('fixture.ts', fixed))).toEqual([])
  })

  test('a range with no git command near it is UNATTRIBUTABLE, which fails rather than passes', () => {
    // The other half of parsing rather than guessing: if the detector cannot say which
    // command a range belongs to, it must not decide it is fine. `x`-padding puts the only
    // `git` token further away than MAX_ATTRIBUTION.
    const far = `const cmd = 'git diff'\n${'// x\n'.repeat(0)}${'const filler = "' + 'x'.repeat(MAX_ATTRIBUTION + 50) + '"\n'}const r = \`\${someBase}..HEAD\``
    const hits = scan('fixture.ts', far)
    expect(hits.map((h) => ({ line: h.line, attributed: h.attributed }))).toEqual([{ line: 3, attributed: false }])
    expect(offenders(hits)).toEqual(['fixture.ts:3 UNATTRIBUTABLE ' + 'const r = `${someBase}..HEAD`'])
  })

  test('a git token inside a COMMENT cannot attribute or shield a range', () => {
    // Why the blanking exists. Without it, this comment's `git diff --end-of-options` is the
    // nearest preceding `git` token and the range below reads as shielded — which is exactly
    // how the first version of this fix passed all three of its mutations.
    const fixture = [
      '// the shipped form is `git diff --end-of-options ${base}..HEAD`',
      "const cmd = ['git', '-C', repo, 'diff', `${plainBase}..HEAD`]",
    ].join('\n')
    const hits = scan('fixture.ts', fixture)
    expect(hits.map((h) => ({ line: h.line, shielded: h.shielded, attributed: h.attributed }))).toEqual([
      { line: 2, shielded: false, attributed: true },
    ])
  })

  test('POSITIVE CONTROL: a new consumer under a THIRD spelling is caught', () => {
    // `whicheverNameIFeelLike` appears nowhere in the codebase, which is the case that
    // defeated the previous instrument. Measured for real too: planting this function in
    // `orchestrator.ts` reds the first test in this block, and removing it goes clean.
    const planted = [
      'const res = await run_host(',
      "  ['git', '-C', repo, 'diff', '--numstat', `${whicheverNameIFeelLike}..${tipOid}`],",
      '  repo,',
      ')',
    ].join('\n')
    expect(offenders(scan('fixture.ts', planted)).length).toBe(1)
    // …and a THREE-dot range on its own argv line, the `mutation-prover.ts` shape.
    const threeDot = ["const a = ['git', '-C', repo, 'diff', '-z', '--name-status',", '  `${someOtherName}...${revision}`,', ']'].join('\n')
    expect(offenders(scan('fixture.ts', threeDot)).length).toBe(1)
  })

  test('the population really does span several spellings — the proof the name is irrelevant', () => {
    const texts = rangeHits().map((h) => h.text)
    // Each of these is the SAME KIND of value under a different name. A matcher keyed to any
    // one of them would report a clean tree while the others went unshielded.
    for (const spelling of ['base_ref', 'baseRef', 'BASE_DIFF_REF', 'BASE_REF', 'seenPin', 'base_sha', 'diffBase']) {
      expect({ spelling, present: texts.some((t) => t.includes(spelling)) }).toEqual({ spelling, present: true })
    }
  })

  test('the two wrappers each take the base as argv and diff with it', () => {
    for (const [file, needle] of [
      ['codex-build.sh', 'git diff --end-of-options "${BASE_DIFF_REF}..HEAD"'],
      ['codex-review.sh', 'FULL_DIFF=$(git diff --end-of-options "${BASE_REF}..HEAD"'],
    ] as const) {
      const src = readFileSync(join(import.meta.dir, file), 'utf8')
      expect({ file, present: src.includes(needle) }).toEqual({ file, present: true })
    }
  })
})

describe('the marker is LOAD-BEARING — measured per command family, against real git', () => {
  /**
   * Run `argv` in the fixture; report the exit, everything it wrote into `target`, and —
   * the assertion that actually matters — whatever it wrote under the SMUGGLED path.
   *
   * The distinction is load-bearing and the first draft of these tests missed it: a
   * guarded `git diff --output=<intended>` still creates <intended> before refusing the
   * operand, so "wrote nothing at all" is the wrong claim. What must be empty is the
   * attacker's path, never the command's own legitimate output.
   */
  async function run(w: World, argv: string[]): Promise<{ ok: boolean; wrote: string[]; smuggled: string[] }> {
    const res = await spawnCapture(['git', '-C', w.repo, ...argv], w.repo)
    const wrote = readdirSync(w.target)
    return { ok: res.ok, wrote, smuggled: wrote.filter((f) => f.startsWith('pwned')) }
  }

  test('git diff --name-only: unguarded WRITES and exits 0; guarded refuses', async () => {
    const w = await seedWorld('diff-name-only')
    const hostile = `--output=${join(w.target, 'pwned')}..${w.head}`

    const unguarded = await run(w, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', hostile])
    // The silent shape: git is perfectly happy and the smuggled file appears.
    expect({ ok: unguarded.ok, smuggled: unguarded.smuggled.length }).toEqual({ ok: true, smuggled: 1 })

    rmSync(join(w.target, unguarded.smuggled[0] as string))
    const guarded = await run(w, [
      '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '--end-of-options', hostile,
    ])
    expect({ ok: guarded.ok, smuggled: guarded.smuggled }).toEqual({ ok: false, smuggled: [] })

    // COMPLEMENT: an ordinary range still works WITH the marker, so the shield is not
    // simply breaking the command.
    const fine = await spawnCapture(
      ['git', '-C', w.repo, 'diff', '--name-only', '--no-renames', '--end-of-options', `${w.base}..${w.head}`],
      w.repo,
    )
    expect({ ok: fine.ok, out: fine.stdout.trim() }).toEqual({ ok: true, out: 'src/a.txt' })
  })

  test('git diff --output=<file>: unguarded honours BOTH outputs; guarded refuses', async () => {
    const w = await seedWorld('diff-output')
    const legit = join(w.target, 'legit.diff')
    const hostile = `--output=${join(w.target, 'pwned')}..${w.head}`

    const unguarded = await run(w, ['diff', `--output=${legit}`, hostile])
    // git honours BOTH `--output`s: the intended file and the smuggled one.
    expect({ ok: unguarded.ok, wrote: unguarded.wrote.length, smuggled: unguarded.smuggled.length }).toEqual({
      ok: true,
      wrote: 2,
      smuggled: 1,
    })

    for (const f of unguarded.wrote) rmSync(join(w.target, f))
    const guarded = await run(w, ['diff', `--output=${legit}`, '--end-of-options', hostile])
    // It refuses, and the SMUGGLED path stays empty. `legit.diff` is created before the
    // refusal — the command's own output, which is not what this is protecting.
    expect({ ok: guarded.ok, smuggled: guarded.smuggled }).toEqual({ ok: false, smuggled: [] })

    const fine = await run(w, ['diff', `--output=${legit}`, '--end-of-options', `${w.base}..${w.head}`])
    expect({ ok: fine.ok, wrote: fine.wrote }).toEqual({ ok: true, wrote: ['legit.diff'] })
  })

  test('git diff with PATHSPECS (the grouped artifact diff): same, with `--` present', async () => {
    // `--` already ends the PATHSPECS, not the options — which is exactly why it does not
    // help here, and why this shape needed the marker too.
    const w = await seedWorld('diff-grouped')
    const part = join(w.target, 'part.diff')
    const hostile = `--output=${join(w.target, 'pwned')}..${w.head}`

    const unguarded = await run(w, ['diff', `--output=${part}`, hostile, '--', ':(literal)src/a.txt'])
    expect({ ok: unguarded.ok, smuggled: unguarded.smuggled.length }).toEqual({ ok: true, smuggled: 1 })

    for (const f of unguarded.wrote) rmSync(join(w.target, f))
    const guarded = await run(w, [
      'diff', `--output=${part}`, '--end-of-options', hostile, '--', ':(literal)src/a.txt',
    ])
    expect({ ok: guarded.ok, smuggled: guarded.smuggled }).toEqual({ ok: false, smuggled: [] })

    const fine = await run(w, [
      'diff', `--output=${part}`, '--end-of-options', `${w.base}..${w.head}`, '--', ':(literal)src/a.txt',
    ])
    expect({ ok: fine.ok, wrote: fine.wrote }).toEqual({ ok: true, wrote: ['part.diff'] })
    expect(readFileSync(part, 'utf8')).toContain('src/a.txt')
  })

  test('git rev-list --count: unguarded writes the file EVEN THOUGH it errors', async () => {
    // The shape that would have looked safe from the exit code alone — non-zero, and the
    // file is there anyway. Checking `ok` and not the filesystem would have missed it.
    const w = await seedWorld('rev-list')
    const hostile = `--output=${join(w.target, 'pwned')}..${w.head}`

    const unguarded = await run(w, ['rev-list', '--count', hostile])
    expect({ ok: unguarded.ok, smuggled: unguarded.smuggled.length }).toEqual({ ok: false, smuggled: 1 })

    rmSync(join(w.target, unguarded.smuggled[0] as string))
    const guarded = await run(w, ['rev-list', '--count', '--end-of-options', hostile])
    expect({ ok: guarded.ok, smuggled: guarded.smuggled }).toEqual({ ok: false, smuggled: [] })

    const fine = await spawnCapture(
      ['git', '-C', w.repo, 'rev-list', '--count', '--end-of-options', `${w.base}..${w.head}`],
      w.repo,
    )
    expect({ ok: fine.ok, out: fine.stdout.trim() }).toEqual({ ok: true, out: '1' })
  })

  test('and nothing was written anywhere the guarded commands ran', async () => {
    const w = await seedWorld('sweep')
    const hostile = `--output=${join(w.target, 'pwned')}..${w.head}`
    for (const argv of [
      ['diff', '--name-only', '--end-of-options', hostile],
      ['diff', '--output=' + join(w.target, 'x.diff'), '--end-of-options', hostile],
      ['rev-list', '--count', '--end-of-options', hostile],
    ]) {
      await run(w, argv)
    }
    expect(existsSync(join(w.target, 'pwned'))).toBe(false)
    expect(readdirSync(w.target).filter((f) => f.startsWith('pwned'))).toEqual([])
  })
})
