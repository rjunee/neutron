/**
 * Tests for the workspace-deps precondition.
 *
 * THE CONTROLS ARE THE POINT. This verifier's whole job is to tell an installed
 * tree from an uninstalled one, so a test suite for it that only ever runs the
 * happy path proves nothing: a `process.exit(0)` at the top of the file would
 * pass it. Every behavioural test below is therefore PAIRED — the healthy tree
 * must exit 0 AND a tree missing the same thing must exit 3.
 *
 * The negative fixtures are built by COPYING the real checkout's shape and
 * removing exactly one thing, rather than by hand-rolling a fake repo. A
 * hand-rolled fixture drifts from the layout it claims to model, and this
 * verifier is entirely about that layout.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const HERE = import.meta.dir
const VERIFIER = join(HERE, 'verify-workspace-deps.ts')
const REPO_ROOT = join(HERE, '..', '..')

const REFUSAL = 3

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function run(root: string): { code: number; out: string } {
  const result = spawnSync('bun', [VERIFIER, root], { encoding: 'utf8' })
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/**
 * A minimal but STRUCTURALLY REAL workspace: a bun store with one package in
 * it, and one workspace package that declares that dependency and reaches it
 * through its own node_modules. Mutations peel one layer off this.
 */
function makeTree(options: { store?: boolean; link?: boolean; declare?: boolean } = {}): string {
  const { store = true, link = true, declare = true } = options
  const root = mkdtempSync(join(tmpdir(), 'verify-deps-'))
  scratch.push(root)

  if (store) {
    const real = join(root, 'node_modules', '.bun', 'left-pad@1.0.0', 'node_modules', 'left-pad')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'package.json'), JSON.stringify({ name: 'left-pad', main: 'index.js' }))
    writeFileSync(join(real, 'index.js'), 'module.exports = () => {}\n')
  } else {
    mkdirSync(join(root, 'node_modules'), { recursive: true })
  }

  const pkg = join(root, 'app')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@fixture/app', dependencies: declare ? { 'left-pad': '1.0.0' } : {} }),
  )

  if (link && store) {
    const linkPath = join(pkg, 'node_modules', 'left-pad')
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(join(root, 'node_modules', '.bun', 'left-pad@1.0.0', 'node_modules', 'left-pad'), linkPath)
  }

  return root
}

describe('verify-workspace-deps — the real checkout', () => {
  // THE POSITIVE CONTROL. If this ever fails, every refusal below is worthless
  // because the verifier is simply refusing everything.
  test('this checkout is installed, so the verifier passes it', () => {
    const { code, out } = run(REPO_ROOT)
    expect(code).toBe(0)
    expect(out).toContain('verify-workspace-deps: OK')
  })

  test('a passing run still reports the gaps it found rather than swallowing them', () => {
    // Measured on main: 4 of 32 packages cannot resolve their first declared
    // dependency and the tree is still perfectly usable. Those are real and
    // must stay visible — a silent one becomes the next unexplained
    // "pre-existing failure".
    const { out } = run(REPO_ROOT)
    expect(out).toMatch(/resolved a declared dependency\.$/m)
  })
})

describe('verify-workspace-deps — an uninstalled tree is refused', () => {
  test('a tree with no bun store is refused with exit 3', () => {
    const { code, out } = run(makeTree({ store: false }))
    expect(code).toBe(REFUSAL)
    expect(out).toContain('node_modules/.bun does not exist')
  })

  test('the refusal names the remedy', () => {
    const { out } = run(makeTree({ store: false }))
    expect(out).toContain('bun install')
  })

  test('a store that exists but is empty is refused too', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-deps-empty-'))
    scratch.push(root)
    mkdirSync(join(root, 'node_modules', '.bun'), { recursive: true })
    const { code, out } = run(root)
    expect(code).toBe(REFUSAL)
    expect(out).toContain('is empty')
  })

  test('a store that is present while nothing resolves is still refused', () => {
    // The anti-presence case, and the reason check 2 is a resolution sweep
    // rather than a directory listing: the store is right there and the tree
    // is still unusable.
    const { code, out } = run(makeTree({ link: false }))
    expect(code).toBe(REFUSAL)
    expect(out).toContain('cannot resolve')
  })

  test('a fully installed fixture passes — the mutations above are what fail, not the fixture', () => {
    const { code } = run(makeTree())
    expect(code).toBe(0)
  })
})

