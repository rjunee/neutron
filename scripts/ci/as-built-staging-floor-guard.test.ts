/**
 * The real staging-floor guard against throwaway git repositories.
 *
 * The guard's boundary is the TREE a branch proposes, not a diff: a directory
 * under `.trident/as-built/` that holds a record and no floor is refused however
 * it got that way, and "I could not look" stays a different failure from "I
 * looked and it is wrong".
 *
 * The property the floor buys is proved separately and with real merges, in
 * `trident/as-built-staging-floor-realgit.test.ts` — that file drains a directory
 * with the real promoter and shows the directory-rename conflict appearing when
 * the floor is absent and not appearing when it is present. This file pins the
 * guard that keeps the tree in the state that test proves is safe.
 *
 * The last test is the one that guards MAIN. The guard itself only ever sees
 * branch proposals (pull requests and merge-queue commits, its own header says
 * why), so this suite also asserts that THIS repo's tracked tree satisfies the
 * rule. That assertion runs in every shard on every event, which is the cheapest
 * place a regression on main can be caught.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD_SH = fileURLToPath(new URL('./as-built-staging-floor-guard.sh', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const UNRESOLVABLE_SHA = '0123456789abcdef0123456789abcdef01234567'
const RECORD = '## 2026-09-12 — a staged record\n\nbody\n'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function commit(repo: string, message: string): void {
  git(repo, '-c', 'user.name=Test Setup', '-c', 'user.email=setup@neutron.local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message)
}

function write(repo: string, relative: string, body: string): void {
  const absolute = join(repo, relative)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, body)
}

type GuardResult = { status: number; stdout: string; stderr: string }

/**
 * The guard is run with EVERY input it reads stripped unless this call supplies
 * it. Inside Actions the ambient `GITHUB_ACTIONS`/`GITHUB_EVENT_NAME`/
 * `GITHUB_EVENT_PATH` describe the REAL pull request, and a harness that let them
 * through would be asking the guard about this repo while claiming to ask about a
 * fixture — the event-filter tests below would then pass for the wrong reason.
 */
