/**
 * REAL-GIT proof that the PUBLISHER — not a test harness standing next to it — merges the
 * AS_BUILT log cleanly when a concurrent build got there first.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `scripts/git/as-built-merge-realgit.test.ts`. That file
 * proves the merge driver works through real git. It does NOT prove anything is wired: Argus
 * reverted the production line in round 1 and the whole suite stayed green, because the test drove
 * the driver itself rather than the code path that is supposed to install it. So this file calls
 * `rebaseOntoObservedBase` — the actual publish step, `trident/orchestrator.ts` — against a real
 * origin, and NOTHING here installs the merge driver. If the `ensureAsBuiltMergeDriver` call is
 * removed from the publisher, nothing installs it at all, the replay hits the same conflict it
 * always did, and the first test below fails with `TridentRebaseConflict`.
 *
 * The second test is its control: the identical scenario in a checkout that does not SHIP the
 * installer, which is every other repository trident builds. There the publisher must leave the
 * checkout alone and the conflict must still surface as an attention state — proof that this
 * change imposes one repository's changelog layout on no one else.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { spawnCapture } from './git-mode.ts'
import { rebaseOntoObservedBase, TridentRebaseConflict } from './orchestrator.ts'

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const GIT_ID = ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false']
const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

async function git(repo: string, ...args: string[]): Promise<void> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
}

const HEADER = '# AS_BUILT\n\nRunning log of what shipped, newest first. One entry per merged change.\n\n'
const HISTORY = '## 2026-08-14 — history that must survive\n\nold body\n\n'
const FIRST = '## 2026-08-16 — the build that published first\n\nbody one\n\n'
const SECOND = '## 2026-08-16 — the build that published second\n\nbody two\n\n'

interface World {
  checkout: string
  branch: string
}

/**
 * A real origin and a real checkout where `main` has ALREADY taken one build's log entry, and a
 * branch cut before that still carries its own.
 *
 * `shipsInstaller: false` models every other repository trident builds — same conflict, no
 * installer to find.
 */
async function seedWorld(opts: { shipsInstaller: boolean }): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'as-built-wiring-'))
  created.push(root)
  const origin = join(root, 'origin.git')
  const checkout = join(root, 'checkout')
  const branch = `trident/as-built-${opts.shipsInstaller ? 'ships' : 'bare'}`

  const init = await spawnCapture(['git', 'init', '--bare', '-q', '--initial-branch=main', origin], root)
  if (!init.ok) throw new Error(`bare init failed: ${init.stderr}`)

  const made = await spawnCapture(['git', 'init', '-q', '--initial-branch=main', checkout], root)
  if (!made.ok) throw new Error(`checkout init failed: ${made.stderr}`)
  await git(checkout, 'config', 'user.email', 'trident-test@neutron.local')
  await git(checkout, 'config', 'user.name', 'Trident Test')
  await git(checkout, 'remote', 'add', 'origin', `file://${origin}`)

  mkdirSync(join(checkout, 'docs'), { recursive: true })
  if (opts.shipsInstaller) {
    mkdirSync(join(checkout, 'scripts', 'git'), { recursive: true })
    for (const rel of [
      ['scripts', 'install-merge-drivers.sh'],
      ['scripts', 'git', 'as-built-merge-driver.ts'],
      ['scripts', 'git', 'as-built-log-merge.ts'],
    ]) {
      cpSync(join(REPO_ROOT, ...rel), join(checkout, ...rel))
    }
    // The path→driver binding is TRACKED, so a repo that ships the installer ships this too. The
    // `bare` variant deliberately gets neither: it stands for every other repo trident builds.
    writeFileSync(join(checkout, '.gitattributes'), 'docs/AS_BUILT.md merge=as-built-log\n')
  }

  writeFileSync(join(checkout, 'docs', 'AS_BUILT.md'), HEADER + HISTORY)
  await git(checkout, 'add', '-A')
  await git(checkout, ...GIT_ID, 'commit', '-q', '-m', 'base')
  await git(checkout, 'push', '-q', 'origin', 'main')

  // The branch, cut from that base, prepends ITS entry.
  await git(checkout, 'branch', branch, 'main')
  const tmp = join(checkout, `.build-${branch.replace(/\W/g, '_')}`)
  await git(checkout, 'worktree', 'add', '-q', tmp, branch)
  writeFileSync(join(tmp, 'docs', 'AS_BUILT.md'), HEADER + SECOND + HISTORY)
  await git(tmp, 'add', '-A')
  await git(tmp, ...GIT_ID, 'commit', '-q', '-m', 'second build')
  await git(checkout, 'worktree', 'remove', '--force', tmp)

  // Meanwhile the OTHER build merged first, so origin/main moves under this branch.
  writeFileSync(join(checkout, 'docs', 'AS_BUILT.md'), HEADER + FIRST + HISTORY)
  await git(checkout, 'add', '-A')
  await git(checkout, ...GIT_ID, 'commit', '-q', '-m', 'first build')
  await git(checkout, 'push', '-q', 'origin', 'main')

  return { checkout, branch }
}

