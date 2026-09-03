import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnCapture } from './git-mode.ts'
import {
  changedFilesOnBranch,
  proofWorktreePath,
  resolveMergeHeadSha,
  runMutationProofGate,
} from './mutation-prover.ts'

/**
 * THE FETCH CONTRACT AND THE HOSTILE NAME, against REAL git.
 *
 * The mocked tests can only prove which argv the resolver BUILDS. What they
 * cannot prove is that the argv WORKS — that after the fetch,
 * `refs/remotes/origin/<branch>` actually names the commit that is on origin —
 * nor that a hostile name changes NOTHING in the repository. Review round 3
 * deleted the argv scan that stood in for the second claim: it scanned argv for
 * the literal strings `branch` and `update-ref`, so it passed while
 * `--upload-pack=…` was running a program and `x:refs/heads/y` was writing a
 * local branch. A test that cannot fail on the bug proves nothing.
 *
 * So the assertions here are REPOSITORY STATE: the resolved sha, the
 * `for-each-ref` snapshot before and after, and whether the marker file the
 * `--upload-pack` payload would have written exists.
 */

const GIT_ID = ['-c', 'user.name=Test Setup', '-c', 'user.email=setup@neutron.local', '-c', 'commit.gpgsign=false']
const BRANCH = 'trident/head-resolves-without-a-local-ref'
const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const result = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

interface World {
  root: string
  origin: string
  /** A clone whose remote has NO fetch refspec at all. */
  consumer: string
  /** The sha origin/<BRANCH> pointed at when the consumer last fetched. */
  stale: string
  /** The sha origin/<BRANCH> points at NOW. */
  current: string
}

async function seedWorld(label: string): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), `mutation-prover-realgit-${label}-`))
  created.push(root)
  const origin = join(root, 'origin.git')
  const author = join(root, 'author')
  const consumer = join(root, 'consumer')

  await spawnCapture(['git', 'init', '--bare', '-q', '--initial-branch=main', origin], root)
  await spawnCapture(['git', 'init', '-q', '--initial-branch=main', author], root)
  writeFileSync(join(author, 'a.txt'), 'base\n')
  await git(author, 'add', '-A')
  await git(author, ...GIT_ID, 'commit', '-q', '-m', 'base')
  await git(author, 'remote', 'add', 'origin', origin)
  await git(author, 'push', '-q', 'origin', 'main')
  await git(author, 'switch', '-q', '-c', BRANCH)
  writeFileSync(join(author, 'a.txt'), 'reviewed\n')
  await git(author, 'add', '-A')
  await git(author, ...GIT_ID, 'commit', '-q', '-m', 'the reviewed commit')
  await git(author, 'push', '-q', 'origin', BRANCH)
  const stale = await git(author, 'rev-parse', 'HEAD')

  const cloned = await spawnCapture(['git', 'clone', '-q', origin, consumer], root)
  if (!cloned.ok) throw new Error(`clone failed: ${cloned.stderr}`)
  await git(consumer, 'fetch', '-q', 'origin', BRANCH)
  await git(consumer, 'switch', '-q', '--detach', 'origin/main')
  // THE CLONE SHAPE UNDER TEST: no fetch refspec, so nothing auto-updates
  // `refs/remotes/origin/*` any more. The tracking ref is frozen at `stale`.
  await git(consumer, 'config', '--unset-all', 'remote.origin.fetch')

  // Origin advances (a rebase/force-push, or simply a later commit).
  writeFileSync(join(author, 'a.txt'), 'reviewed, then amended\n')
  await git(author, 'add', '-A')
  await git(author, ...GIT_ID, 'commit', '-q', '-m', 'the commit that would actually merge')
  await git(author, 'push', '-q', 'origin', BRANCH)
  const current = await git(author, 'rev-parse', 'HEAD')

  return { root, origin, consumer, stale, current }
}

/**
 * A repo whose branch changes ONLY files under `tests/`: a support library, the
 * separate test that asserts its behaviour, and an unrelated control test.
 *
 * With `alias`, it ALSO commits `tests/alias.test.ts` as a SYMLINK to the
 * library — a test-shaped name that is the library, byte for byte.
 */
async function seedSupportLib(opts: { alias?: boolean } = {}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'mutation-prover-realgit-support-lib-'))
  created.push(root)
  const repo = join(root, 'repo')
  await spawnCapture(['git', 'init', '-q', '--initial-branch=main', repo], root)
  writeFileSync(join(repo, 'README.md'), 'seed\n')
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'seed')

  await git(repo, 'switch', '-q', '-c', 'trident/support-lib-proof')
  mkdirSync(join(repo, 'tests', 'support'), { recursive: true })
  writeFileSync(join(repo, 'tests', 'support', 'clamp.ts'), 'export function clamp(n: number, max: number): number {\n  return n > max ? max : n\n}\n')
  writeFileSync(
    join(repo, 'tests', 'support', 'clamp.test.ts'),
    "import { expect, test } from 'bun:test'\n\nimport { clamp } from './clamp.ts'\n\ntest('clamp holds the ceiling', () => {\n  expect(clamp(5, 3)).toBe(3)\n  expect(clamp(2, 3)).toBe(2)\n})\n",
  )
  writeFileSync(
    join(repo, 'tests', 'other-control.test.ts'),
    "import { expect, test } from 'bun:test'\n\ntest('the control is unrelated to the mutated library', () => {\n  expect(1 + 1).toBe(2)\n})\n",
  )
  if (opts.alias === true) symlinkSync('support/clamp.ts', join(repo, 'tests', 'alias.test.ts'))
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'the support library and its separate test')
  return repo
}

/**
 * A repo whose branch adds an ORDINARY PRODUCTION module — `src/limit.ts`, a
 * name no runner collects and no convention declares a test — plus the separate
 * test that asserts it, an unrelated control, and the two BRANCH-AUTHORED
 * command lines a reviewer forged a `proved: true` out of: a `package.json`
 * script that preloads the mutated module behind an unrelated test, and the
 * space-separated `--preload` spelling of the same thing.
 */
