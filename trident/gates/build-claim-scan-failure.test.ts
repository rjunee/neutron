import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeLazyCredentialedHostRunner, spawnCapture } from '../git-mode.ts'
import type { RunHostCommand } from '../merge.ts'
import { checkBuildClaim } from './build-claim.ts'
import { publicationReadiness } from './release-readiness.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const result = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function world() {
  const repo = mkdtempSync(join(tmpdir(), 'build-claim-preservation-'))
  directories.push(repo)
  const origin = join(repo, 'origin.git')
  await git(repo, 'init', '-q', '--initial-branch=main')
  await git(repo, 'init', '--bare', '-q', origin)
  await git(repo, 'config', 'user.name', 'Build Test')
  await git(repo, 'config', 'user.email', 'build@example.invalid')
  await git(repo, 'config', 'commit.gpgsign', 'false')
  await git(repo, 'config', 'core.hooksPath', '/dev/null')
  await git(repo, 'remote', 'add', 'origin', origin)
  await git(repo, 'commit', '--allow-empty', '-qm', 'base')
  const base = await git(repo, 'rev-parse', 'HEAD')
  await git(repo, 'switch', '-qc', 'change')
  await git(repo, 'commit', '--allow-empty', '-qm', 'measured build')
  const head = await git(repo, 'rev-parse', 'HEAD')
  return { repo, origin, base, head, snapshot: { head, diff: '+code', pr: null } }
}

/** All commands execute through the production runner. Only its environment loader fails;
 * the command observer selects the fault without replacing any git output or push receipt. */
function host(fault?: 'rev-list' | 'cat-file' | 'size') {
  const calls: string[][] = []
  let active: string[] = []
  let failures = 0
  const lazy = makeLazyCredentialedHostRunner(async () => {
    if (fault && (fault === 'size' ? active.includes('cat-file') && active.includes('-s') : active.includes(fault))) {
      failures++
      throw new Error('credential loader unavailable during trailer scan')
    }
    return {}
  })
  const run: RunHostCommand = (argv, cwd, env, timeout) => {
    calls.push(argv)
    active = argv
    return lazy(argv, cwd, env, timeout)
  }
  return { run, calls, failures: () => failures }
}

for (const fault of [undefined, 'rev-list', 'cat-file', 'size'] as const) {
  test(`G100 real origin preserves the measured object with ${fault ?? 'healthy'} trailer scan`, async () => {
    const w = await world()
    // A later branch movement must not change the object G100 preserves.
    await git(w.repo, 'commit', '--allow-empty', '-qm', 'later branch movement')
    const moved = await git(w.repo, 'rev-parse', 'HEAD')
    expect(moved).not.toBe(w.head)
    const h = host(fault)
    const verdict = await checkBuildClaim(h.run, w.repo, 'change', w.base, w.base, w.snapshot, 'preservation-test')
    // Observe the bare origin independently, not just the command or reported outcome.
    expect(await git(w.origin, 'rev-parse', '--verify', 'refs/heads/change')).toBe(w.head)
    expect(verdict.kind).toBe('blocked')
    if (verdict.kind !== 'blocked') throw new Error('Preservation must refuse review')
    expect(verdict.on).toContain('branch preserved on origin')
    expect(h.calls.filter(argv => argv.includes('push'))).toEqual([
      ['git', '-C', w.repo, 'push', '--force-with-lease=refs/heads/change:', 'origin', `${w.head}:refs/heads/change`],
    ])
    expect(h.calls.findIndex(argv => argv.includes('rev-list'))).toBeLessThan(h.calls.findIndex(argv => argv.includes('push')))
    expect(h.failures()).toBe(fault ? 1 : 0)
    if (fault) {
      expect(verdict.on).toContain('session-trailer scan unmeasured:')
      expect(verdict.on).toContain('credential loader unavailable during trailer scan')
    } else expect(verdict.on).not.toContain('unmeasured')
  })
}

test('G100 real origin stays untouched without a measured claim conflict', async () => {
  const w = await world()
  for (const [claim, snapshot, branch, kind] of [
    [w.head, w.snapshot, 'change', 'allow'],
    ['missing-claim', w.snapshot, 'change', 'allow'],
    [w.base, { ...w.snapshot, head: 'invalid' }, 'change', 'unknown'],
    [w.base, w.snapshot, 'invalid ref', 'unknown'],
  ] as const) {
    const h = host('rev-list')
    expect((await checkBuildClaim(h.run, w.repo, branch, w.base, claim, snapshot, 'preservation-test')).kind).toBe(kind)
    expect(h.calls.some(argv => argv.includes('push') || argv.includes('rev-list'))).toBe(false)
    expect(await git(w.repo, 'ls-remote', '--heads', 'origin')).toBe('')
    expect(h.failures()).toBe(0)
  }
  // Positive control: the same repository and host can measure a conflict and preserve it.
  const h = host()
  expect((await checkBuildClaim(h.run, w.repo, 'change', w.base, w.base, w.snapshot, 'preservation-test')).kind).toBe('blocked')
  expect(await git(w.origin, 'rev-parse', '--verify', 'refs/heads/change')).toBe(w.head)
})

test('G100 scan exception containment does not authorize subsequent publication', async () => {
  const w = await world()
  const h = host('rev-list')
  expect((await checkBuildClaim(h.run, w.repo, 'change', w.base, w.base, w.snapshot, 'preservation-test')).kind).toBe('blocked')
  expect(await git(w.origin, 'rev-parse', '--verify', 'refs/heads/change')).toBe(w.head)
  expect(await publicationReadiness(h.run, w.repo, 'change', 'main', w.base, w.snapshot, 'preservation-test')).toMatchObject({
    kind: 'unknown', detail: expect.stringContaining('credential loader unavailable'),
  })
  expect(h.failures()).toBe(2)
  expect(h.calls.filter(argv => argv.includes('push'))).toHaveLength(1)
  expect(await publicationReadiness(host().run, w.repo, 'change', 'main', w.base, w.snapshot, 'preservation-test')).toEqual({ kind: 'allow' })
})