describe('the publisher replaying a branch whose log entry raced another', () => {
  test('WIRING — the publish step itself merges both entries, with nothing else installing the driver', async () => {
    const world = await seedWorld({ shipsInstaller: true })
    // The checkout is untouched: no merge driver configured by this test, by design.
    const before = await spawnCapture(
      ['git', '-C', world.checkout, 'config', '--get', 'merge.as-built-log.driver'],
      world.checkout,
    )
    expect(before.stdout.trim()).toBe('')

    const scratchDir = join(world.checkout, '.trident-worktrees', 'rebase-wiring')
    const res = await rebaseOntoObservedBase(spawnCapture, world.checkout, world.branch, 'main', null, scratchDir)

    expect(res.rebased).toBe(true)

    // Both entries landed, history intact, nothing interleaved — read off the REPLAYED commit.
    const show = await spawnCapture(
      ['git', '-C', world.checkout, 'show', `${res.head}:docs/AS_BUILT.md`],
      world.checkout,
    )
    expect(show.ok).toBe(true)
    expect(show.stdout).not.toContain('<<<<<<<')
    expect(show.stdout).toContain('## 2026-08-16 — the build that published first')
    expect(show.stdout).toContain('## 2026-08-16 — the build that published second')
    expect(show.stdout).toContain('## 2026-08-14 — history that must survive')

    // The publisher installed the driver as part of publishing — that is the wiring under test.
    const after = await spawnCapture(
      ['git', '-C', world.checkout, 'config', '--get', 'merge.as-built-log.driver'],
      world.checkout,
    )
    expect(after.stdout.trim()).not.toBe('')

    expect(existsSync(scratchDir)).toBe(false)
  }, 60_000)

  test('CONTROL — a repo that does not ship the installer is left alone, and still reports the conflict', async () => {
    const world = await seedWorld({ shipsInstaller: false })
    const scratchDir = join(world.checkout, '.trident-worktrees', 'rebase-bare')

    // Same race, same file, no installer to find: the publisher must not invent one, and the
    // conflict must surface as an attention state rather than being silently resolved.
    await expect(
      rebaseOntoObservedBase(spawnCapture, world.checkout, world.branch, 'main', null, scratchDir),
    ).rejects.toBeInstanceOf(TridentRebaseConflict)

    const after = await spawnCapture(
      ['git', '-C', world.checkout, 'config', '--get', 'merge.as-built-log.driver'],
      world.checkout,
    )
    expect(after.stdout.trim()).toBe('')
    expect(readFileSync(join(world.checkout, 'docs', 'AS_BUILT.md'), 'utf8')).not.toContain('<<<<<<<')
  }, 60_000)
})