async function seedProductionLib(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'mutation-prover-realgit-production-lib-'))
  created.push(root)
  const repo = join(root, 'repo')
  await spawnCapture(['git', 'init', '-q', '--initial-branch=main', repo], root)
  writeFileSync(join(repo, 'README.md'), 'seed\n')
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'seed')

  await git(repo, 'switch', '-q', '-c', 'trident/production-lib-proof')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'tests'), { recursive: true })
  writeFileSync(
    join(repo, 'src', 'limit.ts'),
    'export function clamp(n: number, max: number): number {\n  return n > max ? max : n\n}\n',
  )
  writeFileSync(
    join(repo, 'tests', 'limit.test.ts'),
    "import { expect, test } from 'bun:test'\n\nimport { clamp } from '../src/limit.ts'\n\ntest('clamp holds the ceiling', () => {\n  expect(clamp(5, 3)).toBe(3)\n  expect(clamp(2, 3)).toBe(2)\n})\n",
  )
  writeFileSync(
    join(repo, 'tests', 'other-control.test.ts'),
    "import { expect, test } from 'bun:test'\n\ntest('the control is unrelated to the mutated module', () => {\n  expect(1 + 1).toBe(2)\n})\n",
  )
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify(
      { name: 'production-lib', scripts: { 'test:unit': 'bun test --preload=./src/limit.ts tests/other-control.test.ts' } },
      null,
      2,
    )}\n`,
  )
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'the production module, its separate test and the branch-authored script')
  return repo
}

/**
 * A repo whose branch adds a LIBRARY whose NAME a runner collects but no
 * convention declares a test — `src/thing_test.ts` — plus the separate test
 * that asserts it and an unrelated control. This is the shape a bare substring
 * FILTER exploits: the library is a legal mutation target, and `bun test
 * thing_test.ts` names no file at all, so bun runs everything whose path
 * contains that string — the mutated library included.
 */
async function seedCollectibleLib(opts: { decoys?: boolean } = {}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'mutation-prover-realgit-collectible-'))
  created.push(root)
  const repo = join(root, 'repo')
  await spawnCapture(['git', 'init', '-q', '--initial-branch=main', repo], root)
  writeFileSync(join(repo, 'README.md'), 'seed\n')
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'seed')

  await git(repo, 'switch', '-q', '-c', 'trident/collectible-lib-proof')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'tests'), { recursive: true })
  writeFileSync(
    join(repo, 'src', 'thing_test.ts'),
    'export const CEILING = 3\nexport function clamp(n: number, max: number): number {\n  return n > max ? max : n\n}\n',
  )
  writeFileSync(
    join(repo, 'tests', 'thing.test.ts'),
    "import { expect, test } from 'bun:test'\n\nimport { clamp } from '../src/thing_test.ts'\n\ntest('clamp holds the ceiling', () => {\n  expect(clamp(5, 3)).toBe(3)\n  expect(clamp(2, 3)).toBe(2)\n})\n",
  )
  writeFileSync(
    join(repo, 'tests', 'other-control.test.ts'),
    "import { expect, test } from 'bun:test'\n\ntest('the control is unrelated to the mutated library', () => {\n  expect(1 + 1).toBe(2)\n})\n",
  )
  if (opts.decoys === true) {
    // THE TWO SPELLINGS THAT RESOLVE. A root `thing_test.ts` makes `bun test
    // thing_test.ts` name a real file — and bun STILL reads the positional as a
    // substring filter and runs `src/thing_test.ts` too. A committed
    // `out/report.test.ts` makes `--reporter-outfile out/report.test.ts`
    // resolve — and it is still a file bun writes during a whole-suite run.
    writeFileSync(
      join(repo, 'thing_test.ts'),
      "import { expect, test } from 'bun:test'\n\ntest('the decoy asserts nothing about the library', () => {\n  expect(1 + 1).toBe(2)\n})\n",
    )
    mkdirSync(join(repo, 'out'), { recursive: true })
    writeFileSync(join(repo, 'out', 'report.test.ts'), 'placeholder\n')
  }
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'the collectible library and its separate test')
  return repo
}

/** A repo whose branch carries `seed(repo)`'s changes on top of main — for the
 *  tests that are about what `changedFilesOnBranch` READS out of real git,
 *  rather than about running a proof. */
async function seedDiffRepo(label: string, seed: (repo: string) => Promise<void>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `mutation-prover-realgit-${label}-`))
  created.push(root)
  const repo = join(root, 'repo')
  await spawnCapture(['git', 'init', '-q', '--initial-branch=main', repo], root)
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), 'seed\n')
  writeFileSync(join(repo, 'src', 'limit.ts'), 'export const LIMIT = 3\n')
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'seed')
  await git(repo, 'switch', '-q', '-c', BRANCH)
  await seed(repo)
  await git(repo, 'add', '-A')
  await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'the branch')
  return repo
}

