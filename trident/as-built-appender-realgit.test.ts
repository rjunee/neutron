import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AS_BUILT_COMMITTER_EMAIL,
  AS_BUILT_COMMITTER_NAME,
  foldStagedAsBuiltEntries,
} from './as-built-appender.ts'
import { spawnCapture } from './git-mode.ts'
import type { RunHostCommand } from './merge.ts'

const GIT_ID = ['-c', 'user.name=Test Setup', '-c', 'user.email=setup@neutron.local', '-c', 'commit.gpgsign=false']
const HEADER = '# AS_BUILT\n\nRunning log of what shipped, newest first. One entry per merged change.\n\n'
const HISTORY = '## 2026-08-14 — history that must survive\n\nold body\n\n'
const created: string[] = []

interface World {
  root: string
  origin: string
  checkout: string
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

async function git(repo: string, ...args: string[]): Promise<void> {
  const result = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
}

async function output(repo: string, ...args: string[]): Promise<string> {
  const result = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

async function seedWorld(label: string): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), `as-built-appender-${label}-`))
  created.push(root)
  const origin = join(root, 'origin.git')
  const checkout = join(root, 'checkout')

  const bare = await spawnCapture(['git', 'init', '--bare', '-q', '--initial-branch=main', origin], root)
  if (!bare.ok) throw new Error(`bare init failed: ${bare.stderr}`)
  const initialized = await spawnCapture(['git', 'init', '-q', '--initial-branch=main', checkout], root)
  if (!initialized.ok) throw new Error(`checkout init failed: ${initialized.stderr}`)

  // This identity is deliberately personal-looking: the fold commit must ignore checkout config.
  await git(checkout, 'config', 'user.name', 'Ambient Checkout Person')
  await git(checkout, 'config', 'user.email', 'ambient-person@example.test')
  await git(checkout, 'remote', 'add', 'origin', origin)
  mkdirSync(join(checkout, 'docs'), { recursive: true })
  writeFileSync(join(checkout, 'docs', 'AS_BUILT.md'), HEADER + HISTORY)
  await git(checkout, 'add', '-A')
  await git(checkout, ...GIT_ID, 'commit', '-q', '-m', 'base')
  await git(checkout, 'push', '-q', '-u', 'origin', 'main')
  return { root, origin, checkout }
}

async function mergeStagedEntry(world: World, path: string, entry: string): Promise<void> {
  await git(world.checkout, 'switch', '-q', '-c', `entry-${path.replace(/[^a-z0-9]+/gi, '-')}`)
  const absolute = join(world.checkout, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, entry)
  await git(world.checkout, 'add', '--', path)
  await git(world.checkout, ...GIT_ID, 'commit', '-q', '-m', `stage ${path}`)
  await git(world.checkout, 'switch', '-q', 'main')
  await git(world.checkout, ...GIT_ID, 'merge', '-q', '--no-ff', '-m', `merge ${path}`, '@{-1}')
  await git(world.checkout, 'push', '-q', 'origin', 'main')
}

async function originOutput(world: World, ...args: string[]): Promise<string> {
  return output(world.origin, ...args)
}

async function queuePaths(world: World): Promise<string[]> {
  const listed = await originOutput(world, 'ls-tree', '-r', '--name-only', 'main', '--', '.trident/as-built/')
  return listed === '' ? [] : listed.split('\n')
}

