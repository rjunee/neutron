/**
 * `scripts/select-tests-for-changes.sh` — the local test set a build lane runs.
 *
 * WHY THIS IS WORTH A TEST SUITE. The selection used to be PROSE inside the
 * trident build contract: three tiers, a priority order and a cap, re-derived by
 * hand by every agent on every fix round. Prose has no failure mode short of
 * "the agent read it differently", which is invisible — and the two ways it goes
 * wrong point in opposite directions. Select too FEW and a lane pushes a break
 * it could have caught locally. Select too MANY and the lane is running the whole
 * suite again with extra steps, which is the machine saturation this replaces.
 *
 * Every case below drives the real script against a real throwaway git repo. The
 * discovery it uses is the runner's own (`scripts/lib/discover-test-files.sh`),
 * so a file it names is always a file the suite actually contains.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const SELECT = join(ROOT, 'scripts', 'select-tests-for-changes.sh')

const repos: string[] = []
afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true })
})

function write(root: string, rel: string, body: string): void {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

function git(root: string, ...args: string[]): void {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...(process.env as Record<string, string>),
      GIT_AUTHOR_NAME: 'trident',
      GIT_AUTHOR_EMAIL: 'trident@example.com',
      GIT_COMMITTER_NAME: 'trident',
      GIT_COMMITTER_EMAIL: 'trident@example.com',
    },
  })
  if ((r.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stdout}${r.stderr}`)
}

/**
 * A throwaway repo whose `main` holds `committed`, then `changed` applied on top
 * of a branch — i.e. exactly the shape a build lane is in when it runs its tests:
 * edits present in the WORKING TREE, nothing committed yet.
 */
function repo(committed: Record<string, string>, changed: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'select-tests-'))
  repos.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  for (const [rel, body] of Object.entries(committed)) write(dir, rel, body)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  git(dir, 'switch', '-qc', 'lane')
  for (const [rel, body] of Object.entries(changed)) write(dir, rel, body)
  return dir
}

function select(root: string, cap = 40): string[] {
  const r = spawnSync('bash', [SELECT, 'main', String(cap)], {
    encoding: 'utf8',
    cwd: root,
    env: { ...(process.env as Record<string, string>), NEUTRON_TEST_ROOT: root },
  })
  expect(r.status).toBe(0)
  return r.stdout.split('\n').filter((l) => l.length > 0)
}