describe('the mutation-proof gate against real git', () => {
  test('the short form leaves the tracking ref STALE; the resolver returns the true origin tip anyway', async () => {
    const w = await seedWorld('stale-ref')
    expect(w.stale).not.toBe(w.current)
    expect(await git(w.consumer, 'rev-parse', `refs/remotes/origin/${BRANCH}`)).toBe(w.stale)

    // THE FAILURE, reproduced: `git fetch origin <branch>` SUCCEEDS and the
    // tracking ref does not move.
    const shortForm = await spawnCapture(['git', '-C', w.consumer, 'fetch', 'origin', BRANCH], w.consumer)
    expect(shortForm.ok).toBe(true)
    expect(await git(w.consumer, 'rev-parse', `refs/remotes/origin/${BRANCH}`)).toBe(w.stale)

    // THE FIX: no local branch exists at all (the #482 shape) and the resolver
    // still returns the CURRENT origin tip.
    expect(
      (await spawnCapture(['git', '-C', w.consumer, 'rev-parse', '--verify', '--quiet', BRANCH], w.consumer)).ok,
    ).toBe(false)
    const resolved = await resolveMergeHeadSha(spawnCapture, w.consumer, BRANCH, null)
    expect(resolved).toBe(w.current)
    expect(resolved).not.toBe(w.stale)
    expect(await git(w.consumer, 'rev-parse', `refs/remotes/origin/${BRANCH}`)).toBe(w.current)
  })

  test('the two reviewer payloads, verbatim: no ref is written, no program runs, and the gate REFUSES', async () => {
    const w = await seedWorld('hostile-name')
    const marker = join(w.root, 'upload-pack-executed')
    const before = await git(w.consumer, 'for-each-ref', '--format=%(refname) %(objectname)')
    for (const hostile of [`--upload-pack=touch ${marker}`, 'feat-x:refs/heads/injected-by-branch']) {
      expect(await resolveMergeHeadSha(spawnCapture, w.consumer, hostile, w.stale)).toBeNull()
      const out = await runMutationProofGate({
        run: { id: 'run-h', slug: 'hostile', repo_path: w.consumer, branch: hostile },
        claim: null,
        base_branch: 'main',
        expected_head: w.stale,
        run_host: spawnCapture,
      })
      expect(out.ok).toBe(false)
      expect(out.reason).toContain('is rejected')
    }
    expect(existsSync(marker)).toBe(false)
    expect(await git(w.consumer, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(before)
    expect(
      (
        await spawnCapture(
          ['git', '-C', w.consumer, 'rev-parse', '--verify', '--quiet', 'refs/heads/injected-by-branch'],
          w.consumer,
        )
      ).ok,
    ).toBe(false)
  })

  test('a name the allowlist cannot judge is judged by REAL git — delegated, and its no refuses', async () => {
    const w = await seedWorld('delegated')
    const out = await runMutationProofGate({
      run: { id: 'run-d', slug: 'delegated', repo_path: w.consumer, branch: 'a/.hidden' },
      claim: null,
      base_branch: 'main',
      expected_head: w.stale,
      run_host: spawnCapture,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('check-ref-format')
  })

  test('a support LIBRARY under tests/ proves red-then-green against REAL git and bun', async () => {
    // THE #489 CLASS, end to end. `tests/support/clamp.ts` declares no test
    // cases: it is a library whose behaviour is asserted by the SEPARATE
    // `tests/support/clamp.test.ts`. Mutating it and watching that separate test
    // go red — while an unrelated control stays green — is a genuine proof, not
    // the tautology the old path rule banned. Note the guard argv element
    // `tests/support/clamp.test.ts` differs from claim.file
    // `tests/support/clamp.ts`, so the tautology check correctly permits it.
    const lib = await seedSupportLib()
    const out = await runMutationProofGate({
      run: { id: 'run-lib', slug: 'support-lib', repo_path: lib, branch: 'trident/support-lib-proof' },
      claim: {
        file: 'tests/support/clamp.ts',
        find: 'n > max ? max : n',
        replace: 'n',
        guard: ['bun', 'test', 'tests/support/clamp.test.ts'],
        control: ['bun', 'test', 'tests/other-control.test.ts'],
      },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect(out.ok).toBe(true)
    expect(out.exempt).toBe(false)
    expect(out.evidence?.proved).toBe(true)

    // Positive control against a silently-empty extraction: there really are
    // observations, and they are asserted NON-optionally.
    const obs = out.evidence?.observed
    expect(obs ?? null).not.toBeNull()
    if (!obs) throw new Error('unreachable')
    expect(obs.guard_mutated.exit_code).not.toBe(0)
    expect(obs.control_mutated.exit_code).toBe(0)
    expect(obs.guard_restored.exit_code).toBe(0)
    // 120s, not 30s: this test spawns THREE real `bun test` processes plus a
    // `git worktree add`, and CI runs eight shards' worth of files four-abreast
    // on a shared runner. A 30s cap was a timing bet on the machine, and the
    // budget the prover itself works to is 15 MINUTES — a cap tighter than the
    // thing under test only ever buys a red that means "the box was busy".
  }, 120_000)

  test('a PRODUCTION target cannot be proved by a wrapper or by a space-separated preload', async () => {
    // THE TWO BYPASSES A REVIEW PANEL REPRODUCED end to end against the branch
    // prover, both of them forging `ok: true, proved: true` for an ordinary
    // production module:
    //
    //  1. `npm run test:unit`, whose body — in the branch's own `package.json`,
    //     committed below — is `bun test --preload=./src/limit.ts
    //     tests/other-control.test.ts`. The argv shows a script NAME; the run
    //     loads the mutated module into a process running an unrelated test, so
    //     a syntax-shaped mutation reddens it with nothing asserting the
    //     mutated behaviour.
    //  2. `--preload ./src`, which is `--preload=./src` — refused since the
    //     round before — with the `=` written as a space. `carriedValue` read
    //     only the `=`-joined and attached-short spellings, so the value was
    //     one more positional to every arm.
    //
    // Both must be refused BEFORE anything is executed or any worktree exists.
    const repo = await seedProductionLib()
    const run = { id: 'run-prod', slug: 'production-lib', repo_path: repo, branch: 'trident/production-lib-proof' }
    const claim = {
      file: 'src/limit.ts',
      find: 'n > max ? max : n',
      replace: 'n',
      control: ['bun', 'test', 'tests/other-control.test.ts'],
    }
    for (const [guard, names] of [
      [['npm', 'run', 'test:unit'], 'whose script body the branch wrote'],
      [['bun', 'test', '--preload', './src', 'tests/other-control.test.ts'], '--preload ./src'],
      [['bun', 'test', '--preload', './src/limit', 'tests/other-control.test.ts'], '--preload ./src/limit'],
    ] as const) {
      const out = await runMutationProofGate({
        run: { ...run, id: `run-prod-${guard.join('-')}` },
        claim: { ...claim, guard: [...guard] },
        base_branch: 'main',
        run_host: spawnCapture,
      })
      expect([guard.join(' '), out.ok, out.exempt, out.evidence?.proved ?? null]).toEqual([
        guard.join(' '),
        false,
        false,
        false,
      ])
      expect(out.reason).toContain('tautology')
      expect(out.reason).toContain(names)
      expect(existsSync(proofWorktreePath(repo, { ...run, id: `run-prod-${guard.join('-')}` }))).toBe(false)
    }

    // POSITIVE CONTROL, and the one that stops all of the above from passing on
    // "a production module can no longer be proved at all": the spelling each
    // refusal recommends — the separate test named with the runner that runs it
    // — proves red-then-green in this very repo, `package.json` and all.
    const fine = await runMutationProofGate({
      run: { ...run, id: 'run-prod-control' },
      claim: { ...claim, guard: ['bun', 'test', 'tests/limit.test.ts'] },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([fine.ok, fine.exempt, fine.evidence?.proved ?? null]).toEqual([true, false, true])
    const obs = fine.evidence?.observed
    expect(obs ?? null).not.toBeNull()
    if (!obs) throw new Error('unreachable')
    expect(obs.guard_mutated.exit_code).not.toBe(0)
    expect(obs.control_mutated.exit_code).toBe(0)
    expect(obs.guard_restored.exit_code).toBe(0)
  }, 120_000)

  test('a make GOAL beside a real path runs a BRANCH-AUTHORED recipe, not a targeted guard, and is refused', async () => {
    // THE BYPASS A REVIEWER REPRODUCED against the previous head: with a
    // `Makefile` the branch itself wrote, whose `test-all` recipe is `bun test`,
    // the guard `make test-all <a real test path>` came back `ok: true,
    // proved: true` — while the SAME repo refused `make test-all`, `npm run
    // test-all <path>` and `bun test`. Make does not hand the extra positional
    // to the recipe; it reads it as a SECOND GOAL, so the recipe's whole-suite
    // discovery runs (collecting and breaking on the mutated library) and the
    // named file, which is on disk, is simply reported up to date. Red mutated,
    // green restored, with the branch having supplied both halves.
    //
    // End to end against real git: the Makefile is committed, the claim is a
    // legal support-library target, and the refusal must land BEFORE anything
    // is executed or any worktree is created.
    const lib = await seedSupportLib()
    writeFileSync(join(lib, 'Makefile'), 'test-all:\n\tbun test\n')
    await git(lib, 'add', '-A')
    await git(lib, ...GIT_ID, 'commit', '-q', '-m', 'the branch-authored recipe')
    const run = { id: 'run-make', slug: 'support-lib', repo_path: lib, branch: 'trident/support-lib-proof' }
    const claim = {
      file: 'tests/support/clamp.ts',
      find: 'n > max ? max : n',
      replace: 'n',
      control: ['bun', 'test', 'tests/other-control.test.ts'],
    }
    const out = await runMutationProofGate({
      run,
      claim: { ...claim, guard: ['make', 'test-all', 'tests/support/clamp.test.ts'] },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([out.ok, out.exempt, out.evidence?.proved ?? null]).toEqual([false, false, false])
    expect(out.reason).toContain('second GOAL for make')
    expect(out.reason).toContain('test-all recipe')
    expect(out.reason).toContain('tautology')
    // Nothing ran, so nothing was left behind — and no `make` was spawned.
    expect(existsSync(proofWorktreePath(lib, run))).toBe(false)

    // POSITIVE CONTROL, and the one that stops this from passing on "make is
    // banned outright": the spelling the refusal RECOMMENDS — the same test
    // named with the runner that actually runs it — still proves red-then-green
    // in this very repo, Makefile and all.
    const fine = await runMutationProofGate({
      run: { ...run, id: 'run-make-control' },
      claim: { ...claim, guard: ['bun', 'test', 'tests/support/clamp.test.ts'] },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([fine.ok, fine.exempt, fine.evidence?.proved ?? null]).toEqual([true, false, true])
    const obs = fine.evidence?.observed
    expect(obs ?? null).not.toBeNull()
    if (!obs) throw new Error('unreachable')
    expect(obs.guard_mutated.exit_code).not.toBe(0)
    expect(obs.guard_restored.exit_code).toBe(0)
  }, 120_000)

  test('a committed REPORTER module that imports the target is refused before anything runs', async () => {
    // THE BYPASS THIS CLOSES, end to end against real git. Node v22 executes the
    // module `--test-reporter` names inside the guard's own process, so the
    // branch commits `tests/reporter.mjs` whose whole body is one import of
    // `../src/limit.ts` and nominates `node --test
    // --test-reporter=./tests/reporter.mjs tests/other-control.test.ts`: the
    // reporter drags the mutated PRODUCTION module in, a syntax-shaped break
    // reddens a guard that asserts nothing about it, and restoring goes green.
    // The refusal must land BEFORE anything is executed — node itself is never
    // spawned, so this test needs no node on the box.
    const repo = await seedProductionLib()
    writeFileSync(join(repo, 'tests', 'reporter.mjs'), "import '../src/limit.ts'\n")
    await git(repo, 'add', '-A')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'the branch-authored reporter module')
    const run = { id: 'run-reporter', slug: 'production-lib', repo_path: repo, branch: 'trident/production-lib-proof' }
    const claim = {
      file: 'src/limit.ts',
      find: 'n > max ? max : n',
      replace: 'n',
      control: ['bun', 'test', 'tests/other-control.test.ts'],
    }
    const out = await runMutationProofGate({
      run,
      claim: {
        ...claim,
        guard: ['node', '--test', '--test-reporter=./tests/reporter.mjs', 'tests/other-control.test.ts'],
      },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([out.ok, out.exempt, out.evidence?.proved ?? null]).toEqual([false, false, false])
    expect(out.reason).toContain('tautology')
    expect(out.reason).toContain('whose body the branch wrote')
    // …and the refusal quotes the option, so the next build knows which one.
    expect(out.reason).toContain('--test-reporter')
    // Nothing ran, so nothing was left behind.
    expect(existsSync(proofWorktreePath(repo, run))).toBe(false)

    // POSITIVE CONTROL, in the same repo with the reporter module committed and
    // all: the spelling the refusal recommends — the separate test named with
    // the runner that runs it — still proves red-then-green.
    const fine = await runMutationProofGate({
      run: { ...run, id: 'run-reporter-control' },
      claim: { ...claim, guard: ['bun', 'test', 'tests/limit.test.ts'] },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([fine.ok, fine.exempt, fine.evidence?.proved ?? null]).toEqual([true, false, true])
    const obs = fine.evidence?.observed
    expect(obs ?? null).not.toBeNull()
    if (!obs) throw new Error('unreachable')
    expect(obs.guard_mutated.exit_code).not.toBe(0)
    expect(obs.control_mutated.exit_code).toBe(0)
    expect(obs.guard_restored.exit_code).toBe(0)
  }, 120_000)

  test('a committed pytest/ package IS the runner, and the -m guard is refused before anything runs', async () => {
    // THE BYPASS THIS CLOSES, end to end against real git. `-m` resolves the
    // module from the working directory first, so a branch that commits its own
    // top-level `pytest/` package supplies the runner the argv names: the guard
    // reddens under a syntax-shaped break of the target while asserting nothing
    // about it, and restoring goes green. The refusal must land BEFORE anything
    // is executed — python is never spawned, so this test needs no pytest on
    // the box, and the marker file below is how we know.
    const repo = await seedProductionLib()
    mkdirSync(join(repo, 'pytest'), { recursive: true })
    // A RELATIVE marker path: the guard's cwd is the proof worktree at
    // `<repo>/.trident-worktrees/proof-…`, so `../../` is the repo root, which
    // outlives the worktree's removal.
    writeFileSync(
      join(repo, 'pytest', '__main__.py'),
      "open('../../pwned-by-python-shadow','w').write('x')\n",
    )
    writeFileSync(join(repo, 'tests', 'unrelated_test.py'), 'def test_ok():\n    assert True\n')
    await git(repo, 'add', '-A')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'the branch-authored pytest package')
    const run = { id: 'run-py-shadow', slug: 'production-lib', repo_path: repo, branch: 'trident/production-lib-proof' }
    const claim = {
      file: 'src/limit.ts',
      find: 'n > max ? max : n',
      replace: 'n',
      control: ['bun', 'test', 'tests/other-control.test.ts'],
    }
    const out = await runMutationProofGate({
      run,
      claim: { ...claim, guard: ['python3', '-m', 'pytest', 'tests/unrelated_test.py'] },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([out.ok, out.exempt, out.evidence?.proved ?? null]).toEqual([false, false, false])
    expect(out.reason).toContain('BRANCH-SUPPLIED')
    expect(out.reason).toContain('pytest')
    expect(out.reason).toContain('claim.guard')
    // Nothing was spawned, so the shadow module never wrote its marker…
    expect(existsSync(join(repo, 'pwned-by-python-shadow'))).toBe(false)
    // …and nothing was left behind.
    expect(existsSync(proofWorktreePath(repo, run))).toBe(false)

    // POSITIVE CONTROL, in the same repo with the shadowing package committed
    // and all: a runner the tree cannot shadow still proves red-then-green.
    const fine = await runMutationProofGate({
      run: { ...run, id: 'run-py-shadow-control' },
      claim: { ...claim, guard: ['bun', 'test', 'tests/limit.test.ts'] },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([fine.ok, fine.exempt, fine.evidence?.proved ?? null]).toEqual([true, false, true])
    const pyObs = fine.evidence?.observed
    expect(pyObs ?? null).not.toBeNull()
    if (!pyObs) throw new Error('unreachable')
    expect(pyObs.guard_mutated.exit_code).not.toBe(0)
    expect(pyObs.control_mutated.exit_code).toBe(0)
    expect(pyObs.guard_restored.exit_code).toBe(0)
  }, 120_000)

  test('a committed conftest.py and a committed argparse.py are refused too — the tree without a flag', async () => {
    // THE TWO SIBLINGS of the shadow above, end to end. Neither puts anything
    // in the argv: `conftest.py` is imported BY PYTEST ITSELF before collection
    // (here a directory down, where pytest's rootdir search really looks), and
    // `argparse.py` is a stdlib name the REAL runner imports on its way up,
    // which the module-name check never looks at. Both markers stay unwritten,
    // which is how we know nothing was executed and this needs no python on the
    // box.
    const repo = await seedProductionLib()
    writeFileSync(join(repo, 'tests', 'conftest.py'), "open('../../pwned-by-conftest','w').write('x')\n")
    writeFileSync(join(repo, 'argparse.py'), "open('../../pwned-by-argparse','w').write('x')\n")
    writeFileSync(join(repo, 'tests', 'unrelated_test.py'), 'def test_ok():\n    assert True\n')
    await git(repo, 'add', '-A')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'a conftest and a shadowed stdlib name')
    const run = { id: 'run-py-conf', slug: 'production-lib', branch: 'trident/production-lib-proof', repo_path: repo }
    const claim = {
      file: 'src/limit.ts',
      find: 'n > max ? max : n',
      replace: 'n',
      control: ['bun', 'test', 'tests/other-control.test.ts'],
    }

    const conf = await runMutationProofGate({
      run,
      claim: { ...claim, guard: ['python3', '-m', 'pytest', 'tests/unrelated_test.py'] },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([conf.ok, conf.exempt, conf.evidence?.proved ?? null]).toEqual([false, false, false])
    expect(conf.reason).toContain('tests/conftest.py')
    expect(conf.reason).toContain('nothing on the argv')

    const dep = await runMutationProofGate({
      run: { ...run, id: 'run-py-dep' },
      claim: { ...claim, guard: ['python3', '-m', 'unittest', 'tests.unrelated_test'] },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([dep.ok, dep.exempt, dep.evidence?.proved ?? null]).toEqual([false, false, false])
    expect(dep.reason).toContain('argparse.py')
    expect(dep.reason).toContain('sys.path')

    expect(existsSync(join(repo, 'pwned-by-conftest'))).toBe(false)
    expect(existsSync(join(repo, 'pwned-by-argparse'))).toBe(false)
    expect(existsSync(proofWorktreePath(repo, run))).toBe(false)

    // POSITIVE CONTROL, in the same repo with both files committed: a runner
    // that does not search the tree still proves red-then-green, so these two
    // refusals are about the nomination and not about the repo.
    const fine = await runMutationProofGate({
      run: { ...run, id: 'run-py-conf-control' },
      claim: { ...claim, guard: ['bun', 'test', 'tests/limit.test.ts'] },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([fine.ok, fine.exempt, fine.evidence?.proved ?? null]).toEqual([true, false, true])
  }, 120_000)

  test('the mutated file under an ABSOLUTE or ..-and-back name is still its own guard, and is refused', async () => {
    // THE BYPASS, against real git and the real path the proof worktree lands
    // at. The guard below runs `tests/support/clamp.ts` — the MUTATED file —
    // as its own test, spelled so no comparison against a repo-relative
    // `claim.file` can ever match it. Before this rule the gate ran it, watched
    // the file it had just broken fail to parse its own assertions, and
    // recorded `proved: true` off a test that never asserted the behaviour.
    const lib = await seedSupportLib()
    const run = { id: 'run-abs', slug: 'support-lib', repo_path: lib, branch: 'trident/support-lib-proof' }
    const worktree = proofWorktreePath(lib, run)
    const spellings = [
      `${worktree}/tests/support/clamp.ts`,
      `../${worktree.split('/').pop() as string}/tests/support/clamp.ts`,
    ]
    for (const spelling of spellings) {
      const out = await runMutationProofGate({
        run,
        claim: {
          file: 'tests/support/clamp.ts',
          find: 'n > max ? max : n',
          replace: 'n',
          guard: ['bun', 'test', spelling],
          control: ['bun', 'test', 'tests/other-control.test.ts'],
        },
        base_branch: 'main',
        run_host: spawnCapture,
      })
      expect([spelling, out.ok, out.exempt, out.evidence?.proved ?? null]).toEqual([spelling, false, false, false])
      expect(out.reason).toContain('must be a repo-relative path inside the worktree')
      // Nothing was executed, so nothing was left behind either.
      expect(existsSync(worktree)).toBe(false)
    }
  }, 60_000)

  test('an option that CARRIES the mutated file runs it as its own guard, and is refused', async () => {
    // THE REPRO A REVIEWER PERSISTED. `--preload=./tests/support/clamp.ts` is
    // ONE argv element, so the whole-element comparison matched nothing; it is
    // repo-relative, so the escapes-the-worktree rule matched nothing either —
    // and bun LOADS the mutated file into the very process that runs the guard.
    // Red under the mutation, green restored, "proved", with the separate test
    // never asserting the behaviour at all.
    const lib = await seedSupportLib()
    const run = { id: 'run-preload', slug: 'support-lib', repo_path: lib, branch: 'trident/support-lib-proof' }
    const worktree = proofWorktreePath(lib, run)
    const out = await runMutationProofGate({
      run,
      claim: {
        file: 'tests/support/clamp.ts',
        find: 'n > max ? max : n',
        replace: 'n',
        guard: ['bun', 'test', '--preload=./tests/support/clamp.ts', 'tests/other-control.test.ts'],
        control: ['bun', 'test', 'tests/other-control.test.ts'],
      },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([out.ok, out.exempt, out.evidence?.proved ?? null]).toEqual([false, false, false])
    expect(out.reason).toContain('tautology')
    // Refused BEFORE anything ran, so no proof worktree was ever created.
    expect(existsSync(worktree)).toBe(false)
  }, 60_000)

  test('a `file://` URL is the third spelling of an absolute path, and is refused', async () => {
    // THE REVIEWER'S REPRO. `file://` starts with no `/`, carries no `=/` and
    // has no `..` segment, so every lexical arm of the escape rule passed it —
    // and `carriedValue` normalizes `file:///a/tests/support/clamp.ts` to
    // `file:/a/tests/support/clamp.ts`, which equals no repo-relative target.
    // Bun preloaded the MUTATED file into the guard process, where it threw and
    // became its own RED against an assertion-free "separate" test.
    const lib = await seedSupportLib()
    const run = { id: 'run-url', slug: 'support-lib', repo_path: lib, branch: 'trident/support-lib-proof' }
    const worktree = proofWorktreePath(lib, run)
    const guards = [
      ['bun', 'test', `--preload=file://${worktree}/tests/support/clamp.ts`, 'tests/other-control.test.ts'],
      ['bun', 'test', `file://${worktree}/tests/support/clamp.ts`],
    ]
    for (const guard of guards) {
      const out = await runMutationProofGate({
        run,
        claim: {
          file: 'tests/support/clamp.ts',
          find: 'n > max ? max : n',
          replace: 'n',
          guard,
          control: ['bun', 'test', 'tests/other-control.test.ts'],
        },
        base_branch: 'main',
        run_host: spawnCapture,
      })
      expect([guard.join(' '), out.ok, out.exempt, out.evidence?.proved ?? null]).toEqual([
        guard.join(' '),
        false,
        false,
        false,
      ])
      expect(out.reason).toContain('must be a repo-relative path inside the worktree')
      // Refused before anything ran, so nothing was mutated and nothing spawned.
      expect(existsSync(worktree)).toBe(false)
    }
  }, 60_000)

  test('a guard argument that is a SYMLINK to the mutated file is still that file, and is refused', async () => {
    // THE REVIEWER'S SECOND REPRO, against real git and real bun.
    // `tests/alias.test.ts` is committed as a symlink to
    // `tests/support/clamp.ts`. The two SPELLINGS differ, so the static
    // tautology check — which compares strings — waved it through, and bun
    // followed the link and ran the MUTATED library as its own assertion-free
    // guard: red mutated, green restored, "proved".
    const lib = await seedSupportLib({ alias: true })
    const run = { id: 'run-alias', slug: 'support-lib', repo_path: lib, branch: 'trident/support-lib-proof' }
    // The mutation BREAKS THE PARSE deliberately: that is what makes the forged
    // proof complete without the fix. The mutated library cannot be loaded, so
    // bun exits non-zero on the alias (RED); restored, the alias parses, holds
    // no test cases, and exits zero (GREEN). Red-then-green off a file that
    // asserted nothing — which is exactly the tautology, wearing a test's name.
    const claim = {
      file: 'tests/support/clamp.ts',
      find: 'return n > max ? max : n',
      replace: 'return n > max ? max : n +',
      guard: ['bun', 'test', 'tests/alias.test.ts'],
      control: ['bun', 'test', 'tests/other-control.test.ts'],
    }
    const out = await runMutationProofGate({ run, claim, base_branch: 'main', run_host: spawnCapture })
    expect([out.ok, out.exempt, out.evidence?.proved ?? null]).toEqual([false, false, false])
    expect(out.reason).toContain('tautology')
    expect(out.reason).toContain('resolves to the same file')
    // Refused BEFORE the mutation was written: the proof made no observations.
    expect(out.evidence?.observed ?? null).toBeNull()

    // POSITIVE CONTROL, in the SAME repo: the honest guard — a real separate
    // test of the library — still proves. So the refusal above is about the
    // alias, not about a repo the prover simply cannot prove anything in.
    const honest = await runMutationProofGate({
      run: { ...run, id: 'run-alias-control' },
      claim: { ...claim, guard: ['bun', 'test', 'tests/support/clamp.test.ts'] },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([honest.ok, honest.exempt, honest.evidence?.proved ?? null]).toEqual([true, false, true])
  }, 120_000)

  test('a guard argument the runner reads as a FILTER is refused — RESOLVING does not make it a selection', async () => {
    // THE REVIEWER'S REPRO, end to end against real git and real bun, in the
    // shape that beat the first fix. `src/thing_test.ts` classifies PRODUCTION
    // (a runner collects that name; no convention declares it a test), so it is
    // a legal nomination. The first cut refused these guards only when the
    // argument existed in NO tree — but the branch under proof writes the tree,
    // so both spellings can be made to RESOLVE and neither becomes a selection:
    //
    //  • this repo commits a root `thing_test.ts`, so `bun test thing_test.ts`
    //    names a real file — and bun still reads the positional as a SUBSTRING
    //    FILTER, so the whole-suite discovery run reaches the mutated file and
    //    lets it be its own guard;
    //  • it commits `out/report.test.ts`, so `--reporter-outfile
    //    out/report.test.ts` resolves — and it is still a file bun WRITES
    //    during a whole-suite run, dressed as a selection well enough to
    //    suppress the no-path arm.
    //
    // Both are matching semantics, not existence, so both are refused
    // lexically. The last case keeps the resolution seam covered: an argument
    // no tree holds AND no filter explains is still refused for not existing.
    const lib = await seedCollectibleLib({ decoys: true })
    const run = { id: 'run-filter', slug: 'collectible-lib', repo_path: lib, branch: 'trident/collectible-lib-proof' }
    const worktree = proofWorktreePath(lib, run)
    // The decoys really are in the tree — otherwise the first two cases would
    // be passing for the OLD reason (nothing on disk) and prove nothing new.
    expect(existsSync(join(lib, 'thing_test.ts'))).toBe(true)
    expect(existsSync(join(lib, 'out', 'report.test.ts'))).toBe(true)
    for (const [guard, expected] of [
      [['bun', 'test', 'thing_test.ts'], 'tautology'],
      [['bun', 'test', '--reporter-outfile', 'out/report.test.ts'], 'tautology'],
      [['bun', 'test', '--reporter', 'junit', '--reporter-outfile', '.output/report.test.ts'], 'tautology'],
      [['bun', 'test', 'tests/nothing-holds-this.test.ts'], 'does not exist at'],
    ] as [string[], string][]) {
      const out = await runMutationProofGate({
        run,
        claim: {
          file: 'src/thing_test.ts',
          // A PARSE-breaking mutation, which is what makes the forgery work:
          // the mutated file cannot even load, so the discovery run that
          // collects it goes red — and goes green again once it is restored.
          find: 'CEILING = 3',
          replace: 'CEILING =',
          guard,
          control: ['bun', 'test', 'tests/other-control.test.ts'],
        },
        base_branch: 'main',
        run_host: spawnCapture,
      })
      expect([guard.join(' '), out.ok, out.exempt, out.evidence?.proved ?? null]).toEqual([
        guard.join(' '),
        false,
        false,
        false,
      ])
      expect(out.reason).toContain(expected)
      // Refused before the file was ever mutated, and the throwaway worktree
      // was removed either way.
      expect(existsSync(worktree)).toBe(false)
    }

    // POSITIVE CONTROL — the SAME target, mutated for real, with a guard naming
    // the separate test the tree actually holds: red under the mutation, green
    // restored, control green throughout. Without this the refusals above could
    // be refusing this whole class of honest nomination.
    const ok = await runMutationProofGate({
      run: { ...run, id: 'run-filter-ok' },
      claim: {
        file: 'src/thing_test.ts',
        find: 'n > max ? max : n',
        replace: 'n',
        guard: ['bun', 'test', 'tests/thing.test.ts'],
        control: ['bun', 'test', 'tests/other-control.test.ts'],
      },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([ok.ok, ok.exempt, ok.evidence?.proved ?? null]).toEqual([true, false, true])
    const obs = ok.evidence?.observed
    expect(obs ?? null).not.toBeNull()
    if (!obs) throw new Error('unreachable')
    expect(obs.guard_mutated.exit_code).not.toBe(0)
    expect(obs.control_mutated.exit_code).toBe(0)
    expect(obs.guard_restored.exit_code).toBe(0)
  }, 120_000)

  test('ONE EXTRA TOKEN beside an honest selector is still the mutated file running as its own guard', async () => {
    // THE REPRO, end to end against real git and real bun. Every argv below
    // carries a REAL selector — `tests/other-control.test.ts`, an unrelated test
    // that passes — so the whole-suite arm has nothing to say. The second token
    // is what does the work: bun reads `thing` as a substring filter and
    // `--coverage`'s operand as another positional, and either one drags
    // `src/thing_test.ts` — the file the prover has just broken so badly it
    // cannot parse — into the same run. Red under the mutation, green restored,
    // and the "proof" is the mutated file failing to load itself.
    const lib = await seedCollectibleLib()
    const run = { id: 'run-token', slug: 'collectible-lib', repo_path: lib, branch: 'trident/collectible-lib-proof' }
    const worktree = proofWorktreePath(lib, run)
    for (const guard of [
      ['bun', 'test', 'tests/other-control.test.ts', 'thing'],
      ['bun', 'test', 'tests/other-control.test.ts', '--coverage', 'thing_test.ts'],
    ]) {
      const out = await runMutationProofGate({
        run,
        claim: {
          file: 'src/thing_test.ts',
          find: 'CEILING = 3',
          replace: 'CEILING =',
          guard,
          control: ['bun', 'test', 'tests/other-control.test.ts'],
        },
        base_branch: 'main',
        run_host: spawnCapture,
      })
      expect([guard.join(' '), out.ok, out.exempt, out.evidence?.proved ?? null]).toEqual([
        guard.join(' '),
        false,
        false,
        false,
      ])
      expect(out.reason).toContain('tautology')
      // Refused on the spelling, so the file was never broken and the throwaway
      // worktree was never left behind.
      expect(existsSync(worktree)).toBe(false)
    }

    // POSITIVE CONTROL — the same target, really mutated, guarded by the
    // separate test that asserts it, with an option carrying a NUMBER beside it.
    // Without this the refusals above could be refusing every argv that has more
    // than two elements, which would close the class this card exists to open.
    const ok = await runMutationProofGate({
      run: { ...run, id: 'run-token-ok' },
      claim: {
        file: 'src/thing_test.ts',
        find: 'n > max ? max : n',
        replace: 'n',
        guard: ['bun', 'test', 'tests/thing.test.ts', '--timeout=30000'],
        control: ['bun', 'test', 'tests/other-control.test.ts'],
      },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([ok.ok, ok.exempt, ok.evidence?.proved ?? null]).toEqual([true, false, true])
    const obs = ok.evidence?.observed
    expect(obs ?? null).not.toBeNull()
    if (!obs) throw new Error('unreachable')
    expect(obs.guard_mutated.exit_code).not.toBe(0)
    expect(obs.control_mutated.exit_code).toBe(0)
    expect(obs.guard_restored.exit_code).toBe(0)
  }, 120_000)

  test('a RENAME shows both source and destination, so a renamed production file cannot buy the exemption', async () => {
    // `git mv src/limit.ts src/limit.test.ts` under default rename detection
    // prints ONLY the destination — a declared test — and the whole diff would
    // then classify as "no production file changed" and merge unproved. The
    // mocked test can only see the `--no-renames` flag in an argv; this sees
    // what real git DOES with it.
    const repo = await seedDiffRepo('rename', async (r) => {
      await git(r, 'mv', 'src/limit.ts', 'src/limit.test.ts')
    })
    const head = await git(repo, 'rev-parse', 'HEAD')
    const files = await changedFilesOnBranch(spawnCapture, repo, 'main', head)
    expect([...(files ?? [])].sort()).toEqual(['src/limit.test.ts', 'src/limit.ts'])

    // …and the gate REFUSES rather than exempting: the source is production.
    const out = await runMutationProofGate({
      run: { id: 'run-rename', slug: 'rename', repo_path: repo, branch: BRANCH },
      claim: null,
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([out.ok, out.exempt]).toEqual([false, false])
    expect(out.reason).toContain('src/limit.ts')

    // POSITIVE CONTROL on the reader itself: a branch that renames NOTHING
    // still reads its own files, so the assertion above cannot be passing on a
    // reader that returns everything under the sun.
    const plain = await seedDiffRepo('rename-control', async (r) => {
      writeFileSync(join(r, 'src', 'limit.ts'), 'export const LIMIT = 4\n')
    })
    expect(await changedFilesOnBranch(spawnCapture, plain, 'main', await git(plain, 'rev-parse', 'HEAD'))).toEqual([
      'src/limit.ts',
    ])
  }, 60_000)

  test('a NON-ASCII path arrives as itself — git quotes it by default and every classifier then misreads it', async () => {
    // #489's own deadlock, one encoding further out: by default git C-quotes any
    // path with a byte outside ASCII, so `tests/süß.test.ts` arrives as
    // `"tests/s\303\274\303\237.test.ts"`. That basename matches no test
    // convention, so a declared test classifies as PRODUCTION, the exemption
    // cannot fire, and the gate refuses an all-test diff — blaming the build for
    // an omission it did not make.
    const name = 'tests/süß.test.ts'
    const repo = await seedDiffRepo('non-ascii', async (r) => {
      mkdirSync(join(r, 'tests'), { recursive: true })
      writeFileSync(join(r, name), "import { expect, test } from 'bun:test'\n\ntest('x', () => expect(1).toBe(1))\n")
    })
    const files = await changedFilesOnBranch(spawnCapture, repo, 'main', await git(repo, 'rev-parse', 'HEAD'))
    expect(files).toEqual([name])
    // The literal quoted spelling, so a reader knows exactly what this prevents.
    expect((files ?? []).join('')).not.toContain('\\303')

    const out = await runMutationProofGate({
      run: { id: 'run-non-ascii', slug: 'non-ascii', repo_path: repo, branch: BRANCH },
      claim: null,
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([out.ok, out.exempt]).toEqual([true, true])
    expect(out.reason).toContain(name)
  }, 60_000)

  test('a TRAILING SPACE survives the read — real git, and the file is production, not a test', async () => {
    // The reader used to `.trim()` every line of `--name-only`. `src/logic.test.ts `
    // — a legal git path, and a PRODUCTION file — arrived as `src/logic.test.ts`,
    // a DECLARED TEST, and a diff of it alone bought the no-production-file
    // exemption and merged unproved. The mocked test can only show the parser;
    // this shows what real git actually writes and what the gate then does.
    const spaced = 'src/logic.test.ts '
    const repo = await seedDiffRepo('trailing-space', async (r) => {
      writeFileSync(join(r, spaced), 'export const LIMIT = 4\n')
    })
    const files = await changedFilesOnBranch(spawnCapture, repo, 'main', await git(repo, 'rev-parse', 'HEAD'))
    expect(files).toEqual([spaced])

    // The consequence: no claim, and the gate REFUSES rather than exempting.
    const out = await runMutationProofGate({
      run: { id: 'run-trailing-space', slug: 'trailing-space', repo_path: repo, branch: BRANCH },
      claim: null,
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([out.ok, out.exempt]).toEqual([false, false])
    expect(out.reason).toContain('a legal mutation target existed')
  }, 60_000)

  test('a LEADING SPACE survives too — the host seam trims the whole stdout, and the status letter blocks it', async () => {
    // THE BUG THIS CLOSES, and it needs REAL git plus the REAL host seam:
    // `spawnCapture` returns `stdout.trim()`, and that runs before the reader
    // sees a byte. Under `--name-only` the first record WAS the first path, so a
    // branch whose only changed file is ` README.md` — a legal git path, and NOT
    // README.md — arrived as `README.md`, classified as prose, and took the
    // prose-only exemption. The trailing side never had this problem because the
    // record ends in NUL and NUL is not whitespace; `--name-status` gives the
    // front of the stream the same protection, with a status letter.
    const spaced = ' README.md'
    const repo = await seedDiffRepo('leading-space', async (r) => {
      writeFileSync(join(r, spaced), 'not the readme\n')
    })
    const files = await changedFilesOnBranch(spawnCapture, repo, 'main', await git(repo, 'rev-parse', 'HEAD'))
    expect(files).toEqual([spaced])

    // The consequence, not just the string: the odd name is not prose, so the
    // gate REFUSES rather than exempting.
    const out = await runMutationProofGate({
      run: { id: 'run-leading-space', slug: 'leading-space', repo_path: repo, branch: BRANCH },
      claim: null,
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([out.ok, out.exempt]).toEqual([false, false])

    // POSITIVE CONTROL — the space is the only difference: the same name
    // without it reads back exactly and DOES buy the prose-only exemption, so
    // this test cannot be passing on a reader that mangles every path.
    const plain = await seedDiffRepo('leading-space-control', async (r) => {
      writeFileSync(join(r, 'README.md'), 'edited\n')
    })
    expect(await changedFilesOnBranch(spawnCapture, plain, 'main', await git(plain, 'rev-parse', 'HEAD'))).toEqual([
      'README.md',
    ])
    const exempt = await runMutationProofGate({
      run: { id: 'run-leading-space-ok', slug: 'leading-space-ok', repo_path: plain, branch: BRANCH },
      claim: null,
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([exempt.ok, exempt.exempt]).toEqual([true, true])
    expect(exempt.reason).toContain('prose-only')
  }, 60_000)

  test('a DELETION-ONLY production diff is refused, and the refusal does not name the file it cannot mutate', async () => {
    // THE DEADLOCK, both halves, against real git: the branch deletes its only
    // production file and edits a test. The refusal used to say "a legal
    // mutation target existed: src/limit.ts" — and the second half below is why
    // that was a closed loop.
    const repo = await seedDiffRepo('deletion-only', async (r) => {
      rmSync(join(r, 'src', 'limit.ts'))
      writeFileSync(join(r, 'src', 'limit.test.ts'), "import { test } from 'bun:test'\n\ntest('x', () => {})\n")
    })
    const head = await git(repo, 'rev-parse', 'HEAD')
    // git really does report the deletion, and the reader really does keep it.
    expect([...(await changedFilesOnBranch(spawnCapture, repo, 'main', head) ?? [])].sort()).toEqual([
      'src/limit.test.ts',
      'src/limit.ts',
    ])
    const run = { id: 'run-deletion-only', slug: 'deletion-only', repo_path: repo, branch: BRANCH }
    const out = await runMutationProofGate({ run, claim: null, base_branch: 'main', run_host: spawnCapture })
    // NOT exempt — a deletion is a production change, and exempting it would
    // hand `git mv src/limit.ts src/limit.test.ts` the pass `--no-renames`
    // exists to deny (the rename test above).
    expect([out.ok, out.exempt]).toEqual([false, false])
    expect(out.reason).toContain('DELETIONS')
    expect(out.reason).toContain('src/limit.ts')
    expect(out.reason).not.toContain('nominated no mutation')

    // THE OTHER HALF OF THE LOOP, so this is not taken on trust: nominating the
    // very file the OLD refusal pointed at is refused by the prover for being
    // absent at the head. Two refusals with no way out is why the message had
    // to stop sending the build after it.
    const nominated = await runMutationProofGate({
      run: { ...run, id: 'run-deletion-only-claim' },
      claim: {
        file: 'src/limit.ts',
        find: 'LIMIT = 3',
        replace: 'LIMIT = 4',
        guard: ['bun', 'test', 'src/limit.test.ts'],
        control: ['bun', 'test', 'src/other.test.ts'],
      },
      base_branch: 'main',
      run_host: spawnCapture,
    })
    expect([nominated.ok, nominated.evidence?.proved ?? null]).toEqual([false, false])
    expect(nominated.reason).toContain('does not exist at')
  }, 60_000)

  test('an expected_head that names a TREE is refused — only the `^{commit}` peel says so', async () => {
    const w = await seedWorld('tree-sha')
    const tree = await git(w.consumer, 'rev-parse', `${w.stale}^{tree}`)
    // The object IS in this repo: a bare `cat-file -e` would wave it through.
    expect((await spawnCapture(['git', '-C', w.consumer, 'cat-file', '-e', tree], w.consumer)).ok).toBe(true)
    expect(await resolveMergeHeadSha(spawnCapture, w.consumer, 'no-such-branch-anywhere', tree)).toBeNull()
    expect(await resolveMergeHeadSha(spawnCapture, w.consumer, 'no-such-branch-anywhere', w.stale)).toBe(w.stale)
  })
})
