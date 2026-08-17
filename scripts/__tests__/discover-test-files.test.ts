/**
 * `scripts/lib/discover-test-files.sh` — the single answer to "what is the suite?".
 *
 * WHY THIS SUITE EXISTS, and it is not the obvious reason. Discovery already has
 * a guard: `scripts/run-tests.sh` cross-checks the count against bun's own walk
 * and aborts on drift. That guard catches discovering too FEW or too MANY files.
 * It cannot catch discovering ZERO, because the runner treats zero as its own
 * fatal error and never reaches the cross-check — and zero is exactly what the
 * first draft of the `-prune` form produced.
 *
 * The bug: `find . \( -name '.*' \) -prune` matches `.`, the starting directory
 * itself. Pruning that prunes the entire walk. It printed nothing, exited 0, and
 * read like a repo with no tests. So the cases below pin the three exclusions
 * against a fixture where each one can be seen to bite, and each assertion can
 * fail for the reason it is testing.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LIB = join(ROOT, 'scripts', 'lib', 'discover-test-files.sh')

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** Run the real helper with `cwd` as the tree under test. */
function discover(cwd: string): string[] {
  const r = spawnSync('bash', ['-c', `. "$1"; neutron_discover_test_files`, 'bash', LIB], {
    encoding: 'utf8',
    cwd,
  })
  expect(r.status).toBe(0)
  return r.stdout.split('\n').filter((l) => l.length > 0)
}

function tree(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'discover-'))
  dirs.push(dir)
  for (const rel of files) {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'x\n')
  }
  return dir
}

describe('neutron_discover_test_files', () => {
  test('finds every test/spec spelling, once, sorted', () => {
    const root = tree([
      'a.test.ts',
      'b.test.tsx',
      'c.test.js',
      'd.test.jsx',
      'e.test.mjs',
      'f.test.cjs',
      'g.spec.ts',
      'h.spec.tsx',
      'i.spec.js',
      'j.spec.jsx',
      'k.spec.mjs',
      'l.spec.cjs',
      'not-a-test.ts',
      'README.md',
    ])
    const found = discover(root)
    expect(found).toHaveLength(12)
    expect(found).not.toContain('./not-a-test.ts')
    expect(found.slice().sort()).toEqual(found)
  })

  test('NEVER EMPTY on a tree that has tests — the prune-the-root regression', () => {
    // `-name '.*'` matches `.`; pruning it prunes everything and prints nothing
    // with exit 0, which reads as "this repo has no tests" rather than as a bug.
    // The runner's coverage cross-check cannot catch this: zero files is its own
    // fatal path, reached before the cross-check runs.
    expect(discover(tree(['one.test.ts']))).toEqual(['./one.test.ts'])
  })

  test('node_modules is excluded at any depth', () => {
    const root = tree(['keep.test.ts', 'node_modules/dep/bad.test.ts', 'pkg/node_modules/dep/bad.test.ts'])
    expect(discover(root)).toEqual(['./keep.test.ts'])
  })

  test('dot-directories are excluded at any depth — this is what keeps worktree clones out', () => {
    // `.claude/worktrees/<slug>/` holds whole stale clones of this repo. Left in,
    // they multiplied the suite by ~16x (measured: 20,258 files against 1,273).
    const root = tree([
      'keep.test.ts',
      '.claude/worktrees/clone/copy.test.ts',
      '.git/hooks/nope.test.ts',
      'pkg/.cache/stale.test.ts',
    ])
    expect(discover(root)).toEqual(['./keep.test.ts'])
  })

  test('a hidden test FILE at the top level is still found — only DIRECTORIES are pruned', () => {
    // The exclusion this replaced was `-not -path '*/.*/*'`, which needs a dot
    // component with slashes on BOTH sides, so a top-level `.hidden.test.ts` was
    // included. Pruning `-name '.?*'` without `-type d` would silently drop it.
    // Nothing in the repo relies on that today; changing it unasked would be a
    // behaviour change hiding inside a performance change.
    expect(discover(tree(['.hidden.test.ts']))).toEqual(['./.hidden.test.ts'])
  })

  test('the override seam wins over the walk, verbatim', () => {
    const r = spawnSync('bash', ['-c', `. "$1"; neutron_discover_test_files`, 'bash', LIB], {
      encoding: 'utf8',
      cwd: tree(['real.test.ts']),
      env: { ...(process.env as Record<string, string>), NEUTRON_TEST_DISCOVER_OVERRIDE: './x.test.ts ./y.test.ts' },
    })
    expect(r.status).toBe(0)
    expect(r.stdout.split('\n').filter((l) => l.length > 0)).toEqual(['./x.test.ts', './y.test.ts'])
  })

  test('THIS repo: hundreds of files, and none of them from an excluded tree', () => {
    const found = discover(ROOT)
    expect(found.length).toBeGreaterThan(100)
    expect(found.filter((f) => f.includes('/node_modules/'))).toEqual([])
    expect(found.filter((f) => /(^|\/)\.[^/]+\//.test(f))).toEqual([])
    expect(new Set(found).size).toBe(found.length)
  }, 60_000)
})