function runGuard(
  repo: string,
  base?: string,
  head?: string,
  event: { name?: string; actions?: boolean; payload?: string } = {},
): GuardResult {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.GUARD_BASE_SHA
  delete env.GUARD_HEAD_SHA
  delete env.GITHUB_ACTIONS
  delete env.GITHUB_EVENT_NAME
  delete env.GITHUB_EVENT_PATH
  env.AS_BUILT_STAGING_FLOOR_ROOT = repo
  if (base !== undefined) env.GUARD_BASE_SHA = base
  if (head !== undefined) env.GUARD_HEAD_SHA = head
  if (event.name !== undefined) env.GITHUB_EVENT_NAME = event.name
  if (event.actions === true) env.GITHUB_ACTIONS = 'true'
  if (event.payload !== undefined) env.GITHUB_EVENT_PATH = event.payload

  const result = spawnSync('bash', [GUARD_SH], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('as-built staging floor guard (real git)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'staging-floor-guard-'))
  let baseSha = ''
  let cleanSha = ''
  let deletesTopFloorSha = ''
  let unflooredSubdirSha = ''
  let flooredSubdirSha = ''
  let renamesFloorAwaySha = ''
  let mdFloorSha = ''

  beforeAll(() => {
    git(repo, 'init', '-q', '--initial-branch=main')
    // The base is the world AFTER this fix: a floor at the top and a floor in the
    // one directory that holds a record.
    write(repo, '.trident/as-built/.gitkeep', '')
    write(repo, '.trident/as-built/fix/.gitkeep', '')
    write(repo, '.trident/as-built/fix/an-earlier-change.md', RECORD)
    write(repo, 'code.ts', 'export const value = 1\n')
    git(repo, 'add', '-A')
    commit(repo, 'base')
    baseSha = git(repo, 'rev-parse', 'HEAD')

    git(repo, 'switch', '-q', '-c', 'clean', baseSha)
    write(repo, '.trident/as-built/fix/this-change.md', RECORD)
    git(repo, 'add', '-A')
    commit(repo, 'stage a record in a floored directory')
    cleanSha = git(repo, 'rev-parse', 'HEAD')

    git(repo, 'switch', '-q', '-c', 'deletes-top-floor', baseSha)
    git(repo, 'rm', '-q', '.trident/as-built/.gitkeep')
    commit(repo, 'delete the top-level floor')
    deletesTopFloorSha = git(repo, 'rev-parse', 'HEAD')

    git(repo, 'switch', '-q', '-c', 'unfloored-subdir', baseSha)
    write(repo, '.trident/as-built/feat/a-new-prefix.md', RECORD)
    git(repo, 'add', '-A')
    commit(repo, 'stage a record in a directory with no floor')
    unflooredSubdirSha = git(repo, 'rev-parse', 'HEAD')

    git(repo, 'switch', '-q', '-c', 'floored-subdir', baseSha)
    write(repo, '.trident/as-built/feat/a-new-prefix.md', RECORD)
    write(repo, '.trident/as-built/feat/.gitkeep', '')
    git(repo, 'add', '-A')
    commit(repo, 'stage a record in a directory it floors itself')
    flooredSubdirSha = git(repo, 'rev-parse', 'HEAD')

    // A RENAME is not a deletion to git, and it is one to this rule. The floor's
    // job is to be a file the promoter cannot carry away; moved out of the
    // directory it does not do that job, whatever the diff calls it.
    git(repo, 'switch', '-q', '-c', 'renames-floor-away', baseSha)
    git(repo, 'mv', '.trident/as-built/fix/.gitkeep', '.trident/as-built/fix-keep')
    commit(repo, 'move the subdirectory floor out of the subdirectory')
    renamesFloorAwaySha = git(repo, 'rev-parse', 'HEAD')

    // The floor may not be a `.md` file: the promoter globs `*.md`
    // (trident/as-built-appender.ts:101), so a README.md here is promoted as
    // though it were a record — and then the directory is empty again.
    git(repo, 'switch', '-q', '-c', 'md-floor', baseSha)
    write(repo, '.trident/as-built/feat/a-new-prefix.md', RECORD)
    write(repo, '.trident/as-built/feat/README.md', '# staged records live here\n')
    git(repo, 'add', '-A')
    commit(repo, 'try to floor a directory with a markdown file')
    mdFloorSha = git(repo, 'rev-parse', 'HEAD')

    git(repo, 'switch', '-q', 'main')
  }, 60_000)

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test('a branch staging a record into a floored directory passes', () => {
    const result = runGuard(repo, baseSha, cleanSha)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('as-built-staging-floor-guard: OK')
  }, 30_000)

  test('deleting the top-level floor FAILS and says what it breaks', () => {
    const result = runGuard(repo, baseSha, deletesTopFloorSha)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('FAILED')
    expect(result.stderr).toContain('removes the floor')
    expect(result.stderr).toContain('CONFLICT (file location)')
    expect(result.stdout).not.toContain('OK')
  }, 30_000)

  test('staging a record in a directory with no floor FAILS and names the file to add', () => {
    const result = runGuard(repo, baseSha, unflooredSubdirSha)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('FAILED')
    expect(result.stderr).toContain('.trident/as-built/feat/ — add .trident/as-built/feat/.gitkeep')
  }, 30_000)

  test('a branch that floors the directory it stages into passes', () => {
    const result = runGuard(repo, baseSha, flooredSubdirSha)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('as-built-staging-floor-guard: OK')
  }, 30_000)

  test('moving a floor OUT of its directory is refused, not just deleting it', () => {
    const result = runGuard(repo, baseSha, renamesFloorAwaySha)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('.trident/as-built/fix/ — add .trident/as-built/fix/.gitkeep')
  }, 30_000)

  test('a .md file is not a floor, because the promoter promotes it', () => {
    const result = runGuard(repo, baseSha, mdFloorSha)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('.trident/as-built/feat/ — add .trident/as-built/feat/.gitkeep')
    expect(result.stderr).toContain('NOT a README.md')
  }, 30_000)

  test('a base with no floor at all is the bootstrap: the installing diff passes, and says so', () => {
    // The change that INSTALLS the floor is judged against a base without one. A
    // blind refusal would red the only PR that can make the guard's claim true.
    const unfloored = mkdtempSync(join(tmpdir(), 'staging-floor-guard-unfloored-'))
    try {
      git(unfloored, 'init', '-q', '--initial-branch=main')
      write(unfloored, 'code.ts', 'export const value = 1\n')
      git(unfloored, 'add', '-A')
      commit(unfloored, 'base with no staging directory')
      const base = git(unfloored, 'rev-parse', 'HEAD')

      git(unfloored, 'switch', '-q', '-c', 'install', base)
      write(unfloored, '.trident/as-built/.gitkeep', '')
      git(unfloored, 'add', '-A')
      commit(unfloored, 'install the staging floor')
      const head = git(unfloored, 'rev-parse', 'HEAD')

      const result = runGuard(unfloored, base, head)
      expect(result.status).toBe(0)
      expect(result.stderr).toContain('installs the staging floor')
      expect(result.stderr).not.toContain('FAILED')
    } finally {
      rmSync(unfloored, { recursive: true, force: true })
    }
  }, 30_000)

  test('the bootstrap is not a general amnesty: it never reaches the PER-DIRECTORY rule', () => {
    // Exempting the top-level check on an unfloored base must not exempt the
    // per-directory rule, or the state this repo was actually in on 2026-09-12 —
    // a record under a directory with no floor — would pass.
    //
    // The fixture floors the TOP on both sides deliberately, so the only thing
    // that can fail it is the per-directory rule. Letting the top-level check fire
    // here instead would make this test pass for a reason it is not about, which
    // is how it read before the exemption was rescoped.
    const amnesty = mkdtempSync(join(tmpdir(), 'staging-floor-guard-amnesty-'))
    try {
      git(amnesty, 'init', '-q', '--initial-branch=main')
      write(amnesty, '.trident/as-built/.gitkeep', '')
      write(amnesty, '.trident/as-built/fix/an-earlier-change.md', RECORD)
      git(amnesty, 'add', '-A')
      commit(amnesty, 'base: top level floored, the record\'s own directory NOT')
      const base = git(amnesty, 'rev-parse', 'HEAD')

      git(amnesty, 'switch', '-q', '-c', 'unrelated', base)
      write(amnesty, 'code.ts', 'export const value = 2\n')
      git(amnesty, 'add', '-A')
      commit(amnesty, 'an unrelated change')
      const head = git(amnesty, 'rev-parse', 'HEAD')

      const result = runGuard(amnesty, base, head)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('.trident/as-built/fix/ — add .trident/as-built/fix/.gitkeep')
      // Not the top-level failure: that one is floored on both sides here.
      expect(result.stderr).not.toContain('has no floor under .trident/as-built/')
    } finally {
      rmSync(amnesty, { recursive: true, force: true })
    }
  }, 30_000)

  test('neither side floored at the TOP still FAILS, even when every record directory is floored', () => {
    // THE BOUNDARY THE FIRST VERSION OF THIS GUARD GOT WRONG, and the reason it
    // earns its own test rather than a line in another one. The top-level check was
    // written as "the base HAS a floor and the head does not", which reads like the
    // rule and is not it: with NEITHER side floored that condition is false, and a
    // tree whose every record-holding subdirectory carries its own floor then walked
    // the per-directory loop clean as well. The guard exited 0 over a tree that never
    // installs the top-level floor at all — exempting, on its very first run, the one
    // state it exists to refuse. An exemption written to let a guard install itself
    // must be scoped to the side that is allowed to be wrong, which is the BASE.
    //
    // The subdirectory floor is present here on purpose: without it the per-directory
    // rule would fail this fixture for an unrelated reason and the test would pass
    // while proving nothing about the top-level check.
    const neither = mkdtempSync(join(tmpdir(), 'staging-floor-guard-neither-'))
    try {
      git(neither, 'init', '-q', '--initial-branch=main')
      write(neither, '.trident/as-built/fix/.gitkeep', '')
      write(neither, '.trident/as-built/fix/an-earlier-change.md', RECORD)
      git(neither, 'add', '-A')
      commit(neither, 'base: every record directory floored, the top level NOT')
      const base = git(neither, 'rev-parse', 'HEAD')

      git(neither, 'switch', '-q', '-c', 'unrelated', base)
      write(neither, 'code.ts', 'export const value = 2\n')
      git(neither, 'add', '-A')
      commit(neither, 'an unrelated change that installs nothing')
      const head = git(neither, 'rev-parse', 'HEAD')

      const result = runGuard(neither, base, head)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('the proposed tree has no floor under .trident/as-built/')
      expect(result.stderr).toContain('Add it: an empty, tracked .trident/as-built/.gitkeep')
      // And not mistaken for the other failure: nothing was removed here.
      expect(result.stderr).not.toContain('removes the floor')
      expect(result.stdout).not.toContain('OK')
    } finally {
      rmSync(neither, { recursive: true, force: true })
    }
  }, 30_000)

  test('missing either required SHA exits 2 rather than skipping', () => {
    const missingBase = runGuard(repo, undefined, cleanSha)
    expect(missingBase.status).toBe(2)
    expect(missingBase.stderr).toContain('GUARD_BASE_SHA')

    const missingHead = runGuard(repo, baseSha, undefined)
    expect(missingHead.status).toBe(2)
    expect(missingHead.stderr).toContain('GUARD_HEAD_SHA')
  }, 30_000)

  test('an unresolvable SHA exits 2 and names the bad value', () => {
    const result = runGuard(repo, UNRESOLVABLE_SHA, cleanSha)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(UNRESOLVABLE_SHA)
  }, 30_000)

  test('a non-branch event with no shas is skipped OUTSIDE Actions', () => {
    const result = runGuard(repo, undefined, undefined, { name: 'push' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('not a branch proposal')
  }, 30_000)

  test('INSIDE Actions a guarded event whose payload yields no sha exits 2', () => {
    // The one risk the relocated event filter creates is the opposite of a
    // bypass: a guard that decides its own applicability can decide "not
    // applicable" over a guarded event and report clean. It must refuse instead.
    const result = runGuard(repo, undefined, undefined, { name: 'pull_request', actions: true })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('REFUSES to skip')
  }, 30_000)

  test('it reads the base and head shas out of a real pull_request payload', () => {
    const payload = join(repo, 'event.json')
    writeFileSync(payload, JSON.stringify({ pull_request: { base: { sha: baseSha }, head: { sha: deletesTopFloorSha } } }))
    const result = runGuard(repo, undefined, undefined, { name: 'pull_request', actions: true, payload })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('removes the floor')
  }, 30_000)

  test('it reads the base and head shas out of a real merge_group payload', () => {
    const payload = join(repo, 'merge-group-event.json')
    writeFileSync(payload, JSON.stringify({ merge_group: { base_sha: baseSha, head_sha: cleanSha } }))
    const result = runGuard(repo, undefined, undefined, { name: 'merge_group', actions: true, payload })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('as-built-staging-floor-guard: OK')
  }, 30_000)

  /**
   * THE PIN ON MAIN. The guard only ever judges branch proposals, so nothing it
   * does can catch main arriving in the bad state by another route — a manual
   * promotion, a force-push, a revert. This asserts the rule directly against
   * THIS repo's tracked tree, which every shard evaluates on every event.
   */
  test("this repo's own tracked tree floors every directory that holds a record", () => {
    const listed = git(REPO_ROOT, 'ls-tree', '-r', '--name-only', 'HEAD', '--', '.trident/as-built/')
    const paths = listed === '' ? [] : listed.split('\n')
    // Positive control: if this ever reads zero paths the assertion below is
    // vacuous, and a vacuous pin on main is exactly the failure being prevented.
    expect(paths.length).toBeGreaterThan(0)

    const records = paths.filter((path) => path.endsWith('.md'))
    const floorDirs = new Set(paths.filter((path) => !path.endsWith('.md')).map((path) => dirname(path)))
    expect(floorDirs.has('.trident/as-built')).toBe(true)
    expect(records.filter((record) => !floorDirs.has(dirname(record)))).toEqual([])
  }, 30_000)
})
