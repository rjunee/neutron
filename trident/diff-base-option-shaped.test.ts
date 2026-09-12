/**
 * AN OPTION-SHAPED BASE REF, at the binding and at every consumer (#546).
 *
 * ── THE DEFECT, AND WHY IT WAS SELF-INFLICTED ─────────────────────────
 * `refResolves` (then `originBaseResolves`) declined to PROBE a name beginning with `-`. That read as a safety
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
  refResolves,
  TridentEmptyBaseError,
  TridentOptionShapedBaseError,
  TridentPaddedBaseError,
  TridentUnresolvableBaseError,
} from './merge.ts'
import { gitRangeArgv, type GitRangeArgv } from './git-range.ts'

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

/**
 * A probe that answers for a REF and records what it was asked.
 *
 * `boolean` answers everything the same way — which is what the whole suite meant while the
 * probe took no argument. A predicate answers per ref, which is what the FALLBACK arm needs:
 * `refs/remotes/origin/<base>` missing and `refs/heads/<base>` present is a different world
 * from both missing, and until round eighteen the binding could not tell them apart.
 */
function probe(
  value: boolean | ((ref: string) => boolean),
): ((ref: string) => Promise<boolean>) & { calls: number; asked: string[] } {
  const fn = async (ref: string): Promise<boolean> => {
    fn.calls += 1
    fn.asked.push(ref)
    return typeof value === 'boolean' ? value : value(ref)
  }
  fn.calls = 0
  fn.asked = [] as string[]
  return fn
}
/** Answers only for the local branch — the no-remote world. */
const headsOnly = (base: string) => (ref: string): boolean => ref === `refs/heads/${base}`
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
    expect(await diffBaseRef('main', null, probe(true))).toBe('refs/remotes/origin/main')
    // THE FALLBACK IS QUALIFIED TOO: no remote-tracking ref, but the local branch exists.
    expect(await diffBaseRef('main', null, probe(headsOnly('main')))).toBe('refs/heads/main')
    // …and when NEITHER resolves the binding REFUSES. The bare name is not inert: git resolves
    // it against every namespace and a same-named TAG answers to it — this repository holds a
    // live one (`archive/agent-replies-prior-iter-3b35767` is a tag and no branch), so handing
    // back the word would have computed a review against it, exit 0.
    await expect(diffBaseRef('main', null, probe(false))).rejects.toThrow(TridentUnresolvableBaseError)
    expect(await diffBaseRef('release/1.x', null, probe(true))).toBe('refs/remotes/origin/release/1.x')
    expect(await diffBaseRef('release/1.x', null, probe(headsOnly('release/1.x')))).toBe('refs/heads/release/1.x')
    // THE ORDER OF THE TWO QUESTIONS, asserted as the sequence asked: the remote-tracking ref
    // first, the local branch only when that one says no.
    const asked = probe(false)
    await expect(diffBaseRef('main', null, asked)).rejects.toThrow(TridentUnresolvableBaseError)
    expect(asked.asked).toEqual(['refs/remotes/origin/main', 'refs/heads/main'])
    const stops = probe(true)
    await diffBaseRef('main', null, stops)
    expect(stops.asked).toEqual(['refs/remotes/origin/main'])
  })

  test('NO RETURN STATEMENT HANDS BACK AN UNQUALIFIED NAME — read off the shipped source', async () => {
    // THE TERMINATING CONDITION, made checkable instead of argued. Three rounds put one defect
    // in three positions — the qualified path, the `refs/heads` fallback, then the no-ref
    // fallback — and each fix left the next-worse path holding the original behaviour. The
    // sequence ends only when the last fallback stops returning a value at all, so this reads
    // the function's OWN returns and requires every one to be a sha or a fully qualified ref.
    const src = readFileSync(join(import.meta.dir, 'merge.ts'), 'utf8')
    const start = src.indexOf('export async function diffBaseRef(')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('\n}', start)
    expect(end).toBeGreaterThan(start)
    const body = src
      .slice(start, end)
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    // ANYWHERE on the line, not just at its start: the two qualified returns are written
    // `if (await ref_resolves(…)) return \`refs/…\``, and an anchored pattern walked straight
    // past them — which would also have walked past `if (x) return name`. The instrument had
    // the same blind spot as the code it checks, one more time.
    const returns = [...body.matchAll(/\b(?:return|throw)\s+([^\n]+)/g)].map((m) => (m[1] as string).trim())
    // The extraction must have found ALL of them — the pin, two qualified returns and four
    // refusals — or this asserts nothing. Pinned as a count so a new arm cannot slip in
    // unexamined.
    expect(returns.length).toBe(7)
    for (const r of returns) {
      const qualified =
        r.includes('base_sha.trim().toLowerCase()') || // the 40-hex pin
        r.includes('`refs/remotes/origin/${name}`') ||
        r.includes('`refs/heads/${name}`') ||
        r.startsWith('new Trident') // a refusal returns nothing at all
      expect({ r, qualified }).toEqual({ r, qualified: true })
    }
    // And specifically: no `return name`, in any spelling. That exact statement is what the
    // last three rounds kept re-introducing one arm further down.
    expect(body).not.toMatch(/^\s*return name\s*$/m)
  })

  test('THE PROBE IS NOT EVEN CALLED when the pin is valid — asserted as an ABSENT side effect', async () => {
    // THE ROUND-ELEVEN DEFECT, one layer out from round eight's. The third parameter was a
    // `boolean`, so every caller wrote `diffBaseRef(base, sha, await refResolves(…))`
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

    // THE COMPLEMENT: with no pin and a usable name, the probe IS issued — once for the
    // remote-tracking ref, and a second time for the local branch only because the first
    // said no. Asserted as the SEQUENCE, not a count: "one call" stopped being the right
    // shape when the fallback gained its own question, and a count would have hidden which
    // question was asked.
    const resolving = probe(true)
    expect(await diffBaseRef('main', null, resolving)).toBe('refs/remotes/origin/main')
    expect(resolving.asked).toEqual(['refs/remotes/origin/main'])
    const falling = probe(false)
    await expect(diffBaseRef('main', null, falling)).rejects.toThrow(TridentUnresolvableBaseError)
    expect(falling.asked).toEqual(['refs/remotes/origin/main', 'refs/heads/main'])
  })

  test('the probe still declines to spend a subprocess on such a name', async () => {
    // Kept, but no longer load-bearing for safety — and asserted so that a future reader
    // does not restore the old belief that THIS is what protects the consumers.
    let calls = 0
    const spy = async (): Promise<never> => {
      calls += 1
      throw new Error('should not be reached')
    }
    expect(await refResolves(spy, '/repo', '--output=/tmp/x')).toBe(false)
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
    row: {
      baseBranch: string
      baseSha?: string
      /** What the FIXTURE answers, per ref — the `.mjs` word asks the repository itself. */
      resolves: boolean | ((ref: string) => boolean)
      mergeMode?: 'pr' | 'local'
    },
  ): Promise<{ ts: string; mjs: string }> {
    const ts = await diffBaseRef(row.baseBranch, row.baseSha ?? null, probe(row.resolves))
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
      const got = await bothAgree(w, { baseBranch, baseSha: sha, resolves: true })
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
      const got = await bothAgree(w, { baseBranch: 'main', resolves: (ref) => ref === 'refs/remotes/origin/main', mergeMode })
      expect({ mergeMode, ...got }).toEqual({ mergeMode, ts: 'refs/remotes/origin/main', mjs: 'refs/remotes/origin/main' })
    }
  })

  test('unpinned, origin/<base> MISSING: both fall back to refs/heads/<base>, in either mode', async () => {
    // THE FALLBACK ARM, and it used to answer the BARE name on both sides. `refs/heads/main`
    // and `refs/tags/main` can coexist and git prefers the tag, so the bare name named
    // something nobody checked — in the arm that runs when the environment is already
    // degraded. Both implementations now name the local branch in full.
    const w = await seedWorld('parity-no-origin')
    // No `refs/remotes/origin/main` in this fixture at all, and `refs/heads/main` is real —
    // asserted, because the row is about which of the two the code picks.
    expect(await git(w.repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/')).toBe('')
    expect((await git(w.repo, 'rev-parse', 'refs/heads/main')).length).toBe(40)
    for (const mergeMode of ['pr', 'local'] as const) {
      const got = await bothAgree(w, { baseBranch: 'main', resolves: headsOnly('main'), mergeMode })
      expect({ mergeMode, ...got }).toEqual({ mergeMode, ts: 'refs/heads/main', mjs: 'refs/heads/main' })
    }
  })

  test('unpinned, NEITHER ref resolves: NOBODY returns a bare name — the ONE row where the two differ', async () => {
    // THE TAG-ONLY WORLD, and the row that used to assert `ts: 'main', mjs: 'main'` — with no
    // tag in the fixture, so it could not fail on the defect it was covering. This repository
    // holds a live instance: `archive/agent-replies-prior-iter-3b35767` resolves as a TAG and
    // as no branch, so a bare name answers to it, exit 0.
    //
    // AND THIS IS THE ONE PLACE THE TWO IMPLEMENTATIONS CANNOT AGREE, stated rather than
    // papered over: the TS binding REFUSES; the `.mjs` composes a shell word in one process
    // for another process to evaluate, so it cannot refuse — it can only name a ref the other
    // process will reject. Both are asserted, and the `.mjs` word is shown to be one git
    // actually rejects, so neither path computes a diff against a base nobody chose.
    const w = await seedWorld('parity-no-refs')
    await git(w.repo, 'branch', '-m', 'main', 'trunk')
    // The tag is what makes this row load-bearing: without it, a bare `main` merely fails.
    await git(w.repo, 'tag', 'main', w.base)
    expect(await git(w.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/main')).toBe('')
    expect(await git(w.repo, 'rev-parse', 'refs/tags/main')).toBe(w.base)

    for (const mergeMode of ['pr', 'local'] as const) {
      await expect(diffBaseRef('main', null, probe(false))).rejects.toThrow(TridentUnresolvableBaseError)
      const composed = await workflowDiffBase({ baseBranch: 'main', repoPath: w.repo, mergeMode })
      const word = (await spawnCapture(['bash', '-c', `printf %s ${composed}`], w.repo)).stdout.trim()
      expect({ mergeMode, word }).toEqual({ mergeMode, word: 'refs/heads/main' })
      // MEASURED: that word is a ref git REFUSES here — loudly, 128, with nothing written —
      // which is the property the TS throw provides on its side.
      const ranged = await spawnCapture(
        ['git', '-C', w.repo, 'diff', '--name-only', '--end-of-options', `${word}..${w.head}`],
        w.repo,
      )
      expect({ mergeMode, ok: ranged.ok, out: ranged.stdout.trim() }).toEqual({ mergeMode, ok: false, out: '' })
      // …while the BARE word the row used to assert resolves happily against the tag.
      const bare = await spawnCapture(
        ['git', '-C', w.repo, 'diff', '--name-only', '--end-of-options', `main..${w.head}`],
        w.repo,
      )
      expect({ mergeMode, ok: bare.ok }).toEqual({ mergeMode, ok: true })
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
    const got = await bothAgree(w, { baseBranch: 'main', resolves: (ref) => ref === 'refs/remotes/origin/main' })
    expect(got).toEqual({ ts: 'refs/remotes/origin/main', mjs: 'refs/remotes/origin/main' })
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

describe('AN UNSHIELDED GIT REV-RANGE IS UNCONSTRUCTIBLE IN TYPESCRIPT — and the rest is enumerated', () => {
  /**
   * ── WHY THIS STOPPED BEING A SCANNER PROBLEM ──────────────────────────
   * "Every consumer carries `--end-of-options`" was asserted by a text scanner over the
   * tree for three rounds, and the scanner was wrong three times, each in a different
   * mechanism:
   *
   *   1. it searched for one SPELLING of the operand (`${baseRef}..`), so
   *      `computeDiffLineCount`'s `base_ref` was invisible — and shipped unshielded — as was
   *      `mutation-prover.ts`'s three-dot range on its own argv line;
   *   2. it then attributed the marker by a TWELVE-LINE WINDOW, so a protected command above
   *      an unprotected one shielded it, and the window read the round's own explanatory
   *      comments — which say `--end-of-options` — as evidence, passing every mutation;
   *   3. with comments blanked and attribution parsed, it still examined only the FIRST
   *      range on each physical line.
   *
   * **Three rounds spent making one instrument adequate means the property was being
   * measured where it should be prevented.** So the eleven TypeScript call sites now build
   * their argv through `gitRangeArgv` (`trident/git-range.ts`), which has no parameter for
   * the marker: an unshielded range cannot be expressed there. The population this file
   * scans fell from 21 to 10, and every survivor is a place a TypeScript helper cannot
   * reach — a command inside a prompt string, or a line of shell.
   *
   * What is left to assert is two much simpler claims, and both are enumerable:
   *   A. no interpolated range is built anywhere in the shipped modules except inside
   *      `git-range.ts` — with six argued exceptions, each a command a helper cannot build;
   *   B. `gitRangeArgv` always emits the marker, in the only position that works.
   */
  const MODULES = [
    'orchestrator.ts',
    'inner-workflow.mjs',
    'merge.ts',
    'mutation-prover.ts',
    'mutation-claim-artifact.ts',
    'git-range.ts',
    'codex-build.sh',
    'codex-review.sh',
  ] as const

  /**
   * An interpolated operand touching the range operator: `` `${x}..` `` or `` `..${x}` ``.
   * GLOBAL, because it used to be `exec`'d once per line: a protected command followed by an
   * unprotected one ON THE SAME LINE reported clean, since the detector stopped at the first
   * match. It also matches `...`, `}..` being a prefix of `}...`.
   */
  const RANGE = /\}\.\.|\.\.\$\{/g

  /**
   * How far back a `git` token may be and still be this range's command. The real maximum
   * among the survivors is 123 characters; the three operator-facing NOTES that merely
   * describe a range sit 1205-1587 characters from any `git`, so the bound separates prose
   * from commands on measurement rather than by assertion.
   */
  const MAX_ATTRIBUTION = 600

  /**
   * Hits that are NOT git invocations, each argued. A hit that is neither shielded nor listed
   * here fails, so adding prose about a range is also a deliberate act.
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
    {
      file: 'codex-review.sh',
      needle: 'does not name a commit in this repository',
      why: 'the refusal MESSAGE naming the range it will not run — prose, never argv',
    },
    {
      file: 'codex-review.sh',
      needle: 'could not read the diff',
      why: "the diff-failure MESSAGE quoting the range git rejected — prose, never argv",
    },
  ]

  /**
   * The six ranges a TypeScript helper cannot build, each with the reason it is out of reach.
   * They still have to carry the marker — being unreachable by the helper is a reason to
   * enumerate them, not a reason to exempt them.
   */
  const OUT_OF_REACH: ReadonlyArray<{ file: string; line: number; why: string }> = [
    { file: 'inner-workflow.mjs', line: 1602, why: "the forge contract's example diff — a command in a PROMPT, run by the agent" },
    { file: 'inner-workflow.mjs', line: 2336, why: "the planner's resume inspection hint — also a prompt" },
    { file: 'inner-workflow.mjs', line: 2449, why: 'the plan probe branch log — a shell command composed for a prompt' },
    { file: 'inner-workflow.mjs', line: 5286, why: 'the resume diff — a shell command the workflow hands to `agent()` to run' },
    { file: 'codex-build.sh', line: 821, why: 'shell: the wrapper regenerates the branch diff when a build committed and wrote none' },
    { file: 'codex-review.sh', line: 365, why: 'shell: the standalone reviewer builds its own diff' },
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
   * A `//` or `#` inside a string literal is not a comment opener, so quotes are tracked.
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

  /** EVERY interpolated range in `source` — all matches per line — attributed to its own command. */
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
      // ALL of them. `RANGE.exec(line)` once was the third defect in this instrument: the
      // first match on a line decided the line, so `…'--end-of-options', \`${a}..HEAD\`]; …\`${b}..HEAD\`]`
      // reported clean.
      for (const m of line.matchAll(RANGE)) {
        const index = (offsets[i] as number) + (m.index as number)
        // THE COMMAND, found by parsing backwards for its `git` token rather than by counting
        // lines. Over the blanked text, so a `git` in a comment cannot be it.
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
      }
    })
    return hits
  }

  /** The shipped tree. */
  function rangeHits(): Hit[] {
    return MODULES.flatMap((file) => scan(file, readFileSync(join(import.meta.dir, file), 'utf8')))
  }

  /** Offenders as the tests report them: unshielded or unattributable, and not excused. */
  function offenders(hits: Hit[]): string[] {
    return hits
      .filter((h) => h.excused === null && (!h.attributed || !h.shielded))
      .map((h) => `${h.file}:${h.line} ${h.attributed ? 'UNSHIELDED' : 'UNATTRIBUTABLE'} ${h.text.slice(0, 70)}`)
  }

  test('A · the TypeScript modules build NO range of their own — the helper does it', () => {
    // The structural claim that replaces "every call site remembered the marker". Before the
    // refactor these three files held eleven ranges between them; now they hold none, and
    // `gitRangeArgv` is the only thing that can make one.
    const perFile: Record<string, number> = {}
    for (const h of rangeHits()) perFile[h.file] = (perFile[h.file] ?? 0) + 1
    expect(perFile).toEqual({
      // Four commands inside PROMPTS — a helper cannot reach an agent's command line.
      'inner-workflow.mjs': 4,
      // Three operator-facing notes that describe a range in prose.
      'mutation-claim-artifact.ts': 3,
      // Two shell wrapper commands plus the trailer label.
      'codex-build.sh': 1,
      // Four: the invocation, the trailer label, and the two refusal messages that quote the
      // range they are refusing to run.
      'codex-review.sh': 4,
    })
    // Named explicitly, because an empty key is easy to misread as "not scanned".
    for (const gone of ['orchestrator.ts', 'merge.ts', 'mutation-prover.ts', 'git-range.ts']) {
      expect({ file: gone, ranges: perFile[gone] ?? 0 }).toEqual({ file: gone, ranges: 0 })
    }
  })

  test('A · every surviving range is shielded in its OWN command, or is argued prose', () => {
    const hits = rangeHits()
    expect(offenders(hits)).toEqual([])
    // The six out-of-reach commands are exactly the shielded survivors — so a new one cannot
    // appear without being argued here, and one that disappears cannot go unnoticed.
    const shielded = hits.filter((h) => h.excused === null).map((h) => `${h.file}:${h.line}`)
    expect(shielded.sort()).toEqual(OUT_OF_REACH.map((o) => `${o.file}:${o.line}`).sort())
    for (const o of OUT_OF_REACH) expect({ site: `${o.file}:${o.line}`, argued: o.why.length > 20 }).toEqual({ site: `${o.file}:${o.line}`, argued: true })
    for (const h of hits.filter((x) => x.excused !== null)) {
      expect({ site: `${h.file}:${h.line}`, why: (h.excused ?? '').length > 20 }).toEqual({ site: `${h.file}:${h.line}`, why: true })
    }
  })

  test('B · gitRangeArgv cannot omit the marker — there is no parameter for it', () => {
    // The prevention itself, asserted as a property over the shapes the tree actually uses.
    const shapes: GitRangeArgv[] = [
      { repo_path: '/repo', subcommand: 'diff', flags: ['--numstat'], base: 'b', head: 'HEAD' },
      { repo_path: '/repo', subcommand: 'diff', base: 'b', head: 'h' },
      { repo_path: '/repo', config: ['-c', 'core.quotePath=false'], subcommand: 'diff', flags: ['-z'], base: 'b', head: 'h', dots: '...' },
      { repo_path: '/repo', subcommand: 'log', flags: ['--format=%H'], base: 'b', head: 'h', pathspec: ['src/a.ts'] },
      { repo_path: '/repo', subcommand: 'rev-list', flags: ['--count'], base: 'refs/heads/main', head: 'tip' },
    ]
    for (const s of shapes) {
      const argv = gitRangeArgv(s)
      const marker = argv.indexOf('--end-of-options')
      const operand = argv.findIndex((a) => a.includes('..'))
      // Present, exactly once, AFTER every flag and BEFORE the operand. Anywhere else is
      // useless: before the flags it stops git reading them, after the operand it is too late.
      expect({ s, present: marker !== -1, once: argv.filter((a) => a === '--end-of-options').length }).toEqual({ s, present: true, once: 1 })
      expect({ s, beforeOperand: marker < operand }).toEqual({ s, beforeOperand: true })
      for (const f of s.flags ?? []) expect({ s, f, flagFirst: argv.indexOf(f) < marker }).toEqual({ s, f, flagFirst: true })
      // `-c` settings precede the subcommand, which git requires.
      for (const c of s.config ?? []) expect({ s, c, early: argv.indexOf(c) < argv.indexOf(s.subcommand) }).toEqual({ s, c, early: true })
    }
    // And the argv is the one the tree already pinned, byte for byte.
    expect(gitRangeArgv({ repo_path: '/repo', subcommand: 'diff', flags: ['--numstat'], base: 'b', head: 'HEAD' })).toEqual([
      'git', '-C', '/repo', 'diff', '--numstat', '--end-of-options', 'b..HEAD',
    ])
    expect(
      gitRangeArgv({ repo_path: '/r', config: ['-c', 'core.quotePath=false'], subcommand: 'diff', flags: ['-z', '--name-status'], base: 'a', head: 'b', dots: '...' }),
    ).toEqual(['git', '-C', '/r', '-c', 'core.quotePath=false', 'diff', '-z', '--name-status', '--end-of-options', 'a...b'])
    // A pathspec lands after the operand, behind `--`; an empty one adds nothing.
    expect(gitRangeArgv({ repo_path: '/r', subcommand: 'log', base: 'a', head: 'b', pathspec: ['x.ts'] }).slice(-3)).toEqual(['a..b', '--', 'x.ts'])
    expect(gitRangeArgv({ repo_path: '/r', subcommand: 'log', base: 'a', head: 'b', pathspec: [] }).slice(-1)).toEqual(['a..b'])
  })

  test('TWO COMMANDS ON ONE LINE: the second is examined too', () => {
    // THE THIRD INSTRUMENT DEFECT. `RANGE.exec(line)` ran once, so the first match decided
    // the line and an unprotected command sharing it was never looked at.
    const oneLine =
      "const a = ['git','diff','--end-of-options',`${good}..HEAD`]; const b = ['git','diff',`${bad}..HEAD`]"
    const hits = scan('fixture.ts', oneLine)
    expect(hits.map((h) => ({ line: h.line, shielded: h.shielded }))).toEqual([
      { line: 1, shielded: true },
      { line: 1, shielded: false },
    ])
    expect(offenders(hits).length).toBe(1)
    // THE COMPLEMENT, so a detector that refuses everything cannot pass.
    const bothShielded = oneLine.replace("['git','diff',`${bad}", "['git','diff','--end-of-options',`${bad}")
    expect(offenders(scan('fixture.ts', bothShielded))).toEqual([])
  })

  test('A PROTECTED COMMAND DOES NOT SHIELD THE NEXT ONE — through the real detector', () => {
    // The second instrument defect: a twelve-line proximity window. The control runs through
    // `scan()` itself, because the version that missed this used a separate per-line filter
    // and so proved that *a* detector works, not that *this* one does.
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
    expect(offenders(hits)).toEqual(["fixture.ts:6 UNSHIELDED ['git', '-C', repo, 'diff', '--numstat', `${otherBase}..HEAD`],"])
    const fixed = fixture.replace("'--numstat',", "'--numstat', '--end-of-options',")
    expect(offenders(scan('fixture.ts', fixed))).toEqual([])
  })

  test('a range with no git command near it is UNATTRIBUTABLE, which fails rather than passes', () => {
    const far = `const cmd = 'git diff'\nconst filler = "${'x'.repeat(MAX_ATTRIBUTION + 50)}"\nconst r = \`\${someBase}..HEAD\``
    const hits = scan('fixture.ts', far)
    expect(hits.map((h) => ({ line: h.line, attributed: h.attributed }))).toEqual([{ line: 3, attributed: false }])
    expect(offenders(hits)).toEqual(['fixture.ts:3 UNATTRIBUTABLE const r = `${someBase}..HEAD`'])
  })

  test('a git token inside a COMMENT cannot attribute or shield a range', () => {
    // The first instrument defect: the window read this round's own comments as evidence.
    const fixture = [
      '// the shipped form is `git diff --end-of-options ${base}..HEAD`',
      "const cmd = ['git', '-C', repo, 'diff', `${plainBase}..HEAD`]",
    ].join('\n')
    expect(scan('fixture.ts', fixture).map((h) => ({ line: h.line, shielded: h.shielded, attributed: h.attributed }))).toEqual([
      { line: 2, shielded: false, attributed: true },
    ])
  })

  test('POSITIVE CONTROL: a new consumer under a THIRD spelling is caught', () => {
    // `whicheverNameIFeelLike` appears nowhere in the codebase — the case that defeated the
    // spelling-keyed instrument. Measured for real too: planting such a function in
    // `orchestrator.ts` reds test A, and removing it goes clean.
    const planted = ["const res = await run_host(", "  ['git', '-C', repo, 'diff', '--numstat', `${whicheverNameIFeelLike}..${tipOid}`],", '  repo,', ')'].join('\n')
    expect(offenders(scan('fixture.ts', planted)).length).toBe(1)
    const threeDot = ["const a = ['git', '-C', repo, 'diff', '-z', '--name-status',", '  `${someOtherName}...${revision}`,', ']'].join('\n')
    expect(offenders(scan('fixture.ts', threeDot)).length).toBe(1)
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