describe('verify-workspace-deps — an empty check must not read as a passing check', () => {
  test('a directory with no workspace packages at all is refused, not called clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-deps-bare-'))
    scratch.push(root)
    const real = join(root, 'node_modules', '.bun', 'left-pad@1.0.0', 'node_modules', 'left-pad')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'package.json'), JSON.stringify({ name: 'left-pad' }))

    const { code, out } = run(root)
    expect(code).toBe(REFUSAL)
    expect(out).toContain('NO workspace packages')
  })

  test('packages that declare no dependencies are refused rather than reported clean', () => {
    const { code, out } = run(makeTree({ declare: false }))
    expect(code).toBe(REFUSAL)
    expect(out).toContain('none of the')
  })
})

describe('verify-workspace-deps — it runs where it is needed', () => {
  test('it imports nothing from the workspace, so it survives a tree that resolves nothing', async () => {
    // A CONTRACT, not tidiness. This file runs exactly when `@neutronai/*`
    // cannot be resolved; an import of one would kill the verifier with the
    // same error class it exists to report.
    const source = await Bun.file(VERIFIER).text()
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)]
      .map((m) => m[1])
      .filter((spec): spec is string => typeof spec === 'string')
    // Loud-empty: an extraction that found no imports would pass the loop below
    // vacuously, which is the same defect this repo has shipped twice.
    expect(imports.length).toBeGreaterThan(0)
    for (const spec of imports) expect(spec.startsWith('node:')).toBe(true)
  })

  // NO TIMING TEST HERE, DELIBERATELY. The draft of this file asserted the
  // verifier finishes inside five seconds, to pin the claim that it is cheap
  // enough to sit in front of every suite run (~60 ms measured). CI's
  // wall-clock-bound gate rejected it, and correctly: a clock comparison in a
  // test is the flake class that gate exists to ban, and "cheap" has no
  // deterministic substitute worth faking one for. The cost claim belongs in
  // the commit message, where it is a measurement rather than an assertion.
  // What IS asserted deterministically is that the verifier reads no test
  // files and runs no suite — it only walks package manifests.
  test('it spawns nothing — it reads manifests, it does not run the suite', async () => {
    const source = await Bun.file(VERIFIER).text()
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // The first draft of THIS test matched on prose and failed on the file's
    // own header, which cites `activity-client.test.ts` as the positive
    // control. Comments are stripped so the assertion is about the code.
    expect(code).toContain('readdirSync')
    expect(code).not.toContain('Bun.spawn')
    expect(code).not.toContain('execFileSync')
  })
})

describe('verify-workspace-deps — run-tests.sh actually enforces it', () => {
  const runner = Bun.file(join(REPO_ROOT, 'scripts', 'run-tests.sh'))

  test('the runner invokes the verifier and refuses on a non-zero status', async () => {
    const source = await runner.text()
    expect(source).toContain('ci/verify-workspace-deps.ts')
    expect(source).toContain('run-tests: REFUSED')
    // Declared is not called. The guard must be an `if !` that exits.
    expect(source).toMatch(/if ! bun "\$\{SCRIPT_DIR\}\/ci\/verify-workspace-deps\.ts" "\$ROOT"; then/)
    expect(source).toMatch(/exit 3/)
  })

  test('the guard runs BEFORE any test file is discovered', async () => {
    const source = await runner.text()
    const guardAt = source.indexOf('verify-workspace-deps.ts')
    const discoverAt = source.indexOf('neutron_discover_test_files')
    expect(guardAt).toBeGreaterThan(-1)
    expect(discoverAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(discoverAt)
  })

  test('the guard does not hand itself to a substituted bun', async () => {
    // The selftests replace `bun` with a stub that prints canned output. Asking
    // that stub whether the tree is installed makes the check answer with
    // whatever the test scripted — this exclusion is why the guard calls `bun`
    // directly rather than NEUTRON_BUN_BIN.
    const source = await runner.text()
    const guardAt = source.indexOf('ci/verify-workspace-deps.ts')
    const block = source.slice(Math.max(0, guardAt - 600), guardAt)
    expect(block).toContain('NEUTRON_BUN_BIN')
    expect(block).toContain('NEUTRON_TEST_ROOT')
    expect(block).toContain('NEUTRON_TEST_PLAN_ONLY')
  })
})
