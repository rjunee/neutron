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

import { spawnCapture } from './git-mode.ts'
import { diffBaseRef, originBaseResolves, TridentOptionShapedBaseError } from './merge.ts'

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