describe('foldStagedAsBuiltEntries with real git', () => {
  test('folds a merged staged entry in one neutral-identity commit, then becomes a no-op', async () => {
    const world = await seedWorld('fold')
    const stagedPath = '.trident/as-built/fold-after-merge.md'
    const entry = '## 2026-08-17 — fold after merge\n\nnew body\n'
    await mergeStagedEntry(world, stagedPath, entry)
    const before = await originOutput(world, 'rev-parse', 'main')

    const result = await foldStagedAsBuiltEntries(spawnCapture, world.checkout, 'pr', 'main')

    expect(result).toEqual({ ok: true, folded: 1 })
    const after = await originOutput(world, 'rev-parse', 'main')
    expect(after).not.toBe(before)
    expect(await originOutput(world, 'rev-list', '--count', `${before}..${after}`)).toBe('1')
    expect(
      (await originOutput(world, 'diff-tree', '--no-commit-id', '--name-status', '-r', after)).split('\n').sort(),
    ).toEqual([`D\t${stagedPath}`, 'M\tdocs/AS_BUILT.md'])

    const log = await originOutput(world, 'show', 'main:docs/AS_BUILT.md')
    expect(log.startsWith(`${HEADER}${entry.trimEnd()}\n\n${HISTORY.trimEnd()}`)).toBe(true)
    expect(log).toContain('## 2026-08-17 — fold after merge')
    expect(await originOutput(world, 'show', '-s', '--format=%cn%n%ce', 'main')).toBe(
      `${AS_BUILT_COMMITTER_NAME}\n${AS_BUILT_COMMITTER_EMAIL}`,
    )
    expect(await queuePaths(world)).toEqual([])

    const again = await foldStagedAsBuiltEntries(spawnCapture, world.checkout, 'pr', 'main')
    expect(again).toEqual({ ok: true, folded: 0 })
    expect(await originOutput(world, 'rev-parse', 'main')).toBe(after)
  }, 60_000)

  test('does nothing when the resolved base tree has no staged entries', async () => {
    const world = await seedWorld('empty')
    const before = await originOutput(world, 'rev-parse', 'main')
    const worktreesBefore = await output(world.checkout, 'worktree', 'list', '--porcelain')

    const result = await foldStagedAsBuiltEntries(spawnCapture, world.checkout, 'pr', 'main')

    expect(result).toEqual({ ok: true, folded: 0 })
    expect(await originOutput(world, 'rev-parse', 'main')).toBe(before)
    expect(await output(world.checkout, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore)
  }, 60_000)

  test('refuses a malformed staged entry by path and leaves it queued without a commit', async () => {
    const world = await seedWorld('malformed')
    const stagedPath = '.trident/as-built/malformed.md'
    await mergeStagedEntry(world, stagedPath, '## not-a-date — malformed\n\nbody\n')
    const before = await originOutput(world, 'rev-parse', 'main')
    const logBlobBefore = await originOutput(world, 'rev-parse', 'main:docs/AS_BUILT.md')

    const result = await foldStagedAsBuiltEntries(spawnCapture, world.checkout, 'pr', 'main')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.folded).toBe(0)
    expect(result.reason).toContain(stagedPath)
    expect(result.reason).toContain("does not match '## YYYY-MM-DD — title'")
    expect(await originOutput(world, 'rev-parse', 'main')).toBe(before)
    expect(await originOutput(world, 'rev-parse', 'main:docs/AS_BUILT.md')).toBe(logBlobBefore)
    expect(await queuePaths(world)).toEqual([stagedPath])
  }, 60_000)

  test('surfaces a plain-push non-fast-forward with git stderr and leaves the queue intact', async () => {
    const world = await seedWorld('nonff')
    const stagedPath = '.trident/as-built/race.md'
    await mergeStagedEntry(world, stagedPath, '## 2026-08-17 — raced fold\n\nbody\n')
    const logBlobBefore = await originOutput(world, 'rev-parse', 'main:docs/AS_BUILT.md')
    const helper = join(world.root, 'helper')
    await git(world.root, 'clone', '-q', world.origin, helper)
    await git(helper, 'config', 'user.name', 'Race Helper')
    await git(helper, 'config', 'user.email', 'race-helper@neutron.local')

    const calls: string[][] = []
    let raced = false
    const racingHost: RunHostCommand = async (cmd, cwd) => {
      calls.push([...cmd])
      const result = await spawnCapture(cmd, cwd)
      if (!raced && result.ok && cmd.includes('fetch') && cmd.at(-1) === 'main') {
        raced = true
        writeFileSync(join(helper, 'race.txt'), 'base moved after the fold fetch\n')
        await git(helper, 'add', 'race.txt')
        await git(helper, ...GIT_ID, 'commit', '-q', '-m', 'move base during fold')
        await git(helper, 'push', '-q', 'origin', 'main')
      }
      return result
    }

    const result = await foldStagedAsBuiltEntries(racingHost, world.checkout, 'pr', 'main')

    expect(raced).toBe(true)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.folded).toBe(0)
    expect(result.reason).toMatch(/fetch first|non-fast-forward|rejected/i)
    expect(await originOutput(world, 'rev-parse', 'main:docs/AS_BUILT.md')).toBe(logBlobBefore)
    expect(await queuePaths(world)).toEqual([stagedPath])
    const pushes = calls.filter((cmd) => cmd.includes('push'))
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).not.toContain('--force')
    expect(pushes[0]).not.toContain('--force-with-lease')
  }, 60_000)

  test('uses the fetched tree despite stale dirty shared state and leaves no scratch worktree', async () => {
    const world = await seedWorld('stale')
    const localMainBefore = await output(world.checkout, 'rev-parse', 'refs/heads/main')
    const integrator = join(world.root, 'integrator')
    await git(world.root, 'clone', '-q', world.origin, integrator)
    await git(integrator, 'config', 'user.name', 'Integrator')
    await git(integrator, 'config', 'user.email', 'integrator@neutron.local')
    const stagedPath = '.trident/as-built/from-newer-origin.md'
    const absolute = join(integrator, stagedPath)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, '## 2026-08-17 — newer origin wins\n\nbody\n')
    await git(integrator, 'add', stagedPath)
    await git(integrator, ...GIT_ID, 'commit', '-q', '-m', 'stage on newer origin')
    await git(integrator, 'push', '-q', 'origin', 'main')

    writeFileSync(join(world.checkout, 'docs', 'AS_BUILT.md'), `${HEADER}dirty shared bytes\n${HISTORY}`)
    writeFileSync(join(world.checkout, 'untracked-local.txt'), 'must survive\n')
    const statusBefore = await output(world.checkout, 'status', '--short')
    const sharedLogBefore = readFileSync(join(world.checkout, 'docs', 'AS_BUILT.md'), 'utf8')

    const result = await foldStagedAsBuiltEntries(spawnCapture, world.checkout, 'pr', 'main')

    expect(result).toEqual({ ok: true, folded: 1 })
    expect(await output(world.checkout, 'rev-parse', 'refs/heads/main')).toBe(localMainBefore)
    expect(await output(world.checkout, 'status', '--short')).toBe(statusBefore)
    expect(readFileSync(join(world.checkout, 'docs', 'AS_BUILT.md'), 'utf8')).toBe(sharedLogBefore)
    expect(readFileSync(join(world.checkout, 'untracked-local.txt'), 'utf8')).toBe('must survive\n')
    const worktrees = await output(world.checkout, 'worktree', 'list', '--porcelain')
    expect(worktrees.split('\n').filter((line) => line.startsWith('worktree '))).toEqual([
      `worktree ${world.checkout}`,
    ])
    expect(await queuePaths(world)).toEqual([])
    expect(await originOutput(world, 'show', 'main:docs/AS_BUILT.md')).toContain('## 2026-08-17 — newer origin wins')
  }, 60_000)
})
