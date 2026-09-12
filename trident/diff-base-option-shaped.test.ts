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
 *     operand at all. This is the fix; everything below is defence in depth.
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
  test('diffBaseRef throws, whatever the probe said and whatever else is in hand', () => {
    for (const bad of ['--output=/tmp/x', '-x', '--upload-pack=touch', '  --output=/tmp/y  ']) {
      // Both probe answers, because the defect was that `false` selected the bare branch:
      // neither value may produce a returned string.
      for (const resolves of [true, false]) {
        expect(() => diffBaseRef(bad, null, resolves)).toThrow(TridentOptionShapedBaseError)
      }
      // …and a pinned sha still wins outright, since it is read before the name at all.
      expect(diffBaseRef(bad, 'a'.repeat(40), false)).toBe('a'.repeat(40))
    }
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
        expect(() => diffBaseRef(empty, null, resolves)).toThrow(TridentEmptyBaseError)
      }
    }
    await expect(workflowDiffBase({ baseBranch: '', repoPath: w.repo })).rejects.toThrow(
      /refusing an empty base branch/,
    )

    // …and a PIN still wins, because the pin is read before the name. Same ordering the
    // option-shaped case needed.
    const sha = 'e'.repeat(40)
    expect(diffBaseRef('', sha, false)).toBe(sha)
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
    expect(diffBaseRef('--output=/tmp/x', sha, false)).toBe(sha)
    expect(await workflowDiffBase({ baseBranch: '--output=/tmp/x', baseSha: sha })).toBe(`'${sha}'`)
  })

  test('ORDER: with NO pin, both refuse the same name', async () => {
    expect(() => diffBaseRef('--output=/tmp/x', null, false)).toThrow(TridentOptionShapedBaseError)
    await expect(workflowDiffBase({ baseBranch: '--output=/tmp/x' })).rejects.toThrow(
      /would read as an option, not a revision/,
    )
  })

  test('THE COMPLEMENT: an ordinary name is unaffected in both directions', () => {
    expect(diffBaseRef('main', null, true)).toBe('origin/main')
    expect(diffBaseRef('main', null, false)).toBe('main')
    expect(diffBaseRef('release/1.x', null, true)).toBe('origin/release/1.x')
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
    const ts = diffBaseRef(row.baseBranch, row.baseSha ?? null, row.originResolves)
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
    expect(() => diffBaseRef('', null, false)).toThrow(TridentEmptyBaseError)
    await expect(workflowDiffBase({ baseBranch: '', repoPath: w.repo })).rejects.toThrow(
      /refusing an empty base branch/,
    )
  })

  test('unpinned, option-shaped: both REFUSE rather than answering', async () => {
    const w = await seedWorld('parity-refuse')
    expect(() => diffBaseRef('--output=/tmp/x', null, false)).toThrow(TridentOptionShapedBaseError)
    await expect(workflowDiffBase({ baseBranch: '--output=/tmp/x', repoPath: w.repo })).rejects.toThrow(
      /would read as an option, not a revision/,
    )
  })
})

describe('every consumer of the resolved base carries --end-of-options', () => {
  /** Lines of `file` that build a git rev-range from the resolved base. */
  function rangeLines(file: string, pattern: RegExp): string[] {
    const src = readFileSync(join(import.meta.dir, file), 'utf8')
    return src
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('*') && !l.startsWith('//') && !l.startsWith('#'))
      .filter((l) => pattern.test(l))
  }

  test('orchestrator.ts — all four, and the extraction proves it found them', () => {
    const lines = rangeLines('orchestrator.ts', /\$\{baseRef\}\.\./)
    // POSITIVE CONTROL: the gate named four call sites across two commands. If a refactor
    // moves or renames them this count changes and the assertion below stops meaning
    // anything, so the count is pinned rather than assumed.
    expect(lines.length).toBe(4)
    for (const line of lines) expect({ line, guarded: line.includes('--end-of-options') }).toEqual({ line, guarded: true })
  })

  test('inner-workflow.mjs — EVERY site that composes a range from diffBase, prompts included', () => {
    // Three: the executed resume diff, and the two PROMPT sites (the forge contract's
    // example and the planner's resume hint). The binding refuses an option-shaped base
    // so the prompts could not carry one — but "every consumer carries the marker" is a
    // simpler claim to keep true than "every consumer except two, protected by something
    // else", and the second shape is how this branch has been wrong six times.
    const lines = rangeLines('inner-workflow.mjs', /git diff [^\n]*\$\{diffBase\}\.\./)
    expect(lines.length).toBe(3)
    for (const line of lines) {
      expect({ line: line.slice(0, 90), guarded: line.includes('--end-of-options') }).toEqual({
        line: line.slice(0, 90),
        guarded: true,
      })
    }
  })

  test('the two wrappers — each takes the base as argv and diffs with it', () => {
    for (const [file, pattern] of [
      ['codex-build.sh', /git diff .*BASE_DIFF_REF/],
      ['codex-review.sh', /FULL_DIFF=\$\(git diff/],
    ] as const) {
      const lines = rangeLines(file, pattern)
      expect({ file, found: lines.length }).toEqual({ file, found: 1 })
      expect({ file, guarded: lines[0]?.includes('--end-of-options') }).toEqual({ file, guarded: true })
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