describe('select-tests-for-changes.sh', () => {
  test('tier (a) — a changed TEST file selects itself', () => {
    const root = repo({ 'src/a.test.ts': 'x', 'src/a.ts': 'y' }, { 'src/a.test.ts': 'x2' })
    expect(select(root)).toContain('src/a.test.ts')
  })

  test('tier (b) — a changed module selects the tests beside it and in its __tests__/', () => {
    const root = repo(
      {
        'pkg/widget.ts': 'export const widget = 1\n',
        'pkg/widget.test.ts': 'import "./widget"\n',
        'pkg/__tests__/other.test.ts': 'unrelated content\n',
        'far/away.test.ts': 'unrelated content\n',
      },
      { 'pkg/widget.ts': 'export const widget = 2\n' },
    )
    const picked = select(root)
    expect(picked).toContain('pkg/widget.test.ts')
    expect(picked).toContain('pkg/__tests__/other.test.ts')
    // A test in an unrelated directory that never names the module is NOT the
    // lane's business — selecting it is how this degenerates into the full suite.
    expect(picked).not.toContain('far/away.test.ts')
  })

  test('tier (c) — a test that NAMES the changed module is selected wherever it lives', () => {
    const root = repo(
      {
        'pkg/widget.ts': 'export const widget = 1\n',
        'elsewhere/consumer.test.ts': 'import { widget } from "../pkg/widget"\n',
      },
      { 'pkg/widget.ts': 'export const widget = 2\n' },
    )
    expect(select(root)).toContain('elsewhere/consumer.test.ts')
  })

  test('an UNTRACKED new test file is selected — git has never seen it', () => {
    // The lane writes its new test and runs before committing, so a selection
    // that only asked `git diff` would miss the very file it just wrote.
    const root = repo({ 'src/a.ts': 'x' }, { 'src/brand-new.test.ts': 'fresh\n' })
    expect(select(root)).toContain('src/brand-new.test.ts')
  })

  test('a DELETED module still selects the tests that imported it', () => {
    // Those tests are exactly what the deletion breaks, so they are the cheapest
    // thing for a local pass to catch. Excluding them would hand the break to CI.
    const root = repo({ 'gone/mod.ts': 'x', 'gone/mod.test.ts': 'import "./mod"\n' })
    rmSync(join(root, 'gone/mod.ts'))
    expect(select(root)).toContain('gone/mod.test.ts')
  })

  test('a DELETED TEST file is never named — the invocation would error on the path', () => {
    // Tier (a) is a list of files handed straight to `bun test`, so a path that
    // is not there does not fail one test, it fails the whole invocation.
    const root = repo({ 'gone/a.test.ts': 'x\n', 'gone/b.test.ts': 'y\n' })
    rmSync(join(root, 'gone/a.test.ts'))
    expect(select(root)).not.toContain('gone/a.test.ts')
  })

  test('a docs-only diff selects NOTHING and exits 0 — an empty set is not an error', () => {
    const root = repo({ 'README.md': 'a\n', 'src/a.test.ts': 'x\n' }, { 'README.md': 'b\n' })
    expect(select(root)).toEqual([])
  })

  test('THE CAP DROPS A WHOLE TIER RATHER THAN TRIMMING ONE', () => {
    // Half of tier (c) is an arbitrary subset with none of the tier's meaning,
    // and the files it keeps are whichever ones sorted first — noise dressed as
    // a decision. Over budget, (c) goes entirely.
    const committed: Record<string, string> = {
      'pkg/thing.ts': 'export const thing = 1\n',
      'pkg/thing.test.ts': 'import "./thing"\n',
    }
    for (let i = 0; i < 20; i++) committed[`wide/c${i}.test.ts`] = 'mentions thing here\n'
    const root = repo(committed, { 'pkg/thing.ts': 'export const thing = 2\n' })

    const capped = select(root, 3)
    expect(capped).toContain('pkg/thing.test.ts')
    expect(capped.filter((f) => f.startsWith('wide/'))).toEqual([])

    // Raise the cap and the same tier comes back whole — proving the drop was the
    // budget talking and not a selection bug.
    expect(select(root, 40).filter((f) => f.startsWith('wide/')).length).toBe(20)
  })

  test('when tier (a) ALONE is over budget, its first CAP files run and no more', () => {
    const committed: Record<string, string> = {}
    const changed: Record<string, string> = {}
    for (let i = 0; i < 10; i++) {
      committed[`many/t${i}.test.ts`] = 'x\n'
      changed[`many/t${i}.test.ts`] = 'y\n'
    }
    const root = repo(committed, changed)
    expect(select(root, 4)).toHaveLength(4)
  })

  test('the output is deduped and stable across runs', () => {
    // A file can qualify under (a), (b) and (c) at once. Running it three times
    // costs three times as much and proves nothing three times.
    const root = repo(
      { 'pkg/thing.ts': 'x\n', 'pkg/thing.test.ts': 'import "./thing"\n' },
      { 'pkg/thing.ts': 'y\n', 'pkg/thing.test.ts': 'import "./thing" // touched\n' },
    )
    const first = select(root)
    expect(new Set(first).size).toBe(first.length)
    expect(select(root)).toEqual(first)
  })

  test('a module name containing regex metacharacters does not blow the grep up', () => {
    // `use-thing.v2.ts` -> basename `use-thing.v2`; unescaped, `.` matches
    // anything and the tier quietly selects half the suite. An unescaped `+`
    // would be a syntax error and empty the tier instead — wrong in both
    // directions, silent in both.
    const root = repo(
      {
        'pkg/use-thing.v2.ts': 'x\n',
        'pkg/other.test.ts': 'refers to use-thing.v2 here\n',
        'far/unrelated.test.ts': 'use-thingXv2 is not the same string\n',
      },
      { 'pkg/use-thing.v2.ts': 'y\n' },
    )
    const picked = select(root)
    expect(picked).toContain('pkg/other.test.ts')
    expect(picked).not.toContain('far/unrelated.test.ts')
  })

  test('outside a git work tree it FAILS LOUD instead of printing an empty set', () => {
    // An empty selection means "nothing to run", so a broken invocation that
    // printed one would read as a clean lane and skip local testing entirely.
    const dir = mkdtempSync(join(tmpdir(), 'select-tests-nogit-'))
    repos.push(dir)
    const r = spawnSync('bash', [SELECT, 'main', '40'], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...(process.env as Record<string, string>), NEUTRON_TEST_ROOT: dir },
    })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).toContain('not a git work tree')
  })
})
